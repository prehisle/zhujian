// 桌面全页截图巡检(用户面 74 格 ①):按写死的清单把桌面每个视图 × 明暗 × 语言各截一张,
// 产物落 `.zjshots/<轮次>/desktop/`,从此当「改 UI 的视觉回归基线」用。
//
// ⭐ 它解决的是门禁解决不了的那一格:六道 CSS/i18n 门禁守的是**值级**漂移(令牌有没有硬编码、
//   三份字典键对不对得上),而「同一个动作在两页长得不一样」「空态节奏不齐」只有并排看图才看得见
//   (memory `gates-green-is-not-looks-right`)。⛔ 所以它**不是门禁**:它不判绿,只产图。
//
// 怎么跑(Windows;⛔ 别在 Linux 上跑 —— 见下面的响亮拒):
//   node scripts/ui-shots-desktop.mjs .zjshots/619/desktop
//   node scripts/ui-shots-desktop.mjs .zjshots/619/desktop --only zh-dark-board   # 调试单张
//
// 它自己起一只**隔离的** app,与用户日常跑的那只并存,三条隔离各有出处:
//   ①`YS_DB_PATH` 换掉 SQLite ⇒ 碰不到真实笔记本(e2e 同一手法;memory
//     `zhujian-verification-isolation-limits` 记着「APPDATA 隔不开」那条死路,别再试);
//   ②`YS_DB_PATH` 下 `lib.rs` **刻意不装单实例门**(lib.rs:3372 那段注释)⇒ 不必先杀掉用户那只;
//   ③WebView2 profile 钉死在 `.ui-shots-profile/` ⇒ 不与 `.cdp-profile/`(手工验收那只)抢,
//     也不往 `C:\Windows\SystemTemp` 撒 `scoped_dir`(memory `zhujian-test-tempdir-leak-cleanup`)。
// 两个窗在 `tauri.conf.json` 里都是 `visible:false`,而 `Page.captureScreenshot` 照样出图 ⇒
// **整趟不抢前台、不偷焦点**,不必套 `run-on-desktop.ps1`(那条是 e2e 的纪律,e2e 真会显窗)。
//
// ⚠ **这批图不是像素级可比的**:截止日期按「今天」现算(要的是「一条逾期 / 一条今天 / 一条将来」
//   这三种**形**长期稳定),⇒ 日期文字每天都变。判读靠人眼与并排看,别拿它做 pixel diff。
// ⚠ 演示数据恒中文,en 那半只换 UI 外壳 ⇒ 它照得出 618 那种「英文键把一行推宽」的形,
//   照不出「英文正文换行」的形。知情的边界,一期不补。
//
// ⛔ **产物早于改动这条坑焊在下面的 assertExeIsFresh 里**(memory `verify-artifact-predates-fix`):
//   exe 比任何前端源文件旧就当场拒,免得截出一批「看着正常的旧界面」还以为验过了。
//
// CDP 客户端这里是**第二份**(第一份在 `scripts/desktop-cdp.mjs`)。刻意没抽公共库:那支是
// 一问一答的 CLI(每条命令新开一条 WS),本支要的是「跨 reload 活着的长连接 + 轮询等条件」,
// 形不一样;抽出来会把那支验收工装的接口一起动,不值。⚠ 加第三份之前先合并这两份。
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

if (process.platform !== "win32") {
  // 绝不回退兜底:Linux 上跑到的是 WebKitGTK,与生产端(WebView2)不是同一个渲染引擎,
  // 截出来的图当基线只会误导。要 Linux 的图就另立一条基线,别把两端混进同一个目录。
  throw new Error(
    `桌面截图巡检只在 Windows(WebView2 = 生产渲染引擎)上有意义,这台是 ${process.platform};` +
      "Linux/WebKitGTK 的图不能与它同目录比对",
  );
}

