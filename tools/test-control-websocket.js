'use strict';
const net = require('net');
const crypto = require('crypto');
const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 4173);
const key = crypto.randomBytes(16).toString('base64');
let buffer = Buffer.alloc(0), upgraded = false, received = false;
const client = net.createConnection(port, host, () => client.write(
  `GET /control HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
));
const timeout = setTimeout(() => { if (!received) { console.error('control websocket timeout'); process.exit(1); } }, 3000);
client.on('error', error => { clearTimeout(timeout); console.error(error.message); process.exitCode = 1; });
client.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const boundary = buffer.indexOf('\r\n\r\n');
    if (boundary < 0) return;
    if (!buffer.subarray(0, boundary).toString().includes('101')) throw new Error('websocket upgrade failed');
    upgraded = true; buffer = buffer.subarray(boundary + 4);
  }
  if (!received && buffer.length >= 2) {
    let length = buffer[1] & 127, offset = 2;
    if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
    if (buffer.length < offset + length) return;
    if (!buffer.subarray(offset, offset + length).toString().includes('state.snapshot')) throw new Error('snapshot missing');
    received = true; clearTimeout(timeout); console.log('control websocket snapshot received'); client.destroy(); process.exit(0);
  }
});
