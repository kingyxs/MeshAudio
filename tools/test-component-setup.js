'use strict';
// Deterministic installer lifecycle tests. No system driver/service is changed.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createComponentManager } = require('../desktop/component-manager');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = Buffer.from('a signed fixture would be used by the real runner');
const sha256 = crypto.createHash('sha256').update(body).digest('hex');
const checks = [];
async function scenario(name, options, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-setup-'));
  const manifest = path.join(dir, 'manifest.json');
  const fixture = { id: 'fixture', download: { url: 'https://fixture.invalid/setup.exe', filename: 'setup.exe', sha256 }, install: { type: 'exe', requiresRestart: false } };
  fs.writeFileSync(manifest, JSON.stringify({ components: [{ ...fixture, ...(options.entry || {}) }] }));
  let calls = 0; let downloaded = 0;
  const manager = createComponentManager({ dataDir: dir, manifestPath: manifest, detect: () => ({ detected: false }), openStream: async () => { downloaded++; const stream = Readable.from([body]); stream.headers = { 'content-length': body.length }; return { stream, request: { destroy: error => stream.destroy(error) } }; }, installRunner: async (...args) => { calls++; return options.runner ? options.runner(...args) : 0; }, ...options });
  try { await verify(manager, () => calls, () => downloaded, dir); checks.push(name); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function terminal(manager) {
  for (let i = 0; i < 300; i++) { const item = manager.list()[0]; if (!item.busy && ['installed', 'restart-required', 'error'].includes(item.progress.phase)) return item; await sleep(10); }
  throw new Error('setup timeout');
}
async function main() {
  await scenario('selected component downloads, verifies, waits and detects', { detect: async () => ({ detected: true }) }, async (m, calls, downloads) => {
    // Pre-scan also tests asynchronous detector caching.
    m.list(); await m.action('', 'rescan');
    assert.equal(m.action('fixture', 'setup').already, true); assert.equal(calls(), 0); assert.equal(downloads(), 0);
  });
  let detected = false; let release;
  await scenario('setup is idempotent while installing; no success before installer exits', { detect: () => ({ detected }), runner: () => new Promise(resolve => { release = () => { detected = true; resolve(0); }; }) }, async (m, calls) => {
    assert(m.action('fixture', 'setup').started);
    assert(m.action('fixture', 'setup').already);
    for (let i = 0; i < 100 && !release; i++) await sleep(10);
    assert(release); assert.equal(calls(), 1); assert.equal(m.list()[0].progress.phase, 'installing'); assert(!m.list()[0].installedByApp);
    assert.throws(() => m.remove('fixture'), /component_busy/);
    release(); const item = await terminal(m); assert(item.detected); assert.equal(item.progress.phase, 'installed');
  });
  await scenario('UAC cancellation is failure and remains retryable', { runner: () => { throw new Error('elevation_cancelled'); } }, async m => {
    m.action('fixture', 'setup'); const item = await terminal(m); assert.equal(item.progress.phase, 'error'); assert(!item.installedByApp); assert.match(item.progress.error, /cancelled/);
    m.action('fixture', 'setup'); assert.equal((await terminal(m)).progress.phase, 'error');
  });
  await scenario('successful exit without detection does not claim installed', {}, async m => { m.action('fixture', 'setup'); const item = await terminal(m); assert.equal(item.progress.error, 'installation_not_detected'); assert(!item.installedByApp); });
  await scenario('restart exit is explicit and persisted', { runner: () => 3010 }, async m => { m.action('fixture', 'setup'); const item = await terminal(m); assert(item.restartRequired); assert.equal(item.progress.phase, 'restart-required'); });
  await scenario('invalid pinned download never runs installer', { entry: { download: { url: 'https://fixture.invalid/setup.exe', filename: 'setup.exe', sha256: '0'.repeat(64) } } }, async (m, calls) => { m.action('fixture', 'setup'); assert.equal((await terminal(m)).progress.error, 'sha256_mismatch'); assert.equal(calls(), 0); });
  await scenario('tampered cached package is rejected before elevation', {}, async (m, calls, downloads, dir) => { const downloadDir = path.join(dir, 'components/downloads'); fs.writeFileSync(path.join(downloadDir, 'setup.exe'), 'tampered'); m.action('fixture', 'setup'); assert.equal((await terminal(m)).progress.error, 'sha256_mismatch'); assert.equal(calls(), 0); assert.equal(downloads(), 0); });
  const report = { ok: true, checkedAt: new Date().toISOString(), realInstallersLaunched: false, checks };
  fs.mkdirSync(path.join(__dirname, '../docs/testing'), { recursive: true }); fs.writeFileSync(path.join(__dirname, '../docs/testing/component-setup-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
