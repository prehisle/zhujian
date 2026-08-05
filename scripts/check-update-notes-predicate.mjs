#!/usr/bin/env node
// 「更新说明值不值得显」这条判据有**两份独立实现**(桌面 src/update.ts 与安卓
// android/src/main.ts 是两个互不共享代码的 Vite 工程),drift 才是真风险 —— 故用
// 同一组用例同时压两份。跑法:node scripts/check-update-notes-predicate.mjs
//
// 它测的是**真源码里那两个函数**(esbuild 现场转译后按函数名切出来),不是把逻辑
// 再抄一遍——抄一遍就成了自指的空测(292 判例)。切不出来即响亮失败。
import { build } from "esbuild";

const TARGETS = [
  { label: "桌面", entry: "src/update.ts", name: "meaningfulNotes" },
  { label: "安卓", entry: "android/src/main.ts", name: "meaningfulNotes" },
];

// [notes, version, 期望显不显]
const CASES = [
  ["", "0.2.25", false],
  [undefined, "0.2.25", false],
  ["   ", "0.2.25", false],
  ["朱简 v0.2.25", "0.2.25", false], // 桌面 CI 296 前写死的值
  ["朱简安卓版 v0.3.22", "0.3.22", false], // 安卓 gen 脚本的回落值
  ["v0.2.25", "0.2.25", false],
  ["局域网直连:同一个 wifi 下的两台设备自动点对点直传。", "0.2.25", true],
  ["朱简 v0.2.25:局域网直连", "0.2.25", true], // 带版本号但有实质内容 → 照显
  ["修了几个 bug", "0.2.25", true],
];

async function load(entry, name) {
  const r = await build({ entryPoints: [entry], bundle: false, write: false, format: "esm" });
  // 只取那个纯函数,剥掉模块副作用(import css / tauri api / 顶层 DOM 访问)
  const m = r.outputFiles[0].text.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  if (!m) throw new Error(`没在 ${entry} 里切出 ${name} —— 函数改名或换了写法?本检查须同改。`);
  const mod = await import(
    "data:text/javascript," + encodeURIComponent(`${m[0]}\nexport { ${name} };`)
  );
  return mod[name];
}

let fail = 0;
for (const { label, entry, name } of TARGETS) {
  const fn = await load(entry, name);
  console.log(`\n=== ${label}(${entry})===`);
  for (const [notes, ver, want] of CASES) {
    const got = fn(notes, ver) !== "";
    if (got !== want) fail++;
    console.log(
      `${got === want ? "✅" : "❌"} 显=${String(got).padEnd(5)} 期望=${String(want).padEnd(5)} ${JSON.stringify(notes)}`,
    );
  }
}
console.log(fail === 0 ? "\n两份实现口径一致,全部通过。" : `\n${fail} 条不符 —— 两端判据已 drift。`);
process.exit(fail === 0 ? 0 : 1);
