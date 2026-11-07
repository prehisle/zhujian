// UI 共享件(120):$ / esc / 时间格式 / 错误提示条 / stage 词汇——从 main.ts 上抬,
// 供卡片操作面板与回收站/归档册/搜索各面共用(单一真相源,别在模块里各抄一份)。

import { t } from "./i18n";
import { parseChecklistLine } from "../../shared/checklist";
import { BAR_RETIRE_MS, CONFIRM_REVERT_MS, TOAST_ERROR_MS, toastSuccessMs } from "./timing";

export const $ = (id: string) => document.getElementById(id)!;

export const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 卡片颜色标记(0040 `items.color`,用户面 110)→ 挂到 `<article class="card…">` 上的类与行内变量。
 *  无色返回两个空串;有色 = ` tinted` + ` style="--card-rgb:R G B"`,整卡一层淡底由 index.html
 *  的 `.card.tinted` 画(浓度令牌 `--card-tint-a`,理由在那儿)。
 *
 *  ⭐ **为什么拆成「三个数 + 一枚 alpha 令牌」而不是像桌面那样整串喂 `--card-color`**:
 *  ① 桌面那形靠 `color-mix()`,要 Chrome 111,台架 MuMu 是 110,且含 `var()` 时补兜底救不了
 *     (IACVT,mobile.md 643);② 也**不按七色各烤一枚令牌** —— 两道后端闸刻意只验 `#RRGGBB`
 *     格式、不验调色板成员(card-color.ts 头注:调色板有意扩展),按色烤令牌 = 手机端再抄一份
 *     调色板,桌面一加色这边就画不出;这里任何合法 hex 都照画,与桌面同一份数据同一个结果
 *     (rgba 叠在 `--raised` 上 ≡ `color-mix(in srgb, C a, --raised)`,算术上逐位相同)。
 *  ③ 顺带把休眠账 7 那条消费面约束做成了**结构上不可能**:写进 CSS 的只有这里解出来的三个
 *     十进制整数,同步来的自由文本一个字也到不了样式表。
 *  非 `#RRGGBB` = 两道后端闸都漏了,响亮抛(不静默当无色)。 */
export function cardTint(color: string | null): { cls: string; attr: string } {
  if (color === null) return { cls: "", attr: "" };
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!m) throw new Error(`卡片颜色不是 #RRGGBB:${color}`);
  const rgb = m.slice(1).map((h) => parseInt(h, 16)).join(" ");
  return { cls: " tinted", attr: ` style="--card-rgb:${rgb}"` };
}

/** 正文 → HTML:行首 `- [ ] ` / `- [x] ` 画成一枚方框(checklist.ts 认行),其余照旧逐字
 *  转义。⚠ 逐行处理、`\n` 原样接回去(卡片正文是 white-space:pre-wrap)。
 *
 *  `clickable=false` 是只读面(回收站 / 归档册 / 搜索结果)那形:照显勾没勾,但 disabled
 *  ——⛔ 不是换成别的标签,两形同一个签名才共用同一份样式。
 *  `data-ck` = 行号,点击处理据此翻那一行(main.ts 的时间轴委托)。 */
export function contentHtml(content: string, clickable: boolean): string {
  const out: string[] = [];
  let prevWasBox = false;
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    const box = parseChecklistLine(line);
    if (box === null) {
      // 正文是 white-space:pre-wrap,换行原样交回去 —— 但**待办项那行是 flex 块、自带
      // 换行**,紧跟它再补一个 `\n` 就会空出一行。故只在「上一行也是普通文本」时补。
      if (i > 0 && !prevWasBox) out.push("\n");
      out.push(esc(line));
      prevWasBox = false;
      return;
    }
    // 157 G3(WM-27):紧挨在待办项前面的空行是那段文字的末行 —— pre-wrap 的末尾换行不成行、单独一个
    // 空串更是零高 ⇒ 两组清单之间特意空出的那一行在卡上看不见。补一枚零宽空格让它成行。
    if (i > 0 && !prevWasBox && lines[i - 1] === "") out.push("\u200b");
    const act = box.checked ? t("checklist.uncheck") : t("checklist.check");
    const state = box.checked ? t("checklist.checked") : t("checklist.unchecked");
    const label = clickable ? act : state;
    const on = box.checked ? " on" : "";
    const dis = clickable ? "" : " disabled";
    // 缩进(嵌套清单)化成整行左内边距 —— flex 容器里的纯空白子节点会被丢掉,靠不住
    // pre-wrap 里那几个空格。勾没勾挂在**外层 .ckline** 上,一处翻、方框与文字同时跟着走。
    const ind = box.indent === "" ? "" : ` style="--ck-indent:${box.indent.length}"`;
    out.push(
      `<span class="ckline${on}"${ind}><button class="ckbox" type="button" data-ck="${i}"${dis}` +
        ` aria-label="${esc(label)}"></button><span class="cktext">${esc(box.rest)}</span></span>`,
    );
    prevWasBox = true;
  });
  return out.join("");
}

