$ErrorActionPreference = 'Stop'
Write-Host 'MeshAudio Phase 0 - Windows audio device inventory'
Get-PnpDevice -PresentOnly | Where-Object { $_.Class -in @('AudioEndpoint','MEDIA') } | Select-Object Status,Class,FriendlyName,InstanceId | Format-Table -AutoSize
Write-Host ''
Write-Host 'Default endpoints are not modified by this script.'
