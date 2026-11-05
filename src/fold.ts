// 长卡折叠的两件共用件(704 立在看板;157 G4 / P13 起随记页同用一份,从 board.ts 搬来,逐字未改)。

/** 溢出不到半行就不算「夹到了」(704)。⭐ 判据不是洁癖:正文尾巴上一个换行符就能多出一个
 *  空行盒,为它长一枚「展开」= 点开什么也没有;而**没夹住就整张摊开**(settleFolds 当场摘夹子)
 *  ⇒ 放宽这个数只会让边界上那几张多显半行,⛔ 绝不会把字悄悄裁掉。半行 ≈ 11px(--fs-15 × 1.5 ÷ 2);
 *  界面字号那四档是整窗缩放、不改 CSS 像素,故这里写 px 是稳的。 */
export const FOLD_SLACK_PX = 11;

/** 夹住之后,有没有**还没勾**的方框落在褶子下面 —— 长卡折叠的豁免判据(704)。
 *
 *  ⭐ **量的是夹后几何,不是「这条正文里有没有框」**:豁免的理由只有一个「褶子下面的框点不到」,
 *  ⇒ 框全在前 8 行的卡(清单在开头、后面拖着一长段记录)**该照折** —— 框照样点得到,而那正是
 *  最该折的一种卡(704 的截图逮到的:第一版按「有没有框」豁免,一张 20 行的清单卡把整列占满)。
 *  ⛔ 别改回按行数猜:正文里一行可能渲染成两行(列宽有下限),谁在褶子下面只有落 DOM 后量得出。
 *  判据取**方框自己的底边**越过夹线(不是整行):框在行首,行尾被切掉不影响它点不点得到。
 *  只数**点得动的**框(`:not(:disabled)`,W3 159 / A16):回收站里的卡 159 起也折,那儿的方框是只读的
 *  (`renderContent` 不给 onToggle 就画成 disabled)—— 本来就点不了,「点不到」这条理由不成立,别据它放行。 */
export function hasBoxBelowFold(body: HTMLElement): boolean {
  const line = body.getBoundingClientRect().bottom;
  return [...body.querySelectorAll<HTMLElement>(".ckline:not(.on) .ckbox:not(:disabled)")].some(
    (b) => b.getBoundingClientRect().bottom > line,
  );
}

/** 只读预览里的长条折叠(W3 159 / A16:搜索结果、标签页展开那两处此前整段摊开、一条占满一屏)。
 *  与随记 / 看板同一个八行上限(各视图的 CSS 里写 `.clamped` 的 max-height)、同一套「先一律夹住、
 *  落 DOM 后量一次」:`root` 下凡带 `.clamped` 的 `sel` 元素,没真夹到东西的当场摘夹子(与没有这功能时
 *  逐字同形、也不长钮),真夹到的后面补一枚「展开 ▾ / 收起 ▴」。读写分两趟(先量完再改)。
 *  ⚠ 与 inbox / board 那两份的差别是**刻意的**:①不记展开态 —— 这两处每次重画都是一次新的浏览,
 *  「读一眼」不是模式(704 那条「展开态只活一次挂载」的更窄一档);②没有方框豁免 —— 只读预览里的
 *  方框本来就点不了(`disabled`),豁免的理由「褶子下面的框点不到」在这里不成立。
 *  钮挂在可点的结果卡里:点击与回车都**截住冒泡**,别让「展开」顺手把人带去跳转。 */
export function settlePreviewFolds(root: ParentNode, sel: string, labels: { fold: string; unfold: string }): void {
  // 量过的打个记号:同一棵树可能被量两趟(标签页点开一行当场量一次、整表重画再统一量一次),
  // 第二趟别再给同一条补第二枚钮。
  const bodies = [...root.querySelectorAll<HTMLElement>(sel)].filter((p) => p.classList.contains("clamped") && !p.dataset.foldSettled);
  const over = bodies.map((p) => p.scrollHeight > p.clientHeight + FOLD_SLACK_PX);
  bodies.forEach((p, i) => {
    p.dataset.foldSettled = "1";
    if (!over[i]) {
      p.classList.remove("clamped");
      return;
    }
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fold-toggle";
    const paint = (): void => {
      const folded = p.classList.contains("clamped");
      b.textContent = folded ? `${labels.unfold} ▾` : `${labels.fold} ▴`;
      b.setAttribute("aria-expanded", String(!folded));
    };
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      p.classList.toggle("clamped");
      paint();
    });
    b.addEventListener("keydown", (e) => e.stopPropagation()); // 回车 / 空格只归这枚钮,别冒到卡上的「跳过去」
    paint();
    p.after(b);
  });
}
