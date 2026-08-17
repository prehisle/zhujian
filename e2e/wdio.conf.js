import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { rmSync } from "node:fs";
import net from "node:net";

// Real GUI e2e: WebdriverIO -> tauri-driver -> 平台原生 WebDriver -> the built app's
// WebView. Drives real clicks against real IPC against a throwaway SQLite DB.
//
// 平台(340 补齐 Linux):
//   Windows — msedgedriver -> WebView2。这是**生产端**,发版前的最终门禁走它。
//   Linux   — WebKitWebDriver -> WebKitGTK(系统包 `webkit2gtk-driver`)。⚠ 渲染引擎与
//             生产端**不是同一个**,故 Linux 绿只是有意义的证据、不能替代 Windows 那次;
//             它换来的是「没有 Windows 机器时也能验交互层」(CI 与容器里尤其值)。
//             无显示器时套 `xvfb-run -a npm run test:e2e`。
//
// Two modes:
//   default — release exe (self-contained, slow to build ~5min). Final gate.
//   fast    — YS_E2E_FAST=1: debug exe + vite dev server on :1420 (seconds to
//             iterate). Needs `npm run dev` (vite only) running in another shell.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const isWin = process.platform === "win32";
const isLinux = process.platform === "linux";
const fast = process.env.YS_E2E_FAST === "1";

const appBinary = resolve(
  root,
  `src-tauri/target/${fast ? "debug" : "release"}/app${isWin ? ".exe" : ""}`,
);
// tauri-driver 要的原生 driver 按平台换。**不给未知平台兜底**(设计铁律「绝不回退兜底」):
// macOS 的 WKWebView today 没有可用的 WebDriver,静默挑一个只会在半小时后以看不懂的
// 方式失败,不如当场说清楚。
const nativeDriver = isWin
  ? resolve(here, "drivers/msedgedriver.exe")
  : isLinux
    ? "/usr/bin/WebKitWebDriver"
    : null;
if (nativeDriver === null) {
  throw new Error(
    `e2e 不支持 ${process.platform}:Windows 走 msedgedriver(生产端)、Linux 走 WebKitWebDriver;` +
      `macOS 的 WKWebView 没有可用的 WebDriver,真机验收走 CDP 或手动`,
  );
}
// **Linux 上没有 release 形**(409 白烧一次 9 分钟才发现,411 补这道响亮拒):下面那行
// release 的 base 写死 `http://tauri.localhost`,而那是 **wry 在 Windows/Android 上的
// workaround URL**;Linux/WebKitGTK 的资产源是 `tauri://localhost`(tauri-2.11.2
// `src/manager/mod.rs:338` 原话)。现象是 36 支**全红在同一处**(`before all` 里 goShow 报
// `Could not parse script result`)——看着像整棵树塌了,其实一个产品缺陷都没有。
// ⛔ 不去「修通」它:Linux 本来就判不了发版(WebKitGTK 非生产渲染引擎,396 起口径没变),
// 修通零收益;**响亮拒**才是省下下一个人那 9 分钟的东西(设计铁律:绝不回退兜底)。
if (isLinux && !fast) {
  throw new Error(
    "这台是 Linux,跑不了 release 形的 e2e:release 的资产源在 Linux/WebKitGTK 是 " +
      "tauri://localhost,而本配置(与 wry 在 Windows/Android 的 workaround 一致)写的是 " +
      "http://tauri.localhost —— 硬跑会 36 支全红在 goShow,且与被测代码无关。" +
      "改用 fast 形:先另起一个终端跑 `npm run dev`(只起 vite),再 `YS_E2E_FAST=1 npm run test:e2e`。",
  );
}
const tauriDriverBin = resolve(homedir(), `.cargo/bin/tauri-driver${isWin ? ".exe" : ""}`);
// A disposable DB so e2e never touches the real notebook (see YS_DB_PATH in lib.rs).
const testDb = resolve(tmpdir(), "ys-nb-e2e.sqlite3");
// 57: with YS_DB_PATH set the app writes window geometry to this separate state
// file (never the real .window-state.json) — wipe it so runs stay deterministic.
// 文件住在 Tauri 的 `app_config_dir`(lib.rs:2143 那段):Windows = %APPDATA%,
// Linux = $XDG_CONFIG_HOME 或 ~/.config。**别用 `resolve(process.env.APPDATA, …)` 一把梭**
// —— Linux 上那个变量是 undefined,resolve 当场抛 TypeError(340 之前踩的就是这个)。
const appConfigDir = isWin
  ? process.env.APPDATA
  : (process.env.XDG_CONFIG_HOME ?? resolve(homedir(), ".config"));
const e2eWindowState = resolve(
  appConfigDir,
  "app.zhujian.notebook/.window-state.e2e.json",
);

// Where the bundled frontend is served: release = Tauri's asset origin, fast =
// the vite dev server. Specs read this via process.env (set below); fail-fast if absent.
process.env.YS_E2E_BASE = fast ? "http://localhost:1420" : "http://tauri.localhost";

let tauriDriver;

function portOpen(port) {
  return new Promise((res) => {
    // host 'localhost' so we match vite whether it binds IPv4 (127.0.0.1) or IPv6 (::1).
    const sock = net.connect({ host: "localhost", port });
    sock.on("connect", () => {
      sock.destroy();
      res(true);
    });
    sock.on("error", () => res(false));
  });
}

