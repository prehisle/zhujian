// 待办清单的快速输入 —— 桌面那半的接线(562)。纯逻辑在 `checklist.ts`,这里只管
// 「哪一记按键触发」与「怎么落笔」。
//
// **两记手势**(五个正文输入口全都接同一份,⛔ 别在某个入口另接一套):
// - **Shift+Enter**:当前行是待办项时续行、带出同缩进的 `- [ ] `;空项上再按一次退出清单。
//   ⚠ 挑 Shift+Enter 不是随意的 —— 五个入口的裸 Enter **都是「提交」**(捕获浮窗、两个
//   compose、灵感卡编辑态、看板卡 inline rename),Shift+Enter 才是那一记「换行」。
// - **Ctrl+L**:把光标那一行(或选中的几行)变成待办项,再按一次摘掉。⚠ 键位是核过的:
//   桌面已占的是 Ctrl+V 粘图 / Ctrl+C 复制图 / Ctrl+B 侧栏 / Ctrl+±/0 缩放 / 两枚可改的
//   全局热键(Ctrl+Alt+N、Ctrl+Alt+M),L 空着;卡片与视图的单键(L = 标签)带修饰键时
//   本来就让位(hotkey-menu / registerViewKeys 开头就 `if (ctrlKey||metaKey||altKey) return`)。
//
// ⛔ **落笔走 `execCommand` 不走 `ta.value = …`**:后者会清空浏览器撤销栈,连用户此前
// 手打的字都 Ctrl+Z 不回来 —— 一个「编辑器辅助」把用户已有的撤销历史吃掉是不能接受的。
// 由此也不必手动派发 `input`:execCommand 自己发,五个入口的自增高 / 存草稿照常跑。

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

/** 给一个正文输入框接上快速输入。五个入口各调一次;监听挂在元素自己身上,故先于
 *  inbox / board 编辑态那两处**文档级** Enter 监听跑到(它们看见 shiftKey 本就让位)。 */
export function wireChecklistInput(ta: HTMLTextAreaElement): void {
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的回车是上屏,不是换行
    if (e.key === "Enter" && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const edit = continueChecklistOnNewline(ta.value, ta.selectionStart, ta.selectionEnd);
      if (edit === null) return; // 不是待办项 / 选中了一段 / 光标还在标记里:放行默认换行
      e.preventDefault();
      applyEdit(ta, edit);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      applyEdit(ta, toggleChecklistMarker(ta.value, ta.selectionStart, ta.selectionEnd));
    }
  });
}
