// Frame-exact MSA1 sender used by local soak checks.
//
// A plain setInterval(5ms) sender is wrong on Windows: timer granularity is
// ~15.6 ms, so it delivers only a fraction of real-time audio and makes the
// receiver look like it is starving. This sender accumulates the packets that
// wall-clock time actually demands and sends them in the same way a
// device-paced capture thread would.
//
// Usage: node tools/send-soak-audio.js [host] [seconds] [port] [packetMs] [driftPct]
//
// driftPct simulates a capture clock that does not match the playback device,
// which is the normal case in the field (a phone's ADC runs on its own crystal,
// typically a few hundred ppm away, sometimes 1 %+ on cheap parts). Positive
// values send faster than real time. The receiver must absorb the difference by
// resampling; dropping samples to do it is audible as a buzz.
const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const host = process.argv[2] || '127.0.0.1';
const seconds = Number(process.argv[3]) || 20;
const port = Number(process.argv[4]) || 4175;
const packetMs = Number(process.argv[5]) || 5;
const drift = 1 + (Number(process.argv[6]) || 0) / 100;
const rate = 48000;
const frames = Math.round(rate * packetMs / 1000);
const pcm = Buffer.alloc(frames * 2 * 4);
for (let i = 0; i < frames; i++) {
  const value = Math.sin(2 * Math.PI * 440 * i / rate) * 0.2;
  pcm.writeFloatLE(value, i * 8);
  pcm.writeFloatLE(value, i * 8 + 4);
}
let sequence = 0;
let producedFrames = 0;
const startedAt = Date.now();
function pump() {
  const elapsed = Date.now() - startedAt;
  const dueFrames = Math.round(elapsed * rate / 1000 * drift);
  while (producedFrames + frames <= dueFrames) {
    const header = Buffer.alloc(20);
    header.write('MSA1', 0);
    header.writeUInt32LE(0x1234, 4);
    header.writeUInt32LE(sequence++, 8);
    header.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12);
    socket.send(Buffer.concat([header, pcm]), port, host);
    producedFrames += frames;
  }
  if (elapsed >= seconds * 1000) {
    clearInterval(timer);
    socket.close();
    console.log(`sent ${sequence} packets (${(producedFrames / rate).toFixed(2)} s of audio) in ${((Date.now() - startedAt) / 1000).toFixed(1)} s to ${host}:${port}`);
  }
}
const timer = setInterval(pump, 5);
pump();
