param(
  [string]$MsysRoot = "$PSScriptRoot/../.build-tools/msys64",
  [string]$Source = "$PSScriptRoot/../third_party/UxPlay",
  [string]$Output = "$PSScriptRoot/../desktop/airplay"
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $MsysRoot).Path
$src = (Resolve-Path $Source).Path
$out = [IO.Path]::GetFullPath($Output)
$env:PATH = "$root/ucrt64/bin;$root/usr/bin;$env:PATH"
$env:BONJOUR_SDK_HOME = (Resolve-Path (Join-Path $PSScriptRoot '../third_party/bonjour')).Path
$build = Join-Path $root '../uxplay-build'
# Build an import library from public Bonjour exports on this machine. The
# proprietary runtime DLL is neither copied nor redistributed by this script.
$import = Join-Path $env:BONJOUR_SDK_HOME 'Lib/x64/dnssd.lib'
if (!(Test-Path -LiteralPath $import)) {
  $dll = Join-Path $env:WINDIR 'System32/dnssd.dll'
  if (!(Test-Path -LiteralPath $dll)) { throw 'Install Apple Bonjour before building AirPlay.' }
  New-Item -ItemType Directory -Force (Split-Path $import) | Out-Null
  $definition = Join-Path $env:BONJOUR_SDK_HOME 'dnssd.def'
  & gendef $dll '-' | Set-Content -LiteralPath $definition -Encoding ascii
  if ($LASTEXITCODE -ne 0) { throw 'Bonjour export scan failed' }
  & dlltool --dllname dnssd.dll --def $definition --output-lib $import
  if ($LASTEXITCODE -ne 0) { throw 'Bonjour import library generation failed' }
}
cmake -S $src -B $build -G Ninja -DNO_MARCH_NATIVE=ON -DNO_X11_DEPS=ON
if ($LASTEXITCODE -ne 0) { throw 'UxPlay configure failed' }
cmake --build $build --parallel
if ($LASTEXITCODE -ne 0) { throw 'UxPlay build failed' }
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $build 'uxplay.exe') (Join-Path $out 'uxplay.exe') -Force
# Keep runtime delivery deterministic: UxPlay is started with this directory
# as cwd, so GStreamer can discover the bundled plugins.
$env:MESHAUDIO_MSYS2 = $root
$env:MESHAUDIO_UXPLAY_OUTPUT = $out
node (Join-Path $PSScriptRoot 'package-uxplay.js')
if ($LASTEXITCODE -ne 0) { throw 'UxPlay packaging failed' }
Copy-Item (Join-Path $src 'LICENSE') (Join-Path $out 'UXPLAY-LICENSE') -Force
Write-Host "Built headless UxPlay at $out"
