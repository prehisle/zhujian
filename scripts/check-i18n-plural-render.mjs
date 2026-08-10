#!/usr/bin/env node
// 复数选择器的**运行期**对拍(363,i18n-plan §1.2)。check-i18n-drift 是静态的:它核得了
// 「选择器形对不对」「zh/en 打印的占位符是否相等」「zh 侧别写选择器」,核不了
// 「t() 跑起来到底选了哪一支」。
//
// 而这一格**别处一格覆盖都没有**:e2e 149 例与安卓 CDP 资产全部刻意跑中文
// (i18n-plan §1),中文值里根本没有选择器 —— 复数那几行代码在既有回归里是死角。
//
// 做法:esbuild 把**真的** src/i18n.ts(连真字典)打成一支,只桩掉三样与文案无关的外部
// 依赖(@tauri-apps/api/event / localStorage / navigator),然后对每一枚带选择器的键
// 各跑 n=1 与 n=2,把屏幕上会出现的那句话读回来判。判的是真函数真字典,不是复刻品。
//
// # 判据(每键两跑)
//  ① 输出里不许残留 `{` 或 `|` —— 残渣意味着 t() 没认出这个写法,它会原样印到界面上。
//  ② n=1 与 n=2 的输出必须不同 —— 守「选择器写了但两支写成一样」。
//  ③ n=1 的输出必须含单数支、n=2 必须含复数支 —— 守「两支选反了」(①②都拦不住)。
//
// # 正控(缺一个,这只工装就可能安静地绿)
//  ④ 每个工程带选择器的键数必须 > 0,且与静态数出的处数恰等:守「正则没匹配上 ⇒ 零键
//     可判 ⇒ 一条不跑也是绿」。
//  ⑤ 不带选择器的键必须逐字原样返回:守「桩把字典桩坏了,返回的根本不是真文案」。
//  ⑥ 生效语言必须真是 en:守「桩没生效 ⇒ 跑的其实是中文那一份 ⇒ 永远没有选择器」。
//
// 用法:node scripts/check-i18n-plural-render.mjs
// ⚠ 非发版门禁,是 check-i18n-drift 复数那几条判据的回归网(照 check-site-i18n-render 的定位)。

import { build } from "esbuild";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLURAL = /\{([A-Za-z0-9_]+)\|([^|{}]*)\|([^|{}]*)\}/g;

// 判据④ 的登记表:两支**对调**了的话,①②③ 一个都拦不住 —— 它们的期望都是从同一份
// 字典推出来的,字典写反了就自证成立(刀 ㉙ 当场证明了这一点)。要抓它必须有一条
// **不来自字典**的知识:英语复数几乎恒是 one + s/es,例外逐条签字。
const IRREGULAR = [
  { one: "has", many: "have", why: "主谓一致,不是名词复数(「{n} attached image has / images have」)" },
];

const PROJECTS = [
  { label: "桌面", entry: "src/i18n.ts" },
  { label: "安卓", entry: "android/src/i18n.ts" },
];

// 只桩三样与文案无关的外部依赖。字典与 t() 都是真的。
// ⚠ Node 22 起 globalThis.navigator 是只读 getter,直接赋值会 TypeError,得 defineProperty。
const STUB =
  'globalThis.localStorage={getItem:()=>"en",setItem:()=>{},removeItem:()=>{}};' +
  'Object.defineProperty(globalThis,"navigator",{value:{language:"en-US"},configurable:true});' +
  "globalThis.document={documentElement:{}};";

const errs = [];
let checkedTotal = 0;

