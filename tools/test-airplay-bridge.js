/**
 * AirPlay 桥接回归：启动桥接 → 灌入 44.1 kHz S16LE 立体声 → 校验 /api/state。
 *
 * 用法：node tools/test-airplay-bridge.js [host] [controlPort] [audioPort]
 * 说明：不需要真实 AirPlay 接收端；本脚本模拟接收端向桥接的 TCP 端口发送 PCM。
 */
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const host = process.argv[2] || '127.0.0.1';
const controlPort = Number(process.argv[3] || 4173);
const audioPort = Number(process.argv[4] || 4175);
const bridgePort = controlPort + 7;
const ROOT = path.join(__dirname, '..');

function request(method, requestPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port: controlPort, path: requestPath, method, timeout: 5000 }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${body}`));
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

function connectWithRetry(port, attempts = 40) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const tryOnce = () => {
      const socket = net.connect(port, host);
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (--remaining <= 0) return reject(new Error('bridge port not ready'));
        setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

function buildPcm() {
  const frames = 44100;
  const buffer = Buffer.alloc(frames * 2 * 2);
  for (let index = 0; index < frames; index++) {
    const value = Math.round(Math.sin(2 * Math.PI * 440 * index / 44100) * 0.2 * 32767);
    buffer.writeInt16LE(value, index * 4);
    buffer.writeInt16LE(value, index * 4 + 2);
  }
  return buffer;
}

async function main() {
  const bridge = spawn(process.execPath, [
    path.join(ROOT, 'desktop', 'airplay-bridge.js'),
    '--control-port', String(controlPort),
    '--audio-port', String(audioPort),
    '--listen-port', String(bridgePort),
    '--source-rate', '44100',
    '--format', 's16le',
    '--device-name', 'AirPlay 测试接收端',
    '--device-id', 'airplay-test',
    '--stats-interval', '1000'
  ], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });

  let bridgeLog = '';
  bridge.stdout.on('data', chunk => { bridgeLog += chunk; });
  bridge.stderr.on('data', chunk => { bridgeLog += chunk; });

  try {
    const socket = await connectWithRetry(bridgePort);
    const pcm = buildPcm();
    const chunkSize = 8820; // 50 ms 的 PCM
    let midState = null;
    for (let offset = 0; offset < pcm.length; offset += chunkSize) {
      socket.write(pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length)));
      await new Promise(resolve => setTimeout(resolve, 50));
      // 发送中途采样：此时队列里一定有数据，rms 不会被结尾静音冲成 0。
      if (!midState && offset >= pcm.length * 0.5) {
        midState = await request('GET', '/api/state');
      }
    }
    socket.end();
    await new Promise(resolve => setTimeout(resolve, 200));

    const finalState = await request('GET', '/api/state');
    const source = (finalState.sources || []).find(item => item.transport === 'airplay');
    if (!source) throw new Error('airplay source missing from /api/state');
    if (source.streamType !== 'media') throw new Error(`unexpected streamType: ${source.streamType}`);
    if (!(source.packets > 0)) throw new Error('no packets ingested');
    const midSource = (midState?.sources || []).find(item => item.transport === 'airplay');
    if (!midSource || !(midSource.rms > 0)) throw new Error('rms is zero while streaming: PCM was not converted');

    console.log(JSON.stringify({
      ok: true,
      sourceId: source.sourceId,
      deviceName: source.deviceName,
      streamType: source.streamType,
      transport: source.transport,
      packets: source.packets,
      rmsMidStream: Number(midSource.rms.toFixed(4)),
      address: source.address
    }, null, 2));
  } catch (error) {
    const tail = bridgeLog.trim().split(/\r?\n/).slice(-8).join('\n');
    throw new Error(`${error.message}${tail ? `\n--- bridge log ---\n${tail}` : ''}`);
  } finally {
    bridge.kill();
  }
}

main().then(() => process.exit(0)).catch(error => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
