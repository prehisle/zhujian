import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { rmSync } from "node:fs";
import net from "node:net";

// Real GUI e2e: WebdriverIO -> tauri-driver -> msedgedriver -> the built app's
// WebView2. Drives real clicks against real IPC against a throwaway SQLite DB.
//
// Two modes:
//   default — release exe (self-contained, slow to build ~5min). Final gate.
//   fast    — YS_E2E_FAST=1: debug exe + vite dev server on :1420 (seconds to
//             iterate). Needs `npm run dev` (vite only) running in another shell.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const isWin = process.platform === "win32";
const fast = process.env.YS_E2E_FAST === "1";

const appBinary = resolve(
  root,
  `src-tauri/target/${fast ? "debug" : "release"}/app${isWin ? ".exe" : ""}`,
);
const edgeDriver = resolve(here, "drivers/msedgedriver.exe");
const tauriDriverBin = resolve(homedir(), `.cargo/bin/tauri-driver${isWin ? ".exe" : ""}`);
// A disposable DB so e2e never touches the real notebook (see YS_DB_PATH in lib.rs).
const testDb = resolve(tmpdir(), "ys-nb-e2e.sqlite3");
// 57: with YS_DB_PATH set the app writes window geometry to this separate state
// file (never the real .window-state.json) — wipe it so runs stay deterministic.
const e2eWindowState = resolve(
  process.env.APPDATA,
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
    tauriDriver = spawn(tauriDriverBin, ["--native-driver", edgeDriver], {
      env: { ...process.env, YS_DB_PATH: testDb },
      stdio: [null, process.stdout, process.stderr],
    });
    // Give tauri-driver + msedgedriver a moment to bind their ports.
    await new Promise((r) => setTimeout(r, 2500));
  },
  afterSession: () => {
    tauriDriver?.kill();
  },
};
