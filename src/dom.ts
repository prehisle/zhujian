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
