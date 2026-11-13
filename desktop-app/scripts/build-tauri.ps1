[CmdletBinding()]
param(
  [ValidateSet('debug', 'release')]
  [string]$Mode = 'debug'
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw "vswhere.exe not found" }
$vsInstall = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if ([string]::IsNullOrWhiteSpace($vsInstall)) { throw 'Visual Studio C++ tools not found' }
$vsDevCmd = Join-Path $vsInstall 'Common7\Tools\VsDevCmd.bat'
if (-not (Test-Path $vsDevCmd)) { throw "VsDevCmd.bat not found: $vsDevCmd" }
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$cargo = Join-Path $cargoBin 'cargo.exe'
if (-not (Test-Path $cargo)) { throw "Cargo not found: $cargo. Install Rustup stable MSVC first." }

$envOutput = & $env:ComSpec /d /s /c "call `"$vsDevCmd`" -no_logo -arch=x64 >nul && set"
foreach ($line in $envOutput) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) {
    [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process')
  }
}
$env:Path = "$cargoBin;$env:Path"

Push-Location $root
try {
  & npm run prepare:resources
  if ($LASTEXITCODE -ne 0) { throw "Resource preparation failed: $LASTEXITCODE" }
  & $cargo metadata --no-deps --format-version 1 --manifest-path (Join-Path $root 'src-tauri\Cargo.toml') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Cargo metadata failed: $LASTEXITCODE" }
  $args = @('tauri', 'build')
  if ($Mode -eq 'debug') { $args += '--debug' }
  & npx @args
  if ($LASTEXITCODE -ne 0) { throw "Tauri build failed: $LASTEXITCODE" }
} finally {
  Pop-Location
}