// ⛔ **stage → 印文的那张表已搬去 `columns.ts`**(B-f 第 1 段):列可由用户增删改名 ⇒
//    它不再是一张能在模块求值期算完的常量表,而是每轮加载登记的库内事实。
//    印文取 `stageLabel(stage)`、任务态判定取 `isTaskStage(stage)`,语义与从前一字不差
//    (灵感态仍答 undefined —— 灵感是纸面的默认态,不盖印)。

/** 只报时刻。随记时间轴用:日期已经是节头,卡上再写一遍是同一句话说两遍。 */
export function fmtTimeOfDay(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 按天分组(随记时间轴)------------------------------------------------
// 桌面那半早就有(`src/tasktime.ts` 的 dayKey / dayLabel,`src/inbox.ts` 的 .tl-group),
// 这一端一直是平铺一条列表。⛔ 两份不是同一个模块,是**逐字孪生**:改一端的语义就两端一起改。
/** 本地日的零点(毫秒),同天判定与「今天 / 昨天」的算子。 */
function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
/** 同一天分到同一组的键。⛔ 别拿 ISO 串前 10 位顶 —— 那是 UTC 日,东八区凌晨八点前记的会归错天。 */
export function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
/** 今天 / 昨天 / 前天,else M月D日(跨年带年)。值与桌面 tasktime.* 逐字同形。 */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (diff === 0) return t("ui.dayToday");
  if (diff === 1) return t("ui.dayYesterday");
  if (diff === 2) return t("ui.dayBeforeYesterday");
  const m = d.getMonth() + 1;
  const day = d.getDate();
  return d.getFullYear() === now.getFullYear()
    ? t("ui.dayMonthDay", { m, d: day })
    : t("ui.dayYearMonthDay", { y: d.getFullYear(), m, d: day });
}

/** 时间戳(165 / W5 Q14:两端一个规矩):今天的写「今天 15:18」,别的天写「11月5日 15:18」,跨年带年。
 *  此前当天只报时刻(回收站「删于 21:10」、长文列表「17:46」)、而同一张在归档 / 长文阅读页又写全日期 —— 一件事几种写法。
 *  ⛔ 例外只有两处、都不走这里:随记时间轴的卡只写时刻(组头已写了哪天,`fmtTimeOfDay`),截止胶囊窄、短写法照旧(main.ts dueLabel)。 */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hm = fmtTimeOfDay(iso);
  if (d.toDateString() === now.toDateString()) return t("ui.whenToday", { hm });
  const md = { m: d.getMonth() + 1, d: d.getDate(), hm };
  return d.getFullYear() === now.getFullYear()
    ? t("ui.whenThisYear", md)
    : t("ui.whenOtherYear", { ...md, y: d.getFullYear() });
}

/** 回执里点名「是哪一条」用的那一截(165 / W5 Q15:「已彻底删除「…」」—— 找不回的那一下得说清删的是谁)。
 *  取第一行有字的、剥掉行首的 Markdown 标题号与清单方框,长了截到 `max` 个字加「…」。整条没有字(只有图)= ""。
 *  ⚠ 桌面照抄同一条规则(D2),两端点名同一截。 */
export function itemSnippet(content: string, max = 20): string {
  const line = content
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s !== "");
  if (line === undefined) return "";
  const bare = line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+\[[ xX]\]\s*/, "").replace(/\s+/g, " ").trim();
  const chars = Array.from(bare);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : bare;
}

/** 比对前把两版的末行补齐换行(165 / W5 A32):行尾的换行是行的一部分,上一版末行没带换行、补了一段之后它带上了 ⇒
 *  同一行字被比成「删掉一行 + 加上一行」,红一遍又一字不差绿一遍,读着像改过。⛔ 只改**拿去比的那两份**,存下的版本一个字不动。 */
