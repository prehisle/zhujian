// 「清空回收站」的那一拍确认 —— 随记与看板两个回收站共用一份(W3 159 / A9 + A19,WD-10 / WD-23)。
//
// 此前两处各写各的:随记那边原钮就地换成红实心「彻底删除全部 6 条和 1 张配图」+「取消」(红钮盖住原钮的
// 左半截,双击的第二下照样能落在红钮上);看板那边左边一句问话 +「取消」+ 红实心「全部删除」(确认跳到左边、
// 取消在前)—— 措辞、钮序、位置三样都不一样,也都不是规范要的全宽(ui-guidelines §3.2 第 6 条 / §3.8「重破坏」)。
//
// 现在两处同一个样:
//   · 触发钮「清空回收站」留在页头那条工具条的右端,按下后**原地置灰**(不收、不换字)——
//     双击的第二下落在一枚灰钮上,什么也不发生(§3.2 第 2 条「执行钮不落在触发钮的原落点上」);
//   · 工具条**下面**另起一块确认区(§3.2 第 1 条「独立确认行」,不动工具条自己的几何):一句后果
//     (几条、几张配图、无法恢复)+ 右上「取消」,再下面一枚**全宽**的红钮「彻底删除全部」;
//   · Esc / 点确认区以外任何地方 = 取消(armDismiss,§3.2 第 3 条);teardown 交给调用方那枚 mount 级单值
//     (重画时整块换掉,闭包局部的 off 会随旧节点泄漏 —— codex M3 那条)。
import "./trash-purge.css";
import { armDismiss } from "./hotkey-menu";
import { t } from "./i18n";
import { el } from "./dom";

export type TrashPurgeOpts = {
  /** 这一页回收站里此刻有几条(随记 / 长文,或任务)、几张已删配图 —— 全都会被彻底删掉。按下那一刻现读
   *  (随记回收站还原 / 彻底删一条只是让卡离场、不整页重画,画的时候那个数到按的时候可能已经旧了)。 */
  count: () => { items: number; images: number };
  /** 调用方 mount 级的确认 teardown 槽(同 trashImagesSection 的 claimConfirm):给 off = 登记,给 null = 已自拆。 */
  claimConfirm: (off: (() => void) | null) => void;
  /** 点了「彻底删除全部」。确认区此时已经收起。 */
  onYes: () => void;
  /** 这是哪一只回收站(165 / W5 Q14:确认句写明只清这一只 —— 随记 / 长文那只与看板那只是两只,清哪只都只清自己)。 */
  which: "notes" | "tasks";
};

/** 返回两样:`button` 放进工具条右端;`panel` 紧跟在工具条后面插进页面(平时 `hidden`,不占位)。 */
export function trashPurgeControl(opts: TrashPurgeOpts): { button: HTMLButtonElement; panel: HTMLElement } {
  const { count, claimConfirm, onYes, which } = opts;
  const button = el("button", { className: "purge-open", type: "button", textContent: t("trash.emptyTrash") });
  button.setAttribute("aria-expanded", "false");
  const no = el("button", { className: "purge-no", type: "button", textContent: t("trash.cancel") });
  const yes = el("button", { className: "purge-yes", type: "button", textContent: t("trash.purgeAllYes") });
  const panel = el("div", { className: "purge-panel", hidden: true }, [
    el("div", { className: "purge-head" }, [el("p", { className: "purge-q" }), no]),
    yes,
  ]);
  panel.setAttribute("role", "group");
  panel.setAttribute("aria-label", t("trash.emptyTrash"));

  // 本块自己持有 armDismiss 的拆除句柄(自己那两枚钮收场时亲手拆,别留着监听等下一次点别处才自拆)。
  // 交给宿主槽位的是**整个收场**(拆监听 + 收起确认区),不只是拆监听:宿主别处开确认(如悬停按 D)
  // 时会先 disarm 在场的这一枚 —— 只拆监听的话,确认区会留在屏上、触发钮一直灰着。
  let off: (() => void) | null = null;
  const close = (): void => {
    if (panel.hidden) return; // 已收:别再去动宿主的槽位(那时它可能已登记着别的确认)
    // 焦点在确认区里(取消 / Esc 收场)或已掉到页面上 ⇒ 收完还给「清空回收站」那枚(W5 A4:此前 Esc 后掉到 body,
    // 下一下 Tab 落到第 1 条的 ⋯)。点了别处、焦点已被接走就不抢。
    const a = document.activeElement;
    const refocus = a === null || a === document.body || panel.contains(a);
    const f = off;
    off = null;
    f?.();
    claimConfirm(null);
    panel.hidden = true;
    button.disabled = false;
    button.setAttribute("aria-expanded", "false");
    if (refocus && button.isConnected) button.focus({ preventScroll: true });
  };
  button.addEventListener("click", () => {
    if (!panel.hidden) return;
    const { items, images } = count();
    const q =
      images === 0
        ? t("trash.purgeAllQ", { n: items })
        : items === 0
          ? t("trash.purgeAllImagesQ", { m: images })
          : t("trash.purgeAllMixedQ", { n: items, m: images });
    (panel.querySelector(".purge-q") as HTMLElement).textContent = `${q}${which === "notes" ? t("trash.scopeNotes") : t("trash.scopeTasks")}`;
    panel.hidden = false;
    button.disabled = true;
    button.setAttribute("aria-expanded", "true");
    off = armDismiss(panel, () => {
      off = null; // armDismiss 已自拆:只归零
      close();
    });
    claimConfirm(close);
    panel.scrollIntoView({ block: "nearest" });
    no.focus({ preventScroll: true }); // 键盘的落点是安全的那一枚:回车 = 取消,真要删得 Tab 过去
  });
  no.addEventListener("click", close);
  yes.addEventListener("click", () => {
    close();
    onYes();
  });
  return { button, panel };
}
