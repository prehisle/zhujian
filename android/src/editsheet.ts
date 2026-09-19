// 编辑层(706):改一条已有条目的正文与配图,住屏底那座层里。
//
// 由头(用户 2026-09-19 当面报「编辑时应该用『记一笔』那个 UI」):此前编辑是**长在卡片里**
// 的一只 textarea(674/689 的「原地编辑」)—— 悬浮 ＋ 压住「保存」、长卡上要靠文档滚动才露
// 得出来、可写高度还比捕获层小。这一层把它挪到键盘上沿,与捕获层 / 留言层同一座 kbsheet。
//
// 分工(⛔ 别揉到一起):
// - **草稿的真相仍在 cardpanel 的 state**(120 实现审 H1 那条契约一个字没变):本层自己不存
//   正文,input 原样回调上去,重画时从宿主递下来的视图对象画回。
// - 本层只管:DOM、开合与返回键守门条目、禁用态、缩略图字节。
// - 写库、session 判弃、两拍确认、busy 闸全在 cardpanel —— 它是这一层唯一的宿主。
//
// ⚠ textarea 是**常驻节点**(不像卡里那版每次重画都新建),故重画只在值真的不同才写
// `.value` —— 照写会把光标弹到末尾(卡里那版每次重画都 `setSelectionRange(end)`,正是那个毛病)。
//
// ⚠ 关层三条路,**只有 UI 那两条平守门条目**:①「取消」/ 点遮罩 / 宿主收场 → `closeEditSheet()`
// (收 DOM + settleHistory);②返回键 → main.ts 的 popstate 已经弹掉条目 ⇒ 走
// `closeEditSheetNow()`(只收 DOM)再让宿主收草稿。两者都幂等,谁先谁后都不会双弹。
import { t } from "./i18n";
import type { ImageMeta } from "./api";
import { createKbSheet, type KbSheet } from "./kbsheet";
import { $, esc, showBar } from "./ui";
import { hydrateThumbs } from "./thumbs";
import { applyChecklistMarker, delegateChecklistNewline } from "./checklist-input";

/** 一次重画要画的全部东西(**宿主的 state 投影**,本层不留副本)。 */
export type EditView = {
  /** 正文草稿(真相在 cardpanel 的 `state.editDraft`)。 */
  text: string;
  /** 只读标签行(照桌面编辑态;改标签仍走操作面的「标签」)。 */
  topics: { title: string; color: string | null }[];
  /** 编辑期间这条的配图(增删就地改宿主那份)。 */
  images: ImageMeta[];
  /** 宿主有写在飞:整层禁点。 */
  busy: boolean;
};

/** 层内动作一律回调宿主 —— 本层不碰库,也不自己决定「编辑结束了没有」。 */
export type EditHost = {
  onInput(text: string): void;
  onSave(): void;
  /** 取消:「取消」钮 / 点遮罩(正文没改过) / 返回键。 */
  onCancel(): void;
  onAddImage(): void;
  onPhoto(): void;
  onDeleteImage(id: string, seq: string): void;
  /** 点缩略图本体 = 只读看大图(删走图上那枚 ×)。 */
  onViewImage(index: number): void;
  /** 正文相对库里那份改过没有:点遮罩时用来分「直接收层」还是「拦一句」。 */
  isDirty(): boolean;
};

type Deps = {
  /** 开层压一枚返回键守门条目(main.ts 的层账本)。 */
  pushLayer: () => void;
  /** UI 主动收层后平掉那枚条目;popstate 关的层⛔不许调。 */
  settleHistory: () => void;
};

let deps: Deps;
let kb: KbSheet | null = null;
let host: EditHost | null = null;
/** 上一次画出来的缩略图条签名:图没变就不重建节点(重建 = 已填好的小图闪一下)。 */
let thumbSig = "";

/** 顶上留这么一条背景:读得出「这是盖在时间轴上的一层」(同留言层的 72,这层没有标题栏故少一档)。 */
const RESERVE_TOP = 56;

const sheetEl = (): HTMLElement => $("edit-sheet");
const textEl = (): HTMLTextAreaElement => $("edit-text") as HTMLTextAreaElement;

export function isEditSheetOpen(): boolean {
  return host !== null;
}

/** 收层的 DOM 部分:popstate(返回键)与 UI 关层共用;history 账目由调用方处置。幂等。 */
export function closeEditSheetNow(): void {
  if (!host) return;
  host = null;
  kb?.close();
  textEl().value = "";
  $("edit-tags").hidden = true;
  $("edit-thumbs").hidden = true;
  $("edit-thumbs").innerHTML = "";
  thumbSig = "";
}

/** UI 主动收层(保存成功 / 取消 / 切空间被迫丢弃):顺带平掉守门条目。**层没开就是 no-op**
 *  —— 返回键那条路已经先把层收掉了,宿主随后照常调这里,不许再弹第二次。 */
