// 安卓 CDP 验收资产的**跑手**(backlog 测试与工装 80)。
//
// # 它解决什么
// `android-cdp.mjs evalfile` 只把返回值 `console.log` 一下、**退出码恒 0**,红绿全靠人扫 JSON;
// 而那 40 支资产的返回形状至少三种。639 把代价量出来了:复跑八支当场逮到**三支是坏的**,
// `pane-entries` 断了 100 多轮零信号 —— 更贵的是它崩在**清场路**上,
// 于是每跑一次就往用户那台真机的回收站里留一条测试条目。
// ⇒ 本跑手要答的不只是「红还是绿」,是三件事:
//   ① 三态判读 PASS / FAIL / NOT-RUN + 非零退出码(⛔ 「没跑成」≠「没过」,skill 通则 3);
//   ② 语言前置(好几支按中文文案认元素,英文机上会**安静地少跑几格**,559);
//   ③ ⭐ **跑完这支,用户的库回没回到起跑时的样子** —— 639 真正缺的是这一格。
//
// # 怎么跑
//   node scripts/android-cdp.mjs forward                 # 先建 tcp:9222
//   node scripts/cdp-run.mjs pane-entries stage-chips    # 点名跑(名字 = 去掉 cdp-acceptance- 前缀)
//   node scripts/cdp-run.mjs --all                       # 全跑,产出「哪几支今天还跑得动」
//   node scripts/cdp-run.mjs --selftest                  # 判读逻辑的阴性对照,不碰设备
// 选项:--lang zh|en|none(默认 zh) --port 9222 --timeout 60000 --no-reload --json <路径>
//
// # ⛔ 知情边界(别把它读大了)
// · **它不是门禁,不进 CI,不建登记表**(80 写死;停止扩张线不触)。跑不跑由人决定。
// · **库普查只数条数**,数得出「多了一条 / 少了一条」,数不出「顺序被改了」——
//   ⚠ `topics-drag` 真改用户标签顺序且不幂等,那一支的还原仍要人自己比对(skill 通则 4)。
// · **它不改任何资产的判据**(80 的验证条款写死了这一句):资产说自己过了没过,它照读;
//   只有「资产自报 pass 与逐格自相矛盾」这一种,判读取严的那一边并把话说响。
// · ⚠ 它管不了「资产自己的前置」(哪一支要先停在哪个面)。⇒ 每支跑前会 reload 回默认面,
//   要人先摆局的那几支照旧自报 `{error:…}` = NOT-RUN,那是对的。
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";
import { readVerdict, censusDiff, censusEqual, JS_CENSUS, PASS, FAIL, NOT_RUN } from "./lib/cdp-assets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const PKG = "app.zhujian.notebook";
const PREFIX = "cdp-acceptance-";

// ── 命令行 ────────────────────────────────────────────────────────────────────
// 带值的开关就这四个;其余是布尔。⛔ 别用「看前一个 argv 是什么」那种写法认位置参数 ——
// 同名参数出现两次时 `indexOf` 会指到第一处,静默认错。
const TAKES_VALUE = new Set(["lang", "port", "timeout", "json"]);
const argv = process.argv.slice(2);
const opt = { all: false, selftest: false, lang: "zh", port: 9222, timeout: 60000, reload: true, json: null };
const names = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) {
    names.push(a);
    continue;
  }
  const key = a.slice(2);
  if (TAKES_VALUE.has(key)) {
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${key} 后面缺一个值`);
    opt[key] = key === "port" || key === "timeout" ? Number(v) : v;
  } else if (key === "no-reload") opt.reload = false;
  else if (key === "all" || key === "selftest") opt[key] = true;
  else throw new Error(`不认识的开关 --${key}`);
}

const USAGE =
  "用法:\n" +
  "  node scripts/cdp-run.mjs <资产名>...      # 例:pane-entries stage-chips\n" +
  "  node scripts/cdp-run.mjs --all            # 全跑并汇总「哪几支今天还跑得动」\n" +
  "  node scripts/cdp-run.mjs --selftest       # 判读逻辑的阴性对照(不碰设备)\n" +
  "选项: --lang zh|en|none  --port 9222  --timeout 60000  --no-reload  --json <路径>";

// ── 花名册:⛔ 不在本文件里手抄(587/1b:skill 里那份列了 27 支、盘里有 39 支,8 支静默不在册)。
//    唯一真相源 = `ls scripts/cdp-acceptance-*`,每支怎么驱动写在**它自己的文件头**那行 `@cdp-run`。
//    ⇒ 认不出标注的一律 NOT-RUN 报出来,⛔ 不许静默跳过 —— 静默跳过正是 587/1b 那个病。
const KINDS = {
  single: "evalfile 一发跑完",
  phase: "多趟驱动(seed/reload/verify),要人按 skill 的表跑",
  part: "别的资产的一步(播种/清场),本身不是判据",
  desktop: "桌面面,走 desktop-cdp.mjs",
};

function discover() {
  const out = [];
  for (const f of readdirSync(join(root, "scripts")).sort()) {
    if (!f.startsWith(PREFIX)) continue;
    const name = f.slice(PREFIX.length).replace(/\.(js|mjs)$/, "");
    const path = join(root, "scripts", f);
    if (f.endsWith(".mjs")) {
      out.push({ name, path, kind: "driver", note: `驱动形:node scripts/${f}` });
      continue;
    }
    const head = readFileSync(path, "utf8").slice(0, 4000);
    const m = head.match(/^\/\/\s*@cdp-run\s+(\w+)(?:\s+timeout=(\d+))?/m);
    if (!m) {
      out.push({ name, path, kind: "unmarked", note: "文件头没有 `// @cdp-run <形>` 那行" });
      continue;
    }
    out.push({ name, path, kind: m[1], timeout: m[2] ? Number(m[2]) : null, note: KINDS[m[1]] ?? null });
  }
  return out;
}

