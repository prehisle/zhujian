// Shared "textarea grows to fit its content" — one implementation for every
// in-list entry point (看板新建/编辑、灵感记下/编辑;捕获浮窗 grows the WINDOW too, so
// it keeps its own fitWindow in main.ts). Call on every `input` event, and once
// right after the textarea is CONNECTED to the DOM — a detached node measures 0
// and would collapse the box (see board.ts requestEdit's queueMicrotask note).
export function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  // With box-sizing:border-box, scrollHeight is content+padding (no border), so a
  // bare height=scrollHeight is short by the border and `overflow-y:auto` shows a
  // spurious scrollbar. Add the border (offsetHeight − clientHeight) so the box
  // fits its content exactly.
  const border = ta.offsetHeight - ta.clientHeight;
  const full = ta.scrollHeight + border;
  // CSS max-height caps each box (none = grow freely); only past the cap is an
  // inner scrollbar wanted. Below it, grow to fit exactly and keep overflow hidden
  // so fractional line-height rounding never leaves a spurious 1px scroll gutter.
  const cap = parseFloat(getComputedStyle(ta).maxHeight) || Infinity;
  ta.style.height = `${Math.min(full, cap)}px`;
  ta.style.overflowY = full > cap ? "auto" : "hidden";
  // 第二遍:长高本身会改变宽度 —— 框一长,外层可滚容器(看板列体 / 灵感列表)冒出滚动条、
  // 把框挤窄一截,原本刚好放得下的一行就折了,第一遍量出的高度少一行,而 overflow 已是
  // hidden ⇒ 最后一行被裁掉(568 判例:20 行正文量出 464、真需要 487)。宽度只会因此变
  // 一次,所以再量一遍即收敛;封顶的框已经在滚了,不用补。
  if (full <= cap && ta.scrollHeight > ta.clientHeight) {
    const full2 = ta.scrollHeight + border;
    ta.style.height = `${Math.min(full2, cap)}px`;
    ta.style.overflowY = full2 > cap ? "auto" : "hidden";
  }
}
