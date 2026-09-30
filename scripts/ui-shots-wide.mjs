// 手机端宽屏截图巡检(平板横竖 + 手机横放;tablet-plan 格 1)。手机竖放两档一起出,当对照组。
//
// 在这台 Windows 上把安卓壳按「桌面构型」起一只**隔离**的隐藏窗口(`tauri dev`,前端由 vite 从工作树现拼 ⇒
// 截到的恒是当前源码,不存在「产物早于改动」),灌展示库 + 几条长短不一的随记,按写死的尺寸 × 面出图,
// 另存一份几何读数 `manifest.json`,改前改后两份用 `--compare` 逐个比。
//
//   node scripts/ui-shots-wide.mjs .zjshots/<轮次>/wide                     # 全套
//   node scripts/ui-shots-wide.mjs <目录> --only land-1440,phone             # 只出名字含这几串的
//   node scripts/ui-shots-wide.mjs <目录> --keep                             # 跑完不杀,接着手工 CDP(端口见下);⛔ 用完自己杀
//   node scripts/ui-shots-wide.mjs --compare <改前>/manifest.json <改后>/manifest.json [--only phone]
//
// ⛔⛔ **隔离靠换 identifier**:安卓壳的 identifier 与桌面 app 同为 `app.zhujian.notebook` ⇒ 裸跑
//   `cd android && npm run tauri dev` 在 Windows 上开的就是**桌面那份真库**(%APPDATA%\app.zhujian.notebook)。
//   本工装一律 `--config` 换成 `app.zhujian.wideshots`,每趟开跑先清掉它自己那两个目录 ⇒ 每趟的数据逐条相同。
// 窗口 `visible:false`:`Page.captureScreenshot` 照样出图,整趟不抢前台(同 ui-shots-desktop 的形)。
//
// # 知情边界(⛔ 别把这批图读成「平板上就长这样」)
//  ① 引擎是 WebView2(Edge 13x),不是平板上的 ArkWeb / 安卓 WebView ⇒ 证的是**排法**,⛔ 不证老引擎认不认
//     某条 CSS(mobile.md 643:MuMu 是 Chrome 110)。真机那半在 tablet-plan 格 4 / 格 6。
//  ② 尺寸靠 `Emulation.setDeviceMetricsOverride`(dpr 1)⇒ 没有状态栏 / 挖孔 / 手势条,`--sat` 与安全区恒 0。
//  ③ 每张都从重载起(随记面、没有开着的层)。⛔ 别对**当前面**再点一次底栏 —— 那是「一步回捕获」,会开记一笔
//     (本工装的草稿就栽在这:一整批图上都盖着记一笔)。
//  ④ 数据的日期全是「今天」(造不出别的日子)⇒ 随记只有一个天分组;截止日期按今天现算,文字每天变,几何不变。
//  ⑤ 设置面底部「关于」里有构建身份戳:工作树有未提交改动时那一行多一句「含未提交改动」、折成两行 ⇒ 设置面高 +20。
//     ⇒ 改前 / 改后两趟要在**同一种脏净状态**下跑(改前在干净树上跑的,改后就提交之后再跑),否则 phone-*-settings
//     两张会报「不同」而与本轮改动无关(tablet-plan 格 2 实撞:改前干净、改后带着改动,差的正是这一行)。
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";
import { SHOWCASE, seedScript } from "./lib/showcase.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
const pick = (name) => !only || only.some((o) => name.includes(o));

// ---- 比对模式:两份 manifest 逐张逐字段比 --------------------------------------
if (argv[0] === "--compare") {
  const [a, b] = [argv[1], argv[2]].map((p) => JSON.parse(readFileSync(p, "utf8")));
  let diff = 0;
  for (const name of Object.keys(a.shots).filter(pick)) {
    if (!b.shots[name]) {
      console.log(`✗ ${name}:改后没有这张`);
      diff++;
      continue;
    }
    const x = JSON.stringify(a.shots[name].geo);
    const y = JSON.stringify(b.shots[name].geo);
    if (x === y) console.log(`= ${name}`);
    else {
      diff++;
      console.log(`≠ ${name}`);
      for (const k of Object.keys(a.shots[name].geo)) {
        const p = JSON.stringify(a.shots[name].geo[k]);
        const q = JSON.stringify(b.shots[name].geo[k]);
        if (p !== q) console.log(`    ${k}: ${p}\n    ${" ".repeat(k.length)}→ ${q}`);
      }
    }
  }
  console.log(diff ? `\n${diff} 张不同` : "\n全部相同");
  process.exit(diff ? 1 : 0);
}

