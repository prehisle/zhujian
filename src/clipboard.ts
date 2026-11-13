// A reusable 复制 action, shared by the idea cards (灵感) and the task cards
// (任务看板) — one source of truth for "quick copy". The webview runs in a
// secure context (tauri.localhost in release, localhost in dev), so the async
// Clipboard API is available; a write failure surfaces on the label (复制失败)
// rather than being swallowed.

import { t } from "./i18n";
import { errDetail } from "./err";
import { toastError } from "./toast";

/** 复制失败的全句「复制失败:{原因}」(902 F3):原因走 `errDetail`,系统给的原话原样带上。
 *  所有复制入口(钮 / 菜单 / 单键 / 右键 / 看大图)共用这一句,⛔ 别再各立一个不带原因的键。 */
export function copyFailText(e: unknown): string {
  return t("clipboard.copyFail", { err: errDetail(e) });
}

/** 报一次复制失败:屏底一条错误提示条说全句;返回给窄位置(钮上 / 菜单行里)闪的那句短的。 */
export function copyFailed(e: unknown): string {
  toastError(copyFailText(e));
  return t("clipboard.copyFailShort");
}

/** Copy `text` to the clipboard from a click. Fail-fast: a rejected write throws,
 *  so callers wrap it for their own feedback. */
export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** A self-contained 复制 pill: on click it copies `text` and briefly flashes 已复制
 *  (or 复制失败 — 同时屏底一条带原因的全句), then reverts. `className` lets each view style it as its own action
 *  pill; `label` is the idle text (defaults to 复制, but a column copy uses 复制 Markdown
 *  etc.). stopPropagation keeps the click from reaching a draggable parent card.
 *  `text` may be a getter when the content is only known at click time (设置「关于」的诊断信息). */
export function copyButton(text: string | (() => string), className: string, label = t("clipboard.copy")): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.textContent = label;
  let revert: ReturnType<typeof setTimeout> | undefined;
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await copyText(typeof text === "string" ? text : text());
      btn.textContent = t("clipboard.copied");
    } catch (err) {
      btn.textContent = copyFailed(err); // 钮上闪短的,全句(带原因)走屏底那条
    }
    clearTimeout(revert);
    revert = setTimeout(() => {
      btn.textContent = label;
    }, 1200);
  });
  return btn;
}