// ---- 入参 -------------------------------------------------------------------
const argv = process.argv.slice(2);
const outDir = argv.find((a) => !a.startsWith("--"));
if (!outDir) {
  console.error(
    "用法: node scripts/ui-shots-desktop.mjs <产物目录> [--only <子串>] [--port N]\n" +
      "  例: node scripts/ui-shots-desktop.mjs .zjshots/619/desktop",
  );
  process.exit(1);
}
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith("--")) throw new Error(`${name} 少了值`);
  return v;
};
const only = flag("--only", null);
// 默认 9224 而不是 desktop-cdp.mjs 那个 9223:两支同时跑时不抢口。
const PORT = Number(flag("--port", "9224"));
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error(`--port 不是合法端口:${PORT}`);

const EXE = resolve(root, "src-tauri/target/release/app.exe");
const DB = resolve(tmpdir(), "zj-ui-shots.sqlite3");
const PROFILE = resolve(root, ".ui-shots-profile");
const OUT = resolve(root, outDir);

// ---- 清单(写死 = 可复跑;改 UI 加了新静态视图就往这儿加一行)------------------
// 一期只截**静态视图**(plan 里写死的边界):瞬态(菜单展开、拖拽中、toast、确认条)二期。
const LANGS = ["zh", "en"];
const THEMES = ["light", "dark"];
const PAGES = [
  { id: "inbox", win: "notebook", view: "inbox", desc: "随记(未归类 + 已整理)" },
  { id: "board", win: "notebook", view: "board", desc: "任务看板(四列)" },
  { id: "topics", win: "notebook", view: "topics", desc: "标签" },
  { id: "search", win: "notebook", view: "search", desc: "搜索(带查询词的结果态)", query: "体检" },
  // 设置面板三节各一张:617 砍的说明句大半住在这里,一节一张才看得见。
  // ⚠ 只截到**视口那一屏** —— 面板自己是个滚动容器,`captureBeyondViewport` 对内层滚动
  // 容器无效。下半屏(如「常规」的截止提醒往下)一期看不到,知情的边界。
  { id: "settings-general", win: "notebook", view: "inbox", desc: "设置 · 常规", settingsCat: "general" },
  { id: "settings-hotkeys", win: "notebook", view: "inbox", desc: "设置 · 快捷键", settingsCat: "hotkeys" },
  { id: "settings-backup", win: "notebook", view: "inbox", desc: "设置 · 备份与恢复", settingsCat: "backup" },
  { id: "capture", win: "capture", desc: "捕获浮窗" },
];

// notebook 窗钉死 1260×700:与 e2e `goNotebook` 同一个数,理由在 support.js 那段长注释
// (顶栏三档塌缩按顶栏自己的宽判,1260 落在「摘键帽、名字还在」那一档)。⛔ 改这个数之前
// 先读那段 —— 它与 `board.css` 的断点是一对。
const NB_W = 1260;
const NB_H = 700;

// ---- 产物早于改动:响亮拒 ----------------------------------------------------
function newestMtime(dir, exts) {
  let best = { ms: 0, path: null };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "target" || e.name === "dist") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = newestMtime(p, exts);
      if (sub.ms > best.ms) best = sub;
    } else if (exts.some((x) => e.name.endsWith(x))) {
      const ms = statSync(p).mtimeMs;
      if (ms > best.ms) best = { ms, path: p };
    }
  }
  return best;
}

