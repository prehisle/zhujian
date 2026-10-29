// 长文的历史比对 —— 两版正文 → 差异(纯函数,两端共用这一份)。画成 DOM 在隔壁 `diff-dom.ts`;
// 本文件零 DOM、零平台依赖(同 checklist.ts / markdown.ts 那条规矩)。规格在 longform-plan §4。
//
// **算法**:先按行比(Myers,O((N+M)·D)),再把配上对的改动行**按码点**比(中文没有空格分词,
// ⛔ 别按词)。
//   - **分行保留行结束符**:按 `\n` 切、`\n` 留在行尾,`\r` 原样留在行里;⛔ 不 trim、不把 CRLF
//     统一成 LF、不丢末尾换行。所以 `"甲"` 与 `"甲\n"`、空文档与一个空行都是真差异。
//     不变式:「相等 + 删除」按顺序拼回 = 旧版,「相等 + 新增」按顺序拼回 = 新版,逐码元精确。
//   - **配对**:两段相等行之间是一个改动段;段内删除行数与新增行数**相等**才按原顺序逐行配对、
//     做字级比,不等就整段显示删 / 加 —— ⛔ 不猜哪行对哪行(逐行配对只是展示约定,不表示语义对应)。
//     配上对的两行都 ≤ DIFF_MAX_CP 个码点才细化,否则那一对整行删 / 加(资格,不算「受限」)。
//   - **平局**:Myers 经典取向 —— 同一层同一对角线,「从 k-1 右移(删)」与「从 k+1 下移(增)」
//     走得一样远时取下移;行级与字级同一条规则,再加上先剥首尾相同的部分。重复行有多条最短
//     路径时落在哪条由这两条决定,具体落点钉在 test-diff.mjs「平局」那条里。显示上,一个改动段
//     不配对时总是整块删在前、整块增在后(那是 `build` 的排法,与平局无关)。
//   - **按码点**:字级先把两行转成码点序列(`codePointAt` 逐个走),顺带记「码点边界 → UTF-16
//     偏移」,回原串切片只在码点边界上切 ⇒ 不劈开代理对。⛔ 不用 `.length` 当码点数,比之前
//     不做 NFC / NFKC。诚实边界:组合音标、肤色修饰、旗帜、ZWJ 家庭表情可能被分成几段着色,
//     本期不承诺按字素簇整体高亮(拼回去的原文照样精确)。
//
// **相等的连续行合成一行显示**(一段相等行 = 一个元素 + 一个文本节点;不配对的删 / 增也各合成
// 一块)⇒ 输出节点数跟改动段数走,不跟行数走 —— 「D 很小但有十几万空行」不会造海量节点。
//
// **资源上界**(⚠ 都是**未经实测的起始值**;最慢的受支持真机测不过就先降,调高必须重跑
// scripts/test-diff.mjs 的资源族):
//   - 每侧输入 ≤ 204,800 UTF-8 字节(与正文 200 KiB 上限一致,入口先数);
//   - 行级编辑距离 D ≤ 1,024(紧凑 trace 约 2 MiB);
//   - 同时存活的类型化数组(行号表、逐层 trace、码点表与偏移表)≤ 8 MiB,**分配之前查**;
//     按数据区字节 + 每个数组 64 字节粗算对象头。字级的 trace 在行级回溯完、释放之后才起,
//     配对行**逐对**算、算完就还 ⇒ 不同时留着各行的 trace。
//     ⚠ 在现在这组数下它够不着(codex 核算):行级两张满行号表 + 0…1024 层 trace 上界
//     3,807,428 字节;字级进第 2000 层前对角线已记 2,001,000 工作单位 ⇒ 最多到第 1999 层,
//     连四张码点 / 偏移表上界 8,164,264 < 8,388,608。它是「哪天调高工作预算 / D 上限」时的那道闸。
//     这只是记账里的类型化数组,不是 JS 总堆或 GC 峰值。
//   - 行级的工作预算**还没构造出**能触发它的输入(D ≤ 1,024 下试过的 200 KiB 构造最高约 0.9M);
//     ⛔ 这是有限样本,不是「行级由 D 封住」的证明 —— snake 总量的理论上界是 (2D+1)·min(n,m)。
//     回溯里相等段是整段一次记账,所以超了时 `stats.work` 可能比预算多出一段,不止 1。
//   - 整次比较共享一份**累计工作预算** 2,000,000 单位:建行号表每行 1、剥首尾相同部分每比上一个 1、
//     每条对角线推进 1、snake 里每走一步 1、回溯每层 1 + 每个相等元素 1、字级数码点与建表每个码点
//     各 1。每一步都是当场记、当场查,⛔ 不攒到循环外。
//     行比较是比行号(先把每一行映成整数),⛔ 不在循环里比字符串;映行号时 Map 的哈希是线性的,
//     被入口的字节上限封住,只按行记 1。
//   - 输出:按 diff-dom.ts 的画法**整份结果合计** DOM 节点 ≤ 16,384(⛔ 不按改动段各给一份),
//     每造一行显示之前查。
// **实测**(scripts/probe-diff.mjs,vivo V2352GA 上的 Chrome 156,中位数 / 最慢一遍):最贵的两族 ——
// 字级最贵一对(工作预算到顶)186 / 254 ms、200 KiB 满屏同一行稀疏替换(D≈1000)185 / 235 ms,
// 连真 DOM 最重 347 ms;其余 ≤ 110 ms。量的是浏览器不是 app 的 WebView,鸿蒙(ArkWeb)**还没量**。
// 降级(都在算之前或途中按计数中止,⛔ 不算完再判):行级超了(字节 / D / 内存 / 工作)或输出
// 超了 ⇒ `ok: false`,画的那一侧显示两份原文;字级超了(内存 / 工作)⇒ 保留行级结果,当前及
// 其后的配对行不再细化,`limited = true`。⛔ 别把「没算出来」写成「全部不同」。

