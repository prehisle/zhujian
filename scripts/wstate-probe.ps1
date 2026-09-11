# Regression probe for the notebook window's geometry memory (window-state plugin + lib.rs 667).
# ASCII only on purpose (memory: powershell-utf8-readfile-trap).
#
# What it proves (each phase prints PASS/FAIL, exit code 1 if any FAIL):
#   P1/P2  state file says "maximized" -> first summon opens maximized AND the un-maximize rect is the
#          remembered one (667 fix 1: before it, show_window pre-sized the window to the whole work area,
#          so un-maximizing gave a 3840x2114 window and that size was then saved back).
#   P3/P4  move/resize and maximize are saved as the user did them (baseline the plugin always got right).
#   P5     minimizing a maximized window must NOT touch the file (667 fix 3: tao clears its MAXIMIZED flag on
#          WM_SIZE(SIZE_MINIMIZED) and the plugin used to save maximized:false); restoring must keep prev.
#   P6     kill while maximized -> relaunch opens maximized with the remembered un-maximize rect.
#   P7/P8  kill while NOT maximized -> two relaunches keep the size bit-exact (667 fix 2: decorations were
#          stripped at runtime AFTER the plugin restored the size, so every restart grew the window 22x56 at 150% DPI).
#
# How it runs: an ISOLATED app instance (YS_DB_PATH => empty temp db => the app auto-summons the notebook
# through the very same show_window path the tray double-click uses; own WebView2 profile; own state file
# .window-state.e2e.json). Run it on the isolated desktop so nothing pops over your work:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-on-desktop.ps1 -Desktop zje2e `
#       -CommandLine "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\wstate-probe.ps1"
#
# Read the log at %TEMP%\zj-wstate-probe\wstate-probe.log (the runner swallows stdout when it fails early).
# Build the exe first (npm run tauri -- build --no-bundle); the probe refuses an exe older than lib.rs.
#
# Known traps (all hit while building this):
#   * Windows PowerShell is not DPI-aware: WinProbe.Dpi() must succeed or every number is scaled -> abort.
#   * After Stop-Process -Force the WebView2 browser process of the killed instance lingers for minutes
#     holding the profile; a relaunch then stalls ~40 s (backlog code-and-structure 75). The probe kills
#     the orphans that belong to ITS OWN profile dir before relaunching -- never touch other WebView2s.
#   * It shares .window-state.e2e.json and the zje2e desktop with e2e / ui-shots: do not run them concurrently.
#   * Seeded rects sit on the primary monitor; a work area smaller than 1700x1100 physical px is refused.

