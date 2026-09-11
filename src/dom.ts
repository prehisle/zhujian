// 拼 DOM 的两枚小助手 —— 607 审计前它们在 14 个模块里各抄一份(11 份 `el(tag, props, children)`
// 逐字相同、3 份 `el(tag, cls, text)` + `btn` 逐字相同),改一次签名要改 14 处;安卓端早收在
// `android/src/ui.ts` 一处。这里只是去重,不是抽象层(why-no-framework:拼 DOM 是一次性消耗品,
// 别把它做"可移植");⛔ 别往这里长出第三种形 —— 两种够用,新模块挑一种 import。

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
