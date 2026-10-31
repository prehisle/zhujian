import "./trash-images.css";
import { el } from "./dom";
import { errText } from "./err";
import { type Act, type HotkeyController, armDismiss } from "./hotkey-menu";
import { t } from "./i18n";
import { getThumb, openLightbox } from "./item-images";
import { invoke } from "./space";
import { when } from "./tasktime";

// 回收站里的「已删配图」一节(用户面 149,docs/image-trash-plan.md §7)。灵感回收站与任务
// 回收站各挂一份(按宿主 stage 分页,范围在 core 的 `TrashScope`),所以抽成两视图共用的件。
//
// 形:按宿主归组,组头 = 宿主正文首行;组里每张图一行(缩略图 + 「图N · 删除于 …」)。
// 每行的动作走只读视图那套(design-rules「只读视图只留离场动作、且不常驻」):接进宿主视图
// 的 HotkeyController —— 悬停 ⋯ / 右键 / 单键,只给「还原」「彻底删除」两个离场动作;
// 点缩略图看大图。还原 = 回到原编号(编号从没让出去过),彻底删除 = 行内二次确认。

export type RemovedImage = { id: string; seq: number; mime: string; removed_at: string };
export type RemovedGroup = { item_id: string; stage: string; content: string; images: RemovedImage[] };

/** 「ideas」= 灵感回收站那页,「tasks」= 任务回收站那页(core `repo::TrashScope`)。 */
export function listRemovedImages(scope: "ideas" | "tasks"): Promise<RemovedGroup[]> {
  return invoke<RemovedGroup[]>("list_removed_images", { scope });
}

export function removedImageCount(groups: RemovedGroup[]): number {
  return groups.reduce((n, g) => n + g.images.length, 0);
}

export type TrashImagesOpts = {
  /** 宿主视图的单键控制器:每行登记成一张「卡」,与条目行同一套悬停 / 右键 / 单键。 */
  hk: HotkeyController;
  /** 宿主视图回收站里「还原 / 彻底删除」用的那两枚键(灵感 R / D、任务 U / D),同概念同键。 */
  keys: { restore: string; deleteForever: string };
  /** 宿主的确认态登记:先收掉宿主别处的确认,再把这一枚的拆除句柄交给宿主保管
   *  (宿主每次重渲前会统一拆,免得监听随旧节点泄漏)。传 null = 已自拆,只归零。 */
  claimConfirm: (off: (() => void) | null) => void;
  /** 还原 / 彻底删除落地后,宿主重新拉一遍回收站。 */
  onChanged: () => void;
  /** 写失败时宿主怎么告诉用户(两视图各有自己的错误条)。 */
  onError: (msg: string) => void;
  /** 行内确认那两枚钮的类名:两视图的确认钮各有一套(灵感 `do` / `no`、看板 `act primary` /
   *  `act ghost`),跟着宿主走,别在这里另起第三套。 */
  buttons: { yes: string; no: string };
};

/** 宿主正文的首行(组头用);空正文给一句占位,别留一个空白组头。行首的 Markdown 标题记号摘掉(长文首行多是
 *  「# 题目」,同列表卡 docTitle;组头里拿不到 kind,随记首行真以「# 」起也一并摘 —— 只是个标签;153 走查 A-M12)。 */
function ownerLine(content: string): string {
  const first = content.split("\n").find((l) => l.trim() !== "")?.replace(/^\s*#{1,6}\s+/, "").trim() ?? "";
  return first === "" ? t("trashImages.noText") : first;
}

export function removedImagesSection(groups: RemovedGroup[], opts: TrashImagesOpts): HTMLElement {
  const section = el("section", { className: "trash-imgs" }, [
    el("h3", { className: "trash-imgs-title", textContent: t("trashImages.title") }),
  ]);
  for (const g of groups) {
    const metas = g.images.map((im) => ({ id: im.id, seq: im.seq, mime: im.mime }));
    const group = el("div", { className: "trash-imgs-group" }, [
      el("div", { className: "trash-imgs-owner", textContent: ownerLine(g.content) }),
    ]);
    g.images.forEach((im, i) => group.append(imageRow(im, metas, i, opts)));
    section.append(group);
  }
  return section;
}

function imageRow(
  im: RemovedImage,
  metas: { id: string; seq: number; mime: string }[],
  index: number,
  opts: TrashImagesOpts,
): HTMLElement {
  const row = el("div", { className: "trash-imgs-row" });
  row.dataset.imageId = im.id;
  const thumb = el("div", { className: "img-thumb" });
  const img = el("img", {
    className: "img-thumb-img",
    alt: t("itemImages.badge", { n: im.seq }),
    title: t("itemImages.clickZoom"),
  });
  getThumb(im.id)
    .then((url) => {
      img.src = url;
    })
    .catch(() => thumb.classList.add("broken"));
  img.addEventListener("click", (e) => {
    e.stopPropagation();
    void openLightbox(metas, index);
  });
  thumb.append(img, el("span", { className: "img-badge", textContent: t("itemImages.badge", { n: im.seq }) }));
  const label = el("span", {
    className: "trash-imgs-label",
    textContent: t("trashImages.row", { n: im.seq, when: when(im.removed_at) }),
  });
  const side = el("div", { className: "trash-imgs-side" });
  const showView = (): void => {
    row.classList.remove("confirming");
    side.replaceChildren(handle.menu());
  };

  // 在飞闸:单键连按 / 双击别发第二条(第二条必撞「不在回收站里」,白报一句错)。
  let busy = false;
  const restore = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await invoke("restore_item_image", { imageId: im.id });
    } catch (e) {
      busy = false;
      opts.onError(errText(e));
      return;
    }
    opts.onChanged();
  };
  const openPurge = (): void => {
    row.classList.add("confirming");
    opts.claimConfirm(
      armDismiss(row, () => {
        opts.claimConfirm(null);
        showView();
      }),
    );
    const purge = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      opts.claimConfirm(null);
      try {
        await invoke("purge_item_image", { imageId: im.id });
      } catch (e) {
        busy = false;
        opts.onError(errText(e));
        showView();
        return;
      }
      opts.onChanged();
    };
    side.replaceChildren(
      el("span", { className: "trash-imgs-q", textContent: t("trashImages.deleteForeverQ") }),
      el("button", {
        className: opts.buttons.no,
        textContent: t("trashImages.cancel"),
        onclick: () => {
          opts.claimConfirm(null);
          showView();
        },
      }),
      el("button", { className: opts.buttons.yes, textContent: t("trashImages.deleteForever"), onclick: purge }),
    );
  };
  const actions = (): Act[] => [
    { label: t("trashImages.restore"), key: opts.keys.restore, run: () => void restore() },
    { label: t("trashImages.deleteForever"), key: opts.keys.deleteForever, run: openPurge, danger: true },
  ];
  const handle = opts.hk.register(row, actions, () => row.classList.contains("confirming"));
  row.append(thumb, label, side);
  showView();
  return row;
}
