# One-off fixture seeder for core/src/test_temp_cleanup.rs (NOT a regression asset).
# ASCII only on purpose: Windows PowerShell 5.1 reads a BOM-less UTF-8 .ps1 as GBK
# and the mangled Chinese comment bytes break parsing (see memory powershell-utf8-readfile-trap).
# The sweeper gates on created(), which `touch` cannot move on Windows -- so we set
# CreationTime explicitly.

$t = $env:TEMP
$old = (Get-Date).AddHours(-3)

# Must be swept: all four prefixes x (file, dir)
$stale = @(
  'ys-nb-sweeptest-stale', 'zj-sweeptest-stale',
  'zhujian-syncd-sweeptest-stale', 'zhujian-meters-test-sweeptest-stale'
)
foreach ($p in $stale) {
  $f = Join-Path $t "$p-file.sqlite3"
  Set-Content -Path $f -Value 'x' -NoNewline
  $i = Get-Item $f; $i.CreationTime = $old; $i.LastWriteTime = $old

  $d = Join-Path $t "$p-dir"
  New-Item -ItemType Directory -Path $d -Force | Out-Null
  Set-Content -Path (Join-Path $d 'inner.txt') -Value 'x' -NoNewline
  $i = Get-Item $d; $i.CreationTime = $old; $i.LastWriteTime = $old
}

# Negative control 1: right prefix but fresh -> must survive (age gate still armed,
# i.e. a concurrently running test process does not get its live containers deleted).
Set-Content -Path (Join-Path $t 'ys-nb-sweeptest-fresh-file.sqlite3') -Value 'x' -NoNewline
New-Item -ItemType Directory -Path (Join-Path $t 'ys-nb-sweeptest-fresh-dir') -Force | Out-Null

# Negative control 2: old enough but prefix not in the table -> must survive
# (proves we are not just nuking %TEMP%).
$f = Join-Path $t 'notours-sweeptest-stale-file.sqlite3'
Set-Content -Path $f -Value 'x' -NoNewline
$i = Get-Item $f; $i.CreationTime = $old; $i.LastWriteTime = $old

Write-Output '--- seeded ---'
Get-ChildItem -Path $t -Filter '*sweeptest*' | Select-Object Name, CreationTime | Format-Table -AutoSize
