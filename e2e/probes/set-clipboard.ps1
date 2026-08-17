# Put a known thing on the REAL Windows clipboard. ASCII-only (PS 5.1 reads BOM-less .ps1 as ANSI).
param([Parameter(Mandatory = $true)][ValidateSet('image', 'text', 'empty')][string]$Mode)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Retry($block) {
  for ($i = 0; $i -lt 12; $i++) {
    try { & $block; return $true } catch { Start-Sleep -Milliseconds 350 }
  }
  return $false
}

if ($Mode -eq 'image') {
  $bmp = New-Object System.Drawing.Bitmap 40, 40
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::FromArgb(200, 30, 40))
  $g.Dispose()
  if (-not (Retry { [System.Windows.Forms.Clipboard]::SetImage($bmp) })) { throw 'SetImage failed' }
  Write-Output ('image ok ContainsImage=' + [System.Windows.Forms.Clipboard]::ContainsImage())
}
elseif ($Mode -eq 'text') {
  if (-not (Retry { [System.Windows.Forms.Clipboard]::SetText('WINCLIP-TEXT') })) { throw 'SetText failed' }
  Write-Output ('text ok ContainsText=' + [System.Windows.Forms.Clipboard]::ContainsText())
}
else {
  if (-not (Retry { [System.Windows.Forms.Clipboard]::Clear() })) { throw 'Clear failed' }
  Write-Output ('empty ok ContainsImage=' + [System.Windows.Forms.Clipboard]::ContainsImage() +
    ' ContainsText=' + [System.Windows.Forms.Clipboard]::ContainsText())
}
