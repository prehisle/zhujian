// 朱简鸿蒙端**产品界面**的跑手(OH-d 及以后)。
//
// # 它与 `ohos-c4.mjs` 的分工(别把两份合起来)
//
// `ohos-c4.mjs` 驱的是 **C4 验收面板**那一页:十四枚定高通栏按钮,坐标能用
// `FIRST_Y + (n-1)*STRIDE` 算出来,所以它的入口是 `tap <1..14>`。
// **产品界面没有那种规则版式** —— 卡片高度随内容变、面板从底下弹、列表会滚
// ⇒ 这里只能收**任意坐标**,由人从截图上读。⇒ 两份跑手,不是一份。
//
// # ⭐ 为什么报告里必须有 `ARKWEB-CONSOLE`
//
// 468 补那条平台缺陷(ArkWeb 上 `localStorage` 恒 `null`)的症状是
// **「界面停在启动闸」,而屏幕上看不出任何异常** —— 那句中文是 `index.html` 的静态原文,
// JS 一行没跑也照样显示。唯一的凭据在 hilog 的 `ARKWEB-CONSOLE` 标签下。
// 而 `ohos-c4.mjs` 的 `ours()` 只挑 `/ZHUJIAN:|C4-JS/`,**把它整个滤掉了**。
// ⇒ 本脚本的报告分两栏:壳的 `ZHUJIAN` 行 + **前端的 console 行**,缺一不可。
//
// ⛔ **别用 `hilog -x` 事后捞**(2026-08-23 实测,那份里我们自己的行一条都没有)——
// 一律挂实时捕获再触发动作。
//
// ⛔ **截图名自带序号**,同名不覆盖(memory `before-after-artifact-overwritten`:
// 版本标记要进文件名,别靠事后改名)。
//
// # 用法
//
//   node scripts/ohos-drive.mjs shot <名字>              截图(自动带序号前缀)
//   node scripts/ohos-drive.mjs tap <x> <y> [名字]       点一下,收该轮日志 + 截图
//   node scripts/ohos-drive.mjs swipe <x1> <y1> <x2> <y2> [毫秒] [名字]
//   node scripts/ohos-drive.mjs text <字符串> [名字]     往当前焦点打字
//   node scripts/ohos-drive.mjs key <键码> [名字]        发一次按下+抬起
//   node scripts/ohos-drive.mjs clear [次数] [名字]      退格 N 次(默认 40)清空当前输入框
//   node scripts/ohos-drive.mjs back [名字]              返回键
//   node scripts/ohos-drive.mjs watch <秒> [名字]        只挂着收日志
//   node scripts/ohos-drive.mjs restart [名字]           force-stop → start
//
// 坐标 = **物理像素**,与 `shot` 出来的截图同一套(这台 Mate 60 Pro 是 1260×2720)。
// ⇒ 从截图上量到多少就填多少,⛔ 别再乘设备缩放比(那是 C4 那份要算 CSS px 才需要的)。
//
// # 往输入框里填东西的两条(OH-e 真机踩出来的,别再问一遍)
//
// ①**退格键码 = `2055`**(实测,⛔ 不是安卓那套号)。`clear` 就是发 N 次它;
//   多条 `uinput` 用 `;` 串在一句里,设备端 shell 吃得下(每次它会回一行
//   `you raised the key 2055`,那是 uinput 自己的回显,不是错)。
// ②⛔ **`clear` 之前必须自己先 `tap` 一下那个框的右侧空白** —— 光标落在你点的地方,
//   点在文字中间就只删得掉左半边。跑手不替你点:哪个框、右边空白在哪,只有截图上量得出来。
// ⭐ `text` 打**大写 ASCII 与短横**实测没问题(OH-e 那趟把 64 位恢复码原样打进去,
//   app 自己核码通过)—— ⛔ 但仍只限 ASCII,中文**这条路**打不进去。
//   ⭐ **中文另有一条路(2026-09-02 实测通)**:`hdc shell "uitest uiInput text 中文"`
//   —— uitest 走的是**剪贴板贴入**而不是键码,汉字原样落进输入框。
//   ⚠ 代价 = **覆盖设备剪贴板**;⚠ 同族的 `uitest uiInput click/swipe/keyEvent` 也都能用,
//   坐标与 `screenCap` 同一套物理像素。⛔ 本脚本刻意没接它(那是另一套注入通道,
//   与这里的 uinput 混用会让「这一下是谁发的」不可追),要用就直接叫 `hdc shell uitest`。
// ③⛔⛔ **软键盘一弹,整页就上移 ⇒ 打完字必须重新 `shot` 量一次坐标再点按钮**。
//   470 补栽的样子:照打字**前**的坐标去点「保存」,那一下落在键盘的 `o` 键上,
//   别名成了 `Mate60o` —— **它不报错,看起来就像我打错了字**。
//
// # ⛔ 行内二次确认条会自己收起 ⇒ 「点动作」与「点确认」要一气呵成
//
// 470 补栽的第二样:点完「删除」后中间插了一次截图+报告(十几秒),回来点确认时
// **确认条早收了**,那个坐标底下是**悬浮 ＋ 钮** ⇒ compose 弹出来、条目一条没删。
// ⚠ 我当场把它误判成「两个热区重叠」,下一趟把两下并进同一条命令就成了 ⇒ **是超时不是重叠**。
// ⇒ 这类「弹出来就开始倒计时」的东西,别用本脚本一步一停的形去点,直接连发两个 `uinput -T -c`。
//
// 环境:`OHOS_HDC` 指到 hdc.exe(默认 `G:\ohos-sdk\toolchains\hdc.exe`,零华为 ID)。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, ".zjshots", "ohd");
const BUNDLE = "app.zhujian.notebook";
const ABILITY = "EntryAbility";

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

