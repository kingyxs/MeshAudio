param(
  [string]$DataDir = (Join-Path $env:APPDATA 'com.meshAudio.desktop'),
  [string]$OpenSsl = '',
  [string[]]$Addresses = @(),
  [switch]$Renew
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
if (-not $OpenSsl) {
  $Bundled = Join-Path $Root '.build-tools/msys64/ucrt64/bin/openssl.exe'
  if (Test-Path -LiteralPath $Bundled) { $OpenSsl = $Bundled }
  else { $OpenSsl = (Get-Command openssl -ErrorAction Stop).Source }
}
if (-not $Addresses.Count) {
  $Addresses = @(Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*'
  } | Select-Object -ExpandProperty IPAddress -Unique)
}
$Addresses = @('127.0.0.1') + $Addresses | Select-Object -Unique
foreach ($Address in $Addresses) {
  $Parsed = $null
  if (-not [Net.IPAddress]::TryParse($Address, [ref]$Parsed) -or $Parsed.AddressFamily -ne 'InterNetwork') { throw "Invalid IPv4 address: $Address" }
}
$Dir = Join-Path $DataDir 'web-microphone'
New-Item -ItemType Directory -Path $Dir -Force | Out-Null
# Keep private keys readable by this Windows account and SYSTEM only.
$Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $Dir /inheritance:r /grant:r "*$($Sid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect certificate directory' }
function Invoke-OpenSsl([string[]]$Arguments) {
  & $OpenSsl @Arguments
  if ($LASTEXITCODE -ne 0) { throw 'Certificate generation failed' }
}
$Ca = Join-Path $Dir 'ca.crt'; $CaKey = Join-Path $Dir 'ca.key'
$Cert = Join-Path $Dir 'server.crt'; $Key = Join-Path $Dir 'server.key'
if (-not (Test-Path -LiteralPath $Ca) -or -not (Test-Path -LiteralPath $CaKey)) {
  Invoke-OpenSsl @('req','-x509','-newkey','rsa:2048','-nodes','-sha256','-days','3650','-subj','/CN=MeshAudio Web Microphone Local CA','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',$CaKey,'-out',$Ca)
}
if ((Test-Path -LiteralPath $Cert) -and -not $Renew) {
  Write-Host 'Existing HTTPS certificate kept. Use -Renew after the LAN address changes.'
} else {
  $Config = Join-Path $Dir 'server.cnf'; $Csr = Join-Path $Dir 'server.csr'
  $San = (@('DNS:localhost') + @($Addresses | ForEach-Object { "IP:$_" })) -join ','
  $Text = "[req]`ndistinguished_name=dn`nprompt=no`n[dn]`nCN=MeshAudio Web Microphone`n[server]`nbasicConstraints=critical,CA:FALSE`nkeyUsage=critical,digitalSignature,keyEncipherment`nextendedKeyUsage=serverAuth`nsubjectAltName=$San`n"
  [IO.File]::WriteAllText($Config, $Text, (New-Object Text.UTF8Encoding($false)))
  Invoke-OpenSsl @('req','-new','-newkey','rsa:2048','-nodes','-sha256','-config',$Config,'-keyout',$Key,'-out',$Csr)
  Invoke-OpenSsl @('x509','-req','-in',$Csr,'-CA',$Ca,'-CAkey',$CaKey,'-CAcreateserial','-days','365','-sha256','-extfile',$Config,'-extensions','server','-out',$Cert)
}
Invoke-OpenSsl @('x509','-in',$Ca,'-outform','DER','-out',(Join-Path $Dir 'ca.cer'))
Write-Host 'HTTPS certificate ready. Restart MeshAudio; the microphone QR will use HTTPS port 4177.'
Write-Host 'On iPhone install ca.cer, then explicitly trust MeshAudio Web Microphone Local CA in certificate trust settings.'
Write-Host 'No certificate was added to the Windows trust store. Never share ca.key or server.key.'
