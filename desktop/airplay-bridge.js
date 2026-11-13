#!/usr/bin/env node
/**
 * MeshAudio AirPlay bridge
 *
 * The native AirPlay receiver runs as a separately managed process.
 * This process is MeshAudio-owned (MIT) and only does
 * format adaptation:
 *
 *   receiver PCM (s16le/f32le, 44.1k, stereo)
 *     -> float32, 48 kHz, interleaved stereo
 *     -> MSA1 packets (20-byte header + PCM)
 *     -> UDP 127.0.0.1:<audioPort>
 *
 * Because it feeds the same UDP ingress as a phone node, the Mixer, native
 * engine, routing and voice chain all apply without further changes.
 *
 * Usage:
 *   node desktop/airplay-bridge.js --control-port 4173 --audio-port 4175 \
 *        --listen-port 4180 --source-rate 44100 --format s16le
 *
 * Receiver side (UxPlay example):
 *   uxplay -n "MeshAudio" -vs 0 -as "audio/x-raw,format=S16LE,rate=48000,channels=2 ! tcpclientsink host=127.0.0.1 port=4180"
 *
 * shairport-sync can pipe raw PCM instead:
 *   shairport-sync --configfile=...   # output_backend = "pipe", format s16le/44100/2
 *   node desktop/airplay-bridge.js --stdin ...
 */
'use strict';

const net = require('net');
const dgram = require('dgram');
const http = require('http');

const TARGET_RATE = 48000;
const PACKET_FRAMES = 240;              // 5 ms at 48 kHz
const MAX_QUEUE_MS = 200;
const REGISTER_RETRY_MS = 2000;
const MAX_BUFFERED_BYTES = 1024 * 1024;