export function diffPair(a: string, b: string): [string, string] {
  const eol = (s: string): string => (s === "" || s.endsWith("\n") ? s : `${s}\n`);
  const na = eol(a);
  const nb = eol(b);
  // 两版**只**差末尾那个换行:补齐就成了同一份、比对里一处差异都不标 ⇒ 这种照原样比(差异就是那个换行,照实报,不误报「没有变化」)。
  return na === nb ? [a, b] : [na, nb];
}

// ---- 卡片分栏(宽屏;tablet-plan 格 1 / 5)--------------------------------------------
// 随记时间轴(main.ts::renderDayGroups)与回收站 / 归档 / 搜索三个面的卡片列表(panes.ts)共用这一组数:每栏不窄于
// NOTE_COL_MIN、最多 NOTE_COLS_MAX 栏 ⇒ 1400 的框三栏、960 / 800 两栏、手机竖放(≤ 430)恒 1 栏。
// ⚠ 与 CSS 是同一组数:`.tl-cols` 的 gap = NOTE_COL_GAP;宽屏断点 720 = 2 × NOTE_COL_MIN + NOTE_COL_GAP + 两边 14。
//   改一处就得改另一处(index.html「宽屏」那段头注写着同一句)。NOTE_COLS_MAX = 3 是用户拍的「横三」—— 1400 的框
//   按 340 算放得下四栏,封顶三栏。
const NOTE_COL_MIN = 340;
const NOTE_COL_GAP = 12;
const NOTE_COLS_MAX = 3;
/** 这么宽的列表放得下几栏。 */
export function colsFor(width: number): number {
  return Math.max(1, Math.min(NOTE_COLS_MAX, Math.floor((width + NOTE_COL_GAP) / (NOTE_COL_MIN + NOTE_COL_GAP))));
}
/** 一串卡片**轮流分栏**(第 i 张进第 i % n 栏,栏里紧挨着往下排)的标记;1 栏时原样拼接 —— 与分栏之前逐字相同。
 *  ⛔ 别改成「放进当前最矮的一栏」:那要先量高,而缩略图晚到、折叠、操作面展开都会改高 ⇒ 卡会在栏间跳来跳去;
 *  轮流分只看序号,恒定。 */
export function splitCols(cards: string[], n: number): string {
  if (n === 1) return cards.join("");
  const cols: string[][] = Array.from({ length: n }, () => []);
  cards.forEach((c, i) => cols[i % n].push(c));
  return `<div class="tl-cols">${cols.map((c) => `<div class="tl-col">${c.join("")}</div>`).join("")}</div>`;
}

// ---- 定位落点的标记(159 / W3 A14,WM-07 / X-07)--------------------------------------
// 从搜索结果跳过去,落点那张卡此前只有 1.2 s 的 `.flash` 脉冲 —— 平滑滚动还没停它就过完了,卡落在一串长得一样的卡中间
// 认不出来。⇒ 冷着陆换成**常亮一会儿再褪**的框(同桌面 `.just-located`:朱砂描边 + 淡朱底),几秒后自己淡掉。
// ⚠ 桌面那枚等「下一次点击 / 滚轮」才褪;手机上手指一碰屏就是 pointerdown(划一下也算),那样刚落地一划就没了 ⇒ 这边按时褪。
// ⛔ 「你自己刚建的那张」(新建 / 挪卡回执的「去看看」)照旧用 `.flash`:那是你知道在哪儿的,不是冷着陆。
/** 落点框常亮多久(含平滑滚动那一段)。元素级节奏,不进 §2.4 表(同 `.flash` 的 1200)。 */
const LOCATED_HOLD_MS = 3200;
/** 淡出那段 —— 与 index.html `.card.located` 的 transition 同长。 */
const LOCATED_FADE_MS = 600;
let locatedEl: HTMLElement | null = null;
let locatedTimer: number | undefined;
/** 给落点卡挂上定位框,到点淡出摘掉。新的一枚顶掉旧的(绝不同时留两枚)。 */
export function markLocated(el: HTMLElement): void {
  clearTimeout(locatedTimer);
  if (locatedEl && locatedEl !== el) locatedEl.classList.remove("located", "locate-fading");
  locatedEl = el;
  el.classList.remove("locate-fading");
  el.classList.add("located");
  locatedTimer = window.setTimeout(() => {
    el.classList.add("locate-fading");
    locatedTimer = window.setTimeout(() => {
      el.classList.remove("located", "locate-fading");
      if (locatedEl === el) locatedEl = null;
    }, LOCATED_FADE_MS);
  }, LOCATED_HOLD_MS);
}

