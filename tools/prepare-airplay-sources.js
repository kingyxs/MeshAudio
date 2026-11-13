'use strict';
// Collect exact corresponding source archives for the actual PE closure.
// Official MSYS2 *.src.tar.* packages contain upstream sources + recipes/patches.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const msys = path.resolve(process.env.MESHAUDIO_MSYS2 || path.join(root, '.build-tools/msys64'));
const out = path.resolve(process.env.MESHAUDIO_UXPLAY_OUTPUT || path.join(root, 'desktop/airplay'));
const cache = path.join(root, '.build-tools/third-party-sources');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function field(desc, name) { return desc.match(new RegExp('%' + name + '%\\n([\\s\\S]*?)(?:\\n\\n|$)'))?.[1].trim() || ''; }
async function main() {
  const info = JSON.parse(fs.readFileSync(path.join(out, 'build-info.json')));
  if (info.codecProfile !== 'aac-alac-only') throw new Error('Only the minimal codec profile is approved for release');
  const db = path.join(msys, 'var/lib/pacman/local');
  const owned = new Set(); const packages = [];
  for (const name of fs.readdirSync(db)) {
    const dir = path.join(db, name); if (!fs.existsSync(path.join(dir, 'files'))) continue;
    const fileList = fs.readFileSync(path.join(dir, 'files'), 'utf8').split('\n');
    const set = new Set(fileList);
    const files = info.files.filter(f => set.has('ucrt64/' + (f.startsWith('lib/') ? f : 'bin/' + f)));
    if (!files.length) continue;
    for (const file of files) owned.add(file);
    const desc = fs.readFileSync(path.join(dir, 'desc'), 'utf8');
    packages.push({ name: field(desc, 'NAME'), base: field(desc, 'BASE'), version: field(desc, 'VERSION'), license: field(desc, 'LICENSE'), homepage: field(desc, 'URL'), files, licenceFiles: fileList.filter(f => /^ucrt64\/share\/licenses\/.+/.test(f) && fs.existsSync(path.join(msys, f)) && fs.statSync(path.join(msys, f)).isFile()) });
  }
  const missing = info.files.filter(f => f !== 'uxplay.exe' && !owned.has(f)); if (missing.length) throw new Error('Unknown binary ownership: ' + missing.join(', '));
  const sourceDir = path.join(out, 'sources'), licenses = path.join(out, 'licenses');
  fs.mkdirSync(cache, { recursive: true });
  // This is a generated, narrowly scoped output directory; remove stale notices
  // from the earlier full-codec runtime before collecting the actual closure.
  if (!licenses.startsWith(out + path.sep)) throw new Error('Invalid notice output directory');
  fs.rmSync(licenses, { recursive: true, force: true }); fs.mkdirSync(licenses, { recursive: true });
  const response = await fetch('https://repo.msys2.org/mingw/sources/', { signal: AbortSignal.timeout(60000) }); if (!response.ok) throw new Error('MSYS2 source index unavailable');
  const index = await response.text();
  const sourceFiles = [...index.matchAll(/href="([^"/]+\.src\.tar\.(?:zst|xz|gz))"/g)].map(m => m[1]);
  const sources = new Map();
  for (const pkg of packages) {
    if (pkg.base === 'mingw-w64-ffmpeg') { pkg.referencePackageLicense = pkg.license; pkg.license = 'LGPL-2.1-or-later (custom AAC/ALAC-only build; GPL/nonfree disabled)'; pkg.customBuild = 'tools/build-minimal-codecs.sh'; }
    // GCC's Runtime Library Exception permits use/distribution of its
    // unmodified support libraries without publishing the compiler source.
    const runtimeException = pkg.base === 'mingw-w64-gcc';
    const version = pkg.version.replace(/^\d+~/, '');
    const filename = sourceFiles.find(f => f.startsWith(`${pkg.base}-${version}.src.tar.`));
    if (!filename && !runtimeException) throw new Error(`Exact source unavailable: ${pkg.base} ${pkg.version}`);
    if (filename && !runtimeException) sources.set(filename, { file: filename, url: 'https://repo.msys2.org/mingw/sources/' + filename });
    pkg.source = filename && !runtimeException ? filename : null;
    pkg.exception = runtimeException ? 'GCC-exception-3.1 (runtime libraries only)' : null;
    for (const licence of pkg.licenceFiles) {
      const dest = path.join(licenses, licence.replace(/^ucrt64\/share\/licenses\//, '')); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(msys, licence), dest);
    }
    delete pkg.licenceFiles;
  }
  // Custom minimal builds use these exact source packages with our build script.
  for (const source of JSON.parse(fs.readFileSync(path.join(root, '.build-tools/minimal-codecs/build-info.json'))).sources) sources.set(source.file, source);
  const sourceList = [...sources.values()]; let cursor = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (cursor < sourceList.length) {
      const source = sourceList[cursor++]; const dest = path.join(cache, source.file);
      if (!fs.existsSync(dest)) {
        const res = await fetch(source.url, { signal: AbortSignal.timeout(240000) }); if (!res.ok) throw new Error(`${source.file}: HTTP ${res.status}`);
        fs.writeFileSync(dest + '.part', Buffer.from(await res.arrayBuffer())); fs.renameSync(dest + '.part', dest);
      }
      const digest = sha(dest); if (source.sha256 && source.sha256 !== digest) throw new Error('Source checksum mismatch: ' + source.file);
      source.sha256 = digest; source.bytes = fs.statSync(dest).size;
      fs.copyFileSync(dest, path.join(sourceDir, source.file));
      console.log(`Source ready: ${source.file}`);
    }
  }));
  for (const [name, file] of [['FFmpeg-LGPL-2.1.txt', '.build-tools/minimal-codecs/ffmpeg-9.0.2/COPYING.LGPLv2.1'], ['FFmpeg-LGPL-3.txt', '.build-tools/minimal-codecs/ffmpeg-9.0.2/COPYING.LGPLv3'], ['gst-libav-COPYING.txt', '.build-tools/minimal-codecs/gst-libav-1.28.9/COPYING']]) fs.copyFileSync(path.join(root, file), path.join(licenses, name));
  const metadata = { profile: info.codecProfile, packages, sources: sourceList, customBuild: 'tools/build-minimal-codecs.sh', completeSourceArchives: true };
  fs.writeFileSync(path.join(sourceDir, 'dependencies.json'), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'msys2-packages.txt'), packages.map(pkg => pkg.name + ' ' + pkg.version).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'third_party/airplay-dependencies.lock.json'), JSON.stringify(metadata, null, 2));
  fs.writeFileSync(path.join(sourceDir, 'README.txt'), 'Corresponding source archives for the exact binaries in build-info.json.\nExtract each .src.tar.* to obtain upstream source archives, PKGBUILD and distribution patches.\nUxPlay changes are in UxPlay-meshaudio-source.tar.gz and meshaudio.patch.\nCustom FFmpeg/gst-libav flags: build-minimal-codecs.sh (only AAC/ALAC decoders).\nBuild instructions: docs/PUBLIC-BUILD.md and docs/THIRD-PARTY-SOURCES.md in the matching MeshAudio source release.\nGCC support DLLs use GCC Runtime Library Exception 3.1; the compiler is not bundled.\n');
  console.log(`Prepared ${packages.length} runtime package records and ${sourceList.length} complete source archives`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
