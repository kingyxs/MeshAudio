const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const dgram = require('dgram');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { Mixer } = require('./desktop/audio-engine');
const { NativePcmOutput, detectVBCable, truthy } = require('./desktop/native-bridge');
const { NativeMixOutput } = require('./desktop/engine-output');
const { createComponentManager } = require('./desktop/component-manager');
const { createAirplayManager } = require('./desktop/airplay-manager');
const { createWebMicrophoneGateway } = require('./desktop/web-microphone-gateway');
const { createNetworkAddressCache } = require('./desktop/network-addresses');

const ROOT = __dirname;
const networkAddresses = createNetworkAddressCache();
const nativeHelperPath = process.env.MESHAUDIO_NATIVE_HELPER || path.join(ROOT, 'desktop', 'native', 'build', process.platform === 'win32' ? 'meshaudio-native.exe' : 'meshaudio-native');
const vbCableProfile = process.platform === 'win32' ? detectVBCable({ helperPath: nativeHelperPath }) : {
  type: 'vb_cable_detection', available: false, diagnostic: 'VB-CABLE detection is only supported on Windows.', renderInput: null, captureOutput: null, helperPath: nativeHelperPath
};
const nativeAudioEnabled = truthy(process.env.MESHAUDIO_NATIVE_AUDIO);
// Native engine: the helper owns mixing and jitter buffering so rendering is
// paced by the WASAPI engine period. MESHAUDIO_ENGINE=node keeps the legacy
// Node-timer renderer available for comparison and rollback.
const engineMode = nativeAudioEnabled && process.env.MESHAUDIO_ENGINE !== 'node';

function runtimeOutputs(outputs) {
  return (Array.isArray(outputs) ? outputs : []).map(output => {
    if (output?.id !== 'out-virtual') return output;
    const available = vbCableProfile.available;
    return {
      ...output,
      // Preserve a user-customised name; only fall back to the auto-generated
      // label when no name has been set.
      name: output.name || (available ? 'VB-CABLE（外部）' : '外部虚拟麦克风（需要 VB-CABLE）'),
      enabled: available,
      external: true,
      renderDeviceId: vbCableProfile.renderInput?.id || null,
      renderDeviceName: vbCableProfile.renderInput?.name || 'CABLE Input',
      captureDeviceId: vbCableProfile.captureOutput?.id || null,
      captureDeviceName: vbCableProfile.captureOutput?.name || 'CABLE Output',
      diagnostic: vbCableProfile.diagnostic
    };
  });
}

const DATA_DIR = path.resolve(process.env.MESHAUDIO_DATA_DIR || path.join(ROOT, 'data'));
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
// Runtime manifest: lets the desktop shell discover an already-running server
// (pid + real ports) instead of blindly spawning a second one.
const RUNTIME_FILE = path.join(DATA_DIR, 'runtime.json');
const PARENT_PID = Number(process.env.MESHAUDIO_PARENT_PID || 0);
// Exit code the shell treats as "another instance already owns the service".
const EXIT_ALREADY_RUNNING = 3;
const BIND_HOST = process.env.MESHAUDIO_BIND_HOST || '0.0.0.0';
const CONTROL_BIND_HOST = process.env.MESHAUDIO_CONTROL_BIND_HOST || BIND_HOST;
const LAN_BIND_HOST = process.env.MESHAUDIO_LAN_BIND_HOST || BIND_HOST;
const HTTP_PORT = Number(process.env.MESHAUDIO_PORT || 4173);
const DISCOVERY_PORT = Number(process.env.MESHAUDIO_DISCOVERY_PORT || 4174);
const AUDIO_PORT = Number(process.env.MESHAUDIO_AUDIO_PORT || 4175);
const AIRPLAY_GUIDE_PORT = Number(process.env.MESHAUDIO_AIRPLAY_GUIDE_PORT || 4176);
const PROTOCOL_VERSION = 1;
const defaults = {
  version: 1,
  settings: { sampleRate: 48000, channels: 2, bufferMs: 20, bandwidthMode: 'low-latency' },
  sources: [],
  buses: [
    { id: 'bus-main', name: '主混音 · 耳机', gain: 1, muted: false },
    { id: 'bus-voice', name: '语音 · 虚拟麦克风', gain: 1, muted: false }
  ],
  outputs: [
    { id: 'out-speaker', name: '系统播放设备', kind: 'system', enabled: true },
    { id: 'out-virtual', name: 'MeshAudio Virtual Mic', kind: 'virtual-mic', enabled: false }
  ],
  routes: []
};

fs.mkdirSync(DATA_DIR, { recursive: true });

// ── Optional third-party components ─────────────────────────────────────────
// VB-CABLE is downloaded from its publisher on user request. Native UxPlay
// is bundled with its source and licenses; detection reuses the
// startup probe so the audio thread is never blocked by a device enumeration.
function findExecutable(names) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    try {
      const result = spawnSync(checker, [name], { windowsHide: true, timeout: 3000 });
      if (result.status === 0) {
        const first = String(result.stdout || '').trim().split(/\r?\n/)[0];
        if (first) return first;
      }
    } catch { /* where/which missing */ }
  }
  return null;
}

function findFileByName(dir, name, depth = 3) {
  if (depth < 0) return null;
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const item of items) {
    if (item.isFile() && item.name.toLowerCase() === name.toLowerCase()) return path.join(dir, item.name);
  }
  for (const item of items) {
    if (!item.isDirectory()) continue;
    const found = findFileByName(path.join(dir, item.name), name, depth - 1);
    if (found) return found;
  }
  return null;
}

function detectComponent(id) {
  if (id === 'bonjour') {
    if (process.platform !== 'win32') return { detected: false, detail: 'Windows only' };
    // Async process: component checks must never block the audio scheduler.
    return new Promise(resolve => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$s=Get-Service -Name 'Bonjour Service' -ErrorAction SilentlyContinue; if ($s.Status -eq 'Running' -and (Test-Path -LiteralPath ($env:WINDIR + '\\System32\\dnssd.dll'))) { 'ready' }"], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      let result = ''; child.stdout.on('data', data => { result += data; });
      child.on('error', () => resolve({ detected: false, detail: 'Bonjour detection failed' }));
      child.on('close', () => resolve({ detected: result.trim() === 'ready', detail: result.trim() === 'ready' ? 'Bonjour service running; x64 dnssd.dll present' : 'Bonjour service or x64 dnssd.dll missing; install or restart Bonjour' }));
      const timeout = setTimeout(() => { child.kill(); resolve({ detected: false, detail: 'Bonjour detection timed out' }); }, 12000);
      child.on('close', () => clearTimeout(timeout));
    });
  }
  if (id === 'vb-cable') {
    if (process.platform !== 'win32') return { detected: false, detail: 'Windows only' };
    // The driver needs a reboot before endpoints appear, so the value captured
    // at startup is authoritative; re-probing here would block the mixer.
    return { detected: vbCableProfile.available === true, detail: vbCableProfile.diagnostic || '' };
  }
  if (id === 'uxplay') {
    const native = process.env.MESHAUDIO_UXPLAY || path.join(ROOT, 'desktop', 'airplay', 'uxplay.exe');
    if (!fs.existsSync(native)) return { detected: false, detail: 'bundled_runtime_missing_reinstall' };
    const metadata = path.join(path.dirname(native), 'build-info.json');
    if (!process.env.MESHAUDIO_UXPLAY) {
      try {
        const info = JSON.parse(fs.readFileSync(metadata, 'utf8'));
        if (!Array.isArray(info.files) || !info.files.length || info.files.some(file => !fs.existsSync(path.join(path.dirname(native), file)))) return { detected: false, detail: 'bundled_runtime_incomplete_reinstall' };
      } catch { return { detected: false, detail: 'bundled_runtime_incomplete_reinstall' }; }
    }
    return { detected: true, detail: native };
  }
  return { detected: false, detail: '' };
}

const componentManager = createComponentManager({
  dataDir: DATA_DIR,
  manifestPath: path.join(ROOT, 'desktop', 'components.manifest.json'),
  detect: detectComponent,
  log: message => console.log(`[components] ${message}`)
});

