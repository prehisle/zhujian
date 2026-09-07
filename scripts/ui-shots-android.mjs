// 手机端全页截图巡检(用户面 74 格 ① 的**安卓半**;桌面那半是 `ui-shots-desktop.mjs`,619)。
// 按写死的清单把手机端每个静态面 × 明暗 × 竖横各截一张,产物落 `.zjshots/<轮次>/android/`,
// 从此当「改手机端 UI 的视觉回归基线」用。
//
// ⭐ 它解决的是门禁解决不了的那一格:六道 CSS/i18n 门禁守的是**值级**漂移,而「同一个动作在两页
//   长得不一样」「空态节奏不齐」只有并排看图才看得见(memory `gates-green-is-not-looks-right`)。
//   ⛔ 所以它**不是门禁**:它不判绿,只产图 + 一份 manifest。
//
// 怎么跑(要一台装着 **devtools 构建**的设备;发版包 WebView 不可调试):
//   node scripts/android-cdp.mjs forward                  # 先建 tcp:9222(找 socket 那段焊着 490 判例)
//   node scripts/ui-shots-android.mjs .zjshots/629/android
//   node scripts/ui-shots-android.mjs .zjshots/629/android --only dark-topics   # 调试单张
//
// # ⛔ 知情边界(⛔ 别把这批图读成「手机端全貌」)
//  ① **内容是那台设备当时的真实数据**(桌面那半是 `YS_DB_PATH` 起隔离库播的演示数据,手机上没有
//     那条路 —— 设备上的库就是用户的库)。⇒ 这批图是**布局与配色**的基线,⛔ 不是像素级可比的
//     基线,也别拿它做 pixel diff:换一台设备、或过几天数据变了,同一个面照出来就不一样。
//     ⭐ 反过来它**整趟只读**:只切面、只改 `<html data-theme>` 这一个属性、只加 `Emulation` 视口
//     覆盖,收尾全部还原 —— 一个字都不往用户的库里写。别为了「好看」给它加播种。
//  ② **横屏那半是真转屏**(`settings put system user_rotation`,收口还原)—— ⛔ 别改回
//     `Emulation.setDeviceMetricsOverride`:那条路在这台上会安静地产出一批**平铺的废图**,
//     理由焊在下面转屏那段的注释里。⚠ 代价是转屏会让 Activity 重来一趟(app 回到默认面),
//     所以每转一次都要重连 CDP、重新驱面。
//  ③ **只有静态面、只有视口那一屏**:瞬态(toast / 两拍确认条 / 卡片操作面板 / 看大图 / 软键盘
//     避让 / 拖拽 / 错误态)一张都没有;长页面滚动之下的部分也没有。
//  ④ **语言只有设备当前那一档**:切语言要写 `localStorage` 再 reload,那就不是只读了 ⇒ 一期不做。
//  ⑤ 明暗是直接改 `<html data-theme>`(CSS 的唯一真相源,见 `android/src/theme.ts`)⇒ 系统状态栏
//     那半(`__zhujianSystemBars`)不跟着变,截图里也看不见它。
import { execFileSync } from "node:child_process";
import { mkdirSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PKG = "app.zhujian.notebook";

const argv = process.argv.slice(2);
const outDir = argv.find((a) => !a.startsWith("--"));
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : null;
const port = Number(argv.includes("--port") ? argv[argv.indexOf("--port") + 1] : 9222);
const allowStale = argv.includes("--allow-stale");
if (!outDir) {
  console.error(
    "用法: node scripts/ui-shots-android.mjs <产物目录> [--only <子串>] [--port N] [--allow-stale]\n" +
      "  例: node scripts/ui-shots-android.mjs .zjshots/629/android",
  );
  process.exit(1);
}

const adb = (args) => execFileSync("adb", args, { encoding: "utf8" });

// ---- 清单:8 个静态面 × 明暗 × 竖横 = 32 张 ---------------------------------
// `open` 是**页面内**要点的那枚真控件(⛔ 别直接改 hidden:`openPane` 还管着确认条作废 /
// history 层 / 各面自己的 load,绕过它截出来的是个没加载完的壳)。
// `ready` 是「这个面真的在屏上了」的判据 —— 驱动完不核一眼,截出来的可能是上一个面。
const FACES = [
  { key: "ideas", label: "随记(时间轴)", mode: "ideas" },
  { key: "tasks", label: "任务(看板)", mode: "tasks" },
  { key: "topics", label: "标签", opener: "#topics-toggle", pane: "topics-pane" },
  { key: "search", label: "搜索", opener: "#search-toggle", pane: "search-pane" },
  { key: "sync", label: "同步", opener: "#sync-toggle", pane: "sync" },
  { key: "settings", label: "设置", opener: "#settings-toggle", pane: "settings-pane" },
  { key: "trash", label: "回收站", opener: '#bottombar [data-pane="trash"]', pane: "trash-pane" },
  { key: "sealed", label: "归档册", opener: '#bottombar [data-pane="sealed"]', pane: "sealed-pane" },
];

// ---- 前置:设备、包、产物鲜度 -------------------------------------------------
/** ⛔ **app 不在前台 = CDP 整个不答**(629 自己撞到:跑到一半用户拿起手机开了微信,`/json`
 *  直接 headers timeout,而报出来的是一行 `TypeError: fetch failed` —— 跟「app 在后台」毫无字面
 *  关系)。手机端 runtime 只在前台跑,这是 skill zhujian-android-verify 早就写着的事实
 *  ⇒ 开跑前先问一句「前台是谁」,把话说清楚,⛔ 别让人对着 undici 的堆栈猜。 */
function assertForeground() {
  const focus = adb(["shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]);
  if (focus.includes(PKG)) return;
  throw new Error(
    `朱笺不在前台,CDP 不会答(手机端 runtime 只在前台跑)。当前:\n${focus.trim()}\n` +
      `  ⇒ adb shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`,
  );
}

function deviceInfo() {
  const serial = adb(["get-serialno"]).trim();
  const model = adb(["shell", "getprop", "ro.product.model"]).trim();
  const wm = adb(["shell", "wm", "size"]).trim();
  const dump = adb(["shell", "dumpsys", "package", PKG]);
  const versionName = dump.match(/versionName=(\S+)/)?.[1] ?? null;
  const lastUpdate = dump.match(/lastUpdateTime=(.+)/)?.[1]?.trim() ?? null;
  if (!versionName) throw new Error(`设备上没有 ${PKG} —— 先装 devtools 包(skill zhujian-android-verify 流程 A)`);
  return { serial, model, wm, versionName, lastUpdate };
}

/** 前端源里最新的那一笔改动时刻。⚠ 只用来跟设备上的 lastUpdateTime 比个先后。 */
function newestFrontendMtime() {
  let newest = { path: null, ms: 0 };
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const ms = statSync(p).mtimeMs;
        if (ms > newest.ms) newest = { path: p, ms };
      }
    }
  };
  walk(join(root, "android/src"));
  const idx = statSync(join(root, "android/index.html"));
  if (idx.mtimeMs > newest.ms) newest = { path: join(root, "android/index.html"), ms: idx.mtimeMs };
  return newest;
}