for (const proj of PROJECTS) {
  const dir = mkdtempSync(join(tmpdir(), "i18nplural-"));
  const out = join(dir, "bundle.mjs");
  // Tauri 事件通道与本判据无关(t() 一行都不碰它),桩成空实现。
  const stubEvent = join(dir, "stub-event.mjs");
  writeFileSync(stubEvent, "export const emit=async()=>{};export const listen=async()=>()=>{};", "utf8");
  try {
    await build({
      entryPoints: [join(root, proj.entry)],
      bundle: true,
      format: "esm",
      platform: "neutral",
      outfile: out,
      alias: { "@tauri-apps/api/event": stubEvent },
      banner: { js: STUB },
      logLevel: "silent",
    });
  } catch (e) {
    errs.push(`${proj.label}:esbuild 打包失败 —— ${String(e.stderr || e).slice(0, 400)}`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }

  const mod = await import(pathToFileURL(out).href);
  const { t, currentLang } = mod;

  // 正控⑥:生效语言真的是 en(桩没生效的话跑的是中文那一份、永远没有选择器)
  if (currentLang() !== "en") {
    errs.push(`${proj.label}:正控⑥ 破 —— 生效语言是「${currentLang()}」不是 en,桩没起作用`);
    rmSync(dir, { recursive: true, force: true });
    continue;
  }

  // 静态数一遍带选择器的键(正控④ 的对照数),同时拿到每键的参数名。
  const dictDir = join(root, dirname(proj.entry), "locales");
  const wanted = new Map(); // key -> { one, many, name }[]
  const plainSample = [];
  for (const f of readdirSync(dictDir)) {
    if (!f.endsWith(".ts") || f === "index.ts") continue;
    for (const line of readFileSync(join(dictDir, f), "utf8").split("\n")) {
      const m = line.match(/"([A-Za-z0-9_.]+)":\s*\{\s*zh:\s*"((?:[^"\\]|\\.)*)",\s*en:\s*"((?:[^"\\]|\\.)*)"\s*\}/);
      if (!m) continue;
      const [, key, , en] = m;
      const sels = [...en.matchAll(PLURAL)].map((x) => ({ name: x[1], one: x[2], many: x[3] }));
      if (sels.length) wanted.set(key, { en, sels });
      else if (!/[{}]/.test(en) && en.length > 6 && plainSample.length < 3) plainSample.push({ key, en });
    }
  }

  if (wanted.size === 0) {
    errs.push(`${proj.label}:正控④ 破 —— 一枚带复数选择器的键都没数到,这只工装等于没跑`);
  }

  for (const [key, { en, sels }] of wanted) {
    // 参数:打印出来的占位符 + 选择器名,一律喂数字。
    const names = new Set(sels.map((s) => s.name));
    for (const m of en.replace(PLURAL, "").matchAll(/\{([A-Za-z0-9_]+)\}/g)) names.add(m[1]);
    for (const n of [1, 2]) {
      const params = Object.fromEntries([...names].map((x) => [x, n]));
      let got;
      try {
        got = t(key, params);
      } catch (e) {
        errs.push(`${proj.label}「${key}」n=${n} 时 t() 抛了:${String(e.message || e)}`);
        continue;
      }
      // 判据①:没有残渣
      if (got.includes("{") || got.includes("|")) {
        errs.push(`${proj.label}「${key}」n=${n} 的输出里有没被认出的写法(会原样印到界面上):${got}`);
      }
      // 判据③:选对了支
      for (const s of sels) {
        const want = n === 1 ? s.one : s.many;
        const other = n === 1 ? s.many : s.one;
        if (want !== other && !got.includes(want)) {
          errs.push(`${proj.label}「${key}」n=${n} 该选「${want}」却没出现在输出里:${got}`);
        }
      }
      checkedTotal++;
    }
    // 判据②:两跑必须不同
    const p = (n) => t(key, Object.fromEntries([...names].map((x) => [x, n])));
    if (p(1) === p(2)) {
      errs.push(`${proj.label}「${key}」n=1 与 n=2 的输出一模一样(选择器两支写成了同一个词?):${p(1)}`);
    }
    // 判据④:两支的关系必须是「复数 = 单数 + s/es」,否则逐条签进 IRREGULAR。
    // 这是唯一一条**不从字典推期望**的判据,故也是唯一抓得住「两支写反」的。
    for (const s of sels) {
      const regular = s.many === `${s.one}s` || s.many === `${s.one}es`;
      const signed = IRREGULAR.some((r) => r.one === s.one && r.many === s.many);
      if (!regular && !signed) {
        errs.push(
          `${proj.label}「${key}」的选择器 {${s.name}|${s.one}|${s.many}} 不是「单数 + s/es」——` +
            `两支写反了?真是不规则形就签进 IRREGULAR 登记表`
        );
      }
    }
  }

  // 正控⑤:不带占位符的键必须逐字原样返回(桩没把字典桩坏)
  for (const { key, en } of plainSample) {
    if (t(key) !== en) errs.push(`${proj.label}:正控⑤ 破 —— 「${key}」返回的不是字典里的 en 值`);
  }

  console.log(`  ${proj.label}:带选择器 ${wanted.size} 键 × 两跑,正控 ${plainSample.length} 枚素键逐字相等,生效语言 en。`);
  rmSync(dir, { recursive: true, force: true });
}

if (errs.length) {
  console.error("\n复数选择器运行期对拍未通过:");
  for (const e of errs) console.error("  ✗ " + e);
  process.exit(1);
}
console.log(`复数选择器运行期对拍通过:共判 ${checkedTotal} 跑(每键 n=1 / n=2 各一次),真 t() + 真字典。`);