// ---- hdc -------------------------------------------------------------------
//
// ⚠ 两个坑焊在这里(memory `zhujian-ohos-feasibility-2026-07-17`):
//   ①`hdc` 的**远端**路径会被 MSYS 当本地路径转 ⇒ 全程 `MSYS_NO_PATHCONV=1`;
//   ②`hdc file recv` 的**本地**路径不吃 Git Bash 的 `/tmp` 形,要 Windows 形。
const hdcPath = process.env.OHOS_HDC ?? "G:\\ohos-sdk\\toolchains\\hdc.exe";
if (!existsSync(hdcPath)) {
  die(`找不到 hdc:${hdcPath}(设 OHOS_HDC 指过去;它在 SDK 全包的 toolchains 里,零华为 ID)`);
}
const hdcEnv = { ...process.env, MSYS_NO_PATHCONV: "1" };

const hdc = (args, { quiet = false } = {}) => {
  const r = spawnSync(hdcPath, args, { encoding: "utf8", env: hdcEnv, maxBuffer: 1 << 26 });
  if (r.error) die(`hdc 起不来:${r.error.message}`);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (!quiet) process.stdout.write(out);
  // ⚠ hdc 的退出码**不可信**(很多失败它照样退 0)⇒ 判据一律放输出内容上。
  return out;
};
const sh = (cmd, opts) => hdc(["shell", cmd], opts);

// ---- 序号与落点 -------------------------------------------------------------

let seq = 0;
const nextSeq = () => {
  mkdirSync(outDir, { recursive: true });
  if (seq === 0) {
    const used = readdirSync(outDir)
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));
    seq = used.length ? Math.max(...used) : 0;
  }
  seq += 1;
  return String(seq).padStart(3, "0");
};

// ---- 日志捕获 ---------------------------------------------------------------
//
// ⚠ 子进程 stdout **直接绑文件描述符**,不经 node 的事件循环 —— 否则一边 spawnSync
// 阻塞、一边等管道数据 = 自锁(memory `self-service-probe-sync-exec-deadlock`)。
const startCapture = (stem) => {
  const file = join(outDir, `${stem}.log`);
  const fd = openSync(file, "w");
  const child = spawn(hdcPath, ["shell", "hilog"], { env: hdcEnv, stdio: ["ignore", fd, fd] });
  return {
    file,
    stop: () => {
      try {
        child.kill();
      } catch {
        /* 已经没了就算了 —— 收尸不是判据 */
      }
      closeSync(fd);
    },
  };
};

const sleep = (ms) => {
  // ⚠ 刻意用**同步**等待:整个脚本是一条直线,混进 async 只会让「点了之后等多久」
  // 散在两种时间轴上。Atomics.wait 是 node 里唯一不烧 CPU 的同步睡眠。
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
};

const report = (file) => {
  const all = readFileSync(file, "utf8").split("\n");
  // 壳那半:Rust 的 `log::info!` 走 ZHUJIAN 域名。
  const shell = all
    .filter((l) => /\/ZHUJIAN:/.test(l))
    .map((l) => l.replace(/^\S+ \S+ +\d+ +\d+ +(\w) A00301\/[^/]+\/ZHUJIAN: /, "$1| "));
  // ⭐ 前端那半:ArkWeb 把 WebView 的 console 打进 `ARKWEB-CONSOLE`。**468 补的判例就在这里**。
  const web = all
    .filter((l) => /ARKWEB-CONSOLE/.test(l))
    .map((l) => l.replace(/^.*ARKWEB-CONSOLE:\s*/, ""));

  console.log(`\n── 壳(ZHUJIAN,${shell.length} 行)`);
  if (!shell.length) console.log("   ⚠ 一行都没有 —— 要么 app 没起来,要么捕获挂晚了。⛔ 别当「没事发生」。");
  for (const l of shell) console.log(`   ${l}`);

  console.log(`\n── 前端(ARKWEB-CONSOLE,${web.length} 行)`);
  if (!web.length) console.log("   (空 —— 这一轮前端没打 console;⛔ 这不等于前端没出错,只等于它没说话)");
  for (const l of web) console.log(`   ${l}`);

  console.log(`\n   全文:${file}`);
  return { shell, web };
};