function assertExeIsFresh() {
  if (!existsSync(EXE)) {
    throw new Error(`没有 release exe:${EXE}\n  先跑 \`npm run tauri -- build --no-bundle\`(⛔ 别用裸 cargo build --release)`);
  }
  const exeMs = statSync(EXE).mtimeMs;
  const srcs = [
    newestMtime(resolve(root, "src"), [".ts", ".css"]),
    newestMtime(resolve(root, "src-tauri/src"), [".rs"]),
    ...["index.html", "notebook.html", "lightbox.html"].map((f) => ({
      ms: statSync(resolve(root, f)).mtimeMs,
      path: resolve(root, f),
    })),
  ];
  const newest = srcs.reduce((a, b) => (b.ms > a.ms ? b : a));
  if (newest.ms > exeMs) {
    throw new Error(
      `release exe 比源码旧,截出来的会是「看着正常的旧界面」(memory verify-artifact-predates-fix):\n` +
        `  exe  ${new Date(exeMs).toISOString()}  ${EXE}\n` +
        `  源码 ${new Date(newest.ms).toISOString()}  ${newest.path}\n` +
        `  ⇒ 先 taskkill //IM app.exe //F(它占着锁,不杀的话 tauri build 静默失败且退出码 0),` +
        `再 \`npm run tauri -- build --no-bundle\``,
    );
  }
  return { exeMs, sha1: createHash("sha1").update(readFileSync(EXE)).digest("hex") };
}

// ---- CDP:跨 reload 活着的长连接 ---------------------------------------------
const TIMEOUT = 30000;

class Cdp {
  constructor(match) {
    this.match = match; // (url) => bool
    this.ws = null;
    this.seq = 0;
  }
  async target() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const ts = await r.json();
    const p = ts.find((t) => t.type === "page" && this.match(t.url) && t.webSocketDebuggerUrl);
    if (!p) throw new Error("无匹配 page target,现有:" + ts.map((t) => t.url).join(", "));
    return p;
  }
  async connect() {
    const p = await this.target();
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener("open", res, { once: true });
      ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
    });
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = null; // 下一条命令自动重连(reload 偶尔会断)
    });
    this.ws = ws;
  }
  async send(method, params = {}) {
    if (!this.ws) await this.connect();
    const ws = this.ws;
    const id = ++this.seq;
    return new Promise((res, rej) => {
      // ⛔ 超时 ≠ 操作失败(428 判例,desktop-cdp.mjs 头注):页面里那段很可能跑完了。
      const to = setTimeout(
        () => rej(new Error(`CDP 等 ${method} 超过 ${TIMEOUT}ms —— 只说明驱动这边不等了,页面里那段可能已跑完`)),
        TIMEOUT,
      );
      const on = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id !== id) return;
        clearTimeout(to);
        ws.removeEventListener("message", on);
        m.error ? rej(new Error(method + ": " + JSON.stringify(m.error))) : res(m.result);
      };
      ws.addEventListener("message", on);
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expr) {
    const out = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    if (out.exceptionDetails) throw new Error("页面异常:" + JSON.stringify(out.exceptionDetails));
    return out.result.value;
  }
  /** 轮询等一个页面内条件为真。⛔ 别换成 sleep:那是拿墙钟赌,慢机器照样漏。 */
  async waitFor(expr, msg, timeout = 20000) {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeout) {
      try {
        if (await this.evaluate(expr)) return;
        last = null;
      } catch (e) {
        last = e; // reload 途中 evaluate 会短暂抛,忍到超时为止
        this.ws = null;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
    throw new Error(`等「${msg}」超过 ${timeout}ms;判据 ${expr}` + (last ? `;最后一次错:${last.message}` : ""));
  }
  async shot(outPath) {
    await this.send("Page.enable");
    const s = await this.send("Page.captureScreenshot", { format: "png" });
    if (!s || !s.data) throw new Error("截图无数据(窗口未绘制?)");
    writeFileSync(outPath, Buffer.from(s.data, "base64"));
  }
}

const isNotebook = (u) => u.includes("notebook");
// 捕获窗的 URL 是应用根(生产下 `http://tauri.localhost/index.html`),不含 "capture"
// —— 与 desktop-cdp.mjs 的 `--page capture` 同一条判据(235 实踩)。
const isCapture = (u) => /\/(index\.html)?(\?.*)?$/.test(u);

