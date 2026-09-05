// 正文里的待办清单 —— 行首 `- [ ] ` / `- [x] ` 画成一枚可点的方框,点一下把那一行的
// 标记翻面、整条正文写回。本文件只有**纯文本逻辑**(认行 / 翻标记),画和写在 main.ts:
// 时间轴卡片渲染成 HTML,写走 edit_note。
//
// ⚠ 桌面那份是 `src/checklist.ts`,**逐字对应的第一份** —— 两棵前端树物理上合不成一份
// (同 filter / timing 那族),**没有门禁核它俩相等**,⛔ 改这份必须同轮改那份。
//
// ⛔ **刻意只认这一种语法**:裸 `- 文字` 是普通列表、**不**当待办项 —— 否则用户就再也
// 写不出一个不带勾的列表了(用户 2026-09-01 拍板)。粗体 / 标题 / 代码块一概不做:这是
// 「正文里能勾几个框」,不是 markdown 编辑器 —— 那条线一破就会一路滑成富文本编辑器,
// 与「轻量 / 最小化」正面冲突。
//
// ⛔ **翻标记只动方括号里那一个字符**,缩进与标记后面那一截原文原样搬回去 —— 正文是
// 用户的话,勾选不是编辑它的借口。

/** 一行待办项拆开的样子(`parseChecklistLine` 的产物)。 */
export type ChecklistLine = {
  /** 行首缩进原样(写回时原样放回)。 */
  indent: string;
  checked: boolean;
  /** 标记后面那一截原文,**含它前面那个空格**;原样保留。 */
  rest: string;
};

// 行首可有缩进;`- ` 之后是 `[ ]` 或 `[x]`(大小写都收 —— 两种写法 markdown 里都有);
// 方括号之后必须是**行尾或一个空白** ⇒ `- [x]abc` 不是待办项,那就是一句普通的话。
const LINE_RE = /^([ \t]*)- \[([ xX])\](|\s.*)$/;

/** 这一行是不是待办项?不是就返回 null(调用方照普通正文画)。 */
export function parseChecklistLine(line: string): ChecklistLine | null {
  const m = LINE_RE.exec(line);
  if (m === null) return null;
  return { indent: m[1], checked: m[2] !== " ", rest: m[3] };
}

/** 把 `content` 第 `lineIndex` 行的勾选翻面,返回新正文。
 *
 *  那一行**不是**待办项(画出来到点下去之间正文被远端改过、索引对不上)就返回 `null`,
 *  调用方据此**放弃这一次点击** —— ⛔ 别猜、别就近找一行来勾:勾错一行是静默改错数据。 */
