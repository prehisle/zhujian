// 待办清单的快速输入 —— 桌面那半的接线(562)。纯逻辑在 `checklist.ts`,这里只管
// 「哪一记按键触发」与「怎么落笔」。
//
// **三记手势**(五个正文输入口全都接同一份,⛔ 别在某个入口另接一套):
// - **Shift+Enter**:当前行是待办项时续行、带出同缩进的 `- [ ] `;空项上再按一次退出清单。
//   ⚠ 挑 Shift+Enter 不是随意的 —— 五个入口的裸 Enter **都是「提交」**(捕获浮窗、两个
//   compose、灵感卡编辑态、看板卡 inline rename),Shift+Enter 才是那一记「换行」。
// - **Ctrl+L**:把光标那一行(或选中的几行)变成待办项,再按一次摘掉。⚠ 键位是核过的:
//   桌面已占的是 Ctrl+V 粘图 / Ctrl+C 复制图 / Ctrl+B 侧栏 / Ctrl+±/0 缩放 / 两枚可改的
//   全局热键(Ctrl+Alt+N、Ctrl+Alt+M),L 空着;卡片与视图的单键(L = 标签)带修饰键时
//   本来就让位(hotkey-menu / registerViewKeys 开头就 `if (ctrlKey||metaKey||altKey) return`)。
// - **Tab / Shift+Tab**(600):把光标那一行(或选中的几行)推进 / 退回一级缩进。
//   ⛔ **绝不无条件吃掉 Tab** —— 它是键盘用户离开输入框的唯一通路,吞了就是把人关在框里。
//   判据窄在纯逻辑那半(`indentChecklistLines`:不涉及待办项 / 已经顶格都答 `null`),
//   答 null 就**放行默认**,焦点照旧移走。⚠ 安卓没有这一记(软键盘上没有 Tab),但纯逻辑
//   那份仍两端逐字对应。
//
// ⚠ **`defaultPrevented` 先看一眼**:捕获浮窗那个框上还挂着另一条 keydown(斜杠命令面板
//   开着时 Enter/Tab = 执行选中的命令),而 `preventDefault()` **拦不住同一元素上的其它
//   监听** —— 两条都会跑。故那边先挂、这边后挂,并在这里认它的旗让位;⛔ 别把 main.ts 里
//   `wireChecklistInput(input)` 那一句挪回文件开头,挪回去两件事会同时发生。
//
// ⛔ **落笔走 `execCommand` 不走 `ta.value = …`**:后者会清空浏览器撤销栈,连用户此前
// 手打的字都 Ctrl+Z 不回来 —— 一个「编辑器辅助」把用户已有的撤销历史吃掉是不能接受的。
// 由此也不必手动派发 `input`:execCommand 自己发,五个入口的自增高 / 存草稿照常跑。

import {
  continueChecklistOnNewline,
  indentChecklistLines,
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
    if (e.defaultPrevented) return; // 同一个框上先跑的那条监听已经吃了这一记(见文件头)
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const edit = indentChecklistLines(ta.value, ta.selectionStart, ta.selectionEnd, !e.shiftKey);
      if (edit === null) return; // 不涉及待办项 / 已经顶格:放行,这一记还给「移焦点」
      e.preventDefault();
      applyEdit(ta, edit);
      return;
    }
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
