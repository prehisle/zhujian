// 看板(宽屏任务面)的滚动宿主(889 立)。889 起看板**列自己竖着滚、看板横着滚**,不再是整页滚(index.html「看板」那段头注;
// 用户在手机横放上报「执行中找不到、一划两列一起动」后选择题改判)。凡是「把某张卡 / 操作面滚进视野」「卡在不在屏上」的地方,
// 先问它住在哪个滚动盒里:看板上是它那一列(`#timeline > .tl-group`),别处(手机竖放、随记、各面)照旧是整页。
// ⛔ 别在调用处各自 `el.closest(".tl-group")`:手机竖放的节也是 `.tl-group`,可那时它不滚 —— 判据是 `body.board`,只住这里。

/** 屏上现在是不是看板(= 任务面 ∧ 宽屏;那枚类只由 main.ts::projectTimeline 写)。 */
export const onBoard = (): boolean => document.body.classList.contains("board");

/** el 所在的那一列(看板上);不是看板 / 不在列里 = null(= 整页滚)。 */
export function columnOf(el: Element): HTMLElement | null {
  return onBoard() ? el.closest<HTMLElement>("#timeline > .tl-group") : null;
}

export type Box = { top: number; bottom: number; left: number; right: number };

/** 一列里看得见的那一框(视口坐标):列盒扣掉吸顶的列头;横向再与看板本身露在屏上的那截取交(列可能一半在屏外)。 */
export function columnView(col: HTMLElement): Box {
  const r = col.getBoundingClientRect();
  const tl = col.parentElement!.getBoundingClientRect();
  const head = col.querySelector(":scope > .tl-sec")?.getBoundingClientRect().height ?? 0;
  return { top: r.top + head, bottom: r.bottom, left: Math.max(r.left, tl.left), right: Math.min(r.right, tl.right) };
}

/** 把 el 所在的滚动盒竖着推 dy(正 = 内容往上走,同 `window.scrollBy(0, dy)`)。 */
export function scrollByFor(el: Element, dy: number): void {
  const col = columnOf(el);
  if (col) col.scrollTop += dy;
  else window.scrollBy(0, dy);
}

// ---- 重画 / 开关面板不丢位置 --------------------------------------------------------------
// projectTimeline 每次都整片重建 #timeline(同步、刷新、挪卡之后都会)⇒ 新画的列从 0 滚起;开面板时 #timeline 是
// display:none,列的滚动位置也跟着没了。整页滚那会儿没这个问题(window 的 scrollY 不随 DOM 重建清零)。
// ⇒ 一直记着(#timeline 上一只**捕获阶段**的 scroll 监听 —— 元素的 scroll 不冒泡,捕获收得到),重画 / 关面之后摆回去。
// 按空间记:换了空间作废(列是那个空间的)。只记看板上的;窄屏的节不滚,收不到事件。
let mem: { space: string; left: number; tops: Map<string, number> } = { space: "", left: 0, tops: new Map() };
let spaceOf: () => string = () => "";

export function initBoardScroll(getCurrentSpace: () => string): void {
  spaceOf = getCurrentSpace;
  const tl = document.getElementById("timeline")!;
  tl.addEventListener(
    "scroll",
    (e) => {
      if (!onBoard()) return;
      const space = spaceOf();
      if (mem.space !== space) mem = { space, left: 0, tops: new Map() };
      const el = e.target as HTMLElement;
      if (el === tl) mem.left = tl.scrollLeft;
      else if (el.parentElement === tl && el.dataset.col !== undefined) mem.tops.set(el.dataset.col, el.scrollTop);
    },
    { capture: true, passive: true },
  );
}

/** 把记着的横滚与各列竖滚摆回去(重画之后、关面之后各调一次;不是看板 / 换了空间就什么都不做)。 */
export function restoreBoardScroll(): void {
  if (!onBoard() || mem.space !== spaceOf()) return;
  const tl = document.getElementById("timeline")!;
  for (const col of tl.querySelectorAll<HTMLElement>(":scope > .tl-group[data-col]")) {
    const y = mem.tops.get(col.dataset.col!);
    if (y !== undefined && col.scrollTop !== y) col.scrollTop = y;
  }
  if (tl.scrollLeft !== mem.left) tl.scrollLeft = mem.left;
}
