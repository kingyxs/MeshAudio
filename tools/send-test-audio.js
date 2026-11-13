const dgram = require('dgram');
const socket = dgram.createSocket('udp4');
const host = process.argv[2] || '127.0.0.1';
let sequence = 0;
const rate = 48000;
const frames = 480;
const pcm = Buffer.alloc(frames * 2 * 4);
for (let i = 0; i < frames; i++) { const value = Math.sin(2 * Math.PI * 440 * i / rate) * 0.2; pcm.writeFloatLE(value, i * 8); pcm.writeFloatLE(value, i * 8 + 4); }
const timer = setInterval(() => { const header = Buffer.alloc(20); header.write('MSA1', 0); header.writeUInt32LE(0x1234, 4); header.writeUInt32LE(sequence++, 8); header.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 12); socket.send(Buffer.concat([header, pcm]), 4175, host); }, 10);
setTimeout(() => { clearInterval(timer); socket.close(); console.log(`sent ${sequence} test PCM packets to ${host}:4175`); }, 3000);
