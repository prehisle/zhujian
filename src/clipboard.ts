// A reusable 复制 action, shared by the idea cards (灵感) and the task cards
// (任务看板) — one source of truth for "quick copy". The webview runs in a
// secure context (tauri.localhost in release, localhost in dev), so the async
// Clipboard API is available; a write failure surfaces on the label (复制失败)
// rather than being swallowed.

/** Copy `text` to the clipboard from a click. Fail-fast: a rejected write throws,
 *  so callers wrap it for their own feedback. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** A self-contained 复制 pill: on click it copies `text` and briefly flashes 已复制
 *  (or 复制失败), then reverts. `className` lets each view style it as its own action
 *  pill; `label` is the idle text (defaults to 复制, but a column copy uses 复制 Markdown
 *  etc.). stopPropagation keeps the click from reaching a draggable parent card. */
export function copyButton(text: string, className: string, label = "复制"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  let revert: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await copyText(text);
      btn.textContent = "已复制";
    } catch {
      btn.textContent = "复制失败";
    }
    clearTimeout(revert);
    revert = setTimeout(() => {
      btn.textContent = label;
    }, 1200);
  });
  return btn;
}
