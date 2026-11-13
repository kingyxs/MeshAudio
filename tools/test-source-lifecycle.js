'use strict';
// Isolated regression; captures only the VB-CABLE endpoint, never system audio.
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const net = require('net'), dgram = require('dgram'), https = require('https');
const tls = require('tls'), crypto = require('crypto');
const { spawn } = require('child_process');
const { detectVBCable } = require('../desktop/native-bridge');
const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-source-regression-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let child, control, gateway, sender, capture, pcmTimer, pcmSocket, logs = '';
const airplayIds = [];
const sockets = [], checks = [];
async function freePort(udp = false) { const socket = udp ? dgram.createSocket('udp4') : net.createServer(); await new Promise(resolve => udp ? socket.bind(0, '127.0.0.1', resolve) : socket.listen(0, '127.0.0.1', resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; }
async function until(test, timeout = 10000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await sleep(50); } throw Error('Condition timed out'); }
async function api(route, body, port = control) { const res = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: route === '/api/config' ? 'PUT' : 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }); assert(res.ok, `${route}: ${res.status}`); return res.json(); }
async function websocket(url) { const socket = new WebSocket(url); sockets.push(socket); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; }); return socket; }
function packet(hash, sequence) { const result = Buffer.alloc(20 + 480 * 8); result.write('MSA1'); result.writeUInt32LE(hash, 4); result.writeUInt32LE(sequence, 8); result.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12); for (let i = 0; i < 480; i++) { const sample = Math.sin((i + sequence * 480) * Math.PI * 2 * 440 / 48000) * .2; result.writeFloatLE(sample, 20 + i * 8); result.writeFloatLE(sample, 24 + i * 8); } return result; }
function trustedGet(port, route, ca) { return new Promise((resolve, reject) => { https.get({ host: '127.0.0.1', port, path: route, ca }, res => { let body = ''; res.on('data', data => body += data); res.on('end', () => resolve({ status: res.statusCode, body })); }).on('error', reject); }); }
async function secureAudio(port, session, ca) {
  const socket = tls.connect({ host: '127.0.0.1', port, ca });
  try {
    await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); });
    assert(socket.authorized, 'WSS certificate was not validated');
    const response = new Promise((resolve, reject) => {
      let headers = ''; const timer = setTimeout(() => reject(Error('WSS upgrade timed out')), 4000);
      socket.on('data', chunk => { headers += chunk.toString(); if (headers.includes('\r\n\r\n')) { clearTimeout(timer); resolve(headers); } }); socket.once('error', reject);
    });
    socket.write(`GET /browser-audio?token=${session.token} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\n\r\n`);
    assert.match(await response, /^HTTP\/1\.1 101/);
    const payload = packet(session.sourceHash, 0), mask = crypto.randomBytes(4), frame = Buffer.alloc(8 + payload.length);
    frame[0] = 0x82; frame[1] = 0xfe; frame.writeUInt16BE(payload.length, 2); mask.copy(frame, 4);
    for (let i = 0; i < payload.length; i++) frame[i + 8] = payload[i] ^ mask[i & 3];
    socket.write(frame);
    await until(async () => (await api('/api/state')).sources.some(source => source.id === session.mixerId && source.packets > 0));
  } finally { socket.destroy(); }
}
async function main() {
  control = await freePort(); const audio = await freePort(true), discovery = await freePort(true);
  const native = detectVBCable();
  child = spawn(process.execPath, ['server.js'], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MESHAUDIO_PORT: String(control), MESHAUDIO_AUDIO_PORT: String(audio), MESHAUDIO_DISCOVERY_PORT: String(discovery), MESHAUDIO_AIRPLAY_GUIDE_PORT: '0', MESHAUDIO_WEB_MIC_TLS_PORT: '0', MESHAUDIO_DATA_DIR: dir, MESHAUDIO_NATIVE_AUDIO: native.available ? '1' : '0', MESHAUDIO_CONTROL_BIND_HOST: '127.0.0.1', MESHAUDIO_PARENT_PID: String(process.pid), MESHAUDIO_WEB_MIC_CERT: path.join(process.env.APPDATA || '', 'com.meshAudio.desktop/web-microphone/server.crt'), MESHAUDIO_WEB_MIC_KEY: path.join(process.env.APPDATA || '', 'com.meshAudio.desktop/web-microphone/server.key') } });
  child.stdout.on('data', data => logs += data); child.stderr.on('data', data => logs += data);
  await until(async () => { try { return (await api('/api/health')).ok; } catch { return false; } });
  const state = await api('/api/state'); gateway = state.server.browserAudio.gateway.port;
  const web = await fetch(`http://127.0.0.1:${gateway}/ios-node.html`); const html = await web.text();
  assert.equal(web.status, 200); assert(html.includes('data-microphone-only="true"')); assert(!html.includes('http-equiv="refresh"'));
  for (const route of ['/api/config', '/server.js', '/desktop/web-microphone-gateway.js', '/control', '/web-microphone/server.key']) assert.equal((await fetch(`http://127.0.0.1:${gateway}${route}`)).status, 404);
  checks.push('phone gateway serves mic-only page without refresh and blocks control/files/private keys');
  const tlsPort = state.server.browserAudio.gateway.securePort;
  assert(tlsPort, 'Run configure-web-microphone.ps1 before this Windows integration test');
  const ca = fs.readFileSync(path.join(process.env.APPDATA, 'com.meshAudio.desktop/web-microphone/ca.crt'));
  assert.equal((await trustedGet(tlsPort, '/ios-node.html', ca)).status, 200);
  assert.equal((await trustedGet(tlsPort, '/api/config', ca)).status, 404);
  checks.push('real TLS handshake validates the generated CA and IP SAN without disabling verification');
  const registration = { deviceId: 'browser-lifecycle-test', deviceName: '网页麦克风测试', streamType: 'microphone' };
  const first = await api('/api/browser-source', registration, gateway);
  const second = await api('/api/browser-source', { ...registration, deviceId: 'browser-other-source' }, gateway);
  await secureAudio(tlsPort, second, ca);
  checks.push('authenticated WSS audio packet reaches its own source over a verified TLS connection');
  const ws = await websocket(`ws://127.0.0.1:${gateway}/browser-audio?token=${first.token}`);
  const ctrl = await websocket(`ws://127.0.0.1:${control}/control`);
  let sequence = 0;
  sender = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(packet(first.sourceHash, sequence++)); }, 10);
  await api('/api/config', { routes: [[first.mixerId, 'bus-main'], ['bus-main', 'out-virtual']] });
  await until(async () => (await api('/api/state')).sources.find(source => source.id === first.mixerId)?.packets > 20);
  assert.equal((await api('/api/state')).sources.find(source => source.id === first.mixerId).gain, 1);
  checks.push('new microphone source has unity gain and reaches the native graph');
  if (native.available) {
    let samples = [], captureLogs = '';
    capture = spawn(native.helperPath, ['--capture', '--device', native.captureOutput.id], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    capture.stdout.on('data', data => samples.push(Buffer.from(data))); capture.stderr.on('data', data => captureLogs += data);
    capture.on('error', error => captureLogs += error.message);
    // Initialization may be slower immediately after the Windows audio
    // service/device graph restarts. Begin gain comparisons only once the
    // endpoint is actually returning PCM; preserve all RMS assertions below.
    await until(() => captureLogs.includes('capture-info') && samples.reduce((bytes, chunk) => bytes + chunk.length, 0) > 20000, 20000);
    const measure = async () => { samples = []; await sleep(550); samples = []; await sleep(900); const pcm = Buffer.concat(samples); assert(pcm.length > 20000, captureLogs || 'no virtual capture samples'); let sum = 0; for (let i = 0; i + 1 < pcm.length; i += 2) sum += (pcm.readInt16LE(i) / 32768) ** 2; return Math.sqrt(sum / (pcm.length / 2)); };
    const normal = await measure(); assert(normal > .03, `virtual output is silent: RMS ${normal}`);
    ctrl.send(JSON.stringify({ type: 'source.gain', sourceId: first.mixerId, gain: 0 }));
    await until(async () => (await api('/api/state')).sources.find(source => source.id === first.mixerId)?.gain === 0);
    const zero = await measure(); assert(zero < normal * .03, `zero gain leaked audio: ${zero}/${normal}`);
    ctrl.send(JSON.stringify({ type: 'source.gain', sourceId: first.mixerId, gain: 1 }));
    const restored = await measure(); assert(restored > normal * .6);
    ctrl.send(JSON.stringify({ type: 'source.mute', sourceId: first.mixerId, muted: true }));
    const muted = await measure(); assert(muted < normal * .03);
    const line = (await api('/api/airplay-lines', {})).line; airplayIds.push(line.id);
    await api(`/api/airplay-lines/${line.id}/start`, {});
    const media = (await api('/api/state')).sources.find(source => source.airplayLineId === line.id);
    await api('/api/config', { routes: [[media.id, 'bus-main'], ['bus-main', 'out-virtual']] });
    pcmSocket = net.connect(line.bridgePort, '127.0.0.1'); pcmSocket.on('error', () => {});
    let position = 0;
    pcmTimer = setInterval(() => { const pcm = Buffer.alloc(960 * 4); for (let i = 0; i < 960; i++, position++) { const value = Math.round(Math.sin(position * Math.PI * 2 * 660 / 48000) * .2 * 32767); pcm.writeInt16LE(value, i * 4); pcm.writeInt16LE(value, i * 4 + 2); } if (!pcmSocket.destroyed) pcmSocket.write(pcm); }, 20);
    const mediaRms = await measure(); assert(mediaRms > .04, `AirPlay PCM output silent: ${mediaRms}`);
    ctrl.send(JSON.stringify({ type: 'source.mute', sourceId: media.id, muted: true }));
    const mediaMuted = await measure(); assert(mediaMuted < mediaRms * .03);
    clearInterval(pcmTimer); pcmSocket.destroy();
    await api(`/api/airplay-lines/${line.id}/remove`, {}); airplayIds.length = 0;
    checks.push(`native UxPlay PCM bridge → graph → WASAPI → VB-CABLE: RMS media=${mediaRms.toFixed(4)}, muted=${mediaMuted.toFixed(4)}`);
    capture.kill(); capture = null;
    checks.push(`actual WASAPI → VB-CABLE capture: RMS normal=${normal.toFixed(4)}, zero=${zero.toFixed(4)}, restored=${restored.toFixed(4)}, muted=${muted.toFixed(4)}`);
  } else checks.push('SKIPPED physical VB-CABLE output capture: device unavailable');
  await api('/api/config', { routes: [[first.mixerId, 'bus-main'], [second.mixerId, 'bus-voice'], ['bus-main', 'out-virtual']] });
  ctrl.send(JSON.stringify({ type: 'source.remove', sourceId: first.mixerId }));
  await until(async () => !(await api('/api/state')).sources.some(source => source.id === first.mixerId));
  await until(() => ws.readyState === WebSocket.CLOSED);
  const udp = dgram.createSocket('udp4');
  for (let i = 0; i < 5; i++) await new Promise(resolve => udp.send(packet(first.sourceHash, i + 10000), audio, '127.0.0.1', resolve));
  udp.close(); await sleep(300);
  const removed = await api('/api/state'); assert(!removed.sources.some(source => source.id === first.mixerId)); assert(!removed.config.routes.some(([from]) => from === first.mixerId)); assert(removed.sources.some(source => source.id === second.mixerId));
  checks.push('delete revokes active WebSocket, removes routes, rejects late UDP and preserves another source');
  const restored = await api('/api/browser-source', registration, gateway); assert.equal(restored.sourceId, first.sourceId); assert.notEqual(restored.token, first.token);
  const next = await websocket(`ws://127.0.0.1:${gateway}/browser-audio?token=${restored.token}`); next.send(packet(restored.sourceHash, 0));
  await until(async () => (await api('/api/state')).sources.some(source => source.id === restored.mixerId && source.packets));
  checks.push('explicit restart re-registers the stable source with a fresh token');
  const report = { ok: true, checks, physicalIPhoneTested: false };
  fs.mkdirSync(path.join(root, 'docs/testing/airplay'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/testing/airplay/source-lifecycle-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); console.error(logs.slice(-4000)); process.exitCode = 1; }).finally(async () => { clearInterval(sender); clearInterval(pcmTimer); pcmSocket?.destroy(); capture?.kill(); for (const id of airplayIds) try { await api(`/api/airplay-lines/${id}/remove`, {}); } catch {} for (const socket of sockets) try { socket.close(); } catch {} child?.kill(); await sleep(400); fs.rmSync(dir, { recursive: true, force: true }); });
