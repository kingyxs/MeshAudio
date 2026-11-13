'use strict';
// Optional diagnostic: independent GStreamer capture of the virtual endpoint
// differentiates renderer/driver gaps from our own capture helper. Never uses
// system loopback. Requires the local developer GStreamer installation.
const fs = require('fs'), path = require('path'), assert = require('assert/strict');
const { spawn } = require('child_process');
const { detectVBCable } = require('../desktop/native-bridge');
const root = path.resolve(__dirname, '..');
const runtime = path.join(root, '.build-tools/msys64/ucrt64/bin/gst-launch-1.0.exe');
const captureFile = path.join(root, '.build-tools/capture-comparison.s16le');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let capture, probe, logs = '';
async function main() {
  const native = detectVBCable(); assert(native.available); assert(fs.existsSync(runtime));
  capture = spawn(runtime, ['-q', 'wasapi2src', `device=${native.captureOutput.id}`, 'low-latency=false', 'buffer-time=100000', 'latency-time=10000', '!', 'audioconvert', '!', 'audio/x-raw,format=S16LE,rate=48000,channels=2', '!', 'filesink', `location=${captureFile.replace(/\\/g, '/')}`], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  capture.stderr.on('data', data => logs += data);
  capture.on('error', error => logs += error.message);
  await sleep(1000);
  probe = spawn(native.helperPath, ['--probe', '--device', native.renderInput.id, '--duration-ms', '30000'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  probe.stderr.on('data', data => logs += data);
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error('Probe timeout')), 40000);
    probe.once('exit', code => { clearTimeout(timeout); resolve(code); });
    probe.once('error', error => { clearTimeout(timeout); reject(error); });
  });
  assert.equal(exit, 0, logs);
  await sleep(1000);
  if (capture.exitCode === null) { const closed = new Promise(resolve => capture.once('exit', resolve)); capture.kill(); await closed; }
  const pcm = fs.readFileSync(captureFile), frames = Math.floor(pcm.length / 4);
  let first = -1, last = -1;
  for (let i = 0; i < frames; i++) if (Math.abs(pcm.readInt16LE(i * 4)) > 100) { if (first < 0) first = i; last = i; }
  const begin = first + 48000, end = last - 48000; assert(end - begin > 48000 * 20, logs || 'too little captured audio');
  let peakStep = 0, previous = 0, quiet = 0, longest = 0, sum = 0;
  for (let i = begin; i < end; i++) { const sample = pcm.readInt16LE(i * 4) / 32768; if (i > begin) peakStep = Math.max(peakStep, Math.abs(sample - previous)); previous = sample; sum += sample * sample; quiet = Math.abs(sample) < .0001 ? quiet + 1 : 0; longest = Math.max(longest, quiet); }
  const report = { ok: peakStep < .08 && longest / 48 < 2, testedAt: new Date().toISOString(), path: 'native probe → WASAPI → VB-CABLE → independent GStreamer capture', seconds: (end - begin) / 48000, rms: Math.sqrt(sum / (end - begin)), peakStep, longestSilenceMs: longest / 48, logs };
  fs.writeFileSync(path.join(root, 'docs/testing/audio/capture-comparison.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
  assert(report.ok, 'Independent capture also contains waveform discontinuities');
}
main().catch(error => { console.error(error, logs); process.exitCode = 1; }).finally(() => { capture?.kill(); probe?.kill(); });
