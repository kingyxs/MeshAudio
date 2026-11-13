// Measures discontinuities in a rendered WAV so clock compensation can be
// checked without listening to it.
//
// A dropped sample (the old "skip a frame" approach) produces a step that is
// several times larger than the signal's own slope: for the 440 Hz test tone at
// 0.2 amplitude and 48 kHz the maximum legitimate step is ~0.0115, while a
// dropped sample doubles it. Counting steps above that bound is therefore a
// direct measurement of click density.
//
// Usage: node tools/analyze-wav.js <file.wav> [toneHz] [toneAmplitude]
const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/analyze-wav.js <file.wav> [toneHz] [toneAmplitude]');
  process.exit(2);
}
const toneHz = Number(process.argv[3]) || 440;
const toneAmplitude = Number(process.argv[4]) || 0.2;

const buffer = fs.readFileSync(file);
if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
  console.error('not a RIFF/WAVE file');
  process.exit(2);
}
let offset = 12;
let format = null;
let data = null;
while (offset + 8 <= buffer.length) {
  const id = buffer.toString('ascii', offset, offset + 4);
  const size = buffer.readUInt32LE(offset + 4);
  const body = offset + 8;
  if (id === 'fmt ') {
    format = {
      channels: buffer.readUInt16LE(body + 2),
      sampleRate: buffer.readUInt32LE(body + 4),
      bits: buffer.readUInt16LE(body + 14)
    };
  } else if (id === 'data') {
    data = buffer.subarray(body, Math.min(body + size, buffer.length));
  }
  offset = body + size + (size % 2);
}
if (!format || !data) {
  console.error('missing fmt or data chunk');
  process.exit(2);
}
if (format.bits !== 16) {
  console.error(`unsupported sample width: ${format.bits}`);
  process.exit(2);
}

const channels = format.channels;
const frames = Math.floor(data.length / (2 * channels));
const samples = new Float32Array(frames * channels);
for (let i = 0; i < samples.length; i++) samples[i] = data.readInt16LE(i * 2) / 32768;

// Theoretical maximum step of the test tone.
const expectedStep = 2 * Math.PI * toneHz / format.sampleRate * toneAmplitude;
const threshold = expectedStep * 1.6;

let peak = 0;
let energy = 0;
let dc = 0;
let maxStep = 0;
const clicks = [];
for (let frame = 1; frame < frames; frame++) {
  for (let channel = 0; channel < channels; channel++) {
    const value = samples[frame * channels + channel];
    const previous = samples[(frame - 1) * channels + channel];
    const step = Math.abs(value - previous);
    if (step > maxStep) maxStep = step;
    if (step > threshold) clicks.push({ frame, seconds: frame / format.sampleRate, step });
  }
}
for (let i = 0; i < samples.length; i++) {
  const value = samples[i];
  peak = Math.max(peak, Math.abs(value));
  energy += value * value;
  dc += value;
}
const rms = Math.sqrt(energy / samples.length);
const seconds = frames / format.sampleRate;
const tail = clicks.slice(-3).map(c => `${c.seconds.toFixed(3)}s(${c.step.toFixed(4)})`).join(' ');

console.log(JSON.stringify({
  file,
  channels,
  sampleRate: format.sampleRate,
  seconds: Number(seconds.toFixed(2)),
  peak: Number(peak.toFixed(4)),
  rms: Number(rms.toFixed(4)),
  dc: Number((dc / samples.length).toFixed(5)),
  expectedMaxStep: Number(expectedStep.toFixed(5)),
  maxStep: Number(maxStep.toFixed(5)),
  stepRatio: Number((maxStep / expectedStep).toFixed(2)),
  clicks: clicks.length,
  clicksPerSecond: Number((clicks.length / seconds).toFixed(1)),
  lastClicks: tail
}, null, 1));