export const DIFF_MAX_BYTES = 204_800;
export const DIFF_MAX_D = 1_024;
export const DIFF_MAX_MEM = 8 * 1024 * 1024;
export const DIFF_MAX_WORK = 2_000_000;
/** 配对行进字级细化的资格:两侧各自 ≤ 这么多**码点**。 */
export const DIFF_MAX_CP = 2_000;
export const DIFF_MAX_DOM = 16_384;
/** 每个类型化数组按这么多字节粗算对象头,计进内存预算。 */
const ARRAY_OVERHEAD = 64;

/** 一行里的一截:`eq` = 两版都有;`del` 只出现在旧版那一行,`ins` 只出现在新版那一行。 */
export type DiffSeg = { t: "eq" | "del" | "ins"; s: string };

export type DiffRow =
  /** 一段连续的相等行(含行结束符,原样拼好)。 */
  | { t: "eq"; s: string }
  /** 一块整行删除 / 整行新增(不配对、不够资格、或细化受限)。 */
  | { t: "del"; s: string }
  | { t: "ins"; s: string }
  /** 配上对且细化了的一行:`del` 拼回 = 旧版那一行(只含 eq / del),`ins` 拼回 = 新版那一行(只含 eq / ins)。 */
  | { t: "pair"; del: DiffSeg[]; ins: DiffSeg[] };

/** `work` 累计工作单位;`peakMem` 同时存活的类型化数组峰值字节;`d` 行级编辑距离(没算完 = 走到的层数)。 */
export type DiffStats = { work: number; peakMem: number; d: number };
export type DiffFail = "bytes" | "depth" | "memory" | "work" | "nodes";
export type DiffResult =
  /** `nodes` = 按 diff-dom.ts 的画法要建的 DOM 节点数(含根)。 */
  | { ok: true; rows: DiffRow[]; limited: boolean; nodes: number; stats: DiffStats }
  | { ok: false; reason: DiffFail; stats: DiffStats };

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

class Over {
  reason: "depth" | "memory" | "work";
  constructor(reason: "depth" | "memory" | "work") {
    this.reason = reason;
  }
}

type Ctx = { stats: DiffStats; live: number };

function work(cx: Ctx, n: number): void {
  cx.stats.work += n;
  if (cx.stats.work > DIFF_MAX_WORK) throw new Over("work");
}

/** 建一个 `len` 个元素的 Int32Array —— 先查内存预算再建。 */
function i32(cx: Ctx, len: number): Int32Array {
  const bytes = len * 4 + ARRAY_OVERHEAD;
  if (cx.live + bytes > DIFF_MAX_MEM) throw new Over("memory");
  cx.live += bytes;
  if (cx.live > cx.stats.peakMem) cx.stats.peakMem = cx.live;
  return new Int32Array(len);
}
function release(cx: Ctx, a: Int32Array): void {
  cx.live -= a.length * 4 + ARRAY_OVERHEAD;
}

