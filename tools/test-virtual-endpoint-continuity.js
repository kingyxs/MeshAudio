'use strict';
// Diagnostic baseline: bypass network, Node mixing and telemetry entirely.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { detectVBCable } = require('../desktop/native-bridge');
const native = detectVBCable();
const gstreamer = process.argv.includes('--gstreamer');
const durationIndex = process.argv.indexOf('--duration-ms');
const toneDurationMs = durationIndex < 0 ? 12000 : Number(process.argv[durationIndex + 1]);
assert(Number.isInteger(toneDurationMs) && toneDurationMs >= 8000 && toneDurationMs <= 60000);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let capture, probe, chunks = [], logs = '';
async function main() {
  assert(native.available);
  const openedAt = Date.now();
  capture = spawn(native.helperPath, ['--capture', '--device', native.captureOutput.id, '--duration-ms', String(toneDurationMs + 4000)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const finished = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { capture.kill(); reject(Error('Capture did not finish within its deadline; inspect Windows Audio service and capture logs.')); }, toneDurationMs + 30000);
    capture.once('exit', code => { clearTimeout(timeout); resolve(code); });
    capture.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  capture.on('error', error => logs += `capture startup: ${error.message}\n`);
  capture.stdout.on('data', data => chunks.push(Buffer.from(data))); capture.stderr.on('data', data => logs += data);
  // Endpoint initialization can take several seconds after Windows Audio has
  // restarted. Wait for the descriptor before generating the finite probe, or
  // that probe can finish while capture is still opening. Readiness does not
  // require PCM: an inactive virtual render side need not emit silent packets.
  for (let i = 0; i < 250 && !logs.includes('capture-info') && capture.exitCode === null; i++) await sleep(100);
  assert(logs.includes('capture-info'), logs || 'capture not ready within 25 seconds');
  const captureStartupMs = Date.now() - openedAt;
  probe = gstreamer
    ? spawn(path.join(__dirname, '../.build-tools/msys64/ucrt64/bin/gst-launch-1.0.exe'), ['-q', 'audiotestsrc', 'is-live=true', 'wave=sine', 'freq=440', 'volume=0.2', 'samplesperbuffer=480', `num-buffers=${Math.round(toneDurationMs / 10)}`, '!', 'audio/x-raw,format=F32LE,rate=48000,channels=2', '!', 'wasapisink', `device=${native.renderInput.id}`, 'exclusive=false', 'buffer-time=40000', 'latency-time=10000'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    : spawn(native.helperPath, ['--probe', '--device', native.renderInput.id, '--duration-ms', String(toneDurationMs)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  probe.stderr.on('data', data => logs += data);
  probe.on('error', error => logs += error.message);
  assert.equal(await finished, 0, logs);
  const pcm = Buffer.concat(chunks);
  const format = logs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === 'capture-info');
  assert(format);
  const stride = format.channels * 2; const frames = pcm.length / stride;
  let first = 0, last = 0;
  for (let i = 0; i < frames; i++) if (Math.abs(pcm.readInt16LE(i * stride)) > 100) { if (!first) first = i; last = i; }
  const begin = first + format.sampleRate, end = last - format.sampleRate;
  assert(end - begin >= format.sampleRate * 5, `too little tone: ${(last - first) / format.sampleRate}s`);
  let peakStep = 0, sum = 0, previous = 0, quiet = 0, longestQuiet = 0;
  for (let i = begin; i < end; i++) { const value = pcm.readInt16LE(i * stride) / 32768; sum += value ** 2; if (i > begin) peakStep = Math.max(peakStep, Math.abs(value - previous)); previous = value; quiet = Math.abs(value) < .0001 ? quiet + 1 : 0; longestQuiet = Math.max(longestQuiet, quiet); }
  const report = { ok: peakStep < .08 && longestQuiet * 1000 / format.sampleRate < 2, path: `${gstreamer ? 'GStreamer' : 'native'} deterministic probe → WASAPI → VB-CABLE capture; no network or telemetry`,
    testedAt: new Date().toISOString(), captureStartupMs,
    seconds: (end - begin) / format.sampleRate, rms: Math.sqrt(sum / (end - begin)), peakStep, longestSilenceMs: longestQuiet * 1000 / format.sampleRate, logs };
  const output = path.join(__dirname, '../docs/testing/audio'); fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, gstreamer ? 'virtual-endpoint-gstreamer-baseline.json' : 'virtual-endpoint-baseline.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  assert(report.ok, 'Independent endpoint waveform did not pass continuity acceptance');
}
main().catch(error => { console.error(error, logs); process.exitCode = 1; }).finally(() => { capture?.kill(); probe?.kill(); });
