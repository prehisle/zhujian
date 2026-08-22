#!/usr/bin/env node
// M5 lockfile 漂移门禁(android-plan §1):关键协议/密码学 crate 的版本必须在
// 全部已提交的 Cargo.lock 间一致。仓里刻意不建 cargo workspace(破 e2e 锚),
// 各 crate 各自持 lock——而 path dep(zhujian-core)的 lock 不控制被依赖时的解析,
// 桌面(src-tauri)与安卓壳各自的 lock 才决定真实编进 app 的版本;两端加密实现
// 漂移会静默破协议(core 的黄金向量测试只护 core 自己 lock 的解析,护不到 app)。
//
// 它同时看住**第二件事**:两份 npm lock 里 `resolved` 的下载源必须是官方 registry
// (318 实栽,见文件下半)。两件事都是「lock 里悄悄漂了个东西进来,而没有任何人会报错」,
// 故合在同一道门禁里 —— 另起一个脚本等于又多一处要记得跑的清单项。
//
// 用法:node scripts/check-lock-drift.mjs
// 全一致 = 退出 0;任一 crate 版本漂移 / npm 下载源非官方 / 点名的 lock 缺失 = 非零响亮。
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

// 全部应提交 lock 的 crate(P4-b 起含安卓壳;OH-c/C3 起含鸿蒙壳)。
// ⚠ 鸿蒙壳那份是**第六份**,加进来的理由与安卓壳同条:它经 path 依赖把 core 整套
// 协议/密码学 crate 解析了一遍,漂了同样会静默破线协议。⛔ 别因为「鸿蒙还没发版」
// 把它排除在外 —— 漂移是在合库那一刻发生的,不是在发版那一刻。
const LOCK_DIRS = ["src-tauri", "core", "server", "sync-proto", "android/src-tauri", "ohos/src-tauri"];

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

// ── 第二件:npm lock 里 `resolved` 的下载源(318 实栽,烧掉约一小时 + 两轮 CI)──
// `npm install --package-lock-only` 会把本机 ~/.npmrc 的 registry **固化进 lock 的
// `resolved`**,而本机那条今天仍写着 registry.npm.taobao.org(重定向到 npmmirror)。
// CI 跑在 GitHub runner 上本就不该走国内镜像:镜像一 502,两条 release CI 全死在
// `npm ci`(npm 会一直重试同一个 502 —— 桌面三平台各卡满 16 分钟才失败)。
// 本地装包用什么源是 `.npmrc` 的事,**不该由 lock 替所有人决定**。
// 这颗雷从 npmmirror 上线起就一直装填着,只是此前它没坏过;318 之后仍是零防护,故补此闸。
const NPM_LOCKS = ["package-lock.json", "android/package-lock.json", "ohos/package-lock.json"];
const OFFICIAL = "registry.npmjs.org";

let srcDrift = false;
for (const rel of NPM_LOCKS) {
  const text = readFileSync(resolve(root, rel), "utf8"); // 缺文件不吞,同 Cargo.lock
  const hosts = new Map(); // host(或非 https 的协议名)-> 条数
  for (const m of text.matchAll(/"resolved":\s*"([^"]+)"/g)) {
    const url = m[1];
    const key = url.startsWith("https://")
      ? url.slice("https://".length).split("/")[0]
      : `非 https(${url.split(":")[0]})`;
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
  }
  const total = [...hosts.values()].reduce((a, b) => a + b, 0);
  // 反向探针:一条都没抽出来,下面那句「全指向官方」就**平凡地**成立了(329 判例:
  // 被验的性质在退化形下照样成立 = 假绿)。故先响亮判死提取器,而不是判它通过。
  if (total === 0) {
    srcDrift = true;
    console.error(`DRIFT ${rel}: 一条 resolved 都没解析到 —— 提取器失灵或 lock 变了形,`);
    console.error("        这不等于「全是官方源」。先修提取器再谈门禁结论。");
    continue;
  }
  const bad = [...hosts.entries()].filter(([h]) => h !== OFFICIAL);
  if (bad.length === 0) {
    console.log(`  ok  ${rel} ${total} 处 resolved 全指向 ${OFFICIAL}`);
  } else {
    srcDrift = true;
    console.error(`DRIFT ${rel}: resolved 指向了非官方源 ——`);
    for (const [h, n] of bad) console.error(`        ${h}: ${n} 处`);
  }
}

if (drift) {
  console.error("\nlockfile 漂移:先对齐版本(cargo update -p <crate> --precise <ver>)再过门禁。");
}
if (srcDrift) {
  console.error(
    "\nnpm lock 的下载源漂了:CI 上 `npm ci` 会去够不着(或会 502)的源拉包,整条 release 打死。" +
      "\n修法 = 纯 host 替换回 registry.npmjs.org(两个源路径结构一致,integrity 是内容哈希、不受影响)," +
      "\n验证不能只看「字符串换对了」:把 lock 复制进临时目录真跑一次" +
      "\n`npm ci --registry=https://registry.npmjs.org`,EXIT=0 才算数。" +
      "\n以后跑 `npm install --package-lock-only` 一律显式带 --registry=https://registry.npmjs.org。",
  );
}
if (drift || srcDrift) process.exit(1);
console.log("\nlock 门禁通过:关键 crate 版本全库一致,npm 下载源全指向官方 registry。");
