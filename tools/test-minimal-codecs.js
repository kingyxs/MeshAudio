'use strict';
// Exercise actual staged decoder DLLs, not the developer machine's full FFmpeg.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const msys = path.resolve(process.env.MESHAUDIO_MSYS2 || path.join(root, '.build-tools/msys64'));
const runtime = path.join(root, 'desktop/airplay');
const bin = path.join(msys, 'ucrt64/bin');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-codecs-'));
function imports(file) {
  return [...execFileSync(path.join(bin, 'objdump.exe'), ['-p', file], { encoding: 'utf8', windowsHide: true }).matchAll(/DLL Name:\s*(\S+)/g)].map(m => m[1]);
}
function copy(file, dest) {
  if (fs.existsSync(dest)) return;
  fs.copyFileSync(file, dest);
  for (const name of imports(file)) if (!fs.existsSync(path.join(dir, name)) && fs.existsSync(path.join(bin, name))) copy(path.join(bin, name), path.join(dir, name));
}
try {
  const info = JSON.parse(fs.readFileSync(path.join(runtime, 'build-info.json')));
  assert.equal(info.codecProfile, 'aac-alac-only');
  for (const file of info.files) { const dest = path.join(dir, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(runtime, file), dest); }
  copy(path.join(bin, 'gst-launch-1.0.exe'), path.join(dir, 'gst-launch-1.0.exe'));
  // Only the test demuxers/parser are extra. Never overwrite the staged codecs.
  for (const name of ['isomp4', 'audioparsers']) copy(path.join(msys, 'ucrt64/lib/gstreamer-1.0', `libgst${name}.dll`), path.join(dir, 'lib/gstreamer-1.0', `libgst${name}.dll`));
  const env = { ...process.env, PATH: [dir, process.env.SystemRoot + '\\System32'].join(path.delimiter), GST_PLUGIN_PATH_1_0: path.join(dir, 'lib/gstreamer-1.0'), GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_REGISTRY: path.join(dir, 'registry.bin'), GST_REGISTRY_FORK: 'no' };
  const results = [];
  for (const codec of ['aac', 'alac']) {
    const input = path.join(dir, codec === 'aac' ? 'tone.aac' : 'tone.m4a'), output = path.join(dir, codec + '.pcm');
    execFileSync(path.join(bin, 'ffmpeg.exe'), ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=1', '-ac', '2', '-c:a', codec, input], { windowsHide: true });
    const args = ['-q', 'filesrc', `location=${input.replaceAll('\\', '/')}`, '!', codec === 'aac' ? 'aacparse' : 'qtdemux', '!', `avdec_${codec}`, '!', 'audioconvert', '!', 'audioresample', '!', 'audio/x-raw,format=F32LE,rate=48000,channels=2,layout=interleaved', '!', 'filesink', `location=${output.replaceAll('\\', '/')}`];
    execFileSync(path.join(dir, 'gst-launch-1.0.exe'), args, { cwd: dir, env, windowsHide: true, timeout: 20000 });
    const pcm = fs.readFileSync(output); assert(pcm.length >= 48000 * 8 * .9);
    let energy = 0, crossings = 0, previous = 0, count = 0;
    for (let i = 8 * 4800; i < Math.min(pcm.length, 8 * 43200); i += 8) { const v = pcm.readFloatLE(i); assert(Number.isFinite(v)); energy += v * v; count++; if (v >= 0 && previous < 0) crossings++; previous = v; }
    const rms = Math.sqrt(energy / count), frequency = crossings * 48000 / count;
    assert(rms > .03 && rms < .2, `${codec} RMS ${rms}`); assert(Math.abs(frequency - 440) < 5, `${codec} frequency ${frequency}`);
    results.push({ codec, seconds: pcm.length / (48000 * 8), rms, frequencyHz: frequency });
  }
  const report = { ok: true, testedAt: new Date().toISOString(), profile: info.codecProfile, playbackDeviceUsed: false, tests: results, untested: ['AAC-ELD from a real iPhone', 'actual AirPlay encrypted session and listening quality'] };
  fs.writeFileSync(path.join(root, 'docs/testing/minimal-codecs-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
