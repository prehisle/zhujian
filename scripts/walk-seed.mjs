// 走查种子的跑手(ux-walk-plan W1a):把 `lib/walk-seed.mjs` 播进一只干净实例。
//
//   node scripts/walk-seed.mjs --desktop <目录> [--lang zh]
//       清掉 <目录>/db → 起隔离 release 实例(YS_DB_PATH + 独立 profile + 调试口 9233)→ 播种 →
//       关掉 → 按种子返回的 backdate 把那几条往前挪几天 → 写 <目录>/launch.ps1(之后走查就跑它)。
//   node scripts/walk-seed.mjs --desktop-spaces <目录> [--lang zh] [--build]
//       W3 起(多空间 / 跨空间挪):`YS_DB_PATH` 模式禁建空间 ⇒ 换一只**改了 identifier 的 debug 构建**
//       (`app.zhujian.walk`,产物在 `src-tauri/target/walk/`,没有或带 `--build` 才编),数据落
//       `%APPDATA%pp.zhujian.walk`(每趟先清)。主空间播同一份种子,再建「演示:家庭」播几条。
//       ⛔ 为什么不用 release:release 首启会把自己写进 HKCU 开机启动(debug 不写)。
//       ⚠ 它照常注册 `zhujian://` 深链(e2e 才不注册)⇒ launch.ps1 起之前 `reg export`、起之后 `reg import` 还回去;
//       全局热键与用户日常那只撞,注册不上(记成边界)。
//   node scripts/walk-seed.mjs --android [--lang zh]
//       往已连上 CDP 的手机(先 `node scripts/android-cdp.mjs forward`)当前空间播种。
//       ⚠ 手机挪不了时间(devtools 包不是 debuggable,run-as 拒)⇒ 手机上时间轴全是今天,走查记成边界。
//       ⚠ 不清库:先在 app 里重置空间或重装,⛔ 只对专用测试机跑(ux-walk-plan §3)。
//
// ⚠ 播种不幂等:同一只库跑两遍就是两份。desktop 形每次先清库,所以只许经由本脚本重播。
// ⚠ 挪时间是直接改隔离库的 `items.created_at`(不走同步、库是一次性的);只挪 created_at,
//   历史 / 图 / 留言的时间不跟着挪 —— 走查时别把「历史时间比条目还新」当毛病。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { walkSeedScript, walkSpace2Script } from "./lib/walk-seed.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const EXE = join(ROOT, "src-tauri/target/release/app.exe");
const PORT = "9233";
const WALK_ID = "app.zhujian.walk";
const WALK_TARGET = join(ROOT, "src-tauri/target/walk");
const WALK_EXE = join(WALK_TARGET, "debug/app.exe");
const DEEPLINK_KEY = String.raw`HKCU\Software\Classes\zhujian`;
const argv = process.argv.slice(2);
const lang = argv.includes("--lang") ? argv[argv.indexOf("--lang") + 1] : "zh";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cdp(tool, args, env = {}) {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts", tool), ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  // 两支驱动印法不一样:desktop-cdp 印整个 result({type, value}),android-cdp 只印 value
  let value;
  try {
    const j = JSON.parse(r.stdout);
    value = tool === "desktop-cdp.mjs" ? j.value : j;
  } catch {}
  return { ok: r.status === 0, value, out: r.stdout, err: r.stderr };
}

function seedFile(captureCmd) {
  const f = join(tmpdir(), `zj-walk-seed-${process.pid}.js`);
  writeFileSync(f, walkSeedScript(lang, { spaceId: "main", captureCmd }));
  return f;
}