/** 把 `root` 里出现的词包成 `<mark class="hit">`(159 / W3 Q8:搜索与过滤命中标红)。⚠ 渲染**之后**走文本节点改,
 *  不碰正文渲染那条路(清单方框、「图N」都在,只是里面的字被包一层);⛔ 不用 innerHTML(用户正文不进 HTML 解析)。
 *  不分大小写、每个词的每一处;同一段文字里几个词挨着 / 重叠的并成一枚(同桌面 search.ts::highlighted)。空词表 = 什么也不做。 */
export function markHits(root: HTMLElement, words: string[]): void {
  const ws = words.map((w) => w.toLowerCase()).filter((w) => w !== "");
  if (!ws.length) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) nodes.push(n as Text);
  for (const node of nodes) {
    const s = node.data;
    const hay = s.toLowerCase();
    const hit = new Array<boolean>(s.length).fill(false);
    let any = false;
    for (const w of ws) {
      for (let at = hay.indexOf(w); at >= 0; at = hay.indexOf(w, at + 1)) {
        hit.fill(true, at, at + w.length);
        any = true;
      }
    }
    if (!any) continue;
    const frag = document.createDocumentFragment();
    for (let from = 0; from < s.length; ) {
      let to = from;
      while (to < s.length && hit[to] === hit[from]) to++;
      const piece = s.slice(from, to);
      if (hit[from]) {
        const m = document.createElement("mark");
        m.className = "hit";
        m.textContent = piece;
        frag.append(m);
      } else frag.append(piece);
      from = to;
    }
    node.replaceWith(frag);
  }
}

// ---- 错误/提示条:后端原话,响亮但会自己退场(notice = 非错误的提示) ----------
// 退场时长按「读得完」定,不再一律 6s(221:全部 24 个调用点共用 6s,「已移到「X」」
// 这种六个字的回执也要顶在时间轴上方杵满六秒)。错误=后端原话、要读懂才好处置,
// 保持 6s;notice=回执,按字数给读秒(下限 2.2s 够扫一眼,上限仍 6s 兜住长指引)。
// 另外补一条:点一下就收——此前 6s 内只能干等或等下一条顶掉。

// 340:这四个值原是本文件的内联字面量,已提进 ./timing(§2.4 的代码侧真身),
// 与桌面 src/timing.ts 逐值对齐、由 check-timing-drift 看着。

let errTimer: number | undefined;
let errWired = false;

function hideBar(): void {
  clearTimeout(errTimer);
  const el = $("error");
  el.classList.remove("retiring");
  el.hidden = true;
}

/** 换面 / 关面时调(164):错误型提示条说的是上一页的事 —— 挂着读秒走到下一页,正盖在那一页顶上的钮上,
 *  而 §3.1 定了它点一下只收、不穿透 ⇒ 第一下点击白给(walk161-m2 S11 量到:同步面「添加设备」点了没反应)。
 *  要读完的长句各自落在表单 / 面板里那一行(加入空间 `#join-err`、同步表单 `#sync-form-err`、设备名单),不靠这条。
 *  回执 / 中性 / 带动作钮(撤销、网络自检)那几形不收:翻一页不该把撤销的机会也翻没了。 */
export function dropErrorBar(): void {
  const el = $("error");
  if (el.hidden || el.classList.contains("notice") || el.classList.contains("neutral") || el.classList.contains("with-act")) return;
  hideBar();
}

/** 读秒到点的退场(157 G1②):先进余温态 —— 整条变淡,条**还在原位**接住迟到的那一下点
 *  (点条身 = hideBar,立刻收;那一下不会落到底下的「同步」上),`BAR_RETIRE_MS` 后才真收。
 *  ⛔ 别把余温态的钮移走或藏掉:条会变矮,瞄着钮落下的那一指正好穿过去。
 *  ⭐ 158 G1(W2 走查 A5):余温里点「撤销」**照旧生效**。此前钮在这段被置灰,点得中却什么都没发生、
 *  也不说 —— 余温的本意是「接住迟到的那一下」,对撤销条来说接住就该照办(撤销是把事还原,迟一秒照办
 *  没有坏处);确认条那边相反,迟到的「确认」作废并明说「没确认,已作罢」(删掉东西不该靠迟到的一指)。 */
