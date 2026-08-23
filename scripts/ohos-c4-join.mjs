// 鸿蒙 C4 面③「加入空间正路」的 **PC 侧台架**(OH-c/C4;跑手是 scripts/ohos-c4.mjs)。
//
// # 它是什么
//
// 「加入空间」要两样手机自己给不了的东西:**一台够得着的同步服务器**,和**一台已经
// 在那个账户里的老设备**(配对码只能由成员设备开槽发出)。这个脚本把两样都在本机起好:
//
//   ①`zhujian-syncd` 听 127.0.0.1:8791(临时 data-dir,`--free-seat-quota 4`);
//   ②**老设备 = 桌面朱简自己**,用 `YS_DB_PATH` 开在一个临时库上 —— 那个模式**禁扫也
//     禁建空间**、单实例门刻意不装、`WriterLease` 落在那个临时目录 ⇒ 真实笔记本一根
//     手指都碰不到,而创号 / 出配对码这两条命令照常能用;
//   ③参数口听 127.0.0.1:8792:手机连上来的**那一刻**才向老设备现要一枚新配对码,
//     答两行(服务器地址 / 配对码)就关。
//   ④`hdc rport` 把 8791/8792 反接到设备的 127.0.0.1 上 —— 手机**不必上 Wi-Fi、
//     PC 不必开防火墙**(2026-08-23 实测:设备 `netstat -an` 里真有这两条 LISTEN)。
//
// ⭐ **走法的判据不是新发明的,是仓里现成的判例**:429 验「恢复 → 创号 → 第二台加进来」
// 走的就是本机 syncd + 同机第二身份,账里专门记了一句「一台机器跑完、用户零操作」;
// 同族 317 亦然。⛔ **别改用线上那台** —— 那是在生产上创账户留痕迹,属「动生产先确认」
// 那一档(backlog 条 18 / progress-log 466 补二)。
//
// # 用法
//
//   node scripts/ohos-c4-join.mjs            起台架并**挂着**(参数口要一直在)
//   node scripts/ohos-c4-join.mjs stop       收场:按 pid 停两个子进程 + 撤 rport
//
// 起好之后另开一个终端点手机上那枚按钮:`node scripts/ohos-c4.mjs tap 14`。
//
// ⛔ **停子进程一律按 pid,别按进程名** —— `app.exe` 这个名字用户的真朱简也叫它,
// `taskkill /IM` 会把人家的工作窗一起杀了。
//
// ⚠ 台架目录在 `.zjshots/c4-join/`(整个 `.zjshots/` 已进 .gitignore,466 那笔),
// 里头有一份真库 + 一枚真账户密钥 —— 都是一次性的,`stop` 之后可以整目录删。

import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(repoRoot, ".zjshots", "c4-join");
const pidFile = join(stage, "pids.json");
const SERVER_PORT = 8791;
const PARAM_PORT = 8792;
const SERVER_URL = `ws://127.0.0.1:${SERVER_PORT}`;
const CDP_PORT = 9223; // desktop-cdp.mjs 里写死的那个

const die = (msg) => {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
};

const hdcPath = process.env.OHOS_HDC ?? "G:\\ohos-sdk\\toolchains\\hdc.exe";
const hdc = (args) =>
  spawnSync(hdcPath, args, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });

// ---- stop ------------------------------------------------------------------

if (process.argv[2] === "stop") {
  if (!existsSync(pidFile)) die(`没有 ${pidFile} —— 台架没起过?(手工核一遍再说)`);
  const pids = JSON.parse(readFileSync(pidFile, "utf8"));
  for (const [name, pid] of Object.entries(pids)) {
    const r = spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], { encoding: "utf8" });
    console.log(`停 ${name}(pid ${pid}):${(r.stdout + r.stderr).trim()}`);
  }
  rmSync(pidFile, { force: true });
  for (const p of [PARAM_PORT, SERVER_PORT]) {
    // ⚠ **两个独立参数,不是一个带空格的串** —— `fport ls` 印出来的是
    // `tcp:8791 tcp:8791`,照着当一个 taskstr 传进去,hdc 答
    // 「ruler is not exist "tcp:8791 tcp:8791"」(2026-08-23 实测,三种写法只有这种成)。
    const r = hdc(["fport", "rm", `tcp:${p}`, `tcp:${p}`]);
    console.log(`撤 rport tcp:${p}:${(r.stdout + r.stderr).trim()}`);
  }
  console.log(`\n⚠ 台架目录还在:${stage}(一份临时库 + 一枚一次性账户密钥,可整目录删)`);
  process.exit(0);
}