/** ⛔ 产物早于改动 = 截出一批「看着正常的旧界面」还以为验过了(memory `verify-artifact-predates-fix`)。
 *  ⚠ 判据是**两个时钟的比较**,而设备的时钟不一定跟宿主同步(MuMu 实测慢十几小时)⇒ 拒的时候
 *  把两个读数都印出来,真是时钟问题就 `--allow-stale`,⛔ 别把这道检查删了。 */
function assertFresh(dev) {
  const newest = newestFrontendMtime();
  const devMs = dev.lastUpdate ? Date.parse(dev.lastUpdate) : NaN;
  const stale = Number.isFinite(devMs) && devMs < newest.ms;
  const readings =
    `  设备上这只包装于:${dev.lastUpdate}\n` +
    `  前端最新改动:    ${new Date(newest.ms).toString()}  (${newest.path.slice(root.length + 1)})`;
  if (stale && !allowStale) {
    throw new Error(
      `设备上的包比前端源**旧** —— 截出来的会是旧界面。\n${readings}\n` +
        "  ⇒ 重建装机(skill zhujian-android-verify 流程 A);确认只是两台机器时钟差,才加 --allow-stale。",
    );
  }
  console.log(`产物鲜度:${stale ? "⚠ 设备上的包看着更旧(--allow-stale 放行)" : "ok"}\n${readings}`);
  return { newestSrc: newest.path.slice(root.length + 1), newestSrcAt: new Date(newest.ms).toISOString(), stale };
}

