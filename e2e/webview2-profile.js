// Windows e2e 的 WebView2 user data folder:钉死它 + 盯着那个不归我们管的临时目录。
//
// **病症**(2026-08-24 清 C 盘时撞到、2026-08-26 坐实):`C:\Windows\SystemTemp` 下攒了
// 1972 个 `scoped_dir<pid>_<rand>\EBWebView\…`,每个约 20 MB = 一份完整的 WebView2 用户
// 数据目录,累计 **34.4 GB / 44.4 万文件**。
//
// **归因是量出来的,不是猜的**:清空后当天两趟 e2e 各留下 **恰好 40 个**(= 40 个 spec 文件),
// 两簇跨度都是 **06:06**、平均间隔 9.4 秒,与那两趟的墙钟(06:17)对得上,40 个里 40 个含
// `EBWebView` ⇒ **一个 spec 一个**。`maxInstances:1` 下 wdio 每个 spec 文件起一次会话,
// 每次会话 msedgedriver 建一个临时 user data folder 给被测 app,**退出时不删**。
//
// **为什么三周里一个信号都没红**:`core/src/test_temp_cleanup.rs` 那个 ctor 扫尾器与 324 那道
// 结构锚判据都是 `std::env::temp_dir()`(Windows 上 = `%TEMP%`),而 `C:\Windows\SystemTemp`
// 根本不在它底下 ⇒ C 盘被吃掉 34 GB,期间全绿。清理器失败时**不报错,只是少干活**。
//
// **修法 = 把源头挪回已被守护的目录**(与 325/326 同族,而不是再养一个清洁工):
// msedgedriver 认 WebView2 选项 `userDataFolder`(它二进制里那张表:`browserExecutableFolder`
// / `userDataFolder` / `additionalBrowserArguments` / `releaseChannelPreference`),而
// tauri-driver 2.0.6 会把 `tauri:options.webviewOptions` 原样转给 `ms:edgeOptions`。
// 于是每个会话各给一个 `%TEMP%/ys-nb-e2e-udd-<launcher pid>/<cid>/`:
//   · 前缀 `ys-nb-` 已在 `core/src/test_temp_cleanup.rs` 的 PREFIXES 里 ⇒ 就算这趟没跑到
//     `onComplete`(Ctrl+C / 崩了),下一趟 `cargo test` 一小时后也会替我们收掉;
//   · 每个会话一个子目录 ⇒ 不会撞上「user data directory is already in use」那条竞态。
// ⛔ **别改回 `WEBVIEW2_USER_DATA_FOLDER` 环境变量那条路** —— 453 本机实测过,
//    msedgedriver 会把它顶掉;认的是上面这个**能力**,不是那个变量。
//
// **修完还要盯着**:上面这条链有三个环节不在我们手里(tauri-driver 转不转、msedgedriver 认不认、
// WebView2 落不落到那儿)。任何一环哪天变了,病症就原样回来,而**它回来的方式是安静的绿**。
// 故 `onComplete` 印两个读数,两个方向都看得见:
//   · 我们那个根下真收到几个会话目录(该 = spec 数;**0 = 这道钉子没钉上**);
//   · `C:\Windows\SystemTemp` 本轮新长出来几个 `scoped_dir`(该 = 0;>0 = 又漏了)。
// 读不动那个目录就如实说「这趟没有结论」,⛔ 别当成 0。
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

const isWin = process.platform === "win32";

// SYSTEM 上下文进程的临时目录,不在 `%TEMP%` 底下 —— 这正是既有扫尾器扫不到它的原因。
const SYSTEM_TEMP = "C:\\Windows\\SystemTemp";
// Chromium 的 `ScopedTempDir` 给自建临时目录起的名字。
const SCOPED = "scoped_dir";

// ⚠ 根目录只能由 launcher 定一次、再经**环境变量**传给每个 worker:`beforeSession` 跑在
// worker 进程里,`onPrepare`/`onComplete` 跑在 launcher 里,两边 `process.pid` 不是一个数
// —— 直接在模块顶层用 pid 拼路径,worker 写的和 launcher 删的会是两个目录(而且不报错)。
const ROOT_ENV = "YS_E2E_UDD_ROOT";

/** launcher 侧:定下这一趟的根并传给 worker。只在 `onPrepare` 调。 */
export function initProfileRoot() {
  if (!isWin) return null;
  const root = resolve(tmpdir(), `ys-nb-e2e-udd-${process.pid}`);
  process.env[ROOT_ENV] = root;
  return root;
}

