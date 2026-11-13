'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'desktop-app/src-tauri/resources/licenses');
function notices(dir, target) {
  if (!fs.existsSync(dir)) return 0;
  let count = 0;
  for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!/^(licen[cs]e|copying|notice|copyright)(?:[._-]|s?$)/i.test(file.name)) continue;
    fs.mkdirSync(target, { recursive: true }); fs.cpSync(path.join(dir, file.name), path.join(target, file.name), { recursive: true }); count++;
  }
  return count;
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(root, 'LICENSES/standard'), path.join(out, 'standard'), { recursive: true });
  const records = [];
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'desktop-app/package-lock.json')));
  for (const [name, value] of Object.entries(lock.packages)) {
    if (!name || value.dev) continue;
    const id = name.replace(/^node_modules\//, '');
    let count = notices(path.join(root, 'desktop-app', name), path.join(out, 'npm', id));
    if (!count && id === '@vue/devtools-api') { fs.mkdirSync(path.join(out, 'npm', id), { recursive: true }); fs.copyFileSync(path.join(root, 'LICENSES/vue-devtools-MIT.txt'), path.join(out, 'npm', id, 'LICENSE')); count = 1; }
    if (!count) throw new Error('Missing npm notice: ' + id);
    records.push({ type: 'npm', name: id, version: value.version, license: value.license });
  }
  const tree = execFileSync('cargo', ['tree', '--locked', '--target', 'x86_64-pc-windows-msvc', '--prefix', 'none', '--format', '{p}'], { cwd: path.join(root, 'desktop-app/src-tauri'), encoding: 'utf8', windowsHide: true });
  const cache = path.join(process.env.CARGO_HOME || path.join(os.homedir(), '.cargo'), 'registry/src');
  const registries = fs.readdirSync(cache).map(name => path.join(cache, name));
  const seen = new Set();
  for (const match of tree.matchAll(/^([\w-]+) v([^\s]+).*$/gm)) {
    const [, name, version] = match; const id = name + '-' + version; if (name === 'meshaudio-desktop' || seen.has(id)) continue; seen.add(id);
    const source = registries.map(dir => path.join(dir, id)).find(p => fs.existsSync(p)); if (!source) throw new Error('Missing Rust source notice: ' + id);
    const toml = fs.readFileSync(path.join(source, 'Cargo.toml'), 'utf8'); const license = toml.match(/^license = "([^"]+)"/m)?.[1] || '';
    const count = notices(source, path.join(out, 'rust', id));
    if (!count) {
      // Some crates declare only SPDX; retain that exact declaration and the
      // full matching standard licence texts instead of inventing copyright.
      fs.mkdirSync(path.join(out, 'rust', id), { recursive: true });
      fs.copyFileSync(path.join(source, 'Cargo.toml'), path.join(out, 'rust', id, 'Cargo.toml'));
      if (!license || !/MIT|Apache-2.0|BSD|ISC|Zlib|Unicode|BSL|Unlicense|CC0|MPL-2.0/.test(license)) throw new Error('Review Rust licence manually: ' + id + ' ' + license);
    }
    if (license.includes('MPL-2.0')) {
      const registry = path.basename(path.dirname(source));
      const archive = path.join(path.dirname(cache), 'cache', registry, id + '.crate');
      const destination = path.join(root, 'desktop-app/src-tauri/resources/corresponding-source/rust');
      fs.mkdirSync(destination, { recursive: true });
      fs.copyFileSync(archive, path.join(destination, id + '.crate'));
    }
    records.push({ type: 'cargo', name, version, license, source: `https://crates.io/crates/${name}/${version}` });
  }
  const nodeVersion = process.version;
  const nodeNotice = path.join(out, 'Node.js-LICENSE.txt');
  let previous = {}; try { previous = JSON.parse(fs.readFileSync(path.join(out, 'inventory.json'))); } catch {}
  if (previous.nodeVersion !== nodeVersion || !fs.existsSync(nodeNotice)) {
    const response = await fetch(`https://raw.githubusercontent.com/nodejs/node/${nodeVersion}/LICENSE`, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('Node licence unavailable for ' + nodeVersion);
    const nodeLicense = await response.text(); if (!nodeLicense.includes('Node.js') || nodeLicense.length < 10000) throw new Error('Incomplete Node licence');
    fs.writeFileSync(nodeNotice, nodeLicense);
  }
  records.push({ type: 'runtime', name: 'Node.js', version: nodeVersion, license: 'MIT plus bundled third-party notices' });
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'MeshAudio-GPL-3.0.txt'));
  fs.copyFileSync(path.join(root, 'LICENSES/MeshAudio-original-MIT.txt'), path.join(out, 'MeshAudio-original-MIT.txt'));
  fs.copyFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), path.join(out, 'THIRD-PARTY-NOTICES.md'));
  fs.copyFileSync(path.join(root, 'LICENSES/qrcode-generator-MIT.txt'), path.join(out, 'qrcode-generator-MIT.txt'));
  fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify({ nodeVersion, records }, null, 2));
  console.log(`Collected notices for ${records.length} npm/Rust/runtime records`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
