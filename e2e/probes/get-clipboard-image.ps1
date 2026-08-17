# Read the REAL Windows clipboard and report whether it carries an image, and how big.
# Prints exactly one line: "image WxH" or "none".
# ASCII-only on purpose (PS 5.1 reads a BOM-less .ps1 as ANSI; non-ASCII bytes in a comment
# can derail the parser so that later statements silently never run -- see the sibling
# probe's notes and memory `powershell-utf8-readfile-trap`).
# Retry like set-clipboard.ps1 does: the clipboard is a machine-wide exclusive resource and
# another process may hold it open. If it cannot be read, THROW -- never print "none",
# which would disguise "could not read" as "there is no image".
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

function Retry($block) {
  $err = $null
  for ($i = 0; $i -lt 12; $i++) {
    try { return & $block } catch { $err = $_; Start-Sleep -Milliseconds 350 }
  }
  throw ('clipboard read failed: ' + $err)
}

$has = Retry { [System.Windows.Forms.Clipboard]::ContainsImage() }
if (-not $has) {
  Write-Output 'none'
  exit 0
}
$img = Retry { [System.Windows.Forms.Clipboard]::GetImage() }
if ($null -eq $img) { throw 'ContainsImage said true but GetImage returned null' }
Write-Output ('image ' + $img.Width + 'x' + $img.Height)
$img.Dispose()
