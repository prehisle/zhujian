#!/usr/bin/env node
// 交互时长漂移门禁(340)。仓里**三份**「§2.4 时长常量」必须逐值对齐:
//
//   桌面 src/timing.ts             —— 真相源
//   安卓 android/src/timing.ts     —— 独立 vite 工程,各写一份
//   规范 docs/ui-guidelines.md §2.4 —— 文档里那张表
//
// # 为什么文档也进被核对的范围
//
// 前四道门禁核的都是代码与代码。这一道多核一份**文档** —— 因为本轮的根因就出在那儿:
// `CONFIRM_REVERT` 在安卓端从 3s 放宽到 6s(理由正当,见 android/src/timing.ts 那一格),
// 规范里那一格**一直写着 3s,没人发现**。规范 v0.1 是 2026-07-17 那次 27 条审计的蒸馏,
// 它列的五个常量名当时**代码里一个都不存在**,于是「表里写什么」和「跑起来是什么」
// 从第一天起就没有对账关系。把表纳进来,那张表才从装饰变成断言。
//
// # 它挡的是什么(立项当天的真判例)
//
//  · `CONFIRM_REVERT` 文档 3s / 代码 6s —— 存续约三周无人发现(340 以代码为准改文档);
//  · `TOAST_SUCCESS` 的读秒**桌面从没实现**:222 给安卓改成「1s + 字数×110ms」,桌面
//    始终是 `toastAction(text, ms = 2200)` 一个默认参数,长回执读不完就走(340 补齐);
//  · `CONFIRM_GUARD` 300ms **两端都不存在**:审计 P0 #5 的修法原文是「执行钮放左取消
//    放右,**或** 300ms disabled」,桌面选了前者,而 §3.2 写成了「并叠加」。这一格是
//    **规范收严了但没落地**,不是漂移 —— 故 340 未入册,`PENDING` 里挂着等拍板
//    (2026-08-08 拍板「或」是原意,已销账,见 PENDING 处注记)。
//
// 用法:node scripts/check-timing-drift.mjs
// 全对齐 = 退出 0;漂移 / 未登记的常量 / 登记了却没人用 / 看不懂的形状 = 非零响亮。
// 发版门禁之一(见 docs/dev-and-testing.md 与 skill zhujian-ops)。

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const DESKTOP = "src/timing.ts";
const ANDROID = "android/src/timing.ts";
const DOC = "docs/ui-guidelines.md";

const BOTH = ["桌面", "安卓"];

/**
 * 全部时长常量的登记表。**新增常量 = 这里加一行**,否则门禁当场拒(逼人当场决定它归谁)。
 *   in   —— 哪几份**应该**有它;不是 BOTH 的必须写 why
 *   doc  —— 规范 §2.4 表里对应那一行的常量名(文档用的是族名,代码是具体到毫秒的字段)
 */
const REGISTRY = [
  { name: "TOAST_SUCCESS_BASE_MS", in: BOTH, doc: "TOAST_SUCCESS" },
  { name: "TOAST_SUCCESS_PER_CHAR_MS", in: BOTH, doc: "TOAST_SUCCESS" },
  { name: "TOAST_SUCCESS_MIN_MS", in: BOTH, doc: "TOAST_SUCCESS" },
  { name: "TOAST_SUCCESS_MAX_MS", in: BOTH, doc: "TOAST_SUCCESS" },
  { name: "TOAST_ERROR_MS", in: BOTH, doc: "TOAST_ERROR" },
  { name: "INPUT_DEBOUNCE_MS", in: BOTH, doc: "INPUT_DEBOUNCE" },
  {
    name: "CONFIRM_REVERT_MS",
    in: ["安卓"],
    doc: "CONFIRM_REVERT",
    why: "两拍确认的自动复原只有安卓有:桌面的确认态走 armDismiss(Esc / 点别处收起),\
没有自动复原定时器 —— 桌面是鼠标场景,指针不会像手指那样停在按钮上,不需要「你没接第二拍\
就当你反悔了」这条兜底",
  },
];

/**
 * 已知**尚未落地**的规范条目。它们在 §2.4 表里有名字、代码里没有 —— 门禁必须知道
 * 这件事是「挂着的账」而不是「漏抓」,否则要么它天天红、要么有人把表里那行删掉了事。
 * 销账 = 从这里挪进 REGISTRY(或改规范),两条路都要经过这个文件。
 */
const PENDING = [
  // 今天没有挂账。上一条是 CONFIRM_GUARD(审计 P0 #5 的「或」被 §3.2 抄成了「并」,
  // 挂了约五周)—— 2026-08-08 用户拍板「或」是原意:桌面的落点错开即合规,300ms
  // disabled 永远不需要落地,§3.2 已改回、§2.4 表里那行连同这里一起销掉(不是移进
  // REGISTRY —— 一个永远不会存在的常量不该留在被对账的表里,史实在 progress-log
  // 340 §四与 344 续)。
];

// ---- 解析 ---------------------------------------------------------------------------

