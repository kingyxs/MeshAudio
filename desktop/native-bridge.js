const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

function defaultHelperPath() {
  const executable = process.platform === 'win32' ? 'meshaudio-native.exe' : 'meshaudio-native';
  return path.join(__dirname, 'native', 'build', executable);
}

function detectVBCable({ helperPath = process.env.MESHAUDIO_NATIVE_HELPER || defaultHelperPath(), timeoutMs = 3000 } = {}) {
  if (!fs.existsSync(helperPath)) {
    return {
      type: 'vb_cable_detection',
      available: false,
      diagnostic: `Native helper not found: ${helperPath}`,
      renderInput: null,
      captureOutput: null,
      helperPath
    };
  }
  let result;
  try {
    result = spawnSync(helperPath, ['--detect-vbcable'], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true
    });
  } catch (error) {
    return {
      type: 'vb_cable_detection',
      available: false,
      diagnostic: `VB-CABLE detection failed: ${error.message}`,
      renderInput: null,
      captureOutput: null,
      helperPath
    };
  }
  const output = String(result.stdout || '').trim();
  let profile;
  try {
    // The native helper may pretty-print fields with CRLF line endings. Parse
    // the complete JSON object instead of assuming one object per line.
    profile = output ? JSON.parse(output) : null;
  } catch (_) {
    // Keep compatibility with helpers that prefix diagnostics before JSON.
    const start = output.indexOf('{');
    const end = output.lastIndexOf('}');
    try {
      profile = start >= 0 && end > start ? JSON.parse(output.slice(start, end + 1)) : null;
    } catch (_) {
      profile = null;
    }
  }
  if (!profile || profile.type !== 'vb_cable_detection') {
    return {
      type: 'vb_cable_detection',
      available: false,
      diagnostic: String(result.stderr || '').trim() || `VB-CABLE detector exited with code ${result.status ?? 'unknown'}`,
      renderInput: null,
      captureOutput: null,
      helperPath
    };
  }
  return {
    ...profile,
    renderInput: profile.render_input || null,
    captureOutput: profile.capture_output || null,
    helperPath
  };
}

// Bounded FIFO of serialized PCM blocks with explicit accounting.
//
// The reference project (Foundation Sunshine, design inspiration only) paces its audio pipeline with a
// bounded blocking queue between the capture and encode threads; the consumer
// is clock-driven, so backpressure flows through the queue instead of dropping
// data. Node cannot block the render loop, so this FIFO plays the same role:
// it absorbs event-loop jitter (default 48 blocks ~= 240 ms at a 5 ms block)
// while the OS pipe to the native helper provides the actual backpressure.
// Overflow still drops the oldest block -- live audio must not grow unbounded
// latency -- but every drop is accounted for and surfaced in status().
class AudioBlockFifo {
  constructor({ capacityBlocks = 48 } = {}) {
    this.capacity = Math.max(1, capacityBlocks | 0);
    this.blocks = [];
    this.queuedFrames = 0;
    this.droppedBlocks = 0;
    this.droppedFrames = 0;
    this.highWatermarkBlocks = 0;
  }

  push(block, frames) {
    if (this.blocks.length >= this.capacity) {
      const dropped = this.blocks.shift();
      this.queuedFrames -= dropped.frames;
      this.droppedBlocks++;
      this.droppedFrames += dropped.frames;
    }
    this.blocks.push({ buffer: block, frames });
    this.queuedFrames += frames;
    this.highWatermarkBlocks = Math.max(this.highWatermarkBlocks, this.blocks.length);
  }

  shift() {
    const record = this.blocks.shift();
    if (!record) return null;
    this.queuedFrames -= record.frames;
    return record;
  }

  clear() {
    this.blocks = [];
    this.queuedFrames = 0;
  }

  get length() {
    return this.blocks.length;
  }
}

class NativePcmOutput {
  constructor({
    enabled = truthy(process.env.MESHAUDIO_NATIVE_AUDIO),
    helperPath = process.env.MESHAUDIO_NATIVE_HELPER || defaultHelperPath(),
    deviceId = process.env.MESHAUDIO_NATIVE_DEVICE || '',
    sampleRate = 48000,
    channels = 2,
    capacityBlocks = Number(process.env.MESHAUDIO_OUTPUT_QUEUE_BLOCKS) || 48,
    logger = console
  } = {}) {
    this.enabled = enabled;
    this.helperPath = helperPath;
    this.deviceId = deviceId;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.logger = logger;
    this.child = null;
    this.fifo = new AudioBlockFifo({ capacityBlocks });
    this.pool = new Map();
    this.writing = false;
    this.started = false;
    this.writtenBlocks = 0;
    this.backpressureEvents = 0;
    this.lastError = null;
    this.capacityBlocks = this.fifo.capacity;
  }

