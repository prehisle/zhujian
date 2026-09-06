#!/usr/bin/env node
// 发版版本号 bump(backlog 测试与工装 81 落地):一条命令改完一侧的**全部**版本号落点,
// 重生成那一侧的两份 lock,回读校验。
//
// 用法:
//   node scripts/bump-version.mjs 0.2.42 --desktop        桌面侧(含官网三处)
//   node scripts/bump-version.mjs 0.3.38 --android        安卓侧(含官网一处)
//   node scripts/bump-version.mjs 0.2.42 --desktop --dry  只印计划,一个字节不写
// 退出码:0 = 全部落点已改且回读对上;非零 = 停在改之前或改到一半(响亮,见输出)。
//
// ⭐ **它为什么存在**:zhujian-ops 流程 4 把这件事记成一张手工清单(桌面三 + 安卓三 + 官网 +
// 四份 lock),已发几十版、每版手做一遍。而 CI **只校验 tag 与两个 `package.json`**:
//   · 桌面侧那三处一致性,发版真实走的是 `gen-update-manifest-ci.mjs`,它**只读 package.json**
//     (查三处一致的是手动路 `gen-update-manifest.mjs`,2026-07-24 换 CI 路之后不在发版链上了)
//     ⇒ `src-tauri/tauri.conf.json` 漏 bump 的后果不是红,是**用户端更新死循环**:
//     装上去的 app 自报旧版(版本从 conf 烤进二进制),线上 `latest.json` 写着新版,永远差一版。
//   · 安卓侧三处由 `gen-android-update-manifest.mjs` 在 CI 里查(那条还在链上)。
//   · **官网与四份 lock 谁也不查** —— 根 `package-lock.json` 就这样停在旧版停了七个版本。
// ⇒ 漏掉的那一格永远不会有人报错。这支脚本就是那道边界。
//
// ⛔ **不判「命令 exit 0」,判文件真变成了什么** —— 两个跑手都有假成功:
//   ①`cargo metadata --offline` 会 **exit 101**(`mac-notification-sys` 在 `--offline` 下下不动),
//     **但版本行已经写进 lock 了**(599 实测);
//   ②`npm install --package-lock-only` **跑了不等于写了**(376 实栽):第一次 npm 判「up to date」
//     直接走人,第二次才写。
//   两处一律走同一条判据:`git diff -U0 <lock>` 改动的行**只许是那一两行版本行**,别的都停。
//   这同时挡住 npm 顺手漂别的依赖 —— 发版 bump 那笔的改动面不该出现第三种东西。
//
// ⚠ **官网命中数不写死**:`site/index.html` 里桌面版本串眼下 3 处、安卓 1 处,但那是页面长什么样
//   决定的,写死就会腐烂成假绿。这里的判据是 **≥1 处命中 + 改完全文一处旧版串都不剩**,
//   并把每一处命中的行号与原文印出来给人看。
//
// ⛔ **鸿蒙(`ohos/`)不在这支里**:564 起它自成一套(只改 `ohos/src-tauri/tauri.conf.json`,
//   `AppScope/app.json5` 构建期派生),且版本序列刻意与安卓解绑(商店驳回重传要 versionCode 递增)。

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SITE = "site/index.html";

const die = (msg) => {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
};

// ── 两侧的落点表 ──────────────────────────────────────────────────────────────
// `authority` = 现版本从哪儿读(也正是 CI 校验 tag 用的那份)。
// `files` 的 `hits` 是**结构性**的(一个文件一处版本声明),对不上就是仓的形变了,停。
const SIDES = {
  desktop: {
    label: "桌面",
    tagPrefix: "v",
    authority: "package.json",
    files: [
      { path: "package.json", kind: "json" },
      { path: "src-tauri/tauri.conf.json", kind: "json" },
      { path: "src-tauri/Cargo.toml", kind: "cargo" },
    ],
    cargo: { dir: "src-tauri", lock: "src-tauri/Cargo.lock", crate: "app" },
    npm: { dir: ".", lock: "package-lock.json" },
  },
  android: {
    label: "安卓",
    tagPrefix: "android-v",
    authority: "android/package.json",
    files: [
      { path: "android/package.json", kind: "json" },
      { path: "android/src-tauri/tauri.conf.json", kind: "json" },
      { path: "android/src-tauri/Cargo.toml", kind: "cargo" },
    ],
    cargo: { dir: "android/src-tauri", lock: "android/src-tauri/Cargo.lock", crate: "zhujian-android" },
    npm: { dir: "android", lock: "android/package-lock.json" },
  },
};