function retireBar(el: HTMLElement): void {
  el.classList.add("retiring");
  errTimer = window.setTimeout(hideBar, BAR_RETIRE_MS);
}

/** 懒接线(模块加载期不碰 DOM):点条身即收,不等读秒走完。 */
function wireBar(el: HTMLElement): void {
  if (errWired) return;
  el.addEventListener("click", hideBar);
  errWired = true;
}

/** `neutral`(161 / W4 A36,WM-28):既不是错、也不是「做成了」的那一档(「一个字没写,这篇没有建」),墨底纸字;
 *  读秒按回执那档(按字数)。⛔ 别拿 notice 的绿条说「什么都没发生」—— 绿色读作成功。 */
export function showBar(msg: string, notice = false, neutral = false) {
  const el = $("error");
  wireBar(el);
  el.textContent = msg;
  el.classList.toggle("notice", notice && !neutral);
  el.classList.toggle("neutral", neutral);
  el.classList.remove("with-act", "retiring");
  el.hidden = false;
  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => retireBar(el), notice || neutral ? toastSuccessMs(msg) : TOAST_ERROR_MS);
}

/** 操作型回执(§3.1):回执文案 + 一枚动作钮(如滑动改状态的「撤销」),notice 形。
 *  点钮=执行并收(冒泡到条身完成收条),点条身=只收;没人点则 CONFIRM_REVERT_MS 后
 *  自动收(动作窗口长度与此前借 confirmBar 的形一致)。新条来了整条重建、旧钮随节点
 *  移除自然作废,无需 token。⛔ 别再拿 confirmBar 当回执用:它左钮恒印「取消」,与
 *  「已改为…」这类既成事实并排,「取消/撤销」读成一对反义词(用户 2026-08-16 实报)。 */
export function actionBar(msg: string, actLabel: string, onAct: () => void, more?: { label: string; on: () => void }): void {
  barWithAct(msg, actLabel, onAct, true, CONFIRM_REVERT_MS, more);
}

/** 错误条 + 一枚「下一步」钮(用户面 126,err.ts `showErr`:「连不上」后面挂「网络诊断」)。
 *  形同 actionBar,只是底色走错误那档、读秒同 showError。 */
export function errorActionBar(msg: string, actLabel: string, onAct: () => void): void {
  barWithAct(msg, actLabel, onAct, false, TOAST_ERROR_MS);
}

function barWithAct(
  msg: string,
  actLabel: string,
  onAct: () => void,
  notice: boolean,
  ms: number,
  more?: { label: string; on: () => void },
): void {
  const el = $("error");
  wireBar(el);
  el.textContent = "";
  const text = document.createElement("span");
  text.textContent = msg;
  const act = document.createElement("button");
  act.className = "bar-act";
  act.textContent = actLabel;
  act.onclick = onAct;
  el.append(text, act);
  // 第二枚(157 G4 / P3:「撤销」旁边的「去看看」):同形同收法,点了也冒泡到条身收条。
  if (more) {
    const b = document.createElement("button");
    b.className = "bar-act";
    b.textContent = more.label;
    b.onclick = more.on;
    el.append(b);
  }
  el.classList.toggle("notice", notice);
  el.classList.remove("neutral");
  el.classList.add("with-act");
  el.classList.remove("retiring");
  el.hidden = false;
  clearTimeout(errTimer);
  errTimer = window.setTimeout(() => retireBar(el), ms);
}

export const showError = (msg: string) => showBar(msg);

/** 点了【撤销】、撤成了之后的那一句(165 / W5 Q6,两端同句):条一收、卡回原处,而回到的地方常不在眼前 ——
 *  不说一声就没法确认撤没撤成;误点中撤销(A31)也只有这一句能让人发现。成功型、按字数读秒(约 2 秒),不带钮。
 *  ⛔ 撤销失败不走这里(调用方照旧 showErr)。 */
export function showUndone(): void {
  showBar(t("common.undone"), true);
}

