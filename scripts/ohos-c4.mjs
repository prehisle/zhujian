// 朱简鸿蒙端 C4 真机验收的**跑手**(OH-c/C4)。
//
// # 它为什么存在
//
// 鸿蒙这一端**没有 CDP、没有 WebDriver、私有区 hdc 也够不着** —— 安卓那套
// (skill `zhujian-android-verify` 的 CDP 断言)一条都用不上。今天唯一的两个抓手是:
//   ①`hdc shell uinput -T -c X Y` 按坐标点屏幕;②实时 `hdc shell hilog` 收日志。
// ⇒ 本脚本 = 把这两样编成「点一下 → 收该轮日志 → 存证」的循环。
//
// ⛔ **结论从日志里读,不从屏幕上读**(壳那边每条 C4 命令都 `log::info!("C4 …")` 一份)。
// 截图只作第二现场:出岔子时人看一眼,⛔ 别拿它当判据(认字既慢又脆)。
//
// ⛔ **别用 `hilog -x` 事后捞** —— 2026-08-23 实测那份里我们的行**一条都没有**
// (同一趟冷启,实时流里 `run() 进入 / WriterLease 已持 / catalog 就绪` 一条不少)。
// 这是这一端「不报错、只给一个别的答案」的又一形,栽过一次就够了。
//
// # 用法
//
//   node scripts/ohos-c4.mjs devices          认设备
//   node scripts/ohos-c4.mjs build            出验收包(= build-ohos.mjs --c4)
//   node scripts/ohos-c4.mjs fresh            **卸了重装**(格① 要的「全新安装」)
//   node scripts/ohos-c4.mjs install          覆盖装(不清数据)
//   node scripts/ohos-c4.mjs restart          force-stop → start,收启动那几行
//   node scripts/ohos-c4.mjs tap <1..13>      点第 n 枚 C4 按钮,收该轮日志
//   node scripts/ohos-c4.mjs shot [名字]      截一张图存 .zjshots/
//   node scripts/ohos-c4.mjs watch <秒>       只挂着收日志
//
// 每一趟的原始日志都落 `.zjshots/c4/` 下,**按序号 + 步骤名**命名(⛔ 别覆盖同名:
// memory `before-after-artifact-overwritten` —— 版本标记要进文件名,别靠事后改名)。

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, ".zjshots", "c4");
const BUNDLE = "app.zhujian.notebook";
const ABILITY = "EntryAbility";

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

// ---- hdc ------------------------------------------------------------------
//
// ⚠ 两个坑焊在这里,别在调用处再想一遍(memory `zhujian-ohos-feasibility-2026-07-17`):
//   ①`hdc` 的**远端**路径会被 MSYS 当本地路径转 ⇒ 全程 `MSYS_NO_PATHCONV=1`;
//   ②`hdc file send` 的**本地**路径不吃 Git Bash 的 `/tmp` 形,要 Windows 形。
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
  // ⚠ hdc 的退出码**不可信**(很多失败它照样退 0),所以判据一律放在**输出内容**上。
  // 同 memory `background-task-single-mechanism` 那条:退出码答的常是另一个问题。
  return out;
};
const sh = (cmd, opts) => hdc(["shell", cmd], opts);

// ---- 日志捕获 --------------------------------------------------------------
//
// ⚠ 子进程的 stdout **直接绑到文件描述符**上,不经 node 的事件循环 ——
// 否则一边 spawnSync 阻塞、一边等管道数据 = 自锁(memory `self-service-probe-sync-exec-deadlock`)。
let seq = 0;
const nextFile = (step) => {
  mkdirSync(outDir, { recursive: true });
  if (seq === 0) {
    const used = readdirSync(outDir).map((n) => Number.parseInt(n, 10)).filter((n) => !Number.isNaN(n));
    seq = used.length ? Math.max(...used) : 0;
  }
  seq += 1;
  return join(outDir, `${String(seq).padStart(3, "0")}-${step}.log`);
};

const startCapture = (step) => {
  const file = nextFile(step);
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
  // 这件事散在两种时间轴上。Atomics.wait 是 node 里唯一不烧 CPU 的同步睡眠。
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
};

/// 把这一轮里我们自己的行挑出来(⛔ 别打印整份:一趟 8 秒就上万行系统日志)。
const ours = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => /\/ZHUJIAN:|C4-JS/.test(l))
    .map((l) => l.replace(/^\S+ \S+ +\d+ +\d+ +(\w) A00301\/[^/]+\/ZHUJIAN: /, "$1| "));

const report = (file) => {
  const lines = ours(file);
  console.log(`\n── 这一轮我们的日志(${lines.length} 行;全文 ${file})`);
  if (!lines.length) {
    console.log("   ⚠ 一行都没有 —— 要么 app 没起来,要么捕获挂晚了。⛔ 别当「没事发生」。");
  }
  for (const l of lines) console.log(`   ${l}`);
  return lines;
};