// ── 参数 ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const dry = argv.includes("--dry");
const picked = Object.keys(SIDES).filter((s) => argv.includes(`--${s}`));
const positional = argv.filter((a) => !a.startsWith("--"));

if (picked.length !== 1 || positional.length !== 1) {
  console.error("用法: node scripts/bump-version.mjs <x.y.z> --desktop|--android [--dry]");
  console.error("      一次只发一侧;桌面与安卓两条 release workflow 本就独立。");
  process.exit(1);
}
const side = SIDES[picked[0]];
const next = positional[0];

// 每格 0-999:安卓 versionCode = x*1_000_000 + y*1_000 + z(build-android.mjs / build-ohos.mjs 同源),
// 越界会把两个不同版本算成同一个 code。桌面一并按这个口径收,免得两侧规矩不一样。
const parts = next.split(".");
if (parts.length !== 3 || !parts.every((p) => /^\d{1,3}$/.test(p))) {
  die(`版本号 ${JSON.stringify(next)} 不是 x.y.z(每格 0-999)。`);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" });

// ── 现版本 + 递增校验 ─────────────────────────────────────────────────────────
const cur = JSON.parse(read(side.authority)).version;
if (typeof cur !== "string") die(`${side.authority} 里读不出 version。`);
const num = (v) => v.split(".").map(Number).reduce((a, p) => a * 1000 + p, 0);
if (next === cur) die(`${side.label}现在就是 ${cur},没什么可 bump 的。`);
if (num(next) < num(cur)) {
  die(
    `${side.label}要从 ${cur} 退到 ${next} —— 拒。装了新版的用户收不到「更新」到旧版\n` +
      `  (updater 比 semver),安卓 versionCode 递减则商店与设备直接拒装。`,
  );
}

// ── 前置:两份 lock 必须干净 ──────────────────────────────────────────────────
// ⭐ **只卡 lock,不卡别的**:lock 那道判据是 `git diff`,起手就脏则判据失效。其余落点靠
// 命中计数 + 回读,脏不脏都判得准 —— 而**一次发版通常两侧都发**,先 `--desktop` 再
// `--android` 时 `site/index.html` 必然已经脏了(两侧共用它),卡下去就得中间插一笔提交。
// 两侧的 lock 互不相交,所以这条卡得住又不挡路。
const touched = [...side.files.map((f) => f.path), SITE, side.cargo.lock, side.npm.lock];
const dirtyLocks = git(["status", "--porcelain", "--", side.cargo.lock, side.npm.lock]).trim();
if (dirtyLocks) {
  die(`${side.label}那两份 lock 有未提交改动,先收干净(lock 判据靠 git diff):\n${dirtyLocks}`);
}
const dirtyRest = git(["status", "--porcelain", "--", ...side.files.map((f) => f.path), SITE]).trim();
if (dirtyRest) console.log(`\n⚠ 这些落点本来就脏(不挡路,但下面的 diff 会混着看):\n${dirtyRest}`);

// ── 命中面:先全量清点,一处对不上就停在「一个字节都还没写」 ──────────────────
const jsonRe = () => new RegExp(`("version":\\s*")${esc(cur)}(")`, "g");
const cargoRe = () => new RegExp(`(^version\\s*=\\s*")${esc(cur)}(")`, "gm");
// 官网写的是 `· v0.2.41</div>`;后面跟数字或点则是另一个更长的版本串,不许误伤。
const siteRe = () => new RegExp(`(v)${esc(cur)}(?![\\d.])`, "g");

const lineOf = (text, index) => text.slice(0, index).split("\n").length;

const plan = [];
for (const f of side.files) {
  const text = read(f.path);
  const re = f.kind === "json" ? jsonRe() : cargoRe();
  const hits = [...text.matchAll(re)];
  if (hits.length !== 1) {
    die(
      `${f.path} 里 version = "${cur}" 命中 ${hits.length} 处,期望恰 1 处 —— 仓的形变了,` +
        `先看一眼那个文件再改这支脚本的落点表。`,
    );
  }
  plan.push({ path: f.path, text, re: f.kind === "json" ? jsonRe() : cargoRe(), hits });
}
{
  const text = read(SITE);
  const hits = [...text.matchAll(siteRe())];
  // 官网不进任何 CI(365 量出三笔躺了一整天)⇒ 它是最容易被漏掉的那一处,0 命中一律当红。
  if (hits.length === 0) {
    die(`${SITE} 里一处 v${cur} 都没有 —— 官网不进 CI,漏在这儿没人会报错,先去看页面。`);
  }
  plan.push({ path: SITE, text, re: siteRe(), hits });
}

console.log(`\n── ${side.label}:${cur} → ${next} ${dry ? "(--dry,不写)" : ""}`);
for (const p of plan) {
  console.log(`  ${p.path}  命中 ${p.hits.length} 处`);
  for (const h of p.hits) {
    const ln = lineOf(p.text, h.index);
    console.log(`    L${ln}: ${p.text.split("\n")[ln - 1].trim()}`);
  }
}

if (dry) {
  console.log(`\n  之后会重生成:${side.cargo.lock} / ${side.npm.lock}`);
  console.log(`  之后要打的 tag:${side.tagPrefix}${next}(zhujian-ops 流程 4 第 4 步)`);
  console.log("\n✔ --dry:以上是全部落点,一个字节都没写。");
  process.exit(0);
}

// ── 写文本落点 ────────────────────────────────────────────────────────────────
for (const p of plan) {
  const out =
    p.path === SITE
      ? p.text.replace(p.re, `$1${next}`)
      : p.text.replace(p.re, `$1${next}$2`);
  writeFileSync(join(root, p.path), out);
}
console.log(`\n✔ ${plan.length} 个文本落点已写。`);

// ── lock:跑手一律不看退出码,判据是 git diff 只动了版本行 ─────────────────────
// 返回改动的正文行(去掉 +++/--- 文件头),空数组 = lock 没动。
function changedLines(lock) {
  return git(["diff", "-U0", "--", lock])
    .split("\n")
    .filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l))
    .map((l) => l.slice(1).trim());
}

