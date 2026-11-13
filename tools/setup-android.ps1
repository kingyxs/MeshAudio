[CmdletBinding()]
param([string]$ToolsRoot=(Join-Path (Split-Path $PSScriptRoot -Parent) '.build-tools'))
$ErrorActionPreference='Stop'
$downloadDir=Join-Path $ToolsRoot 'android-downloads'
$sdkDir=Join-Path $ToolsRoot 'android-sdk'
New-Item -ItemType Directory -Force $downloadDir,$sdkDir | Out-Null
function Fetch([string]$Url,[string]$Target){
    if(-not(Test-Path -LiteralPath $Target)){
        & curl.exe -fL --retry 3 --connect-timeout 20 $Url -o ($Target+'.part')
        if($LASTEXITCODE -ne 0){throw "Download failed: $Url"}
        Move-Item -LiteralPath ($Target+'.part') -Destination $Target
    }
}
# Official Google repository metadata pins this JDK-17-compatible tools revision.
$cmdZip=Join-Path $downloadDir 'commandlinetools-win-12266719_latest.zip'
Fetch 'https://dl.google.com/android/repository/commandlinetools-win-12266719_latest.zip' $cmdZip
if((Get-FileHash $cmdZip -Algorithm SHA1).Hash.ToLowerInvariant() -ne '32787c10f55911fd109848906b1275723e79f659'){throw 'Google SDK checksum mismatch'}
$sdkManager=Join-Path $sdkDir 'cmdline-tools/16.0/bin/sdkmanager.bat'
if(-not(Test-Path -LiteralPath $sdkManager)){
    $staging=Join-Path $downloadDir 'cmdline-tools-staging'
    Expand-Archive -LiteralPath $cmdZip -DestinationPath $staging -Force
    New-Item -ItemType Directory -Force (Join-Path $sdkDir 'cmdline-tools') | Out-Null
    Move-Item -LiteralPath (Join-Path $staging 'cmdline-tools') -Destination (Join-Path $sdkDir 'cmdline-tools/16.0')
}
$gradleZip=Join-Path $downloadDir 'gradle-8.10.2-bin.zip'
Fetch 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip' $gradleZip
$shaFile=$gradleZip+'.sha256'
Fetch 'https://services.gradle.org/distributions/gradle-8.10.2-bin.zip.sha256' $shaFile
if((Get-FileHash $gradleZip -Algorithm SHA256).Hash.ToLowerInvariant() -ne (Get-Content $shaFile -Raw).Trim()){throw 'Gradle checksum mismatch'}
if(-not(Test-Path -LiteralPath (Join-Path $ToolsRoot 'gradle/gradle-8.10.2/bin/gradle.bat'))){Expand-Archive -LiteralPath $gradleZip -DestinationPath (Join-Path $ToolsRoot 'gradle') -Force}
$env:ANDROID_HOME=$sdkDir;$env:ANDROID_SDK_ROOT=$sdkDir
Write-Host 'Review and accept the Android SDK licenses when prompted. Run with JDK 17.'
& $sdkManager "--sdk_root=$sdkDir" --licenses
if($LASTEXITCODE -ne 0){throw 'Android SDK license acceptance failed'}
& $sdkManager "--sdk_root=$sdkDir" 'platforms;android-35' 'build-tools;35.0.0' 'platform-tools'
if($LASTEXITCODE -ne 0){throw 'Android SDK installation failed'}
Write-Host "Ready: ANDROID_HOME=$sdkDir"
