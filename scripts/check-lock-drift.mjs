#!/usr/bin/env node
// M5 lockfile 漂移门禁(android-plan §1):关键协议/密码学 crate 的版本必须在
// 全部已提交的 Cargo.lock 间一致。仓里刻意不建 cargo workspace(破 e2e 锚),
// 各 crate 各自持 lock——而 path dep(zhujian-core)的 lock 不控制被依赖时的解析,
// 桌面(src-tauri)与安卓壳各自的 lock 才决定真实编进 app 的版本;两端加密实现
// 漂移会静默破协议(core 的黄金向量测试只护 core 自己 lock 的解析,护不到 app)。
//
// 用法:node scripts/check-lock-drift.mjs
// 全一致 = 退出 0;任一 crate 版本漂移 / 点名的 lock 缺失 = 非零响亮。
// 发版门禁之一(与 cargo audit 并列,见 docs/dev-and-testing.md)。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// 看住的 crate(android-plan §1 M5 点名的 + 密码学全家):线上格式与密码学行为的载体。
const WATCH = [
  "rustls",
  "ring",
  "tokio-tungstenite",
  "tungstenite",
  "ciborium",
  "chacha20poly1305",
  "hkdf",
  "hmac",
  "sha2",
  "spake2",
  "ed25519-dalek",
  "curve25519-dalek",
];

// 全部应提交 lock 的 crate(P4-b 起含安卓壳)。
const LOCK_DIRS = ["src-tauri", "core", "server", "sync-proto", "android/src-tauri"];

function versionsIn(lockPath) {
  // 缺文件不吞:点名的 lock 必须在(fail-fast,别让门禁静默变窄)。
  const text = readFileSync(lockPath, "utf8");
  const map = new Map(); // name -> Set<version>(同名多版本共存是 cargo 真实情况,全记)
  for (const m of text.matchAll(/\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g)) {
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(m[2]);
  }
  return map;
}

const locks = LOCK_DIRS.map((d) => ({ dir: d, pkgs: versionsIn(resolve(root, d, "Cargo.lock")) }));

let drift = false;
for (const name of WATCH) {
  const present = locks
    .filter((l) => l.pkgs.has(name))
    .map((l) => ({ dir: l.dir, vers: [...l.pkgs.get(name)].sort().join("+") }));
  if (present.length === 0) continue; // 谁都不用它(WATCH 面向未来,允许超前点名)
  const distinct = new Set(present.map((p) => p.vers));
  if (distinct.size === 1) {
    console.log(`  ok  ${name} ${present[0].vers}  (${present.map((p) => p.dir).join(", ")})`);
  } else {
    drift = true;
    console.error(`DRIFT ${name}:`);
    for (const p of present) console.error(`        ${p.dir}: ${p.vers}`);
  }
}

if (drift) {
  console.error("\nlockfile 漂移:先对齐版本(cargo update -p <crate> --precise <ver>)再过门禁。");
  process.exit(1);
}
console.log("\nlock 门禁通过:关键 crate 版本全库一致。");