// `expect` 是**行数**,不是「大概几行」:一份 Cargo.lock 里本 crate 恰 1 行 version(删 1 加 1 = 2),
// 一份 package-lock.json 恰 2 行(顶层 + `packages[""]`,删 2 加 2 = 4)。这是文件格式定的、不腐烂,
// 而它堵的是内容白名单一个人堵不住的洞:某个**依赖**恰好从 <cur> 涨到 <next> 时,那行长得跟本
// crate 的版本行一模一样,只比内容会放过去。
function assertOnlyVersionLines(lock, allowed, expect) {
  const lines = changedLines(lock);
  if (lines.length === 0) die(`${lock} 一个字都没动 —— 重生成没落到底。`);
  const stray = lines.filter((l) => !allowed.some((a) => a === l));
  if (stray.length || lines.length !== expect) {
    die(
      `${lock} 除了那 ${expect} 行版本行还动了别的,拒(发版 bump 那笔不该出现第三种改动):\n` +
        (stray.length
          ? stray.map((l) => `    ${l}`).join("\n")
          : `    (版本行长相都对,但改了 ${lines.length} 行、期望 ${expect} 行)`) +
        `\n  ⇒ 树现在是半改的,别提交。复位整棵:` +
        `\n     git checkout -- ${touched.join(" ")}` +
        `\n     再单独看那几行是什么。`,
    );
  }
  console.log(`✔ ${lock}:只动了版本行(${lines.length} 行)。`);
}