async function desktop(dir, spaces) {
  if (process.platform !== "win32") throw new Error("--desktop 只在 Windows 上跑");
  const abs = resolve(dir);
  // .ps1 恒 ASCII-only(memory powershell-utf8-readfile-trap):路径里有中文就当场拒
  if (/[^\x00-\x7f]/.test(abs)) throw new Error(`目录路径要纯 ASCII(launch.ps1 会读它):${abs}`);
  const profile = join(abs, "profile");
  const launch = join(abs, "launch.ps1");
  let dbFile, lines;
  if (spaces) {
    if (argv.includes("--build") || !existsSync(WALK_EXE)) buildWalkExe();
    for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA]) {
      const d = join(base, WALK_ID);
      if (!d.endsWith(WALK_ID)) throw new Error(`要清的目录不对:${d}`);
      rmSync(d, { recursive: true, force: true });
    }
    rmSync(profile, { recursive: true, force: true });
    dbFile = join(process.env.APPDATA, WALK_ID, "notebook.sqlite3");
    const regFile = join(abs, "deeplink-backup.reg");
    lines = [
      `reg export '${DEEPLINK_KEY}' '${regFile}' /y | Out-Null`,
      `$env:WEBVIEW2_USER_DATA_FOLDER = '${profile}'`,
      `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=${PORT}'`,
      `$p = Start-Process '${WALK_EXE}' -PassThru`,
      `$p.Id | Out-File -Encoding ascii '${join(abs, "app.pid")}'`,
      // 它启动时把 zhujian:// 改指自己;等它注册完再把用户那只的还回去
      `Start-Sleep -Seconds 8`,
      `reg import '${regFile}' 2>&1 | Out-Null`,
      `Write-Output $p.Id`,
    ];
  } else {
    if (!existsSync(EXE)) throw new Error(`没有 release exe:${EXE}(npm run tauri -- build --no-bundle)`);
    const db = join(abs, "db");
    rmSync(db, { recursive: true, force: true });
    mkdirSync(db, { recursive: true });
    dbFile = join(db, "walk.sqlite3");
    lines = [
      `$env:YS_DB_PATH = '${dbFile}'`,
      `$env:WEBVIEW2_USER_DATA_FOLDER = '${profile}'`,
      `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=${PORT}'`,
      `$p = Start-Process '${EXE}' -PassThru`,
      `$p.Id | Out-File -Encoding ascii '${join(abs, "app.pid")}'`,
      `Write-Output $p.Id`,
    ];
  }
  mkdirSync(profile, { recursive: true });
  writeFileSync(launch, [...lines, ""].join("\r\n"));
  const ps = () => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launch], { encoding: "utf8" });
  const kill = (pid) => spawnSync("taskkill", ["/PID", pid, "/F"], { encoding: "utf8" });

  if (spaces) assertDeeplinkNotWalk("起之前");
  const pid = ps().stdout.trim();
  if (!/^\d+$/.test(pid)) throw new Error(`起实例没拿到 pid:${pid}`);
  try {
    if (spaces) assertDeeplinkNotWalk("launch.ps1 还回去之后");
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      await sleep(1000);
      const r = cdp("desktop-cdp.mjs", ["eval", "document.readyState==='complete' && !!window.__TAURI__"], { ZJ_CDP_PORT: PORT });
      ready = r.ok && r.value === true;
    }
    if (!ready) throw new Error("90 秒内 CDP 没起来");
    const r = cdp("desktop-cdp.mjs", ["evalfile", seedFile("capture_note"), "--timeout", "180000"], { ZJ_CDP_PORT: PORT });
    if (!r.ok) throw new Error(`播种失败:${r.err || r.out}`);
    const res = r.value;
    if (!res?.backdate) throw new Error(`播种没回结果:${r.out}`);
    if (spaces) {
      const f = join(tmpdir(), `zj-walk-space2-${process.pid}.js`);
      writeFileSync(f, walkSpace2Script(lang));
      const r2 = cdp("desktop-cdp.mjs", ["evalfile", f, "--timeout", "60000"], { ZJ_CDP_PORT: PORT });
      if (!r2.ok || !r2.value?.spaceId) throw new Error(`第二个空间播种失败:${r2.err || r2.out}`);
      res.space2 = r2.value.spaceId;
    }
    kill(pid);
    await sleep(1500);
    const { DatabaseSync } = await import("node:sqlite");
    const h = new DatabaseSync(dbFile);
    const up = h.prepare(
      "UPDATE items SET created_at = strftime('%Y-%m-%dT%H:%M:%S', created_at, ?) || substr(created_at, 20) WHERE id = ?",
    );
    let n = 0;
    for (const [id, days] of res.backdate) n += Number(up.run(`-${days} days`, id).changes);
    h.close();
    if (n !== res.backdate.length) throw new Error(`挪时间只挪成 ${n}/${res.backdate.length} 条`);
    writeFileSync(join(abs, "seed-result.json"), JSON.stringify(res, null, 2));
    console.log(`✅ 播完:${JSON.stringify(res.counts)};挪了 ${n} 条的时间`);
    console.log(`   起走查实例:powershell -NoProfile -ExecutionPolicy Bypass -File ${launch}(调试口 ${PORT})`);
  } catch (e) {
    kill(pid);
    throw e;
  }
}

function android() {
  const r = cdp("android-cdp.mjs", ["evalfile", seedFile("capture_idea")], { CDP_TIMEOUT_MS: "180000" });
  if (!r.ok) throw new Error(`播种失败:${r.err || r.out}`);
  const res = r.value;
  if (!res?.counts) throw new Error(`播种没回结果:${r.out}`);
  console.log(`✅ 播完:${JSON.stringify(res.counts)};⚠ 手机挪不了时间,时间轴全是今天`);
}

// zhujian:// 不许停在走查那只身上(launch.ps1 起完会 reg import 还回去;这里核一遍,没还成就响亮停)
function assertDeeplinkNotWalk(when) {
  const r = spawnSync("reg", ["query", DEEPLINK_KEY + String.raw`\shell\open\command`, "/ve"], { encoding: "latin1" });
  if (r.status !== 0) throw new Error(`${when}读不到 ${DEEPLINK_KEY}:${r.stderr}`);
  if (r.stdout.includes(WALK_TARGET)) throw new Error(`${when} zhujian:// 指着走查构建 —— 先把它还回用户那只:
${r.stdout}`);
}

function buildWalkExe() {
  const cfg = join(tmpdir(), "zj-walk-tauri.override.json");
  writeFileSync(cfg, JSON.stringify({ identifier: WALK_ID }));
  console.log(`编走查用 debug 构建(identifier ${WALK_ID},产物 ${WALK_EXE});首次要几分钟`);
  const r = spawnSync("cmd", ["/c", "npx", "tauri", "build", "--debug", "--no-bundle", "--config", cfg], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: WALK_TARGET },
  });
  if (r.status !== 0 || !existsSync(WALK_EXE)) throw new Error(`走查构建失败(退出码 ${r.status})`);
}

if (argv[0] === "--desktop" && argv[1]) await desktop(argv[1], false);
else if (argv[0] === "--desktop-spaces" && argv[1]) await desktop(argv[1], true);
else if (argv[0] === "--android") android();
else {
  console.error("用法: node scripts/walk-seed.mjs --desktop <目录> | --desktop-spaces <目录> [--build] | --android  [--lang zh]");
  process.exit(2);
}
