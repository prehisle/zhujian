// 走查种子的跑手(ux-walk-plan W1a):把 `lib/walk-seed.mjs` 播进一只干净实例。
//
//   node scripts/walk-seed.mjs --desktop <目录> [--lang zh]
//       清掉 <目录>/db → 起隔离 release 实例(YS_DB_PATH + 独立 profile + 调试口 9233)→ 播种 →
//       关掉 → 按种子返回的 backdate 把那几条往前挪几天 → 写 <目录>/launch.ps1(之后走查就跑它)。
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
import { walkSeedScript } from "./lib/walk-seed.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const EXE = join(ROOT, "src-tauri/target/release/app.exe");
const PORT = "9233";
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

async function desktop(dir) {
  if (process.platform !== "win32") throw new Error("--desktop 只在 Windows 上跑");
  if (!existsSync(EXE)) throw new Error(`没有 release exe:${EXE}(npm run tauri -- build --no-bundle)`);
  const abs = resolve(dir);
  const db = join(abs, "db");
  const profile = join(abs, "profile");
  rmSync(db, { recursive: true, force: true });
  mkdirSync(db, { recursive: true });
  mkdirSync(profile, { recursive: true });
  const dbFile = join(db, "walk.sqlite3");
  const launch = join(abs, "launch.ps1");
  // .ps1 恒 ASCII-only(memory powershell-utf8-readfile-trap):路径里有中文就当场拒
  if (/[^\x00-\x7f]/.test(abs)) throw new Error(`目录路径要纯 ASCII(launch.ps1 会读它):${abs}`);
  writeFileSync(
    launch,
    [
      `$env:YS_DB_PATH = '${dbFile}'`,
      `$env:WEBVIEW2_USER_DATA_FOLDER = '${profile}'`,
      `$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=${PORT}'`,
      `$p = Start-Process '${EXE}' -PassThru`,
      `$p.Id | Out-File -Encoding ascii '${join(abs, "app.pid")}'`,
      `Write-Output $p.Id`,
      "",
    ].join("\r\n"),
  );
  const ps = () => spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launch], { encoding: "utf8" });
  const kill = (pid) => spawnSync("taskkill", ["/PID", pid, "/F"], { encoding: "utf8" });

  const pid = ps().stdout.trim();
  if (!/^\d+$/.test(pid)) throw new Error(`起实例没拿到 pid:${pid}`);
  try {
    let ready = false;
    for (let i = 0; i < 30 && !ready; i++) {
      await sleep(1000);
      const r = cdp("desktop-cdp.mjs", ["eval", "document.readyState==='complete' && !!window.__TAURI__"], { ZJ_CDP_PORT: PORT });
      ready = r.ok && r.value === true;
    }
    if (!ready) throw new Error("30 秒内 CDP 没起来");
    const r = cdp("desktop-cdp.mjs", ["evalfile", seedFile("capture_note"), "--timeout", "180000"], { ZJ_CDP_PORT: PORT });
    if (!r.ok) throw new Error(`播种失败:${r.err || r.out}`);
    const res = r.value;
    if (!res?.backdate) throw new Error(`播种没回结果:${r.out}`);
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

if (argv[0] === "--desktop" && argv[1]) await desktop(argv[1]);
else if (argv[0] === "--android") android();
else {
  console.error("用法: node scripts/walk-seed.mjs --desktop <目录> | --android  [--lang zh]");
  process.exit(2);
}