  status() {
    return {
      enabled: this.enabled,
      running: Boolean(this.child && this.child.exitCode === null),
      helperPath: this.helperPath,
      deviceId: this.deviceId || null,
      sampleRate: this.sampleRate,
      channels: this.channels,
      queuedBlocks: this.fifo.length,
      queuedMs: round1(this.fifo.queuedFrames * 1000 / this.sampleRate),
      droppedBlocks: this.fifo.droppedBlocks,
      droppedMs: round1(this.fifo.droppedFrames * 1000 / this.sampleRate),
      highWatermarkBlocks: this.fifo.highWatermarkBlocks,
      capacityBlocks: this.fifo.capacity,
      writtenBlocks: this.writtenBlocks,
      backpressureEvents: this.backpressureEvents,
      inFlightBytes: Number(this.child?.stdin?.writableLength) || 0,
      lastError: this.lastError
    };
  }

  get droppedBlocks() {
    return this.fifo.droppedBlocks;
  }

  start() {
    if (!this.enabled || this.child) return false;
    if (!fs.existsSync(this.helperPath)) {
      this.lastError = `Native helper not found: ${this.helperPath}`;
      this.logger.warn?.(`[native-audio] ${this.lastError}`);
      return false;
    }
    const args = ['--stdin-pcm'];
    if (this.deviceId) args.push('--device', this.deviceId);
    try {
      this.child = spawn(this.helperPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.lastError = error.message;
      this.child = null;
      this.logger.error?.(`[native-audio] failed to start: ${this.lastError}`);
      return false;
    }
    this.started = false;
    this.child.stdout?.on('data', chunk => this.logger.info?.(`[native-audio] ${String(chunk).trim()}`));
    this.child.stderr?.on('data', chunk => {
      const text = String(chunk).trim();
      if (text) this.logger.warn?.(`[native-audio] ${text}`);
    });
    this.child.on('error', error => {
      this.lastError = error.message;
      this.logger.error?.(`[native-audio] ${this.lastError}`);
    });
    this.child.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) this.lastError = `helper exited with code ${code}${signal ? ` (${signal})` : ''}`;
      this.child = null;
      this.started = false;
      this.writing = false;
      this.fifo.clear();
      this.pool = new Map();
    });
    const header = Buffer.alloc(16);
    header.write('MAPC', 0, 'ascii');
    header.writeUInt16LE(1, 4);
    header.writeUInt16LE(this.channels, 6);
    header.writeUInt32LE(this.sampleRate, 8);
    header.writeUInt32LE(0, 12);
    this.child.stdin.write(header);
    this.started = true;
    return true;
  }

  writeBlock(pcm, frameCount = Math.floor(pcm.length / this.channels)) {
    if (!this.enabled) return false;
    if (!this.child && !this.start()) return false;
    if (!this.child?.stdin?.writable || !this.started) return false;
    if (!(pcm instanceof Float32Array) || pcm.length !== frameCount * this.channels || frameCount <= 0) {
      this.lastError = 'Native output requires a non-empty interleaved Float32Array block.';
      return false;
    }
    const byteLength = 4 + pcm.byteLength;
    const block = this._acquireBuffer(byteLength);
    block.writeUInt32LE(frameCount, 0);
    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(block, 4);
    this.fifo.push(block, frameCount);
    this.flush();
    return true;
  }

  // Serialized blocks vary in size because wall-clock pacing renders exact
  // frame counts, so the pool is bucketed by byte length; steady-state
  // rendering still reuses buffers instead of allocating per tick.
  _acquireBuffer(byteLength) {
    const bucket = this.pool.get(byteLength);
    if (bucket && bucket.length) return bucket.pop();
    return Buffer.allocUnsafe(byteLength);
  }

  _recycleBuffer(block) {
    let bucket = this.pool.get(block.length);
    if (!bucket) {
      bucket = [];
      this.pool.set(block.length, bucket);
    }
    if (bucket.length < 8) bucket.push(block);
  }

  flush() {
    if (this.writing || !this.child?.stdin?.writable) return;
    if (!this.fifo.length) return;
    this.writing = true;
    while (this.fifo.length && this.child?.stdin?.writable) {
      const record = this.fifo.shift();
      if (!record) break;
      const block = record.buffer;
      this.writtenBlocks++;
      const accept = this.child.stdin.write(block, () => this._recycleBuffer(block));
      if (!accept) {
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
        const end = Buffer.alloc(4);
        this.child.stdin.write(end);
        this.child.stdin.end();
      }
    } catch (error) {
      this.lastError = error.message;
    }
    const child = this.child;
    this.fifo.clear();
    this.pool = new Map();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 1500).unref();
  }
}

module.exports = { NativePcmOutput, AudioBlockFifo, truthy, defaultHelperPath, detectVBCable };