// ---- 截图 -------------------------------------------------------------------

const shot = (stem) => {
  mkdirSync(outDir, { recursive: true });
  const local = join(outDir, `${stem}.jpeg`);
  sh("snapshot_display -f /data/local/tmp/ohd-shot.jpeg", { quiet: true });
  hdc(["file", "recv", "/data/local/tmp/ohd-shot.jpeg", local.replace(/\//g, "\\")], { quiet: true });
  console.log(`✔ 截图:${local}`);
  return local;
};

// ---- 一个动作 = 挂捕获 → 触发 → 等 → 收 → 截图 -------------------------------

const act = ({ stem, cmd, settle = 2500 }) => {
  const cap = startCapture(stem);
  sleep(1200); // 让 hilog 那条流先站住,否则动作那几行会漏在捕获之前
  if (cmd) sh(cmd, { quiet: true });
  sleep(settle);
  cap.stop();
  const r = report(cap.file);
  shot(stem);
  return r;
};

// ---- 入口 -------------------------------------------------------------------

const argv = process.argv.slice(2);
const [step] = argv;
const num = (v, what) => {
  const n = Number.parseInt(v ?? "", 10);
  if (Number.isNaN(n)) die(`${what} 要一个数,拿到的是 ${v ?? "<空>"}`);
  return n;
};
const stemOf = (name, fallback) => `${nextSeq()}-${name ?? fallback}`;

switch (step) {
  case "shot":
    shot(stemOf(argv[1], "shot"));
    break;

  case "tap": {
    const x = num(argv[1], "x");
    const y = num(argv[2], "y");
    act({ stem: stemOf(argv[3], `tap-${x}-${y}`), cmd: `uinput -T -c ${x} ${y}` });
    break;
  }

  case "swipe": {
    const [x1, y1, x2, y2] = [1, 2, 3, 4].map((i) => num(argv[i], `坐标 ${i}`));
    const ms = argv[5] ? num(argv[5], "毫秒") : 300;
    act({ stem: stemOf(argv[6], `swipe-${y1}-${y2}`), cmd: `uinput -T -m ${x1} ${y1} ${x2} ${y2} ${ms}` });
    break;
  }

  case "text": {
    const s = argv[1] ?? die("要打什么字?");
    // ⚠ `uinput -K -t` 只吃 ASCII —— 中文打不进去(要中文得靠剪贴板或前端注入,这一端两条都没有)。
    if (!/^[\x20-\x7e]*$/.test(s)) die(`uinput 只打得进 ASCII,这串里有别的字符:${s}`);
    act({ stem: stemOf(argv[2], "text"), cmd: `uinput -K -t '${s}'` });
    break;
  }

  case "key": {
    const code = num(argv[1], "键码");
    act({ stem: stemOf(argv[2], `key-${code}`), cmd: `uinput -K -d ${code} -u ${code}` });
    break;
  }

  case "clear": {
    // 退格 N 次。⛔ 调用方要先 tap 到框的**右侧空白**把光标带到末尾(见头注②)。
    const n = argv[1] ? num(argv[1], "次数") : 40;
    if (n < 1 || n > 200) die(`次数 ${n} 不像话(1..200)`);
    const one = "uinput -K -d 2055 -u 2055";
    act({ stem: stemOf(argv[2], `clear-${n}`), cmd: Array.from({ length: n }, () => one).join("; ") });
    break;
  }

  case "back":
    // 2 = 鸿蒙的返回键码(与安卓 KEYCODE_BACK 不同号,别照抄 4)。
    act({ stem: stemOf(argv[1], "back"), cmd: "uinput -K -d 2 -u 2" });
    break;

  case "watch":
    act({ stem: stemOf(argv[2], "watch"), cmd: null, settle: num(argv[1], "秒") * 1000 });
    break;

  case "restart": {
    const stem = stemOf(argv[1], "restart");
    const cap = startCapture(stem);
    sleep(1500);
    sh(`aa force-stop ${BUNDLE}`, { quiet: true });
    sleep(1500);
    sh(`aa start -a ${ABILITY} -b ${BUNDLE}`, { quiet: true });
    sleep(9000);
    cap.stop();
    report(cap.file);
    shot(stem);
    break;
  }

  default:
    die(`不认得的步骤:${step ?? "<空>"} —— 看本文件头注那张用法表`);
}
