'use strict';
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
function readAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter(item => item && item.family === 'IPv4' && !item.internal).map(item => item.address);
}
if (!isMainThread && workerData?.meshAudioNetworkCache) {
  setInterval(() => { try { parentPort.postMessage(readAddresses()); } catch { /* keep last successful result */ } }, workerData.intervalMs);
}
function createNetworkAddressCache(intervalMs = 30000) {
  // The only synchronous query happens before audio starts. Windows adapter
  // discovery can block for tens of milliseconds, so refresh it off-thread.
  let addresses = readAddresses();
  const worker = new Worker(__filename, { workerData: { meshAudioNetworkCache: true, intervalMs } });
  worker.on('message', value => { if (Array.isArray(value)) addresses = value; });
  worker.on('error', error => console.warn('[network-addresses]', error.message));
  worker.unref();
  return { get: () => addresses.slice(), close: () => worker.terminate() };
}
module.exports = { createNetworkAddressCache };
