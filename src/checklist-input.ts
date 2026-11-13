// 待办清单的快速输入 —— 桌面那半的接线(562)。纯逻辑在 `checklist.ts`,这里只管
// 「哪一记按键触发」与「怎么落笔」。
//
// **三记手势**(五个正文输入口全都接同一份,⛔ 别在某个入口另接一套):
// - **Enter / Shift+Enter**:当前行是待办项时续行、带出同缩进的 `- [ ] `;空项上再按一次退出清单。
//   157 G4 / P6(用户拍)起**裸回车也续** —— 此前只认 Shift+Enter(五个入口的裸 Enter 都是「提交」),
//   清单写到第二项就被整条记下,而手机与长文都是回车续。现在:待办项那一行上回车 = 续,
//   别的行回车照旧提交,Ctrl+Enter 恒提交。提交点让位的接法见 `enterContinuesChecklist`。
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
  parseChecklistLine,
  indentChecklistLines,
  minimalEditRange,
  toggleChecklistMarker,
  type ChecklistEdit,
} from "../shared/checklist";
import { isTabKey } from "./keys";

/** 把纯逻辑算出的整份新正文落到框里,只改真正变了的那一段(撤销栈得以保留)。 */
export function applyEdit(ta: HTMLTextAreaElement, edit: ChecklistEdit): void {
  const { from, to, text } = minimalEditRange(ta.value, edit.value);
  ta.setSelectionRange(from, to);
  if (text === "") document.execCommand("delete");
  else document.execCommand("insertText", false, text);
  ta.setSelectionRange(edit.selStart, edit.selEnd);
}

/** 清单**中间**的空项上回车退出(158 G2 / A17,W2 走查 WD-25):纯逻辑那半把空项抹成一行空行、光标落在
 *  空行上 —— 在清单末尾那正是「接着写正文」的位置,夹在两项之间却只是清单里多出来的一道缝。⇒ 只在
 *  **下一行仍是待办项**时改成连这一行带它的换行一起拿掉、光标回到上一行末尾(撤掉刚续出来的那一项)。
 *  ⚠ 只改桌面接线这半;`shared/checklist.ts` 的纯逻辑与手机那半没动(手机没有这条走查读数)。 */
const NL = "\n";
function collapseMidListExit(value: string, caret: number, edit: ChecklistEdit): ChecklistEdit {
  const lines = value.split(NL);
  const before = value.slice(0, caret).split(NL);
  const at = before.length - 1; // 光标所在行号
  const ls = caret - before[at].length; // 那一行行首
  const isExit = edit.value === [...lines.slice(0, at), "", ...lines.slice(at + 1)].join(NL); // 退出 = 这一行被抹空
  if (!isExit || at === 0 || at === lines.length - 1) return edit;
  if (parseChecklistLine(lines[at - 1]) === null || parseChecklistLine(lines[at + 1]) === null) return edit;
  const out = [...lines.slice(0, at), ...lines.slice(at + 1)].join(NL);
  return { value: out, selStart: ls - 1, selEnd: ls - 1 };
}

/** 提交给后端之前,把**空的待办项**整行摘掉(901,用户拍板;手机那半同一条判据)。
 *
 *  判据不另写一套:就是 `parseChecklistLine` 认得的行(`shared/checklist.ts` 的 `LINE_RE`)且标记后面
 *  没有非空白 —— 与续行那记「空项上回车 = 退出清单」(`continueChecklistOnNewline`)同一句话。合起来等价于
 *  整行匹配 `/^[ \t]*- \[[ xX]\]\s*$/`。别的行(含空行、裸 `- ` 列表)一字不动;没有空项时原样返回。
 *
 *  ⛔ **只在提交那一刻调**(记一笔 / 捕获浮窗 / 随记与卡片编辑的保存),输入过程中不许调 —— 正在打的那一行
 *  可以暂时是空的。⛔ 点方框打勾(`toggleChecklistLine` → edit_note / rename_task,0039 不留历史那条路)
 *  与长文(那里的 `- [ ]` 是用户写的 Markdown 源)都不经过这里,别接上去。 */
export function dropEmptyChecklistLines(content: string): string {
  return content
    .split(NL)
    .filter((l) => {
      const p = parseChecklistLine(l);
      return p === null || p.rest.trim() !== "";
    })
    .join(NL);
}

/** 这一记裸回车会不会被拿去续待办项(157 G4 / P6)—— 给挂在 `wireChecklistInput` **之前**的提交监听
 *  先问一句(捕获浮窗);挂在之后的看 `e.defaultPrevented` 就够。 */
export function enterContinuesChecklist(ta: HTMLTextAreaElement, e: KeyboardEvent): boolean {
  if (e.key !== "Enter" || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  return continueChecklistOnNewline(ta.value, ta.selectionStart, ta.selectionEnd) !== null;
}

/** 给一个正文输入框接上快速输入。五个入口各调一次;监听挂在元素自己身上,故先于
 *  inbox / board 编辑态那两处**文档级** Enter 监听跑到(它们看见 shiftKey 本就让位)。 */
export function wireChecklistInput(ta: HTMLTextAreaElement): void {
  ta.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的回车是上屏,不是换行
    if (e.defaultPrevented) return; // 同一个框上先跑的那条监听已经吃了这一记(见文件头)
    if (isTabKey(e) && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const edit = indentChecklistLines(ta.value, ta.selectionStart, ta.selectionEnd, !e.shiftKey);
      if (edit === null) return; // 不涉及待办项 / 已经顶格:放行,这一记还给「移焦点」
      e.preventDefault();
      applyEdit(ta, edit);
      return;
    }
    // 157 G4 / P6 起裸回车也续(手机与长文本来就是):光标在待办项那一行上时,回车 = 下一项,
    // 空项上再按一次退出清单;别的行裸回车照旧归提交点。提交点见 `defaultPrevented` 就让位
    // (捕获浮窗那条监听挂在本条之前,走 `enterContinuesChecklist` 先问)。Ctrl+Enter 恒提交。
    if (e.key === "Enter" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const edit = continueChecklistOnNewline(ta.value, ta.selectionStart, ta.selectionEnd);
      if (edit === null) return; // 不是待办项 / 选中了一段 / 光标还在标记里:放行默认换行
      e.preventDefault();
      applyEdit(ta, collapseMidListExit(ta.value, ta.selectionStart, edit));
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.key === "l" || e.key === "L")) {
      e.preventDefault();
      applyEdit(ta, toggleChecklistMarker(ta.value, ta.selectionStart, ta.selectionEnd));
    }
  });
}
