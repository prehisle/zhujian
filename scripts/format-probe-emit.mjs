// 把格式探针的注入体落成一个文件,交给安卓那条 CDP 路跑(backlog 用户面 56)。
//
//   node scripts/format-probe-emit.mjs            # 落到 .fmt-samples/android-inject.js
//   node scripts/android-cdp.mjs forward
//   node scripts/android-cdp.mjs evalfile .fmt-samples/android-inject.js
//
// ⭐ **为什么不新写一支安卓跑手**:`android-cdp.mjs` 的 `evalfile` 已经带 `awaitPromise: true`
// (接得住这个异步注入体),而注入体与样本又来自 `e2e/probes/format-samples.js` 的
// **同一个 `buildInjectable()`** —— 桌面那支探针 `(0,eval)` 的就是这段文本。
// ⇒ 这一步只是「把它写到磁盘上」,没有第二份实现能漂,也没有一行未跑过的驱动代码。
//
// ⛔ **样本缺一枚就整个拒**(退出码 1):这趟去安卓上量的主角就是 HEIC,
// 少了它跑出来的那张表会被读成「安卓这边没这个问题」——那正是用户面 56 在修的病。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_DIR, buildInjectable } from "../e2e/probes/format-samples.js";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? resolve(SAMPLE_DIR, "android-inject.js"));

const { source, samples, missing } = buildInjectable();

if (missing.length > 0) {
  console.error("⛔ 样本不全,拒绝出注入体(缺的那几格会让读数被误读成「这一端没问题」):");
  for (const m of missing) console.error(`   - ${m.key}:${m.why}\n     取它:${m.cmd}`);
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, source, "utf8");

const rel = relative(repo, out).replace(/\\/g, "/");
console.log(`✅ 注入体已落盘:${rel}(${(source.length / 1024).toFixed(1)} KB)`);
console.log(`   样本 ${Object.keys(samples).length} 枚:${Object.keys(samples).join(" ")}`);
console.log(`   样本目录:${SAMPLE_DIR}`);
console.log("\n接着在**插着真机 / 模拟器**的那台上跑(app 要是 devtools 构建且在前台):");
console.log("   node scripts/android-cdp.mjs forward");
console.log(`   node scripts/android-cdp.mjs evalfile ${rel}`);
console.log(
  "\n⚠ 读表时对照先看:png/jpeg/gif/webp 必须 img=ok,broken 必须 img=err;" +
    "\n  这两头有一头不对,整张表作废(是台架坏了,不是引擎不认)。",
);