// ---- 起台架 ----------------------------------------------------------------

if (existsSync(pidFile)) {
  die(`${pidFile} 还在 —— 上一趟台架可能还挂着。先 \`node scripts/ohos-c4-join.mjs stop\``);
}

const syncd = join(repoRoot, "server", "target", "release", "zhujian-syncd.exe");
const openerExe = join(repoRoot, "src-tauri", "target", "release", "app.exe");
for (const [what, p] of [["同步服务端", syncd], ["桌面朱简(老设备)", openerExe]]) {
  if (!existsSync(p)) die(`找不到${what}:${p}`);
}
if (!existsSync(hdcPath)) die(`找不到 hdc:${hdcPath}(设 OHOS_HDC 指过去)`);

mkdirSync(stage, { recursive: true });
const syncdData = join(stage, "syncd");
mkdirSync(syncdData, { recursive: true });
// banlist.txt 必须在(空文件 = 零封禁);registry.json 不存在会自己建。
writeFileSync(join(syncdData, "banlist.txt"), "# C4 台架,一次性\n");
const openerDb = join(stage, "opener.sqlite3");
const webview2 = join(stage, "webview2");

const pids = {};
const saveP = () => writeFileSync(pidFile, JSON.stringify(pids, null, 2));

console.log(`── 起 zhujian-syncd(${SERVER_URL},data-dir=${syncdData})`);
const srv = spawn(syncd, ["--listen", `127.0.0.1:${SERVER_PORT}`, "--data-dir", syncdData, "--free-seat-quota", "4"], {
  stdio: ["ignore", "inherit", "inherit"],
});
pids.syncd = srv.pid;
saveP();

console.log(`── 起老设备(桌面朱简 + YS_DB_PATH 隔离:${openerDb})`);
const opener = spawn(openerExe, [], {
  stdio: ["ignore", "inherit", "inherit"],
  env: {
    ...process.env,
    // ⭐ 这一条就是隔离本身:该模式禁扫也禁建空间、不装单实例门、租约落在这个库旁边。
    YS_DB_PATH: openerDb,
    WEBVIEW2_USER_DATA_FOLDER: webview2,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  },
});
pids.opener = opener.pid;
saveP();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/// 走 desktop-cdp.mjs(134 手法,已焊过坑)喂一段表达式给老设备的 notebook 页。
/// 返回它的值;⛔ 失败原样抛,别翻译成和缓的话。
const evalInOpener = (expr, timeoutMs = 60000) => {
  const r = spawnSync("node", [join(repoRoot, "scripts", "desktop-cdp.mjs"), "eval", expr, "--timeout", String(timeoutMs)], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  if (r.status !== 0) throw new Error(`CDP 失败:${(r.stdout ?? "") + (r.stderr ?? "")}`);
  const out = JSON.parse(r.stdout);
  return out.value;
};

const invokeIn = (cmd, args = {}) =>
  evalInOpener(
    `(async () => { try { return { ok: await window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}) }; }` +
      ` catch (e) { return { err: String(e) }; } })()`,
  );

const must = (what, r) => {
  if (r && typeof r === "object" && "err" in r) throw new Error(`${what} 失败:${r.err}`);
  return r.ok;
};

/// 老设备起来没有:轮到 `list_spaces` 真答得出为止。
/// ⛔ 不靠 sleep 猜 —— WebView2 起多久看机器心情,而后面每一步都指着它。
const waitOpener = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const spaces = invokeIn("list_spaces");
      if (spaces && spaces.ok) return spaces.ok;
    } catch {
      /* 还没起来 —— 这是唯一允许吞的一格,下面有总超时兜着 */
    }
    await sleep(1000);
  }
  throw new Error("老设备 60 秒都没把 list_spaces 答出来(CDP 口没开?窗口崩了?)");
};

