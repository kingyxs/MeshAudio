const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-protocol-'));
const ports = {
  control: 43000 + Math.floor(Math.random() * 10000),
  discovery: 53000 + Math.floor(Math.random() * 5000),
  audio: 58000 + Math.floor(Math.random() * 4000)
};
let serverProcess;
let controlSocket;

function stableSourceId(deviceId, streamType) {
  const wireType = streamType === 'microphone' ? 'mic' : streamType;
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(`${deviceId}:${wireType}`)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash.toString(16);
}

function requestJson(method, route, body) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: ports.control, path: route, method, headers: body ? { 'Content-Type': 'application/json' } : {} }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => text += chunk);
      response.on('end', () => {
        try { resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    if (body) request.end(JSON.stringify(body));
    else request.end();
  });
}

async function waitForServer() {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const health = await requestJson('GET', '/api/health');
      if (health.body?.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('server did not become healthy');
}

function discover(request, timeoutMs = 800) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    const timeout = setTimeout(() => { socket.close(); resolve(null); }, timeoutMs);
    socket.once('error', error => { clearTimeout(timeout); socket.close(); reject(error); });
    socket.on('message', message => {
      clearTimeout(timeout);
      socket.close();
      try { resolve(JSON.parse(message.toString('utf8'))); }
      catch (error) { reject(error); }
    });
    socket.bind(0, '127.0.0.1', () => {
      const message = Buffer.from(JSON.stringify(request));
      socket.send(message, ports.discovery, '127.0.0.1', error => {
        if (error) { clearTimeout(timeout); socket.close(); reject(error); }
      });
    });
  });
}

function maskedTextFrame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const mask = crypto.randomBytes(4);
  const maskedBody = Buffer.from(body);
  for (let i = 0; i < maskedBody.length; i++) maskedBody[i] ^= mask[i % 4];
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, maskedBody]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 0xfe;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, mask, maskedBody]);
}

