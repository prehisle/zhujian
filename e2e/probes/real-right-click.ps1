# Real OS-level right click at an absolute screen point, then grab a given screen
# rect (native popups included). WebDriver cannot do either half:
#   - its pointer actions go through CDP and are synthesized inside the renderer;
#   - its screenshots only cover the page, and a native context menu is its own window.
#
# ⛔ This script deliberately does NOT look up the window itself. It used to
# (EnumWindows over app.exe + size filter) and that picked the WRONG window when a
# second zhujian was running (the user's installed build), then SetForegroundWindow
# raised it OVER the one under test — the right click landed on the old binary and
# "proved" the native menu still shows. Caller passes the rect; caller owns focus.
#
# ASCII-only on purpose (PS 5.1 reads .ps1 as GBK). The here-string is C# source.
# Dx/Dy are offsets INSIDE the target window's client area.
# ⛔ Do not switch back to absolute screen coords derived from window.screenX/screenY:
# on this machine WebView2 reported screenY=2540 on a 1440-tall virtual screen, i.e.
# a point off-screen, and every click missed. The window rect from the OS is the
# authority; the page only supplies the offset within its own viewport.
param(
  [Parameter(Mandatory=$true)][int]$TargetPid,  # which app.exe (two zhujian can run)
  [Parameter(Mandatory=$true)][int]$Dx,
  [Parameter(Mandatory=$true)][int]$Dy,
  [Parameter(Mandatory=$true)][string]$Out
)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class RC {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  public const uint RDOWN = 0x0008, RUP = 0x0010;
}
"@
[void][RC]::SetProcessDPIAware()

# Find the TARGET process's main window (visible, big enough to not be the 560x140
# capture slip). Scoping by pid is what keeps a second zhujian out of the picture.
$found = [IntPtr]::Zero
$rect = New-Object RC+RECT
$cb = [RC+EnumProc]{
  param($h, $p)
  if (-not [RC]::IsWindowVisible($h)) { return $true }
  $wpid = 0
  [void][RC]::GetWindowThreadProcessId($h, [ref]$wpid)
  if ([int]$wpid -ne $TargetPid) { return $true }
  $r = New-Object RC+RECT
  [void][RC]::GetWindowRect($h, [ref]$r)
  if (($r.R - $r.L) -lt 700 -or ($r.B - $r.T) -lt 400) { return $true }
  $script:found = $h
  $script:rect = $r
  return $false
}
[void][RC]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:found -eq [IntPtr]::Zero) { throw ("no main window for pid " + $TargetPid) }
$r = $script:rect
Write-Output ("window rect: {0},{1} {2}x{3}" -f $r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T))
[void][RC]::SetForegroundWindow($script:found)
Start-Sleep -Milliseconds 300

$AbsX = $r.L + $Dx
$AbsY = $r.T + $Dy
# Move first, then click (a click at a spot the cursor only just arrived at can be
# dropped by the target window - see the windows-ui-automation notes).
[void][RC]::SetCursorPos($AbsX, $AbsY)
Start-Sleep -Milliseconds 250

# Report which process owns the pixel we are about to click - the guard against the
# "two zhujian windows" trap above.
# ⚠ Must walk up to the ROOT window first: WindowFromPoint returns the deepest child,
# and inside a Tauri window that is WebView2's render surface, owned by
# msedgewebview2.exe - NOT by app.exe. Asserting on the raw hit-test pid reported a
# foreign pid on every single run and made a click that landed just fine look like a
# miss (three rounds were spent chasing coordinates because of it).
$pt = New-Object RC+POINT
$pt.X = $AbsX; $pt.Y = $AbsY
$hw = [RC]::WindowFromPoint($pt)
$root = [RC]::GetAncestor($hw, 2)   # GA_ROOT
$owner = 0
[void][RC]::GetWindowThreadProcessId($root, [ref]$owner)
$leaf = 0
[void][RC]::GetWindowThreadProcessId($hw, [ref]$leaf)
Write-Output ("target-pid: {0} (leaf-pid {1})" -f $owner, $leaf)

[RC]::mouse_event([RC]::RDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 60
[RC]::mouse_event([RC]::RUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 900   # let any menu (ours or the native one) settle

$M = 60   # margin: a native menu can spill outside the window
$x = [Math]::Max(0, $r.L - $M); $y = [Math]::Max(0, $r.T - $M)
$bmp = New-Object System.Drawing.Bitmap((($r.R - $r.L) + 2 * $M), (($r.B - $r.T) + 2 * $M))
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output ("saved {0}" -f $Out)
