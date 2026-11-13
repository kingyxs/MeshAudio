[CmdletBinding()]
param(
  [string]$BuildDir,
  [string]$CMakePath,
  [string]$VsDevCmdPath,
  [ValidateSet("x64", "x86", "arm64")]
  [string]$Architecture = "x64",
  [ValidateSet("Debug", "Release", "RelWithDebInfo", "MinSizeRel")]
  [string]$Configuration = "Release"
)

$ErrorActionPreference = "Stop"
$nativeDir = (Resolve-Path (Join-Path $PSScriptRoot "..\desktop\native")).Path
if ([string]::IsNullOrWhiteSpace($BuildDir)) {
  $BuildDir = Join-Path $nativeDir "build"
}
$BuildDir = [System.IO.Path]::GetFullPath($BuildDir)

if ([string]::IsNullOrWhiteSpace($VsDevCmdPath)) {
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vswhere)) {
    throw "vswhere.exe was not found. Pass -VsDevCmdPath with an absolute VsDevCmd.bat path."
  }
  $vsInstall = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vsInstall)) {
    throw "Visual Studio C++ build tools were not found. Install the Desktop development with C++ workload."
  }
  $VsDevCmdPath = Join-Path $vsInstall "Common7\Tools\VsDevCmd.bat"
}
if (-not (Test-Path $VsDevCmdPath)) {
  throw "VsDevCmd.bat was not found at '$VsDevCmdPath'. Pass its absolute path with -VsDevCmdPath."
}

if ([string]::IsNullOrWhiteSpace($CMakePath)) {
  $vsRoot = Split-Path (Split-Path (Split-Path $VsDevCmdPath -Parent) -Parent) -Parent
  $bundledCMake = Join-Path $vsRoot "Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
  if (Test-Path $bundledCMake) {
    $CMakePath = $bundledCMake
  } else {
    $cmakeCommand = Get-Command cmake.exe -ErrorAction SilentlyContinue
    if ($null -eq $cmakeCommand) {
      throw "CMake was not found. Pass -CMakePath with an absolute cmake.exe path."
    }
    $CMakePath = $cmakeCommand.Source
  }
}
if (-not (Test-Path $CMakePath)) {
  throw "CMake was not found at '$CMakePath'. Pass -CMakePath with an absolute path."
}

$windowsKits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\Include"
$sdk = Get-ChildItem $windowsKits -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
  Sort-Object { [version]$_.Name } -Descending |
  Select-Object -First 1
if ($null -eq $sdk) {
  throw "Windows 10/11 SDK headers were not found under '$windowsKits'."
}

$devCommand = "`"$VsDevCmdPath`" -no_logo -arch=$Architecture >nul && set"
$environmentOutput = & $env:ComSpec /d /s /c $devCommand
if ($LASTEXITCODE -ne 0) {
  throw "VsDevCmd.bat failed with exit code $LASTEXITCODE."
}
foreach ($line in $environmentOutput) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) {
    $name = $line.Substring(0, $separator)
    $value = $line.Substring($separator + 1)
    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

Write-Host "Configuring MeshAudio native helper ($Architecture, $Configuration, SDK $($sdk.Name))"
& $CMakePath -S $nativeDir -B $BuildDir -G "NMake Makefiles" `
  "-DCMAKE_BUILD_TYPE=$Configuration" "-DCMAKE_SYSTEM_VERSION=$($sdk.Name)"
if ($LASTEXITCODE -ne 0) {
  throw "CMake configure failed with exit code $LASTEXITCODE."
}
& $CMakePath --build $BuildDir --config $Configuration
if ($LASTEXITCODE -ne 0) {
  throw "Native build failed with exit code $LASTEXITCODE."
}

Write-Host "Built: $(Join-Path $BuildDir 'meshaudio-native.exe')"
