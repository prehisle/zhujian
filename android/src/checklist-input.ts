// 待办清单的快速输入 —— 安卓那半的接线(562)。纯逻辑在 `checklist.ts`(与桌面逐字
// 对应的那份),这里只管「哪一记触发」与「怎么落笔」。
//
// **与桌面刻意不同的两处**(不是漂移,是这一端本来就没有那两样东西):
// - **续行挂在裸回车**:桌面五个入口的 Enter 都是「提交」、Shift+Enter 才是换行;手机上
//   软键盘的回车本来就只是换行(提交靠「记下」/「保存」钮),所以那一记就是续行那记。
// - **起一条靠按钮不靠快捷键**:手机没有 Ctrl。compose 行与卡片编辑态各摆一枚「＋ 待办」。
//
// ⛔ **落笔走 `execCommand` 不走 `ta.value = …`**(同桌面那份):后者会清空 WebView 的
// 撤销栈,连用户此前手打的字都撤不回来。由此也不必手动派发 `input` —— execCommand 自己
// 发,compose 的草稿持久化与卡片面板的 `state.editDraft` 回写照常跟上。

import {
  continueChecklistOnNewline,
  minimalEditRange,
  toggleChecklistMarker,
  type ChecklistEdit,
} from "./checklist";

/** 把纯逻辑算出的整份新正文落到框里,只改真正变了的那一段(撤销栈得以保留)。 */
function applyEdit(ta: HTMLTextAreaElement, edit: ChecklistEdit): void {
  const { from, to, text } = minimalEditRange(ta.value, edit.value);
  ta.setSelectionRange(from, to);
  if (text === "") document.execCommand("delete");
  else document.execCommand("insertText", false, text);
  ta.setSelectionRange(edit.selStart, edit.selEnd);
}

/** 回车续行:当前行是待办项就带出下一项,空项上再按一次退出清单;别的情况放行默认换行。 */
function onNewline(ta: HTMLTextAreaElement, e: KeyboardEvent): void {
  if (e.isComposing) return; // IME 组合期的回车是上屏,不是换行
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
  const edit = continueChecklistOnNewline(ta.value, ta.selectionStart, ta.selectionEnd);
  if (edit === null) return;
  e.preventDefault();
  applyEdit(ta, edit);
}

/** 静态输入框(compose 那个 `#text`)直接接。 */
export function wireChecklistNewline(ta: HTMLTextAreaElement): void {
  ta.addEventListener("keydown", (e) => onNewline(ta, e));
}

/** 委托形:卡片操作面板的编辑框每次重画都是新节点,只能在容器上认 `sel`。 */
export function delegateChecklistNewline(root: HTMLElement, sel: string): void {
  root.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLTextAreaElement && t.matches(sel)) onNewline(t, e);
  });
}

/** 「＋ 待办」那一按:把光标那一行(或选中的几行)变成待办项,再按一次摘掉。
 *
 *  ⚠ 调用方须在 **mousedown** 上 `preventDefault` 拦掉焦点转移(同 capture-commands 的
 *  手法),否则按下去的那一刻框已失焦、`execCommand` 落不到它身上;这里再 `focus()` 一次
 *  兜住「框本来就没焦点」(刚开面板还没点过输入框)那种局面。 */
export function applyChecklistMarker(ta: HTMLTextAreaElement): void {
  if (document.activeElement !== ta) ta.focus();
  applyEdit(ta, toggleChecklistMarker(ta.value, ta.selectionStart, ta.selectionEnd));
}
