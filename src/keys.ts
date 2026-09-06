// 键盘判据里唯一一条不能只看 `e.key` 的:Tab。
//
// 地面事实(602 在 Linux/WebKitGTK 上两支探针实测,读数在 progress-log 602 —— 一支经
// WebDriver、一支 xdotool/XTEST 真键盘,**两者同形** ⇒ 不是驱动合成的差异):按下
// **Shift+Tab** 时 WebKitGTK 把 `e.key` 报成 `"Unidentified"`,而 `code=Tab` /
// `keyCode=9` / `shiftKey` 全都在。裸 Tab(不带 Shift)那一端报得对 ⇒ 只有「带 Shift
// 的那一记」漏。
// ⇒ 判 `e.key === "Tab"` 的地方,在这一端**用户按下去真的没反应**:那是我们判得太窄,
//   ⛔ **不是**「这一端没有这个能力」—— 与 571 那格(Ctrl+Z:整个应用没有撤销能力,
//   故显式跳过并记诚实边界)**不同族**,别照那条判例读。
// ⛔ 也别把它当「Windows 无关」:同一份代码在两端跑,放宽只是让漏掉的那一端跟上,
//   `e.key === "Tab"` 成立的那一端一个字都没变。
//
// 判据 = 「`key` 或 `code` 任一个说这是 Tab」。⛔ 别精简成只看 `e.code`:合成事件与某些
// IME 路径上 `code` 是空串,而那时 `key` 才是对的。
//
// ⚠ **这条判据只此一份**,理由是它此前恰好是两份:`checklist-input.ts`(缩进 / 退回)与
//   `item-images.ts`(灯箱焦点陷阱)当初各写各的 `e.key === "Tab"`,而只有前者有 e2e 盯着
//   ⇒ 后者一直没人发现也漏 —— 396 那份读数里「焦点溜到背后的 `BUTTON.hk-btn`」正是它,
//   当时被记成了驱动差异(603 推翻)。
export function isTabKey(e: KeyboardEvent): boolean {
  return e.key === "Tab" || e.code === "Tab";
}
