#!/usr/bin/env node
// RustSec 依赖通告闸(backlog 测试与工装 82 落地):把 `cargo audit` 接到一条自动边界上。
//
// ⭐ **它为什么存在**:`cargo audit` 在 80 轮被定成发布门禁、88 轮跑过一次之后**就消失了**
// —— 不在十一道门禁、不在任何 workflow、不在 branch-gate ⇒ 从 88 到 607 这段时间里,
// 密码学 / 网络栈上出通告,**没有任何边界会红**(server 那份 lock 07-11 起没动过)。
// 607 审计当天离线跑一遍,桌面与安卓两份 lock 各有 1 条真通告在躺着。
//
// 用法:
//   node scripts/audit-deps.mjs             刷 advisory-db 后跑(CI 走这个)
//   node scripts/audit-deps.mjs --offline   用本机缓存的 advisory-db 跑(本机翻不出墙,走这个)
// 退出码(同 e2e-verdict / kotlin-test-verdict 的三态口径):0 绿 · 1 红 · 2 判不出。
//
// ⛔ **它不是发版门禁,是警报** —— 刻意不进 `preflight.yml`,也刻意**不进 `ci.yml`**:
//   ①红的来源是**外部数据库**(今晚 RustSec 收一条新通告,明早这棵一个字没动的树就红了),
//     那种红不该挡发版;②`branch-gate land` 的「已知红拒」是按 **workflow 名 `ci`** 判的
//     (`ciVerdict()` 里 `r.name === "ci"`)⇒ 把这一格塞进 `ci.yml`,一条上游 crate 的通告
//     就能把**三个环境的落地**全卡住。故它自己一条 `audit.yml`,红了只发失败邮件。
//
// ⛔ **别看 `cargo audit` 的退出码了事**:找到漏洞退 1,而**连不上 advisory-db 也退 1**
//   (本机实测:`error sending request for url (https://github.com/RustSec/advisory-db.git/...)`)
//   ⇒ 只看退出码,"网络断了"与"发现漏洞"同形。这里一律解析 `--json`:出不来 JSON = 判不出(2),
//   不是绿也不是红。
//
// ⚠ **扫描面自己长**:lock 清单走 `git ls-files "*Cargo.lock"`,新建一个 crate 就自动进面,
//   ⛔ 别改成写死的七行数组(那种清单腐烂时是安静的)。一份都没找到 = 判不出。

import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const offline = process.argv.includes("--offline");

// ── 放行表 ────────────────────────────────────────────────────────────────────
// 一条 = 一个「知道、看过、当前不修」的通告,必须写清 why。⭐ **放行表自己会过期**:
// 下面每条声明了它该命中哪几份 lock,**命中不上就红**(升上去了 / crate 被换掉了 ⇒ 这条
// 该删,而不是继续挂着假装还在守什么)。⛔ 别加"全局忽略"这种形。
const ALLOWED = [
  {
    id: "RUSTSEC-2026-0235",
    crate: "rkyv",
    locks: ["src-tauri/Cargo.lock", "android/src-tauri/Cargo.lock"],
    why:
      "rkyv 0.7.46 归档校验不足致越界读。路径 = tauri → byte-unit → rust_decimal → rkyv," +
      "修法是 >=0.8.17(跨大版本,得等 rust_decimal 那一层动)⇒ 我们这一侧改不动。" +
      "⭐ 实际暴露:`cargo tree -i rkyv` 在当前 target/feature 下**印不出任何路径**" +
      "(它是 rust_decimal 的可选依赖,只是被 Cargo.lock 记着;cargo audit 只读 lock 不看 feature)" +
      "⇒ 编都没编进去,更不存在「app 去反序列化外来 rkyv 归档」这条路。",
  },
];

// ── 取扫描面 ──────────────────────────────────────────────────────────────────
function lockfiles() {
  const raw = execFileSync("git", ["ls-files", "*Cargo.lock"], { cwd: root, encoding: "utf8" });
  return raw.trim().split("\n").map((s) => s.trim()).filter(Boolean);
}

