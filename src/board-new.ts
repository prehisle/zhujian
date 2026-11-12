// 「新建看板」对话框(multiboard-plan §6;用户拍:起名 + 选模板)。两处开它:侧栏「+ 新建看板」(有两块及以上
// 看板时才展开)与列管理面底部(只有一块看板时侧栏不展开 —— 渐进式披露,用户 2026-11-11 拍:入口放这里)。
import { boardsChanged, createBoard, setCurrentBoard } from "./boards";
import { el, trapTab } from "./dom";
import { errText } from "./err";
import { t } from "./i18n";
import "./column-manager.css";

// ---- 新建看板(用户拍:起名 + 选模板) -------------------------------------------------
// 两个模板(plan §6):★「待处理 / 进行中 / 已完成」三列、完成列 = 已完成;或「一列」纯分类(只分类、不完成)。
// 之后照列管理改。列名按本端语言给进 core(core 不造界面文案)。

let dialog: HTMLDivElement | null = null;

/** 开「新建看板」。建好之后:记成「在看这块」、广播看板变了、再调 `onCreated`(侧栏传「切到看板视图」;
 *  列管理面里开的那次不传 —— 看板视图收到广播自己重画到新那块)。
 *  没建就关掉(取消 / Esc / 点遮罩):给了 `onCancel` 就交它(列管理面里开的那次 = 回到列管理面),
 *  否则焦点还给打开它的那一枚(ui-guidelines §3.5「关完焦点还给打开它的那枚」)。 */
export function openNewBoard(onCreated?: () => void, onCancel?: () => void): void {
  if (dialog) return;
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const overlay = el("div", { className: "bcm-overlay" });
  dialog = overlay;
  const panel = el("div", { className: "bcm-panel bn-new" });
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("bnav.newTitle"));
  const close = (): void => {
    overlay.remove();
    dialog = null;
    document.removeEventListener("keydown", onKey);
  };
  /** 没建就关:回到打开它的地方。 */
  const cancelOut = (): void => {
    close();
    if (onCancel) onCancel();
    else if (opener?.isConnected) opener.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent): void => {
    trapTab(panel, e);
    if (e.key === "Escape") {
      e.stopPropagation();
      cancelOut();
    }
  };
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) cancelOut();
  });

  const name = el("input", { className: "bcm-col-input", type: "text", placeholder: t("bnav.namePh") });
  let tpl: "flow" | "one" = "flow";
  const tplBtn = (key: "flow" | "one", title: string, sub: string): HTMLElement => {
    const b = el("button", { className: "bn-tpl", type: "button" }, [
      el("span", { className: "bn-tpl-title", textContent: title }),
      el("span", { className: "bn-tpl-sub", textContent: sub }),
    ]);
    b.dataset.tpl = key;
    b.addEventListener("click", () => {
      tpl = key;
      paintTpl();
    });
    return b;
  };
  const tpls = el("div", { className: "bn-tpls" }, [
    tplBtn("flow", t("bnav.tplFlow"), t("bnav.tplFlowSub")),
    tplBtn("one", t("bnav.tplOne"), t("bnav.tplOneSub")),
  ]);
  function paintTpl(): void {
    for (const b of tpls.querySelectorAll<HTMLElement>(".bn-tpl")) {
      const on = b.dataset.tpl === tpl;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", String(on));
    }
  }
  paintTpl();
  const err = el("div", { className: "bcm-err", hidden: true });
  const cancel = el("button", { className: "bcm-btn", type: "button", textContent: t("cols.cancel") });
  cancel.addEventListener("click", cancelOut);
  const ok = el("button", { className: "bcm-btn solid-ink", type: "button", textContent: t("bnav.create") });
  ok.addEventListener("click", () => void go());
  name.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void go();
  });
  let busy = false;
  async function go(): Promise<void> {
    if (busy) return;
    const title = name.value.trim();
    if (title === "") {
      err.textContent = t("cols.emptyBoardName");
      err.hidden = false;
      name.focus();
      return;
    }
    const cols = tpl === "flow" ? [t("bnav.colTodo"), t("bnav.colDoing"), t("bnav.colDone")] : [t("bnav.colOne")];
    busy = true;
    let id: string;
    try {
      id = await createBoard(title, cols, tpl === "flow" ? 2 : null);
    } catch (e) {
      busy = false;
      err.textContent = errText(e);
      err.hidden = false;
      return;
    }
    close();
    // 900 C8:建好之后焦点还给打开它的那一枚(此前只有「没建就关」那条路还,建好了焦点掉到 body)。侧栏那枚
    // 「+ 新建看板」随后会被重画换掉 —— board-nav 的 paint 按「焦点原在哪一枚」接回新那枚。
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    setCurrentBoard(id);
    boardsChanged();
    onCreated?.();
  }

  panel.append(
    el("div", { className: "bcm-head" }, [el("h2", { className: "bcm-title", textContent: t("bnav.newTitle") })]),
    name,
    tpls,
    el("p", { className: "bcm-hint", textContent: t("bnav.newHint") }),
    err,
    el("div", { className: "bn-new-acts" }, [cancel, ok]),
  );
  overlay.append(panel);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey);
  name.focus();
}