/// 独立观测:拿 node 自己的 sqlite 直读老设备那份库数各表几行。
/// ⭐ **刻意不问 app** —— 手机那边报的数要有个不同来路的东西去比
/// (memory `verification-independence`)。
const openerCounts = () => {
  const expr =
    "const{DatabaseSync}=require('node:sqlite');" +
    `const d=new DatabaseSync(process.argv[1],{readOnly:true});` +
    "const n=(t)=>d.prepare('SELECT COUNT(*) c FROM '+t).get().c;" +
    "console.log(JSON.stringify({items:n('items'),topics:n('topics'),links:n('item_topic')," +
    "images:n('item_image'),revisions:n('item_revisions'),ops:n('oplog')}));";
  const r = spawnSync("node", ["--experimental-sqlite", "-e", expr, openerDb], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`直读老设备库失败:${r.stdout}${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
};

const setup = async () => {
  const spaces = await waitOpener();
  console.log(`   老设备就绪,空间清单:${spaces.map((s) => s.id).join(" ")}`);
  if (spaces.length !== 1 || spaces[0].id !== "main") {
    throw new Error(`隔离没生效 —— YS_DB_PATH 模式下该只有 main,实得 ${JSON.stringify(spaces.map((s) => s.id))}`);
  }

  console.log("── 老设备创号(open-signup 无感创号,账户 ULID 客户端自生成)");
  must("创号", invokeIn("sync_create_account", { spaceId: "main", serverUrl: SERVER_URL }));
  // ⚠ 恢复码就地丢弃:这个账户是一次性的,而把它印在日志里等于把密钥写进仓外文件。

  console.log("── 种数据(4 条目 / 1 标签 / 1 挂接)");
  const n1 = must("随记1", invokeIn("capture_note", { spaceId: "main", content: "C4③ 随记一:鸿蒙加入空间" }));
  must("随记2", invokeIn("capture_note", { spaceId: "main", content: "C4③ 随记二:引导要把我带过去" }));
  must("随记3", invokeIn("capture_note", { spaceId: "main", content: "C4③ 随记三:数目要对得上" }));
  must("任务", invokeIn("create_task", { spaceId: "main", title: "C4③ 一条任务" }));
  const tid = must("标签", invokeIn("create_topic", { spaceId: "main", title: "C4三号标签" }));
  // ⚠ 参数名是 `topicId` / `newTitle`(lib.rs::file_note_to_topic),⛔ 别凭印象写 topicTitle。
  must("挂标签", invokeIn("file_note_to_topic", { spaceId: "main", id: n1, topicId: tid }));

  // 上线等一等:创号后 transport 要重连一次,配对开槽得在**连上之后**才发得出去。
  for (let i = 0; i < 30; i += 1) {
    const st = must("状态", invokeIn("sync_status", { spaceId: "main" }));
    if (st.state === "online") break;
    if (i === 29) throw new Error(`老设备 30 秒没上线(state=${st.state} error=${st.error})`);
    await sleep(1000);
  }
  const counts = openerCounts();
  console.log(`   老设备库(node 直读,与 app 无关):${JSON.stringify(counts)}`);
  return counts;
};

const counts = await setup();

// ---- 反向端口 + 参数口 ------------------------------------------------------

for (const p of [SERVER_PORT, PARAM_PORT]) {
  const r = hdc(["rport", `tcp:${p}`, `tcp:${p}`]);
  const out = (r.stdout + r.stderr).trim();
  // 已经挂过会答 "TCP Port listen failed" 之类 —— 那不是错,`fport ls` 里在就行。
  console.log(`── rport tcp:${p} → 127.0.0.1:${p}:${out}`);
}
console.log((hdc(["fport", "ls"]).stdout ?? "").trim());

let served = 0;
const param = createServer((sock) => {
  served += 1;
  const at = new Date().toISOString();
  console.log(`\n── 手机连上参数口了(第 ${served} 次,${at})—— 现向老设备要一枚新配对码`);
  let code;
  try {
    code = must("开配对槽", invokeIn("sync_pair_start", { spaceId: "main" }));
  } catch (e) {
    console.error(`✖ 要不到配对码:${e}`);
    sock.end();
    return;
  }
  console.log(`   配对码 ${code}(十分钟有效、只能用一次)`);
  sock.end(`${SERVER_URL}\n${code}\n`);
});
param.listen(PARAM_PORT, "127.0.0.1", () => {
  console.log(
    [
      "",
      "════ 台架就绪 ════",
      `  服务器      ${SERVER_URL}(data-dir ${syncdData})`,
      `  老设备      ${openerExe}  ← YS_DB_PATH=${openerDb}`,
      `  老设备库    ${JSON.stringify(counts)}`,
      `  参数口      127.0.0.1:${PARAM_PORT}(连上才现要码)`,
      "",
      "  下一步(另一个终端):node scripts/ohos-c4.mjs tap 14",
      "  收场        :node scripts/ohos-c4-join.mjs stop",
      "",
    ].join("\n"),
  );
});
