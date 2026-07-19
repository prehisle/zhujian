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
}
