'use strict';

// MeshAudio-owned AirPlay lines. Each line has its own native UxPlay process,
// PCM bridge and stable source identity. No default-device switching is used.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const dgram = require('dgram');
const { spawn } = require('child_process');

function macFor(id) {
  const bytes = crypto.createHash('sha256').update(id).digest().subarray(0, 6);
  bytes[0] = (bytes[0] | 2) & 254;
  return [...bytes].map(value => value.toString(16).padStart(2, '0')).join(':');
}

async function probePorts(line) {
  const sockets = [];
  try {
    for (const port of [line.bridgePort, line.uxplayPort, line.uxplayPort + 1, line.uxplayPort + 2]) {
      const socket = net.createServer(); sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, port === line.bridgePort ? '127.0.0.1' : '0.0.0.0', resolve); });
    }
    for (const port of [line.uxplayPort, line.uxplayPort + 1, line.uxplayPort + 2]) {
      const socket = dgram.createSocket('udp4'); sockets.push(socket);
      await new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '0.0.0.0', resolve); });
    }
  } catch (error) { throw new Error(`airplay_port_unavailable: ${error.message}`); }
  finally { await Promise.all(sockets.map(socket => new Promise(resolve => { try { socket.close(resolve); } catch { resolve(); } }))); }
}

function createAirplayManager(options = {}) {
  const spawnProcess = options.spawn || spawn;
  const root = options.root || process.cwd();
  const dataDir = options.dataDir || path.join(root, 'data');
  const stateFile = path.join(dataDir, 'airplay-lines.json');
  const bridgeScript = options.bridgeScript || path.join(root, 'desktop', 'airplay-bridge.js');
  const controlPort = Number(options.controlPort || 4173);
  const audioPort = Number(options.audioPort || 4175);
  const lines = new Map();
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    for (const item of Array.isArray(saved?.lines) ? saved.lines : []) {
      if (!item || typeof item.id !== 'string') continue;
      if (!/^airplay-[a-f0-9]{8}$/.test(item.id) || !Number.isInteger(item.index) || item.index < 0 || item.index > 7 || [...lines.values()].some(line => line.index === item.index)) continue;
      lines.set(item.id, { ...item, child: null, bridge: null, state: 'stopped', error: null, logs: [], stats: null, remoteIp: null, generation: 0, pending: null });
    }
  } catch { /* first run */ }

  function persist() {
    fs.mkdirSync(dataDir, { recursive: true });
    const value = [...lines.values()].map(({ id, index, name, sourceId, sourceName, mac, bridgePort, uxplayPort }) => ({ id, index, name, sourceId, sourceName, mac, bridgePort, uxplayPort }));
    fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify({ version: 1, lines: value }, null, 2));
    fs.renameSync(`${stateFile}.tmp`, stateFile);
  }
  function executable() {
    const candidates = [
      process.env.MESHAUDIO_UXPLAY,
      path.join(root, 'desktop', 'airplay', 'uxplay.exe'),
      path.join(root, 'desktop', 'native', 'uxplay.exe'),
      path.join(dataDir, 'components', 'uxplay', 'uxplay.exe')
    ].filter(Boolean);
    return candidates.find(item => fs.existsSync(item)) || null;
  }
  function publicLine(line) {
    return {
      id: line.id, index: line.index, name: line.name, sourceId: line.sourceId,
      sourceName: line.sourceName, bridgePort: line.bridgePort, uxplayPort: line.uxplayPort,
      state: line.state, pid: line.child?.pid || null, bridgePid: line.bridge?.pid || null,
      error: line.error, connected: line.state === 'connected', receiving: line.receiving === true, remoteIp: line.remoteIp || null,
      logs: (line.logs || []).slice(-24), stats: line.stats || null
    };
  }
  function stop(line) {
    line.generation = (line.generation || 0) + 1;
    for (const child of [line.child, line.bridge]) {
      if (!child || child.killed) continue;
      try { child.kill(); } catch { /* already exited */ }
    }
    line.child = null; line.bridge = null; line.state = 'stopped'; line.error = null; line.pending = null; line.remoteIp = null; line.stats = null; line.receiving = false; line.sessions = new Map();
    options.onStop?.(line);
    persist();
    return publicLine(line);
  }
  async function start(id) {
    const line = lines.get(id);
    if (!line) throw new Error('airplay_line_not_found');
    if (line.pending) return line.pending;
    if (line.child && !line.child.killed) return publicLine(line);
    const uxplay = executable();
    if (!uxplay) { line.state = 'error'; line.error = 'uxplay_native_build_missing'; throw new Error(line.error); }
    const generation = ++line.generation;
    line.logs = []; line.error = null; line.state = 'starting'; line.sessions = new Map(); line.receiving = false;
    const append = text => { line.logs.push(text.slice(-1000)); if (line.logs.length > 80) line.logs.shift(); };
    const run = async () => {
    options.registerSource?.(line);
    await probePorts(line);
    if (line.generation !== generation) throw new Error('airplay_start_cancelled');
    // Native GStreamer resamples to the exact wire format; the bridge only
    // packetizes 48 kHz stereo and never captures a Windows sound device.
    const bridgeArgs = [bridgeScript, '--control-port', String(typeof options.controlPort === 'function' ? options.controlPort() : controlPort), '--audio-port', String(audioPort), '--listen-port', String(line.bridgePort), '--source-rate', '48000', '--format', 's16le', '--device-id', line.sourceId, '--device-name', line.sourceName, '--stats-interval', '1000'];
    const bridge = spawnProcess(process.execPath, bridgeArgs, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MESHAUDIO_BRIDGE_PARENT: String(process.pid) } });
    line.bridge = bridge;
    let bridgeBuffer = '';
    let readyBridge;
    const bridgeReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('airplay_bridge_timeout')), 8000);
      readyBridge = () => { clearTimeout(timeout); resolve(); };
      bridge.once('error', error => { clearTimeout(timeout); reject(error); });
      bridge.once('exit', code => { clearTimeout(timeout); reject(new Error(`airplay_bridge_exit_${code}`)); });
    });
    bridge.stdout?.on('data', data => {
      if (line.generation !== generation) return;
      bridgeBuffer = (bridgeBuffer + String(data)).slice(-16384);
      const records = bridgeBuffer.split(/\r?\n/); bridgeBuffer = records.pop();
      for (const text of records) {
        if (/listening for/.test(text)) readyBridge();
        if (/receiver connected/.test(text)) line.receiving = true;
        if (/receiver disconnected/.test(text)) line.receiving = false;
        try { const record = JSON.parse(text); if (record.type === 'airplay.stats') line.stats = record; else append(text); } catch { append(text); }
      }
    });
    bridge.stderr?.on('data', data => { line.error = String(data).trim().slice(-500); });
    bridge.on('exit', code => { if (line.bridge === bridge) { line.bridge = null; if (line.state !== 'stopped') { line.state = 'error'; line.error = `bridge_exit_${code}`; line.child?.kill(); options.onStop?.(line); } } });
    await bridgeReady;
    if (line.generation !== generation) throw new Error('airplay_start_cancelled');
    const args = ['-n', line.name, '-nh', '-m', line.mac, '-p', String(line.uxplayPort), '-vs', '0', '-as', `audio/x-raw,format=S16LE,rate=48000,channels=2 ! tcpclientsink host=127.0.0.1 port=${line.bridgePort}`, '-vsync', 'no'];
    const runtime = path.dirname(uxplay);
    const child = spawnProcess(uxplay, args, { cwd: runtime, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MESHAUDIO_UXPLAY_PARENT: String(process.pid), GST_PLUGIN_PATH_1_0: path.join(runtime, 'lib', 'gstreamer-1.0'), GST_PLUGIN_SYSTEM_PATH_1_0: '', GST_REGISTRY: path.join(dataDir, `airplay-gst-${line.index}.bin`), GST_REGISTRY_FORK: 'no' } });
    line.child = child;
    let readyReceiver;
    const receiverReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('airplay_receiver_timeout')), 8000);
      readyReceiver = () => { clearTimeout(timeout); resolve(); };
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); reject(new Error(`airplay_receiver_exit_${code}`)); });
    });
    let receiverBuffer = '';
    const readReceiverLog = data => {
      if (line.generation !== generation) return;
      receiverBuffer = (receiverBuffer + String(data)).slice(-16384);
      const records = receiverBuffer.split(/\r?\n/); receiverBuffer = records.pop();
      for (const text of records) {
      append(text.trim());
      if (/Initialized server socket/.test(text)) readyReceiver();
      const session = text.match(/MESHAUDIO_SESSION (connected|disconnected) id=([0-9a-fx]+) ip=([0-9a-f:.%]+)/i);
      if (session) {
        if (session[1] === 'connected') line.sessions.set(session[2], session[3]);
        else line.sessions.delete(session[2]);
        line.remoteIp = [...line.sessions.values()][0] || null;
        line.state = line.sessions.size ? 'connected' : 'ready';
        options.onConnection?.(line, line.sessions.size > 0);
      }
      if (/error|failed|fatal/i.test(text)) line.error = text.trim().slice(-500);
      }
    };
    child.stdout?.on('data', readReceiverLog);
    child.stderr?.on('data', readReceiverLog);
    child.on('exit', code => { if (line.child === child) { line.child = null; if (line.state !== 'stopped') { line.state = 'error'; line.error = `uxplay_exit_${code}`; line.bridge?.kill(); options.onStop?.(line); } } });
    await receiverReady;
    await new Promise(resolve => setTimeout(resolve, 350));
    if (line.generation !== generation || !line.child || !line.bridge || line.state === 'error') throw new Error(line.error || 'airplay_start_cancelled');
    if (line.state !== 'connected') line.state = 'ready';
    return publicLine(line);
    };
    line.pending = run().catch(error => {
      if (line.generation === generation) { stop(line); line.state = 'error'; line.error = error.message; }
      throw error;
    }).finally(() => { if (line.generation === generation) line.pending = null; });
    return line.pending;
  }
  function add(input = {}) {
    if (lines.size >= 8) throw new Error('airplay_line_limit');
    let index = 0; while ([...lines.values()].some(line => line.index === index)) index++;
    const id = `airplay-${crypto.randomBytes(4).toString('hex')}`;
    const name = String(input.name || `MeshAudio iOS ${index + 1}`).replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 48);
    if (!name || [...lines.values()].some(line => line.name === name)) throw new Error('airplay_name_not_unique');
    const line = { id, index, name, sourceId: id, sourceName: `iOS · ${name}`, mac: macFor(id), bridgePort: 4180 + index * 10, uxplayPort: 7200 + index * 10, state: 'stopped', child: null, bridge: null, error: null, logs: [], generation: 0, pending: null };
    lines.set(id, line); persist();
    if (typeof options.registerSource === 'function') options.registerSource(line);
    return publicLine(line);
  }
  function remove(id) { const line = lines.get(id); if (!line) throw new Error('airplay_line_not_found'); stop(line); lines.delete(id); persist(); options.onRemove?.(line); return { ok: true, id }; }
  function stopAll() { for (const line of lines.values()) if (line.child || line.bridge) stop(line); }
  return { list: () => [...lines.values()].map(publicLine), add, start, stop: id => { const line = lines.get(id); if (!line) throw new Error('airplay_line_not_found'); return stop(line); }, remove, stopAll, executable };
}

module.exports = { createAirplayManager };
