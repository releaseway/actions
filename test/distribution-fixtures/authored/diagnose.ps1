param([string]$Expected = '1.0.0', [switch]$Uninstall)
$ErrorActionPreference = 'Stop'
if (-not $env:FIXTURE_HOME) { throw 'FIXTURE_HOME must name a disposable fixture directory' }
$VersionFile = Join-Path $env:FIXTURE_HOME 'version'
if ($Uninstall) {
    Remove-Item -LiteralPath $VersionFile -ErrorAction SilentlyContinue
    Write-Output 'uninstalled'
} else {
    if ((Get-Content -LiteralPath $VersionFile -Raw).Trim() -ne $Expected) { throw 'unexpected fixture version' }
    Write-Output "diagnosed:$Expected"
}