// ── 设备前置 ──────────────────────────────────────────────────────────────────
const adb = (args) => execFileSync("adb", args, { encoding: "utf8" });

/** ⛔ app 不在前台 = CDP 整个不答,而报出来的是一行 `TypeError: fetch failed`,跟「在后台」
 *  毫无字面关系(629 实撞)。手机端 runtime 只在前台跑 ⇒ 开跑前先问一句「前台是谁」。 */
function assertForeground() {
  const focus = adb(["shell", "dumpsys window | grep -E 'mCurrentFocus|mFocusedApp'"]);
  if (focus.includes(PKG)) return focus.trim();
  throw new Error(
    `朱笺不在前台,CDP 不会答。当前:\n${focus.trim()}\n` +
      `  ⇒ adb shell monkey -p ${PKG} -c android.intent.category.LAUNCHER 1`,
  );
}

async function connect(timeoutMs = opt.timeout) {
  const t = await pageTarget(opt.port);
  return openSession(t.webSocketDebuggerUrl, { timeoutMs });
}

// ── 页面内的三段小脚本 ────────────────────────────────────────────────────────
const JS_READY = `(() => ({
  ready: document.readyState === "complete"
    && !!window.__TAURI__?.core?.invoke
    && !!document.querySelector('#bottombar [data-mode].active'),
  epoch: window.__cdpRunEpoch ?? null,
}))()`;

// 库普查那段页内脚本住在 `lib/cdp-assets.mjs::JS_CENSUS`(驱动形资产也要用它,别抄第二份)。

const jsReload = (token, lang) => `(() => {
  window.__cdpRunEpoch = ${JSON.stringify(token)};
  ${lang === "none" ? "" : `localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)});`}
  setTimeout(() => location.reload(), 0);
  return "reloading";
})()`;

// ── 三件事:普查静下来、重载真落地、跑一支 ────────────────────────────────────
/** 背靠背连跑时,**上一支的清场还没落地、下一支已经把列表读进去了**(632 实撞:`topics-drag`
 *  读到 27 行 = 22 真 + 5 枚上一支的种子)。⛔ 别拿 `sleep` 顶 —— 判据是「后端两拍读数一样」。 */
async function settledCensus(s, { tries = 20, gapMs = 400 } = {}) {
  let prev = await s.evaluate(JS_CENSUS);
  if (prev?.error) throw new Error(`库普查读不到:${prev.error}`);
  for (let i = 0; i < tries; i++) {
    await sleep(gapMs);
    const now = await s.evaluate(JS_CENSUS);
    if (now?.error) throw new Error(`库普查读不到:${now.error}`);
    if (censusEqual(prev, now)) return now;
    prev = now;
  }
  throw new Error(`库普查 ${tries} 拍还没静下来(最后一拍 ${JSON.stringify(prev)})—— 上一支的清场没落地?`);
}

