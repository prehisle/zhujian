#!/usr/bin/env bash
# 发版上传到 VPS —— 两条 release workflow 共用这一支(583 立,= 582 那次事故的修)。
#
# **它替掉的是什么**:此前两条 workflow 各写一段
#     ssh "$H" "rm -f $D/<旧产物> $D/<清单>"
#     scp upload/* "$H:$D/"
# 而 **`rm` 在满盘下照样成功**。582 实测:磁盘 100% 时 `scp` 每个文件只写进 261,120 字节就断
# ⇒ 线上进入「旧包全没了 / 新包是残骸 / 清单完整且指着这些坏包」态。
# ⛔ **这比「没发出去」更糟**:存量用户看到有新版 → 下载 → 验签必失败装不上,
# 而官网下载卡指着的旧包也已经删了 ⇒ 新装机同样 404。
#
# **两条判据(缺一不可,别只做一件)**:
#   ① **fail-closed 前移到任何远端写之前** —— 先问一句可用空间,不够就当场红,
#      那时线上一个字节都还没动(同 385 把验签前移到 scp 之前的形)。
#   ② **先传临时名、齐了再换名**,且**清单最后换** —— 与流程 2 换二进制那条(`.new` → `mv`)
#      同一条道理。任何一刻线上都是自洽的:
#        起点 旧清单+旧包 → 传完 旧清单+旧包+新包(临时名) → 换产物 旧清单+两套包
#        → 换清单 新清单+新包 → 清旧包 新清单+新包。
#      ⛔ 顺序反过来(先换清单)= 清单指着还没就位的包,正是要防的那一档。
#
# 用法:
#   ZJ_UPLOAD_HOST=zjci@1.2.3.4 ZJ_UPLOAD_DIR=/var/www/zhujian-app/updates \
#   ZJ_SSH_KEY=~/.ssh/id_ed25519 \
#   scripts/release-upload.sh <本地目录> <清单文件名> <旧产物glob> [<旧产物glob>...]
#
#   <本地目录>   要发布的那几个文件**恰好**都在这儿(桌面 = upload/;安卓 = 现搭一个 staging)
#   <清单文件名> 该目录里那份清单(latest.json / android.json)—— 它最后换名
#   <旧产物glob> 远端上「这次要顶掉的旧产物」怎么找(⛔ 只写自己这端的族:
#                桌面别碰 apk/android.json,安卓别碰 *-setup.exe/latest.json,
#                两份清单刻意分开、两端发版节奏不绑,deploy §7.4)
#
# 阴性对照:`node scripts/gate-sandbox-release-upload.mjs`(假 ssh/scp 台架,含一把
# 反向刀证明旧那个形在满盘下真会把线上毁掉)。⛔ 改本文件必跑它。
set -euo pipefail

die() { echo "::error::$*" >&2; exit 1; }