// ---- 种子库(演示数据;⛔ 恒是这一份,别拿真实笔记本截基线)--------------------
// 三条硬要求:①一眼看得出是演示数据(万一图外送也无害,74② 那条「别把自家想法往外传」);
// ②每个视图都有得看(空态另有其形,二期单列);③截止日期按「今天」现算 ⇒「逾期 / 今天 /
// 将来」三种形长期稳定,而不是养成一屏全逾期。
const SEED = `(async () => {
  const inv = (c, a) => window.__TAURI__.core.invoke(c, Object.assign({ spaceId: "main" }, a));
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };

  const topics = {};
  const palette = { "家里": "#c0563f", "工作": "#3f7a99", "读书": "#7f8b3a", "身体": "#a8577e" };
  for (const title of ["家里", "工作", "读书", "身体"]) {
    const id = await inv("create_topic", { title });
    topics[title] = id;
    await inv("set_topic_color", { id, color: palette[title] });
  }

  // 随记:三条未归类 + 三条已整理(整理过的挂标签,列表里两段都有得看)
  for (const c of [
    "给妈打电话,问体检结果",
    "阳台那盆绿萝该换土了",
    "想写一篇关于纸质笔记本的短文",
  ]) await inv("capture_note", { content: c });
  const filed = [
    ["周末把书架第二层整理一遍", "家里"],
    ["《长安的荔枝》读完了,想记几句", "读书"],
    ["体检报告下周三出,记得去取", "身体"],
  ];
  for (const [c, topic] of filed) {
    const id = await inv("capture_note", { content: c });
    await inv("file_note_to_topic", { id, topicId: topics[topic] });
  }

  // 任务:四列都有;三条截止各占一种形(逾期 / 今天 / 将来);一条带勾选清单
  const mk = async (title, col, due, prio, topic) => {
    const id = await inv("create_task", { title, dueOn: due, priority: prio, topicId: topic ? topics[topic] : null });
    if (col !== "todo") await inv("update_task_status", { id, to: col });
    return id;
  };
  await mk("把书房的旧电脑重装一遍", "todo", day(-2), 1, "家里");
  await mk("交季度报表", "todo", day(0), null, "工作");
  await mk("订下个月回老家的票", "todo", day(9), null, "家里");
  await mk("读完《长安的荔枝》最后两章", "todo", null, null, "读书");
  const pack = await mk("出差要带的东西", "doing", day(3), null, "工作");
  await inv("rename_task", {
    id: pack,
    title: "出差要带的东西\\n- [x] 身份证\\n- [x] 充电器\\n- [ ] 会议材料打印\\n- [ ] 常用药",
  });
  await mk("把阳台的花搬到向阳的一侧", "doing", null, null, "家里");
  await mk("等体检中心回电确认时间", "confirming", null, null, "身体");
  await mk("换掉厨房那只坏了的灯泡", "done", null, null, "家里");
  await mk("给同事回邮件", "done", null, null, "工作");

  return {
    ideas: (await inv("list_inbox")).length + (await inv("list_processed")).length,
    tasks: (await inv("list_tasks")).length,
    topics: (await inv("list_topics")).length,
  };
})()`;

// ---- 一张图 ------------------------------------------------------------------
// 切档一律走「写 localStorage → reload」,⛔ 不点侧栏按钮:点击那条路要与 notebook 自己的
// 异步启动序抢(e2e support.js 那段「同一个视图被挂两次」的判例),reload 没有这个窗口。
function prelude(lang, theme, view) {
  return `(() => {
    localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)});
    localStorage.setItem("zhujian.theme", ${JSON.stringify(theme)});
    localStorage.setItem("zhujian.last-view", ${JSON.stringify(view)});
    localStorage.setItem("zhujian.sidebar-collapsed", "0");
    location.reload();
    return true;
  })()`;
}