// ---- 页面内的驱动与判据(全部只读,除了 data-theme 这一个属性) --------------
const JS_STATE = `(() => {
  const vis = [...document.querySelectorAll("section.sync")].find((s) => !s.hidden);
  return {
    pane: vis ? vis.id : null,
    mode: document.querySelector('#bottombar [data-mode].active')?.dataset.mode ?? null,
    paneOpen: document.body.classList.contains("pane-open"),
    theme: document.documentElement.dataset.theme ?? null,
    w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio,
  };
})()`;

const jsGoto = (face) => `(() => {
  const q = (s) => document.querySelector(s);
  const st = () => ({
    pane: [...document.querySelectorAll("section.sync")].find((s) => !s.hidden)?.id ?? null,
    mode: q('#bottombar [data-mode].active')?.dataset.mode ?? null,
    open: document.body.classList.contains("pane-open"),
  });
  const s = st();
  ${
    face.mode
      ? `// 主视图:只在「有面开着」或「模式不对」时才点 —— 已经停在这个模式又没开面时再点一下,
     // onModeButton 会去 focus 捕获框,软键盘就上来了(那不是这批图要的样子)。
     if (s.open || s.mode !== ${JSON.stringify(face.mode)}) q('#bottombar [data-mode="${face.mode}"]').click();`
      : `// 面:openPane 自己处理「面换面」;已经开着这一面就别再点(那一下是收)。
     if (s.pane !== ${JSON.stringify(face.pane)}) q(${JSON.stringify(face.opener)}).click();`
  }
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  return st();
})()`;

const jsReady = (face) =>
  face.mode
    ? `(() => !document.body.classList.contains("pane-open")
        && document.querySelector('#bottombar [data-mode].active')?.dataset.mode === ${JSON.stringify(face.mode)})()`
    : `(() => { const el = document.getElementById(${JSON.stringify(face.pane)}); return !!el && !el.hidden; })()`;

// ---- 跑 ----------------------------------------------------------------------
const dir = resolve(root, outDir);
mkdirSync(dir, { recursive: true });

const dev = deviceInfo();
assertForeground();
console.log(`设备:${dev.model} / ${dev.serial} / ${dev.wm} / ${PKG} ${dev.versionName}`);
const fresh = assertFresh(dev);

// ⛔⛔ **横屏那半必须真转屏,`Emulation.setDeviceMetricsOverride` 在这台上是个陷阱**(629 实撞):
//   覆盖之后 DOM **真的重排了**(`innerWidth` 从 360 变 800、`clientWidth` 同步),可
//   `Page.captureScreenshot` 截出来的是**把 360 宽那张surface 横向平铺两遍多**的图 ——
//   页头「朱简」在一张图里出现三次。`captureBeyondViewport: true` + 显式 `clip` 两条路都一样。
//   ⇒ 安卓 WebView 的合成 surface 不跟着覆盖走。**「重排了」证不了「截得对」**,别再试这条路。
//   ⇒ 走 `settings put system user_rotation`(先关自动旋转),⚠ 那是用户手机上的系统设置:
//   开跑前读原值,收口 `finally` 里放回去并回读确认。
const rotationNow = () => ({
  accel: adb(["shell", "settings", "get", "system", "accelerometer_rotation"]).trim(),
  user: adb(["shell", "settings", "get", "system", "user_rotation"]).trim(),
});
const setRotation = (r) => {
  adb(["shell", "settings", "put", "system", "accelerometer_rotation", "0"]);
  adb(["shell", "settings", "put", "system", "user_rotation", String(r)]);
};