/**
 * 从一份 timing.ts 里取出 `export const NAME = <整数>;`。
 *
 * **fail-closed**:文件里任何一条 `export const` 只要不是这个形状(算式、字符串、
 * 非整数……),一律抛 —— 别猜。函数导出(toastSuccessMs)另走 `functionBody`,不在此列。
 */
function constsOf(rel) {
  const src = readFileSync(resolve(root, rel), "utf8");
  const out = new Map();
  const line = /^export const (\w+)\s*=\s*(.+?);\s*$/gm;
  for (const m of src.matchAll(line)) {
    const [, name, raw] = m;
    if (!/^\d+$/.test(raw)) {
      throw new Error(`${rel}:${name} 的值不是整数字面量而是 \`${raw}\` —— 解析器看不懂这个形状`);
    }
    out.set(name, Number(raw));
  }
  return out;
}

/** 取出某个导出函数的函数体,空白折叠后用于逐字比对(两端各写一份同算法)。 */
function functionBody(rel, fname) {
  const src = readFileSync(resolve(root, rel), "utf8");
  const at = src.indexOf(`export function ${fname}(`);
  if (at === -1) return null;
  const open = src.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i).replace(/\s+/g, " ").trim();
    }
  }
  throw new Error(`${rel}:${fname} 的 { 没有配平的 } —— 解析器看不懂这个形状`);
}

/**
 * 取出规范 §2.4 那张表:`| \`常量\` | <整数> | 归属 | 用途 |`。
 * 认不出的行一律抛(表被改成别的形状时要响亮,不是静静少判几行)。
 *
 * ⚠ 341 修:上界原本只找「下一个 `---`」,而 §2.4 与那条 `---` 之间**当时恰好没有别的
 * 小节**。341 在中间插了 §2.5(圆角阶,另一张同形状的表),这只解析器当场把 §2.5 的
 * 表头也读了进来、抛「第一格不是 `常量名`:令牌」。它依赖的是一条碰巧在那儿的分隔线,
 * 不是章节边界 —— 现在两种上界取先到的那个。
 */
function docTable() {
  const src = readFileSync(resolve(root, DOC), "utf8");
  const at = src.indexOf("### 2.4");
  if (at === -1) throw new Error(`${DOC} 里找不到 「### 2.4」 —— 章节被改名了?`);
  const ends = ["\n---", "\n### ", "\n## "].map((s) => src.indexOf(s, at + 1)).filter((i) => i !== -1);
  const end = ends.length ? Math.min(...ends) : -1;
  const block = src.slice(at, end === -1 ? src.length : end);

  const rows = block.split("\n").filter((l) => l.trim().startsWith("|"));
  if (rows.length < 3) throw new Error(`${DOC} §2.4 的表少于 3 行 —— 表没了?`);

  const out = new Map();
  for (const row of rows.slice(2)) {
    // 跳过表头与分隔行
    const cells = row.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) throw new Error(`${DOC} §2.4 表里这一行认不出形状:${row}`);
    const nameCell = cells[0];
    const m = /^`(\w+)`$/.exec(nameCell);
    if (!m) throw new Error(`${DOC} §2.4 表里第一格不是 \`常量名\`:${nameCell}`);
    const vals = cells[1];
    // 值格允许 `NAME = 123` 的多条(TOAST_SUCCESS 那族由四个字段拼成),也允许「—」表示未落地
    if (vals === "—") {
      out.set(m[1], null);
      continue;
    }
    const fields = new Map();
    for (const f of vals.split("、")) {
      const fm = /^`(\w+)`\s*=\s*(\d+)$/.exec(f.trim());
      if (!fm) throw new Error(`${DOC} §2.4 「${m[1]}」的值格认不出:${f}`);
      fields.set(fm[1], Number(fm[2]));
    }
    out.set(m[1], fields);
  }
  return out;
}

// ---- 抓取器自检 ---------------------------------------------------------------------
// 一段不随仓库变的样本:每种该抓的写法与每种该跳过的形状各一处,抓到的必须**恰好等于**
// 期望清单。少抓 = 少判 = 安静的绿,这道自检就是防它的(照 check-hardcoded-colors 的做法)。

