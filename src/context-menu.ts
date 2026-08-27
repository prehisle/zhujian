// 505:卡片**以外**的右键也归应用管。
//
// 504 只接管了卡片上的右键(`hotkey-menu.ts` 那条路 = 给已有的 ⋯ 菜单加第二个开门方式)。
// 挪开一寸——列空白 / 看板背景 / 侧栏 / 标签视图——弹的仍是 WebView2 那份「返回 · 刷新 ·
// 另存为 · 打印 · 检查」。三件事都不对:在桌面应用里这五项是穿帮;**「刷新」点下去是重载
// 整个 app**;而 504 之后割裂感反倒更明显(卡片上是应用菜单,旁边一寸是浏览器菜单)。
//
// ⛔ **v1 只做「不弹浏览器那份」,不新造动作表**。列空白 / 列头的自定义右键菜单(「在这一
// 列新建任务」「管理列」之类)是另一件事、成本高一档,用户没提过。
//
// ⛔ **别做成「全局一律禁用右键」**:输入框的**粘贴**是刚需(配图那条路正是粘贴)、选中文字
// 的复制也是。让位判据不是装饰,拿掉哪一条都是负优化。

/** 右键必须让给浏览器原生菜单的落点。**卡片那条路(504)与文档这条路(505)同读这一份**,
 *  ⇒ 「哪儿该让位」只有一个定义,不会两条路各自漂移。
 *  - `input` / `textarea` / `[contenteditable]`:编辑态右键要**粘贴**;
 *  - `a` / `img`:各自已有右键约定(`item-images.ts` 的「右键复制链接」就在 `a` 上)。 */
export const NATIVE_MENU_KEEP = "input, textarea, [contenteditable='true'], a, img";

/** 右键点在选中的文字上 = 用户正想复制那段字,让位。
 *
 *  两个方向都算「点在选区上」:选区的祖先套着落点(点在选中的那段字里面),或落点套着选区
 *  (点在包着选区的容器上)。⚠ 选区落在**单个文本节点**里时 `commonAncestorContainer` 就是
 *  那个文本节点,而 `Node.contains(元素)` 对它恒 false ⇒ 必须先抬到元素父级再比,否则这条
 *  判据在最常见的那种选区上直接失效。 */
export function rightClickOnSelection(target: Element): boolean {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const anc = sel.getRangeAt(0).commonAncestorContainer;
  const ancEl = anc.nodeType === Node.ELEMENT_NODE ? (anc as Element) : anc.parentElement;
  return !!ancEl && (ancEl.contains(target) || target.contains(ancEl));
}

/** 文档级接管。**两个窗口壳(notebook + capture)各调一次**,启动时一次,不卸载。 */
export function armAppContextMenu(): void {
  document.addEventListener("contextmenu", (e) => {
    // ⛔ **卡片子树整个交给 504 那条路**,这里一个字都别再判。它 `preventDefault` 了就是
    // 接管了(菜单已经开出来);它**没有** `preventDefault` 就是**它决定让位**(编辑态 /
    // 卡内有选区 / 行内确认中)。在这里重判一遍会两义,更糟的是会把它刚让出去的那次右键
    // **吞掉** —— 用户什么菜单都拿不到,比改之前还差。
    if (e.defaultPrevented) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && (target.closest(".hk-host") || target.closest(NATIVE_MENU_KEEP))) return;
    if (target && rightClickOnSelection(target)) return;
    e.preventDefault();
  });
}
