'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { createComponentManager } = require('../desktop/component-manager');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const body = Buffer.from('isolated Bonjour installer fixture');
const checks = [];
async function scenario(name, settings, verify) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-bundled-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({ components: [
    { id: 'bonjour', install: { type: 'exe' }, download: { url: 'https://fixture.invalid/bonjour.exe', filename: 'bonjour.exe', sha256: crypto.createHash('sha256').update(body).digest('hex') } },
    { id: 'uxplay', install: { type: 'bundled' }, requires: settings.cycle ? ['uxplay'] : ['bonjour'] }
  ] }));
  let detected = settings.bonjour === true, calls = 0, downloads = 0;
  const manager = createComponentManager({ dataDir: dir, manifestPath,
    detect: id => ({ detected: id === 'uxplay' ? settings.runtime !== false : detected }),
    openStream: async () => { downloads++; const stream = Readable.from([body]); stream.headers = { 'content-length': body.length }; return { stream, request: { destroy: error => stream.destroy(error) } }; },
    installRunner: async () => { calls++; if (settings.runner) return settings.runner(calls, () => { detected = true; }); detected = true; return 0; }
  });
  try { await verify(manager, () => ({ calls, downloads })); checks.push(name); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
async function terminal(manager) {
  for (let i = 0; i < 600; i++) {
    const entry = manager.list().find(e => e.id === 'uxplay');
    if (!entry.busy && ['installed', 'restart-required', 'error'].includes(entry.progress.phase)) return entry;
    await sleep(10);
  }
  throw new Error('bundled setup timeout');
}
async function main() {
  let release;
  await scenario('bundled plugin reports pending prerequisites; explicit auto-setup installs Bonjour once and waits', { runner: (_count, ready) => new Promise(resolve => { release = () => { ready(); resolve(0); }; }) }, async (manager, counts) => {
    const before = manager.list().find(e => e.id === 'uxplay'); assert(before.detected); assert(!before.ready); assert.deepEqual(counts(), { calls: 0, downloads: 0 });
    assert(manager.action('uxplay', 'setup').started); assert(manager.action('uxplay', 'setup').already);
    for (let i = 0; i < 200 && !release; i++) await sleep(10);
    assert(release); assert(manager.action('bonjour', 'setup').already); assert.equal(counts().calls, 1);
    assert(!manager.list().find(e => e.id === 'uxplay').ready); release();
    const entry = await terminal(manager); assert(entry.ready); assert(entry.installedByApp); assert.deepEqual(counts(), { calls: 1, downloads: 1 });
    assert.throws(() => manager.action('uxplay', 'launch'), /use_canvas_airplay_lines/);
  });
  await scenario('complete bundled runtime with existing Bonjour performs no downloads or installer calls', { bonjour: true }, async (manager, counts) => {
    assert(manager.action('uxplay', 'setup').already); assert(manager.list().find(e => e.id === 'uxplay').ready); assert.deepEqual(counts(), { calls: 0, downloads: 0 });
  });
  await scenario('missing bundled files request application repair without downloading a wrapper or installing prerequisites', { runtime: false }, async (manager, counts) => {
    manager.action('uxplay', 'setup'); const entry = await terminal(manager); assert.equal(entry.progress.error, 'bundled_runtime_missing_reinstall'); assert(!entry.ready); assert.deepEqual(counts(), { calls: 0, downloads: 0 });
  });
  await scenario('prerequisite cancellation reaches the plugin status and can be retried', { runner: (count, ready) => { if (count === 1) throw new Error('elevation_cancelled'); ready(); return 0; } }, async (manager, counts) => {
    manager.action('uxplay', 'setup'); assert.equal((await terminal(manager)).progress.error, 'elevation_cancelled');
    manager.action('uxplay', 'setup'); assert((await terminal(manager)).ready); assert.deepEqual(counts(), { calls: 2, downloads: 1 });
  });
  await scenario('prerequisite restart requirement is propagated without reporting ready', { runner: () => 3010 }, async manager => {
    manager.action('uxplay', 'setup'); const entry = await terminal(manager); assert(entry.restartRequired); assert(!entry.ready); assert.equal(entry.progress.phase, 'restart-required');
  });
  await scenario('invalid dependency cycle is rejected before starting any job', { cycle: true }, async (manager, counts) => {
    assert.throws(() => manager.action('uxplay', 'setup'), /component_dependency_cycle/); assert.deepEqual(counts(), { calls: 0, downloads: 0 });
  });
  const report = { ok: true, testedAt: new Date().toISOString(), realInstallersLaunched: false, checks };
  fs.mkdirSync(path.join(__dirname, '../docs/testing'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, '../docs/testing/bundled-airplay-setup-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
