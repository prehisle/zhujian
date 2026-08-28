# Run a command on a separate Windows desktop in the current session.
# See scripts/lib/win-desktop.cs for why. ASCII only on purpose.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-on-desktop.ps1 `
#       -Desktop zje2e -CommandLine "node scripts\e2e-session.mjs --smoke"
#
# The whole child process tree inherits the desktop, so tauri-driver -> msedgedriver ->
# app.exe all land there too. Nothing is visible on your desktop and nothing steals focus.

param(
    [Parameter(Mandatory = $true)][string]$Desktop,
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [string]$WorkingDir = "",
    [switch]$NoWait
)

$ErrorActionPreference = "Stop"

if ($WorkingDir -eq "") { $WorkingDir = (Get-Location).Path }

$cs = Join-Path $PSScriptRoot "lib\win-desktop.cs"
if (-not (Test-Path $cs)) { throw "missing $cs" }
Add-Type -Path $cs

$wait = -not $NoWait
$result = [WinDesktop]::Run($Desktop, $CommandLine, $WorkingDir, $wait)

if ($NoWait) {
    Write-Output ("pid=" + $result)
} else {
    Write-Output ("exit=" + $result)
    exit $result
}