function parseArgs(argv) {
  const options = {
    controlPort: 4173,
    audioPort: 4175,
    listenPort: 4180,
    format: 's16le',
    sourceRate: 44100,
    sourceChannels: 2,
    deviceId: 'airplay-bridge',
    deviceName: 'AirPlay 接收端',
    stdin: false,
    statsInterval: 5000
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = () => argv[++index];
    switch (flag) {
      case '--control-port': options.controlPort = Number(value()); break;
      case '--audio-port': options.audioPort = Number(value()); break;
      case '--listen-port': options.listenPort = Number(value()); break;
      case '--format': options.format = String(value() || '').toLowerCase(); break;
      case '--source-rate': options.sourceRate = Number(value()); break;
      case '--source-channels': options.sourceChannels = Number(value()); break;
      case '--device-id': options.deviceId = String(value() || options.deviceId); break;
      case '--device-name': options.deviceName = String(value() || options.deviceName); break;
      case '--stdin': options.stdin = true; break;
      case '--stats-interval': options.statsInterval = Number(value()); break;
      default: break;
    }
  }
  if (!Number.isFinite(options.sourceRate) || options.sourceRate < 8000) options.sourceRate = 44100;
  if (![1, 2].includes(options.sourceChannels)) options.sourceChannels = 2;
  if (!['s16le', 'f32le'].includes(options.format)) options.format = 's16le';
  return options;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(message) {
  console.log(`[airplay] ${message}`);
}

// Registration makes the source visible in the canvas before any audio
// arrives, so the user can pre-wire a route and see it come online later.
function registerSource(options) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify({
      deviceId: options.deviceId,
      deviceName: options.deviceName,
      streamType: 'media',
      transport: 'airplay'
    }));
    const request = http.request({
      host: '127.0.0.1',
      port: options.controlPort,
      path: '/api/external-source',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
      timeout: 3000
    }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          return reject(new Error(`register HTTP ${response.statusCode}: ${body}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('timeout', () => request.destroy(new Error('register timeout')));
    request.on('error', reject);
    request.end(payload);
  });
}

// Linear interpolation is enough here: the receiver already decoded lossless
// ALAC/AAC, and the ratio is a fixed 44.1/48 conversion, not clock tracking.
class StereoResampler {
  constructor(inputRate, outputRate) {
    this.step = inputRate / outputRate;
    this.position = 0;
    this.prevLeft = 0;
    this.prevRight = 0;
    this.primed = false;
  }

  process(left, right) {
    if (Math.abs(this.step - 1) < 1e-6) {
      const passthrough = new Float32Array(left.length * 2);
      for (let index = 0; index < left.length; index++) {
        passthrough[index * 2] = left[index];
        passthrough[index * 2 + 1] = right[index];
      }
      return passthrough;
    }
    const capacity = Math.ceil(left.length / this.step) * 2 + 8;
    const output = new Float32Array(capacity);
    let written = 0;
    let position = this.position;
    let prevLeft = this.primed ? this.prevLeft : (left[0] || 0);
    let prevRight = this.primed ? this.prevRight : (right[0] || 0);
    for (let index = 0; index < left.length; index++) {
      const currentLeft = left[index];
      const currentRight = right[index];
      while (position < 1 && written + 2 <= capacity) {
        output[written++] = prevLeft + (currentLeft - prevLeft) * position;
        output[written++] = prevRight + (currentRight - prevRight) * position;
        position += this.step;
      }
      position -= 1;
      prevLeft = currentLeft;
      prevRight = currentRight;
    }
    this.position = position;
    this.prevLeft = prevLeft;
    this.prevRight = prevRight;
    this.primed = true;
    return output.subarray(0, written);
  }
}

class FrameQueue {
  constructor(maxFrames) {
    this.data = new Float32Array(maxFrames * 2);
    this.maxFrames = maxFrames;
    this.readFrame = 0;
    this.count = 0;
    this.trimmed = 0;
  }

  push(interleaved) {
    let frames = Math.floor(interleaved.length / 2);
    if (!frames) return;
    if (frames > this.maxFrames) {
      interleaved = interleaved.subarray((frames - this.maxFrames) * 2);
      frames = this.maxFrames;
    }
    const overflow = Math.max(0, this.count + frames - this.maxFrames);
    if (overflow) {
      this.readFrame = (this.readFrame + overflow) % this.maxFrames;
      this.count -= overflow;
      this.trimmed += overflow;
    }
    let writeFrame = (this.readFrame + this.count) % this.maxFrames;
    for (let index = 0; index < frames; index++) {
      this.data[writeFrame * 2] = interleaved[index * 2];
      this.data[writeFrame * 2 + 1] = interleaved[index * 2 + 1];
      writeFrame = (writeFrame + 1) % this.maxFrames;
    }
    this.count += frames;
  }

  pop(frames, target) {
    if (this.count < frames) return false;
    for (let index = 0; index < frames; index++) {
      target[index * 2] = this.data[this.readFrame * 2];
      target[index * 2 + 1] = this.data[this.readFrame * 2 + 1];
      this.readFrame = (this.readFrame + 1) % this.maxFrames;
    }
    this.count -= frames;
    return true;
  }
}

function buildPacket(sourceHash, sequence, pcm) {
  const packet = Buffer.allocUnsafe(20 + pcm.length * 4);
  packet.write('MSA1', 0);
  packet.writeUInt32LE(sourceHash >>> 0, 4);
  packet.writeUInt32LE(sequence >>> 0, 8);
  packet.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12);
  for (let index = 0; index < pcm.length; index++) {
    packet.writeFloatLE(pcm[index], 20 + index * 4);
  }
  return packet;
}

async function main() {
  const parent = Number(process.env.MESHAUDIO_BRIDGE_PARENT);
  if (Number.isInteger(parent) && parent > 0) {
    const watchdog = setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 1000);
    watchdog.unref();
  }
  const options = parseArgs(process.argv.slice(2));
  const bytesPerSample = options.format === 'f32le' ? 4 : 2;
  const frameBytes = options.sourceChannels * bytesPerSample;
  const queue = new FrameQueue(Math.round(TARGET_RATE * MAX_QUEUE_MS / 1000));
  let resampler = new StereoResampler(options.sourceRate, TARGET_RATE);
  const packet = new Float32Array(PACKET_FRAMES * 2);
  const socket = dgram.createSocket('udp4');
  const stats = {
    sent: 0,
    sequence: 0,
    underrun: 0,
    clients: 0,
    bytesIn: 0,
    lastPeak: 0,
    startedAt: Date.now()
  };

  let session = null;
  while (!session) {
    try {
      session = await registerSource(options);
    } catch (error) {
      log(`register failed: ${error.message}; retrying in ${REGISTER_RETRY_MS} ms`);
      await sleep(REGISTER_RETRY_MS);
    }
  }
  const audioPort = Number(session.audioPort) || options.audioPort;
  log(`source ${session.sourceId} registered -> udp 127.0.0.1:${audioPort}`);

  let partial = Buffer.alloc(0);

  function consume(chunk) {
    stats.bytesIn += chunk.length;
    partial = partial.length ? Buffer.concat([partial, chunk]) : chunk;
    if (partial.length > MAX_BUFFERED_BYTES) {
      // A stuck receiver must not grow memory forever; keep the tail.
      partial = partial.subarray(partial.length - MAX_BUFFERED_BYTES);
    }
    const frames = Math.floor(partial.length / frameBytes);
    if (!frames) return;
    const usable = frames * frameBytes;
    const block = partial.subarray(0, usable);
    partial = partial.subarray(usable);

    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let index = 0; index < frames; index++) {
      const offset = index * frameBytes;
      if (options.format === 'f32le') {
        left[index] = block.readFloatLE(offset);
        right[index] = options.sourceChannels === 2 ? block.readFloatLE(offset + 4) : left[index];
      } else {
        left[index] = block.readInt16LE(offset) / 32768;
        right[index] = options.sourceChannels === 2 ? block.readInt16LE(offset + 2) / 32768 : left[index];
      }
    }
    queue.push(resampler.process(left, right));
  }

  if (options.stdin) {
    process.stdin.on('data', consume);
    process.stdin.on('error', error => log(`stdin error: ${error.message}`));
    log('reading PCM from stdin');
  } else {
    const server = net.createServer(connection => {
      if (stats.clients) { connection.destroy(); log('second PCM client rejected: use a separate AirPlay line'); return; }
      stats.clients++;
      log(`receiver connected from ${connection.remoteAddress}`);
      connection.on('data', consume);
      connection.on('error', error => log(`receiver error: ${error.message}`));
      connection.on('close', () => {
        stats.clients = Math.max(0, stats.clients - 1);
        partial = Buffer.alloc(0);
        queue.count = 0; queue.readFrame = 0;
        resampler = new StereoResampler(options.sourceRate, TARGET_RATE);
        started = false; silentStreak = 0;
        log('receiver disconnected');
      });
    });
    server.on('error', error => {
      log(`listen failed: ${error.message}`);
      process.exit(1);
    });
    server.listen(options.listenPort, '127.0.0.1', () => {
      log(`listening for ${options.format} ${options.sourceRate} Hz x${options.sourceChannels} on 127.0.0.1:${options.listenPort}`);
    });
  }

  // Wall-clock pacing, not "one packet per timer tick": Windows timers fire at
  // 12-16 ms, which would otherwise halve the produced audio rate.
  // Pre-roll: hold playback until ~150 ms is buffered. Receivers deliver PCM in
  // 50 ms blocks, so without a cushion the bridge sits exactly at the underrun
  // boundary and pads silence on every scheduling hiccup — which also makes the
  // source look like a live silent stream.
  const PREROLL_FRAMES = Math.round(TARGET_RATE * 0.06);
  let clockStart = performance.now();
  let sentFrames = 0;
  let silentStreak = 0;
  let started = false;
  const timer = setInterval(() => {
    if (!started) {
      if (queue.count < PREROLL_FRAMES) return;
      started = true;
      clockStart = performance.now();
      sentFrames = 0;
      return;
    }
    const elapsed = performance.now() - clockStart;
    let deficit = Math.floor(elapsed * TARGET_RATE / 1000) - sentFrames;
    if (deficit > TARGET_RATE * 0.2) {
      // More than 200 ms behind (GC pause / resume after suspend): resync
      // instead of dumping a burst into the mixer.
      clockStart = performance.now();
      sentFrames = 0;
      deficit = 0;
      log('clock resync after long stall');
    }
    while (deficit >= PACKET_FRAMES) {
      if (!queue.pop(PACKET_FRAMES, packet)) {
        // A short gap is padded with silence so the timeline stays intact, but
        // an idle receiver must not look like a live silent source forever.
        if (silentStreak >= 40) {
          started = false;
          silentStreak = 0;
          break;
        }
        packet.fill(0);
        stats.underrun++;
        silentStreak++;
      } else {
        silentStreak = 0;
      }
      socket.send(buildPacket(session.sourceHash, stats.sequence++, packet), audioPort, '127.0.0.1');
      stats.sent++;
      sentFrames += PACKET_FRAMES;
      deficit -= PACKET_FRAMES;
      let peak = 0;
      for (let index = 0; index < packet.length; index++) {
        const magnitude = Math.abs(packet[index]);
        if (magnitude > peak) peak = magnitude;
      }
      stats.lastPeak = peak;
    }
  }, 5);

  const statsTimer = setInterval(() => {
    console.log(JSON.stringify({
      type: 'airplay.stats',
      sent: stats.sent,
      underrun: stats.underrun,
      trimmedFrames: queue.trimmed,
      queuedMs: Math.round(queue.count / TARGET_RATE * 1000),
      clients: stats.clients,
      bytesIn: stats.bytesIn,
      lastPeak: Number(stats.lastPeak.toFixed(4)),
      uptimeSec: Math.round((Date.now() - stats.startedAt) / 1000)
    }));
  }, Math.max(1000, options.statsInterval));

  const shutdown = () => {
    clearInterval(timer);
    clearInterval(statsTimer);
    try { socket.close(); } catch { /* already closed */ }
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('uncaughtException', error => {
    log(`fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { StereoResampler, FrameQueue, buildPacket };
if (require.main === module) main().catch(error => {
  log(`failed to start: ${error.stack || error.message}`);
  process.exit(1);
});