// ---- 底部固定确认条(ui-audit P0 #4):两拍确认的第二拍 --------------------------
// 第一拍只弹这条 fixed 条,原按钮与周围布局零改动——第二拍永远落在几何恒定、
// 远离单拍控件的位置。token 防旧定时器/旧回调作用于新确认;调用方在 onYes 里
// 自行复核状态(session/行还在)再执行,过期即弃。

let cbTimer: number | undefined;
let cbToken = 0;

/** 重破坏那一档(§3.8「确认钮全宽」/ §3.2 第 6 条权重升格;159 / W3 A19:清空回收站此前与删一枚标签同形同大)。
 *  `from` = 点出这条确认的那枚钮 —— 全宽的执行钮横贯整条,**会落到它的原落点上**(§3.2 第 2 条),量了躲开。 */
export type HeavyConfirm = { from: HTMLElement };

/** `noLabel`:左钮的字,不给就是「取消」。158 G1(W2 走查 WM-24):编辑层点「取消」问「丢掉这次的修改?」,
 *  条上左钮再印一个「取消」,读不出是「取消丢掉」还是「取消编辑」⇒ 那种问句给左钮换一个不歧义的词。
 *  `heavy`:见 `HeavyConfirm`。版式换成三行(问句 / 全宽执行钮 / 全宽取消,同空间重置那形「确认钮全宽独行、取消拉开在下」)。 */
export function confirmBar(question: string, yesLabel: string, onYes: () => void, noLabel?: string, heavy?: HeavyConfirm): void {
  const token = ++cbToken;
  const bar = $("confirmbar");
  bar.classList.toggle("heavy", heavy !== undefined);
  bar.style.transform = "";
  $("confirmbar-q").textContent = question;
  const yes = $("confirmbar-yes") as HTMLButtonElement;
  const no = $("confirmbar-no") as HTMLButtonElement;
  no.textContent = noLabel ?? t("shell.cancel");
  no.onclick = () => hideConfirmBar();
  no.disabled = false;
  yes.disabled = false;
  yes.textContent = yesLabel;
  yes.onclick = () => {
    if (token !== cbToken) return; // 已被新确认/收起替代:旧回调作废
    hideConfirmBar();
    onYes();
  };
  bar.classList.remove("retiring");
  bar.hidden = false;
  if (heavy) dodgeTrigger(bar, yes, heavy.from);
  clearTimeout(cbTimer);
  cbTimer = window.setTimeout(() => {
    if (token !== cbToken) return;
    // 没接第二拍:先交代一句、钮变灰(条高不变,迟到的那一指落在条上不落到底下),余温过了才收(157 G1②)。
    // 放宽到 6s 的来龙去脉见 timing.ts 那一格。
    cbToken++; // 旧「确认」从此作废(钮已灰,这是第二道)
    bar.classList.add("retiring");
    $("confirmbar-q").textContent = t("ui.confirmExpired");
    no.disabled = true;
    yes.disabled = true;
    cbTimer = window.setTimeout(hideConfirmBar, BAR_RETIRE_MS);
  }, CONFIRM_REVERT_MS);
}

export function hideConfirmBar(): void {
  cbToken++;
  clearTimeout(cbTimer);
  const bar = $("confirmbar");
  bar.classList.remove("retiring", "heavy");
  bar.style.transform = "";
  bar.hidden = true;
}

/** 全宽执行钮横贯整条 ⇒ 点出确认的那枚钮若正好在条的高度上(翻到面底时「清空…」就在屏底、正是条出现的地方),
 *  手快的第二下会直接落在执行钮上(§3.2 第 2 条,桌面那半是 A9)。量两者的屏幕位置:纵向有交叠就把整条往上抬,
 *  抬到执行钮的下沿离触发钮上沿还有 8px —— 原落点上于是只剩「取消」或条的留白。
 *  ⚠ 抬的是**条**,不是滚页面:第二下落在屏幕的同一点,滚页面只挪得动触发钮、挪不动条。 */
function dodgeTrigger(bar: HTMLElement, yes: HTMLElement, from: HTMLElement): void {
  const f = from.getBoundingClientRect();
  const y = yes.getBoundingClientRect();
  if (f.height === 0 || y.top >= f.bottom || y.bottom <= f.top) return;
  bar.style.transform = `translateY(${-Math.ceil(y.bottom - f.top + 8)}px)`;
}
