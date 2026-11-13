// 拼 DOM 的两枚小助手 —— 607 审计前它们在 14 个模块里各抄一份(11 份 `el(tag, props, children)`
// 逐字相同、3 份 `el(tag, cls, text)` + `btn` 逐字相同),改一次签名要改 14 处;安卓端早收在
// `android/src/ui.ts` 一处。这里只是去重,不是抽象层(why-no-framework:拼 DOM 是一次性消耗品,
// 别把它做"可移植");⛔ 别往这里长出第三种形 —— 两种够用,新模块挑一种 import。
import { isTabKey } from "./keys";

/** 建节点:`props` 直接 `Object.assign` 到元素上,`children` 逐个 `append`。 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

/** 建节点的"类名 + 文本"短形(devices / sync / update 三个面板在用,那边 `import { elText as el }`)。 */
export function elText<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

export function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = elText("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

/** 把一个元素接成原生拖放的落点:`dragenter` 与 `dragover` 挂**同一个**处理器(里面该 preventDefault
 *  的照旧由它自己判)。⛔ 只接 dragover 不够 —— 引擎每次指针**跨进一个新元素**(卡片标题、chip、
 *  日期…)那一拍只发 dragenter、不发 dragover,而那一拍有没有 preventDefault 就是引擎回给系统的
 *  「可不可放」;要到下一次鼠标移动的 dragover 才再答一遍。⇒ 每跨一个元素就有一拍「不可放」,
 *  松手恰好落在那一拍(最后一次移动正好是跨界那一下、或长列自动滚动时卡片在指针下面滑过)=
 *  系统按取消收场、卡片弹回原位(666,用户报「拖到别的列有时会退回来」;CDP 驱动引擎实测:
 *  跨进新元素那一拍确实只有一枚未被取消的 dragenter,而最后一拍未取消时 drop 根本不派发)。 */
export function onDragTarget(target: HTMLElement, handler: (e: DragEvent) => void): void {
  target.addEventListener("dragenter", handler);
  target.addEventListener("dragover", handler);
}

// ---- 模态面板的 Tab 圈闭(ui-guidelines §3.5;158 起「管理列」面板第一个用)----
// ⭐ 共享件:§3.5 那条「修就一起修,别只给新面板单独发明一套」—— 下一个要圈闭的面板(留言浮层 /
// 放大编辑)直接挂这一只:`panel.addEventListener("keydown", (e) => trapTab(panel, e))`;要整套「接管键盘」
// (焦点进 / 圈住 / 背后按不到 / 关掉还焦)的浮层用下面的 `holdKeyboard`(W4 起设置、同步、关窗那一问在用)。

/** 面板里此刻能拿焦点的控件(按 DOM 序;禁用的、没渲染的不算)。 */
export function focusables(panel: HTMLElement): HTMLElement[] {
  return [...panel.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(
    (n) => !(n as HTMLButtonElement).disabled && n.offsetParent !== null,
  );
}

// ---- 浮层接管键盘(ui-guidelines §3.5;W4 A3,WD-04 / 新撞-4)----
// 设置浮层与同步浮层此前不接管键盘:打开后焦点还在侧栏那枚钮上,Tab 一路走到背后被模糊掉的按钮,
// 回车把背后的页面切走、按在窗口「关闭」上整只主窗藏进托盘;✕ / 点外面关掉后焦点掉到 body。
// ⭐ 两只面板共用这一只(§3.5「修就一起修」):
//   ① 打开:记下此刻的焦点(= 打开它的那枚钮),焦点放进浮层;
//   ② Tab / Shift+Tab 圈在面板里(document **捕获相**:焦点掉到 body —— 面板重画把聚焦的钮换掉了 ——
//      时也接得住,同「管理列」那只的判例);叠着两层时只有最上面那层圈;
//   ③ 浮层里按下的键**不冒到 document**:背后视图的单键 / 卡片键 / Ctrl+F / Ctrl+B 都挂在 document 上。
//      只 stopPropagation、不 preventDefault ⇒ 钮上的回车 / 空格照旧是点击、框里照旧打字;
//      面板自己框里的键处理挂在框上,先于这里跑(别名框的 Esc 只放弃编辑那条照旧)。
//      放行一种:Ctrl + / Ctrl - / Ctrl 0 —— 管的是整窗字号,不是背后某一页(设置里那行就叫人这么按);
//   ④ Esc 交给面板自己的 `onEscape`(各有条件:录制中不关 / 叠着别的层);
//   ⑤ 收:摘监听,焦点还给打开它的那枚(它还在文档里的话)。
// ⛔ 别让 overlay 自己拿焦点(tabindex):焦点落在面板外的遮罩上,Tab 圈闭的「不在面板里」判据就失灵了。

const ZOOM_CODES = new Set(["Equal", "NumpadAdd", "Minus", "NumpadSubtract", "Digit0", "Numpad0"]);
const holders: HTMLElement[] = [];

export type KeyboardHold = { release(restoreFocus?: boolean): void };

export function holdKeyboard(
  overlay: HTMLElement,
  panel: HTMLElement,
  opts: { onEscape: (e: KeyboardEvent) => void; focus?: HTMLElement | null },
): KeyboardHold {
  const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  holders.push(panel);
  const onTab = (e: KeyboardEvent): void => {
    if (holders[holders.length - 1] !== panel) return;
    trapTab(panel, e);
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      opts.onEscape(e);
      return;
    }
    if (e.ctrlKey && !e.altKey && !e.metaKey && ZOOM_CODES.has(e.code)) return;
    e.stopPropagation();
  };
  document.addEventListener("keydown", onTab, true);
  overlay.addEventListener("keydown", onKey);
  (opts.focus ?? focusables(panel)[0])?.focus();
  let released = false;
  return {
    release(restoreFocus = true) {
      if (released) return;
      released = true;
      document.removeEventListener("keydown", onTab, true);
      overlay.removeEventListener("keydown", onKey);
      const i = holders.lastIndexOf(panel);
      if (i >= 0) holders.splice(i, 1);
      if (restoreFocus && returnTo?.isConnected) returnTo.focus();
    },
  };
}

/** 一排就地展开的选项(看板卡的优先级 高 / 中 / 低 / 清除、颜色 1–7 / 无色):焦点进来后 ← → ↑ ↓ 在这一排里挪
 *  (到头绕回)。⚠ 吞掉这四枚键(stopPropagation):document 上的卡片控制器拿方向键挪「选中」,
 *  不截的话按一下 → 选中跑去隔壁那张、这一排晾在原地(W5 A39)。 */
export function arrowWalk(row: HTMLElement): void {
  row.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (d === 0) return;
    const list = focusables(row);
    if (list.length === 0) return;
    e.preventDefault();
    e.stopPropagation();
    const at = list.indexOf(document.activeElement as HTMLElement);
    list[(at < 0 ? 0 : at + d + list.length) % list.length].focus();
  });
}

/** Tab / Shift+Tab 到头就绕回另一头,焦点不出面板。判 Tab 走 `isTabKey`(WebKitGTK 上 Shift+Tab 的
 *  `e.key` 是 "Unidentified",那条判据只此一份,见 keys.ts)。 */
export function trapTab(panel: HTMLElement, e: KeyboardEvent): void {
  if (!isTabKey(e) || e.ctrlKey || e.altKey || e.metaKey) return;
  const list = focusables(panel);
  if (list.length === 0) return;
  const first = list[0];
  const last = list[list.length - 1];
  const at = document.activeElement;
  if (e.shiftKey && (at === first || !panel.contains(at))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (at === last || !panel.contains(at))) {
    e.preventDefault();
    first.focus();
  }
}