if (process.platform !== "win32") throw new Error("本工装只在 Windows 上跑(隐藏窗 + WebView2 CDP);这台是 " + process.platform);
const outDir = argv.find((a) => !a.startsWith("--") && !(only && a === argv[argv.indexOf("--only") + 1]));
if (!outDir) {
  console.error("用法见头注:node scripts/ui-shots-wide.mjs <产物目录> [--only 串,串] [--keep]");
  process.exit(1);
}
const KEEP = argv.includes("--keep");
const PORT = 9245;
const VITE_PORT = 1420; // android/vite.config.ts 的 strictPort;桌面那只 `npm run tauri dev` 也用它
const ID = "app.zhujian.wideshots";

// ---- 尺寸 × 面(清单写死;加一行就是多一批图)---------------------------------------
const SIZES = [
  ["land-1440x960", 1440, 960],
  ["land-1280x800", 1280, 800],
  ["port-960x1440", 960, 1440],
  ["port-800x1280", 800, 1280],
  ["phland-800x360", 800, 360],
  ["phland-915x412", 915, 412],
  ["phone-360x800", 360, 800], // 对照组:手机竖放每格都要证「与改前相同」
  ["phone-412x915", 412, 915],
];
const LIST_TASK = SHOWCASE.zh.tasks.find(([title]) => title.includes("\n"))[0].split("\n")[0];
const FACES = {
  ideas: null,
  tasks: `document.querySelector('#bottombar [data-mode="tasks"]').click()`,
  // 点开那张带清单的任务:操作面在列里放不放得下,是 tablet-plan 格 2 的判据
  "tasks-panel": `(() => {
    document.querySelector('#bottombar [data-mode="tasks"]').click();
    const c = [...document.querySelectorAll("#timeline .card")].find((e) => e.innerText.includes(${JSON.stringify(LIST_TASK)}));
    c.querySelector(".body").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  })()`,
  settings: `document.getElementById("settings-toggle").click()`,
  compose: `document.getElementById("capture-fab").click()`,
};
const READY = {
  ideas: `document.body.dataset.view === "ideas"`,
  tasks: `document.body.dataset.view === "tasks"`,
  "tasks-panel": `!!document.querySelector("#timeline .panel")`,
  settings: `!document.getElementById("settings-pane").hidden`,
  compose: `document.getElementById("compose-card").classList.contains("open")`,
};
const SHOTS = [];
for (const [sname, w, h] of SIZES) for (const f of Object.keys(FACES)) SHOTS.push({ name: `${sname}-${f}`, w, h, face: f, theme: "light" });
for (const f of ["ideas", "tasks"]) SHOTS.push({ name: `land-1440x960-${f}-dark`, w: 1440, h: 960, face: f, theme: "dark" });

// 瀑布流与对齐网格的差别只有长短不一的卡才照得出(展示库那几条差不多长)⇒ 在展示库之后再写这几条。
// ⛔ 别把它们加进 lib/showcase.mjs:那份还喂官网配图与商店图,改了那两套要整批重拍。
const EXTRA_NOTES = [
  "楼下新开的面馆,牛肉面不错,下次带爸妈去",
  "读书笔记:\n作者说「好的工作方法是让重要的事情自然浮上来」。\n我的做法:每天早上只看今天和逾期的两列,其余的周末再翻。\n这样一周下来,没有哪件事是被忘掉的。",
  "给阳台装一个晾衣杆",
  "下周三前把房租转给房东",
  "想学的菜\n- [ ] 红烧肉\n- [ ] 番茄牛腩\n- [ ] 清蒸鲈鱼\n- [ ] 可乐鸡翅\n- [ ] 酸辣土豆丝",
  "周六上午带孩子去图书馆还书",
];