function openControlSocket() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(ports.control, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const messages = [];
    const waiters = [];
    let upgradeResolve;
    let upgradeReject;
    const upgradedPromise = new Promise((ok, fail) => { upgradeResolve = ok; upgradeReject = fail; });
    socket._waitFor = (predicate, timeoutMs = 2000) => new Promise((ok, fail) => {
      const index = messages.findIndex(predicate);
      if (index >= 0) return ok(messages.splice(index, 1)[0]);
      const timer = setTimeout(() => {
        const waiterIndex = waiters.indexOf(waiter);
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
        fail(new Error('control snapshot timeout'));
      }, timeoutMs);
      const waiter = { predicate, resolve: value => { clearTimeout(timer); ok(value); } };
      waiters.push(waiter);
    });
    socket.on('error', error => { if (!upgraded) upgradeReject(error); });
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const marker = buffer.indexOf('\r\n\r\n');
        if (marker < 0) return;
        const headers = buffer.subarray(0, marker).toString();
        if (!headers.includes('101 Switching Protocols')) return upgradeReject(new Error('control websocket upgrade failed'));
        upgraded = true;
        buffer = buffer.subarray(marker + 4);
        upgradeResolve();
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        if (buffer.length < offset + length) return;
        const payload = buffer.subarray(offset, offset + length);
        buffer = buffer.subarray(offset + length);
        if (opcode !== 0x1) continue;
        const message = JSON.parse(payload.toString('utf8'));
        const waiterIndex = waiters.findIndex(waiter => waiter.predicate(message));
        if (waiterIndex >= 0) waiters.splice(waiterIndex, 1)[0].resolve(message);
        else messages.push(message);
      }
    });
    socket.once('connect', () => socket.write(`GET /control HTTP/1.1\r\nHost: 127.0.0.1:${ports.control}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    upgradedPromise.then(() => resolve(socket), reject);
  });
}

async function run() {
  serverProcess = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: {
      ...process.env,
      MESHAUDIO_DATA_DIR: dataDir,
      MESHAUDIO_PORT: String(ports.control),
      MESHAUDIO_DISCOVERY_PORT: String(ports.discovery),
      MESHAUDIO_AUDIO_PORT: String(ports.audio),
      // Keep protocol tests deterministic on developer machines that have
      // an external VB-CABLE driver installed.
      MESHAUDIO_NATIVE_HELPER: path.join(dataDir, 'missing-meshaudio-native.exe')
    },
    stdio: 'ignore'
  });
  await waitForServer();

  const deviceId = 'device-protocol-test';
  const expectedSourceId = stableSourceId(deviceId, 'mic');
  const invalid = await discover({ type: 'meshaudio.discover', protocol: 99, deviceId, deviceName: 'Protocol Test', streamType: 'mic' });
  assert.strictEqual(invalid, null, 'discovery with the wrong protocol version must be ignored');
  const invalidType = await discover({ type: 'meshaudio.discover', protocol: 1, deviceId, deviceName: 'Protocol Test', streamType: 'invalid' });
  assert.strictEqual(invalidType, null, 'discovery with an unknown stream type must be ignored');

  const response = await discover({ type: 'meshaudio.discover', protocol: 1, deviceId, deviceName: 'Protocol Test', streamType: 'mic' });
  assert.strictEqual(response.type, 'meshaudio.discover.response');
  assert.strictEqual(response.protocol, 1);
  assert.strictEqual(response.port, ports.audio);
  assert.strictEqual(response.sourceId, expectedSourceId);
  assert.strictEqual(response.streamType, 'microphone');
  assert.strictEqual(response.streamId, `${deviceId}:microphone`);

  const sourceId = `net-${expectedSourceId}`;
  const configResult = await requestJson('PUT', '/api/config', {
    routes: [
      [sourceId, 'bus-main'],
      ['bus-main', 'out-speaker'],
      ['bus-main', 'out-virtual'],
      ['bus-main', 'bus-voice'],
      [sourceId, 'out-speaker'],
      ['out-speaker', 'bus-main']
    ]
  });
  assert.strictEqual(configResult.status, 200);
  assert.deepStrictEqual(configResult.body.routes, [[sourceId, 'bus-main'], ['bus-main', 'out-speaker']]);

  const initialState = await requestJson('GET', '/api/state');
  const source = initialState.body.sources.find(item => item.id === sourceId);
  assert(source, 'discovered source should appear in the state snapshot');
  assert.strictEqual(source.deviceId, deviceId);
  assert.strictEqual(source.online, false, 'discovered but silent source should remain offline');
  assert.deepStrictEqual(initialState.body.config.routes, configResult.body.routes);

  controlSocket = await openControlSocket();
  let message = await controlSocket._waitFor(item => item.type === 'state.snapshot');
  assert(message.sources.some(item => item.id === sourceId), 'control snapshot must include discovered metadata');
  controlSocket.write(maskedTextFrame({ type: 'source.mute', sourceId, muted: true }));
  message = await controlSocket._waitFor(item => item.type === 'state.snapshot' && item.sources.some(item => item.id === sourceId && item.muted));
  assert(message.sources.find(item => item.id === sourceId).muted);
  controlSocket.write(maskedTextFrame({ type: 'source.stop', sourceId }));
  message = await controlSocket._waitFor(item => item.type === 'state.snapshot' && item.sources.some(item => item.id === sourceId && item.stopped));
  const stoppedSource = message.sources.find(item => item.id === sourceId);
  assert.strictEqual(stoppedSource.online, false);
  assert.deepStrictEqual(message.config.routes, configResult.body.routes, 'stopping a source must preserve its routes');
  controlSocket.write(maskedTextFrame({ type: 'state.get' }));
  message = await controlSocket._waitFor(item => item.type === 'state.snapshot' && item.sources.some(item => item.id === sourceId && item.stopped));
  assert(message.config.sources.some(item => item.id === sourceId), 'source metadata must persist after stop');
  controlSocket.write(maskedTextFrame({ type: 'source.start', sourceId }));
  message = await controlSocket._waitFor(item => item.type === 'state.snapshot' && item.sources.some(item => item.id === sourceId && !item.stopped));
  const resumedSource = message.sources.find(item => item.id === sourceId);
  assert(resumedSource, 'source should be present after resume');
  assert.strictEqual(resumedSource.online, false, 'resumed but silent source should wait offline for the next packet');
  assert.deepStrictEqual(message.config.routes, configResult.body.routes, 'resuming a source must preserve its routes');
  console.log('control protocol discovery, identity, lifecycle, snapshot, and route validation passed');
}

run().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
}).finally(() => {
  if (controlSocket && !controlSocket.destroyed) controlSocket.destroy();
  if (serverProcess && serverProcess.exitCode === null) serverProcess.kill();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
