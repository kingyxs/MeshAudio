'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const { spawn, spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-airplay-lines-'));
const ids = [];
let child, control, logs = '';
const checks = [];
async function freePort(udp = false) {
  const socket = udp ? dgram.createSocket('udp4') : net.createServer();
  await new Promise(resolve => udp ? socket.bind(0, '127.0.0.1', resolve) : socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve)); return port;
}
async function request(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${control}${route}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}), signal: AbortSignal.timeout(20000) });
  return { status: response.status, body: await response.json() };
}
async function ok(method, route, body) {
  const result = await request(method, route, body);
  assert(result.status < 300, `${route}: ${JSON.stringify(result)}`); return result.body;
}
async function until(predicate, timeout = 7000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await predicate(); if (value) return value; await sleep(100); }
  throw new Error('Condition timed out');
}
function tone(port, amplitude) {
  const connection = net.connect(port, '127.0.0.1');
  connection.on('error', () => {});
  let phase = 0;
  const timer = setInterval(() => {
    const pcm = Buffer.alloc(480 * 4);
    for (let i = 0; i < 480; i++, phase++) { const value = Math.round(Math.sin(phase * 2 * Math.PI * 440 / 48000) * amplitude * 32767); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); }
    if (!connection.destroyed) connection.write(pcm);
  }, 10);
  return () => { clearInterval(timer); connection.destroy(); };
}
function receiverInfo(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1'); let data = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(Error('RTSP info timed out')); }, 4000);
    socket.on('error', reject);
    socket.on('connect', () => socket.write('GET /info RTSP/1.0\r\nCSeq: 1\r\nUser-Agent: MeshAudio-regression\r\n\r\n'));
    socket.on('data', chunk => {
      data = Buffer.concat([data, chunk]); const end = data.indexOf('\r\n\r\n'); if (end < 0) return;
      const headers = data.subarray(0, end).toString(); const length = Number(headers.match(/Content-Length:\s*(\d+)/i)?.[1]);
      if (!Number.isFinite(length) || data.length < end + 4 + length) return;
      clearTimeout(timer); socket.destroy(); resolve(data.subarray(end + 4, end + 4 + length));
    });
  });
}
async function main() {
  control = await freePort();
  const discovery = await freePort(true), audio = await freePort(true);
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MESHAUDIO_PORT: String(control), MESHAUDIO_DISCOVERY_PORT: String(discovery), MESHAUDIO_AUDIO_PORT: String(audio), MESHAUDIO_AIRPLAY_GUIDE_PORT: '0', MESHAUDIO_NATIVE_AUDIO: '0', MESHAUDIO_DATA_DIR: dir, MESHAUDIO_CONTROL_BIND_HOST: '127.0.0.1', MESHAUDIO_PARENT_PID: String(process.pid) } });
  child.stdout.on('data', data => logs += String(data)); child.stderr.on('data', data => logs += String(data));
  await until(async () => { try { return (await request('GET', '/api/health')).body.ok; } catch { return false; } }, 10000);
  const iosPage = await fetch(`http://127.0.0.1:${control}/ios-node.html`);
  assert.equal(iosPage.status, 200); assert((await iosPage.text()).includes('网页麦克风'));
  checks.push('iOS web microphone alias serves the microphone page');
  const initial = await ok('GET', '/api/airplay-lines');
  assert.equal(initial.lines.length, 0); checks.push('fresh startup creates no receiver lines/processes');
  assert(initial.receiver?.endsWith('uxplay.exe'), 'native UxPlay missing');
  const first = (await ok('POST', '/api/airplay-lines', {})).line; ids.push(first.id);
  const second = (await ok('POST', '/api/airplay-lines', {})).line; ids.push(second.id);
  assert.notEqual(first.sourceId, second.sourceId); assert.notEqual(first.bridgePort, second.bridgePort); assert.notEqual(first.uxplayPort, second.uxplayPort);
  checks.push('two distinct receiver/source/PCM/RTSP identities');
  const ready = await Promise.all(ids.map(id => ok('POST', `/api/airplay-lines/${id}/start`, {})));
  assert(ready.every(item => item.line.state === 'ready' && item.line.pid && item.line.bridgePid));
  checks.push('two native UxPlay and PCM bridges start concurrently, audio-only');
  const info = await receiverInfo(first.uxplayPort + 1);
  assert.equal((await ok('GET', '/api/airplay-lines')).lines[0].state, 'ready');
  checks.push('real native RTSP /info probe does not mark an iPhone connected');
  const plistutil = path.join(root, '.build-tools/msys64/ucrt64/bin/plistutil.exe');
  if (fs.existsSync(plistutil)) {
    const input = path.join(dir, 'receiver-info.plist'); fs.writeFileSync(input, info);
    const decoded = spawnSync(plistutil, ['-i', input, '-f', 'xml'], { windowsHide: true });
    assert.equal(decoded.status, 0, `${decoded.stderr}\n${decoded.stdout}`);
    assert.match(decoded.stdout.toString(), /<key>maxFPS<\/key>\s*<integer>30<\/integer>/);
    checks.push('native receiver advertises 30 FPS instead of the removed audio-only 1 FPS cap');
  }
  const repeat = await ok('POST', `/api/airplay-lines/${first.id}/start`, {});
  assert.equal(repeat.line.pid, ready[0].line.pid); checks.push('idempotent start reuses the process');
  const listed = (await ok('GET', '/api/airplay-lines')).lines;
  assert(listed.every(line => line.source && line.guideUrl));
  const guide = await fetch(listed[0].guideUrl.replace(new URL(listed[0].guideUrl).hostname, '127.0.0.1'));
  const html = await guide.text(); assert(html.includes(first.name)); assert(!html.includes('<b>' + second.name + '</b>'));
  const guideApi = await fetch(new URL('/api/config', listed[0].guideUrl).href.replace(new URL(listed[0].guideUrl).hostname, '127.0.0.1'));
  assert.equal(guideApi.status, 404); checks.push('per-line phone guide reachable; LAN guide exposes no control API');
  const snapshot = await ok('GET', '/api/state');
  const source1 = snapshot.sources.find(source => source.airplayLineId === first.id);
  const source2 = snapshot.sources.find(source => source.airplayLineId === second.id);
  assert(source1 && source2);
  assert.equal(source1.gain, 1); assert.equal(source2.gain, 1);
  checks.push('new AirPlay sources default to unity gain for the native output engine');
  await ok('PUT', '/api/config', { sources: [] });
  const preserved = await ok('GET', '/api/state');
  assert(preserved.sources.some(source => source.airplayLineId === first.id));
  checks.push('source snapshots cannot be deleted by an empty config patch');
  const routes = [[source1.id, snapshot.config.buses[0].id], [source2.id, snapshot.config.buses[1].id], [snapshot.config.buses[0].id, 'out-speaker']];
  await ok('PUT', '/api/config', { routes });
  const end1 = tone(first.bridgePort, .2), end2 = tone(second.bridgePort, .6);
  try {
    const active = await until(async () => { const state = await ok('GET', '/api/state'); const a = state.sources.find(source => source.id === source1.id); const b = state.sources.find(source => source.id === source2.id); return a?.packets > 20 && b?.packets > 20 && a.rms > .08 && b.rms > .25 ? state : false; });
    const a = active.sources.find(source => source.id === source1.id), b = active.sources.find(source => source.id === source2.id);
    assert(b.rms > a.rms * 2); checks.push('separate PCM ingress reaches two normal graph sources without cross-mixing');
    await ok('PUT', '/api/config', { sources: [{ ...a, muted: true, gain: .25 }] });
    const updated = await ok('GET', '/api/state'); assert(updated.sources.find(source => source.id === source1.id).muted); assert(!updated.sources.find(source => source.id === source2.id).muted);
    checks.push('graph gain/mute settings apply independently');
    const before = updated.sources.find(source => source.id === source2.id).packets;
    end1(); await ok('POST', `/api/airplay-lines/${first.id}/stop`, {}); await sleep(400);
    const after = await ok('GET', '/api/state'); assert(after.sources.find(source => source.id === source2.id).packets > before);
    assert.deepEqual(after.config.routes, routes); checks.push('stop one receiver preserves routes and other active source');
  } finally { end1(); end2(); }
  await ok('POST', `/api/airplay-lines/${first.id}/start`, {});
  const restarted = await ok('GET', '/api/state'); assert.equal(restarted.sources.filter(source => source.airplayLineId === first.id).length, 1); checks.push('line restart keeps stable graph source identity');
  const legacy = await request('POST', '/api/airplay/receiver', { action: 'start' }); assert.equal(legacy.status, 410); checks.push('legacy default-device/capture receiver API disabled');
  for (const id of ids) await ok('POST', `/api/airplay-lines/${id}/remove`, {});
  const removed = await ok('GET', '/api/state'); assert.equal(removed.sources.filter(source => source.airplayLineId).length, 0); checks.push('remove cleans source/routes/processes');
  console.log(JSON.stringify({ ok: true, checks, manualRequired: ['iPhone AirPlay negotiation and audio playback', 'two physical iPhones simultaneous connection', 'no video/taskbar window during actual mirroring', 'firewall inbound rules and Bonjour installed on target PC'] }, null, 2));
}
main().catch(async error => { console.error(error.stack); console.error(logs.slice(-5000)); try { console.error(JSON.stringify((await request('GET', '/api/airplay-lines')).body, null, 2)); } catch {} process.exitCode = 1; }).finally(async () => {
  if (child) {
    for (const id of ids) { try { await request('POST', `/api/airplay-lines/${id}/stop`, {}); } catch { /* exited */ } }
    child.kill();
  }
  await sleep(200);
  fs.rmSync(dir, { force: true, recursive: true });
});