/** 重载并**自证真的重载过**:重载前往 `window` 上钉一个 token,重载后它必须不见了。
 *  ⛔ 别拿「页面答得上话」当判据 —— 老页面照样答得上(memory `verify-artifact-predates-fix` 的页面面)。 */
async function reloadAndWait(lang) {
  const token = `cdp-run-${Date.now()}`;
  const s0 = await connect();
  await s0.evaluate(jsReload(token, lang));
  s0.close();
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < 30000) {
    await sleep(400);
    try {
      const s = await connect();
      last = await s.evaluate(JS_READY);
      s.close();
      if (last?.ready && last.epoch === null) return;
    } catch {
      // 重载途中 /json 会短暂没有 page target —— 这一段的重试是**在等一件确定会发生的事**,
      // 不是回退兜底:超时仍会响亮抛。
    }
  }
  throw new Error(`重载后 30s 没就绪(最后一次读到 ${JSON.stringify(last)})`);
}

async function runOne(asset) {
  const rec = { name: asset.name, kind: asset.kind };
  if (asset.kind !== "single") {
    return { ...rec, state: NOT_RUN, reason: `${asset.note ?? asset.kind} —— ${opt.all ? "`--all` 不猜它怎么驱动" : "点名也不代跑"}` };
  }

  if (opt.reload) await reloadAndWait(opt.lang);

  // ⚠ 单条 CDP 调用的上限**在开会话时定死**;标签面那几支的文件头自己写着要 60-120s
  //   ⇒ 那个数跟着资产走(`@cdp-run single timeout=90000`),⛔ 别让人每次去想 env 该设多少。
  const s = await connect(asset.timeout ?? opt.timeout);
  try {
    const before = await settledCensus(s);
    rec.census = { before };
    const src = readFileSync(asset.path, "utf8");
    const t0 = Date.now();
    let raw;
    try {
      raw = await s.evaluate(src);
    } catch (e) {
      // ⭐ 639 那三支坏资产就是死在这儿(`click(null)` 抛 TypeError)⇒ **整支没有 JSON 输出**。
      //   那不是「红格」,是「跑不成」—— 记 NOT-RUN,并且照样往下走清场自证:抛的位置很可能
      //   就在清场路上,库里正躺着刚种下的探针。
      rec.ms = Date.now() - t0;
      rec.state = NOT_RUN;
      rec.reason = `资产跑飞了(整支没有返回值):${e.message}`;
      rec.census.after = await settledCensus(s).catch((err) => ({ error: err.message }));
      rec.residue = censusDiff(before, rec.census.after);
      return rec;
    }
    rec.ms = Date.now() - t0;
    const v = readVerdict(raw);
    rec.state = v.state;
    rec.reason = v.reason;
    rec.shape = v.shape;
    rec.total = v.total;
    rec.passed = v.passed;
    rec.failedNames = v.failed.map((f) => f?.name ?? "(无名)");
    rec.skipped = v.skipped;
    rec.census.after = await settledCensus(s);
    rec.residue = censusDiff(before, rec.census.after);
    return rec;
  } finally {
    s.close();
  }
}