const origRotation = rotationNow();
console.log(`屏幕方向原值:accelerometer_rotation=${origRotation.accel} user_rotation=${origRotation.user}`);

const shots = [];
let base = null;
let originalTheme = null;
let cdp = null;
try {
  for (const o of [
    { key: "portrait", rotation: 0, wide: false },
    { key: "landscape", rotation: 1, wide: true },
  ]) {
    setRotation(o.rotation);
    await sleep(2500); // 转屏会让 Activity 重来一趟,WebView 的 devtools target 也可能换
    // 转完重连:target 可能已经不是刚才那条(⛔ 别复用旧会话,它会静默地不答)
    if (cdp) cdp.close();
    cdp = await openSession((await pageTarget(port)).webSocketDebuggerUrl);
    const vp = await cdp.evaluate(JS_STATE);
    if (!base) {
      base = vp;
      originalTheme = vp.theme;
      console.log(`页面:${vp.w}×${vp.h} @${vp.dpr}  当前 ${vp.mode ?? vp.pane} / ${vp.theme}`);
    }
    // 自证前置:真转过去了没有。⛔ 少了这一句,上面那个平铺陷阱就会安静地产出一批废图。
    if (o.wide !== vp.w > vp.h) {
      throw new Error(`${o.key} 没转成:视口 ${vp.w}×${vp.h}(期望 ${o.wide ? "宽>高" : "高>宽"})`);
    }
    console.log(`${o.key}:视口 ${vp.w}×${vp.h}`);
    for (const theme of ["light", "dark"]) {
      // CSS 只认 <html data-theme>(theme.ts 是唯一真相源)⇒ 直接改它,不碰 localStorage。
      await cdp.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; })()`);
      for (const face of FACES) {
        const name = `${o.key}-${theme}-${face.key}`;
        if (only && !name.includes(only)) continue;
        await cdp.evaluate(jsGoto(face));
        await sleep(500); // 各面自己 load 一趟(列表都是异步 invoke 回来才长出来)
        if (!(await cdp.evaluate(jsReady(face)))) {
          throw new Error(`驱不到「${face.label}」这个面 —— 当前态 ${JSON.stringify(await cdp.evaluate(JS_STATE))}`);
        }
        const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(join(dir, `${name}.png`), Buffer.from(data, "base64"));
        shots.push({ name, face: face.label, orient: o.key, theme, w: vp.w, h: vp.h });
        console.log(`  ✔ ${name}.png`);
      }
    }
  }
} finally {
  // 还原:屏幕方向放回去、主题属性放回去。⛔ 一步都不能省 —— 这是用户日常在用的那台。
  adb(["shell", "settings", "put", "system", "user_rotation", origRotation.user]);
  adb(["shell", "settings", "put", "system", "accelerometer_rotation", origRotation.accel]);
  const back = rotationNow();
  console.log(`屏幕方向已还原:accelerometer_rotation=${back.accel} user_rotation=${back.user}`);
  if (back.accel !== origRotation.accel || back.user !== origRotation.user) {
    console.error("✗✗ 屏幕方向没还原成功 —— 自己去手机上把自动旋转打开");
  }
  try {
    if (cdp && originalTheme) {
      await cdp.evaluate(`(() => { document.documentElement.dataset.theme = ${JSON.stringify(originalTheme)}; })()`);
    }
  } catch { /* 同上 */ }
  if (cdp) cdp.close();
}

const manifest = {
  tool: "ui-shots-android.mjs",
  at: new Date().toISOString(),
  device: dev,
  viewport: { cssW: base.w, cssH: base.h, dpr: base.dpr },
  freshness: fresh,
  gitHead: execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  shots,
};
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\n共 ${shots.length} 张,落在 ${outDir}(manifest.json 记着设备、视口、gitHead)`);
