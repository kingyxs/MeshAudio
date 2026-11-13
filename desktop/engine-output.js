const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function defaultHelperPath() {
  const executable = process.platform === 'win32' ? 'meshaudio-native.exe' : 'meshaudio-native';
  return path.join(__dirname, 'native', 'build', executable);
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

// MSMP v1 output: the native helper owns the mixer and the per-source jitter
// buffers, so rendering is paced by the WASAPI engine period instead of a Node
// timer. Node only forwards raw PCM packets plus the route/gain configuration.
//
// Stream layout (all little-endian):
//   16-byte header: 'MSMP' | u16 version(1) | u16 channels | u32 sampleRate | u32 reserved
//   records:       4-byte tag | u32 payloadBytes | payload
//     'MCFG' payload: u16 ver | u16 channels | u32 rate | u16 sources | u16 buses
//                     source: u32 hash | f32 gain | u8 muted | u8 stopped | u16 reserved | u64 busMask
//                     bus:    f32 gain | u8 muted | u8 pad[3]
//     'PCM ' payload: u32 hash | u32 sequence | u32 frames | u32 reserved | float32 interleaved
//     'END ' payload: empty
class NativeMixOutput {
  constructor({
    enabled = truthy(process.env.MESHAUDIO_NATIVE_AUDIO),
    helperPath = process.env.MESHAUDIO_NATIVE_HELPER || defaultHelperPath(),
    deviceId = '',
    sampleRate = 48000,
    channels = 2,
    logger = console,
    onStats = null,
    spawnProcess = spawn,
    now = Date.now
  } = {}) {
    this.enabled = enabled;
    this.helperPath = helperPath;
    this.deviceId = deviceId;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.logger = logger;
    this.onStats = onStats;
    this.spawnProcess = spawnProcess;
    this.now = now;
    this.restartAt = 0;
    this.restartFailures = 0;
    this.configRecord = null;
    this.child = null;
    this.pool = new Map();
    this.pending = [];
    this.writing = false;
    this.started = false;
    this.writtenPackets = 0;
    this.droppedPackets = 0;
    this.backpressureEvents = 0;
    this.lastError = null;
    this.engine = { targetMs: null, renderedMs: 0, sources: {} };
    this.stdoutBuffer = '';
  }

  status() {
    const sources = Object.values(this.engine.sources);
    const queuedMs = sources.length ? round1(Math.max(...sources.map(s => Number(s.queuedMs) || 0))) : 0;
    const delayMs = sources.length ? round1(Math.max(...sources.map(s => Number(s.delayMs) || 0))) : 0;
    return {
      enabled: this.enabled,
      running: Boolean(this.child && this.child.exitCode === null),
      mode: 'native-engine',
      helperPath: this.helperPath,
      deviceId: this.deviceId || null,
      sampleRate: this.sampleRate,
      channels: this.channels,
      queuedBlocks: 0,
      queuedMs,
      droppedBlocks: this.droppedPackets,
      writtenBlocks: this.writtenPackets,
      backpressureEvents: this.backpressureEvents,
      inFlightBytes: Number(this.child?.stdin?.writableLength) || 0,
      engineTargetMs: this.engine.targetMs,
      engineRenderedMs: round1(this.engine.renderedMs),
      renderUnderruns: this.engine.renderUnderruns || 0,
      engineSourceCount: sources.length,
      lastError: this.lastError
    };
  }

  start() {
    if (!this.enabled || this.child || this.now() < this.restartAt) return false;
    if (!fs.existsSync(this.helperPath)) {
      this.lastError = `Native helper not found: ${this.helperPath}`;
      this.logger.warn?.(`[native-engine] ${this.lastError}`);
      this._deferRestart();
      return false;
    }
    const args = ['--engine'];
    if (this.deviceId) args.push('--device', this.deviceId);
    // Explicit field override for bursty Wi-Fi. The native default preserves
    // a bounded scheduling reserve without coupling it to UI refreshes.
    const targetMs = Number(process.env.MESHAUDIO_ENGINE_TARGET_MS);
    if (Number.isFinite(targetMs) && targetMs > 0) args.push('--target-ms', String(targetMs));
    try {
      this.child = this.spawnProcess(this.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.lastError = error.message;
      this.child = null;
      this.logger.error?.(`[native-engine] failed to start: ${this.lastError}`);
      this._deferRestart();
      return false;
    }
    this.stdoutBuffer = '';
    const child = this.child;
    let helperError = '';
    const retire = () => {
      if (this.child !== child) return;
      this.child = null;
      this.started = false;
      this.writing = false;
      this.pending = [];
      this.pool.clear();
      this.engine = { targetMs: null, renderedMs: 0, sources: {} };
      this._deferRestart();
    };
    // A dying helper must surface as a status error, never as an unhandled
    // EPIPE that would take the control service down with it.
    this.child.stdin?.on('error', error => {
      this.lastError = `helper stdin: ${error.message}`;
      this.writing = false;
      this.pending = [];
    });
    this.child.stdout?.on('data', chunk => this._consumeStdout(String(chunk)));
    this.child.stderr?.on('data', chunk => {
      const text = String(chunk).trim();
      if (text.startsWith('error:')) helperError = text;
      if (text) this.logger.warn?.(`[native-engine] ${text}`);
    });
    this.child.on('error', error => {
      this.lastError = error.message;
      this.logger.error?.(`[native-engine] ${this.lastError}`);
      retire();
    });
    this.child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      if (code !== 0 && code !== null) this.lastError = helperError || `helper exited with code ${code}${signal ? ` (${signal})` : ''}`;
      retire();
    });

    const header = Buffer.alloc(16);
    header.write('MSMP', 0, 'ascii');
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(this.channels, 6);
    header.writeUInt32LE(this.sampleRate, 8);
    header.writeUInt32LE(0, 12);
    this.child.stdin.write(header);
    this.started = true;
    // Recovery must restore the graph before the next PCM packet. Otherwise a
    // restarted helper silently has no sources until a later control change.
    if (this.configRecord) this._enqueue(Buffer.from(this.configRecord));
    return true;
  }

  _deferRestart() {
    // Do not turn a failed audio service into hundreds of native launches per
    // second. Other outputs and control remain independent during recovery.
    const delay = Math.min(10000, 1000 * 2 ** Math.min(4, this.restartFailures++));
    this.restartAt = this.now() + delay;
  }

  _consumeStdout(text) {
    this.stdoutBuffer += text;
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.startsWith('{')) {
        try {
          const stats = JSON.parse(line);
          if (stats.type === 'engine.stats') this._applyStats(stats);
        } catch (_) { /* ignore malformed stats lines */ }
      } else if (line) {
        this.logger.info?.(`[native-engine] ${line}`);
      }
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  _applyStats(stats) {
    this.restartFailures = 0;
    this.restartAt = 0;
    this.lastError = null;
    try {
      const short = (stats.sources || []).find(item => Number(item.written) < 128 && Number(item.written) >= 0);
      if (short && process.env.MESHAUDIO_ENGINE_DEBUG) {
        require('fs').appendFileSync(process.env.MESHAUDIO_ENGINE_DEBUG,
          `${new Date().toISOString()} ${JSON.stringify(short)}\n`);
      }
    } catch (_) { /* diagnostics must never break audio */ }
    this.engine.targetMs = stats.targetMs;
    this.engine.renderedMs = stats.renderedMs;
    this.engine.renderUnderruns = Number(stats.renderUnderruns) || 0;
    const sources = {};
    for (const source of Array.isArray(stats.sources) ? stats.sources : []) {
      sources[String(source.hash)] = source;
    }
    this.engine.sources = sources;
    this.onStats?.(stats);
  }

  _record(tag, payload) {
    const header = Buffer.alloc(8);
    header.write(tag, 0, 'ascii');
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  sendConfig({ sources = [], buses = [] }) {
    if (!this.enabled) return false;
    const payload = Buffer.alloc(12 + sources.length * 20 + buses.length * 8);
    payload.writeUInt16LE(1, 0);
    payload.writeUInt16LE(this.channels, 2);
    payload.writeUInt32LE(this.sampleRate, 4);
    payload.writeUInt16LE(sources.length, 8);
    payload.writeUInt16LE(buses.length, 10);
    let offset = 12;
    for (const source of sources) {
      payload.writeUInt32LE(source.hash >>> 0, offset);
      payload.writeFloatLE(Number(source.gain) || 0, offset + 4);
      payload.writeUInt8(source.muted ? 1 : 0, offset + 8);
      payload.writeUInt8(source.stopped ? 1 : 0, offset + 9);
      // bit 0 = voice chain (high-pass + NS + AGC)
      // bit 1 = voice enhanced (DeepVQE-S mode)
      payload.writeUInt16LE((source.voice ? 1 : 0) | (source.voiceEnhanced ? 2 : 0), offset + 10);
      payload.writeBigUInt64LE(BigInt(source.busMask || 0), offset + 12);
      offset += 20;
    }
    for (const bus of buses) {
      payload.writeFloatLE(Number(bus.gain) || 0, offset);
      payload.writeUInt8(bus.muted ? 1 : 0, offset + 4);
      offset += 8;
    }
    this.configRecord = this._record('MCFG', payload);
    if (!this.child) return this.start();
    if (!this.child.stdin?.writable || !this.started) return false;
    this._enqueue(Buffer.from(this.configRecord));
    return true;
  }

  writePacket(hash, sequence, pcm) {
    if (!this.enabled) return false;
    if (!this.child && !this.start()) return false;
    if (!this.child?.stdin?.writable || !this.started) return false;
    const frames = Math.floor(pcm.length / this.channels);
    if (frames <= 0) return false;
    // Live audio must not queue without bound: if the pipe is badly backed up,
    // drop this packet and let the engine treat it as a gap. 64 KiB is about
    // 130 ms of stereo 48 kHz audio, so a stalled helper cannot turn into a
    // multi-second delay before the engine even sees the packets.
    if ((Number(this.child.stdin.writableLength) || 0) > 65536) {
      this.droppedPackets++;
      return false;
    }
    const payloadBytes = 16 + frames * this.channels * 4;
    const block = this._acquire(8 + payloadBytes);
    block.write('PCM ', 0, 'ascii');
    block.writeUInt32LE(payloadBytes, 4);
    block.writeUInt32LE(hash >>> 0, 8);
    block.writeUInt32LE(sequence >>> 0, 12);
    block.writeUInt32LE(frames, 16);
    block.writeUInt32LE(0, 20);
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(block, 24);
    this._enqueue(block);
    return true;
  }

  _acquire(byteLength) {
    const bucket = this.pool.get(byteLength);
    if (bucket && bucket.length) return bucket.pop();
    return Buffer.allocUnsafe(byteLength);
  }

  _recycle(block) {
    let bucket = this.pool.get(block.length);
    if (!bucket) {
      bucket = [];
      this.pool.set(block.length, bucket);
    }
    if (bucket.length < 8) bucket.push(block);
  }

  _enqueue(block) {
    this.pending.push(block);
    this.flush();
  }

  flush() {
    if (this.writing || !this.child?.stdin?.writable) return;
    if (!this.pending.length) return;
    this.writing = true;
    while (this.pending.length && this.child?.stdin?.writable) {
      const block = this.pending.shift();
      this.writtenPackets++;
      let accepted = false;
      try {
        accepted = this.child.stdin.write(block, () => this._recycle(block));
      } catch (error) {
        this.lastError = `helper stdin: ${error.message}`;
        this.writing = false;
        this.pending = [];
        return;
      }
      if (!accepted) {
        this.backpressureEvents++;
        this.child.stdin.once('drain', () => {
          this.writing = false;
          this.flush();
        });
        return;
      }
    }
    this.writing = false;
  }

  stop() {
    if (!this.child) return;
    try {
      if (this.child.stdin?.writable) {
        this.child.stdin.write(this._record('END ', Buffer.alloc(0)));
        this.child.stdin.end();
      }
    } catch (error) {
      this.lastError = error.message;
    }
    const child = this.child;
    this.pending = [];
    this.pool.clear();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500).unref();
  }
}

module.exports = { NativeMixOutput, defaultHelperPath };
