'use strict';
// Codec sources are pinned complete MSYS2 source packages, not executable
// package recipes. Build only upstream code; no bundled video/AI encoders.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const msys = path.resolve(process.env.MESHAUDIO_MSYS2 || path.join(root, '.build-tools/msys64'));
const sources = [
  ['mingw-w64-ffmpeg-9.0.2-3.src.tar.zst', 'b1ae15944aac72df605c7a87650f65cf778acb595f0bb2ece80c3228979f1e56'],
  ['mingw-w64-gst-libav-1.28.9-1.src.tar.zst', '4bacd1fc0011c17be3abbefe4b6d5b5050eec097e38e4d15092c4d4d275a1ea3']
];
function msysPath(p) { return path.resolve(p).replaceAll('\\', '/').replace(/^([A-Za-z]):/, (_, drive) => '/' + drive.toLowerCase()); }
async function main() {
  const dir = path.join(root, '.build-tools/minimal-codecs/sources'); fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, PATH: [path.join(msys, 'ucrt64/bin'), path.join(msys, 'usr/bin'), process.env.PATH].join(path.delimiter), MSYSTEM: 'UCRT64' };
  for (const [file, sha] of sources) {
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) { const response = await fetch('https://repo.msys2.org/mingw/sources/' + file, { signal: AbortSignal.timeout(180000) }); if (!response.ok) throw new Error(`source HTTP ${response.status}`); fs.writeFileSync(target, Buffer.from(await response.arrayBuffer())); }
    if (crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== sha) throw new Error('Source hash mismatch: ' + file);
    const result = spawnSync(path.join(msys, 'usr/bin/tar.exe'), ['--zstd', '-xf', msysPath(target), '-C', msysPath(dir)], { env, stdio: 'inherit', windowsHide: true });
    if (result.status !== 0) throw new Error('Source extraction failed');
  }
  const result = spawnSync(path.join(msys, 'usr/bin/bash.exe'), [msysPath(path.join(root, 'tools/build-minimal-codecs.sh'))], { env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) throw new Error('Minimal codec build failed');
  fs.writeFileSync(path.join(root, '.build-tools/minimal-codecs/build-info.json'), JSON.stringify({ profile: 'aac-alac-only', ffmpeg: '9.0.2', gstLibav: '1.28.9', sources: sources.map(([file, sha256]) => ({ file, sha256, url: 'https://repo.msys2.org/mingw/sources/' + file })), config: 'tools/build-minimal-codecs.sh', modifiedUpstream: false }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
