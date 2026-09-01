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
