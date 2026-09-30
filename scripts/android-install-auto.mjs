// 朱笺安卓自动装机 —— adb install -r 会卡在 vivo 拦截页;本脚本**按控件认**(uiautomator dump 读拦截页的
// 控件 id / 文字 / 勾没勾 / bounds)一步步点掉,再轮询 versionName/lastUpdateTime 确认装成;装不上则
// 自动截图 + 如实报错(绝不盲点完就宣布成功)。拦截页有两种,谁出来点谁:
//   · 「外部来源」风险页 → 勾「已了解应用的风险检测结果」(`…:id/deleted_file_state_cb`)→ 继续安装;
//   · 同 versionCode 反装时部分 ROM 先弹「已安装相同版本」(PackageInterceptActivity)→ 重新安装。
//
// 用法:
//   node scripts/android-install-auto.mjs <apk路径> [--device <serial>] [--expect <版本>]
// 前置:adb 在 PATH;设备已 USB 调试授权、**亮屏且已解锁**;APK 与已装同签名、versionCode ≥ 已装。
//
// ⭐ 793 起不再按「分辨率标定的固定坐标」点(那张 GEOMETRY 表撤了)。那一趟 V2352GA 上两处都变了:
//   ①风险页先「安全守护正在深度检测…」五六秒,勾选框与按钮这时还没画出来 —— 旧版等 2 秒就点,落空;
//   ②有一次页底多一行「继续安装第三方应用需身份验证…」,整页上移约 140px,表里的坐标全落在空白处。
//   拦截页是原生页,dump 给得出真 bounds(⚠ 与朱简自己那页相反:WebView 子树在这台上 bounds 全零)⇒ 每拍现读现点,
//   页面怎么排都跟得上;认不出就不点,等到超时截图报错。⛔ 别再把坐标写回来当兜底(两套机制 = 两种失灵)。
// ⚠ dump 用固定文件名、**每次先删再写** —— dump 失败时设备上会留着上一次的旧文件(V1986A 上撞过),读到旧 xml
//   就是对着过去的屏幕点。⚠ 从 Git Bash 手敲同样的 `adb shell uiautomator dump /sdcard/…` 要带 MSYS_NO_PATHCONV=1,
//   否则路径被改成 `/Files/Git/sdcard/…`、`cat` 读到的正是旧文件(793 手工那趟实撞);本脚本走 execFileSync,不经 MSYS。
// ⚠ 要身份验证(锁屏密码 / 指纹)的那一步只有机主能过:点完「继续安装」若转去了验证页,本脚本不碰,超时后截图报错。
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { fileURLToPath } from "node:url";

const [, , apk, ...rest] = process.argv;
if (!apk) {
  console.error("用法: node scripts/android-install-auto.mjs <apk路径> [--device serial] [--expect 版本]");
  process.exit(2);
}
let device = null, expect = null;
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === "--device") device = rest[++i];
  else if (rest[i] === "--expect") expect = rest[++i];
}