export function closeEditSheet(): void {
  if (!host) return;
  closeEditSheetNow();
  deps.settleHistory();
}

/** 开层改这一条。宿主从 actions 面进编辑态时调;层已开着(同一条重入)= 只重画。 */
export function openEditSheet(v: EditView, h: EditHost): void {
  const first = host === null;
  host = h;
  paintEditSheet(v);
  if (first) {
    kb?.open();
    deps.pushLayer(); // 返回键第一本能 = 关掉这层
  }
  const ta = textEl();
  ta.focus(); // 进编辑态就该能写字(键盘随之起,视口由原生 ime inset 让位)
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/** 重画(草稿/配图/禁用态变了都走这里)。⛔ 正文只在真的不同才写,免得踩掉光标。
 *  ⛔ 正文框**不随 busy 禁用**:禁用会当场失焦、键盘落下去,而写在飞时继续打字是正当的
 *  (草稿实时入宿主 state,与卡里那版同)。禁的只是那五枚钮。 */
export function paintEditSheet(v: EditView): void {
  if (!host) return;
  const ta = textEl();
  if (ta.value !== v.text) ta.value = v.text;

  const tags = $("edit-tags");
  tags.hidden = v.topics.length === 0;
  tags.innerHTML = v.topics
    .map(
      (tp) =>
        `<span class="chip${tp.color ? " tinted" : ""}"${tp.color ? ` style="--tc:${esc(tp.color)}"` : ""}>${esc(tp.title)}</span>`,
    )
    .join("");

  // 缩略图条复用只读那套(`.thumbs`/`.thumb`,字节走 thumbs.ts);删钮挂 `data-editdel`。
  // ⚠ 图没变就一个节点都不动:每次重画都重建的话,已经填好字节的小图会闪一下(而 busy
  // 期间的重画一趟不少)。
  const thumbs = $("edit-thumbs");
  const sig = v.images.map((im) => `${im.id}:${im.seq}`).join(",");
  thumbs.hidden = v.images.length === 0;
  if (sig !== thumbSig) {
    thumbSig = sig;
    thumbs.innerHTML = v.images
      .map(
        (im) =>
          `<button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"><span class="tag-n">${t(
            "images.imageN",
            { n: im.seq },
          )}</span><span class="thumb-del" data-editdel="${esc(im.id)}" data-seq="${im.seq}" aria-label="${t(
            "main.deleteImage",
            { n: im.seq },
          )}">×</span></button>`,
      )
      .join("");
    hydrateThumbs(thumbs); // 缓存命中直接填,否则滚到可视区才拉(同只读那套)
  }

  for (const id of ["edit-addimg", "edit-photo", "edit-todo", "edit-cancel", "edit-save"]) {
    ($(id) as HTMLButtonElement).disabled = v.busy;
  }
}

export function initEditSheet(d: Deps): void {
  deps = d;
  kb = createKbSheet({
    sheet: sheetEl(),
    scrim: $("edit-scrim"),
    input: textEl(),
    reserveTop: RESERVE_TOP,
    // 点遮罩:正文一个字没改 = 当「取消」收层;改过了就拦一句——一记误触不该吞掉刚写的一段。
    // ⛔ 别改成「点遮罩直接丢弃」:这一层与捕获层不同,它没有 localStorage 那份草稿兜底。
    onDismiss: () => {
      if (!host) return;
      if (host.isDirty()) showBar(t("cardpanel.finishDraftFirst"));
      else host.onCancel();
    },
  });

  const ta = textEl();
  ta.addEventListener("input", () => host?.onInput(ta.value));
  // 回车续待办项(与捕获层同一套委托;这里的框是常驻节点,挂一次即可)。
  delegateChecklistNewline(sheetEl(), "textarea.edit");
  // 层内按钮不抢输入焦点:失了焦键盘会落、层跳一下,而「＋ 清单」那记 execCommand 更是
  // 非落在输入框上不可(同捕获层与 cardpanel 的手法:动作走 click,拦焦点走 mousedown)。
  sheetEl().addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  $("edit-save").addEventListener("click", () => host?.onSave());
  $("edit-cancel").addEventListener("click", () => host?.onCancel());
  $("edit-addimg").addEventListener("click", () => host?.onAddImage());
  $("edit-photo").addEventListener("click", () => host?.onPhoto());
  $("edit-todo").addEventListener("click", () => applyChecklistMarker(ta));
  $("edit-thumbs").addEventListener("click", (e) => {
    if (!host) return;
    const el = e.target as HTMLElement;
    const del = el.closest<HTMLElement>("[data-editdel]");
    if (del) {
      host.onDeleteImage(del.dataset.editdel!, del.dataset.seq ?? "");
      return;
    }
    const thumb = el.closest<HTMLElement>(".thumb[data-img]");
    if (!thumb) return;
    const all = [...$("edit-thumbs").querySelectorAll<HTMLElement>(".thumb[data-img]")];
    host.onViewImage(all.indexOf(thumb));
  });
}