export const config = {
  runner: "local",
  specs: [resolve(here, "specs/**/*.e2e.js")],
  maxInstances: 1,
  capabilities: [
    {
      "tauri:options": { application: appBinary },
      "wdio:enforceWebDriverClassic": true,
    },
  ],
  logLevel: "error",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120000 },

  // 163/164 accounting: all 25 specs share one accumulating DB with no retry, so a
  // full run occasionally shows 1-2 false reds in non-board specs from cold-start
  // timeouts / environment jitter (they pass when run alone = a fresh session is all
  // it takes). Retry a failed spec FILE once in a fresh session. deferred:false =
  // retry immediately (closest to "green in isolation"; not pushed to the most-
  // accumulated tail). A genuinely broken spec still fails both attempts — only the
  // jitter is absorbed. The alternative root-cause fix (per-spec DB isolation) stays
  // noted in the log; not taken here to avoid a Windows file-lock race on the shared DB.
  specFileRetries: 1,
  specFileRetriesDeferred: false,

  // Talk directly to tauri-driver's WebDriver endpoint.
  hostname: "127.0.0.1",
  port: 4444,
  path: "/",

  onPrepare: async () => {
    rmSync(testDb, { force: true }); // fresh DB each run
    rmSync(e2eWindowState, { force: true });
    // 412:备份的三处路径**按库派生**(lib.rs setup 里那段:e2e 下绝不碰真实用户配置,
    // 也绝不用 `main_db.parent()` —— 那是 /tmp,多个测试库会共享同一个暂存区)。库既然
    // 每趟重来,它们也得一起重来:留着配置的话「首次仪式」那一格下一趟就没得测了。
    for (const side of [".backup.json", ".backup-staging", ".backups"]) {
      rmSync(`${testDb}${side}`, { force: true, recursive: true });
    }
    if (fast) {
      // Refresh the debug binary so it reflects the latest Rust (incremental, seconds).
      const cargo = resolve(homedir(), `.cargo/bin/cargo${isWin ? ".exe" : ""}`);
      const built = spawnSync(cargo, ["build"], {
        cwd: resolve(root, "src-tauri"),
        stdio: "inherit",
      });
      if (built.status !== 0) throw new Error("fast 模式:cargo build (debug) 失败");
      // The debug WebView loads from the vite dev server — it must already be up.
      if (!(await portOpen(1420))) {
        throw new Error(
          "fast 模式需要 vite 在 :1420 — 先在另一终端跑 `npm run dev`(只起 vite;别用 tauri dev,会抢全局热键)",
        );
      }
    }
  },
  beforeSession: async () => {
    tauriDriver = spawn(tauriDriverBin, ["--native-driver", nativeDriver], {
      // 394:整套 spec 的断言都是**中文串**(⋯ 菜单项、筛选 pill、空态文案),而 358 起
      // 语言「自动」档跟 `navigator.language` 走 —— Linux 上那是**进程 locale**。英文
      // locale 的机器上 app 渲染英文,断言一条都对不上:2026-08-16 在 en_US 的容器里
      // 实测 **32/36 红**,同一棵树换成 zh_CN 后 30 passed / 6 failed。故这里把语言钉死,
      // 别让「机器的 locale」变成判绿的隐藏入参(Windows 的 WebView2 语言由系统设置定,
      // 这两个变量它不看 = 生产端那条链一字不变)。
      env: { ...process.env, YS_DB_PATH: testDb, LANG: "zh_CN.UTF-8", LC_ALL: "zh_CN.UTF-8" },
      stdio: [null, process.stdout, process.stderr],
    });
    // Give tauri-driver + the native driver a moment to bind their ports.
    await new Promise((r) => setTimeout(r, 2500));
  },
  // 396:再焊掉一个隐藏入参 —— **上一次会话没记下的 compose 草稿**。
  // 草稿(文字 localStorage / 暂存图 IndexedDB,198+353+393)是**设备本地**的,住在 app 的
  // WebKit 存储里,而 `YS_DB_PATH` 只换掉 SQLite ⇒ 它跨 e2e 运行、跨手动开发会话一直留着。
  // 留着就会翻掉判绿:三个 compose 在挂载时「有草稿就把自己开出来」,而 `#add-task` /
  // 「记下灵感」是**开关**,于是 spec 里那句「点开 compose」反而把它关上 —— 现场是
  // `element ("#compose-input") still not displayed after 5000ms`。阳性/阴性对照(396 §二):
  // 板子桶里种一张暂存图 → board.e2e.js **8 failing**;删掉 → **15 passing 零重试**。
  // 394 记的那只 1/16 抖动就是它,不是时序。
  // ⚠ 代价说清楚:跑一次 e2e 会清掉**本机真实**的未记下草稿(与 SQLite 不同,这份没有影子
  // 目录可换)。可接受 —— 草稿的定位本就是「还没记下的临时暂存」(393 拍板同一取舍),
  // 而文档早已要求跑 e2e 前先退出生产朱简。
  before: async () => {
    await browser.execute(() => {
      for (const k of ["zhujian.capture-draft", "zhujian.inbox-draft", "zhujian.board-draft"])
        localStorage.removeItem(k);
    });
    // 清**内容**不删库:删库遇上另一窗还开着连接会走 `blocked`,那一路要么挂住要么静默跳过。
    await browser.executeAsync((done) => {
      const req = indexedDB.open("zhujian-compose-draft", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("images");
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction("images", "readwrite");
        tx.objectStore("images").clear();
        tx.oncomplete = () => {
          db.close();
          done();
        };
        tx.onabort = () => {
          db.close();
          done();
        };
      };
      req.onerror = () => done();
      req.onblocked = () => done();
    });
  },

  afterSession: () => {
    tauriDriver?.kill();
  },
};