// Cargo.lock:⚠ exit 101 是常态(mac-notification-sys 在 --offline 下下不动),吞掉不看。
console.log(`\n── 重生成 ${side.cargo.lock}`);
try {
  execFileSync("cargo", ["metadata", "--format-version", "1", "--offline"], {
    cwd: join(root, side.cargo.dir),
    stdio: ["ignore", "ignore", "pipe"],
  });
} catch (e) {
  // 见头注①:**退出码**在这儿不是判据,吞掉。但「压根没跑起来」要分出来说 ——
  // 否则 cargo 不在 PATH 时会一路掉到下面那句「lock 一个字都没动」,人会去查错东西。
  if (e.code === "ENOENT") die("找不到 cargo(它在 ~/.cargo/bin):先 export PATH=\"$HOME/.cargo/bin:$PATH\"。");
}
assertOnlyVersionLines(side.cargo.lock, [`version = "${cur}"`, `version = "${next}"`], 2);
// 再核一眼改的是**本 crate 那一格**,不是别人同名版本行碰巧撞上。
{
  const block = read(side.cargo.lock).match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${esc(side.cargo.crate)}"\\nversion = "([^"]+)"`),
  );
  if (block?.[1] !== next) {
    die(`${side.cargo.lock} 里 ${side.cargo.crate} 的 version = ${block?.[1] ?? "(找不到)"},不是 ${next}。`);
  }
}

// package-lock.json:⚠ 第一次可能判「up to date」走人,故最多跑两趟,每趟后回读。
// ⛔ registry 必须显式带(330 那道闸)。
console.log(`\n── 重生成 ${side.npm.lock}`);
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    execFileSync(
      "npm",
      ["install", "--package-lock-only", "--registry=https://registry.npmjs.org"],
      { cwd: join(root, side.npm.dir), stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" },
    );
  } catch (e) {
    die(`npm install --package-lock-only 第 ${attempt} 趟起不来(要联网):\n${String(e.stderr ?? e).trim()}`);
  }
  if (changedLines(side.npm.lock).length) break;
  console.log(`  第 ${attempt} 趟 npm 判「up to date」没写 lock,再来一趟(376 实栽)。`);
}
assertOnlyVersionLines(side.npm.lock, [`"version": "${cur}",`, `"version": "${next}",`], 4);

// ── 回读:全部从盘上重读一遍 ──────────────────────────────────────────────────
// ⛔ 别拿裸版本串在整个文件里数 —— 两份 lock 里随便一个依赖恰好是 `0.2.41` 就会把回读弄成
// 假红/假绿。每种文件读它**自己那一格**。
console.log("\n── 回读");
const checks = [];
for (const f of side.files) {
  const text = read(f.path);
  const freshRe =
    f.kind === "json"
      ? new RegExp(`"version":\\s*"${esc(next)}"`, "g")
      : new RegExp(`^version\\s*=\\s*"${esc(next)}"`, "gm");
  const fresh = [...text.matchAll(freshRe)];
  const stale = [...text.matchAll(f.kind === "json" ? jsonRe() : cargoRe())];
  checks.push({ rel: f.path, ok: fresh.length === 1 && stale.length === 0, note: `新版 ${fresh.length} 处 / 残留旧版 ${stale.length} 处` });
}
{
  const text = read(SITE);
  const fresh = [...text.matchAll(new RegExp(`v${esc(next)}(?![\\d.])`, "g"))];
  const stale = [...text.matchAll(siteRe())];
  checks.push({ rel: SITE, ok: fresh.length > 0 && stale.length === 0, note: `新版 ${fresh.length} 处 / 残留旧版 ${stale.length} 处` });
}
{
  const v = read(side.cargo.lock).match(
    new RegExp(`\\[\\[package\\]\\]\\nname = "${esc(side.cargo.crate)}"\\nversion = "([^"]+)"`),
  )?.[1];
  checks.push({ rel: side.cargo.lock, ok: v === next, note: `${side.cargo.crate} = ${v ?? "(找不到)"}` });
}
{
  const j = JSON.parse(read(side.npm.lock));
  const top = j.version;
  const self = j.packages?.[""]?.version;
  checks.push({ rel: side.npm.lock, ok: top === next && self === next, note: `顶层 ${top} / packages[""] ${self}` });
}
for (const c of checks) console.log(`  ${c.ok ? "✔" : "✖"} ${c.rel}  ${c.note}`);
const bad = checks.filter((c) => !c.ok).length;
if (bad) die(`${bad} 个文件回读没对上 —— 树是半改的,别提交,逐个看上面那张表。`);

console.log(`\n✔ ${side.label} ${cur} → ${next}:${touched.length} 个文件全部对上。`);
console.log(`  下一步(zhujian-ops 流程 4):本地门禁 → branch-gate verify/land → 打 tag ${side.tagPrefix}${next}`);