[ $# -ge 3 ] || die "用法:release-upload.sh <本地目录> <清单文件名> <旧产物glob>..."
LOCAL_DIR=$1; shift
MANIFEST=$1; shift
GLOBS=("$@")

H=${ZJ_UPLOAD_HOST:-}; [ -n "$H" ] || die "ZJ_UPLOAD_HOST 没设"
D=${ZJ_UPLOAD_DIR:-}; [ -n "$D" ] || die "ZJ_UPLOAD_DIR 没设"
SSH_I=(); SCP_I=()
if [ -n "${ZJ_SSH_KEY:-}" ]; then SSH_I=(-i "$ZJ_SSH_KEY"); SCP_I=(-i "$ZJ_SSH_KEY"); fi

rsh() { ssh ${SSH_I[@]+"${SSH_I[@]}"} "$H" "$1"; }

# ── 本地这一份是什么 ────────────────────────────────────────────────────────
[ -d "$LOCAL_DIR" ] || die "本地目录不存在:$LOCAL_DIR"
NAMES=()
while IFS= read -r n; do [ -n "$n" ] && NAMES+=("$n"); done < <(cd "$LOCAL_DIR" && ls -1)
[ ${#NAMES[@]} -gt 0 ] || die "本地目录是空的:$LOCAL_DIR"

need=0
for n in "${NAMES[@]}"; do
  # 名字里有空白就当场停:后面整支都在用「一行一个名字」的形传给远端 shell,
  # 与其写一套引号杂技,不如响亮拒绝(发版产物的命名是我们自己定的)。
  case "$n" in *[[:space:]]*) die "产物名里有空白,本脚本不收:$n";; esac
  [ -f "$LOCAL_DIR/$n" ] || die "$LOCAL_DIR/$n 不是普通文件"
  need=$(( need + $(wc -c < "$LOCAL_DIR/$n" | tr -d ' ') ))
done
printf '%s\n' "${NAMES[@]}" | grep -qx -- "$MANIFEST" || die "清单 $MANIFEST 不在 $LOCAL_DIR 里"

echo "要发布 ${#NAMES[@]} 个文件,合计 $need 字节 → $H:$D"

# ── ⓪ 先扫掉上一趟留下的临时件 ──────────────────────────────────────────────
# 临时名从来不是线上在用的东西(清单不指它、旧产物 glob 也匹配不到它)⇒ 删它绝对安全,
# 而且这一下顺带把上一趟失败占住的空间还回来,让下面那格问到的是真实可用量。
rsh "rm -f $D/*.uploading" || die "连不上或清不掉上一趟的临时件(fail-closed:没往下走)"

# ── ① 空间闸:不够就在这儿红,线上一个字节还没动 ────────────────────────────
# 水位 = 新的这一份 ×2 + 64 MiB。为什么是这个数:换名期间新旧两份**必然共存**
# ⇒ 至少要 1×;第二个 1× 是留给传输期间别的东西(日志/容器)也在长的余量;
# 那 64 MiB 是地板,免得「一份很小的清单」在一块只剩 10 MB 的盘上照样放行。
want=$(( need * 2 + 64 * 1024 * 1024 ))
avail_kb=$(rsh "df -P -k $D | awk 'NR==2{print \$4}'" | tr -d ' \r')
case "$avail_kb" in
  ''|*[!0-9]*) die "问不出可用空间(df 回的是 '$avail_kb')—— fail-closed,不猜";;
esac
avail=$(( avail_kb * 1024 ))
echo "远端可用 $avail 字节 / 本次水位 $want 字节(= 新产物 $need ×2 + 64 MiB)"
if [ "$avail" -lt "$want" ]; then
  die "远端空间不够($avail < $want):**本次一个字节都没往线上写**。先去清盘再重跑这一步(gh run rerun --failed,tag 不必重打)。"
fi

# ── ② 传临时名 ─────────────────────────────────────────────────────────────
for n in "${NAMES[@]}"; do
  echo "  → $n.uploading"
  scp ${SCP_I[@]+"${SCP_I[@]}"} "$LOCAL_DIR/$n" "$H:$D/$n.uploading" || {
    rsh "rm -f $D/*.uploading" || true
    die "传 $n 失败:线上原样未动(临时件已清)。"
  }
done

# ── ③ 逐个核字节数 ─────────────────────────────────────────────────────────
# scp 断在中途**通常**会自己非零退出,但 582 那次的形是「每个文件都只写进 261,120 字节」——
# 与其信上一步的退出码,不如把「远端那份到底多大」当判据(验证独立于被测对象)。
remote_paths=""
for n in "${NAMES[@]}"; do remote_paths="$remote_paths $D/$n.uploading"; done
got=$(rsh "stat -c%s$remote_paths") || { rsh "rm -f $D/*.uploading" || true; die "核不了远端大小(临时件已清)"; }
i=0
for n in "${NAMES[@]}"; do
  i=$(( i + 1 ))
  want_n=$(wc -c < "$LOCAL_DIR/$n" | tr -d ' ')
  got_n=$(printf '%s\n' "$got" | sed -n "${i}p" | tr -d ' \r')
  if [ "$got_n" != "$want_n" ]; then
    rsh "rm -f $D/*.uploading" || true
    die "$n 远端 $got_n 字节 ≠ 本地 $want_n:传坏了,**线上原样未动**(临时件已清)。"
  fi
done
echo "  ${#NAMES[@]} 个文件逐个字节数对上"

# ── ④ 换名:先产物、后清单 ──────────────────────────────────────────────────
# ⛔ 清单必须最后:它是「有新版了」这句话本身,先落地就等于指着还没就位的包。
for n in "${NAMES[@]}"; do
  [ "$n" = "$MANIFEST" ] && continue
  rsh "chmod 644 $D/$n.uploading && mv -f $D/$n.uploading $D/$n" || die "换名 $n 失败(此刻线上仍是上一版清单 + 上一版包)"
done
rsh "chmod 644 $D/$MANIFEST.uploading && mv -f $D/$MANIFEST.uploading $D/$MANIFEST" || die "换清单失败(线上仍是上一版清单 + 上一版包)"
echo "  已就位,清单最后换:$MANIFEST"

# ── ⑤ 清旧产物 ─────────────────────────────────────────────────────────────
# 到这儿线上已经是新的一套了,清旧只是回收空间 ⇒ 放在最后,失败也不该判这趟发版红。
# ⛔ 判据是「按名字排掉刚放上去的那几个」,不是「按 glob 一把梭」——
#    `*-setup.exe` 这类 glob **同时匹配新旧两代**,先删后传那个老形正是栽在这上面。
listcmd="ls -1d"
for g in "${GLOBS[@]}"; do listcmd="$listcmd $D/$g"; done
old=$(rsh "$listcmd 2>/dev/null || true" | tr -d '\r')
stale=""
while IFS= read -r p; do
  [ -n "$p" ] || continue
  b=${p##*/}
  printf '%s\n' "${NAMES[@]}" | grep -qx -- "$b" && continue
  stale="$stale $p"
done <<EOF
$old
EOF
if [ -n "$stale" ]; then
  echo "  清掉旧产物:$stale"
  rsh "rm -f$stale" || echo "::warning::旧产物没清干净(新版已就位,不影响用户):$stale"
else
  echo "  没有要清的旧产物"
fi

echo "✔ 上传完成:${#NAMES[@]} 个文件已就位($MANIFEST 最后落地)"
