import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const repo = resolve(root, '..')
const target = join(root, 'src-tauri', 'resources')
if (process.platform !== 'win32') throw new Error('The self-contained desktop package requires Windows x64 Node.js')
const airplay = join(repo, 'desktop', 'airplay')
const info = JSON.parse(await readFile(join(airplay, 'build-info.json'), 'utf8'))
if (info.codecProfile !== 'aac-alac-only') throw new Error('Build the minimal AAC/ALAC codec profile before packaging')
for (const file of info.files) {
  const source = resolve(airplay, file)
  if (!source.startsWith(airplay + sep)) throw new Error('Unsafe AirPlay resource path')
  const digest = createHash('sha256').update(await readFile(source)).digest('hex')
  if (digest !== info.sha256[file]) throw new Error(`AirPlay checksum mismatch: ${file}`)
}
const sources = JSON.parse(await readFile(join(airplay, 'sources', 'dependencies.json'), 'utf8'))
if (!sources.completeSourceArchives) throw new Error('Prepare corresponding third-party sources before release')
await stat(join(repo, 'desktop/native/build/meshaudio-native.exe'))
await stat(join(airplay, 'sources/UxPlay-meshaudio-source.tar.gz'))
execFileSync(process.execPath, [join(repo, 'tools/prepare-license-notices.js')], { cwd: repo, stdio: 'inherit', windowsHide: true })
await mkdir(target, { recursive: true })
// Remove only generated runtime copies; never touch profiles or source inputs.
for (const folder of ['desktop', 'protocol']) {
  const generated = resolve(target, folder)
  if (!generated.startsWith(target + sep)) throw new Error('Unsafe resource output path')
  await rm(generated, { recursive: true, force: true })
}
const files = ['server.js', 'browser-node.html', 'browser-node.js',
  'desktop/audio-engine.js', 'desktop/native-bridge.js', 'desktop/engine-output.js',
  'desktop/component-manager.js', 'desktop/components.manifest.json',
  'desktop/airplay-bridge.js', 'desktop/airplay-manager.js',
  'desktop/web-microphone-gateway.js', 'desktop/network-addresses.js',
  'desktop/native/build/meshaudio-native.exe',
  ...info.files.map(file => 'desktop/airplay/' + file),
  'desktop/airplay/UXPLAY-LICENSE', 'desktop/airplay/build-info.json',
  'desktop/airplay/sources/UxPlay-meshaudio-source.tar.gz',
  'desktop/airplay/sources/dependencies.json']
for (const file of files) {
  await mkdir(resolve(target, file, '..'), { recursive: true })
  await cp(join(repo, file), join(target, file))
}
await cp(join(airplay, 'licenses'), join(target, 'desktop/airplay/licenses'), { recursive: true })
await writeFile(join(target, 'package.json'), '{"type":"commonjs"}\n', 'utf8')
await cp(process.execPath, join(target, 'node.exe'))
console.log(`Bundled Node runtime: ${process.version}`)
console.log(`Prepared sidecar resources under ${target}`)