// ── 跑一份 ────────────────────────────────────────────────────────────────────
// 返回 cargo audit 的 JSON 报告;拿不到 JSON 一律抛(上层判 2)。
function auditOne(lock) {
  const args = ["audit", "--json", "--file", lock];
  if (offline) args.push("-n");
  let stdout;
  try {
    stdout = execFileSync("cargo", args, { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (e) {
    // 退 1 既可能是"有漏洞"也可能是"取不到库":有漏洞时 JSON 照样在 stdout 上。
    stdout = e.stdout;
    if (!stdout || !stdout.trim().startsWith("{")) {
      const err = String(e.stderr || e.message || "").trim().split("\n").slice(-4).join("\n");
      throw new Error(`\`cargo audit\` 没给出 JSON(${lock}):\n${err}`);
    }
  }
  return JSON.parse(stdout);
}

function main() {
  const locks = lockfiles();
  if (!locks.length) {
    console.error("⛔ 判不出:`git ls-files \"*Cargo.lock\"` 一份都没找到 —— 在仓里跑了吗?");
    process.exit(2);
  }

  console.log(`RustSec 依赖通告闸 —— ${locks.length} 份 Cargo.lock${offline ? "(离线,用本机缓存的 advisory-db)" : ""}`);

  const unexpected = []; // 未放行的真通告
  const hits = new Map(); // `${id}@${lock}` → 命中的放行条目,用来查放行表过期
  let dbCount = null;
  let dbUpdated = null;

  for (const lock of locks) {
    let report;
    try {
      report = auditOne(lock);
    } catch (e) {
      console.error(`\n⛔ 判不出:${e.message}`);
      if (!offline) console.error("   (本机翻不出墙 ⇒ 本机跑一律带 `--offline`;CI 上出这句才是真事故)");
      process.exit(2);
    }
    dbCount = report.database["advisory-count"];
    dbUpdated = report.database["last-updated"] ?? dbUpdated;

    const deps = report.lockfile["dependency-count"];
    if (!deps) {
      // 「扫了 0 个依赖 + 没有发现 = 绿」正是安静的绿那一形,当场拒。
      console.error(`\n⛔ 判不出:${lock} 报告里 dependency-count = ${deps} —— 这份 lock 是空的?`);
      process.exit(2);
    }

    const vulns = report.vulnerabilities.list || [];
    const warn = Object.entries(report.warnings || {})
      .map(([kind, list]) => `${kind} ${list.length}`)
      .join(" / ") || "无";
    for (const v of vulns) {
      const id = v.advisory.id;
      const allow = ALLOWED.find((a) => a.id === id && a.locks.includes(lock));
      if (allow) hits.set(`${id}@${lock}`, allow);
      else unexpected.push({ lock, id, crate: v.package.name, version: v.package.version, title: v.advisory.title, patched: (v.versions.patched || []).join(", ") });
    }
    const vtag = vulns.length ? `通告 ${vulns.length}(放行 ${vulns.length - unexpected.filter((u) => u.lock === lock).length})` : "通告 0";
    console.log(`  ${lock.padEnd(30)} 依赖 ${String(deps).padStart(4)} · ${vtag} · 警告 ${warn}`);
  }

  console.log(`\nadvisory-db:${dbCount} 条${dbUpdated ? `,最后更新 ${dbUpdated}` : offline ? "(离线跑取不到更新时刻 —— 本机这趟的绿只对本机缓存那一刻成立)" : ""}`);
  console.log("⚠ 警告(unmaintained / unsound)刻意不判红:今天 19 条里大半是 Linux-only 的 gtk3 绑定,判红等于永久红。");

  // 放行表过期检查
  const stale = [];
  for (const a of ALLOWED) for (const lock of a.locks) if (!hits.has(`${a.id}@${lock}`)) stale.push(`${a.id} 在 ${lock} 上`);

  if (hits.size) {
    console.log("\n已放行(每条都是「看过、当前不修」,⛔ 别默默续期):");
    for (const [key, a] of hits) console.log(`  · ${key}(${a.crate})\n      ${a.why}`);
  }

  let bad = false;
  if (unexpected.length) {
    bad = true;
    console.error(`\n⛔ 红:${unexpected.length} 条未放行的通告`);
    for (const u of unexpected) {
      console.error(`  · ${u.id} ${u.crate} ${u.version} —— ${u.title}`);
      console.error(`      ${u.lock}${u.patched ? ` · 修到 ${u.patched}` : ""}`);
    }
    console.error("  处置 = 升上去(`cargo update -p <crate>`,升完把 lock 一起提交),");
    console.error("  或读过之后往本脚本的 ALLOWED 里加一条并写清 why —— ⛔ 两条路之外没有第三条。");
  }
  if (stale.length) {
    bad = true;
    console.error(`\n⛔ 红:放行表有 ${stale.length} 条已经命不中了(说明它守的东西没了,该删):`);
    for (const s of stale) console.error(`  · ${s}`);
  }
  if (bad) process.exit(1);

  console.log("\n✅ 绿:没有未放行的通告,放行表也没过期。");
  console.log("⛔ 诚实边界:它只读 Cargo.lock,不看 feature 是否真把那个 crate 编了进来;");
  console.log("   npm 那两份依赖、以及没进 RustSec 的漏洞,都不在这道闸的面内。");
}

main();