// ── 判读逻辑的阴性对照(⛔ 不是门禁,是这支跑手自己的刀)────────────────────────
// memory `test-negative-control`:新判据必配阴性对照,否则「全绿」证明不了它在干活。
// 每一条夹具都是**真实见过的形**,来路写在名字里。
const FIXTURES = [
  ["多数形:字符串包一层的 {pass,steps}", JSON.stringify({ pass: true, steps: [{ name: "a", ok: true }] }), PASS],
  ["同形但有一格红", JSON.stringify({ pass: false, steps: [{ name: "a", ok: true }, { name: "b", ok: false }] }), FAIL],
  ["rows 形(comments / panes / devices / db-migrate)", { pass: true, rows: [{ name: "a", ok: true }] }, PASS],
  ["rows 形有红", { pass: false, rows: [{ name: "a", ok: false }] }, FAIL],
  // ⭐ `panes` 的 `rows` 是**数据表**不是逐格判据(一个 `ok` 都没有)—— 这条夹具是 80 头一趟
  //   `--all` 实跑逮出来的:判读一度把它读成 4/4 全红,再撞上「矛盾取严」把好资产判成红。
  ["rows 是数据表不是判据(panes)", JSON.stringify({ viewportH: 640, rows: [{ paneVisible: true, paneAboveFold: true }], closedBackToTimeline: true, pass: true }), PASS],
  ["同形而 pass=false", JSON.stringify({ rows: [{ paneVisible: false }], pass: false }), FAIL],
  ["半有 ok 半没有 ⇒ 说不清,fail-closed", JSON.stringify({ pass: true, rows: [{ name: "a", ok: true }, { paneVisible: true }] }), NOT_RUN],
  ["数据表且连 pass 都没有 ⇒ 读不出判据", JSON.stringify({ rows: [{ paneVisible: true }] }), NOT_RUN],
  ["只有 pass 没有逐格(textsize)", { base: 1, fails: [], pass: true }, PASS],
  ["只有 pass 且 false", { base: 1, fails: ["r130"], pass: false }, FAIL],
  ["自报前置不满足(android-viewer-close)", JSON.stringify({ error: "先用 adb input tap 点开一张图再跑" }), NOT_RUN],
  // ⭐ 这一条才是「{error} 要先看」那道守卫的真刀:`desktop-lightbox-close` 回的是
  //   `{...out, error:"第二次没打开"}` —— **逐格和 error 一起在**。守卫拿掉之后它会被
  //   当成一份普通成绩去判(实测变 FAIL),于是「跑到一半就断了」这件事**没人说**。
  ["逐格与 error 一起在(desktop-lightbox-close)", JSON.stringify({ pass: false, steps: [{ name: "a", ok: true }], error: "第二次没打开" }), NOT_RUN],
  ["自报 skip=true(view-split-space 单空间设备)", JSON.stringify({ pass: true, skip: true, steps: [{ name: "a", ok: true }] }), NOT_RUN],
  ["0 格判据 = 跑手坏了,不是成绩(skill 通则 2)", JSON.stringify({ pass: true, steps: [] }), NOT_RUN],
  ["资产跑飞后什么都没返回", undefined, NOT_RUN],
  ["返回了非 JSON 字符串", "TypeError: Cannot read properties of null", NOT_RUN],
  ["认不出的形(seed/cleanup 的 {seeded:true})", JSON.stringify({ seeded: true, n: 3 }), NOT_RUN],
  ["pass 与逐格自相矛盾 ⇒ 取严的那边", JSON.stringify({ pass: true, steps: [{ name: "a", ok: false }] }), FAIL],
  // ⭐ 矛盾的**另一向**才是危险的那一向:资产自己说没过、逐格却全绿。没有那道守卫就直接判 PASS
  //   —— 资产的汇总逻辑坏掉时**恰恰是这一向**在骗人(上一条不管拿不拿掉守卫都是 FAIL,判不出差别)。
  ["矛盾的另一向:自报 false 而逐格全绿", JSON.stringify({ pass: false, steps: [{ name: "a", ok: true }] }), FAIL],
  ["⛔ 阴性对照:`grep '\"pass\": true'` 会把这条判成过", JSON.stringify({ pass: false, steps: [{ name: "a", ok: false }] }), FAIL],
];

function selftest() {
  let bad = 0;
  for (const [label, raw, want] of FIXTURES) {
    const got = readVerdict(raw);
    const okk = got.state === want;
    if (!okk) bad++;
    console.log(`${okk ? "✅" : "❌"} ${want.padEnd(7)} ← ${label}${okk ? "" : `\n     实得 ${got.state}:${got.reason}`}`);
  }
  // 库普查那半的刀
  const b = { timeline: 2, topics: 0, trash: 0, archived: 0, sealed: 0, archivedTasks: 0 };
  const cases = [
    ["零残留", b, { ...b }, 0],
    ["回收站多了一条(639 那三条测试条目的形)", b, { ...b, trash: 3 }, 1],
    ["时间轴少了一条", b, { ...b, timeline: 1 }, 1],
    ["普查那一格自己报错 ⇒ 也算说不清", b, { ...b, trash: "ERR:x" }, 1],
    // ⭐ 真刀在这一条:**两拍都报同一个错**时,`a !== b` 是 false ⇒ 没有那道 fail-closed
    //   就一声不响地判成「零残留」。而「命令一直报错」恰恰是最该说话的时候。
    ["两拍都报错 ⇒ 仍要说不清,⛔ 不许算成没变", { ...b, trash: "ERR:x" }, { ...b, trash: "ERR:x" }, 1],
    ["⛔ 阴性对照:只看 timeline 会漏掉回收站那一面", b, { ...b, sealed: 1 }, 1],
  ];
  for (const [label, before, after, want] of cases) {
    const got = censusDiff(before, after).length;
    const okk = got === want;
    if (!okk) bad++;
    console.log(`${okk ? "✅" : "❌"} 残留 ${want} 项 ← ${label}${okk ? "" : `(实得 ${got})`}`);
  }
  console.log(bad === 0 ? `\n判读逻辑 ${FIXTURES.length + cases.length} 刀全过。` : `\n❌ ${bad} 刀没过。`);
  return bad === 0 ? 0 : 1;
}