/** UTF-8 字节数超没超 `limit`(超了就停)。孤立代理按 3 字节算(编码时会变 U+FFFD)。 */
function exceedsBytes(s: string, limit: number): boolean {
  if (s.length > limit) return true; // 每个码元至少 1 字节
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Myers(行级与字级共用)
// ---------------------------------------------------------------------------

/** 编辑脚本:按顺序的 [种类, 长度] 对,种类 0 = 相等、1 = 删、2 = 增。 */
const EQ = 0;
const DEL = 1;
const INS = 2;

/**
 * A[a0..a1) 对 B[b0..b1) 的最短编辑脚本。`maxD` 是层数上限(超了抛 depth)。
 * trace 第 d 层只存有效对角线 k = -d, -d+2, …, d 上走得最远的 x(相对 a0),共 d+1 个;
 * 出界的对角线记 -1。回溯完 trace 全部释放。
 */
function myers(cx: Ctx, A: Int32Array, a0: number, a1: number, B: Int32Array, b0: number, b1: number, maxD: number, line: boolean): number[] {
  const n = a1 - a0;
  const m = b1 - b0;
  const trace: Int32Array[] = [];
  try {
    let D = -1;
    for (let d = 0; D < 0; d++) {
      if (d > maxD) throw new Over("depth");
      if (line) cx.stats.d = d;
      const cur = i32(cx, d + 1);
      trace.push(cur);
      const prev = d > 0 ? trace[d - 1] : null;
      for (let i = 0; i <= d; i++) {
        const k = -d + 2 * i;
        work(cx, 1);
        let x: number;
        if (prev === null) x = 0;
        else {
          x = start(prev, i, d, k, n, m);
          if (x < 0) {
            cur[i] = -1;
            continue;
          }
        }
        let y = x - k;
        while (x < n && y < m && A[a0 + x] === B[b0 + y]) {
          work(cx, 1);
          x++;
          y++;
        }
        cur[i] = x;
        if (x >= n && y >= m) {
          D = d;
          break;
        }
      }
    }
    // 回溯:从 (n, m) 沿 trace 倒着走,脚本先倒着收、最后翻过来
    const rev: number[] = [];
    let x = n;
    let y = m;
    for (let d = D; d > 0; d--) {
      work(cx, 1);
      const k = x - y;
      const prev = trace[d - 1];
      const i = (k + d) / 2;
      const down = takesDown(prev, i, d, k, n, m);
      const px = down ? prev[i] : prev[i - 1];
      const py = px - (down ? k + 1 : k - 1);
      const sx = down ? px : px + 1; // 这一步编辑之后、snake 之前的点
      if (x > sx) {
        work(cx, x - sx);
        push(rev, EQ, x - sx);
      }
      push(rev, down ? INS : DEL, 1);
      x = px;
      y = py;
    }
    if (x > 0) {
      work(cx, x);
      push(rev, EQ, x);
    }
    const out: number[] = [];
    for (let j = rev.length - 2; j >= 0; j -= 2) push(out, rev[j], rev[j + 1]);
    return out;
  } finally {
    for (const t of trace) release(cx, t);
  }
}

/** 第 d 层对角线 k 这一步取「从 k+1 下移(增)」吗。两边都合法且一样远时取下移(经典取向)。 */
function takesDown(prev: Int32Array, i: number, d: number, k: number, n: number, m: number): boolean {
  // prev 是第 d-1 层:对角线 k+1 在下标 i,k-1 在下标 i-1
  const dn = i < d ? prev[i] : -1; // 下移后 x 不变
  const rt = i > 0 ? prev[i - 1] : -1; // 右移后 x + 1
  const dnOk = dn >= 0 && dn - (k + 1) < m;
  const rtOk = rt >= 0 && rt < n;
  if (!dnOk) return false;
  if (!rtOk) return true;
  return rt + 1 <= dn;
}

/** 第 d 层对角线 k 这一步编辑之后的 x;两条来路都出界 = -1。 */
function start(prev: Int32Array, i: number, d: number, k: number, n: number, m: number): number {
  const dn = i < d ? prev[i] : -1;
  const rt = i > 0 ? prev[i - 1] : -1;
  const dnOk = dn >= 0 && dn - (k + 1) < m;
  const rtOk = rt >= 0 && rt < n;
  if (!dnOk && !rtOk) return -1;
  return takesDown(prev, i, d, k, n, m) ? dn : rt + 1;
}

/** 往脚本里追一段;与上一段同种就并上。 */
function push(s: number[], op: number, len: number): void {
  if (s.length > 0 && s[s.length - 2] === op) s[s.length - 1] += len;
  else s.push(op, len);
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/** 按 `\n` 切行,`\n` 留在行尾;最后一段没有 `\n` 且非空才算一行。`""` → `[]`。 */
function splitLines(s: string): string[] {
  const out: string[] = [];
  let p = 0;
  while (p < s.length) {
    const q = s.indexOf("\n", p);
    const e = q < 0 ? s.length : q + 1;
    out.push(s.slice(p, e));
    p = e;
  }
  return out;
}

/** 比较两版正文。旧版 `a`、新版 `b`。 */
export function diffText(a: string, b: string): DiffResult {
  const stats: DiffStats = { work: 0, peakMem: 0, d: 0 };
  if (exceedsBytes(a, DIFF_MAX_BYTES) || exceedsBytes(b, DIFF_MAX_BYTES)) return { ok: false, reason: "bytes", stats };
  const cx: Ctx = { stats, live: 0 };
  const la = splitLines(a);
  const lb = splitLines(b);
  let script: number[];
  let pre = 0;
  let suf = 0;
  try {
    // 行 → 整数(同一行文本同一个号),之后只比整数
    const ids = new Map<string, number>();
    const A = i32(cx, la.length);
    const B = i32(cx, lb.length);
    const intern = (ls: string[], into: Int32Array): void => {
      for (let i = 0; i < ls.length; i++) {
        work(cx, 1);
        let id = ids.get(ls[i]);
        if (id === undefined) {
          id = ids.size;
          ids.set(ls[i], id);
        }
        into[i] = id;
      }
    };
    intern(la, A);
    intern(lb, B);
    // 首尾相同的行先剥掉(Myers 本身也会走过去,这里只是省 trace)
    const lim = Math.min(A.length, B.length);
    work(cx, 2);
    while (pre < lim && A[pre] === B[pre]) {
      work(cx, 1);
      pre++;
    }
    while (suf < lim - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) {
      work(cx, 1);
      suf++;
    }
    script = myers(cx, A, pre, A.length - suf, B, pre, B.length - suf, DIFF_MAX_D, true);
    release(cx, A);
    release(cx, B);
  } catch (e) {
    if (e instanceof Over) return { ok: false, reason: e.reason, stats };
    throw e;
  }
  if (pre > 0) script.unshift(EQ, pre);
  if (suf > 0) push(script, EQ, suf);
  return build(cx, la, lb, script);
}

// ---------------------------------------------------------------------------
// 编辑脚本 → 显示行(含输出节点预算与字级细化)
// ---------------------------------------------------------------------------

/** 按 diff-dom.ts 的画法:根 1;eq / del / ins 一行 = 元素 + 文本 2;pair = 两行元素 2 + 每截
 *  (eq 截 = 文本 1,del / ins 截 = 元素 + 文本 2)。两边改一边就得改另一边,测试对拍。 */
function rowCost(r: DiffRow): number {
  if (r.t !== "pair") return 2;
  let c = 2;
  for (const s of r.del) c += s.t === "eq" ? 1 : 2;
  for (const s of r.ins) c += s.t === "eq" ? 1 : 2;
  return c;
}

class NodesOver {}

function build(cx: Ctx, la: string[], lb: string[], script: number[]): DiffResult {
  const rows: DiffRow[] = [];
  let nodes = 1;
  let limited = false;
  const emit = (r: DiffRow): void => {
    const c = rowCost(r);
    if (nodes + c > DIFF_MAX_DOM) throw new NodesOver();
    nodes += c;
    rows.push(r);
  };
  let ia = 0;
  let ib = 0;
  try {
    for (let j = 0; j < script.length; ) {
      if (script[j] === EQ) {
        const len = script[j + 1];
        emit({ t: "eq", s: la.slice(ia, ia + len).join("") });
        ia += len;
        ib += len;
        j += 2;
        continue;
      }
      // 一个改动段:收到下一段相等为止
      let p = 0;
      let q = 0;
      for (; j < script.length && script[j] !== EQ; j += 2) {
        if (script[j] === DEL) p += script[j + 1];
        else q += script[j + 1];
      }
      if (p !== q) {
        if (p > 0) emit({ t: "del", s: la.slice(ia, ia + p).join("") });
        if (q > 0) emit({ t: "ins", s: lb.slice(ib, ib + q).join("") });
      } else {
        // 等长:逐行配对;细化不了的相邻几对并成一块删 + 一块增
        let from = 0; // 还没吐出去的整行配对起点
        const flush = (to: number): void => {
          if (to > from) {
            emit({ t: "del", s: la.slice(ia + from, ia + to).join("") });
            emit({ t: "ins", s: lb.slice(ib + from, ib + to).join("") });
          }
        };
        for (let k = 0; k < p; k++) {
          if (limited) break;
          const r = refine(cx, la[ia + k], lb[ib + k]);
          if (r === "limited") {
            limited = true;
            break;
          }
          if (r === null) continue; // 不够资格:留在整行块里
          flush(k);
          emit(r);
          from = k + 1;
        }
        flush(p);
      }
      ia += p;
      ib += q;
    }
  } catch (e) {
    if (e instanceof NodesOver) return { ok: false, reason: "nodes", stats: cx.stats };
    throw e;
  }
  return { ok: true, rows, limited, nodes, stats: cx.stats };
}

/** 一行 → 码点表 + 「码点边界 → UTF-16 偏移」表;码点超过 DIFF_MAX_CP 回 null(不建)。 */
function codePoints(cx: Ctx, s: string, held: Int32Array[]): { cp: Int32Array; off: Int32Array } | null {
  if (s.length > 2 * DIFF_MAX_CP) return null; // 码点数 ≥ 码元数 / 2
  // 取码点只有这一处(孤立代理照样算一个码点);⛔ 别换成 charCodeAt —— 那就劈开代理对了
  const at = (i: number): number => s.codePointAt(i)!;
  let n = 0;
  for (let i = 0; i < s.length; n++) {
    work(cx, 1);
    i += at(i) > 0xffff ? 2 : 1;
  }
  if (n > DIFF_MAX_CP) return null;
  const cp = i32(cx, n);
  held.push(cp);
  const off = i32(cx, n + 1);
  held.push(off);
  let i = 0;
  for (let j = 0; j < n; j++) {
    work(cx, 1);
    const c = at(i);
    cp[j] = c;
    off[j] = i;
    i += c > 0xffff ? 2 : 1;
  }
  off[n] = i;
  return { cp, off };
}

/** 往一侧追一截;与上一截同种就并上(另一侧的改动夹在中间时,这一侧会出现相邻的两截相等)。 */
function seg(xs: DiffSeg[], t: DiffSeg["t"], s: string): void {
  const l = xs[xs.length - 1];
  if (l !== undefined && l.t === t) l.s += s;
  else xs.push({ t, s });
}

/** 配对的两行做字级比。`null` = 不够资格(整行);`"limited"` = 字级预算用完。 */
function refine(cx: Ctx, s: string, t: string): DiffRow | null | "limited" {
  const held: Int32Array[] = [];
  try {
    const x = codePoints(cx, s, held);
    if (x === null) return null;
    const y = codePoints(cx, t, held);
    if (y === null) return null;
    const A = x.cp;
    const B = y.cp;
    const lim = Math.min(A.length, B.length);
    let pre = 0;
    let suf = 0;
    work(cx, 2);
    while (pre < lim && A[pre] === B[pre]) {
      work(cx, 1);
      pre++;
    }
    while (suf < lim - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) {
      work(cx, 1);
      suf++;
    }
    const script = myers(cx, A, pre, A.length - suf, B, pre, B.length - suf, Infinity, false);
    if (pre > 0) script.unshift(EQ, pre);
    if (suf > 0) push(script, EQ, suf);
    const del: DiffSeg[] = [];
    const ins: DiffSeg[] = [];
    let ia = 0;
    let ib = 0;
    for (let j = 0; j < script.length; j += 2) {
      const op = script[j];
      const len = script[j + 1];
      if (op !== INS) {
        seg(del, op === EQ ? "eq" : "del", s.slice(x.off[ia], x.off[ia + len]));
        ia += len;
      }
      if (op !== DEL) {
        seg(ins, op === EQ ? "eq" : "ins", t.slice(y.off[ib], y.off[ib + len]));
        ib += len;
      }
    }
    return { t: "pair", del, ins };
  } catch (e) {
    if (e instanceof Over) return "limited";
    throw e;
  } finally {
    for (const h of held) release(cx, h);
  }
}
