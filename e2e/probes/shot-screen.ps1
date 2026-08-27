# Full-screen grab including native popups (WebView2's default context menu is a
# native window - WebDriver screenshots and PrintWindow both miss it, only a real
# screen copy sees it). ASCII-only on purpose: PS 5.1 reads .ps1 as GBK.
param([Parameter(Mandatory=$true)][string]$Out)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output "saved $Out"