// AirPlay is opt-in: no receiver process is launched until the user adds a
// line on the canvas. Lines are persisted but remain stopped across restarts.
const airplayManager = createAirplayManager({
  root: ROOT,
  dataDir: DATA_DIR,
  controlPort: () => { const address = server.address(); return address && typeof address === 'object' ? address.port : HTTP_PORT; },
  audioPort: AUDIO_PORT,
  onStop: line => {
    const source = config.sources.find(item => item.airplayLineId === line.id);
    const stream = source && streams.get(source.sourceId);
    if (stream) { stream.online = false; stream.rms = 0; stream.address = null; }
    broadcastControl();
  },
  onRemove: line => {
    const source = config.sources.find(item => item.airplayLineId === line.id);
    if (!source) return;
    removeGraphSource(source);
  },
  registerSource: line => {
    const source = sourceFromExternal({ deviceId: line.sourceId, deviceName: line.sourceName, streamType: 'media', transport: 'airplay' });
    if (source) registerDiscoveredSource({ ...source, airplayLineId: line.id, airplayName: line.name });
  },
  onConnection: (line, connected) => {
    const source = config.sources.find(item => item.airplayLineId === line.id);
    const stream = source && streams.get(source.sourceId);
    if (stream && !connected) {
      stream.online = false;
      stream.rms = 0;
      stream.latencyMs = null;
    }
    broadcastControl();
  }
});


// ── Single-instance bookkeeping ─────────────────────────────────────────────
// A second MeshAudio server would open the same WASAPI devices as the first
// one and both would fight over them, so the runtime manifest is the single
// source of truth for "who owns the service".
function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return error && error.code === 'EPERM';
  }
}

