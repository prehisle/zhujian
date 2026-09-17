# Crop a PNG to a rectangle. Used by the release round to keep ONLY the update banner
# out of a full-screen Android screencap -- the rest of that frame is the user's own notes
# and must not stay on disk (zhujian-ops flow 7, "only the crop is written").
#
# ASCII-only on purpose: PowerShell reads .ps1 as the OEM codepage here, so non-ASCII
# source bytes get mangled (memory powershell-utf8-readfile-trap).
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/crop-png.ps1 `
#     -In <src.png> -Out <dst.png> -X 40 -Y 1950 -W 1180 -H 340
# Pass -Replace to delete the source after a successful crop.
param(
  [Parameter(Mandatory = $true)][string]$In,
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$W,
  [Parameter(Mandatory = $true)][int]$H,
  [switch]$Replace
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path $In).Path)
try {
  Write-Host ("source  : {0}x{1}" -f $src.Width, $src.Height)
  # Clamp to the image so a bad rect fails loudly instead of throwing an opaque GDI+ error.
  if ($X -lt 0 -or $Y -lt 0 -or $X -ge $src.Width -or $Y -ge $src.Height) {
    throw "crop origin ($X,$Y) is outside the image"
  }
  $w = [Math]::Min($W, $src.Width - $X)
  $h = [Math]::Min($H, $src.Height - $Y)
  $rect = New-Object System.Drawing.Rectangle($X, $Y, $w, $h)
  $crop = ([System.Drawing.Bitmap]$src).Clone($rect, $src.PixelFormat)
  try {
    $dir = Split-Path -Parent $Out
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $crop.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Host ("cropped : {0}x{1} at ({2},{3}) -> {4}" -f $w, $h, $X, $Y, $Out)
  } finally { $crop.Dispose() }
} finally { $src.Dispose() }

if ($Replace) {
  Remove-Item -LiteralPath (Resolve-Path $In).Path -Force
  Write-Host "source deleted (-Replace)"
}