// ── 主流程 ────────────────────────────────────────────────────────────────────
function summarize(records) {
  const icon = { [PASS]: "✅", [FAIL]: "❌", [NOT_RUN]: "⬜" };
  console.log("\n──────── 汇总:哪几支今天还跑得动 ────────");
  for (const r of records) {
    const grade = r.total ? ` ${r.passed}/${r.total} 格` : "";
    const ms = r.ms ? ` ${(r.ms / 1000).toFixed(1)}s` : "";
    console.log(`${icon[r.state]} ${r.state.padEnd(7)} ${r.name.padEnd(24)}${grade}${ms}`);
    if (r.reason) console.log(`            ${r.reason}`);
    if (r.residue?.length) {
      console.log(`   ⚠⚠ 用户库有残留:${r.residue.map((d) => `${d.key} ${d.before}→${d.after}`).join(",")}`);
    }
  }
  const n = (st) => records.filter((r) => r.state === st).length;
  const residue = records.filter((r) => r.residue?.length);
  console.log(`\n${n(PASS)} 过 / ${n(FAIL)} 没过 / ${n(NOT_RUN)} 没跑成;共 ${records.length} 支。`);
  if (residue.length) {
    console.log(`\n⚠⚠⚠ **有 ${residue.length} 支往库里留了东西**:${residue.map((r) => r.name).join(" ")}`);
    console.log("     ⇒ 去把它清干净再收工(639:那三条测试条目就是这么进用户真机回收站的)。");
    return 3;
  }
  if (n(FAIL)) return 1;
  if (n(NOT_RUN)) return 2;
  return 0;
}

async function main() {
  if (opt.selftest) return selftest();
  if (!opt.all && names.length === 0) {
    console.error(USAGE);
    return 1;
  }
  if (!opt.reload && opt.lang !== "none") {
    throw new Error("`--no-reload` 与 `--lang` 冲突:语言键要重载才生效(i18n.ts 在模块求值时读 localStorage)。⇒ 要么去掉 --no-reload,要么 --lang none。");
  }

  const roster = discover();
  let picked;
  if (opt.all) {
    picked = roster;
  } else {
    picked = names.map((n) => {
      const hit = roster.find((a) => a.name === n || a.name === n.replace(PREFIX, ""));
      if (!hit) {
        throw new Error(`没有这支资产:${n}\n  盘里有:${roster.map((a) => a.name).join(" ")}`);
      }
      return hit;
    });
  }

  const focus = assertForeground();
  console.log(`前台:${focus.split("\n")[0].trim()}`);
  console.log(`语言前置:${opt.lang === "none" ? "不动(--lang none)" : `zhujian.lang=${opt.lang} + 重载`};每支跑前重载:${opt.reload ? "是" : "⚠ 否"}`);
  console.log(`要跑 ${picked.filter((a) => a.kind === "single").length} 支,另 ${picked.length - picked.filter((a) => a.kind === "single").length} 支不在 evalfile 一发的形里(照样列出来,⛔ 不静默跳过)。\n`);

  const records = [];
  for (const a of picked) {
    process.stdout.write(`── ${a.name} … `);
    let rec;
    try {
      rec = await runOne(a);
    } catch (e) {
      rec = { name: a.name, kind: a.kind, state: NOT_RUN, reason: `跑手这一层就出错了:${e.message}` };
    }
    console.log(rec.state);
    records.push(rec);
  }

  const code = summarize(records);
  if (opt.json) {
    writeFileSync(resolve(opt.json), JSON.stringify({ at: new Date().toISOString(), lang: opt.lang, records }, null, 2));
    console.log(`\n机器可读的一份:${opt.json}`);
  }
  console.log(`\n退出码 ${code}(0=全过零残留 / 1=有没过的 / 2=有没跑成的 / 3=库里有残留,最响)`);
  return code;
}

main().then(
  (c) => process.exit(c),
  (e) => {
    console.error("错误:", e.message);
    process.exit(1);
  },
);