function readRuntimeManifest() {
  try {
    const raw = fs.readFileSync(RUNTIME_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeRuntimeManifest(ports) {
  const manifest = {
    pid: process.pid,
    parentPid: PARENT_PID || null,
    controlPort: ports.control,
    discoveryPort: ports.discovery,
    audioPort: ports.audio,
    startedAt: new Date().toISOString(),
    protocol: PROTOCOL_VERSION,
    version: 1
  };
  try {
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify(manifest, null, 2));
  } catch (error) {
    console.error('[runtime] failed to write manifest:', error.message);
  }
}

function clearRuntimeManifest() {
  const manifest = readRuntimeManifest();
  // Never delete a manifest that another live instance wrote.
  if (manifest && manifest.pid !== process.pid && isProcessAlive(manifest.pid)) return;
  try { fs.unlinkSync(RUNTIME_FILE); } catch { /* already gone */ }
}

/** Drop a stale manifest left behind by a crashed instance. */
function pruneStaleManifest() {
  const manifest = readRuntimeManifest();
  if (!manifest) return;
  if (manifest.pid === process.pid) return;
  if (isProcessAlive(manifest.pid)) return;
  console.warn(`[runtime] pruning stale manifest from dead pid ${manifest.pid}`);
  try { fs.unlinkSync(RUNTIME_FILE); } catch { /* ignore */ }
}

/** A live, different instance already owns the service. */
function ownedByAnotherInstance() {
  const manifest = readRuntimeManifest();
  if (!manifest) return null;
  if (manifest.pid === process.pid) return null;
  if (!isProcessAlive(manifest.pid)) return null;
  return manifest;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, maxLength = 256) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function normalizedStreamType(value) {
  if (value === 'mic' || value === 'microphone') return 'microphone';
  if (value === 'media') return 'media';
  return null;
}

function stableSourceId(deviceId, streamType) {
  const type = normalizedStreamType(streamType);
  if (!type) return null;
  const wireType = type === 'microphone' ? 'mic' : 'media';
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(`${deviceId}:${wireType}`, 'utf8')) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

function normalizeSource(source) {
  if (!isRecord(source)) return null;
  const id = nonEmptyString(source.id, 256) ? source.id : null;
  const rawSourceId = typeof source.sourceId === 'string' ? source.sourceId.toLowerCase().replace(/^0x/, '') : '';
  const sourceId = /^[0-9a-f]{1,8}$/.test(rawSourceId) ? (Number.parseInt(rawSourceId, 16) >>> 0).toString(16) : null;
  if (!id && !sourceId) return null;
  const streamType = normalizedStreamType(source.streamType) || (source.streamType === 'unknown' ? 'unknown' : null);
  const stableId = id || `net-${sourceId}`;
  return {
    ...source,
    id: stableId,
    ...(sourceId ? { sourceId, sourceHash: Number.parseInt(sourceId, 16) >>> 0 } : {}),
    ...(streamType ? { streamType } : {}),
    gain: Number.isFinite(Number(source.gain)) ? Math.max(0, Math.min(4, Number(source.gain))) : 1,
    muted: source.muted === true,
    stopped: source.stopped === true,
    voiceEnhanced: source.voiceEnhanced === true
  };
}

function mergeSources(existing, incoming) {
  const sources = new Map();
  for (const value of Array.isArray(existing) ? existing : []) {
    const source = normalizeSource(value);
    if (source) sources.set(source.id, source);
  }
  for (const value of Array.isArray(incoming) ? incoming : []) {
    const source = normalizeSource(value);
    if (!source) continue;
    const previous = sources.get(source.id);
    sources.set(source.id, {
      ...previous,
      ...source,
      muted: typeof value.muted === 'boolean' ? value.muted : previous?.muted === true,
      stopped: typeof value.stopped === 'boolean' ? value.stopped : previous?.stopped === true
    });
  }
  return [...sources.values()];
}

function validRoutes(routes, buses, outputs) {
  const busIds = new Set(buses.map(bus => bus.id));
  const outputById = new Map(outputs.map(output => [output.id, output]));
  const valid = [];
  const seen = new Set();
  for (const edge of Array.isArray(routes) ? routes : []) {
    if (!Array.isArray(edge) || edge.length !== 2 || !edge.every(id => nonEmptyString(id, 256))) continue;
    const [from, to] = edge;
    if (from === to) continue;
    const sourceToBus = busIds.has(to) && !busIds.has(from) && !outputById.has(from);
    const busToOutput = busIds.has(from) && outputById.get(to)?.enabled === true;
    if (!sourceToBus && !busToOutput) continue;
    const key = `${from}\u0000${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push([from, to]);
  }
  return valid;
}

function validateConfig(next, previous = defaults) {
  const base = isRecord(previous) ? previous : defaults;
  const candidate = isRecord(next) ? next : {};
  const requestedBuses = Array.isArray(candidate.buses)
    ? candidate.buses.filter(item => isRecord(item) && nonEmptyString(item.id, 256))
    : null;
  // An empty bus list is never a legitimate edit: the UI can only add buses,
  // and a patch that arrives before the snapshot loads would otherwise wipe
  // every bus, which drops all routes and leaves every source unrouted (the
  // engine then discards its audio and the stream goes silent). Keep what we
  // had, and fall back to the defaults if the stored config somehow lost them.
  const buses = requestedBuses && requestedBuses.length
    ? requestedBuses
    : (base.buses && base.buses.length ? base.buses : defaults.buses);
  // Merge outputs by id rather than replacing wholesale: a rename patch from
  // the UI sends only the fields it changed, and replacing would drop the
  // VB-CABLE detection fields or lose an output entirely.
  const baseOutputs = Array.isArray(base.outputs) ? base.outputs : defaults.outputs;
  let outputDefinitions = baseOutputs;
  if (Array.isArray(candidate.outputs)) {
    const candidateOutputs = candidate.outputs.filter(item => isRecord(item) && nonEmptyString(item.id, 256));
    if (candidateOutputs.length) {
      const mergedOutputs = new Map(baseOutputs.map(item => [item?.id, item]));
      for (const item of candidateOutputs) {
        mergedOutputs.set(item.id, { ...(mergedOutputs.get(item.id) || {}), ...item });
      }
      outputDefinitions = [...mergedOutputs.values()];
    }
  }
  const outputs = runtimeOutputs(outputDefinitions);
  const merged = {
    ...base,
    ...candidate,
    settings: { ...defaults.settings, ...(isRecord(base.settings) ? base.settings : {}), ...(isRecord(candidate.settings) ? candidate.settings : {}) },
    sources: mergeSources(base.sources, candidate.sources),
    buses,
    outputs
  };
  merged.routes = validRoutes(candidate.routes === undefined ? base.routes : candidate.routes, buses, outputs);
  return merged;
}

let storedConfig = {};
try {
  storedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
} catch {
  storedConfig = {};
}
let config = validateConfig(storedConfig, defaults);
const streams = new Map();
const audioClients = new Set();
const controlClients = new Set();
// Browser nodes are authenticated per source: registration hands out a random
// token, and the WebSocket audio bridge only accepts frames carrying it. The
// rest of the control plane stays unauthenticated (LAN-only by design), but a
// browser source must not be hijackable by anyone else on the network.
const browserSessions = new Map();
// Deleted source hashes cannot be resurrected by in-flight audio packets.
// An explicit registration/discovery is required to add the source again.
const removedSourceIds = new Set();
const MAX_AUDIO_PACKET_BYTES = 64 * 1024;
const MAX_BROWSER_FRAME_BYTES = 128 * 1024;
const BROWSER_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const lowLatency = config.settings.bandwidthMode === 'low-latency';
const targetBufferMs = lowLatency
  ? Math.min(20, Math.max(8, Number(config.settings.bufferMs) || 20))
  : Math.max(20, Number(config.settings.bufferMs) || 40);
const renderBlockMs = lowLatency ? 5 : 10;
const renderBlockFrames = Math.max(1, Math.round(config.settings.sampleRate * renderBlockMs / 1000));
const mixer = new Mixer({
  sampleRate: config.settings.sampleRate,
  channels: config.settings.channels,
  targetMs: targetBufferMs,
  limiter: true
});
// Maps the mixer's source id (config id like `net-65b58006`) back to the
// stream key (hex sourceId) so render-loop stats can update stream records.
const mixerIdToSourceId = new Map();
const nativeOutput = new NativePcmOutput({
  enabled: nativeAudioEnabled,
  helperPath: nativeHelperPath,
  sampleRate: config.settings.sampleRate,
  channels: config.settings.channels
});
const virtualOutput = new NativePcmOutput({
  enabled: (nativeAudioEnabled || truthy(process.env.MESHAUDIO_VBCABLE_AUDIO)) && vbCableProfile.available,
  helperPath: nativeHelperPath,
  deviceId: vbCableProfile.renderInput?.id || '',
  sampleRate: config.settings.sampleRate,
  channels: config.settings.channels
});

function streamForHash(hash) {
  return streams.get((hash >>> 0).toString(16)) || null;
}

function applyEngineStats(stats) {
  const targetMs = Number(stats.targetMs) || null;
  for (const source of Array.isArray(stats.sources) ? stats.sources : []) {
    const stream = streamForHash(source.hash);
    // An output that does not receive this source reports zeros; never let that
    // clobber the routing output's measurements.
    if (!stream || !(Number(source.received) > 0)) continue;
    // delayMs is the measured buffer residence inside the engine, so a plain
    // EWMA is enough; the old max() made the reading never come back down.
    const delay = Number(source.delayMs) || 0;
    stream.latencyMs = stream.latencyMs === null ? delay : stream.latencyMs + (delay - stream.latencyMs) * 0.3;
    stream.jitterMs = Number(source.jitterMs) || 0;
    stream.bufferDelayMs = delay;
    stream.occupancyMs = Number(source.queuedMs) || 0;
    stream.targetMs = targetMs;
    stream.clockPpm = Number(source.ratePpm) || 0;
    stream.starvedPackets = Number(source.starved) || 0;
    stream.lostPackets = Number(source.lost) || 0;
    stream.resyncPackets = Number(source.resync) || 0;
    stream.voiceProcessed = Number(source.voice) === 1;
    stream.voiceEnhanced = Number(source.voiceEnhanced) === 1;
    stream.shortfallFrames = Number(source.shortfallFrames) || 0;
    stream.dropLate = Number(source.dropLate) || 0;
    stream.dropNoMask = Number(source.dropNoMask) || 0;
    stream.engineWritten = Number(source.written) || 0;
    stream.engineFifoFrames = Number(source.fifoFrames) || 0;
    stream.overflowedPackets = Number(source.overflowed) || 0;
  }
}

const engineOutputs = engineMode ? {
  'out-speaker': new NativeMixOutput({
    enabled: true,
    helperPath: nativeHelperPath,
    sampleRate: config.settings.sampleRate,
    channels: config.settings.channels,
    onStats: applyEngineStats
  }),
  'out-virtual': new NativeMixOutput({
    enabled: (nativeAudioEnabled || truthy(process.env.MESHAUDIO_VBCABLE_AUDIO)) && vbCableProfile.available,
    helperPath: nativeHelperPath,
    deviceId: vbCableProfile.renderInput?.id || '',
    sampleRate: config.settings.sampleRate,
    channels: config.settings.channels,
    onStats: applyEngineStats
  })
} : null;

// Per-output binary config: keep global bus indices stable, but only route a
// source into buses that actually reach this output.
function engineConfigForOutput(outputId) {
  const busIndex = new Map(config.buses.map((bus, index) => [bus.id, index]));
  const routedBuses = new Set(config.routes.filter(edge => edge[1] === outputId).map(edge => edge[0]));
  const sources = [];
  for (const source of config.sources) {
    if (!source.sourceId) continue;
    let busMask = 0n;
    for (const edge of config.routes) {
      if (edge[0] !== source.id) continue;
      if (!routedBuses.has(edge[1])) continue;
      const index = busIndex.get(edge[1]);
      if (index === undefined || index > 63) continue;
      busMask |= 1n << BigInt(index);
    }
    if (busMask === 0n) continue;  // not routed to this output: do not send it
    sources.push({
      hash: Number.parseInt(source.sourceId, 16) >>> 0,
      gain: Number.isFinite(Number(source.gain)) ? Math.max(0, Math.min(4, Number(source.gain))) : 1,
      muted: source.muted === true,
      stopped: source.stopped === true,
      // Microphones get the voice chain; music/screen audio must stay untouched.
      voice: source.streamType === 'microphone',
      voiceEnhanced: source.streamType === 'microphone' && source.voiceEnhanced === true,
      busMask
    });
  }
  const buses = config.buses.map(bus => routedBuses.has(bus.id)
    ? { gain: Number(bus.gain) || 0, muted: bus.muted === true }
    : { gain: 0, muted: true });
  return { sources, buses };
}

// Sources actually routed to each output. Packets for other sources are not
// forwarded: an engine that never consumes them would just build a backlog.
const engineActiveSources = new Map();

let engineConfigTimer = null;
function scheduleEngineConfig() {
  if (!engineOutputs || engineConfigTimer) return;
  engineConfigTimer = setTimeout(() => {
    engineConfigTimer = null;
    for (const [outputId, output] of Object.entries(engineOutputs)) {
      const engineConfig = engineConfigForOutput(outputId);
      const active = new Set(engineConfig.sources.filter(item => item.busMask !== 0n).map(item => item.hash));
      engineActiveSources.set(outputId, active);
      output.sendConfig(engineConfig);
    }
  }, 50);
  engineConfigTimer.unref?.();
}

function syncMixerConfig() {
  const currentIds = new Set(config.sources.map(sourceMixerId));
  for (const id of mixer.sources.keys()) if (!currentIds.has(id)) { mixer.removeSource(id); mixerIdToSourceId.delete(id); }
  for (const source of config.sources) {
    const id = sourceMixerId(source);
    if (!id) continue;
    mixerIdToSourceId.set(id, source.sourceId || null);
    mixer.addSource(id);
    mixer.setSource(id, { gain: Number.isFinite(Number(source.gain)) ? Number(source.gain) : 1, muted: source.muted === true || source.stopped === true });
  }
  for (const bus of config.buses) mixer.addBus(bus.id, { gain: Number(bus.gain) || 0, muted: bus.muted === true });
  mixer.setRoutes(config.routes);
  scheduleEngineConfig();
}

function sourceMixerId(source) {
  return source?.id || (source?.sourceId ? `net-${source.sourceId}` : null);
}

syncMixerConfig();

function streamFromSource(source) {
  return {
    ...source,
    packets: 0,
    bytes: 0,
    sequence: null,
    timestamp: null,
    rms: 0,
    lastSeen: null,
    address: null,
    online: false,
    latencyMs: null,
    jitterMs: null,
    bufferDelayMs: null,
    occupancyMs: null,
    targetMs: null,
    clockPpm: 0,
    starvedPackets: 0,
    resyncPackets: 0,
    voiceProcessed: false,
    shortfallFrames: 0,
    dropLate: 0,
    dropNoMask: 0,
    engineWritten: 0,
    engineFifoFrames: 0,
    overrunPackets: 0,
    framesIn: 0,
    framesOut: 0,
    queuedFrames: 0,
    lostPackets: 0,
    overflowedPackets: 0,
    transport: source?.transport || 'udp'
  };
}

for (const source of config.sources) {
  if (source.sourceId) streams.set(source.sourceId, streamFromSource(source));
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function interfaceAddresses() {
  return networkAddresses.get();
}

function info() {
  const address = server.address();
  return {
    service: 'MeshAudio',
    version: '0.1.0',
    protocol: PROTOCOL_VERSION,
    host: os.hostname(),
    addresses: interfaceAddresses(),
    bindHost: CONTROL_BIND_HOST,
    controlPort: address && typeof address === 'object' ? address.port : HTTP_PORT,
    audioPort: AUDIO_PORT,
    sampleRate: config.settings.sampleRate,
    channels: config.settings.channels,
    latencyMs: engineOutputs
      ? round1((engineOutputs['out-speaker'].engine.targetMs || 12) + 2.7)
      : targetBufferMs + renderBlockMs,
    latencyMode: lowLatency ? 'low-latency' : 'bandwidth-saving',
    audioEngine: engineOutputs ? 'native' : 'node',
    latencyRefreshMs,
    renderScheduler: {
      blockMs: renderBlockMs,
      blockMsAvg: round1(averageBlockMs()),
      catchUpResyncs: audioClock.resyncs,
      maxCatchUpMs: audioClock.maxCatchUpMs,
      producedSeconds: round1(audioClock.producedFrames / config.settings.sampleRate),
      elapsedSeconds: round1((performance.now() - audioClock.startedAt) / 1000)
    },
    audioOutput: engineOutputs ? engineOutputs['out-speaker'].status() : nativeOutput.status(),
    virtualOutput: {
      ...(engineOutputs ? engineOutputs['out-virtual'].status() : virtualOutput.status()),
      mode: 'external-vb-cable',
      renderEndpoint: vbCableProfile.renderInput || null,
      captureEndpoint: vbCableProfile.captureOutput || null,
      detection: vbCableProfile.diagnostic
    },
    browserAudio: {
      registerPath: '/api/browser-source',
      audioPath: '/browser-audio',
      page: '/ios-node.html',
      gateway: webMicrophoneGateway.status(),
      url: webMicrophoneGateway.url(airplayLanAddress()),
      transport: 'websocket-msa1',
      sessions: browserSessions.size,
      note: 'Browser microphone / in-page media only; no system audio capture.'
    }
  };
}

function sourceSnapshots() {
  return config.sources.map(source => {
    const stream = source.sourceId ? streams.get(source.sourceId) : null;
    const line = source.airplayLineId ? airplayManager.list().find(item => item.id === source.airplayLineId) : null;
    const airplayConnected = line?.state === 'connected';
    return {
      ...source,
      receiving: stream?.online === true && Date.now() - stream.lastSeen <= 3000,
      online: (stream?.online === true || airplayConnected) && stream?.stopped !== true && source.stopped !== true,
      stopped: stream?.stopped === true || source.stopped === true,
      packets: stream?.packets || 0,
      bytes: stream?.bytes || 0,
      sequence: stream?.sequence ?? null,
      timestamp: stream?.timestamp ?? null,
      rms: stream?.rms || 0,
      lastSeen: stream?.lastSeen ?? null,
      address: source.airplayLineId ? line?.remoteIp || null : stream?.address ?? null,
      latencyMs: stream?.latencyMs ?? null,
      jitterMs: stream?.jitterMs ?? null,
      bufferDelayMs: stream?.bufferDelayMs ?? null,
      occupancyMs: stream?.occupancyMs ?? null,
      targetMs: stream?.targetMs ?? null,
      clockPpm: stream?.clockPpm ?? 0,
      starvedPackets: stream?.starvedPackets ?? 0,
      resyncPackets: stream?.resyncPackets ?? 0,
      voiceProcessed: stream?.voiceProcessed === true,
      voiceEnhanced: stream?.voiceEnhanced === true,
      shortfallFrames: stream?.shortfallFrames ?? 0,
      dropLate: stream?.dropLate ?? 0,
      dropNoMask: stream?.dropNoMask ?? 0,
      engineWritten: stream?.engineWritten ?? 0,
      engineFifoFrames: stream?.engineFifoFrames ?? 0,
      overrunPackets: stream?.overrunPackets ?? 0,
      framesIn: stream?.framesIn ?? 0,
      framesOut: stream?.framesOut ?? 0,
      queuedFrames: stream?.queuedFrames ?? 0,
      lostPackets: stream?.lostPackets ?? 0,
      overflowedPackets: stream?.overflowedPackets ?? 0
    };
  });
}

function snapshot(includeType = true) {
  return {
    ...(includeType ? { type: 'state.snapshot' } : {}),
    config,
    sources: sourceSnapshots(),
    streams: [...streams.values()].map(stream => ({ ...stream })),
    server: info()
  };
}

function wsFrame(payload, opcode = 0x2) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, body.length]), body]);
  if (body.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function sendControl(socket, message) {
  if (!socket.destroyed) socket.write(wsFrame(JSON.stringify(message), 0x1));
}

function broadcastControl(message = snapshot()) {
  const frame = wsFrame(JSON.stringify(message), 0x1);
  for (const client of controlClients) {
    if (!client.destroyed) client.write(frame);
  }
}

function persistSources(sources) {
  config = validateConfig({ ...config, sources }, config);
  syncMixerConfig();
  saveConfig();
}

function sourceForKey(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let key = String(value).trim().toLowerCase();
  if (key.startsWith('net-')) key = key.slice(4);
  key = key.replace(/^0x/, '');
  return config.sources.find(source => source.id === `net-${key}` || source.sourceId === key || source.id === value) || null;
}

function removeGraphSource(source) {
  removedSourceIds.add(source.sourceId);
  for (const [token, session] of browserSessions) {
    if (session.sourceId !== source.sourceId) continue;
    browserSessions.delete(token);
    for (const socket of session.sockets || []) socket.destroy();
  }
  config.routes = config.routes.filter(([from]) => from !== source.id);
  streams.delete(source.sourceId);
  config.sources = config.sources.filter(item => item.id !== source.id);
  syncMixerConfig(); saveConfig(); broadcastControl();
}

function handleControlMessage(socket, message) {
  if (!isRecord(message)) return;
  if (message.type === 'state.get') {
    sendControl(socket, snapshot());
    return;
  }
  if (message.type === 'config.patch' && isRecord(message.patch)) {
    config = validateConfig({ ...config, ...message.patch }, config);
    syncMixerConfig();
    saveConfig();
    for (const source of config.sources) {
      if (source.sourceId && !streams.has(source.sourceId)) streams.set(source.sourceId, streamFromSource(source));
    }
    broadcastControl();
    return;
  }
  if (message.type === 'source.mute') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    if (!source) return;
    const muted = typeof message.muted === 'boolean' ? message.muted : !source.muted;
    persistSources(config.sources.map(item => item.id === source.id ? { ...item, muted } : item));
    syncMixerConfig();
    const stream = streams.get(source.sourceId);
    if (stream) stream.muted = muted;
    broadcastControl();
    return;
  }
  if (message.type === 'source.voiceEnhanced') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    if (!source) return;
    const enabled = message.enabled === true;
    persistSources(config.sources.map(item => item.id === source.id ? { ...item, voiceEnhanced: enabled } : item));
    syncMixerConfig();
    const stream = streams.get(source.sourceId);
    if (stream) stream.voiceEnhanced = enabled;
    broadcastControl();
    return;
  }
  if (message.type === 'source.gain') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    const gain = Number(message.gain);
    if (!source || !Number.isFinite(gain) || gain < 0 || gain > 4) return;
    persistSources(config.sources.map(item => item.id === source.id ? { ...item, gain } : item));
    broadcastControl();
    return;
  }
  if (message.type === 'source.remove') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    if (!source) return;
    if (source.airplayLineId) {
      try { airplayManager.remove(source.airplayLineId); } catch { removeGraphSource(source); }
      return;
    }
    removeGraphSource(source);
    return;
  }
  if (message.type === 'source.stop') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    if (!source) return;
    persistSources(config.sources.map(item => item.id === source.id ? { ...item, stopped: true } : item));
    syncMixerConfig();
    const stream = streams.get(source.sourceId);
    if (stream) {
      stream.stopped = true;
      stream.online = false;
    }
    broadcastControl();
    return;
  }
  if (message.type === 'source.start' || message.type === 'source.resume') {
    const source = sourceForKey(message.sourceId ?? message.id ?? message.sourceHash);
    if (!source) return;
    persistSources(config.sources.map(item => item.id === source.id ? { ...item, stopped: false } : item));
    syncMixerConfig();
    const stream = streams.get(source.sourceId);
    if (stream) {
      stream.stopped = false;
      stream.online = false;
      stream.lastSeen = null;
    }
    broadcastControl();
  }
}

function consumeControlFrames(socket, chunk) {
  socket._meshBuffer = Buffer.concat([socket._meshBuffer || Buffer.alloc(0), chunk]);
  while (socket._meshBuffer.length >= 2) {
    const first = socket._meshBuffer[0];
    const second = socket._meshBuffer[1];
    const opcode = first & 0x0f;
    const masked = !!(second & 0x80);
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (socket._meshBuffer.length < 4) return;
      length = socket._meshBuffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (socket._meshBuffer.length < 10) return;
      const largeLength = socket._meshBuffer.readBigUInt64BE(2);
      if (largeLength > 1024n * 1024n) return socket.destroy();
      length = Number(largeLength);
      offset = 10;
    }
    if (length > 1024 * 1024) return socket.destroy();
    if (masked) offset += 4;
    const total = offset + length;
    if (socket._meshBuffer.length < total) return;
    let body = socket._meshBuffer.subarray(offset, total);
    if (masked) {
      const mask = socket._meshBuffer.subarray(offset - 4, offset);
      body = Buffer.from(body);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
    }
    socket._meshBuffer = socket._meshBuffer.subarray(total);
    if (opcode === 0x8) return socket.end();
    if (opcode === 0x9) {
      socket.write(wsFrame(body, 0x0a));
      continue;
    }
    if (opcode !== 0x1) continue;
    try {
      handleControlMessage(socket, JSON.parse(body.toString('utf8')));
    } catch {
      sendControl(socket, { type: 'control.error', error: 'invalid_message' });
    }
  }
}

function acceptWebSocket(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.setNoDelay?.(true);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return socket;
}

// Minimal incremental WebSocket frame reader for the browser audio bridge.
// The control channel only needs text frames and a fixed shape; audio frames
// are binary, get coalesced by TCP, and must be unmasked here.
function createBrowserFrameReader(onPacket, onClose) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  const fail = reason => {
    if (closed) return;
    closed = true;
    onClose(reason);
  };
  return {
    push(chunk) {
      if (closed) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (buffer.length > MAX_BROWSER_FRAME_BYTES) return fail('frame_too_large');
      while (!closed) {
        if (buffer.length < 2) return;
        const fin = (buffer[0] & 0x80) !== 0;
        const opcode = buffer[0] & 0x0f;
        const masked = (buffer[1] & 0x80) !== 0;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffer.length < 10) return;
          const wide = buffer.readBigUInt64BE(2);
          if (wide > BigInt(MAX_BROWSER_FRAME_BYTES)) return fail('frame_too_large');
          length = Number(wide);
          offset = 10;
        }
        // Browsers mask client-to-server frames. Rejecting cleartext frames is
        // safer than treating arbitrary bytes as PCM.
        if (!masked) return fail('unmasked_frame');
        const maskOffset = offset;
        offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.allocUnsafe(length);
        for (let index = 0; index < length; index++) {
          payload[index] = buffer[offset + index] ^ buffer[maskOffset + (index & 3)];
        }
        buffer = buffer.subarray(offset + length);
        if (opcode === 0x8) return fail('client_close');
        if (opcode === 0x9 || opcode === 0xa) continue;
        if (opcode === 0x1) continue;
        // The page sends one packet per frame; fragments would need reassembly
        // and are rejected loudly instead of being half-decoded.
        if (!fin) return fail('fragmented_frame_unsupported');
        if (opcode === 0x2) onPacket(payload);
      }
    },
    close() { closed = true; }
  };
}

function browserSession(token) {
  const session = browserSessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    browserSessions.delete(token);
    return null;
  }
  return session;
}

function handleBrowserAudioUpgrade(req, socket, url) {
  const token = url.searchParams.get('token') || '';
  const session = browserSession(token);
  if (!session) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
    return;
  }
  const client = acceptWebSocket(req, socket);
  if (!client) return;
  const address = String(socket.remoteAddress || 'browser').replace(/^::ffff:/, '');
  const reader = createBrowserFrameReader(
    packet => {
      if (browserSession(token) !== session || packet.length < 8 || packet.readUInt32LE(4) !== Number.parseInt(session.sourceId, 16)) { client.destroy(); return; }
      if (ingestAudioPacket(packet, { address }, 'browser')) session.packets++;
      else session.dropped++;
    },
    () => { if (!client.destroyed) client.destroy(); }
  );
  session.clients = (session.clients || 0) + 1;
  (session.sockets ||= new Set()).add(client);
  client.on('data', chunk => reader.push(chunk));
  client.on('error', () => reader.close());
  client.on('close', () => {
    reader.close();
    session.clients = Math.max(0, (session.clients || 1) - 1);
    session.sockets.delete(client);
  });
}

function sourceFromDiscovery(request) {
  if (request.type !== 'meshaudio.discover' || request.protocol !== PROTOCOL_VERSION) return null;
  if (!nonEmptyString(request.deviceId, 128) || !nonEmptyString(request.deviceName, 128)) return null;
  const streamType = normalizedStreamType(request.streamType);
  if (!streamType) return null;
  if (request.sampleRate !== undefined && (!Number.isInteger(request.sampleRate) || request.sampleRate < 8000 || request.sampleRate > 192000)) return null;
  if (request.channels !== undefined && (!Number.isInteger(request.channels) || request.channels < 1 || request.channels > 8)) return null;
  const deviceId = request.deviceId.trim();
  const deviceName = request.deviceName.trim();
  const sourceId = stableSourceId(deviceId, request.streamType);
  return {
    id: `net-${sourceId}`,
    sourceId,
    sourceHash: Number.parseInt(sourceId, 16) >>> 0,
    deviceId,
    deviceName,
    streamId: `${deviceId}:${streamType}`,
    streamType,
    sampleRate: request.sampleRate || config.settings.sampleRate,
    channels: request.channels || config.settings.channels,
    codec: nonEmptyString(request.codec, 64) ? request.codec : 'pcm_f32le',
    muted: false,
    stopped: false
  };
}

function registerDiscoveredSource(record) {
  removedSourceIds.delete(record.sourceId);
  const previous = config.sources.find(source => source.id === record.id);
  const source = {
    ...previous,
    ...record,
    muted: previous?.muted === true,
    stopped: false
  };
  persistSources([...config.sources.filter(item => item.id !== source.id), source]);
  const stream = streams.get(source.sourceId);
  if (stream) Object.assign(stream, source, { stopped: false });
  else streams.set(source.sourceId, streamFromSource(source));
  return source;
}

// A browser node registers exactly like a discovered phone node: same stable
// source id derivation, same config record shape, same presence in the canvas.
// The only difference is the transport, which is carried for diagnostics.
function sourceFromBrowser(request) {
  if (!isRecord(request)) return null;
  const streamType = normalizedStreamType(request.streamType);
  if (!streamType) return null;
  const deviceId = nonEmptyString(request.deviceId, 128)
    ? request.deviceId.trim()
    : `browser-${crypto.randomBytes(4).toString('hex')}`;
  const deviceName = nonEmptyString(request.deviceName, 128)
    ? request.deviceName.trim()
    : '网页麦克风';
  const sourceId = stableSourceId(deviceId, streamType);
  if (!sourceId) return null;
  return {
    id: `net-${sourceId}`,
    sourceId,
    sourceHash: Number.parseInt(sourceId, 16) >>> 0,
    deviceId,
    deviceName,
    streamId: `${deviceId}:${streamType}`,
    streamType,
    sampleRate: config.settings.sampleRate,
    channels: config.settings.channels,
    codec: 'pcm_f32le',
    transport: 'browser',
    muted: false,
    stopped: false
  };
}

// External decoders (the AirPlay bridge today) register here. They send plain
// MSA1 over UDP afterwards, so no per-source token is possible on that path;
// the transport tag is what keeps the canvas honest about where audio came from.
function sourceFromExternal(request) {
  if (!isRecord(request)) return null;
  const streamType = normalizedStreamType(request.streamType);
  if (!streamType) return null;
  const transport = request.transport === 'airplay' ? 'airplay' : 'external';
  const deviceId = nonEmptyString(request.deviceId, 128)
    ? request.deviceId.trim()
    : `ext-${crypto.randomBytes(4).toString('hex')}`;
  const deviceName = nonEmptyString(request.deviceName, 128)
    ? request.deviceName.trim()
    : (transport === 'airplay' ? 'AirPlay 接收端' : '外部音频源');
  const sourceId = stableSourceId(deviceId, streamType);
  if (!sourceId) return null;
  return {
    id: `net-${sourceId}`,
    sourceId,
    sourceHash: Number.parseInt(sourceId, 16) >>> 0,
    deviceId,
    deviceName,
    streamId: `${deviceId}:${streamType}`,
    streamType,
    sampleRate: config.settings.sampleRate,
    channels: config.settings.channels,
    codec: 'pcm_f32le',
    transport,
    muted: false,
    stopped: false
  };
}

function airplayLanAddress() {
  const candidates = [];
  for (const address of interfaceAddresses()) {
      // Prefer real LAN subnets over VPN/tun adapters (198.18.0.0/15 etc.).
      const score = address.startsWith('192.168.') || address.startsWith('10.') || address.startsWith('172.') ? 0 : 1;
      candidates.push({ address, score });
  }
  candidates.sort((a, b) => a.score - b.score);
  return candidates[0]?.address || null;
}


function sendDiscoveryResponse(request, remote) {
  const discovered = sourceFromDiscovery(request);
  const source = discovered ? { ...discovered, address: remote.address } : null;
  if (!source) return;
  const registered = registerDiscoveredSource(source);
  const response = {
    type: 'meshaudio.discover.response',
    protocol: PROTOCOL_VERSION,
    ...info(),
    port: AUDIO_PORT,
    deviceId: registered.deviceId,
    deviceName: registered.deviceName,
    streamId: registered.streamId,
    streamType: registered.streamType,
    sourceId: registered.sourceId,
    // Voice-enhancement state so the phone can sync its toggle UI.
    voiceEnhanced: config.sources.find(s => s.id === registered.id)?.voiceEnhanced === true
  };
  discovery.send(Buffer.from(JSON.stringify(response)), remote.port, remote.address);
  broadcastControl();
}

const json = (res, status, body) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(JSON.stringify(body));
};

// Component management can start installers, so it stays loopback-only even
// when the control plane is bound to 0.0.0.0 for browser nodes.
const isLoopbackRequest = req => {
  const address = req.socket?.remoteAddress || '';
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
};
const isTrustedLocalRequest = req => {
  if (!isLoopbackRequest(req)) return false;
  if (!req.headers.origin) return true;
  try { const origin = new URL(req.headers.origin); return ['http:', 'https:', 'tauri:'].includes(origin.protocol) && ['127.0.0.1', 'localhost', '[::1]', 'tauri.localhost'].includes(origin.hostname); } catch { return false; }
};

function handleBrowserSourceRegistration(req, res) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
      const record = sourceFromBrowser(request);
      if (!record) return json(res, 400, { error: 'invalid_source' });
      const registered = registerDiscoveredSource(record);
      // Expired sessions are swept here rather than by a timer: registration
      // happens once per browser node, so a periodic job would be noise.
      for (const [key, value] of browserSessions) {
        if (value.expiresAt <= Date.now()) browserSessions.delete(key);
      }
      const token = crypto.randomBytes(18).toString('hex');
      const expiresAt = Date.now() + BROWSER_SESSION_TTL_MS;
      browserSessions.set(token, {
        sourceId: registered.sourceId,
        deviceId: registered.deviceId,
        streamType: registered.streamType,
        createdAt: Date.now(),
        expiresAt,
        packets: 0,
        dropped: 0,
        clients: 0
      });
      broadcastControl();
      return json(res, 200, {
        ok: true,
        token,
        expiresAt,
        sourceId: registered.sourceId,
        sourceHash: registered.sourceHash,
        mixerId: sourceMixerId(registered),
        deviceId: registered.deviceId,
        deviceName: registered.deviceName,
        streamType: registered.streamType,
        sampleRate: config.settings.sampleRate,
        channels: config.settings.channels,
        wsPath: '/browser-audio'
      });
    });
}

const server = http.createServer((req, res) => {
  if ((req.url.startsWith('/api/components') || req.url.startsWith('/api/setup')) && !isTrustedLocalRequest(req)) return json(res, 403, { ok: false, error: 'trusted_local_request_required' });
  // Cross-origin preflight: the desktop shell (tauri.localhost / Vite dev on
  // :1420) talks to this service on a different origin, so JSON POSTs such as
  // /api/airplay/bridge need an explicit OPTIONS response before they are sent.
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }
  if (req.url.startsWith('/api/airplay-lines') && !isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'loopback_only' });
  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, { ok: true, uptime: process.uptime(), streams: streams.size });
  }
  // The desktop shell takes ownership of a server it adopted; from here on we
  // watch *its* pid so the service still dies with the app even on hard kill.
  if (req.method === 'POST' && req.url === '/api/handoff') {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 4096) req.destroy();
    });
    req.on('end', () => {
      let pid = 0;
      try {
        const parsed = JSON.parse(raw || '{}');
        if (isRecord(parsed)) pid = Number(parsed.parentPid) || 0;
      } catch { /* malformed body */ }
      if (!Number.isInteger(pid) || pid <= 0) return json(res, 400, { error: 'invalid_parent' });
      // Never steal ownership from a shell that is still alive; a second
      // window must not be able to orphan the first one's service.
      if (watchParentPid && watchParentPid !== pid && isProcessAlive(watchParentPid)) {
        return json(res, 409, { error: 'already_owned', parentPid: watchParentPid });
      }
      handoffParent(pid);
      return json(res, 200, { ok: true, parentPid: pid });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/components') {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'loopback_only' });
    return json(res, 200, { ok: true, components: componentManager.list() });
  }
  if (req.url === '/api/setup' && req.method === 'GET') {
    let setup = { version: 1, completed: false };
    try { setup = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'setup.json'), 'utf8')); } catch { /* first launch */ }
    return json(res, 200, { ok: true, setup });
  }
  if (req.url === '/api/setup' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const value = JSON.parse(body);
        if (value.completed !== true) return json(res, 400, { ok: false, error: 'invalid_setup' });
        const setup = { version: 1, completed: true, completedAt: new Date().toISOString() };
        const file = path.join(DATA_DIR, 'setup.json');
        fs.writeFileSync(file + '.tmp', JSON.stringify(setup, null, 2)); fs.renameSync(file + '.tmp', file);
        return json(res, 200, { ok: true, setup });
      } catch { return json(res, 400, { ok: false, error: 'invalid_setup' }); }
    });
    return;
  }
  // Clears the cached detection so a freshly installed receiver shows up
  // without restarting the service.
  if (req.method === 'POST' && req.url === '/api/components/rescan') {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'loopback_only' });
    componentManager.action('', 'rescan', {}).then(() => json(res, 200, { ok: true, components: componentManager.list() })).catch(error => json(res, 500, { ok: false, error: error.message }));
    return;
  }
  if (req.method === 'POST' && req.url.startsWith('/api/components/')) {
    if (!isLoopbackRequest(req)) return json(res, 403, { ok: false, error: 'loopback_only' });
    const id = decodeURIComponent(req.url.slice('/api/components/'.length).split('?')[0]);
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 64 * 1024) req.destroy();
    });
    req.on('end', async () => {
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        return json(res, 400, { ok: false, error: 'invalid_json' });
      }
      if (!isRecord(payload)) return json(res, 400, { ok: false, error: 'invalid_payload' });
      try {
        const result = await componentManager.action(id, String(payload.action || ''), payload);
        return json(res, 200, { ok: true, ...result, components: componentManager.list() });
      } catch (error) {
        return json(res, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          components: componentManager.list()
        });
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/state') return json(res, 200, snapshot(false));
  if (req.method === 'GET' && req.url === '/api/server-info') return json(res, 200, info());
  if (req.method === 'PUT' && req.url === '/api/config') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const patch = JSON.parse(body);
        if (!isRecord(patch)) return json(res, 400, { error: 'invalid_config' });
    config = validateConfig({ ...config, ...patch }, config);
    syncMixerConfig();
    saveConfig();
        for (const source of config.sources) {
          if (source.sourceId && !streams.has(source.sourceId)) streams.set(source.sourceId, streamFromSource(source));
        }
        broadcastControl();
        return json(res, 200, config);
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/browser-source') {
    handleBrowserSourceRegistration(req, res);
    return;
  }
  if (req.method === 'POST' && req.url === '/api/external-source') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 16 * 1024) req.destroy();
    });
    req.on('end', () => {
      let request;
      try {
        request = JSON.parse(body || '{}');
      } catch {
        return json(res, 400, { error: 'invalid_json' });
      }
      const record = sourceFromExternal(request);
      if (!record) return json(res, 400, { error: 'invalid_source' });
      const registered = registerDiscoveredSource(record);
      broadcastControl();
      return json(res, 200, {
        ok: true,
        sourceId: registered.sourceId,
        sourceHash: registered.sourceHash,
        mixerId: sourceMixerId(registered),
        deviceId: registered.deviceId,
        deviceName: registered.deviceName,
        streamType: registered.streamType,
        transport: registered.transport,
        audioPort: AUDIO_PORT,
        controlPort: HTTP_PORT
      });
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/airplay/status') {
    return json(res, 200, { ok: true, mode: 'managed-native', lines: airplayManager.list() });
  }
  if (req.method === 'GET' && req.url === '/api/airplay-lines') {
    const lines = airplayManager.list().map(line => ({
      ...line,
      guideUrl: guideUrlForLine(line.id),
      source: sourceSnapshots().find(source => source.airplayLineId === line.id) || null,
      routes: config.routes.filter(([from]) => from === config.sources.find(item => item.airplayLineId === line.id)?.id),
      paths: config.routes.filter(([from]) => from === config.sources.find(item => item.airplayLineId === line.id)?.id).map(([, busId]) => {
        const bus = config.buses.find(bus => bus.id === busId);
        const targets = config.routes.filter(([from]) => from === busId).map(([, outputId]) => config.outputs.find(output => output.id === outputId)).filter(Boolean);
        return { bus: bus?.name || busId, muted: bus?.muted === true, outputs: targets.map(output => ({ name: output.name, enabled: output.enabled })) };
      })
    }));
    return json(res, 200, { ok: true, lines, receiver: airplayManager.executable(), guidePort: webMicrophoneGateway.status().port, guideError: webMicrophoneGateway.status().error });
  }
  if (req.method === 'POST' && req.url === '/api/airplay-lines') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      try {
        const request = JSON.parse(body || '{}');
        const line = airplayManager.add({ name: request.name });
        const url = guideUrlForLine(line.id);
        return json(res, 201, { ok: true, line: { ...line, guideUrl: url } });
      } catch (error) { return json(res, 400, { ok: false, error: error.message || 'invalid_request' }); }
    });
    return;
  }
  const airplayLineMatch = req.url.match(/^\/api\/airplay-lines\/([a-z0-9-]+)(?:\/(start|stop|remove))?$/i);
  if (req.method === 'POST' && airplayLineMatch) {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', async () => {
      try {
        const [, id, action] = airplayLineMatch;
        const line = action === 'start' ? await airplayManager.start(id)
          : action === 'stop' ? airplayManager.stop(id)
            : action === 'remove' ? airplayManager.remove(id)
              : null;
        if (!action) return json(res, 200, { ok: true, line: airplayManager.list().find(item => item.id === id) || null });
        return json(res, 200, { ok: true, line });
      } catch (error) { return json(res, 400, { ok: false, error: error.message || 'airplay_action_failed' }); }
    });
    return;
  }
  if (['/api/airplay/bridge', '/api/airplay/receiver', '/api/airplay/arguments', '/airplay-guide'].includes(req.url)) {
    return json(res, 410, { ok: false, error: 'legacy_airplay_disabled', hint: 'Use canvas Add iOS source and /api/airplay-lines' });
  }
  const pathname = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // Keep one maintained web microphone implementation while exposing an
  // iOS-specific, readable QR path for phones.
  const assetPath = pathname === '/ios-node.html' ? '/browser-node.html' : pathname;
  const file = path.resolve(ROOT, `.${assetPath}`);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) return json(res, 404, { error: 'not_found' });
  const contentTypes = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };
  res.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

// A dedicated phone gateway exposes only microphone registration and audio.
const webMicrophoneGateway = createWebMicrophoneGateway({
  root: ROOT, dataDir: DATA_DIR, bindHost: LAN_BIND_HOST,
  lineForId: id => airplayManager.list().find(line => line.id === id),
  register: handleBrowserSourceRegistration, upgrade: handleBrowserAudioUpgrade
});
function guideUrlForLine(id) { return webMicrophoneGateway.url(airplayLanAddress(), id, true); }

server.on('upgrade', (req, socket) => {
  const requestUrl = new URL(req.url, 'http://localhost');
  if (requestUrl.pathname === '/browser-audio') {
    handleBrowserAudioUpgrade(req, socket, requestUrl);
    return;
  }
  if (req.url !== '/audio' && req.url !== '/control') return socket.destroy();
  const client = acceptWebSocket(req, socket);
  if (!client) return;
  if (req.url === '/audio') {
    audioClients.add(client);
    client.on('close', () => audioClients.delete(client));
    client.on('error', () => audioClients.delete(client));
    client.on('data', () => {});
    return;
  }
  controlClients.add(client);
  client.on('close', () => controlClients.delete(client));
  client.on('error', () => controlClients.delete(client));
  client.on('data', chunk => consumeControlFrames(client, chunk));
  sendControl(client, snapshot());
});

const discovery = dgram.createSocket('udp4');
discovery.on('message', (message, remote) => {
  let request;
  try {
    request = JSON.parse(message.toString('utf8'));
  } catch {
    return;
  }
  if (!isRecord(request)) return;
  // Phone sends voice-enhancement toggle as a UDP control message to the
  // discovery port (it has no WebSocket). Handle it here so phone and PC
  // stay in sync.
  if (request.type === 'source.voiceEnhanced') {
    const source = config.sources.find(item =>
      item.deviceId === request.deviceId || item.streamType === request.streamType
    );
    if (source) {
      source.voiceEnhanced = request.enabled === true;
      saveConfig();
      syncMixerConfig();
      broadcastControl();
    }
    return;
  }
  sendDiscoveryResponse(request, remote);
});
discovery.bind(DISCOVERY_PORT, LAN_BIND_HOST);

// Reused decode buffer: the JitterBuffer copies packet PCM on push, so a
// single scratch array serves every packet without per-packet allocation.
let decodeScratch = new Float32Array(2048);

// Single audio ingress shared by the UDP listener and the browser WebSocket
// bridge. Keeping one path means a browser source reuses the existing Mixer /
// native engine / statistics / route filtering instead of growing a second
// mixing implementation that would drift from the native nodes.
function ingestAudioPacket(packet, remote, transport = 'udp') {
  if (packet.length < 24 || packet.length > MAX_AUDIO_PACKET_BYTES) return false;
  if ((packet.length - 20) % 4 !== 0 || packet.subarray(0, 4).toString() !== 'MSA1') return false;
  const sourceHash = packet.readUInt32LE(4);
  const sourceId = sourceHash.toString(16);
  if (removedSourceIds.has(sourceId)) return false;
  let source = config.sources.find(item => item.sourceId === sourceId);
  if (!source) {
    source = {
      id: `net-${sourceId}`,
      sourceId,
      sourceHash,
      deviceId: null,
      deviceName: '未知设备',
      streamId: null,
      streamType: 'unknown',
      sampleRate: config.settings.sampleRate,
      channels: config.settings.channels,
      codec: 'pcm_f32le',
      muted: false,
      stopped: false
    };
    persistSources([...config.sources, source]);
  }
  let stream = streams.get(sourceId);
  if (!stream) {
    stream = streamFromSource(source);
    streams.set(sourceId, stream);
  }
  if (source.stopped || stream.stopped) return false;
  const mixerId = sourceMixerId(source);
  const sampleCount = (packet.length - 20) / 4;
  if (decodeScratch.length < sampleCount) {
    decodeScratch = new Float32Array(Math.ceil(sampleCount / 2048) * 2048);
  }
  const pcm = decodeScratch.subarray(0, sampleCount);
  let energy = 0;
  for (let index = 0; index < sampleCount; index++) {
    const sample = packet.readFloatLE(20 + index * 4);
    const value = Number.isFinite(sample) ? sample : 0;
    pcm[index] = value;
    energy += value * value;
  }
  const sequence = packet.readUInt32LE(8);
  if (engineOutputs) {
    for (const [outputId, output] of Object.entries(engineOutputs)) {
      if (!output.enabled) continue;
      const active = engineActiveSources.get(outputId);
      if (!active || !active.has(sourceHash)) continue;
      output.writePacket(sourceHash, sequence, pcm);
    }
  } else {
    mixer.push(mixerId, sequence, pcm, performance.now());
  }
  const justCameOnline = !stream.online;
  stream.packets++;
  stream.bytes += packet.length - 20;
  stream.sequence = packet.readUInt32LE(8);
  stream.timestamp = Number(packet.readBigUInt64LE(12));
  stream.rms = sampleCount ? Math.sqrt(energy / sampleCount) : 0;
  stream.lastSeen = Date.now();
  if (remote?.address) stream.address = remote.address;
  // transport is a property of the source (udp / browser / airplay), declared at
  // registration. Do not overwrite it with the inbound packet's transport, or an
  // AirPlay source would be relabelled as "udp" on its first packet.
  stream.online = true;
  if (justCameOnline) broadcastControl();
  if (source.muted) return true;
  const frame = wsFrame(packet);
  for (const client of audioClients) {
    if (!client.destroyed) client.write(frame);
  }
  return true;
}

const audio = dgram.createSocket('udp4');
audio.on('message', (packet, remote) => { ingestAudioPacket(packet, remote, 'udp'); });
audio.bind(AUDIO_PORT, LAN_BIND_HOST);

// Reused per-output mixdown buffers; one allocation per output for the whole
// process lifetime instead of one per render tick.
const MAX_CATCH_UP_MS = 200;
const maxRenderFrames = Math.ceil(config.settings.sampleRate * MAX_CATCH_UP_MS / 1000) + renderBlockFrames;
const outputBlocks = new Map();
const audioClock = { startedAt: performance.now(), producedFrames: 0, blocks: 0, resyncs: 0, maxCatchUpMs: 0 };

function getOutputBlock(outputId, frameCount) {
  const length = frameCount * config.settings.channels;
  let block = outputBlocks.get(outputId);
  if (!block || block.length < length) {
    block = new Float32Array(maxRenderFrames * config.settings.channels);
    outputBlocks.set(outputId, block);
  }
  return block.subarray(0, length);
}

// Actual render cadence. Node timers fire at OS granularity (~12-16 ms on
// Windows), so the realized block is usually larger than renderBlockMs; using
// the measured average keeps the reported per-source latency honest.
function averageBlockMs() {
  if (!audioClock.blocks) return renderBlockMs;
  return audioClock.producedFrames / audioClock.blocks * 1000 / config.settings.sampleRate;
}

function outputQueueMs() {
  const queues = [];
  if (nativeOutput.enabled) queues.push(nativeOutput.status().queuedMs || 0);
  if (virtualOutput.enabled) queues.push(virtualOutput.status().queuedMs || 0);
  return queues.length ? Math.max(...queues) : 0;
}

// Per-source playout latency, measured instead of guessed:
// realized jitter-buffer residence (arrival -> playout) + render block + the
// current output FIFO depth. EWMA-smoothed because individual frames jitter.
function updateSourceLatencyStats() {
  const queueMs = outputQueueMs();
  for (const [mixerId, stats] of mixer.sourceStats()) {
    const sourceId = mixerIdToSourceId.get(mixerId);
    const stream = sourceId ? streams.get(sourceId) : null;
    if (!stream || !stream.online) continue;
    stream.jitterMs = stats.jitterMs;
    stream.bufferDelayMs = stats.bufferDelayMs;
    stream.occupancyMs = stats.occupancyMs;
    stream.targetMs = stats.targetMs;
    stream.starvedPackets = stats.starved;
    stream.overrunPackets = stats.overrun;
    stream.framesIn = stats.framesIn;
    stream.framesOut = stats.framesOut;
    stream.queuedFrames = stats.queuedFrames;
    stream.lostPackets = stats.lost;
    stream.overflowedPackets = stats.overflowed;
    const latency = (stats.bufferDelayMs || 0) + averageBlockMs() + queueMs;
    stream.latencyMs = stream.latencyMs === null ? latency : stream.latencyMs + (latency - stream.latencyMs) * 0.15;
  }
}

function renderNativeAudio(frameCount = renderBlockFrames) {
  if (!nativeOutput.enabled && !virtualOutput.enabled) return;
  const outputBuses = new Map([
    ['out-speaker', new Set()],
    ['out-virtual', new Set()]
  ]);
  for (const edge of config.routes) {
    if (Array.isArray(edge) && outputBuses.has(edge[1])) outputBuses.get(edge[1]).add(edge[0]);
  }
  if (![...outputBuses.values()].some(set => set.size > 0)) return;
  const rendered = mixer.render(frameCount);
  updateSourceLatencyStats();
  for (const [outputId, buses] of outputBuses) {
    if (buses.size === 0) continue;
    const block = getOutputBlock(outputId, frameCount);
    block.fill(0);
    for (const busId of buses) {
      const busBlock = rendered.get(busId);
      if (!busBlock) continue;
      for (let index = 0; index < block.length; index++) {
        const value = block[index] + busBlock[index];
        block[index] = Number.isFinite(value) ? Math.max(-1, Math.min(1, value)) : 0;
      }
    }
    if (outputId === 'out-speaker' && nativeOutput.enabled) nativeOutput.writeBlock(block, frameCount);
    if (outputId === 'out-virtual' && virtualOutput.enabled) virtualOutput.writeBlock(block, frameCount);
  }
}

// Frame-exact wall-clock pacing. A fixed "one block per timer tick" loop is
// wrong on Windows: Node timers fire at ~12-16 ms OS granularity, so a 5 ms
// timer yields fewer blocks than real time needs (buffer backlog and growing
// latency) or, with setInterval catch-up, more than the WASAPI consumer drains
// (queue overflow and dropped blocks -- the original "robotic audio" symptom).
// Instead every tick renders exactly the frames that wall-clock time demands,
// so production always matches the endpoint clock. The reference project paces
// its capture thread the same way: by the audio timeline, not by timer cadence.
// A stall longer than MAX_CATCH_UP_MS is capped and the accounting resynced so
// a GC pause cannot burst hundreds of milliseconds of audio at once.
function pumpAudioClock() {
  const sampleRate = config.settings.sampleRate;
  const now = performance.now();
  const elapsedMs = now - audioClock.startedAt - audioClock.producedFrames * 1000 / sampleRate;
  if (elapsedMs <= 0) return;
  let dueFrames = Math.floor(elapsedMs * sampleRate / 1000);
  if (dueFrames <= 0) return;
  if (elapsedMs > audioClock.maxCatchUpMs) audioClock.maxCatchUpMs = round1(elapsedMs);
  const maxFrames = Math.round(MAX_CATCH_UP_MS * sampleRate / 1000);
  if (dueFrames > maxFrames) {
    audioClock.startedAt = now - audioClock.producedFrames * 1000 / sampleRate - MAX_CATCH_UP_MS;
    audioClock.resyncs++;
    dueFrames = maxFrames;
  }
  renderNativeAudio(dueFrames);
  audioClock.producedFrames += dueFrames;
  audioClock.blocks++;
  // Calibrate the legacy timer renderer once, independently of UI telemetry.
  // Windows timers may run at a coarser cadence than the requested 5 ms.
  if (audioClock.blocks === 100) mixer.setTargetMs(Math.max(targetBufferMs, averageBlockMs() * 2));
}

if (!engineOutputs) setInterval(pumpAudioClock, renderBlockMs).unref();

function round1(value) {
  return Math.round(value * 10) / 10;
}

// Per-source latency is refreshed to the UI on a fixed cadence (default 5 s,
// configurable). Only broadcast while at least one source is online so an
// idle server stays quiet.
const latencyRefreshMs = Math.max(1000, Number(process.env.MESHAUDIO_LATENCY_REFRESH_MS) || 5000);
setInterval(() => {
  let anyOnline = false;
  for (const stream of streams.values()) {
    if (stream.online) { anyOnline = true; break; }
  }
  if (anyOnline) broadcastControl({
    type: 'state.telemetry', measuredAt: Date.now(),
    sources: config.sources.map(source => {
      const stream = streams.get(source.sourceId);
      return { id: source.id, rms: stream?.rms || 0, latencyMs: stream?.latencyMs ?? null,
        packets: stream?.packets || 0, receiving: stream?.online === true };
    }),
    server: { latencyRefreshMs }
  });
}, latencyRefreshMs).unref();

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const stream of streams.values()) {
    if (stream.online && now - stream.lastSeen > 3000) {
      stream.online = false;
      stream.rms = 0;
      stream.latencyMs = null;
      changed = true;
    }
  }
  if (changed) broadcastControl();
}, 1000).unref();

pruneStaleManifest();

server.on('error', error => {
  if (error && error.code === 'EADDRINUSE') {
    const owner = ownedByAnotherInstance();
    if (owner) {
      console.error(
        `[singleton] MeshAudio already running (pid=${owner.pid}, port=${owner.controlPort}); delegating`
      );
      process.exit(EXIT_ALREADY_RUNNING);
    }
    console.error(`[fatal] control port ${HTTP_PORT} is in use by another process`);
    process.exit(1);
  }
  console.error('[fatal] control server error:', error && error.message);
  process.exit(1);
});

server.listen(HTTP_PORT, CONTROL_BIND_HOST, () => {
  const address = server.address();
  const actualPort = address && typeof address === 'object' ? address.port : HTTP_PORT;
  writeRuntimeManifest({ control: actualPort, discovery: DISCOVERY_PORT, audio: AUDIO_PORT });
  console.log(`MeshAudio control listening on port ${actualPort}`);
  startParentWatchdog();
});

/**
 * If the desktop shell dies without cleaning up (crash, task manager kill),
 * exit so we never linger as an orphan holding the audio devices.
 */
let parentWatchdog = null;
let watchParentPid = PARENT_PID;

function startParentWatchdog() {
  if (!watchParentPid || parentWatchdog) return;
  const watched = watchParentPid;
  parentWatchdog = setInterval(() => {
    if (!isProcessAlive(watched)) {
      console.error(`[watchdog] parent ${watched} is gone; shutting down`);
      shutdown();
    }
  }, 2000);
  parentWatchdog.unref();
}

/**
 * Ownership transfer: the shell that adopted us becomes the new parent we
 * watch. Without this, an adopted server would outlive a hard-killed app.
 */
function handoffParent(pid) {
  if (parentWatchdog) { clearInterval(parentWatchdog); parentWatchdog = null; }
  watchParentPid = pid;
  console.log(`[watchdog] now watching parent ${pid}`);
  startParentWatchdog();
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  networkAddresses.close();
  if (parentWatchdog) { clearInterval(parentWatchdog); parentWatchdog = null; }
  try { nativeOutput.stop(); } catch (_) {}
  try { virtualOutput.stop(); } catch (_) {}
  if (engineOutputs) for (const output of Object.values(engineOutputs)) {
    try { output.stop(); } catch (_) {}
  }
  try { discovery.close(); } catch (_) {}
  try { airplayManager.stopAll(); } catch (_) {}
  try { webMicrophoneGateway.close(); } catch (_) {}
  try { audio.close(); } catch (_) {}
  clearRuntimeManifest();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGHUP', shutdown);
process.once('exit', clearRuntimeManifest);
