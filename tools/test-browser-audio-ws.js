/**
 * 浏览器节点回归：注册 → WebSocket 握手 → 发送 MSA1 帧 → 校验 /api/state。
 *
 * 用法：node tools/test-browser-audio-ws.js [host] [port]
 * 注意：注册会写入 DATA_DIR 的 config.json，联调时请用临时 MESHAUDIO_DATA_DIR。
 */
const net = require('net');
const http = require('http');
const crypto = require('crypto');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 4173);
const DEVICE_ID = `ws-test-${crypto.randomBytes(3).toString('hex')}`;
const FRAMES = 512;
const PACKETS = 20;

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host,
      port,
      path,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': payload.length }
        : {}
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error(`invalid JSON from ${path}`));
        }
      });
    });
    req.on('error', reject);
    req.end(payload || undefined);
  });
}

function maskedFrame(payload) {
  const mask = crypto.randomBytes(4);
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x82, 0x80 | length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x82;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x82;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) {
    masked[index] = payload[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

function msa1Packet(sourceHash, sequence) {
  const pcm = Buffer.alloc(FRAMES * 2 * 4);
  for (let index = 0; index < FRAMES; index++) {
    const value = Math.sin(2 * Math.PI * 440 * index / 48000) * 0.2;
    pcm.writeFloatLE(value, index * 8);
    pcm.writeFloatLE(value, index * 8 + 4);
  }
  const header = Buffer.alloc(20);
  header.write('MSA1');
  header.writeUInt32LE(sourceHash >>> 0, 4);
  header.writeUInt32LE(sequence >>> 0, 8);
  header.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12);
  return Buffer.concat([header, pcm]);
}

function upgrade(session) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(port, host);
    const key = crypto.randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('websocket upgrade timeout'));
    }, 5000);

    socket.on('connect', () => {
      socket.write(
        `GET ${session.wsPath}?token=${encodeURIComponent(session.token)} HTTP/1.1\r\n` +
        `Host: ${host}:${port}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
      );
    });

    socket.on('data', chunk => {
      if (settled) return;
      buffer = Buffer.concat([buffer, chunk]);
      const marker = buffer.indexOf('\r\n\r\n');
      if (marker < 0) return;
      const head = buffer.subarray(0, marker).toString();
      if (!head.includes('101')) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`upgrade rejected: ${head.split('\r\n')[0]}`));
      }
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  const session = await request('POST', '/api/browser-source', {
    deviceId: DEVICE_ID,
    deviceName: 'WS 测试节点',
    streamType: 'microphone'
  });
  if (!session.token || !session.sourceId) throw new Error('registration response missing token/sourceId');

  const socket = await upgrade(session);
  let sent = 0;
  for (let index = 0; index < PACKETS; index++) {
    socket.write(maskedFrame(msa1Packet(session.sourceHash, index)));
    sent++;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  socket.destroy();

  const state = await request('GET', '/api/state');
  const source = (state.sources || []).find(item => item.sourceId === session.sourceId);
  if (!source) throw new Error('source missing from /api/state');
  if (source.packets < sent) throw new Error(`packets ${source.packets} < sent ${sent}`);
  if (source.online !== true) throw new Error('source reported offline after receiving audio');
  if (!(source.rms > 0)) throw new Error('rms is zero: PCM was not decoded');

  console.log(JSON.stringify({
    ok: true,
    sourceId: source.sourceId,
    deviceName: source.deviceName,
    streamType: source.streamType,
    transport: source.transport || null,
    sent,
    packets: source.packets,
    rms: Number(source.rms.toFixed(4)),
    address: source.address
  }, null, 2));
}

main().then(() => process.exit(0)).catch(error => {
  console.error('FAIL:', error.message);
  process.exit(1);
});
