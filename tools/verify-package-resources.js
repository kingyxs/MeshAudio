'use strict';
// Verify an extracted NSIS payload (does not run installers or alter a profile).
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const app = path.resolve(process.argv[2] || path.join(root, `.build-tools/nsis-${require('../package.json').version}-extracted`));
const runtime = path.join(app, 'resources/meshaudio-runtime');
const airplay = path.join(runtime, 'desktop/airplay');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function desktopHash(file) {
  const data = fs.readFileSync(file), marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_');
  // Earlier occurrences are comparison constants (MSI/NSS); the final marker
  // is the application bundle value rewritten by the bundler.
  const at = data.lastIndexOf(marker);
  assert(at >= 0, 'expected a Tauri bundle marker');
  const value = at + marker.length;
  assert(['UNK', 'NSS'].includes(data.toString('ascii', value, value + 3)), 'unexpected Tauri bundle type');
  // Tauri patches only UNK → NSS when embedding the EXE in an NSIS bundle.
  // Normalize precisely those three bytes; all other bytes must still match.
  data.write('UNK', value, 'ascii');
  return crypto.createHash('sha256').update(data).digest('hex');
}
function imports(file) {
  const data = fs.readFileSync(file), pe = data.readUInt32LE(0x3c), opt = pe + 24;
  assert.equal(data.toString('ascii', pe, pe + 4), 'PE\0\0');
  const directory = opt + (data.readUInt16LE(opt) === 0x20b ? 112 : 96), sections = opt + data.readUInt16LE(pe + 20);
  function offset(rva) {
    for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
      const s = sections + i * 40, va = data.readUInt32LE(s + 12);
      if (rva >= va && rva < va + Math.max(data.readUInt32LE(s + 8), data.readUInt32LE(s + 16))) return rva - va + data.readUInt32LE(s + 20);
    }
    throw new Error('Invalid PE import RVA: ' + file);
  }
  const rva = data.readUInt32LE(directory + 8); if (!rva) return [];
  const names = [];
  for (let at = offset(rva); data.readUInt32LE(at + 12); at += 20) { const start = offset(data.readUInt32LE(at + 12)); names.push(data.toString('ascii', start, data.indexOf(0, start))); }
  return names;
}
function walk(dir) { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]); }
const checks = [];
try {
  for (const file of ['node.exe', 'server.js', 'package.json', 'browser-node.html', 'browser-node.js', 'desktop/native/build/meshaudio-native.exe', 'desktop/component-manager.js', 'desktop/components.manifest.json', 'desktop/airplay-manager.js', 'desktop/airplay-bridge.js', 'desktop/web-microphone-gateway.js']) assert(fs.statSync(path.join(runtime, file)).isFile(), file);
  assert.equal(JSON.parse(fs.readFileSync(path.join(runtime, 'package.json'))).type, 'commonjs');
  const native = path.join(runtime, 'desktop/native/build/meshaudio-native.exe');
  assert.equal(sha(native), sha(path.join(root, 'desktop/native/build/meshaudio-native.exe')), 'stale native engine in package');
  assert.equal(desktopHash(path.join(app, 'meshaudio-desktop.exe')), desktopHash(path.join(root, 'desktop-app/src-tauri/target/release/meshaudio-desktop.exe')), 'stale desktop executable');
  assert.equal(sha(path.join(runtime, 'node.exe')), sha(process.execPath), 'incorrect Node runtime');
  assert(!execFileSync(native, ['--help'], { encoding: 'utf8', windowsHide: true }).includes('--set-default'));
  checks.push('application, bundled Node, native engine, component manager and phone assets are present');
  const expected = JSON.parse(fs.readFileSync(path.join(root, 'desktop/airplay/build-info.json')));
  const actual = JSON.parse(fs.readFileSync(path.join(airplay, 'build-info.json')));
  assert.deepEqual(actual, expected); assert.equal(actual.codecProfile, 'aac-alac-only');
  for (const file of actual.files) assert.equal(sha(path.join(airplay, file)), actual.sha256[file], file);
  const dlls = walk(airplay).filter(file => /\.(dll|exe)$/i.test(file)).map(file => path.relative(airplay, file).replaceAll('\\', '/')).sort();
  assert.deepEqual(dlls, [...actual.files].sort());
  checks.push(`exact minimal AirPlay closure matches all ${actual.files.length} checksums; no stale/video-wrapper DLLs`);
  for (const file of [path.join(app, 'meshaudio-desktop.exe'), path.join(runtime, 'desktop/native/build/meshaudio-native.exe'), path.join(runtime, 'node.exe')]) assert(!imports(file).some(name => /^(vcruntime|msvcp|concrt)/i.test(name)), 'separate VC runtime required: ' + file);
  checks.push('desktop application, Node and native engine have no direct VC redistributable DLL dependency');
  const all = walk(app);
  assert(!all.some(file => {
    const relative = path.relative(app, file).replaceAll('\\', '/');
    // Nested npm packages retain their attribution path inside licences only.
    return /\.(?:src\.tar\.(?:zst|xz)|pfx|p12|wav|log)$/i.test(relative) || /(?:^|\/)(?:\.git|data)(?:\/|$)/.test(relative) || (!relative.startsWith('licenses/') && /(?:^|\/)node_modules(?:\/|$)/.test(relative));
  }));
  for (const file of ['SOURCE-NOTICE.txt', 'licenses/inventory.json', 'licenses/Node.js-LICENSE.txt', 'licenses/MeshAudio-GPL-3.0.txt', 'licenses/THIRD-PARTY-NOTICES.md', 'resources/meshaudio-runtime/desktop/airplay/UXPLAY-LICENSE', 'resources/meshaudio-runtime/desktop/airplay/sources/UxPlay-meshaudio-source.tar.gz']) assert(fs.statSync(path.join(app, file)).size > 0, file);
  assert(!all.some(file => /(?:VBCABLE.*\.(?:zip|exe)|BonjourPSSetup\.exe|dnssd\.dll)$/i.test(path.basename(file))));
  checks.push('licences and source notice included; no proprietary installers, user data, test audio or full source archives inside application payload');
  const report = { ok: true, testedAt: new Date().toISOString(), version: require('../package.json').version, checks, bytes: all.reduce((sum, file) => sum + fs.statSync(file).size, 0), extractedPayload: app, notTested: ['Windows system installation/UAC/restart', 'physical iPhone playback'] };
  fs.mkdirSync(path.join(root, 'docs/testing/release'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/testing/release/package-resources-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
