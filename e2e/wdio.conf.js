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
      env: { ...process.env, YS_DB_PATH: testDb },
      stdio: [null, process.stdout, process.stderr],
    });
    // Give tauri-driver + the native driver a moment to bind their ports.
    await new Promise((r) => setTimeout(r, 2500));
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
