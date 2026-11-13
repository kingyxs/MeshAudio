'use strict';
// Copy only the PE dependency closure of UxPlay and its audio plugins.
// No Qt launcher, video sink, Windows audio sink or system DLL is bundled.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const msys = path.resolve(process.env.MESHAUDIO_MSYS2 || path.join(root, '.build-tools/msys64'));
const bin = path.join(msys, 'ucrt64/bin');
const out = path.resolve(process.env.MESHAUDIO_UXPLAY_OUTPUT || path.join(root, 'desktop/airplay'));
const pluginDir = path.join(msys, 'ucrt64/lib/gstreamer-1.0');
const minimal = path.join(root, '.build-tools/minimal-codecs/prefix');
if (!fs.existsSync(path.join(minimal, 'lib/gstreamer-1.0/libgstlibav.dll'))) throw new Error('Build the AAC/ALAC-only codecs first: node tools/build-minimal-codecs.js');
const plugins = ['app', 'coreelements', 'libav', 'playback', 'autodetect', 'videoparsersbad', 'audioconvert', 'audioresample', 'volume', 'level', 'tcp', 'typefindfunctions'];
function msysPath(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}
function imports(file) {
  const data = fs.readFileSync(file);
  const pe = data.readUInt32LE(0x3c);
  if (data.toString('ascii', pe, pe + 4) !== 'PE\0\0') throw new Error(`Invalid PE: ${file}`);
  const opt = pe + 24;
  const dir = opt + (data.readUInt16LE(opt) === 0x20b ? 112 : 96);
  const sections = opt + data.readUInt16LE(pe + 20);
  function offset(rva) {
    for (let i = 0; i < data.readUInt16LE(pe + 6); i++) {
      const s = sections + i * 40;
      const va = data.readUInt32LE(s + 12);
      if (rva >= va && rva < va + Math.max(data.readUInt32LE(s + 8), data.readUInt32LE(s + 16))) return rva - va + data.readUInt32LE(s + 20);
    }
    throw new Error(`Invalid import RVA in ${file}`);
  }
  const rva = data.readUInt32LE(dir + 8);
  if (!rva) return [];
  const result = [];
  for (let at = offset(rva); data.readUInt32LE(at + 12); at += 20) {
    const name = offset(data.readUInt32LE(at + 12));
    result.push(data.toString('ascii', name, data.indexOf(0, name)));
  }
  return result;
}
fs.mkdirSync(path.join(out, 'lib/gstreamer-1.0'), { recursive: true });
const queue = [[path.join(msys, '../uxplay-build/uxplay.exe'), path.join(out, 'uxplay.exe')], ...plugins.map(name => [path.join(name === 'libav' ? path.join(minimal, 'lib/gstreamer-1.0') : pluginDir, `libgst${name}.dll`), path.join(out, 'lib/gstreamer-1.0', `libgst${name}.dll`)])];
const visited = new Set();
const files = new Set();
while (queue.length) {
  const [source, target] = queue.shift();
  if (visited.has(source.toLowerCase())) continue;
  visited.add(source.toLowerCase());
  if (!fs.existsSync(source)) throw new Error(`Required runtime file is missing: ${source}`);
  fs.copyFileSync(source, target);
  files.add(path.relative(out, target).replaceAll('\\', '/'));
  for (const name of imports(source)) {
    const candidate = fs.existsSync(path.join(minimal, 'bin', name)) ? path.join(minimal, 'bin', name) : path.join(bin, name);
    if (fs.existsSync(candidate)) queue.push([candidate, path.join(out, name)]);
  }
}
// Prune only stale .dll files from this generated runtime directory. This is
// intentionally bounded to the validated output path, never to a tool root.
for (const dir of [out, path.join(out, 'lib/gstreamer-1.0')]) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    if (/\.dll$/i.test(name) && !files.has(path.relative(out, file).replaceAll('\\', '/'))) fs.unlinkSync(file);
  }
}
fs.copyFileSync(path.join(root, 'third_party/UxPlay/LICENSE'), path.join(out, 'UXPLAY-LICENSE'));
const upstream = JSON.parse(fs.readFileSync(path.join(root, 'third_party/uxplay.lock.json'), 'utf8'));
const commit = upstream.commit;
const sourceDir = path.join(out, 'sources');
fs.mkdirSync(sourceDir, { recursive: true });
execFileSync(path.join(msys, 'usr/bin/tar.exe'), ['--exclude=.git', '--exclude=*.lib', '-czf', msysPath(path.join(sourceDir, 'UxPlay-meshaudio-source.tar.gz')), '-C', msysPath(path.join(root, 'third_party')), 'UxPlay', 'bonjour'], { windowsHide: true, env: { ...process.env, PATH: path.join(msys, 'usr/bin') + path.delimiter + process.env.PATH } });
const patch = fs.readFileSync(path.join(root, 'third_party/uxplay-meshaudio.patch'), 'utf8');
fs.writeFileSync(path.join(sourceDir, 'meshaudio.patch'), patch);
for (const name of ['build-uxplay.ps1', 'package-uxplay.js', 'build-minimal-codecs.js', 'build-minimal-codecs.sh', 'prepare-airplay-sources.js']) fs.copyFileSync(path.join(root, 'tools', name), path.join(sourceDir, name));
const packages = execFileSync(path.join(msys, 'usr/bin/pacman.exe'), ['-Q'], { encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(sourceDir, 'msys2-packages.txt'), packages);
const hashes = Object.fromEntries([...files].sort().map(file => [file, require('crypto').createHash('sha256').update(fs.readFileSync(path.join(out, file))).digest('hex')]));
fs.writeFileSync(path.join(out, 'build-info.json'), JSON.stringify({ upstream: 'https://github.com/antimof/UxPlay', commit, version: '1.73.6', modified: Boolean(patch), codecProfile: 'aac-alac-only', plugins, files: [...files].sort(), sha256: hashes, dependencies: 'sources/dependencies.json', source: 'sources/UxPlay-meshaudio-source.tar.gz' }, null, 2));
console.log(`Packaged ${files.size} runtime files (${Math.round([...files].reduce((sum, file) => sum + fs.statSync(path.join(out, file)).size, 0) / 1024 / 1024)} MiB)`);
