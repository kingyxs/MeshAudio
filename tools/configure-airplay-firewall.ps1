param(
  [string]$NativePath = "$PSScriptRoot/../desktop/airplay/uxplay.exe",
  [int]$GuidePort = 4176,
  [int]$MicrophoneTlsPort = 4177,
  [int]$AirplayPortStart = 7200,
  [int]$AirplayPortEnd = 7279
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator rights are required. Re-run PowerShell as Administrator; no firewall rule was changed.' }
$native = [IO.Path]::GetFullPath($NativePath)
if (-not (Test-Path -LiteralPath $native -PathType Leaf)) { throw "Native UxPlay not found: $native" }
$group = 'MeshAudio AirPlay'
Get-NetFirewallRule -Group $group -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'MeshAudio native AirPlay receiver' -Group $group -Direction Inbound -Action Allow -Profile Private -Program $native -Protocol TCP -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'MeshAudio native AirPlay receiver UDP' -Group $group -Direction Inbound -Action Allow -Profile Private -Program $native -Protocol UDP -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'MeshAudio AirPlay guide' -Group $group -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $GuidePort -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'MeshAudio HTTPS web microphone' -Group $group -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort $MicrophoneTlsPort -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'MeshAudio AirPlay ports' -Group $group -Direction Inbound -Action Allow -Profile Private -Protocol TCP -LocalPort "$AirplayPortStart-$AirplayPortEnd" -RemoteAddress LocalSubnet | Out-Null
New-NetFirewallRule -DisplayName 'MeshAudio AirPlay ports UDP' -Group $group -Direction Inbound -Action Allow -Profile Private -Protocol UDP -LocalPort "$AirplayPortStart-$AirplayPortEnd" -RemoteAddress LocalSubnet | Out-Null
Write-Host "Configured Private-profile, LocalSubnet-only rules for $native and AirPlay ports $AirplayPortStart-$AirplayPortEnd."