async function shootNotebook(cdp, page, lang, theme, file) {
  await cdp.evaluate(prelude(lang, theme, page.view));
  await cdp.waitFor(
    `document.readyState === "complete" && document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !!document.querySelector(".v-${page.view}")`,
    `${page.id} 重载后挂上 .v-${page.view} 且主题变成 ${theme}`,
  );
  // 窗口大小走 Tauri API(⛔ 别用 WebDriver 的 setWindowSize —— 606 起有第三个窗口壳,
  // 「驱动认为当前窗是谁」不确定;这条判例的家在 e2e/specs/support.js)。
  await cdp.evaluate(`(async () => {
    const W = window.__TAURI__.window;
    await W.getCurrentWindow().setSize(new W.LogicalSize(${NB_W}, ${NB_H}));
    return true;
  })()`);
  await cdp.waitFor(`window.innerWidth >= ${NB_W - 60}`, `视口宽跟上 ${NB_W}`, 8000);
  if (page.query) {
    await cdp.evaluate(`(() => {
      const q = document.querySelector("#q");
      q.value = ${JSON.stringify(page.query)};
      q.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    // ⛔ 判据必须认**命中卡**(`article.hit`),别写成「`#list` 有孩子」—— 空态那句
    // 「在所有条目里查找」本身就是 `#list` 的孩子 ⇒ 那条判据**恒真**,截出来的是没搜过的
    // 空态而它一路绿(第一版真这么写过,图印出来才发现;memory
    // `test-parameters-are-part-of-the-predicate`)。输入是防抖的,轮询等它到。
    await cdp.waitFor(`document.querySelectorAll("#list .hit").length > 0`, "搜索出命中卡", 8000);
  }
  if (page.settingsCat) {
    // 分类按 `data-cat` 认人,⛔ 不认可见文字 —— 文字随语言变(settings.ts:135 的原话)。
    await cdp.evaluate(`(() => { document.querySelector("#settings-entry").click(); return true; })()`);
    await cdp.waitFor(`!!document.querySelector(".settings-panel")`, "设置面板打开", 8000);
    await cdp.evaluate(
      `(() => { document.querySelector('.settings-cat[data-cat=${JSON.stringify(page.settingsCat)}]').click(); return true; })()`,
    );
    await cdp.waitFor(
      `document.querySelector('.settings-pane[data-cat=${JSON.stringify(page.settingsCat)}]').hidden === false`,
      `设置切到「${page.settingsCat}」这一节`,
      8000,
    );
  }
  // 字体没就位时截图会拿到 fallback 字形 ⇒ 一批图的字宽对不上,像素比对当场无意义。
  await cdp.waitFor(`document.fonts.status === "loaded"`, "字体加载完成", 8000);
  await cdp.shot(file);
}

// 纸条上摆什么字:⭐ **651 之前这一格是隐藏入参** —— 捕获窗的草稿是**断电恢复**的
// (`zhujian.capture-draft`,main.ts:360),于是隔离 profile 里上一趟遗留的半句话会原样
// 出现在下一趟的基线图里(651 那趟截出来的是一张写着「wf」的纸条,没人写过它)。
// ⇒ 每趟**显式写死**一句,同 hotkey 冲突条那条判据:不许有人没写过的东西进图。
// ⛔ 刻意不复用演示库里那六条,也不用官网首屏 CSS 仿纸条里那句(copy-plan §2.4:
//    「与流程卡里的桌面截图不重复」)—— 三处各说各的,读者才不会觉得在看同一张图。
const CAPTURE_DRAFT = { zh: "明早顺路取体检报告", en: "Pick up the health report tomorrow" };

async function shootCapture(cdp, lang, theme, file) {
  await cdp.evaluate(`(() => {
    localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)});
    localStorage.setItem("zhujian.theme", ${JSON.stringify(theme)});
    // ⚠ 这个键的载荷是 **JSON \`{text, space}\`**(compose-draft.ts 的 TextDraft),不是裸串 ——
    // 写裸串的话 loadTextDraft 的 JSON.parse 抛、catch 掉、返回 null ⇒ 纸条**空着**出图,
    // 不报错(651 写这段时先踩了一次)。捕获窗的落点在回车那刻才定 ⇒ space 恒 null。
    localStorage.setItem("zhujian.capture-draft", JSON.stringify({ text: ${JSON.stringify(CAPTURE_DRAFT[lang])}, space: null }));
    location.reload();
    return true;
  })()`);
  await cdp.waitFor(
    `document.readyState === "complete" && document.documentElement.dataset.theme === ${JSON.stringify(theme)} && !!document.querySelector("#capture")`,
    `捕获窗重载后主题变成 ${theme}`,
  );
  // ⭐ 隐藏入参,量出来的:另一只朱简(用户日常那只)在跑时全局热键注册不上,捕获窗顶上
  // 会多一条「Ctrl+Alt+N 被别的程序占用」的红条,把窗撑高 ⇒ **同一棵树两趟出两张不同的图**。
  // 那条红条本身是产品的合法一态(值得单截),但不许它当**隐藏**入参 ⇒ 这里按产品自己的
  // 收起路径(`.hk-x`,main.ts:101)点掉,并把「本趟有没有它」印出来。
  // ⛔ 判据取**壳自己的答案**再等 DOM 跟上,别写成「现在页面上有没有那条」—— 红条是
  // `refreshHotkeyBar` 一趟异步 invoke 之后才挂的,早看一眼恒为空 = 又一条恒真判据。
  const conflicts = await cdp.evaluate(`window.__TAURI__.core.invoke("hotkey_conflicts")`);
  if (conflicts.length > 0) {
    await cdp.waitFor(`document.getElementById("cap-hotkey").hidden === false`, "热键冲突条挂上", 8000);
    await cdp.evaluate(`(() => { document.querySelector("#cap-hotkey .hk-x").click(); return true; })()`);
    await cdp.waitFor(`document.getElementById("cap-hotkey").hidden === true`, "热键冲突条收起", 5000);
    process.stdout.write(`(热键 ${conflicts.join("/")} 被别的程序占着,冲突条已收起) `);
  }
  await cdp.waitFor(`document.fonts.status === "loaded"`, "字体加载完成", 8000);
  await cdp.shot(file);
}

// ---- 主流程 ------------------------------------------------------------------
const exeInfo = assertExeIsFresh();

// 每趟都从零起:库、window-state、WebView2 profile 全删掉,免得「上一趟留下的档」
// 变成判读的隐藏入参(e2e 那三处清理同一个道理)。
rmSync(DB, { force: true });
// ⚠ `-wal` / `-shm` / `.writer.lock` 跟着一起删 —— 只删主库的话,下一趟是**新库配一份旧
// WAL**(收尾实测那份 wal 有 1.4 MB)。SQLite 认 salt、多半自己丢掉它,但「多半」不是判据,
// 而上面那句「每趟都从零起」得是真话。
for (const side of ["-wal", "-shm", ".writer.lock", ".backup.json", ".backup-auto.json", ".backup-staging", ".backups"]) {
  rmSync(`${DB}${side}`, { force: true, recursive: true });
}
rmSync(resolve(process.env.APPDATA, "app.zhujian.notebook/.window-state.e2e.json"), { force: true });
rmSync(PROFILE, { force: true, recursive: true });
mkdirSync(OUT, { recursive: true });

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();

console.log(`exe   ${EXE}`);
console.log(`      ${new Date(exeInfo.exeMs).toISOString()}  sha1 ${exeInfo.sha1.slice(0, 12)}`);
console.log(`库    ${DB}(隔离,每趟重建)`);
console.log(`产物  ${OUT}`);

const app = spawn(EXE, [], {
  env: {
    ...process.env,
    YS_DB_PATH: DB,
    WEBVIEW2_USER_DATA_FOLDER: PROFILE,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: ["ignore", "inherit", "inherit"],
});
let appExited = null;
app.on("exit", (code) => {
  appExited = code;
});

const shots = [];
let failure = null;
try {
  // 等调试口起来(app 冷启动含开库 + 迁移)
  const t0 = Date.now();
  for (;;) {
    if (appExited !== null) throw new Error(`app 自己退了(码 ${appExited})—— 全局热键冲突?看上面它自己印的话`);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const ts = await r.json();
      if (ts.some((t) => t.type === "page" && isNotebook(t.url))) break;
    } catch {
      /* 还没起 */
    }
    if (Date.now() - t0 > 60000) throw new Error(`60s 内 :${PORT} 上没等到 notebook 页`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`调试口就绪(${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  const nb = new Cdp(isNotebook);
  // ⭐ 调试口就绪 ≠ 页面就绪:上面那圈只等到 `/json/list` 里出现 notebook 这个 target,
  // 而那一刻页面往往还在加载(实测 1.3s 就报就绪,`window.__TAURI__` 还没注入 ⇒ 种子第一句
  // 就 `Cannot read properties of undefined`)。判据换成**页面自己说的话**:桥注入了、
  // 启动序末尾那句 navigate 已经挂上了视图(同 e2e support.js 那条正面字据)。
  await nb.waitFor(
    `document.readyState === "complete" && !!window.__TAURI__ && !!document.querySelector("#view > .view")`,
    "notebook 页加载完且 Tauri 桥注入、启动序已挂上视图",
    30000,
  );
  const seeded = await nb.evaluate(SEED);
  console.log(`种子库:随记 ${seeded.ideas} 条 · 任务 ${seeded.tasks} 条 · 标签 ${seeded.topics} 个`);

  const cap = new Cdp(isCapture);
  for (const lang of LANGS) {
    for (const theme of THEMES) {
      for (const page of PAGES) {
        const name = `${lang}-${theme}-${page.id}`;
        if (only && !name.includes(only)) continue;
        const file = join(OUT, `${name}.png`);
        process.stdout.write(`  ${name} … `);
        if (page.win === "capture") await shootCapture(cap, lang, theme, file);
        else await shootNotebook(nb, page, lang, theme, file);
        const kb = (statSync(file).size / 1024).toFixed(0);
        console.log(`${kb} KB`);
        shots.push({ name, lang, theme, page: page.id, desc: page.desc, file: `${name}.png`, bytes: statSync(file).size });
      }
    }
  }
} catch (e) {
  failure = e;
} finally {
  app.kill();
}

// 清单:回答「这批图是哪棵树、哪只 exe、什么时候出的」——图本身答不了,而下一个人一定要问。
// ⛔ `--only` 那趟**不写**:它只补几张,写了就把整批的清单盖成一份「只有 4 张」的假账
//    (调试时真踩过一次)。补完图之后要清单,重跑一趟不带 `--only` 的全量。
if (only) {
  console.log(`\n⚠ 这是 --only「${only}」的补拍,${shots.length} 张;⛔ 没写 manifest.json(免得盖掉全量那份)`);
} else writeFileSync(
  join(OUT, "manifest.json"),
  JSON.stringify(
    {
      tool: "scripts/ui-shots-desktop.mjs",
      shotAt: new Date().toISOString(),
      gitHead: head,
      exe: { path: EXE, mtime: new Date(exeInfo.exeMs).toISOString(), sha1: exeInfo.sha1 },
      window: { width: NB_W, height: NB_H },
      note: "截止日期按截图当天现算 ⇒ 日期文字每天不同,别拿它做 pixel diff;演示数据恒中文,en 那半只换 UI 外壳",
      shots,
    },
    null,
    2,
  ) + "\n",
);

if (failure) throw failure;
console.log(`\n共 ${shots.length} 张 → ${OUT}`);
