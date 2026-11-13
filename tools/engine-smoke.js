// Standalone smoke test for the native mix engine (MSMP v1).
//
// Spawns meshaudio-native.exe --engine, sends one source route plus paced
// 5 ms float32 packets, and prints the engine's per-second stats. Run it while
// changing server.js so the C++ path can be validated on its own.
//
// Usage: node tools/engine-smoke.js [device] [seconds] [packetMs] [driftPct] [wavPath] [targetMs] [voice] [amplitude]
const { spawn } = require('child_process');
const path = require('path');

const helper = process.env.MESHAUDIO_NATIVE_HELPER || path.join(__dirname, '..', 'desktop', 'native', 'build', 'meshaudio-native.exe');
const device = process.argv[2] || '';
const seconds = Number(process.argv[3]) || 10;
const packetMs = Number(process.argv[4]) || 5;
const drift = 1 + (Number(process.argv[5]) || 0) / 100;
const wavPath = process.argv[6] || '';
const targetMs = process.argv[7] || '';
const voice = process.argv[8] === '1';
const amplitude = Number(process.argv[9]) || 0.2;
const channels = 2;
const rate = 48000;
const frames = Math.round(rate * packetMs / 1000);
const sourceHash = 0x1234;
const busMask = 1n;

function record(tag, payload) {
  const header = Buffer.alloc(8);
  header.write(tag, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function configRecord() {
  const payload = Buffer.alloc(12 + 20 + 8);
  payload.writeUInt16LE(1, 0);
  payload.writeUInt16LE(channels, 2);
  payload.writeUInt32LE(rate, 4);
  payload.writeUInt16LE(1, 8);
  payload.writeUInt16LE(1, 10);
  let offset = 12;
  payload.writeUInt32LE(sourceHash, offset);
  payload.writeFloatLE(1, offset + 4);
  payload.writeUInt8(0, offset + 8);
  payload.writeUInt8(0, offset + 9);
  payload.writeUInt16LE(voice ? 1 : 0, offset + 10);
  payload.writeBigUInt64LE(busMask, offset + 12);
  offset += 20;
  payload.writeFloatLE(1, offset);
  payload.writeUInt8(0, offset + 4);
  return record('MCFG', payload);
}

const args = ['--engine'];
if (wavPath) args.push('--wav', wavPath);
else if (device) args.push('--device', device);
if (targetMs) args.push('--target-ms', targetMs);
const child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

const header = Buffer.alloc(16);
header.write('MSMP', 0, 'ascii');
header.writeUInt16LE(1, 4);
header.writeUInt16LE(channels, 6);
header.writeUInt32LE(rate, 8);
child.stdin.write(header);
child.stdin.write(configRecord());

let statsLines = 0;
let renderedPrev = null;
let renderedAt = Date.now();
child.stdout.on('data', chunk => {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('{')) {
      statsLines++;
      const stats = JSON.parse(line);
      const source = (stats.sources || [])[0] || {};
      const now = Date.now();
      const rate = renderedPrev === null ? 1 : (stats.renderedMs - renderedPrev) / ((now - renderedAt) / 1000);
      renderedPrev = stats.renderedMs;
      renderedAt = now;
      console.log(`[engine] rendered=${stats.renderedMs}ms speed=${rate.toFixed(2)}x queued=${source.queuedMs}ms ppm=${source.ratePpm} recv=${source.received} starved=${source.starved} lost=${source.lost} resync=${source.resync} voice=${source.voice}`);
    } else {
      console.log(`[helper] ${line}`);
    }
  }
});
child.stderr.on('data', chunk => console.log(`[helper:err] ${String(chunk).trim()}`));
child.on('exit', code => {
  console.log(`helper exited with ${code}, stats lines: ${statsLines}`);
  process.exit(code === 0 ? 0 : 1);
});

// The tone must be phase-continuous across packets. Re-sending one fixed 5 ms
// buffer restarts the waveform every packet (440 Hz is not an integer number of
// cycles in 240 samples), which is itself a click train and would mask whatever
// the engine does.
const toneHz = 440;
let tonePhase = 0;
function nextPacket() {
  const pcm = Buffer.alloc(frames * channels * 4);
  for (let i = 0; i < frames; i++) {
    const value = Math.sin(tonePhase) * amplitude;
    tonePhase += 2 * Math.PI * toneHz / rate;
    if (tonePhase >= 2 * Math.PI) tonePhase -= 2 * Math.PI;
    pcm.writeFloatLE(value, i * channels * 4);
    pcm.writeFloatLE(value, i * channels * 4 + 4);
  }
  return pcm;
}

let sequence = 0;
let produced = 0;
const started = Date.now();
const timer = setInterval(() => {
  const elapsed = Date.now() - started;
  const target = Math.round(elapsed * rate / 1000 * drift);
  while (produced + frames <= target) {
    const pcm = nextPacket();
    const payload = Buffer.alloc(16 + pcm.length);
    payload.writeUInt32LE(sourceHash, 0);
    payload.writeUInt32LE(sequence++, 4);
    payload.writeUInt32LE(frames, 8);
    pcm.copy(payload, 16);
    child.stdin.write(record('PCM ', payload));
    produced += frames;
  }
  if (elapsed >= seconds * 1000) {
    clearInterval(timer);
    child.stdin.write(record('END ', Buffer.alloc(0)));
    child.stdin.end();
  }
}, 5);
