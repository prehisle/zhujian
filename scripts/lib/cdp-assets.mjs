// CDP 验收资产的**判读**这一层(backlog 测试与工装 80 的第二半;第一半 = `lib/cdp.mjs` 那份客户端)。
//
// # 为什么在这儿
// 那 40 支资产的返回值**至少三种形状**,而 `android-cdp.mjs evalfile` 从来只 `console.log` 一下、
// 退出码恒 0 ⇒ 红绿全靠人一眼扫 JSON。639 把代价量出来了:复跑八支当场逮到**三支是坏的**,
// 其中 `pane-entries` 断了 100 多轮零信号,而它崩的位置在**清场路**上 ——
// 于是每跑一次就往用户那台真机的回收站里留一条测试条目。
// ⇒ 本文件把「这支今天是过了、没过、还是根本没跑成」判成一个机器可读的三态。
//
// # 边界
// · **纯函数,不碰设备、不碰网络** —— 所以它能被 `check-cdp-verdict.mjs` 拿一批夹具当场验红验绿。
// · ⛔ 不改任何资产的判据(80 的验证条款写死了这一句);它只读资产**已经返回**的东西。
// · fail-closed:认不出的形状一律 NOT-RUN,⛔ 不许退回「那大概是过了吧」(设计铁律「绝不回退兜底」)。

/** 三态。⛔ 别把 NOT-RUN 并进 FAIL —— 「没跑成」要人去修台架,「没过」要人去看产品(skill 通则 3)。 */
export const PASS = "PASS";
export const FAIL = "FAIL";
export const NOT_RUN = "NOT-RUN";

/** 把可能被 `JSON.stringify` 包了一层(甚至两层)的返回值剥回对象。
 *  ⚠ 多数资产 `return JSON.stringify(out)`,而 `Runtime.evaluate` 的 returnByValue 又原样递给我们
 *  ⇒ 拿到的是**字符串**。`grep '"pass": true'` 判不了它(实际长成 `\"pass\":true`),skill 通则 2。 */
function unwrap(raw) {
  let v = raw;
  for (let i = 0; i < 3; i++) {
    if (typeof v !== "string") return { value: v, depth: i };
    const s = v.trim();
    if (!s) return { value: null, depth: i, parseError: "空字符串" };
    try {
      v = JSON.parse(s);
    } catch (e) {
      return { value: null, depth: i, parseError: `${e.message};原文头 200 字:${s.slice(0, 200)}` };
    }
  }
  return { value: v, depth: 3 };
}

const isPlainObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/** 把对象里那几个「大到没法印」的键摘掉,剩下的当理由印出来。 */
function digest(obj) {
  const small = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "steps" || k === "rows") continue;
    if (typeof v === "string" && v.length > 160) small[k] = `${v.slice(0, 160)}…`;
    else if (Array.isArray(v) && v.length > 8) small[k] = `[${v.length} 项]`;
    else small[k] = v;
  }
  return JSON.stringify(small);
}

/**
 * 把一支资产的返回值读成三态。
 *
 * @param {unknown} raw `Runtime.evaluate` 的 returnByValue 值(字符串 / 对象都收)
 * @returns {{state:string, reason:string|null, total:number, passed:number,
 *            failed:Array, skipped:Array, shape:string, value:unknown}}
 */