export function toggleChecklistLine(content: string, lineIndex: number): string | null {
  const lines = content.split("\n");
  if (lineIndex < 0 || lineIndex >= lines.length) return null;
  const parsed = parseChecklistLine(lines[lineIndex]);
  if (parsed === null) return null;
  lines[lineIndex] = `${parsed.indent}- [${parsed.checked ? " " : "x"}]${parsed.rest}`;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 快速输入(562;600 添缩进那记):打清单时别一个字一个字敲 `- [ ] `、也别为了起一级
// 手挪光标去行首敲空格。三件事,都是**编辑器辅助** —— 用户看得见改了什么、一个退格/一次
// 撤销就能回去。
//
// ⛔ **不做「打 `- ` 自动补成 `- [ ] `」** —— 那是背着人改用户正在打的字,且普通列表
// 从此每次都要退格。续行与快捷键是用户主动按出来的,性质不同(用户 2026-09-01 拍板)。
// ---------------------------------------------------------------------------

/** 一次文本框改写的结果:新正文 + 新选区。调用方原样写回 textarea,别再自己算位置。 */
export type ChecklistEdit = {
  value: string;
  selStart: number;
  selEnd: number;
};

/** 未勾的标记,含尾随那个空格 —— 插入的永远是它(新写的一项当然还没做)。 */
const MARK = "- [ ] ";

/** 一级缩进 = 两个空格(用户 2026-09-05 拍板)。
 *
 *  ⛔ **插空格不插制表符**:画的那半按**字符数**算缩进(`--ck-indent`,一字符 = 1em),
 *  一个制表符在那儿只算一级、与一个空格同宽,可它在输入框里显示成一大格 —— 编辑时看见
 *  的缩进与存下来看见的对不上。 */
const INDENT = "  ";

/** `pos` 所在那一行在 `value` 里的 [起, 止)(止 = 行尾换行符之前)。
 *
 *  ⚠ `pos === 0` 必须短路:`lastIndexOf` 的负 fromIndex 会被夹回 0,于是首字符正好是
 *  换行时它会答 0、把行首算到 1 去。 */
function lineBoundsAt(value: string, pos: number): [number, number] {
  const start = pos === 0 ? 0 : value.lastIndexOf("\n", pos - 1) + 1;
  const nl = value.indexOf("\n", pos);
  return [start, nl === -1 ? value.length : nl];
}

/** 行首那截缩进(空格 / 制表符)。 */
function leadingIndent(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/** 单行改写之后拿新选区端点的算子:随该行长度变化平移,并夹在**这一行之内**。
 *
 *  ⛔ 下限是**本行行首**(`ls`)不是 0 —— 用 0 的话,光标本来就在标记里(或缩进里)时,
 *  一记摘标记 / 反缩进会把它甩到上一行去。⚠ 两处单行分支(起一条 / 缩进)共用这一份:
 *  各留一份的话,阴性对照那把刀只砍得到先出现的那一处,另一处就无声无息了。 */
function lineClamp(ls: number, lineLen: number, delta: number): (x: number) => number {
  return (x) => Math.min(ls + lineLen, Math.max(ls, x + delta));
}

/** 按下「换行那一记」(桌面 = Shift+Enter,安卓 = 软键盘回车)时的续行。
 *
 *  当前行是待办项 ⇒ 换行并带出**同缩进**的 `- [ ] `,写清单时第二项起完全不用动手;
 *  当前行是个**空的**待办项(标记后没有非空白)⇒ 把整行抹平、**不插新行** = 退出清单,
 *  和各家编辑器一个手势。别的情况返回 `null`,调用方**放行默认换行**。
 *
 *  两处刻意不接管:
 *  - 选区没折叠(选中了一段再按)—— 那一记的语义是「用换行替换掉选中的」,不是续行;
 *  - 光标还在标记里头(`- [| ] x`)—— 接管会把标记劈成两半,那不是任何人想要的。 */
export function continueChecklistOnNewline(
  value: string,
  selStart: number,
  selEnd: number,
): ChecklistEdit | null {
  if (selStart !== selEnd) return null;
  const [ls, le] = lineBoundsAt(value, selStart);
  const parsed = parseChecklistLine(value.slice(ls, le));
  if (parsed === null) return null;
  if (parsed.rest.trim() === "") {
    // 空项 = 退出清单:连缩进一起抹掉,光标落在原行首。⛔ 别只删标记留下缩进——
    // 那样下一行看着是空的、实则挂着几个空格,写回去就是正文里的一行空白噪音。
    return { value: value.slice(0, ls) + value.slice(le), selStart: ls, selEnd: ls };
  }
  // 非空项时 rest 必以空白开头(LINE_RE 保证),故正文起点 = 缩进 + `- [x]` + 那个空白。
  if (selStart < ls + parsed.indent.length + MARK.length) return null;
  const ins = `\n${parsed.indent}${MARK}`;
  const at = selStart + ins.length;
  return { value: value.slice(0, selStart) + ins + value.slice(selStart), selStart: at, selEnd: at };
}

/** 快捷键 / 按钮:把选中的那一行(或那几行)变成待办项,再按一次摘掉。
 *
 *  **方向看整块**:只要还有一行不是待办项就**整块都加**,全是了才**整块都摘** —— 只看
 *  第一行的话,混排的几行来回按两次会被洗成不可预期的样子。
 *
 *  ⚠ 多行选区里的**空行原样留着**(不长出空待办项),单行时即便空也照加 —— 那正是
 *  「我要在这儿起一条」。摘标记只去掉标记与它后面那**一个**空白,别的原文一字不动。 */
export function toggleChecklistMarker(value: string, selStart: number, selEnd: number): ChecklistEdit {
  const [ls] = lineBoundsAt(value, selStart);
  const [, le] = lineBoundsAt(value, selEnd);
  const lines = value.slice(ls, le).split("\n");
  const multi = lines.length > 1;
  const judged = multi ? lines.filter((l) => l.trim() !== "") : lines;
  const add = judged.some((l) => parseChecklistLine(l) === null);
  const out = lines.map((l) => {
    if (multi && l.trim() === "") return l;
    const p = parseChecklistLine(l);
    if (add) {
      if (p !== null) return l;
      const ind = leadingIndent(l);
      return `${ind}${MARK}${l.slice(ind.length)}`;
    }
    if (p === null) return l;
    return `${p.indent}${p.rest.replace(/^\s/, "")}`;
  });
  const block = out.join("\n");
  const next = value.slice(0, ls) + block + value.slice(le);
  if (multi) {
    // 跨行:选区盖住改写后的整块(通行做法——用户选了这几行,改完还该是这几行)。
    return { value: next, selStart: ls, selEnd: ls + block.length };
  }
  // 单行:选区两端随该行长度变化平移,并夹在这一行之内(光标本来就在标记里时不许跑出去)。
  const clamp = lineClamp(ls, out[0].length, out[0].length - lines[0].length);
  return { value: next, selStart: clamp(selStart), selEnd: clamp(selEnd) };
}

/** 反缩进时该从行首削掉几个字符:一级封顶,但绝不越过实有的那点缩进。
 *
 *  ⚠ 按**字符**削,不按「一个制表符 = 一级」削 —— 画的那半就是按字符数算的,且用户手打
 *  的缩进常常只有一个空格,那时该削的就是那一个。 */
function outdentWidth(line: string): number {
  return Math.min(INDENT.length, leadingIndent(line).length);
}

/** Tab(`deeper` = true)/ Shift+Tab(false):把光标那一行(或选中的那几行)推进一级 /
 *  退回一级。缩进本来就是待办清单的一等公民(画的那半把它化成整行左内边距、续行还会带出
 *  同缩进),此前唯独没有「怎么起一级」那记手势 —— 只能自己把光标挪到行首手敲空格。
 *
 *  ⭐ **判据窄到「涉及的那几行里至少有一行是待办项」**,别的一概返回 `null` 让浏览器照旧
 *  把焦点移走 —— Tab 是键盘用户离开输入框的**唯一通路**,无条件接管 = 把人关在框里。
 *  ⭐ **一个字都没变也返回 `null`**(反缩进时已经顶格),那一记同样还给焦点。
 *
 *  接管之后选区跨几行就动几行,⚠ 空行原样留着(同 `toggleChecklistMarker`:给空行加两个
 *  空格 = 正文里一行看不见的噪音)。⛔ 缩进不设上限:设了就得在某一级上「按了没反应」,
 *  那是静默默认值;推过头看得见,Shift+Tab 退回来就是。 */
export function indentChecklistLines(
  value: string,
  selStart: number,
  selEnd: number,
  deeper: boolean,
): ChecklistEdit | null {
  const [ls] = lineBoundsAt(value, selStart);
  const [, le] = lineBoundsAt(value, selEnd);
  const lines = value.slice(ls, le).split("\n");
  if (!lines.some((l) => parseChecklistLine(l) !== null)) return null;
  const out = lines.map((l) => {
    if (l.trim() === "") return l;
    return deeper ? INDENT + l : l.slice(outdentWidth(l));
  });
  if (out.every((l, i) => l === lines[i])) return null;
  const block = out.join("\n");
  const next = value.slice(0, ls) + block + value.slice(le);
  if (lines.length > 1) {
    // 跨行:选区盖住改写后的整块(同 toggleChecklistMarker —— 用户选了这几行,改完还该是这几行)。
    return { value: next, selStart: ls, selEnd: ls + block.length };
  }
  // 单行:选区两端随该行长度变化平移,并夹在这一行之内(反缩进不许把光标甩到上一行去)。
  const clamp = lineClamp(ls, out[0].length, out[0].length - lines[0].length);
  return { value: next, selStart: clamp(selStart), selEnd: clamp(selEnd) };
}

/** 一段「把 [from, to) 换成 text」的改写。 */
export type EditRange = { from: number; to: number; text: string };

/** 老文本 → 新文本之间那一段真正变了的区间(共同前缀 / 共同后缀之外的部分)。
 *
 *  ⭐ **接线层落笔靠它**:上面两个函数为了好测好对拍,答的是「整份新正文」,而直接
 *  `ta.value = 新正文` 会把浏览器的撤销栈整个清掉 —— 连用户此前手打的字都 Ctrl+Z 不
 *  回来。改成「选中这一段、往里插」(`execCommand`)就还在撤销栈上,与手打无异。 */
export function minimalEditRange(before: string, after: string): EditRange {
  let p = 0;
  while (p < before.length && p < after.length && before[p] === after[p]) p++;
  let s = 0;
  while (
    s < before.length - p &&
    s < after.length - p &&
    before[before.length - 1 - s] === after[after.length - 1 - s]
  ) {
    s++;
  }
  return { from: p, to: before.length - s, text: after.slice(p, after.length - s) };
}
