'use strict';
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const host = process.argv[2] || '127.0.0.1';
const controlPort = Number(process.argv[3] || 4173);
const audioPort = Number(process.argv[4] || 4175);
const key = crypto.randomBytes(16).toString('base64');
const client = net.createConnection(controlPort, host);
let buffer = Buffer.alloc(0), upgraded = false, received = false;
client.on('connect', () => client.write(`GET /audio HTTP/1.1\r\nHost: ${host}:${controlPort}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
client.on('error', error => { console.error(error.message); process.exitCode = 1; });
client.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const boundary = buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    if (!buffer.subarray(0, boundary).toString().includes('101')) throw new Error('audio websocket upgrade failed');
    upgraded = true; buffer = buffer.subarray(boundary + 4); sendProbe();
  }
  if (upgraded && !received && buffer.length >= 2) {
    const length = buffer[1] & 127, header = length < 126 ? 2 : 4;
    const size = length < 126 ? length : buffer.readUInt16BE(2);
    if (buffer.length >= header + size) { received = true; console.log(`audio websocket frame received: ${size} bytes`); client.destroy(); process.exit(0); }
  }
});
function sendProbe() {
  const udp = dgram.createSocket('udp4');
  const pcm = Buffer.alloc(16); pcm.writeFloatLE(.1, 0); pcm.writeFloatLE(.1, 4); pcm.writeFloatLE(.1, 8); pcm.writeFloatLE(.1, 12);
  const header = Buffer.alloc(20); header.write('MSA1'); header.writeUInt32LE(0xBEEF, 4); header.writeUInt32LE(1, 8); header.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12);
  udp.send(Buffer.concat([header, pcm]), audioPort, host, () => setTimeout(() => udp.close(), 100));
}
setTimeout(() => { if (!received) { console.error('no audio websocket frame'); process.exit(1); } }, 3000);
