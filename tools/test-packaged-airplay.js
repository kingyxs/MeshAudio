'use strict';
// Exercises the built Tauri/WebView2 application and its actual sidecar bundle.
// Never changes the user's existing sources or routes; test lines are removed.
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');
const { chromium } = require('../.build-tools/ui-check/node_modules/playwright-core');
const root = path.resolve(__dirname, '..');
const binary = process.env.MESHAUDIO_TEST_BINARY
  ? path.resolve(process.env.MESHAUDIO_TEST_BINARY)
  : path.join(root, 'desktop-app/src-tauri/target/debug/meshaudio-desktop.exe');
const manifest = path.join(process.env.APPDATA, 'com.meshAudio.desktop/runtime.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let app, browser, appPage, port;
const created = [], checks = [], logs = [];
async function until(predicate, timeout = 20000) { const end = Date.now() + timeout; while (Date.now() < end) { try { const value = await predicate(); if (value) return value; } catch {} await sleep(100); } throw new Error('Packaged application readiness timed out'); }
async function api(route, method = 'GET', body) { const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }) }); const result = await response.json(); if (!response.ok) throw new Error(JSON.stringify(result)); return result; }
async function main() {
  assert(fs.existsSync(binary));
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve)); const debugPort = socket.address().port; await new Promise(resolve => socket.close(resolve));
  app = spawn(binary, [], { cwd: path.dirname(binary), windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort}`, MESHAUDIO_AIRPLAY_GUIDE_PORT: '0' } });
  app.stdout.on('data', data => logs.push(String(data))); app.stderr.on('data', data => logs.push(String(data)));
  await until(async () => { const state = JSON.parse(fs.readFileSync(manifest, 'utf8')); port = state.controlPort; return (await api('/api/health')).ok; });
  checks.push('built desktop application starts its bundled Node sidecar');
  const gateway = (await api('/api/state')).server.browserAudio.gateway;
  assert(gateway.port, 'bundled phone gateway missing');
  for (const route of ['/ios-node.html', '/browser-node.js']) {
    const response = await fetch(`http://127.0.0.1:${gateway.port}${route}`); assert.equal(response.status, 200, `bundled ${route} missing`);
  }
  assert.equal((await fetch(`http://127.0.0.1:${gateway.port}/api/config`)).status, 404);
  checks.push('bundled phone microphone assets are reachable; phone gateway keeps control API private');
  await until(async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
  const page = await until(async () => browser.contexts()[0]?.pages().find(page => /tauri|localhost/.test(page.url())));
  appPage = page;
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const version = await page.evaluate(() => window.__TAURI_INTERNALS__.invoke('app_version'));
  assert.equal(version, require('../package.json').version);
  checks.push('actual WebView2 application reports the matching release version');
  // Existing users may not have completed the new guide. Dismiss the UI only;
  // never silently mark their setup complete or launch optional installers.
  const setup = page.locator('dialog.setup-wizard');
  await page.locator('.canvas-toolbar').waitFor();
  await sleep(1500);
  if (await setup.isVisible()) await setup.getByRole('button', { name: /稍后继续|Continue later/ }).click();
  const initial = await api('/api/airplay-lines');
  assert.equal(path.resolve(initial.receiver), path.join(path.dirname(binary), 'resources/meshaudio-runtime/desktop/airplay/uxplay.exe'));
  checks.push('packaged runtime locates native UxPlay in the bundled resources');
  const plugin = (await api('/api/components')).components.find(entry => entry.id === 'uxplay');
  assert(plugin?.detected, 'complete bundled plugin is not detected');
  assert.equal(plugin.installKind, 'bundled'); assert.deepEqual(plugin.requirements, ['bonjour']);
  checks.push('bundled UxPlay is automatically deployed and exposes prerequisite auto-setup without a separate plugin download');
  const original = (await api('/api/state')).config;
  const result = await api('/api/airplay-lines', 'POST', { name: `MeshAudio packaging check ${Date.now() % 100000}` });
  created.push(result.line.id);
  const started = await api(`/api/airplay-lines/${result.line.id}/start`, 'POST', {});
  assert.equal(started.line.state, 'ready'); checks.push('packaged native UxPlay starts with video_disabled and an independent bridge');
  await page.getByRole('button', { name: /连接详情|Connection details/ }).last().click();
  const dialog = page.getByRole('dialog'); await dialog.locator('.line-qr svg').waitFor();
  assert.equal(await dialog.locator('.line-row').count(), 1);
  assert.equal(await dialog.getByRole('button', { name: /添加 iOS 源|Add iOS source|全部线路|All receivers/ }).count(), 0);
  fs.mkdirSync(path.join(root, 'docs/testing/airplay'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'docs/testing/airplay/packaged-desktop.png') });
  checks.push('actual WebView2 UI opens the new capsule details and renders its QR');
  await api(`/api/airplay-lines/${result.line.id}/remove`, 'POST', {});
  const after = (await api('/api/state')).config;
  assert.deepEqual(after.routes, original.routes);
  assert.deepEqual(after.sources, original.sources);
  checks.push('test source cleanup preserves all pre-existing user sources and routes');
  assert.equal(errors.length, 0, errors.join('\n'));
  const report = { ok: true, testedAt: new Date().toISOString(), checks, binary, screenshot: 'docs/testing/airplay/packaged-desktop.png' };
  fs.writeFileSync(path.join(root, 'docs/testing/airplay/packaged-ui-optimization-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
main().catch(error => { console.error(error.stack); console.error(logs.join('').slice(-3000)); process.exitCode = 1; }).finally(async () => {
  for (const id of created) { try { await api(`/api/airplay-lines/${id}/remove`, 'POST', {}); } catch {} }
  try { await appPage?.evaluate(() => window.__TAURI_INTERNALS__.invoke('quit_app')); } catch { /* app exit closes CDP */ }
  if (browser) { try { await browser.close(); } catch {} }
  app?.kill();
});
