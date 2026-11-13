'use strict';
// Export from explicit source roots, never archive the whole working directory.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const release = path.join(root, 'release');
const name = `MeshAudio-${version}`;
const destination = path.join(release, 'source', name);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const excluded = new Set(['.git', 'node_modules', 'target', 'dist', 'build', 'gen', '.DS_Store', 'Thumbs.db', 'Desktop.ini']);
const records = [];
function copy(relative, accept = () => true) {
  const from = path.join(root, relative);
  if (!fs.existsSync(from)) throw new Error('Required public source missing: ' + relative);
  function visit(file, rel) {
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink()) throw new Error('Review symbolic link before export: ' + rel);
    if (excluded.has(path.basename(file))) return;
    if (entry.isDirectory()) { for (const child of fs.readdirSync(file)) visit(path.join(file, child), rel + '/' + child); return; }
    if (!accept(rel)) return;
    if (/\.(?:exe|dll|lib|obj|log|wav|zip|pfx|p12|key|keystore|jks|apk|aab)$/i.test(rel) || /(?:^|\/)\.env(?:\.|$)/.test(rel)) throw new Error('Private/generated file in source export: ' + rel);
    const target = path.join(destination, rel); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(file, target);
    records.push({ path: rel.replaceAll('\\', '/'), bytes: entry.size, sha256: hash(file) });
  }
  visit(from, relative.replaceAll('\\', '/'));
}
function checkPublicTree() {
  for (const record of records) {
    if (!/\.(?:js|mjs|json|ts|vue|rs|toml|md|txt|yml|yaml|ps1|sh|html|css|patch|java|gradle|xml|properties)$/i.test(record.path) || record.path.startsWith('third_party/UxPlay/')) continue;
    const text = fs.readFileSync(path.join(destination, record.path), 'utf8');
    const normalized = text.replaceAll('\\\\', '\\').replaceAll('/', '\\').toLowerCase();
    if ([root, os.homedir()].some(privatePath => normalized.includes(privatePath.toLowerCase())) || /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_]{15,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)) throw new Error('Local path or secret-like content requires review: ' + record.path);
  }
}
function main() {
  if (!destination.startsWith(path.join(root, 'release', 'source') + path.sep)) throw new Error('Unsafe export destination');
  fs.mkdirSync(release, { recursive: true }); fs.rmSync(destination, { recursive: true, force: true });
  for (const file of ['.gitignore', '.gitattributes', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'SOURCE-NOTICE.txt', 'CONTRIBUTING.md', 'SECURITY.md', 'CLA.md', 'package.json', 'package-lock.json', 'server.js', 'app.js', 'index.html', 'styles.css', 'browser-node.html', 'browser-node.js']) copy(file);
  copy('.github/PULL_REQUEST_TEMPLATE.md');
  for (const folder of ['LICENSES', 'protocol', 'contributors', '.github/workflows', 'desktop-app/src', 'desktop-app/public', 'desktop-app/scripts', 'desktop-app/src-tauri/src', 'desktop-app/src-tauri/.cargo', 'desktop-app/src-tauri/icons', 'desktop-app/src-tauri/capabilities', 'third_party/UxPlay', 'third_party/bonjour/Include']) copy(folder);
  for (const folder of ['android/app/src', 'android/test-player/src', 'android/device-driver/src', 'android/gradle']) copy(folder);
  for (const file of ['README.md', 'settings.gradle', 'build.gradle', 'gradle.properties', 'gradlew', 'gradlew.bat', 'app/build.gradle', 'test-player/build.gradle', 'device-driver/build.gradle']) copy('android/' + file);
  for (const file of fs.readdirSync(path.join(root, 'desktop'))) if (/\.(?:js|json)$/.test(file)) copy('desktop/' + file);
  for (const file of fs.readdirSync(path.join(root, 'desktop/native'))) if (/\.(?:cpp|h|txt|md)$/.test(file)) copy('desktop/native/' + file);
  for (const file of ['desktop-app/package.json', 'desktop-app/package-lock.json', 'desktop-app/vite.config.ts', 'desktop-app/tsconfig.json', 'desktop-app/index.html', 'desktop-app/src-tauri/Cargo.toml', 'desktop-app/src-tauri/Cargo.lock', 'desktop-app/src-tauri/build.rs', 'desktop-app/src-tauri/tauri.conf.json', 'third_party/uxplay.lock.json', 'third_party/uxplay-meshaudio.patch', 'third_party/airplay-dependencies.lock.json']) copy(file);
  copy('tools', relative => /\.(?:js|ps1|sh)$/.test(relative) && !/\/(?:phase0-verify|verify-phase0|phase1-acceptance)\.ps1$/.test(relative));
  for (const file of ['PROJECT-OVERVIEW.md', 'LICENSING.md', 'PUBLIC-BUILD.md', 'WINDOWS-INSTALLATION.md', 'KNOWN-LIMITATIONS.md', 'THIRD-PARTY-SOURCES.md', 'RELEASE.md', 'ACCEPTANCE-0.3.0.md', 'ACCEPTANCE-0.3.1.md', 'ACCEPTANCE-ANDROID-0.3.1.md', 'ADR-007-native-airplay-lines.md', 'ADR-008-web-microphone-and-presence.md', 'ADR-009-observability-and-audio-isolation.md', 'ADR-010-interaction-installation-license.md', 'ARCHITECTURE.md', 'AIRPLAY-NATIVE.md', 'WEB-MICROPHONE.md']) copy('docs/' + file);
  checkPublicTree();
  fs.writeFileSync(path.join(destination, 'SOURCE-MANIFEST.json'), JSON.stringify({ version, generatedAt: new Date().toISOString(), files: records }, null, 2));
  const projectArchive = path.join(release, name + '-source.zip'); fs.rmSync(projectArchive, { force: true });
  execFileSync('tar.exe', ['-a', '-cf', projectArchive, '-C', path.dirname(destination), name], { windowsHide: true });
  const staging = path.join(release, 'third-party-staging');
  if (!staging.startsWith(release + path.sep)) throw new Error('Unsafe third-party staging path');
  fs.rmSync(staging, { recursive: true, force: true }); fs.mkdirSync(staging, { recursive: true });
  const sources = JSON.parse(fs.readFileSync(path.join(root, 'third_party/airplay-dependencies.lock.json')));
  if (!sources.completeSourceArchives) throw new Error('Complete dependency sources required');
  for (const source of sources.sources) {
    const file = path.join(root, 'desktop/airplay/sources', source.file);
    if (hash(file) !== source.sha256) throw new Error('Corresponding source hash mismatch: ' + source.file);
    fs.copyFileSync(file, path.join(staging, source.file));
  }
  for (const file of ['dependencies.json', 'README.txt', 'UxPlay-meshaudio-source.tar.gz']) fs.copyFileSync(path.join(root, 'desktop/airplay/sources', file), path.join(staging, file));
  fs.cpSync(path.join(root, 'desktop-app/src-tauri/resources/corresponding-source/rust'), path.join(staging, 'rust'), { recursive: true });
  const thirdPartyArchive = path.join(release, name + '-third-party-sources.tar.gz'); fs.rmSync(thirdPartyArchive, { force: true });
  execFileSync('tar.exe', ['-czf', thirdPartyArchive, '-C', staging, '.'], { windowsHide: true });
  fs.rmSync(staging, { recursive: true, force: true });
  const artifacts = [projectArchive, thirdPartyArchive, ...fs.readdirSync(release).filter(file => file.includes('_' + version + '_') && /\.(exe|msi)$/i.test(file)).map(file => path.join(release, file))];
  // Only the signed release APK is a public artifact; the debug build is an internal test package.
  const androidApk=path.join(release,'android',`MeshAudio-Android-${version}-release.apk`);
  if(fs.existsSync(androidApk)) artifacts.push(androidApk);
  else console.error('Note: no signed release APK found; debug APK is intentionally excluded from public artifacts.');
  fs.writeFileSync(path.join(release, 'SHA256SUMS.txt'), artifacts.map(file => `${hash(file)}  ${path.relative(release,file).replaceAll('\\','/')}`).join('\n') + '\n');
  console.log(JSON.stringify({ version, sourceDirectory: destination, sourceFiles: records.length, scans: ['explicit allowlist', 'generated/binary exclusions', 'local path and common secret patterns', 'dependency archive checksums'], artifacts: artifacts.map(file => ({ file, bytes: fs.statSync(file).size, sha256: hash(file) })) }, null, 2));
}
try { main(); } catch (error) { console.error(error); process.exitCode = 1; }