// 每张图旁边记下的几何读数(改前改后逐字段比)。gaps = 同一叠卡里相邻两张的竖向间距(瀑布流不留洞的判据);
// panelActRows = 点开的操作面里动作钮排成了几行(看板列够不够宽的判据)。
const GEO = `(() => {
  // ⚠ 别拿 offsetParent 判可见:底栏 / ＋ / 记一笔都是 fixed,它们的 offsetParent 恒为 null
  const R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); if (!b.width && !b.height) return null;
    return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) }; };
  const q = (s) => document.querySelector(s);
  const g0 = q("#timeline > .tl-group");
  const cols = g0 ? [...g0.querySelectorAll(":scope > .tl-cols > .tl-col")] : [];
  const stacks = cols.length ? cols : [...document.querySelectorAll("#timeline > .tl-group")];
  const gaps = [];
  for (const s of stacks) {
    const cards = [...s.querySelectorAll(":scope > .card")];
    for (let i = 1; i < cards.length; i++) gaps.push(Math.round(cards[i].getBoundingClientRect().top - cards[i - 1].getBoundingClientRect().bottom));
  }
  const acts = [...document.querySelectorAll("#timeline .panel .acts button")].filter((b) => b.offsetParent);
  return {
    view: document.body.dataset.view,
    h1: R(q("body > header h1")), headActs: R(q(".head-acts")), nav: R(q("#bottombar")),
    fbar: R(q("#filterbar")), tl: R(q("#timeline")), fab: R(q("#capture-fab")), compose: R(q("#compose-card.open")),
    panes: [...document.querySelectorAll("section.sync")].filter((s) => !s.hidden && s.offsetParent).map((s) => s.id + ":" + JSON.stringify(R(s))),
    groups: document.querySelectorAll("#timeline > .tl-group").length,
    cols: cols.length, cards: document.querySelectorAll("#timeline .card").length, gaps,
    panelActRows: new Set(acts.map((b) => Math.round(b.getBoundingClientRect().top))).size,
  };
})()`;

// ---- 前置 --------------------------------------------------------------------
function portBusy(port) {
  const r = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" });
  return r.stdout.split(/\r?\n/).some((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l));
}
for (const p of [VITE_PORT, PORT]) {
  if (portBusy(p)) throw new Error(`端口 ${p} 已被占(${p === VITE_PORT ? "vite:桌面那只 tauri dev 或上一趟 --keep 没杀" : "CDP:上一趟没杀干净"})—— 先杀掉再跑`);
}
if (!existsSync(join(root, "android/node_modules"))) throw new Error("android/node_modules 不在 —— 先 cd android && npm install");

// 数据目录:每趟清空 ⇒ 空库、首启闸、播种,逐趟相同。⛔ 只删名字里带本工装 identifier 的那两个。
for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
  const d = join(base, ID);
  if (!d.endsWith(ID)) throw new Error(`要清的目录不对:${d}`);
  rmSync(d, { recursive: true, force: true });
}
const work = join(tmpdir(), "zj-ui-shots-wide");
mkdirSync(work, { recursive: true });
const cfg = join(work, "tauri.override.json");
writeFileSync(cfg, JSON.stringify({ identifier: ID, app: { windows: [{ label: "main", title: "wideshots", width: 1440, height: 960, visible: false }] } }));
const log = join(work, "tauri-dev.log");

