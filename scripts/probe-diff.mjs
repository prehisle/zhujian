#!/usr/bin/env node
// 长文历史比对(shared/diff.ts + diff-dom.ts)的**真机资源探针**:在手机浏览器里把最贵的几族各跑
// 几遍,回传墙钟,用来定 diff.ts 头注那几个预算数(longform-plan §7 第 2b 格)。
// 跑法:node scripts/probe-diff.mjs --adb   (USB 插着的安卓:adb reverse + 拉起 Chrome)
//       node scripts/probe-diff.mjs         (只起服务,自己在设备上打开打印出来的地址)
// 结果打在终端,并写 `.zjshots/probe-diff-<时间>.json`。
//
// ⚠ 量的是设备上的 **Chrome**,不是 app 的 WebView:同一颗 CPU、同一代 V8(Android System WebView
// 跟着 Chrome 发版),当预算标尺够用;⛔ 别拿它当「app 里不卡」的证明 —— 那是第 4b 格的真机验收。
// 鸿蒙的 ArkWeb 内核不同,要在鸿蒙真机上另跑一次(hdc rport 把端口反向转过去,再在设备浏览器打开)。
import { build } from "esbuild";
import http from "node:http";
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PORT = 8765;
const useAdb = process.argv.includes("--adb");

const bundle = (
  await build({
    stdin: { contents: 'export * from "./shared/diff"; export * from "./shared/diff-dom";', resolveDir: process.cwd(), loader: "ts" },
    bundle: true,
    write: false,
    format: "iife",
    globalName: "D",
    target: "es2021",
  })
).outputFiles[0].text;

// 在设备上跑的那段:每族先预热 1 遍、再量 5 遍取中位数;DOM 族连真 DOM 一起建。
const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<pre id="o">跑着……</pre><script>${bundle}</script><script>
const fams = {
  "全异短行(行级 D 到顶降级)": () => { const f = (p) => Array.from({ length: 25000 }, (_, i) => p + i + "\\n").join(""); return [f("a"), f("b")]; },
  "满屏同一行、稀疏替换(D≈1000)": () => { const A = [], B = []; for (let i = 0; i < 97000; i++) { A.push(i % 200 === 0 ? "m" + i : "x"); B.push(i % 200 === 0 ? "n" + i : "x"); } return [A.join("\\n"), B.join("\\n")]; },
  "字级最贵一对(工作预算到顶)": () => { const s = (b) => Array.from({ length: 1999 }, (_, i) => String.fromCodePoint(b + i)).join("") + "\\n"; return [s(0x4e00), s(0x6000)]; },
  "512 对全异短行(D=1024 + 逐对细化)": () => { const f = (p) => Array.from({ length: 512 }, (_, i) => p + "第" + i + "行的一些字\\n").join(""); return [f("甲"), f("乙")]; },
  "十万空行夹两处改动": () => { const b = "\\n".repeat(100000); return ["a\\n" + b + "b\\n", "A\\n" + b + "B\\n"]; },
};
const out = { ua: navigator.userAgent, cores: navigator.hardwareConcurrency, rows: [] };
const med = (xs) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
for (const [name, f] of Object.entries(fams)) {
  const [a, b] = f();
  const r0 = D.diffText(a, b);
  const calc = [], dom = [];
  for (let i = 0; i < 6; i++) {
    let t = performance.now(); D.diffText(a, b); const c = performance.now() - t;
    t = performance.now(); const r = D.renderDiff(a, b); document.body.append(r.root); r.root.getBoundingClientRect(); r.root.remove(); const d = performance.now() - t;
    if (i > 0) { calc.push(c); dom.push(d); }
  }
  out.rows.push({ name, ok: r0.ok, reason: r0.ok ? null : r0.reason, limited: r0.ok ? r0.limited : null, nodes: r0.ok ? r0.nodes : null, work: r0.stats.work, peakMem: r0.stats.peakMem, d: r0.stats.d, calcMs: +med(calc).toFixed(1), calcMax: +Math.max(...calc).toFixed(1), withDomMs: +med(dom).toFixed(1) });
  document.getElementById("o").textContent = JSON.stringify(out, null, 1);
}
fetch("/result", { method: "POST", body: JSON.stringify(out) }).then(() => { document.getElementById("o").textContent += "\\n已回传"; });
</script>`;

const srv = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/result") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.end("ok");
      const r = JSON.parse(body);
      console.log(r.ua, `cores=${r.cores}`);
      console.table(r.rows);
      fs.mkdirSync(".zjshots", { recursive: true });
      const f = `.zjshots/probe-diff-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      fs.writeFileSync(f, JSON.stringify(r, null, 1));
      console.log("写进了", f);
      if (useAdb) execFileSync("adb", ["reverse", "--remove", `tcp:${PORT}`]);
      srv.close();
    });
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(page);
});
srv.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}/?t=${Date.now()}`;
  console.log("探针在", url);
  if (useAdb) {
    execFileSync("adb", ["reverse", `tcp:${PORT}`, `tcp:${PORT}`]);
    execFileSync("adb", ["shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", url, "-p", "com.android.chrome"]);
    console.log("已在手机 Chrome 打开;等回传(手机要亮屏解锁)");
  }
});