const sh = (args) => execFileSync("adb", device ? ["-s", device, ...args] : args, { encoding: "utf8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PKG = "app.zhujian.notebook";
const INSTALLER = "com.android.packageinstaller";
const DUMP = "/sdcard/zj-install-ui.xml";
// 失败截图落仓根(.gitignore 已收)。⛔ 别写死盘符:从前写死 g:/yj2026/zhujian,换到仓在别处的机器上
// 超时那步 createWriteStream 抛 ENOENT 直接崩,截图和「超时未确认装成」那句都没了。
const FAIL_PNG = fileURLToPath(new URL("../.install-fail.png", import.meta.url));
// 深度检测五六秒 + 装机本身 + 每拍一次 dump(约 1–2 秒)。
const DEADLINE_MS = 60000;

function deviceSerial() {
  if (device) return device;
  const out = execFileSync("adb", ["devices"], { encoding: "utf8" });
  const lines = out.split("\n").slice(1).map((l) => l.trim()).filter((l) => l.endsWith("\tdevice"));
  if (lines.length !== 1) throw new Error(`需恰好一台设备(现 ${lines.length} 台),用 --device 指定`);
  return lines[0].split("\t")[0];
}
function installedVersion() {
  const out = sh(["shell", "dumpsys", "package", PKG]);
  return out.match(/versionName=(\S+)/)?.[1] ?? null;
}
function installedUpdateTime() {
  const out = sh(["shell", "dumpsys", "package", PKG]);
  return out.match(/lastUpdateTime=(.+)/)?.[1]?.trim() ?? null;
}
function topActivity() {
  const out = sh(["shell", "dumpsys", "activity", "activities"]);
  return out.match(/topResumedActivity=[^\n]*/)?.[0]?.trim() ?? "(问不出)";
}
/** 当前屏上的控件(只要拦截页那个包的)。dump 不成就回空表 —— 这一拍不点,下一拍再问。 */
function installerNodes() {
  let xml;
  try {
    sh(["shell", "rm", "-f", DUMP]);
    sh(["shell", "uiautomator", "dump", DUMP]);
    xml = sh(["shell", "cat", DUMP]);
  } catch {
    return [];
  }
  return [...xml.matchAll(/<node [^>]*>/g)]
    .map(([n]) => {
      const a = (k) => n.match(new RegExp(` ${k}="([^"]*)"`))?.[1] ?? "";
      const b = a("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      const c = b ? [Math.round((+b[1] + +b[3]) / 2), Math.round((+b[2] + +b[4]) / 2)] : null;
      return { pkg: a("package"), id: a("resource-id"), text: a("text"), checked: a("checked") === "true", c };
    })
    .filter((n) => n.pkg === INSTALLER && n.c && (n.c[0] > 0 || n.c[1] > 0));
}
const tap = ([x, y]) => sh(["shell", "input", "tap", String(x), String(y)]);

(async () => {
  device = deviceSerial();
  const beforeV = installedVersion();
  const beforeT = installedUpdateTime();
  console.log(`设备 ${device} / 现装 ${beforeV ?? "(无)"} → 安装 ${apk}`);
  sh(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);

  // 后台起 install(会阻塞在拦截页);不 await
  const proc = spawn("adb", (device ? ["-s", device] : []).concat(["install", "-r", apk]), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let installLog = "";
  proc.stdout.on("data", (d) => (installLog += d));
  proc.stderr.on("data", (d) => (installLog += d));

  // 每拍:先问装成没有(versionName 或 lastUpdateTime 变了;有 --expect 则须等于它),没成就读一次拦截页、点下一步。
  // 一拍只点一下,点完回头再读 —— 勾选框勾没勾、按钮亮没亮都以下一次 dump 为准,不信「刚才点过了」。
  const steps = [];
  const t0 = Date.now();
  while (Date.now() - t0 < DEADLINE_MS) {
    const v = installedVersion(), t = installedUpdateTime();
    if ((v !== beforeV || (t && t !== beforeT)) && (!expect || v === expect)) {
      console.log(`✔ 安装成功:${v}(lastUpdateTime ${t});拦截页上点过:${steps.join(" → ") || "(没弹拦截页)"}`);
      process.exit(0);
    }
    const nodes = installerNodes();
    const reinstall = nodes.find((n) => n.text === "重新安装");
    const box = nodes.find((n) => /:id\/deleted_file_state_cb$/.test(n.id));
    const go = nodes.find((n) => n.text === "继续安装" || n.id === "android:id/button1");
    if (reinstall) {
      tap(reinstall.c);
      steps.push("重新安装");
    } else if (box && !box.checked) {
      tap(box.c);
      steps.push("勾选");
    } else if (box && go) {
      tap(go.c);
      steps.push("继续安装");
    }
    await sleep(1000);
  }

  // 超时:截图 + 如实报错
  try {
    const png = createWriteStream(FAIL_PNG);
    const cap = spawn("adb", (device ? ["-s", device] : []).concat(["exec-out", "screencap", "-p"]));
    cap.stdout.pipe(png);
    await new Promise((r) => cap.on("close", r));
  } catch {}
  console.error(`✘ ${DEADLINE_MS / 1000}s 内没确认装成。拦截页上点过:${steps.join(" → ") || "(一下没点 —— dump 没认出勾选框 / 按钮)"}`);
  console.error(`  最上面的 activity:${topActivity()}`);
  console.error(`  install 输出:${installLog.trim() || "(无)"}`);
  console.error(`  已截屏 ${FAIL_PNG} —— 若是身份验证 / 锁屏页,那一步只有机主能过;若拦截页换了控件,照 dump 改本脚本认的 id / 文字。`);
  process.exit(1);
})().catch((e) => {
  console.error("✘ " + e.message);
  process.exit(1);
});