function selfCheck() {
  const sample = [
    "// export const IN_COMMENT_MS = 1;",
    "const NOT_EXPORTED_MS = 2;",
    "export const GOOD_MS = 300;",
    "export const ALSO_GOOD_MS = 6000;",
    "export function f(): number { return 7; }",
  ].join("\n");
  const got = new Map();
  for (const m of sample.matchAll(/^export const (\w+)\s*=\s*(.+?);\s*$/gm)) {
    if (!/^\d+$/.test(m[2])) throw new Error("自检:样本里出现了非整数,不该有");
    got.set(m[1], Number(m[2]));
  }
  const want = [["GOOD_MS", 300], ["ALSO_GOOD_MS", 6000]];
  const gotStr = [...got].map(([k, v]) => `${k}=${v}`).join(",");
  const wantStr = want.map(([k, v]) => `${k}=${v}`).join(",");
  if (gotStr !== wantStr) {
    throw new Error(`抓取器自检不过:抓到 [${gotStr}],期望 [${wantStr}]`);
  }

  // 阴性对照:非整数形状必须**抛**,不能被静静跳过。
  let threw = false;
  try {
    constsOfString("export const BAD_MS = 2 * 1000;");
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("自检:算式形状没有抛,fail-closed 失效");
}

/** constsOf 的纯字符串版,只给自检用(同一条正则,保证测的是真家伙)。 */
function constsOfString(src) {
  const out = new Map();
  for (const m of src.matchAll(/^export const (\w+)\s*=\s*(.+?);\s*$/gm)) {
    if (!/^\d+$/.test(m[2])) throw new Error(`值不是整数字面量:${m[2]}`);
    out.set(m[1], Number(m[2]));
  }
  return out;
}

// ---- 比对 ---------------------------------------------------------------------------

function main() {
  selfCheck();

  const code = { 桌面: constsOf(DESKTOP), 安卓: constsOf(ANDROID) };
  const doc = docTable();
  const errs = [];

  // ① 代码里出现、登记表里没有 → 拒(逼人当场决定它归谁)
  for (const [end, m] of Object.entries(code)) {
    for (const name of m.keys()) {
      if (!REGISTRY.some((r) => r.name === name)) {
        errs.push(`${end} ${relOf(end)} 有未登记的常量 ${name} —— 先进 REGISTRY 说明归谁`);
      }
    }
  }

  // ② 登记表说该有、代码里没有(或不该有却有)→ 拒。**两个方向都核**
  for (const r of REGISTRY) {
    for (const end of BOTH) {
      const has = code[end].has(r.name);
      const should = r.in.includes(end);
      if (should && !has) errs.push(`${end} 缺常量 ${r.name}(登记表说它该有)`);
      if (!should && has) errs.push(`${end} 多出常量 ${r.name}(登记表说它只归 ${r.in.join("/")})`);
    }
    // ③ 两端都有的,值必须逐字相同
    if (r.in.length === 2) {
      const [a, b] = [code.桌面.get(r.name), code.安卓.get(r.name)];
      if (a !== undefined && b !== undefined && a !== b) {
        errs.push(`${r.name} 两端漂移:桌面 ${a} / 安卓 ${b}`);
      }
    }
    // ④ 与规范 §2.4 那张表对账
    const fields = doc.get(r.doc);
    if (fields === undefined) {
      errs.push(`规范 §2.4 表里没有 ${r.doc} 这一行(${r.name} 指着它)`);
    } else if (fields === null) {
      errs.push(`规范 §2.4 的 ${r.doc} 标着「—」(未落地),但代码里有 ${r.name}`);
    } else {
      const want = fields.get(r.name);
      const got = code[r.in[0]].get(r.name);
      if (want === undefined) errs.push(`规范 §2.4 的 ${r.doc} 值格里没有 ${r.name}`);
      else if (want !== got) errs.push(`${r.name} 文档与代码不一致:规范 ${want} / 代码 ${got}`);
    }
  }

  // ⑤ 挂账的规范条目:表里必须有它、且必须标「—」(有值 = 已落地,该销账进 REGISTRY)
  for (const p of PENDING) {
    if (!doc.has(p.doc)) errs.push(`规范 §2.4 表里没有挂账条目 ${p.doc}`);
    else if (doc.get(p.doc) !== null) {
      errs.push(`${p.doc} 在规范里有值了却还挂在 PENDING —— 落地了就挪进 REGISTRY`);
    }
  }

  // ⑥ 规范表里出现、登记表与挂账表都不认的行 → 拒(守「表里多写了一行没人核」)
  const known = new Set([...REGISTRY.map((r) => r.doc), ...PENDING.map((p) => p.doc)]);
  for (const name of doc.keys()) {
    if (!known.has(name)) errs.push(`规范 §2.4 表里的 ${name} 既不在 REGISTRY 也不在 PENDING`);
  }

  // ⑦ 两端各写一份的读秒算法,函数体逐字相同
  const [fa, fb] = [functionBody(DESKTOP, "toastSuccessMs"), functionBody(ANDROID, "toastSuccessMs")];
  if (fa === null || fb === null) errs.push("toastSuccessMs 在某一端找不到 —— 两端都该有");
  else if (fa !== fb) errs.push(`toastSuccessMs 两端算法漂移:\n    桌面 ${fa}\n    安卓 ${fb}`);

  if (errs.length) {
    console.error(`时长漂移门禁不过(${errs.length} 条):`);
    for (const e of errs) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  const n = REGISTRY.length;
  console.log(
    `时长门禁通过:${n} 个常量三份对齐(桌面 ${code.桌面.size} / 安卓 ${code.安卓.size} / 规范 §2.4 ${doc.size} 行),读秒算法两端逐字相同。`,
  );
  if (PENDING.length) {
    console.log(`  挂账 ${PENDING.length} 条(规范有名、代码未落地):${PENDING.map((p) => p.doc).join("、")}`);
  }
  console.log(
    "  ⚠ 诚实边界:它只核**命名常量**。散在别处的时长字面量(动画 260ms、flash 1200ms 等)不在扫描面内 —— 那些是元素级的节奏、不是跨端契约,要收得先进 §2.4 表。",
  );
}

function relOf(end) {
  return end === "桌面" ? DESKTOP : ANDROID;
}

main();
