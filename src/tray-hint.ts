// 第一次点主窗 ✕ 的那句交代(W4 A5,WD-15)。ui-guidelines §4.2「按钮标注真实行为:……桌面『关闭』实为
// 隐藏到托盘 → 首次给提示」—— 此前一句不说:以为退出了,下次再开就撞上「主窗不出来」(A1)。
//
// ⭐ 为什么是窗里的一问、不是托盘气泡 / 系统通知:那两样都归系统管,Win10「专注助手」、通知被关了
// 都会把它安静地吞掉(走查第一次点 ✕ 后连拍四张右下角,一张都没见到);窗里这一问是**一定看得见**的。
// 只问这一次:点了「收进托盘」才藏窗;「取消」/ Esc / 点外面 = 窗留着 —— 两种都算看过了,之后的 ✕
// 照旧一下就藏。记在 localStorage(同字号 / 明暗:这台机器怎么用,不进库、不同步)。
// ⚠ 只管自绘的那枚 ✕(Windows / Linux)。Alt+F4、任务栏「关闭窗口」走的是壳里 `CloseRequested`
// 那条路(lib.rs,直接藏),不经这里 —— 那两样是知道自己在干嘛的人才按的。
import { t } from "./i18n";
import { confirmDialog } from "./confirm-dialog";

const KEY = "zhujian.tray-hint-seen";

function seen(): boolean {
  return localStorage.getItem(KEY) === "1";
}

/** 自绘 ✕ 的点击:第一次先问一句,之后直接 `hide()`。弹窗本体 878 起抽成 confirm-dialog.ts(混版提醒共用)。 */
export function closeToTray(hide: () => void): void {
  if (seen() || document.querySelector(".th-overlay")) {
    hide();
    return;
  }
  void confirmDialog({
    title: t("notebook.trayHintTitle"),
    body: t("notebook.trayHintBody"),
    ok: t("notebook.trayHintOk"),
    cancel: t("notebook.cancel"),
    focus: "ok",
    returnFocusOnOk: false, // 要藏窗就不必把焦点还回去(还回 ✕ 上,下次回窗焦点就停在那枚钮上)
  }).then((thenHide) => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {
      // 写不进去的最坏结果只是下次点 ✕ 再问一次 —— 不值得为它挡住藏窗。
    }
    if (thenHide) hide();
  });
}