export function readVerdict(raw) {
  const base = { reason: null, total: 0, passed: 0, failed: [], skipped: [], shape: "?", value: raw };
  const notRun = (reason, shape) => ({ ...base, state: NOT_RUN, reason, shape });

  if (raw === undefined || raw === null) {
    return notRun("资产一个字都没返回(它是不是没有 return?或者中途抛了?)", "空");
  }

  const { value, depth, parseError } = unwrap(raw);
  if (parseError) return notRun(`返回的是字符串但不是 JSON:${parseError}`, "非 JSON 字符串");
  const shape = depth > 0 ? `字符串包 ${depth} 层的 JSON` : "对象";
  if (!isPlainObject(value)) {
    return notRun(`返回的不是对象,是 ${Array.isArray(value) ? "数组" : typeof value}:${JSON.stringify(value)?.slice(0, 200)}`, shape);
  }
  base.value = value;
  base.shape = shape;

  // ── ① 资产自报「前置没摆好」:`{error:"先用 adb input tap 点开一张图再跑"}` 那一族。
  //    skill 通则 3:**那不是失败,是没跑**,⛔ 别混进「全过」也别混进「红」。
  if (value.error) return { ...base, state: NOT_RUN, reason: `资产自报前置不满足:${String(value.error)}` };

  // ── ② 资产自报「这台设备做不了这一支」(`view-split-space` 在单空间设备上 `skip:true`)。
  //    ⚠ 它自己写着「算过」,本判读**不认**:没跑就是没跑,记进 NOT-RUN 才不会把覆盖面读高。
  if (value.skip === true) return { ...base, state: NOT_RUN, reason: "资产自报 skip=true(这台设备造不出前置)" };

  // ── ③ 逐格数组:多数叫 `steps`,一族叫 `rows`(`comments` / `devices` / `db-migrate` …)。
  //    ⚠⚠ **`rows` 不一定是逐格判据** —— `panes` 的 `rows` 是一张**数据表**
  //    (`{paneVisible, paneAboveFold, …}`,一个 `ok` 都没有),`pass` 另算。
  //    照「每项都有 ok」去读它会得到 4/4 全红,再撞上下面那道「矛盾取严」⇒ 把一支好资产判成红。
  //    ⇒ 判据取**这个数组自己长什么样**,⛔ 别从手上那两三个样本推整族
  //    (memory `match-surface-from-distribution-not-sample`)。
  const arr = Array.isArray(value.steps) ? value.steps : Array.isArray(value.rows) ? value.rows : null;
  const withOk = arr ? arr.filter((e) => e && typeof e.ok === "boolean").length : 0;
  // 一半有 ok 一半没有 = 说不清,fail-closed。
  if (arr && withOk > 0 && withOk < arr.length) {
    return { ...base, state: NOT_RUN, reason: `逐格数组 ${arr.length} 项里只有 ${withOk} 项带 ok 字段 —— 认不出这是判据还是数据表` };
  }
  const steps = arr && (withOk > 0 || arr.length === 0) ? arr : null;
  const hasPass = typeof value.pass === "boolean";
  // 数组在、却是数据表(一个 ok 都没有)且资产也没给 `pass` ⇒ 没有任何判据可读。
  if (arr && !steps && !hasPass) {
    return { ...base, state: NOT_RUN, reason: `${arr.length} 项的数据表,既没有 ok 也没有 pass —— 读不出判据` };
  }
  if (!steps && !hasPass) {
    return { ...base, state: NOT_RUN, reason: `认不出的返回形(既没有 steps/rows 也没有 pass):${digest(value)}` };
  }

  if (Array.isArray(value.skipped)) base.skipped = value.skipped;

  if (steps) {
    // ⭐ skill 通则 2 末句:**「N 步全过」里 N=0 是跑手坏了的信号,不是资产的成绩。**
    if (steps.length === 0) {
      return { ...base, state: NOT_RUN, reason: "0 格判据 —— 这是跑手/前置坏了的信号,不是「全过」" };
    }
    base.total = steps.length;
    base.failed = steps.filter((s) => !s?.ok);
    base.passed = steps.length - base.failed.length;
    const derived = base.failed.length === 0;
    // ⚠ `pass` 与逐格自相矛盾时**取严的那一边**并把话说响 —— 规格内部不一致时别照抄松的那份
    //   (memory `spec-internal-inconsistency-loosest-wins`)。
    if (hasPass && value.pass !== derived) {
      return {
        ...base,
        state: FAIL,
        reason: `资产自报 pass=${value.pass},逐格却是 ${base.failed.length}/${steps.length} 没过 —— 资产的汇总逻辑坏了`,
      };
    }
    if (!derived) {
      return { ...base, state: FAIL, reason: `${base.failed.length}/${steps.length} 格没过:${base.failed.map((s) => s?.name ?? "(无名)").join(" / ")}` };
    }
    return { ...base, state: PASS };
  }

  // ── ④ 没有逐格数组、只有一个 `pass`(`textsize` 那种)。
  base.total = 1;
  base.passed = value.pass ? 1 : 0;
  return value.pass
    ? { ...base, state: PASS }
    : { ...base, state: FAIL, reason: `pass=false:${digest(value)}` };
}

/** 一次库普查的键。⚠ 六个都得在,少一个就有一整面的残留看不见。 */
export const CENSUS_KEYS = ["timeline", "topics", "trash", "archived", "sealed", "archivedTasks"];

/** 一次库普查的**页内脚本**。⚠ 六面全问 —— 少问一面就有一整面的残留看不见。
 *  fail-closed:哪一条命令报错就把错原样带回来,⛔ 别 catch 成 0(那会让残留看着像「没变」)。
 *  ⛔ 跑手与驱动形资产共用这一份,别抄第二份(91:`swipe-undo` 改驱动形时要的就是它)。 */
export const JS_CENSUS = `(async () => {
  const I = window.__TAURI__.core.invoke;
  const spaces = await I("list_spaces");
  const cur = spaces.find((s) => s.current);
  if (!cur) return { error: "没有前台空间(list_spaces 里一条 current 都没有)" };
  const n = async (cmd) => {
    try { return (await I(cmd, { spaceId: cur.id })).length; }
    catch (e) { return "ERR:" + String(e && e.message ? e.message : e); }
  };
  return {
    space: cur.id,
    timeline: await n("list_timeline"),
    topics: await n("list_topics"),
    trash: await n("list_trash"),
    archived: await n("list_archived"),
    sealed: await n("list_sealed_tasks"),
    archivedTasks: await n("list_archived_tasks"),
  };
})()`;

/**
 * 比两次库普查。⭐ 这才是 639 那场事故真正缺的那道自证:**跑完这支,用户的库回没回到起跑时的样子**。
 * @returns {Array<{key:string, before:number, after:number, delta:number}>} 只含变了的键
 */
export function censusDiff(before, after) {
  const out = [];
  for (const k of CENSUS_KEYS) {
    const b = before?.[k];
    const a = after?.[k];
    // fail-closed:普查本身没读到数(命令报错)也算「说不清」,当成残留报出来。
    if (typeof b !== "number" || typeof a !== "number") {
      out.push({ key: k, before: b ?? null, after: a ?? null, delta: NaN });
      continue;
    }
    if (a !== b) out.push({ key: k, before: b, after: a, delta: a - b });
  }
  return out;
}

/** 两次普查一模一样 = 后端静下来了(`--all` 背靠背跑时靠它等清场落地,⛔ 别拿 `sleep`)。 */
export function censusEqual(a, b) {
  return CENSUS_KEYS.every((k) => typeof a?.[k] === "number" && a[k] === b?.[k]);
}
