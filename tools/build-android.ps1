[CmdletBinding()]
param(
    [ValidateSet('Debug','Release')][string]$Configuration='Debug',
    [string]$AndroidSdkPath,
    [switch]$Install,
    [string]$Device
)
$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
if(-not $AndroidSdkPath){
    $candidates=@($env:ANDROID_HOME,$env:ANDROID_SDK_ROOT,(Join-Path $projectRoot '.build-tools/android-sdk'),(Join-Path $env:LOCALAPPDATA 'Android/Sdk')) | Where-Object { $_ }
    $AndroidSdkPath=$candidates | Where-Object {Test-Path -LiteralPath (Join-Path $_ 'platforms/android-35/android.jar')} | Select-Object -First 1
}
if(-not $AndroidSdkPath){throw 'Android SDK 35 not found. Set ANDROID_HOME or run tools/setup-android.ps1.'}
$env:ANDROID_HOME=(Resolve-Path -LiteralPath $AndroidSdkPath).Path
$env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
$gradle=Join-Path $projectRoot '.build-tools/gradle/gradle-8.10.2/bin/gradle.bat'
if(-not(Test-Path -LiteralPath $gradle)){$gradle=Join-Path $projectRoot 'android/gradlew.bat'}
if(-not(Test-Path -LiteralPath $gradle)){throw 'Gradle not found. Run tools/setup-android.ps1.'}
Push-Location (Join-Path $projectRoot 'android')
try {
    & $gradle --no-daemon :app:testDebugUnitTest :app:lintDebug ":app:assemble$Configuration" ':test-player:assembleDebug' ':device-driver:assembleDebug'
    if($LASTEXITCODE -ne 0){throw "Android checks/build failed: $LASTEXITCODE"}
} finally {Pop-Location}
$variant=$Configuration.ToLowerInvariant()
$apk=Join-Path $projectRoot "android/app/build/outputs/apk/$variant/app-$variant.apk"
if($Configuration -eq 'Release' -and -not(Test-Path -LiteralPath $apk)){
    throw 'Release APK is unsigned. Configure your own release signing credentials outside the source tree. Debug builds are installable test candidates.'
}
$suffix=if($Configuration -eq 'Release'){'release-unsigned'}else{$variant}
$destination=Join-Path $projectRoot "release/android/MeshAudio-Android-0.3.1-$suffix.apk"
New-Item -ItemType Directory -Force (Split-Path $destination) | Out-Null
Copy-Item -LiteralPath $apk -Destination $destination -Force
$hash=(Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($destination+'.sha256'),"$hash  $([IO.Path]::GetFileName($destination))`n")
Write-Host "APK: $destination"
Write-Host "SHA256: $hash"
if($Install){
    $adb=Join-Path $env:ANDROID_HOME 'platform-tools/adb.exe'
    $arguments=@();if($Device){$arguments+=@('-s',$Device)}
    & $adb @arguments install -r $destination
    if($LASTEXITCODE -ne 0){throw 'Install failed. Existing application/data were not uninstalled.'}
}
