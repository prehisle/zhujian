# Release-round helper: capture the desktop update banner ("You have a new version")
# from the zhujian window the user is actually running, without disturbing their layout.
# ASCII-only on purpose: PS 5.1 reads .ps1 as GBK (see memory powershell-utf8-readfile-trap).
#
# Usage (from repo root, after CI has published latest.json):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-banner-shot.ps1 -OutDir .zjshots/<round>-release
# Output: <OutDir>/desktop-update-banner.png (crop of the bottom-right corner only).
#
# How it works (progress-log 599 / 628 / 670 / 688 are the rounds that burned each rule in):
#   * src/update.ts checkForUpdateOnFocus fires when the main window gains focus, throttled to
#     once per 10 minutes. If the crop shows no banner, the user focused the app within the last
#     10 minutes -- wait and rerun; do NOT taskkill/restart (that is a needless restart).
#   * The main window is found by class 'Tauri Window' + title (the two CJK chars are built from
#     code points below). NEVER pick it by Get-Process MainWindowHandle (599: that answered the
#     capture bar, 560x230) nor by "largest visible window" (670: when the main window is hidden
#     in the tray IsWindowVisible is false and a 16x16 shell window wins).
#   * Three window states, each restored afterwards: minimized (IsIconic, rect at -32000) ->
#     SW_RESTORE which returns to the pre-minimize state, maximized included -> SW_MINIMIZE back;
#     hidden in tray -> SW_SHOW (keeps maximized state) -> SW_HIDE back; normal/maximized -> touch
#     nothing. Do NOT call SW_RESTORE on a non-iconic maximized window: it un-maximizes it.
#   * Capture uses PrintWindow(PW_RENDERFULLCONTENT): it renders the window even when the user's
#     other windows cover it (a full-screen CopyFromScreen would capture whatever they are doing).
#   * Only the crop is written. The full window bitmap contains the user's notes and is never saved
#     unless -KeepFull is given (delete it as soon as you have looked).
#   * Crop default 480x180: at 125% DPI the banner is ~450 px wide (688: 420 cut the left edge).
#   * $pid is a read-only automatic variable in PowerShell -- the EnumWindows callback uses $wp.
param(
  [Parameter(Mandatory=$true)][string]$OutDir,
  [int]$WaitSec = 12,
  [int]$CropW = 480,
  [int]$CropH = 180,
  [switch]$KeepFull
)
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class N {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
"@
[void][N]::SetProcessDPIAware()
$title = [string]([char]0x6731) + [string]([char]0x7B80)   # the product name, two CJK chars
$pids = @(Get-Process app -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
if ($pids.Count -eq 0) { throw 'app.exe is not running' }
$script:found = [IntPtr]::Zero
$cb = [N+EnumProc]{ param($h, $l)
  [uint32]$wp = 0; [void][N]::GetWindowThreadProcessId($h, [ref]$wp)
  if ($pids -contains [int]$wp) {
    $t = New-Object System.Text.StringBuilder 256; [void][N]::GetWindowText($h, $t, 256)
    $c = New-Object System.Text.StringBuilder 256; [void][N]::GetClassName($h, $c, 256)
    if ($c.ToString() -eq 'Tauri Window' -and $t.ToString() -eq $title) { $script:found = $h }
  }
  return $true }
[void][N]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found -eq [IntPtr]::Zero) { throw 'main window not found (class Tauri Window + product title)' }
$h = $script:found
$wasIconic = [N]::IsIconic($h)
$wasVisible = [N]::IsWindowVisible($h)
Write-Output ("hwnd={0} iconic={1} visible={2} zoomed={3}" -f $h, $wasIconic, $wasVisible, [N]::IsZoomed($h))
$prevFg = [N]::GetForegroundWindow()
if ($wasIconic) { [void][N]::ShowWindow($h, 9) }          # SW_RESTORE: back to the pre-minimize state
elseif (-not $wasVisible) { [void][N]::ShowWindow($h, 5) } # SW_SHOW: keeps the maximized state
[void][N]::BringWindowToTop($h)
[void][N]::SetForegroundWindow($h)
[N]::SwitchToThisWindow($h, $true)
Start-Sleep -Milliseconds 400
Write-Output ("foreground-now={0} target={1}" -f [N]::GetForegroundWindow(), $h)
Start-Sleep -Seconds $WaitSec
$r = New-Object N+RECT; [void][N]::GetWindowRect($h, [ref]$r)
$w = $r.R - $r.L; $hh = $r.B - $r.T
Write-Output ("rect={0},{1} {2}x{3}" -f $r.L, $r.T, $w, $hh)
$bmp = New-Object System.Drawing.Bitmap($w, $hh)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$dc = $g.GetHdc()
$ok = [N]::PrintWindow($h, $dc, 2)   # PW_RENDERFULLCONTENT
$g.ReleaseHdc($dc)
$g.Dispose()
New-Item -ItemType Directory -Force $OutDir | Out-Null
if ($KeepFull) { $bmp.Save((Join-Path $OutDir 'desktop-window-full.png'), [System.Drawing.Imaging.ImageFormat]::Png) }
$cw = [Math]::Min($CropW, $w); $ch = [Math]::Min($CropH, $hh)
$rect = New-Object System.Drawing.Rectangle(($w - $cw), ($hh - $ch), $cw, $ch)
$crop = $bmp.Clone($rect, $bmp.PixelFormat)
$out = Join-Path $OutDir 'desktop-update-banner.png'
$crop.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose(); $bmp.Dispose()
Write-Output ("printwindow={0} saved {1}" -f $ok, $out)
# put the window back the way it was
if ($wasIconic) { [void][N]::ShowWindow($h, 6) }           # SW_MINIMIZE
elseif (-not $wasVisible) { [void][N]::ShowWindow($h, 0) } # SW_HIDE (WM_CLOSE would not re-hide it)
if ($prevFg -ne [IntPtr]::Zero -and $prevFg -ne $h) { [void][N]::SetForegroundWindow($prevFg) }
Write-Output ("restored: iconic={0} visible={1} zoomed={2}" -f [N]::IsIconic($h), [N]::IsWindowVisible($h), [N]::IsZoomed($h))
