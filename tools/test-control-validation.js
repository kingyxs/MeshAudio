const net = require('net');
const crypto = require('crypto');

const host = process.argv[2] || '127.0.0.1';
const port = Number(process.argv[3] || 4173);
const key = crypto.randomBytes(16).toString('base64');
const socket = net.createConnection(port, host);
let buffer = Buffer.alloc(0);
let upgraded = false;
let snapshots = 0;
let originalRoutes = [];

function maskedTextFrame(value) {
  const body = Buffer.from(value);
  const mask = crypto.randomBytes(4);
  const encoded = Buffer.alloc(body.length);
  for (let i = 0; i < body.length; i++) encoded[i] = body[i] ^ mask[i % 4];
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, encoded]);
  if (body.length >= 65536) throw new Error('test payload unexpectedly large');
  return Buffer.concat([Buffer.from([0x81, 0xfe, body.length >> 8, body.length & 0xff]), mask, encoded]);
}

function readFrames() {
  while (buffer.length >= 2) {
    const first = buffer[0];
    const second = buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
    if (length === 127) throw new Error('unexpected large websocket frame');
    if (buffer.length < offset + length) return;
    const payload = buffer.subarray(offset, offset + length);
    buffer = buffer.subarray(offset + length);
    if ((first & 0x0f) !== 0x1) continue;
    const message = JSON.parse(payload.toString());
    if (message.type !== 'state.snapshot') continue;
    snapshots++;
    if (snapshots === 1) {
      originalRoutes = message.config.routes || [];
      const patch = {
        type: 'config.patch',
        patch: {
          routes: [
            ['bus-main', 'out-speaker'],
            ['phone-mic', 'bus-main'],
            ['bus-main', 'bus-voice'],
            ['phone-mic', 'out-speaker'],
            ['out-speaker', 'bus-main']
          ]
        }
      };
      socket.write(maskedTextFrame(JSON.stringify(patch)));
    } else if (snapshots === 2) {
      const routes = message.config.routes.map(edge => edge.join('>'));
      if (!routes.includes('bus-main>out-speaker')) throw new Error('valid bus->output route was removed');
      if (!routes.includes('phone-mic>bus-main')) throw new Error('valid source->bus route was removed');
      if (routes.includes('bus-main>bus-voice')) throw new Error('invalid bus->bus route accepted');
      if (routes.includes('phone-mic>out-speaker')) throw new Error('invalid source->output route accepted');
      if (routes.includes('out-speaker>bus-main')) throw new Error('invalid output->bus route accepted');
      console.log('control route validation passed');
      socket.write(maskedTextFrame(JSON.stringify({ type: 'config.patch', patch: { routes: originalRoutes } })));
    } else {
      socket.end();
      process.exit(0);
    }
  }
}

socket.on('connect', () => socket.write(`GET /control HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
socket.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  if (!upgraded) {
    const marker = buffer.indexOf('\r\n\r\n');
    if (marker < 0) return;
    if (!buffer.subarray(0, marker).toString().includes('101')) throw new Error('upgrade failed');
    upgraded = true;
    buffer = buffer.subarray(marker + 4);
  }
  readFrames();
});
setTimeout(() => { console.error('control validation timeout'); process.exit(1); }, 3000);
