// 窗里一问的轻模态(标题 + 一段话 + 两枚钮)。878 从「第一次点 ✕」那一问(tray-hint.ts,W4 A5)里抽出来,
// 让混版提醒(doc-skew-ask.ts)用同一只,⛔ 别再另造一套。样子吃 tray-hint.css 的 `th-*`(类名沿用,别改:
// e2e 认它);键盘接管走 dom.ts::holdKeyboard(打开即焦点进面板 / Tab 圈闭 / 浮层内按键不冒到 document /
// 关掉焦点还给打开它的那枚)。
//
// 只管「问 + 交回答案」:记不记住、记在哪,由调用方定(两处的规矩不一样:✕ 那一问两种答案都记,
// 混版提醒只在「仍然使用」后记)。Esc / 点遮罩 = 取消。
import { elText as el, holdKeyboard } from "./dom";
import "./tray-hint.css";

export type ConfirmDialogOpts = {
  title: string;
  body: string;
  /** 主行动(左、朱砂点染)。 */
  ok: string;
  cancel: string;
  /** 打开时焦点落哪一枚。 */
  focus: "ok" | "cancel";
  /** 点了主行动之后焦点要不要还给打开它的那枚(✕ 那一问紧接着藏窗,不还)。取消 / Esc 一律还。 */
  returnFocusOnOk: boolean;
  /** 额外类名(挂在面板上,e2e / 截图认它)。 */
  panelClass?: string;
};

/** 弹出、等回答:`true` = 主行动,`false` = 取消 / Esc / 点遮罩。 */
export function confirmDialog(o: ConfirmDialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const overlay = el("div", "th-overlay");
    const panel = el("div", o.panelClass ? `th-panel ${o.panelClass}` : "th-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", o.title);
    const ok = el("button", "hbtn th-go", o.ok);
    const cancel = el("button", "hbtn th-no", o.cancel);
    const acts = el("div", "th-acts");
    acts.append(ok, cancel);
    panel.append(el("h2", "th-title", o.title), el("p", "th-body", o.body), acts);
    overlay.append(panel);
    document.body.append(overlay);

    let settled = false;
    const done = (yes: boolean): void => {
      if (settled) return;
      settled = true;
      hold.release(!yes || o.returnFocusOnOk);
      overlay.remove();
      resolve(yes);
    };
    const hold = holdKeyboard(overlay, panel, { focus: o.focus === "ok" ? ok : cancel, onEscape: () => done(false) });
    ok.addEventListener("click", () => done(true));
    cancel.addEventListener("click", () => done(false));
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) done(false);
    });
  });
}