param(
    [string]$Exe = (Join-Path $PSScriptRoot "..\src-tauri\target\release\app.exe"),
    [string]$Scratch = (Join-Path $env:TEMP "zj-wstate-probe")
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force $Scratch | Out-Null
$exe = (Resolve-Path $Exe).Path
$db = Join-Path $Scratch "probe.sqlite3"
$prof = Join-Path $Scratch "webview2-profile"
$stateFile = Join-Path $env:APPDATA "app.zhujian.notebook\.window-state.e2e.json"
$log = Join-Path $Scratch "wstate-probe.log"
$pidFile = Join-Path $Scratch "app.pid"
if (Test-Path $log) { Remove-Item $log -Force }

Add-Type -Path (Join-Path $PSScriptRoot "lib\win32probe.cs")
if (-not [WinProbe]::Dpi()) { throw "SetProcessDpiAwarenessContext failed: readings would be DPI-scaled, refusing to judge" }

$libRs = Join-Path $PSScriptRoot "..\src-tauri\src\lib.rs"
if ((Get-Item $exe).LastWriteTime -lt (Get-Item $libRs).LastWriteTime) {
    throw "exe ($((Get-Item $exe).LastWriteTime)) is older than src-tauri/src/lib.rs -- rebuild first (memory: verify-artifact-predates-fix)"
}

$script:results = @()
function Log($s) { $line = "[{0}] {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $s; Add-Content -Path $log -Value $line -Encoding ascii; Write-Host $line }
function Expect($name, $ok, $detail) {
    $script:results += [pscustomobject]@{ name = $name; ok = [bool]$ok; detail = $detail }
    Log ($(if ($ok) { "PASS " } else { "FAIL " }) + $name + " -- " + $detail)
}
function ReadState() { (Get-Content -Raw $stateFile | ConvertFrom-Json).notebook }
function StateText() { (Get-Content -Raw $stateFile) -replace "\s+", " " }
function Seed($max, $w, $h, $x, $y, $px, $py) {
    $json = '{ "notebook": { "width": ' + $w + ', "height": ' + $h + ', "x": ' + $x + ', "y": ' + $y + ', "prev_x": ' + $px + ', "prev_y": ' + $py + ', "maximized": ' + $max + ', "visible": true, "decorated": true, "fullscreen": false } }'
    Set-Content -Path $stateFile -Value $json -Encoding ascii
    Log ("SEED " + $json)
}
function CleanDb() {
    foreach ($s in @("", "-wal", "-shm", ".writer.lock", ".backup.json", ".backup-auto.json")) { Remove-Item -Force -ErrorAction SilentlyContinue ($db + $s) }
    foreach ($d in @(".backup-staging", ".backups")) { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue ($db + $d) }
}
function KillLeftoverApp() {
    # A previous run that threw mid-way leaves its app instance running (and holding the state file).
    if (-not (Test-Path $pidFile)) { return }
    $old = [int](Get-Content $pidFile); Remove-Item $pidFile -Force
    $proc = Get-Process -Id $old -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq "app") { Log ("  leftover app pid=" + $old + " from an aborted run -> kill"); Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1500 }
}
function KillOrphanWebViews() {
    # Only the WebView2 processes that were started for OUR profile dir (their command line names it).
    Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like ("*" + $prof + "*") } | ForEach-Object {
        Log ("  orphan webview pid=" + $_.ProcessId + " -> kill")
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
}
function Launch() {
    CleanDb
    $env:YS_DB_PATH = $db
    $env:WEBVIEW2_USER_DATA_FOLDER = $prof
    $p = Start-Process -FilePath $exe -PassThru
    Set-Content -Path $pidFile -Value $p.Id -Encoding ascii   # so an aborted run can be cleaned up next time
    Log ("LAUNCH pid=" + $p.Id)
    $t0 = Get-Date
    while (((Get-Date) - $t0).TotalSeconds -lt 40) {
        $h = [WinProbe]::Notebook([uint32]$p.Id)
        if ($h -ne [IntPtr]::Zero -and [WinProbe]::IsWindowVisible($h)) { Start-Sleep -Seconds 3; return @($p, $h) }
        Start-Sleep -Milliseconds 200
    }
    throw "notebook window did not appear within 40 s (a lingering WebView2 holding the profile? see header)"
}
function KillApp($p) {
    Log ("KILL -Force pid=" + $p.Id); Stop-Process -Id $p.Id -Force; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 1500
    KillOrphanWebViews; Start-Sleep -Milliseconds 1500
}
function Rect($h) { $r = New-Object WinProbe+RECT; [void][WinProbe]::GetWindowRect($h, [ref]$r); @($r.L, $r.T, ($r.R - $r.L), ($r.B - $r.T)) }  # parens: the comma binds tighter than - in PowerShell
function NormalRect($h) { $wp = [WinProbe]::Placement($h); $n = $wp.normalPos; @($n.L, $n.T, ($n.R - $n.L), ($n.B - $n.T)) }
function Same($a, $b) { ($a -join ",") -eq ($b -join ",") }
function Snap($tag, $h) { Log ($tag + " NB " + [WinProbe]::Describe($h)); Log ($tag + " FILE " + (StateText)) }

Log ("exe=" + $exe + " mtime=" + (Get-Item $exe).LastWriteTime)
KillLeftoverApp
KillOrphanWebViews
$wa = [WinProbe]::WorkArea([IntPtr]::Zero)
Log ("primary " + $wa)
if ($wa -notmatch "work=\(0,0\)-\((\d+),(\d+)\)") { throw "could not read the primary work area: $wa" }
if ([int]$Matches[1] -lt 1700 -or [int]$Matches[2] -lt 1100) { throw "primary work area too small for the seeded rects: $wa" }

# ---- P1: file says maximized with a modest normal rect; launch -> auto-summon
Seed "true" 1200 800 -11 -11 300 200
$p, $h = Launch
Snap "P1(maximized restore)" $h
Expect "P1 opens maximized" ([WinProbe]::IsZoomed($h)) ([WinProbe]::Describe($h))
Expect "P1 un-maximize rect kept (300,200,1200,800)" (Same (NormalRect $h) @(300, 200, 1200, 800)) ("normal=" + ((NormalRect $h) -join ","))
$f = ReadState
Expect "P1 file: maximized + prev/size from the OS normal rect" ($f.maximized -and $f.prev_x -eq 300 -and $f.prev_y -eq 200 -and $f.width -eq 1200 -and $f.height -eq 800) (StateText)

# ---- P2: user un-maximizes
[void][WinProbe]::ShowWindow($h, [WinProbe]::SW_RESTORE); Start-Sleep -Milliseconds 2000
Snap "P2(after SW_RESTORE)" $h
Expect "P2 restored to (300,200,1200,800)" ((-not [WinProbe]::IsZoomed($h)) -and (Same (Rect $h) @(300, 200, 1200, 800))) ("rect=" + ((Rect $h) -join ","))
$f = ReadState
Expect "P2 file: not maximized, 1200x800 @ 300,200" ((-not $f.maximized) -and $f.x -eq 300 -and $f.y -eq 200 -and $f.width -eq 1200 -and $f.height -eq 800) (StateText)

# ---- P3: user moves/resizes
[void][WinProbe]::MoveWindow($h, 400, 300, 1000, 700, $true); Start-Sleep -Milliseconds 2000
Snap "P3(after MoveWindow 400,300 1000x700)" $h
$f = ReadState
Expect "P3 file follows the move (400,300,1000,700)" ($f.x -eq 400 -and $f.y -eq 300 -and $f.width -eq 1000 -and $f.height -eq 700 -and -not $f.maximized) (StateText)

# ---- P4: user maximizes
[void][WinProbe]::ShowWindow($h, [WinProbe]::SW_SHOWMAXIMIZED); Start-Sleep -Milliseconds 2000
Snap "P4(after SW_SHOWMAXIMIZED)" $h
$f = ReadState
Expect "P4 file: maximized, prev=(400,300), size 1000x700 kept" ($f.maximized -and $f.prev_x -eq 400 -and $f.prev_y -eq 300 -and $f.width -eq 1000 -and $f.height -eq 700) (StateText)
$p4 = StateText

# ---- P5: minimize (file must not change), restore from minimized (prev must survive)
[void][WinProbe]::ShowWindow($h, [WinProbe]::SW_MINIMIZE); Start-Sleep -Milliseconds 2000
Snap "P5a(after SW_MINIMIZE)" $h
Expect "P5a minimizing does not rewrite the file" ((StateText) -eq $p4) (StateText)
[void][WinProbe]::ShowWindow($h, [WinProbe]::SW_RESTORE); Start-Sleep -Milliseconds 2000
Snap "P5b(after SW_RESTORE from minimized)" $h
$f = ReadState
Expect "P5b back to maximized, prev still (400,300)" ([WinProbe]::IsZoomed($h) -and $f.maximized -and $f.prev_x -eq 400 -and $f.prev_y -eq 300) (StateText)

# ---- P6: kill while maximized, relaunch
KillApp $p
$p, $h = Launch
Snap "P6(relaunch after kill while maximized)" $h
Expect "P6 opens maximized with normal rect (400,300,1000,700)" ([WinProbe]::IsZoomed($h) -and (Same (NormalRect $h) @(400, 300, 1000, 700))) ([WinProbe]::Describe($h))
[void][WinProbe]::ShowWindow($h, [WinProbe]::SW_RESTORE); Start-Sleep -Milliseconds 2000
Expect "P6 un-maximize lands on (400,300,1000,700)" (Same (Rect $h) @(400, 300, 1000, 700)) ("rect=" + ((Rect $h) -join ","))

# ---- P7/P8: kill while NOT maximized; two relaunches must keep the size bit-exact
[void][WinProbe]::MoveWindow($h, 500, 250, 1100, 750, $true); Start-Sleep -Milliseconds 2000
Snap "P7a(after MoveWindow 500,250 1100x750)" $h
KillApp $p
$p, $h = Launch
Snap "P7b(relaunch after kill while normal)" $h
Expect "P7 relaunch keeps (500,250,1100,750) exactly" ((-not [WinProbe]::IsZoomed($h)) -and (Same (Rect $h) @(500, 250, 1100, 750))) ("rect=" + ((Rect $h) -join ","))
KillApp $p
$p, $h = Launch
Snap "P8(second relaunch)" $h
Expect "P8 second relaunch still (500,250,1100,750)" ((-not [WinProbe]::IsZoomed($h)) -and (Same (Rect $h) @(500, 250, 1100, 750))) ("rect=" + ((Rect $h) -join ","))
KillApp $p

Remove-Item -Force -ErrorAction SilentlyContinue $stateFile
CleanDb

$failed = @($script:results | Where-Object { -not $_.ok })
Log ("---- " + $script:results.Count + " checks, " + $failed.Count + " failed ----")
foreach ($r in $script:results) { Log ($(if ($r.ok) { "  PASS " } else { "  FAIL " }) + $r.name) }
if ($failed.Count -gt 0) { exit 1 }
exit 0
