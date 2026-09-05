#!/bin/bash
# ⛔ **按需探针,不进任何套件**(住 `e2e/probes/`)。**Linux 专属**:要 X 显示 + xdotool。
#
# 干什么:回答「**这一记键在真 Linux 桌面上按下去到底什么样**」—— backlog 用户面 64 头上那两笔账。
# 那两笔一直没人还,是因为 CI 与本地 e2e 用的是**同一个 WebDriver 驱动**:拿驱动去验「驱动合成
# 的键与真键盘一不一样」是循环论证。这支不经 WebDriver:app 自己起,键走 **xdotool(XTEST)**
# —— 与真键盘在 X 服务器那一层同路(450 那次 XIM 重译的差别就出在这一层),结果从**库里**读。
#
# ⛔⛔ **别把它改写成 wdio 探针**(571 试过,死路):tauri-driver 起的那只 app,窗口 active /
# focus 都对、`document.activeElement` 也对,但 **`document.hasFocus()` 恒 false** ⇒ webview
# 那一层根本没拿到键盘焦点,XTEST 的键一个都不进 DOM(真鼠标点一下也拿不回来)。
# 现象是「按了没反应」——**与「功能不工作」输出一模一样**,571 第一版就差点照这个写出两条反的结论。
# ⭐ 所以这支的头一格恒是**阳性对照**:先确认字真的打进去了,再谈那记键有没有效。
#
# 怎么跑(先 `npm run tauri -- build --no-bundle` 或 `cd src-tauri && cargo build` 出 debug exe;
# debug 形指向 localhost:1420,故还要另起 `npm run dev`):
#   DISPLAY=:1.0 e2e/probes/linux-real-keys.sh "要打的字" [接着按的键…]
# 例(571 那三趟的原样):
#   … "abcdef" ctrl+z Return        # 只打字再撤销 —— 阳性对照 + ①
#   … "abc" ctrl+l ctrl+z Return    # 快速输入之后再撤销 —— ①
#   … "abc" ctrl+l shift+Return Return  # 续行手势 —— 顺带
# ⭐ **键序里可以夹 `type:<字>`**(602 加):中途再打一段字。
#   ⚠⚠ **量缩进必须用它**,别把缩进只落在第一行 —— 捕获窗提交那步 `main.ts:482` 会 `trim()`,
#   首行的缩进在库里**看不见**,那个读数对「Tab 生没生效」**不构成判据**(602 第一趟就这么被骗过)。
#   例:… "abc" ctrl+l shift+Return type:def Tab Return   # 缩进落在第二行,库里读得出
# 读数从最后那几行 `ROW` 看:打进去的字在不在、那记键有没有改变它。
set -u
APP=${ZJ_APP:-./src-tauri/target/debug/app}
DB=${ZJ_PROBE_DB:-/tmp/zj-real-keys.sqlite3}
LOG=${ZJ_PROBE_LOG:-/tmp/zj-real-keys.app.log}
[ -x "$APP" ] || { echo "没有 debug exe:$APP(先 cd src-tauri && cargo build)"; exit 1; }
command -v xdotool >/dev/null || { echo "缺 xdotool"; exit 1; }
[ -n "${DISPLAY:-}" ] || { echo "没有 DISPLAY —— 这支要真 X 显示,⛔ xvfb 下的读数不算「真桌面」"; exit 1; }
[ $# -ge 1 ] || { echo "用法:$0 \"要打的字\" [键…]"; exit 1; }

rm -f "$DB" "$DB"-wal "$DB"-shm "$DB".writer.lock
YS_DB_PATH="$DB" "$APP" >"$LOG" 2>&1 &
APP_PID=$!
trap 'kill $APP_PID 2>/dev/null' EXIT

for _ in $(seq 1 40); do
  WID=$(xdotool search --name "^朱简 · 捕获$" 2>/dev/null | head -1)
  [ -n "$WID" ] && break
  sleep 0.5
done
[ -n "${WID:-}" ] || { echo "捕获窗没出来(看 $LOG)"; exit 1; }
sleep 2

# ⚠ XTEST 只认**当前焦点**,所以先把窗口按到前面、再真点一下把键盘焦点交给 webview。
# ⛔ 别用 `xdotool key --window <id>`:那条走 XSendEvent,事件带 send_event 标记,GTK/WebKit 一律
#    忽略 —— 又是一个「看着发出去了、其实没人收」的形。
xdotool windowactivate --sync "$WID"
eval "$(xdotool getwindowgeometry --shell "$WID")"
xdotool mousemove $((X + WIDTH / 2)) $((Y + HEIGHT / 2)) click 1
sleep 1
echo "活动窗口=$(xdotool getactivewindow getwindowname)"

xdotool type --delay 60 -- "$1"   # ⚠ `--`:要打的字以 `-` 开头时,没有它会被当成选项
shift
sleep 1
# 601 补:键位里可以夹 `type:<字>`(⚠ **要用它**,别把缩进只落在第一行 —— 捕获窗提交那步
# `main.ts:482` 会 `trim()`,首行的缩进在库里看不见,读数对「Tab 生没生效」不构成判据)。
for k in "$@"; do
  case "$k" in
    type:*) xdotool type --delay 60 -- "${k#type:}" ;;
    *) xdotool key --clearmodifiers "$k" ;;
  esac
  sleep 0.8
done
sleep 2

ZJ_PROBE_DB="$DB" node --experimental-sqlite -e '
const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(process.env.ZJ_PROBE_DB, { readOnly: true });
const rows = d.prepare("select stage, content from items order by rowid").all();
if (!rows.length) console.log("(库里一条都没有 —— 要么那记提交没生效,要么字压根没打进去)");
for (const r of rows) console.log("ROW", JSON.stringify(r.content), r.stage);
'