// ---- 按钮坐标 --------------------------------------------------------------
//
// ⚠⚠ **这三个数是量出来的,不是算出来的** —— CSS px 与屏幕物理像素之间隔着一个
// 这台设备自己的缩放比,而那个比值我们问不到(没有 CDP)。
// ⇒ 用法:`node scripts/ohos-c4.mjs shot calib` 截一张图,**人肉读一次**第 1 枚与第 2 枚
// 按钮的中心 y,填回下面;`STRIDE` = 两者之差。**改了 index.html 的版式就要重量一次**。
// ⭐ 版式那边已经写死了「按钮定高、通栏、零外边距、排在最前、读数只往下方写」四条,
// 就是为了让这三个数**稳定**(读数变长不会推动按钮)。
// 2026-08-23 在 Mate 60 Pro(1260×2720)上量的:
//   1 CSS px ≈ **3.23** 物理像素,顶上另有 ≈**119** 物理像素的状态栏内缩
//   ⇒ 第 n 枚中心 y = 119 + (60 + (n-1)×48 + 24) × 3.23
// ⭐ **这两个数有活的自检**:点第 n 枚之后,日志里会说它跑的是哪条命令 ——
//    点 3 却看见 `C4 schema` 就是坐标歪了,⛔ 别靠肉眼比对截图。
const TAP_X = 630; // 屏宽 1260 的中线;按钮通栏,x 取中间
const FIRST_Y = 390; // 第 1 枚按钮中心 y
const STRIDE = 155; // 相邻两枚中心 y 之差(48 CSS px × 3.23)

const tapY = (n) => {
  if (!FIRST_Y || !STRIDE) {
    die(
      "按钮坐标还没量过(FIRST_Y / STRIDE 是 0)——\n" +
        "   先 `node scripts/ohos-c4.mjs shot calib`,读出第 1、2 枚按钮的中心 y,填进本文件。\n" +
        "   ⛔ 别拿 CSS 里那两个数(140 / 110)直接当物理像素:中间隔着设备缩放比。",
    );
  }
  return FIRST_Y + (n - 1) * STRIDE;
};

// ---- 步骤 ------------------------------------------------------------------

const buildHap = () => {
  const r = spawnSync("node", [join(repoRoot, "scripts", "build-ohos.mjs"), "--c4"], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (r.status !== 0) die(`出包失败(退出码 ${r.status ?? r.signal})`);
};

const hapPath = join(
  repoRoot,
  "ohos/src-tauri/gen/ohos/entry/build/default/outputs/default/entry-default-signed.hap",
);

const install = ({ fresh }) => {
  if (!existsSync(hapPath)) die(`没有签名 HAP:${hapPath}(先 \`node scripts/ohos-c4.mjs build\`)`);
  if (fresh) {
    // 格① 要的是**全新安装**:卸载连数据一起走,私有区从零开始。
    console.log(sh(`bm uninstall -n ${BUNDLE}`, { quiet: true }).trim());
  }
  hdc(["file", "send", hapPath.replace(/\//g, "\\"), "/data/local/tmp/zj-c4.hap"]);
  const out = sh(`bm install -p /data/local/tmp/zj-c4.hap`, { quiet: true });
  process.stdout.write(out);
  if (!/install bundle successfully/.test(out)) die(`装机没说成功 —— 原话在上面,⛔ 别接着跑`);
};

const restart = (label = "restart") => {
  const cap = startCapture(label);
  sleep(1500); // 让 hilog 那条流先站住,否则启动那几行会漏在捕获之前
  sh(`aa force-stop ${BUNDLE}`, { quiet: true });
  sleep(1500);
  sh(`aa start -a ${ABILITY} -b ${BUNDLE}`, { quiet: true });
  sleep(9000);
  cap.stop();
  return report(cap.file);
};

const tap = (n) => {
  const y = tapY(n);
  const cap = startCapture(`tap${String(n).padStart(2, "0")}`);
  sleep(1500);
  sh(`uinput -T -c ${TAP_X} ${y}`, { quiet: true });
  // ⚠ 备份那一格(第 5 枚)会真跑一趟 VACUUM INTO + 加密 + 恢复 ⇒ 等久一点。
  sleep(n === 5 ? 40000 : 9000);
  cap.stop();
  return report(cap.file);
};

const shot = (name = "shot") => {
  mkdirSync(outDir, { recursive: true });
  const local = join(outDir, `${name}.jpeg`);
  sh("snapshot_display -f /data/local/tmp/c4-shot.jpeg", { quiet: true });
  hdc(["file", "recv", "/data/local/tmp/c4-shot.jpeg", local.replace(/\//g, "\\")], { quiet: true });
  console.log(`✔ 截图:${local}`);
};

// ---- 入口 ------------------------------------------------------------------

const [step, arg] = process.argv.slice(2);
switch (step) {
  case "devices":
    hdc(["list", "targets"]);
    break;
  case "build":
    buildHap();
    break;
  case "fresh":
    install({ fresh: true });
    restart("fresh-boot");
    break;
  case "install":
    install({ fresh: false });
    restart("install-boot");
    break;
  case "restart":
    restart();
    break;
  case "tap":
    tap(Number.parseInt(arg ?? "", 10) || die("要点第几枚?`tap 1` .. `tap 13`"));
    break;
  case "shot":
    shot(arg);
    break;
  case "watch": {
    const secs = Number.parseInt(arg ?? "10", 10);
    const cap = startCapture("watch");
    sleep(secs * 1000);
    cap.stop();
    report(cap.file);
    break;
  }
  default:
    die(`不认得的步骤:${step ?? "<空>"} —— 看本文件头注那张用法表`);
}