// ---- 起 --------------------------------------------------------------------
console.log(`起隔离实例(${ID},CDP :${PORT});首次要编译安卓壳的桌面构型,日志 ${log}`);
const child = spawn("cmd", ["/c", "npx", "tauri", "dev", "--no-watch", "--config", cfg], {
  cwd: join(root, "android"),
  windowsHide: true,
  stdio: ["ignore", openSync(log, "w"), openSync(log, "a")],
  env: {
    ...process.env,
    WEBVIEW2_USER_DATA_FOLDER: join(work, "profile"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
});
const killTree = () => spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8" });

let s;
const ev = (js) => s.evaluate(js);
async function waitFor(expr, what, ms = 15000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return;
    } catch {
      /* reload 途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) throw new Error(`等「${what}」超过 ${ms}ms;判据 ${expr}`);
    await sleep(120);
  }
}

const manifest = { at: new Date().toISOString(), head: spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim(), dirty: spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).stdout.trim() !== "", shots: {} };
try {
  // CDP 起来 = vite 起了、壳编完了、页面加载了。首次编译几分钟,之后几十秒。
  const t0 = Date.now();
  for (;;) {
    try {
      s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
      break;
    } catch {
      if (child.exitCode !== null) throw new Error(`tauri dev 退出了(${child.exitCode}),看日志 ${log}`);
      if (Date.now() - t0 > 10 * 60 * 1000) throw new Error(`十分钟没等到 CDP,看日志 ${log}`);
      await sleep(2000);
    }
  }
  console.log(`CDP 连上(${Math.round((Date.now() - t0) / 1000)}s)`);

  // 首启隐私告知(651)点掉,再等启动闸放行。⚠ 告知层是异步冒出来的:等到「告知在屏上」或「闸已放行」二者之一再判
  const agreeShown = `!!document.getElementById("privacy-agree")?.offsetParent`;
  await waitFor(`document.readyState === "complete" && (${agreeShown} || document.getElementById("gate")?.hidden === true)`, "页面加载", 60000);
  if (await ev(agreeShown)) await ev(`document.getElementById("privacy-agree").click(), true`);
  await waitFor(`document.getElementById("gate").hidden`, "启动闸放行", 30000);

  // 播种:新建「生活」空间 → 展示库(带 story)→ 长短随记 → 设为前台、中文、亮档,重载
  const inv = (c, a) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(c)}, ${JSON.stringify(a ?? {})})`);
  const spaceId = await inv("create_space", { name: SHOWCASE.zh.space });
  await inv("activate_space", { spaceId });
  const seeded = await ev(seedScript("zh", { spaceId, captureCmd: "capture_idea", story: true }));
  for (const content of EXTRA_NOTES) await inv("capture_idea", { spaceId, content });
  console.log(`播种:随记 ${seeded.notes}+${EXTRA_NOTES.length} · 任务 ${seeded.tasks} · 标签 ${seeded.topics}`);
  await ev(`(() => {
    localStorage.setItem("zhujian.lang", "zh");
    localStorage.setItem("zhujian.theme", "light");
    localStorage.setItem("zhujian.last-space", ${JSON.stringify(spaceId)});
    return true;
  })()`);

  mkdirSync(outDir, { recursive: true });
  for (const shot of SHOTS.filter((x) => pick(x.name))) {
    await s.send("Emulation.setDeviceMetricsOverride", { width: shot.w, height: shot.h, deviceScaleFactor: 1, mobile: true });
    await ev(`setTimeout(() => location.reload(), 0), true`);
    await sleep(600);
    await waitFor(
      `document.readyState === "complete" && document.body.dataset.view === "ideas" && document.querySelectorAll("#timeline .card").length > 0`,
      `${shot.name} 重载完`,
    );
    await ev(`document.documentElement.dataset.theme = ${JSON.stringify(shot.theme)}, true`);
    if (FACES[shot.face]) await ev(`${FACES[shot.face]}, true`);
    await waitFor(READY[shot.face], `${shot.name} 进到 ${shot.face}`);
    await sleep(450); // 层的淡入 0.22s + 缩略图 / 折叠量高
    const png = await s.send("Page.captureScreenshot", { format: "png", fromSurface: true });
    writeFileSync(join(outDir, `${shot.name}.png`), Buffer.from(png.data, "base64"));
    manifest.shots[shot.name] = { w: shot.w, h: shot.h, face: shot.face, theme: shot.theme, geo: await ev(GEO) };
    console.log(`  ✔ ${shot.name}`);
  }
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`\n${Object.keys(manifest.shots).length} 张 + manifest.json → ${outDir}(HEAD ${manifest.head}${manifest.dirty ? " + 未提交改动" : ""})`);
} finally {
  s?.close?.();
  if (KEEP) {
    // ⚠ 本进程一退,起它的那只 cmd 也跟着退了,vite 与壳成了孤儿 ⇒ 打它的 pid 没用(第一次 --keep 就栽在这),
    //   要杀的是「听 1420 的那只」与壳本身,按端口 / 映像名现查出来
    const listeners = spawnSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf8" }).stdout.split(/\r?\n/)
      .filter((l) => /LISTENING/.test(l) && new RegExp(`:${VITE_PORT}\\s`).test(l)).map((l) => l.trim().split(/\s+/).pop());
    const shells = [...spawnSync("tasklist", ["/FI", "IMAGENAME eq zhujian-android.exe", "/FO", "CSV", "/NH"], { encoding: "utf8" }).stdout.matchAll(/"zhujian-android\.exe","(\d+)"/g)].map((m) => m[1]);
    const pids = [...new Set([...listeners, ...shells])];
    console.log(`\n--keep:实例还开着(CDP :${PORT},vite :${VITE_PORT});用完:taskkill ${pids.map((p) => `/PID ${p}`).join(" ")} /T /F`);
  } else {
    killTree();
    await sleep(1500);
    if (portBusy(VITE_PORT)) console.warn(`⚠ vite :${VITE_PORT} 还在听 —— 手动杀掉(它会自己涨到 GB 级)`);
  }
}
process.exit(0);
