'use strict';
// Use private data and dynamic ports: never attach tests to the user's app.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const net = require('net'), dgram = require('dgram');
const root = path.resolve(__dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-ws-suite-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, logs = '';
async function freePort(udp = false) {
  const socket = udp ? dgram.createSocket('udp4') : net.createServer();
  await new Promise(resolve => udp ? socket.bind(0, '127.0.0.1', resolve) : socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function main() {
const port = await freePort(), audio = await freePort(true), discovery = await freePort(true);
server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MESHAUDIO_PORT: String(port), MESHAUDIO_AUDIO_PORT: String(audio),
    MESHAUDIO_DISCOVERY_PORT: String(discovery), MESHAUDIO_AIRPLAY_GUIDE_PORT: '0', MESHAUDIO_WEB_MIC_TLS_PORT: '0',
    MESHAUDIO_CONTROL_BIND_HOST: '127.0.0.1', MESHAUDIO_DATA_DIR: dataDir,
    MESHAUDIO_NATIVE_AUDIO: '0', MESHAUDIO_PARENT_PID: String(process.pid) }
});
server.stdout.on('data', chunk => { logs += String(chunk); });
server.stderr.on('data', chunk => { logs += String(chunk); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch {}
    if (ready) break;
    await sleep(100);
  }
  if (!ready) throw Error(`WebSocket test server did not start: ${logs}`);
  for (const script of ['test-control-websocket.js', 'test-audio-websocket.js', 'test-control-validation.js']) {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(__dirname, script), '127.0.0.1', String(port), String(audio)], { cwd: root, stdio: 'inherit', windowsHide: true });
      child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(Error(`${script} exited ${code}`)));
    });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
  fs.rmSync(dataDir, { recursive: true, force: true });
});