/** ⛔ 不兜底:读不到就说明 `onPrepare` 没接上,静默换个路径比当场报错难查得多。 */
function profileRoot() {
  const v = process.env[ROOT_ENV];
  if (!v) throw new Error(`${ROOT_ENV} 没设 —— wdio.conf.js 的 onPrepare 里漏了 initProfileRoot()`);
  return v;
}

/** 这个会话的 user data folder。`cid` 是 wdio 给每个 runner 的编号(如 `0-7`)。 */
export function sessionProfile(cid) {
  if (!isWin) return null;
  const dir = resolve(profileRoot(), String(cid));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 我们那个根下今天有几个会话目录 —— 0 就是「这颗钉子没钉上」。 */
export function sessionProfileCount() {
  if (!isWin) return 0;
  const root = profileRoot();
  return existsSync(root) ? readdirSync(root).length : 0;
}

/**
 * `C:\Windows\SystemTemp` 下的 `scoped_dir*` 名单快照。
 * 读不动就回 `null`(而不是空集)—— 「没有结论」与「一个都没有」必须分得开。
 */
export function snapshotSystemTemp() {
  if (!isWin) return null;
  try {
    return new Set(readdirSync(SYSTEM_TEMP).filter((n) => n.startsWith(SCOPED)));
  } catch {
    return null;
  }
}

function dirBytes(dir) {
  let total = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name);
    try {
      if (e.isDirectory()) total += dirBytes(p);
      else total += statSync(p).size;
    } catch {
      // 边扫边被删是正常的,量的是数量级不是精确字节。
    }
  }
  return total;
}

/**
 * 收尾:删掉我们自己那个根,并数一数 `SystemTemp` 本轮新长出来多少 `scoped_dir`
 * (顺手也删掉——留着没有任何用处,而这台机器上那 34 GB 就是这么攒的)。
 * @param before {Set<string>|null} `snapshotSystemTemp()` 的返回值
 */
export function sweep(before) {
  const out = { ownMB: 0, leaked: 0, leakedMB: 0, failed: 0, unknown: false };
  if (!isWin) return out;

  const root = profileRoot();
  if (existsSync(root)) {
    out.ownMB = dirBytes(root) / 1024 / 1024;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      out.failed += 1;
    }
  }

  const after = snapshotSystemTemp();
  if (before === null || after === null) {
    out.unknown = true;
    return out;
  }
  for (const name of after) {
    if (before.has(name)) continue;
    const p = resolve(SYSTEM_TEMP, name);
    out.leaked += 1;
    try {
      out.leakedMB += dirBytes(p) / 1024 / 1024;
      rmSync(p, { recursive: true, force: true });
    } catch {
      out.failed += 1;
    }
  }
  return out;
}

/**
 * 把两个读数印成人话。
 * ⛔ 这些行里别出现 `✓` 或 `RETRYING` —— `scripts/lib/test-verdict.mjs` 数的就是它们。
 */
export function report(sessions, swept) {
  if (!isWin) return;
  const mb = (n) => n.toFixed(0);
  console.log(
    `[e2e] WebView2 profile:本轮 ${sessions} 个会话目录(${mb(swept.ownMB)} MB,已删)`,
  );
  if (sessions === 0) {
    console.log(
      "[e2e] ⚠ 会话目录数是 0 —— `tauri:options.webviewOptions.userDataFolder` 这颗钉子没钉上" +
        "(tauri-driver 不转发了?msedgedriver 不认了?),profile 多半又落回 C:\\Windows\\SystemTemp 了。",
    );
  }
  if (swept.unknown) {
    console.log(
      "[e2e] C:\\Windows\\SystemTemp:读不动,这趟没有结论(⛔ 别当成 0 —— 34 GB 就是在全绿里攒出来的)",
    );
  } else if (swept.leaked === 0) {
    console.log("[e2e] C:\\Windows\\SystemTemp:本轮新增 scoped_dir 0 个(期望值)");
  } else {
    console.log(
      `[e2e] ⚠ C:\\Windows\\SystemTemp:本轮新增 scoped_dir ${swept.leaked} 个 / ${mb(swept.leakedMB)} MB(已删)` +
        " —— 期望 0。userDataFolder 那颗钉子失效了,见 e2e/webview2-profile.js 头注。",
    );
  }
  if (swept.failed > 0) {
    console.log(`[e2e] ⚠ 有 ${swept.failed} 处删不掉(多半还被占着),下一趟或手动再清。`);
  }
}
