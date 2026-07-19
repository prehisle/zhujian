// 朱笺安卓自动装机 —— 免每次截图估坐标。adb install -r 会卡在 vivo「外部来源应用」
// 安全拦截页;本脚本延时后按「设备分辨率标定过的固定坐标」点勾选框 + 继续安装,再轮询
// versionName 确认装成;装不上则自动截图 + 如实报错(绝不盲点完就宣布成功)。
//
// 用法:
//   node scripts/android-install-auto.mjs <apk路径> [--device <serial>] [--expect <版本>]
// 前置:adb 在 PATH;设备已 USB 调试授权;APK 与已装同签名、versionCode ≥ 已装。
//
// ⚠ 坐标是「设备分辨率 + 厂商系统版本」绑定的:换机/系统大更新可能漂移。新设备第一次
//   跑若超时,会把当前屏截到 .install-fail.png——照它量出勾选框/继续安装坐标,加进下面
//   GEOMETRY 表(键 = `adb shell wm size` 的 WxH)。只对自己的测试机 + 验收包用。
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";

const GEOMETRY = {
  // vivo V2352GA(1260×2800):实测三次一致。[x, y] 为物理像素。
  "1260x2800": { checkbox: [658, 2440], cont: [630, 2622] },
};

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
function focusHasInstaller() {
  const out = sh(["shell", "dumpsys", "window"]);
  return /mCurrentFocus=[^\n]*packageinstaller/i.test(out);
}

(async () => {
  device = deviceSerial();
  const geo = sh(["shell", "wm", "size"]).match(/Override size:\s*(\d+x\d+)|Physical size:\s*(\d+x\d+)/);
  const dim = (geo?.[1] || geo?.[2] || "").trim();
  const coords = GEOMETRY[dim];
  if (!coords) throw new Error(`未标定分辨率 ${dim}——先手动装一次量坐标,加进 GEOMETRY 表`);

  const beforeV = installedVersion();
  const beforeT = installedUpdateTime();
  console.log(`设备 ${device} / ${dim} / 现装 ${beforeV ?? "(无)"} → 安装 ${apk}`);

  // 后台起 install(会阻塞在弹窗);不 await
  const proc = spawn("adb", (device ? ["-s", device] : []).concat(["install", "-r", apk]), {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let installLog = "";
  proc.stdout.on("data", (d) => (installLog += d));
  proc.stderr.on("data", (d) => (installLog += d));

  // 等拦截页出现(最多 15s)
  let dialog = false;
  for (let i = 0; i < 30 && !dialog; i++) {
    await sleep(500);
    if (focusHasInstaller()) dialog = true;
  }
  if (dialog) {
    sh(["shell", "input", "keyevent", "KEYCODE_WAKEUP"]);
    // vivo 拦截页 focus 先到、内容后渲染:点太早会落空(勾选框没勾上→继续安装灰着不动)。
    // 先等渲染,再「勾选框 + 继续安装」为一组重试,直到 focus 离开 installer(=真点掉)。
    await sleep(2000);
    let dismissed = false;
    for (let a = 0; a < 5 && !dismissed; a++) {
      sh(["shell", "input", "tap", String(coords.checkbox[0]), String(coords.checkbox[1])]); // 风险确认框
      await sleep(700);
      sh(["shell", "input", "tap", String(coords.cont[0]), String(coords.cont[1])]); // 继续安装
      await sleep(1500);
      if (!focusHasInstaller()) dismissed = true;
    }
    console.log(dismissed ? "已自动点掉拦截页(勾选框+继续安装)" : "⚠ 多次尝试后拦截页仍在——坐标可能漂移");
  } else {
    console.log("未见拦截页(可能已直接安装或系统允许静默)——继续等结果");
  }

  // 轮询装成(versionName 或 lastUpdateTime 变化;有 --expect 则须等于它)
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const v = installedVersion(), t = installedUpdateTime();
    const changed = v !== beforeV || (t && t !== beforeT);
    if (changed && (!expect || v === expect)) {
      console.log(`✔ 安装成功:${v}(lastUpdateTime ${t})`);
      process.exit(0);
    }
  }

  // 超时:截图 + 如实报错
  try {
    const png = createWriteStream("g:/yj2026/zhujian/.install-fail.png");
    const cap = spawn("adb", (device ? ["-s", device] : []).concat(["exec-out", "screencap", "-p"]));
    cap.stdout.pipe(png);
    await new Promise((r) => cap.on("close", r));
  } catch {}
  console.error(`✘ 超时未确认装成。install 输出:\n${installLog.trim()}`);
  console.error("已截屏 .install-fail.png——核对弹窗是否变样、坐标是否需重标定。");
  process.exit(1);
})().catch((e) => {
  console.error("✘ " + e.message);
  process.exit(1);
});
