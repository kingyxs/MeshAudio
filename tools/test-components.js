'use strict';

/**
 * Component manager regression test.
 *
 * It exercises the real download path against the publisher URL in
 * desktop/components.manifest.json, so it needs network access. Installer
 * launching is deliberately not tested: it raises a UAC prompt and cannot run
 * unattended.
 *
 * Usage: node tools/test-components.js [--skip-download]
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createComponentManager } = require('../desktop/component-manager');

const manifestPath = path.join(__dirname, '..', 'desktop', 'components.manifest.json');
const skipDownload = process.argv.includes('--skip-download');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectError(fn, expected) {
  try {
    await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `expected "${expected}", got "${message}"`);
    return message;
  }
  throw new Error(`expected failure containing "${expected}", but it resolved`);
}

async function waitForPhase(manager, id, phases, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const component = manager.list().find(item => item.id === id);
    if (component && phases.includes(component.progress.phase)) return component;
    if (component && component.progress.phase === 'error') {
      throw new Error(`download failed: ${component.progress.error}`);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`timed out waiting for ${id} to reach ${phases.join('/')}`);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meshaudio-components-'));
  const manager = createComponentManager({
    dataDir,
    manifestPath,
    detect: () => ({ detected: false, detail: '' }),
    log: () => {}
  });

  try {
    const initial = manager.list();
    const ids = initial.map(item => item.id);
    assert(ids.includes('vb-cable'), 'vb-cable missing from manifest');
    assert(ids.includes('uxplay'), 'uxplay missing from manifest');

    const vb = initial.find(item => item.id === 'vb-cable');
    assert(vb.download && vb.download.url, 'vb-cable has no download source');
    assert(vb.installKind === 'zip-launch', `unexpected install kind: ${vb.installKind}`);

    const uxplay = initial.find(item => item.id === 'uxplay');
    assert(uxplay.installKind === 'bundled', `unexpected uxplay install kind: ${uxplay.installKind}`);
    assert(uxplay.download === null, 'legacy wrapper download must not be offered');
    assert(uxplay.canLaunch === false, 'receiver must only be launched by the line manager');
    assert(uxplay.needsRestart === false, 'uxplay must not require a reboot');

    const errors = {
      unknownComponent: await expectError(() => manager.action('nope', 'download', {}), 'unknown_component'),
      uxplayNotDownloaded: await expectError(() => manager.action('uxplay', 'install', {}), 'bundled_component_managed_by_airplay_lines'),
      uxplayNotInstalled: await expectError(() => manager.action('uxplay', 'launch', {}), 'use_canvas_airplay_lines'),
      uxplayRemoveBlocked: await expectError(() => manager.action('uxplay', 'remove', {}), 'bundled_component_managed_by_airplay_lines'),
      vbNotDownloaded: await expectError(() => manager.action('vb-cable', 'install', {}), 'not_downloaded'),
      missingFile: await expectError(() => manager.action('vb-cable', 'install-local', { path: 'C:/nope/setup.exe' }), 'file_not_found')
    };

    let downloaded = null;
    if (!skipDownload) {
      manager.action('vb-cable', 'download', {});
      downloaded = await waitForPhase(manager, 'vb-cable', ['downloaded']);
      assert(downloaded.downloadedBytes > 500000, `suspiciously small download: ${downloaded.downloadedBytes}`);
      assert(typeof downloaded.sha256 === 'string' && downloaded.sha256.length === 64, 'sha256 not recorded');
      assert(fs.existsSync(path.join(dataDir, 'components', 'downloads', downloaded.download.filename)), 'downloaded file missing');
    }

    manager.action('vb-cable', 'remove', {});
    const afterRemove = manager.list().find(item => item.id === 'vb-cable');
    assert(afterRemove.installedByApp === false, 'remove did not clear installed state');

    console.log(JSON.stringify({
      ok: true,
      components: initial.map(item => ({
        id: item.id,
        installKind: item.installKind,
        hasDownload: Boolean(item.download),
        needsRestart: item.needsRestart
      })),
      errors,
      download: downloaded ? {
        bytes: downloaded.downloadedBytes,
        sha256: downloaded.sha256.slice(0, 16),
        file: downloaded.download.filename
      } : 'skipped'
    }, null, 2));
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exit(1);
});
