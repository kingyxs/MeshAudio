'use strict';
// Synthetic LAN media → native mixer → WASAPI → VB-CABLE only. No system
// loopback capture. Refresh windows and whole-run quality are reported apart.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const net = require('net'), dgram = require('dgram');
const { Worker, isMainThread, workerData } = require('worker_threads');
const { spawn } = require('child_process');
const { performance } = require('perf_hooks');
if (!isMainThread) {
  const socket = dgram.createSocket('udp4');
  const start = performance.now(); let sequence = 0;
  setInterval(() => {
    const due = Math.floor((performance.now() - start) / 10);
    while (sequence < due) {
      const packet = Buffer.alloc(20 + 480 * 8);
      packet.write('MSA1'); packet.writeUInt32LE(workerData.hash, 4); packet.writeUInt32LE(sequence, 8);
      packet.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12);
      for (let i = 0; i < 480; i++) { const sample = Math.sin((sequence * 480 + i) * Math.PI * 2 * 440 / 48000) * .2; packet.writeFloatLE(sample, 20 + i * 8); packet.writeFloatLE(sample, 24 + i * 8); }
      socket.send(packet, workerData.port, '127.0.0.1'); sequence++;
    }
  }, 2);
} else {
  const { detectVBCable } = require('../desktop/native-bridge');
  const root = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-telemetry-audio-'));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let server, capture, sender, controlSocket, control, logs = '', captureLogs = '';
  const chunks = [], refreshes = [], snapshots = [];
  async function freePort(udp = false) { const s = udp ? dgram.createSocket('udp4') : net.createServer(); await new Promise(resolve => udp ? s.bind(0, '127.0.0.1', resolve) : s.listen(0, '127.0.0.1', resolve)); const p = s.address().port; await new Promise(resolve => s.close(resolve)); return p; }
  async function api(route, body) { const r = await fetch(`http://127.0.0.1:${control}${route}`, body === undefined ? {} : { method: route === '/api/config' ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert(r.ok, `${route}: ${r.status}`); return r.json(); }
  async function until(test, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { try { if (await test()) return; } catch {} await sleep(100); } throw Error('Audio regression readiness timeout'); }
  function analyze(pcm, channels, sampleRate) {
    let sum = 0, peakStep = 0, previous = 0, quiet = 0, longestQuiet = 0;
    const jumps = [], silence = [];
    const frames = Math.floor(pcm.length / (channels * 2));
    for (let i = 0; i < frames; i++) {
      const value = pcm.readInt16LE(i * channels * 2) / 32768;
      sum += value * value;
      if (i) { const step = Math.abs(value - previous); peakStep = Math.max(peakStep, step); if (step > .08 && jumps.length < 20) jumps.push({ atSeconds: i / sampleRate, step }); }
      previous = value;
      if (Math.abs(value) < .0001) quiet++;
      else { if (quiet >= sampleRate * .002 && silence.length < 20) silence.push({ atSeconds: (i - quiet) / sampleRate, durationMs: quiet * 1000 / sampleRate }); quiet = 0; }
      longestQuiet = Math.max(longestQuiet, quiet);
    }
    return { seconds: frames / sampleRate, rms: Math.sqrt(sum / Math.max(1, frames)), peakStep, longestSilenceMs: longestQuiet * 1000 / sampleRate, jumps, silence };
  }
  async function main() {
    const native = detectVBCable(); assert(native.available, 'VB-CABLE is required for actual output verification');
    control = await freePort(); const audio = await freePort(true), discovery = await freePort(true);
    server = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
      MESHAUDIO_PORT: String(control), MESHAUDIO_AUDIO_PORT: String(audio), MESHAUDIO_DISCOVERY_PORT: String(discovery), MESHAUDIO_DATA_DIR: dir,
      MESHAUDIO_NATIVE_AUDIO: '1', MESHAUDIO_AIRPLAY_GUIDE_PORT: '0', MESHAUDIO_WEB_MIC_TLS_PORT: '0', MESHAUDIO_PARENT_PID: String(process.pid), MESHAUDIO_CONTROL_BIND_HOST: '127.0.0.1', MESHAUDIO_LATENCY_REFRESH_MS: '5000' } });
    server.stdout.on('data', data => logs += data); server.stderr.on('data', data => logs += data);
    await until(async () => (await api('/api/health')).ok);
    const session = await api('/api/browser-source', { deviceId: 'telemetry-media-test', deviceName: 'Telemetry media', streamType: 'media' });
    await api('/api/config', { routes: [[session.mixerId, 'bus-main'], ['bus-main', 'out-virtual']] });
    controlSocket = new WebSocket(`ws://127.0.0.1:${control}/control`);
    await new Promise((resolve, reject) => { controlSocket.onopen = resolve; controlSocket.onerror = reject; });
    let totalBytes = 0;
    controlSocket.onmessage = event => { const message = JSON.parse(String(event.data)); if (message.type === 'state.telemetry') { assert(!message.config && !message.streams, 'telemetry must not include full topology'); refreshes.push({ at: performance.now(), bytes: totalBytes, source: message.sources.find(s => s.id === session.mixerId) }); } else if (message.type === 'state.snapshot') snapshots.push(performance.now()); };
    sender = new Worker(__filename, { workerData: { hash: session.sourceHash, port: audio } });
    await until(async () => (await api('/api/state')).sources.find(s => s.id === session.mixerId)?.packets > 100);
    await sleep(1000);
    capture = spawn(native.helperPath, ['--capture', '--device', native.captureOutput.id, '--duration-ms', '24000'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const captured = new Promise(resolve => { capture.once('exit', resolve); capture.once('error', error => { captureLogs += error.message; resolve(-1); }); });
    capture.stdout.on('data', data => { chunks.push(Buffer.from(data)); totalBytes += data.length; });
    capture.stderr.on('data', data => captureLogs += data);
    await until(() => totalBytes > 48000 * 4, 30000);
    chunks.length = 0; totalBytes = 0; refreshes.length = 0; snapshots.length = 0;
    const beforeState = await api('/api/state'); const before = beforeState.sources.find(s => s.id === session.mixerId);
    assert.equal(await captured, 0, captureLogs); capture = null;
    const afterState = await api('/api/state'); const after = afterState.sources.find(s => s.id === session.mixerId);
    const format = captureLogs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === 'capture-info');
    assert(format, captureLogs || 'capture descriptor missing');
    const captureStats = captureLogs.split(/\r?\n/).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === 'capture.stats');
    const pcm = Buffer.concat(chunks); const frameBytes = format.channels * 2;
    const quality = analyze(pcm, format.channels, format.sampleRate);
    const windows = refreshes.filter(event => event.bytes > format.sampleRate * frameBytes && event.bytes < pcm.length - format.sampleRate * frameBytes / 2).map(event => {
      const begin = Math.max(0, Math.floor((event.bytes - format.sampleRate * frameBytes * .1) / frameBytes) * frameBytes);
      const end = Math.min(pcm.length, begin + Math.round(format.sampleRate * .4) * frameBytes);
      return { ...event, quality: analyze(pcm.subarray(begin, end), format.channels, format.sampleRate) };
    });
    const report = { ok: quality.rms > .08 && quality.peakStep < .08 && quality.longestSilenceMs < 2 && windows.length >= 3,
      refreshIntervalMs: 5000, refreshesDuringCapture: windows.length, fullSnapshotsAfterWarmup: snapshots.length,
      nativeEngine: afterState.server.audioEngine, nativeOutput: afterState.server.virtualOutput.mode, quality, windows, captureStats,
      counters: { starvedDelta: after.starvedPackets - before.starvedPackets, shortfallFramesDelta: after.shortfallFrames - before.shortfallFrames, lostDelta: after.lostPackets - before.lostPackets, resyncDelta: after.resyncPackets - before.resyncPackets, overflowedDelta: after.overflowedPackets - before.overflowedPackets },
      renderUnderrunsDelta: afterState.server.virtualOutput.renderUnderruns - beforeState.server.virtualOutput.renderUnderruns,
      testedAt: new Date().toISOString(), measuredLatencyMs: after.latencyMs, physicalIPhoneTested: false, captureEndpoint: native.captureOutput.name };
    if (process.env.MESHAUDIO_TEST_SAVE_PCM === '1') fs.writeFileSync(path.join(root, '.build-tools/telemetry-continuity.pcm'), pcm);
    fs.mkdirSync(path.join(root, 'docs/testing/audio'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/audio/telemetry-continuity-report.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(root, 'docs/testing/audio/telemetry-latest-attempt.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    assert(report.ok, 'Audio discontinuity found; inspect telemetry-continuity-report.json');
    assert(report.fullSnapshotsAfterWarmup <= 2, 'Periodic refresh sent full topology snapshots');
  }
  main().catch(error => {
    console.error(error); console.error(logs.slice(-2500), captureLogs); process.exitCode = 1;
    fs.mkdirSync(path.join(root, 'docs/testing/audio'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/testing/audio/telemetry-latest-attempt.json'), JSON.stringify({ ok: false, testedAt: new Date().toISOString(), error: error.message, captureLogs, serverLogs: logs.slice(-2500), physicalIPhoneTested: false, waveformReport: 'telemetry-continuity-report.json (last complete measurement; see its timestamp)' }, null, 2));
  }).finally(async () => {
    await sender?.terminate(); capture?.kill(); controlSocket?.close();
    if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}
