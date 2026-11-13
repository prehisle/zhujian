// 回收站 / 归档册 / 搜索 低频面(120)。统一纪律(codex 120 设计审 M7):
// 每次加载开头取定 {space, seq},响应回来复核 space 未变且 seq 仍是最新才画
// ——旧查询晚回不许盖新查询,切空间后的迟到响应整体弃。写操作 in-flight 禁点,
// 彻底删/清空的两拍确认在底部固定确认条(ui-audit P0 #4:原位换话术会改按钮几何,
// 第二拍可能落到毗邻单拍的「恢复」上;固定条几何恒定,onYes 复核行还在才执行)。
import {
  getCurrentSpace,
  listBoardColumns,
  listBoards,
  listItemImages,
  listRemovedImages,
  listSealedTasks,
  listTrash,
  purgeArchived,
  purgeArchivedTasks,
  purgeItemImage,
  purgeNote,
  purgeTask,
  restoreItemImage,
  restoreNote,
  restoreTask,
  searchNotes,
  unsealTask,
  sealTask,
  type ImageMeta,
  type RemovedGroup,
  type SearchHitItem,
  type SearchStatus,
  type SpaceInfo,
} from "./api";
import { fillThumb, hydrateThumbs } from "./thumbs";
import { onFoldClick, resettleFolds, settleFolds } from "./fold";
import { docTitle, docTitleIsHeading, excerpt } from "./docs";
import { openViewer } from "./viewer";
import { currentLang, t } from "./i18n";
import {
  $,
  actionBar,
  cardTint,
  colsFor,
  confirmBar,
  contentHtml,
  esc,
  fmtWhen,
  hideConfirmBar,
  itemSnippet,
  markHits,
  markLocated,
  showBar,
  showError,
  showUndone,
  splitCols,
} from "./ui";
import { INPUT_DEBOUNCE_MS } from "./timing";
import { errDetail, showErr } from "./err";
import {
  type Board,
  HOLDING,
  allBoards,
  boardName,
  boardOfStage,
  currentView,
  isHeldStage,
  isTaskStage,
  liveBoards,
  setBoards,
  setColumns,
  stageLabel,
} from "./columns";

type Deps = {
  refreshTimeline: () => Promise<void>;
  /** 回到主视图定位并闪一下那张卡(归档册「取消归档」回执的「去看看」;main.ts 实现)。 */
  focusCard: (id: string) => void;
  /** 点了一条搜索结果(main.ts 实现):按归属分流到时间轴 / 长文 / 回收站 / 归档册并定位那一条(ui-audit P1 #8、
   *  159 A14),且压住「按一次返回回到搜索结果」那一层(159 A3,WM-02)。 */
  jumpFromSearch: (hit: SearchHitItem) => void;
  /** 这台上的空间(main.ts 的 spacesCache 影子):搜索没结果时「有没有多个空间」照顶栏空间徽章那一处判(901)。 */
  getSpaces: () => SpaceInfo[];
};

let deps: Deps;

// 宽屏上三个面的卡片列表分栏(tablet-plan 格 5;与随记同一套:ui.ts 的 colsFor / splitCols,轮流分)。栏数按**列表自己的宽**
// 算;面收着时列表 0 宽 ⇒ 沿用上一次。每只列表挂一只 ResizeObserver,栏数真变了才重画(转屏、分屏拖宽窄 —— 盯的是列表
// 自己,面开着时也触发);只重画**已经画着卡**的列表(加载中 / 空态 / 出错那句话不是卡,不碰)。
const listCols = new WeakMap<HTMLElement, number>();
function colsOf(box: HTMLElement): number {
  const w = box.clientWidth;
  if (w === 0) return listCols.get(box) ?? 1;
  const n = colsFor(w);
  listCols.set(box, n);
  return n;
}
function watchCols(box: HTMLElement, rerender: () => void): void {
  new ResizeObserver(() => {
    if (box.clientWidth === 0 || !box.querySelector(".card")) return;
    if (colsFor(box.clientWidth) !== listCols.get(box)) rerender();
  }).observe(box);
}

/** 收起底部确认条(重载/切空间时:旧确认不许挂在新列表上)。 */
function clearConfirm() {
  hideConfirmBar();
}

// ---- 回收站 -------------------------------------------------------------------
//
// ⭐ 159(W3 走查 Q1,用户拍 ①;WM-01 / X-01):一页里分「随记」「任务」两段,各数各的、各自清空 —— 与指南
// 「回收站按视图分开」、与桌面两个回收站一致。此前是一张混排列表 + 一枚「清空回收站」,一下连任务一起彻底删了,
// 确认条只写「N 条和 M 张配图」、不提里面有任务。
//  · 段归属 = 条目冻结的 stage 是不是任务列(`isTaskStage`,与还原落到哪一面同一份判据);长文归「随记」那段
//    (同桌面随记页的回收站:随记、长文和它们删掉的配图)。
//  · 已删配图跟着**宿主现在的 stage** 走(宿主在用;core `TrashScope` 的谓词,`images.rs` 那条
//    `each_clear_only_touches_its_own_page` 钉着):随记那段的清空 = `purge_archived`(连随记 / 长文宿主的已删图),
//    任务那段 = `purge_archived_tasks`(连任务宿主的已删图)—— 两条都是 core 现成的单事务,手机从此不再调
//    `purge_all_trash`(那条留在命令面,不删)。
//  · ⛔ 这是**一页两段**不是两个 tab(§3.9:别给某一页单独造 tab 条);段头吸顶,用的是时间轴节头那一套。

type TrashSec = "ideas" | "tasks";
const SECS: TrashSec[] = ["ideas", "tasks"];
const secOfStage = (stage: string): TrashSec => (isTaskStage(stage) ? "tasks" : "ideas");

let trashSeq = 0;
let trashBusy = false;
let trashRows: import("./api").TrashItem[] = [];
/** 回收站里的已删配图(用户面 149),按宿主归组;与 trashRows 同批取。 */
let trashImgs: RemovedGroup[] = [];
/** 回收站里每条**自己的**配图(159 / W3 A15,WM-10):宿主进回收站时它的图不算删,跟着冻结,还原后原样都在 ——
 *  此前回收站里那条一张图都不显示、也不写有几张。按条目 id 取(`list_item_images`,与时间轴卡同一份元数据)。 */
let trashRowImgs = new Map<string, ImageMeta[]>();
const imgCount = (sec: TrashSec): number =>
  trashImgs.filter((g) => secOfStage(g.stage) === sec).reduce((n, g) => n + g.images.length, 0);
const rowsOf = (sec: TrashSec) => trashRows.filter((r) => secOfStage(r.stage) === sec);
/** 已删配图那一行的「开合键」:与条目卡共用 trashOpenId(至多一个开着),加前缀免得撞 id。 */
const imgKey = (id: string): string => `img:${id}`;
/** 展开着操作面板的那张卡(同 `sealedOpenId`,至多一张);null = 一张都没开。
 *  51 起回收站跟上 508 的形 —— 只读视图的离场动作不常驻,点卡片才出。 */
let trashOpenId: string | null = null;

export async function loadTrash(): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++trashSeq;
  const box = $("trash-list");
  // 159 / W3 A17(WM-12):只有列表还没画过时才换「读取中…」。还原 / 彻底删除 / 远端刷新之后的重载照旧画着旧卡,
  // 新的到了原地换 —— 此前每次都先换成一行字,页面一矮,滚动位被钳回顶,连续整理要每次从头划。
  if (!box.querySelector(".card, p.empty")) box.innerHTML = `<p class="muted empty">${t("panes.loading")}</p>`;
  try {
    // 列与行同批取:回收站每行要印「这是灵感还是哪一列的任务」,而列名来自库
    // (B-f 第 1 段)。⛔ 别指望主时间轴那轮已经登记过 —— 首轮 refresh 失败时它是空的,
    // 那会让每一行都退化成「灵感」而**不报错**(159 起还会把任务分进「随记」那段)。
    const [rows, cols, imgs] = await Promise.all([listTrash(space), listBoardColumns(space), listRemovedImages(space)]);
    // 每条自己的配图:逐条取(回收站通常几条到几十条;并发发出)。
    const own = await Promise.all(rows.map((r) => listItemImages(space, r.id)));
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    setColumns(cols);
    trashRows = rows;
    trashImgs = imgs;
    trashRowImgs = new Map(rows.map((r, i) => [r.id, own[i]]));
    // 重载后那张卡可能已经不在(自己刚还原/彻底删了、对端动过):展开态跟着作废(同 sealed)。
    const alive = (k: string): boolean =>
      rows.some((r) => r.id === k) || imgs.some((g) => g.images.some((im) => imgKey(im.id) === k));
    if (trashOpenId !== null && !alive(trashOpenId)) trashOpenId = null;
    clearConfirm();
    renderTrash();
    // A14:从搜索点进来的那一条 —— 画好之后滚过去、挂定位框(只活这一趟)。
    const want = trashLocate;
    trashLocate = null;
    if (want !== null) applyLocate(box, `[data-trash="${want.id}"]`, want);
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    trashLocate = null;
    box.innerHTML = `<p class="empty warn-ink">${t("panes.trashLoadFailed", { error: esc(errDetail(err)) })}</p>`;
  }
}

/** 长文卡的正文(159 / W3 A16,WM-11):照长文列表卡那形 —— 题目 + 两行摘要,不露 `#`(Markdown 只在长文阅读页渲染)。 */
function docBodyHtml(content: string): string {
  const title = docTitle(content);
  return (
    `<h3 class="doc-title${title === "" ? " untitled" : docTitleIsHeading(content) ? "" : " plain"}">${esc(title === "" ? t("docs.untitled") : title)}</h3>` +
    `<p class="doc-ex">${esc(excerpt(content, title))}</p>`
  );
}

/** 一条回收站卡。 */
function trashCardHtml(r: import("./api").TrashItem): string {
  // 列名是同步来的自由文本(桌面能改成任意字)⇒ 进 HTML 前转义(backlog 用户面 144)
  // 长文(0042)回收站里保留长文属性:还原后它回的是长文那一面,小标照实说。
  const isDoc = r.doc_at !== null && !isTaskStage(r.stage);
  // 159 / W3 Q12(WM-29):小章说的是「这是哪一类东西」—— 任务就叫「任务」(此前印的是它删前那一列的列名「待办」,
  // 同一张在搜索里却叫「任务」)。列名照旧只在看板的列头上。
  const kind = isDoc ? t("panes.kindDoc") : isTaskStage(r.stage) ? t("panes.kindTask") : t("panes.kindIdea");
  const chips = r.topics
    .map(
      (t) =>
        `<span class="chip${t.color ? " tinted" : ""}"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
    )
    .join("");
  // 51:两枚离场动作不常驻 —— 点卡片才出面板,再点收起(同 sealed / 同时间轴)。
  const panel =
    r.id === trashOpenId
      ? `<div class="panel"><div class="acts">
          <button data-trash-act="restore"${trashBusy ? " disabled" : ""}>${t("panes.restore")}</button>
          <button data-trash-act="purge" class="warn"${trashBusy ? " disabled" : ""}>${t("panes.purge")}</button>
        </div></div>`
      : "";
  // 配图(A15):与时间轴卡同一形的只读缩略图(字节滚到可视区才拉,hydrateThumbs);点开看大图(只读)。
  const imgs = trashRowImgs.get(r.id) ?? [];
  const thumbs = imgs.length
    ? `<div class="thumbs">${imgs
        .map(
          (im) =>
            `<button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"
               aria-label="${t("main.viewImage", { n: im.seq })}"><span class="tag-n">${t("images.imageN", { n: im.seq })}</span></button>`,
        )
        .join("")}</div>`
    : "";
  // 正文(A16):随记照时间轴卡,先一律夹住、落 DOM 后由 settleFolds 量(超过八行才折、长一枚「展开」);
  // 长文照长文列表卡。
  const body = isDoc ? docBodyHtml(r.content) : `<p class="content clamped">${contentHtml(r.content, false)}</p>`;
  const tint = cardTint(r.color);
  return `<article class="card${isDoc ? " doc-card" : ""}${tint.cls}"${tint.attr} data-trash="${esc(r.id)}"><div class="body">
    ${body}${thumbs}
    <footer><span class="pill">${esc(kind)}</span><time>${t("panes.deletedAt", { when: esc(fmtWhen(r.archived_at)) })}</time>${chips}</footer>${panel}
  </div></article>`;
}

function renderTrash() {
  const box = $("trash-list");
  if (!trashRows.length && !trashImgs.length) {
    box.innerHTML = `<p class="muted empty">${t("panes.trashEmpty")}</p>`;
    return;
  }
  // A17:重画保滚动位 —— 夹子、缩略图落定之后还原(要还的是夹后几何,§3.6「全量重画必须保留滚动位」)。
  const y = window.scrollY;
  box.innerHTML = SECS.map((sec) => {
    const rows = rowsOf(sec);
    const m = imgCount(sec);
    const cards = rows.map(trashCardHtml);
    const head = `<h3 class="tl-sec">${sec === "ideas" ? t("panes.secIdeas") : t("panes.secTasks")}<span class="tl-count">${rows.length}</span></h3>`;
    const inner =
      rows.length === 0 && m === 0
        ? `<p class="tl-empty">${sec === "ideas" ? t("panes.secIdeasEmpty") : t("panes.secTasksEmpty")}</p>`
        : (cards.length ? splitCols(cards, colsOf(box)) : "") +
          trashImagesHtml(sec) +
          // 158 G2:清空不常驻列表最上面、不通栏(§3.8)⇒ 每段末尾一枚次级钮;确认走全宽重破坏那一档(A19)。
          `<div class="row trash-foot"><button id="trash-empty-${sec}" class="ghost" data-trash-empty="${sec}"${
            trashBusy ? " disabled" : ""
          }>${sec === "ideas" ? t("panes.emptyIdeas") : t("panes.emptyTasks")}</button></div>`;
    return `<section class="tl-group trash-sec" data-sec="${sec}">${head}${inner}</section>`;
  }).join("");
  hydrateThumbs(box);
  settleFolds(box);
  if (window.scrollY !== y) window.scrollTo(0, y);
}

/** 宿主正文首行(组头);空正文给一句占位。行首的 Markdown 标题记号摘掉(长文首行多是「# 题目」,
 *  同列表卡 docTitle;组头里拿不到 kind,随记首行真以「# 」起也一并摘 —— 只是个标签;153 走查 A-M12)。 */
function ownerLine(content: string): string {
  const first = content.split("\n").find((l) => l.trim() !== "")?.replace(/^\s*#{1,6}\s+/, "").trim() ?? "";
  return first === "" ? t("panes.imageNoText") : first;
}

/** 「已删配图」一节(用户面 149):按宿主归组,每张一行(缩略图 + 「图N · 删于 …」)。
 *  点缩略图看大图(只读查看器:那枚「删除」藏掉 —— 它已经在回收站里了);点行别处 = 开合
 *  操作面板(还原 / 彻底删除),与条目卡同一套「离场动作不常驻」。159 起按宿主 stage 分进两段各画各的。 */
function trashImagesHtml(sec: TrashSec): string {
  const mine = trashImgs.filter((g) => secOfStage(g.stage) === sec);
  if (!mine.length) return "";
  const groups = mine
    .map((g) => {
      const rows = g.images
        .map((im) => {
          const open = trashOpenId === imgKey(im.id);
          const panel = open
            ? `<div class="panel"><div class="acts">
                <button data-trash-img-act="restore"${trashBusy ? " disabled" : ""}>${t("panes.restore")}</button>
                <button data-trash-img-act="purge" class="warn"${trashBusy ? " disabled" : ""}>${t("panes.purge")}</button>
              </div></div>`
            : "";
          return `<article class="card trash-img" data-trash-img="${esc(im.id)}"><div class="body">
            <div class="trash-img-row">
              <button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"
                aria-label="${t("main.viewImage", { n: im.seq })}"><span class="tag-n">${t("images.imageN", { n: im.seq })}</span></button>
              <span class="trash-img-label">${t("panes.imageRow", { n: im.seq, when: esc(fmtWhen(im.removed_at)) })}</span>
            </div>${panel}
          </div></article>`;
        })
        .join("");
      return `<div class="trash-img-group"><p class="trash-img-owner">${esc(ownerLine(g.content))}</p>${rows}</div>`;
    })
    .join("");
  return `<div class="trash-imgs"><h4 class="trash-imgs-title">${t("panes.imagesTitle")}</h4>${groups}</div>`;
}

/** 已删配图那几行的点击(从 onTrashClick 分出来):缩略图 = 看大图;动作钮 = 还原 / 彻底删除;
 *  行别处 = 开合面板。返回 true = 这一下归它管。 */
function onTrashImageClick(el: HTMLElement): boolean {
  const rowEl = el.closest<HTMLElement>("[data-trash-img]");
  if (!rowEl) return false;
  const id = rowEl.dataset.trashImg!;
  const group = trashImgs.find((g) => g.images.some((im) => im.id === id));
  if (!group) return true;
  const thumb = el.closest<HTMLElement>(".thumb[data-img]");
  if (thumb) {
    const metas = group.images.map((im) => ({ id: im.id, seq: im.seq, mime: im.mime }));
    void openViewer(metas, metas.findIndex((m) => m.id === id), true);
    return true;
  }
  if (trashBusy) return true;
  const act = el.closest<HTMLElement>("[data-trash-img-act]")?.dataset.trashImgAct;
  if (!act) {
    clearConfirm();
    trashOpenId = trashOpenId === imgKey(id) ? null : imgKey(id);
    renderTrash();
    return true;
  }
  if (act === "restore") {
    void trashRun((space) => restoreItemImage(space, id), t("panes.restoredImage"));
  } else if (act === "purge") {
    confirmBar(t("panes.purgeImageQ"), t("panes.purge"), () => {
      // 确认期间列表可能已被远端刷新重载:那张图不在了就弃(绝不误删)。
      const still = trashImgs.some((g) => g.images.some((im) => im.id === id));
      if (!still || trashBusy) return;
      // A7(WM-04):彻底删除做完要说话(此前还原、清空都有回执,唯独它一声不吭)。
      void trashRun((space) => purgeItemImage(space, id), t("panes.purgedImage"));
    });
  }
  return true;
}

/** `done`:做完那句回执 —— 一句话(成功型),或一个自己出条的回调(还原那种带「去看看」的,A22)。 */
async function trashRun(op: (space: string) => Promise<unknown>, done: string | (() => void)) {
  if (trashBusy) return;
  const space = getCurrentSpace();
  trashBusy = true;
  renderTrash();
  try {
    await op(space);
    if (space === getCurrentSpace()) {
      if (typeof done === "string") showBar(done, true);
      else done();
    }
  } catch (err) {
    if (space === getCurrentSpace()) showErr(err);
  } finally {
    trashBusy = false;
    clearConfirm();
    if (space === getCurrentSpace()) {
      await loadTrash();
      void deps.refreshTimeline();
    }
  }
}

/** 一段的「清空」(Q1 / A19):确认句说清清的是哪一段、几条、几张配图;执行钮全宽(重破坏那一档)。 */
function askEmpty(sec: TrashSec, from: HTMLElement): void {
  const n = rowsOf(sec).length;
  const m = imgCount(sec);
  if ((!n && !m) || trashBusy) return;
  // 「几条」与「几张配图」各自为 0 时不说(「0 条和 2 张配图」是句空话)。
  const items = sec === "ideas" ? t("panes.whatNotes", { n }) : t("panes.whatTasks", { n });
  const images = t("panes.whatImages", { m });
  const what = m === 0 ? items : n === 0 ? images : t("panes.whatBoth", { items, images });
  const q = sec === "ideas" ? t("panes.emptyIdeasQ", { what }) : t("panes.emptyTasksQ", { what });
  confirmBar(
    q,
    t("panes.emptyTrashYes"),
    () => {
      if (trashBusy || (!rowsOf(sec).length && !imgCount(sec))) return; // 期间已重载成空/在写:弃
      void trashRun(
        (space) => (sec === "ideas" ? purgeArchived(space) : purgeArchivedTasks(space)),
        sec === "ideas" ? t("panes.ideasEmptied") : t("panes.tasksEmptied"),
      );
    },
    undefined,
    { from },
  );
}

function onTrashClick(e: Event) {
  const el = e.target as HTMLElement;
  const emptyBtn = el.closest<HTMLElement>("[data-trash-empty]");
  if (emptyBtn) {
    askEmpty(emptyBtn.dataset.trashEmpty as TrashSec, emptyBtn);
    return;
  }
  if (onTrashImageClick(el)) return;
  // 长卡的「展开 / 收起」(A16):只翻折叠,别冒到下面「点卡 = 开合操作面」那一支。
  if (onFoldClick(el)) return;
  // 条目自己的缩略图(A15):看大图(只读),不开合操作面。
  const thumb = el.closest<HTMLElement>(".thumb[data-img]");
  const thumbCard = thumb?.closest<HTMLElement>("[data-trash]");
  if (thumb && thumbCard) {
    if (thumb.classList.contains("err")) {
      thumb.classList.remove("err"); // 暂态读错不判死:点一下重试(同时间轴)
      void fillThumb(thumb);
      return;
    }
    const metas = trashRowImgs.get(thumbCard.dataset.trash!) ?? [];
    const idx = metas.findIndex((m) => m.id === thumb.dataset.img);
    if (idx >= 0) void openViewer(metas, idx, true);
    return;
  }
  const act = el.closest<HTMLElement>("[data-trash-act]")?.dataset.trashAct;
  if (!act) {
    // 点卡片本身 = 开合它的操作面板(至多一张开着,同归档册 / 同时间轴)。写在途整面禁点,
    // 与那两枚按钮的 disabled 同一条闸。
    // ⭐ **开合必须连底部确认条一起收**(照 `cardpanel.ts` 的 toggle:收面与换卡都 `clearConfirm()`)
    //    —— 否则「彻底删除」问到一半把卡收起来,屏底还挂着一句问谁都不知道的确认。
    const card = el.closest<HTMLElement>("[data-trash]");
    if (!card || trashBusy) return;
    clearConfirm();
    trashOpenId = trashOpenId === card.dataset.trash ? null : card.dataset.trash!;
    renderTrash();
    return;
  }
  if (trashBusy) return;
  const id = el.closest<HTMLElement>("[data-trash]")?.dataset.trash;
  const row = trashRows.find((r) => r.id === id);
  if (!row) return;
  const task = isTaskStage(row.stage);
  if (act === "restore") {
    // 146:恢复=回主视图,按该行冻结 stage 指路(任务回任务面、灵感回灵感面)。
    // 165 / W5 A22(两端同句,照桌面):说回到了哪儿 + 【去看看】(指南「还原的回执……带【去看看】」),时长同别的操作型回执;
    // ⛔ 不再写「在底栏「随记」里」—— 手机一横、平板上根本没有底栏(Q13 那句一起改)。任务说回到哪一列(列已不在 = 只说回到看板)。
    // 0043(backlog 170):原列 / 原看板已删 ⇒ 卡还原进了收容区(plan §3a),回执照实说(同桌面 boards.restoredHeld),
    // 「去看看」经 focusCard 切到收容区那一格。⛔ 别再说「已还原到「X」列」—— 那一列已经不在看板上了。
    const col = task ? stageLabel(row.stage) : undefined;
    const msg = task
      ? isHeldStage(row.stage)
        ? t("boards.restoredHeld")
        : col !== undefined
          ? t("trash.restoredTask", { col })
          : t("trash.restoredBoard")
      : row.doc_at !== null
        ? t("trash.restoredDoc")
        : t("trash.restoredNote");
    const id = row.id;
    void trashRun(
      (space) => (task ? restoreTask(space, id) : restoreNote(space, id)),
      () => actionBar(msg, t("cardpanel.goSee"), () => deps.focusCard(id)),
    );
    return;
  }
  if (act === "purge") {
    // 159(主控补,对齐桌面 trash.purgeOne*Q):确认写「无法恢复」,带图时说清连带删掉几张(这一条自己的配图)。
    const m = trashRowImgs.get(row.id)?.length ?? 0;
    const q = m > 0 ? t("panes.purgeOneImagesQ", { m }) : t("panes.purgeOneQ");
    confirmBar(q, t("panes.purge"), () => {
      // 确认期间列表可能已被远端刷新重载:按 id 重取现行,行没了就弃(绝不误删别行)。
      const fresh = trashRows.find((r) => r.id === row.id);
      if (!fresh || trashBusy) return;
      const freshTask = isTaskStage(fresh.stage);
      // A7(WM-04):彻底删除做完要说话。165 / W5 Q15:找不回的那一下写出删的是哪一条(「已彻底删除「…」」,
      // 字多了按字数读秒自然停久一点);整条没字(只有图)就照旧那一句。
      const name = itemSnippet(fresh.content);
      void trashRun(
        (space) => (freshTask ? purgeTask(space, fresh.id) : purgeNote(space, fresh.id)),
        name === "" ? t("panes.purged") : t("trash.purgedNamed", { name }),
      );
    });
  }
}

// ---- 归档册 -------------------------------------------------------------------

let sealedSeq = 0;
let sealedBusy = false;
let sealedRows: import("./api").TaskItem[] = [];
/** 展开着操作面板的那张卡(同一时刻至多一张,与时间轴卡片同一个手势);null = 一张都没开。
 *  归档册是只读视图,**静默才是常态** —— 508 起那枚「取消入册」不再常驻(design-rules
 *  「只读视图只留离场动作、且不常驻」),点卡片才出、再点收起。 */
let sealedOpenId: string | null = null;
/** 0043(用户拍 ⑦,backlog 170):归档册按看板筛 —— 正筛着哪块看板;null = 全部。本机 UI 态,换空间清。 */
let sealedBoard: string | null = null;

/** 这台此刻正看着的那块活看板(筛选排里恒在的那一枚、进面时预选的那一枚);正看着收容区 = 没有「当前看板」。 */
function sealedCurrent(): Board | null {
  const v = currentView(getCurrentSpace());
  return v === HOLDING ? null : v;
}

/** `entering` = 用户这一下**开**归档面(main.ts openPane);面开着时的重载(远端变更 / 取消归档之后)不给,筛选留在人选的那一枚上。 */
export async function loadSealed(entering = false): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++sealedSeq;
  const box = $("sealed-list");
  box.innerHTML = `<p class="muted empty">${t("panes.loading")}</p>`;
  try {
    // 列与看板同批取(同回收站那条):每条要按「来自哪块看板」标签 / 筛,⛔ 别指望主时间轴那轮已经登记过。
    const [rows, cols, bds] = await Promise.all([listSealedTasks(space), listBoardColumns(space), listBoards(space)]);
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    setColumns(cols);
    setBoards(bds);
    sealedRows = rows;
    // 902(用户拍 R4):进面恒选当前看板(它没有归档就是那句「这块看板还没有归档的卡片」);只有一块活看板的库照旧不筛。
    if (entering) sealedBoard = liveBoards().length >= 2 ? (sealedCurrent()?.id ?? null) : null;
    // 从搜索点进来要定位那一条:先回「全部」,免得它正好被筛掉、落空。
    if (sealedLocate !== null) sealedBoard = null;
    // 重载后那张卡可能已经不在(自己刚取消入册 / 对端动过):展开态跟着作废。
    // ⛔ 别留着 —— 那个 id 若还挂着,下一次渲染会把面板开在一张**别的**卡上是不可能的
    // (按 id 匹配),但它会让「其实没有卡开着」的状态无声地存活到下一轮。
    if (sealedOpenId !== null && !rows.some((r) => r.id === sealedOpenId)) sealedOpenId = null;
    renderSealed();
    const want = sealedLocate; // A14:同回收站那条
    sealedLocate = null;
    if (want !== null) applyLocate(box, `[data-sealed="${want.id}"]`, want);
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    sealedLocate = null;
    sealedRows = [];
    sealedOpenId = null;
    box.innerHTML = `<p class="empty warn-ink">${t("panes.sealedLoadFailed", { error: esc(errDetail(err)) })}</p>`;
  }
}

/** 取消归档回哪儿(mbopt R4:点名那一列,⛔ 别写死「已完成」—— 各块看板的完成列各叫各的):回原列;原列 / 原看板已删 ⇒ 收容区。 */
const unsealDest = (status: string): string => (isHeldStage(status) ? t("boards.holdingPill") : stageLabel(status)!);

function renderSealed() {
  const box = $("sealed-list");
  // 0043(用户拍 ⑦,同桌面 renderSealed):成就合一本,筛的是看板、不是列:来处按卡所在列的归属认(删掉的看板也算一块)。
  // 902(用户拍 R4):**活看板 ≥ 2 块**时顶上那排筛选恒出现 ——「全部看板」+ 当前看板(恒在,哪怕它没有归档)+ 其他有归档的看板。
  // 只有一块活看板的库照旧:归档来自 ≥ 2 块看板(另一块已删)才出那排,否则不出(一枚「全部」是噪音)。
  // ⛔ 活看板只有一块时别把它硬塞进那排:已删的看板也在表里,会凭空挂上「任务」。
  const fromOf = (r: { status: string }): string | null => boardOfStage(r.status)?.id ?? null;
  const multi = liveBoards().length >= 2;
  const curId = multi ? (sealedCurrent()?.id ?? null) : null;
  const pillBoards = allBoards().filter((b) => b.id === curId || sealedRows.some((r) => fromOf(r) === b.id));
  const tagged = multi || pillBoards.length >= 2;
  if (!tagged || !pillBoards.some((b) => b.id === sealedBoard)) sealedBoard = null;
  if (!tagged && !sealedRows.length) {
    box.innerHTML = `<p class="muted empty">${t("panes.sealedEmpty")}</p>`;
    return;
  }
  const shown = sealedBoard === null ? sealedRows : sealedRows.filter((r) => fromOf(r) === sealedBoard);
  const pill = (label: string, id: string | null): string =>
    `<button type="button" class="fpill${sealedBoard === id ? " active" : ""}" aria-pressed="${sealedBoard === id}" data-sealed-board="${esc(id ?? "")}">${esc(label)}</button>`;
  const pills = tagged
    ? `<div class="fstages sealed-boards">${pill(t("boards.sealedAll"), null)}${pillBoards.map((b) => pill(boardName(b), b.id)).join("")}</div>`
    : "";
  const cards = shown
    .map((r) => {
      const panel =
        r.id === sealedOpenId
          ? `<div class="panel"><div class="acts">
              <button data-unseal="${esc(r.id)}"${sealedBusy ? " disabled" : ""}>${t("panes.unseal", { col: esc(unsealDest(r.status)) })}</button>
            </div></div>`
          : "";
      const tint = cardTint(r.color);
      // 165 / W5 A44:归档卡也画标签(同回收站 / 搜索那一形)—— 此前不画,看不出归档时分类保没保留(搜索结果里同一张却带着)。
      const chips = r.topics
        .map(
          (tp) =>
            `<span class="chip${tp.color ? " tinted" : ""}"${tp.color ? ` style="--tc:${esc(tp.color)}"` : ""}>${esc(tp.title)}</span>`,
        )
        .join("");
      const from = tagged ? boardOfStage(r.status) : undefined;
      const tag = from ? `<span class="pill">${esc(boardName(from))}</span>` : "";
      return `<article class="card${tint.cls}"${tint.attr} data-sealed="${esc(r.id)}"><div class="body">
        <p class="content">${contentHtml(r.title, false)}</p>
        <footer>${tag}<time>${
          // 158 G3 / Q13(WM-17):归档页的卡恒写日期 —— 今天完成的此前只写「完成于 13:xx」,翻到这页看不出是哪天。
          r.done_at
            ? t("panes.doneAt", { when: esc(fmtWhen(r.done_at)) })
            : t("panes.sealedAt", { when: esc(fmtWhen(r.sealed_at!)) })
        }</time>${chips}</footer>${panel}
      </div></article>`;
    });
  // 筛着某块看板而它没有归档 = 「这块看板还没有归档的卡片」;在「全部看板」上还是空的 = 整本都空,照旧那句。
  const list =
    cards.length > 0
      ? splitCols(cards, colsOf(box))
      : `<p class="muted empty">${sealedBoard === null ? t("panes.sealedEmpty") : t("boards.sealedNoneHere")}</p>`;
  // 整排是重画的(横向滚动位随 innerHTML 归零)⇒ 先摆回重画前的位置,再把选中那枚挪进可视区(903,用户拍):
  // 902 起进面恒选当前看板,看板一多它可能半出屏。⛔ 只动这一排自己的 scrollLeft,别用 scrollIntoView —— 那会带着整页竖向滚。
  const prevLeft = box.querySelector<HTMLElement>(".sealed-boards")?.scrollLeft ?? 0;
  box.innerHTML = pills + list;
  const strip = box.querySelector<HTMLElement>(".sealed-boards");
  const on = strip?.querySelector<HTMLElement>(".fpill.active");
  if (strip && on) {
    strip.scrollLeft = prevLeft;
    const s = strip.getBoundingClientRect();
    const a = on.getBoundingClientRect();
    const pad = 12; // 贴边留一点,看得出两侧还有
    if (a.left < s.left + pad) strip.scrollLeft += a.left - s.left - pad;
    else if (a.right > s.right - pad) strip.scrollLeft += a.right - s.right + pad;
  }
}

function onSealedClick(e: Event) {
  const el = e.target as HTMLElement;
  const pick = el.closest<HTMLElement>("[data-sealed-board]");
  if (pick) {
    // 换筛选 = 本机 UI 态,不写库;展开着的那张若被筛掉就一起收(同重载那条)。
    sealedBoard = pick.dataset.sealedBoard || null;
    sealedOpenId = null;
    renderSealed();
    return;
  }
  const id = el.closest<HTMLElement>("[data-unseal]")?.dataset.unseal;
  if (!id) {
    // 点卡片本身 = 开合它的操作面板(至多一张开着,同时间轴那套)。写在途时整面禁点,
    // 与那枚按钮的 disabled 同一条闸。
    const card = el.closest<HTMLElement>("[data-sealed]");
    if (!card || sealedBusy) return;
    sealedOpenId = sealedOpenId === card.dataset.sealed ? null : card.dataset.sealed!;
    renderSealed();
    return;
  }
  if (sealedBusy) return;
  const space = getCurrentSpace();
  // 回执说回到哪一列(mbopt R4):按点的那一刻屏上这张卡的来处算(钮上写的也是它)。
  const dest = unsealDest(sealedRows.find((r) => r.id === id)!.status);
  sealedBusy = true;
  renderSealed(); // 立即画出禁用态(同 trashRun 的形):连点不许并发提交同一条
  void (async () => {
    try {
      await unsealTask(space, id);
      // 158 G2(W2 走查 A6 / A20,WM-20):回执带「撤销」= 再归档回去(同归档回执那枚的反向),
      // 读秒随之是操作型回执的 6 s(此前按字数 3 s,与别的回执长短不一)。
      // 158 G3 / Q3:另挂「去看看」= 回任务面落到那张卡(收归档页、滚过去、闪一下)。
      if (space === getCurrentSpace())
        actionBar(
          t("panes.unsealed", { col: dest }),
          t("ui.undo"),
          () => {
            if (space !== getCurrentSpace()) return; // 换空间的旧撤销作废
            void (async () => {
              let ok = false;
              try {
                await sealTask(space, id);
                ok = true;
              } catch (err) {
                showErr(err);
              }
              await loadSealed();
              void deps.refreshTimeline();
              if (ok && space === getCurrentSpace()) showUndone(); // 165 / W5 Q6
            })();
          },
          { label: t("cardpanel.goSee"), on: () => deps.focusCard(id) },
        );
    } catch (err) {
      if (space === getCurrentSpace()) showErr(err);
    } finally {
      sealedBusy = false;
      if (space === getCurrentSpace()) {
        await loadSealed();
        void deps.refreshTimeline();
      }
    }
  })();
}

// ---- 搜索 --------------------------------------------------------------------

const SEARCH_STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: t("panes.hitInbox"),
  processed: t("panes.hitProcessed"),
  doc: t("panes.hitDoc"),
  task: t("panes.hitTask"),
  archived: t("panes.hitArchived"),
  sealed: t("panes.hitSealed"),
};

// 回收站里的命中写「回收站 · 任务 / 随记 / 长文」(159 / W3 Q12,WM-29:此前只写「回收站」,看不出原来是什么)。
// 用词与另几枚章同一份(「随记」「任务」「长文」),⛔ 别另起一套。
const TRASH_KIND_LABEL: Record<NonNullable<SearchHitItem["trash_kind"]>, string> = {
  idea: t("panes.hitInbox"),
  task: t("panes.hitTask"),
  doc: t("panes.hitDoc"),
};
function hitLabel(h: SearchHitItem): string {
  if (h.status !== "archived") return SEARCH_STATUS_LABEL[h.status] ?? h.status;
  // core 对回收站行恒给 trash_kind(213e3c7a);缺 = 契约断了,响亮抛(同桌面 search.ts::badgeLabel,不猜)。
  if (h.trash_kind === null) throw new Error(`search: archived hit ${h.id} without trash_kind`);
  return t("panes.hitTrashKind", { kind: TRASH_KIND_LABEL[h.trash_kind] });
}

let searchSeq = 0;
/** 最近一次搜到的命中(转屏重画用;加载中 / 空词 / 出错时不留)。 */
let searchHits: SearchHitItem[] = [];
/** 屏上这批**结果卡**是哪个词搜出来的(trim 后);标红按它。"" = 屏上不是结果(提示 / 搜索中 / 没找到 / 出错)。 */
let shownQuery = "";
/** 屏上那一屏(结果 / 没找到 / 提示)是替哪个词画的:输入框里的词与它不同 = 「改了词」(Q8 / WM-24)。
 *  null = 屏上那一屏已经作废(改过词、清掉了旧结果,还没换上新的)—— 这时哪怕改回原来那个词也得重搜:
 *  「改一个字又删掉」的那一下,旧结果已经清了、在途那一趟也作废了,不重搜就停在「搜索中…」。 */
let askedQuery: string | null = "";
/** 打字停一下再搜(159 / W3 Q8:和桌面一样打完自动出;§2.4 `INPUT_DEBOUNCE`)。 */
let searchTimer: number | undefined;

const searchInput = (): HTMLInputElement => $("search-input") as HTMLInputElement;
const searchWords = (q: string): string[] => q.split(/\s+/).filter((w) => w !== "");

function renderHits() {
  const box = $("search-results");
  // Q8(WM-15):写「N 条匹配」;A4(WM-06):「改过的旧版本也一起搜」那句有结果时也在(此前只在空态露脸)。
  const head = `<p class="hit-head"><b>${t("panes.searchCount", { n: searchHits.length })}</b> · ${t("panes.searchPrompt")}</p>`;
  box.innerHTML =
    head +
    splitCols(
      searchHits.map((h) => {
        // 159 / W3 A16(WM-11):长条目照时间轴卡夹到八行(settleFolds 量)、长文照长文列表卡画(不露 `#`)。
        // 回收站里的长文看 `trash_kind`(core 判的归属,前端不另判)。
        const isDoc = h.status === "doc" || h.trash_kind === "doc";
        const body = isDoc ? docBodyHtml(h.content) : `<p class="content clamped">${contentHtml(h.content, false)}</p>`;
        // A4(WM-06):只在改过的旧版本里命中 —— 卡上画的是现在的正文,里面没有那个词、不标红,得说一声。
        const old = h.history_only ? `<span class="chip old-hit">${t("panes.oldVersionHit")}</span>` : "";
        return `<article class="card${isDoc ? " doc-card" : ""}" data-hit="${esc(h.id)}" data-hit-status="${esc(h.status)}"><div class="body">
              ${body}
              <footer><span class="pill">${esc(hitLabel(h))}</span>${old}
                <time>${esc(fmtWhen(h.created_at))}</time>
                ${h.topics.map((tp) => `<span class="chip">${esc(tp)}</span>`).join("")}</footer>
            </div></article>`;
      }),
      colsOf(box),
    );
  // Q8(WM-15):命中词标红 —— 只标正文(题目 / 摘要 / 正文),不标卡脚的章与标签。⚠ 排在量折叠之前(标红改字重)。
  const words = searchWords(shownQuery);
  for (const el of box.querySelectorAll<HTMLElement>(".card .content, .card .doc-title, .card .doc-ex")) markHits(el, words);
  settleFolds(box);
}

/** 作废在途的查询并把结果区换成「词变了」之后该有的样子(Q8 / WM-24:一改词就先清掉旧结果,别让旧结果挂在新词下面)。 */
function dropShownHits(q: string, pending: boolean): void {
  searchSeq++;
  searchHits = [];
  shownQuery = "";
  askedQuery = null;
  $("search-results").innerHTML = `<p class="muted empty">${pending && q !== "" ? t("panes.searching") : t("panes.searchPrompt")}</p>`;
}

async function runSearch() {
  window.clearTimeout(searchTimer);
  // 序号先行(实现审 L7):空查询也要作废在途的旧查询——否则「清空再点搜」后,
  // 旧查询的迟到结果会把空态盖回旧列表。
  const space = getCurrentSpace();
  const seq = ++searchSeq;
  const q = searchInput().value.trim();
  const box = $("search-results");
  askedQuery = q;
  searchHits = [];
  shownQuery = "";
  if (!q) {
    box.innerHTML = `<p class="muted empty">${t("panes.searchPrompt")}</p>`;
    return;
  }
  box.innerHTML = `<p class="muted empty">${t("panes.searching")}</p>`;
  try {
    const hits = await searchNotes(space, q);
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    searchHits = hits;
    if (hits.length) {
      shownQuery = q;
      renderHits();
    } else {
      // 901:没结果时多说一句怎么办;有多个空间(判法同顶栏空间徽章显不显:main.ts::renderSpaceChip)再接一句「只搜当前空间」。
      // 两句各是一个键;英文句间要一个空格、中文句号后不要(拼接处定,不写进字典值的首尾)。
      const gap = currentLang() === "en" ? " " : "";
      const other = deps.getSpaces().length > 1 ? `${gap}<span class="search-other-spaces">${t("panes.searchOtherSpaces")}</span>` : "";
      box.innerHTML = `<p class="muted empty">${t("panes.searchNoHit", { q: esc(q) })}${other}</p>`;
    }
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    searchHits = [];
    shownQuery = "";
    box.innerHTML = `<p class="empty warn-ink">${t("panes.searchFailed", { error: esc(errDetail(err)) })}</p>`;
  }
}

/** 打字停一下再搜(Q8)。⛔ 中文输入法组字期间(`isComposing`)不触发:那时框里是拼音字母,搜了也是白搜一趟 IPC;
 *  上屏那一刻(`compositionend`)再排。词没变(比如只多打了个空格)不重搜。 */
function scheduleSearch(): void {
  window.clearTimeout(searchTimer);
  if (searchInput().value.trim() === askedQuery) return;
  searchTimer = window.setTimeout(() => void runSearch(), INPUT_DEBOUNCE_MS);
}

function onSearchInput(e: Event): void {
  const q = searchInput().value.trim();
  const composing = (e as InputEvent).isComposing === true;
  if (q !== askedQuery) dropShownHits(q, !composing);
  if (q === "") {
    // 删空了:当场回提示(不等去抖),在途的作废。
    window.clearTimeout(searchTimer);
    askedQuery = "";
    return;
  }
  if (composing) {
    window.clearTimeout(searchTimer);
    return;
  }
  scheduleSearch();
}

/** 搜到了要到得了(ui-audit P1 #8):活跃条目回时间轴 / 长文定位,回收站 / 归档册命中切到对应面并定位到那一条(A14)。
 *  都经 main.ts 的 `jumpFromSearch`:它负责「按一次返回回到这里」那一层(A3)。 */
function onSearchClick(e: Event) {
  if (onFoldClick(e.target as HTMLElement)) return; // 长卡的「展开 / 收起」只翻折叠,不跳走(A16)
  const card = (e.target as HTMLElement).closest<HTMLElement>("[data-hit]");
  if (!card) return;
  const hit = searchHits.find((h) => h.id === card.dataset.hit);
  if (!hit) return;
  window.clearTimeout(searchTimer); // 正要排的那一趟重搜作废:人已经点进去了
  deps.jumpFromSearch(hit);
}

/** 开搜索面(main.ts::openPane 调):空着时把空态那句话画上(UI 一致性 M8)。
 *  ⚠ 只在真空时画:关面再开时上一轮的结果与输入框里的词都还留着(既有行为),别拿空态盖掉。
 *  ⭐ 159 / W3 A17(WM-12):**有结果时不把焦点塞回框里** —— 从结果点进去再回来、或顶栏再开一次,是接着看结果的;
 *  此前一律 focus ⇒ 键盘弹起盖半屏、页面被滚回顶。要换词点一下框就是。 */
export function focusSearch() {
  const box = $("search-results");
  if (box.innerHTML === "") box.innerHTML = `<p class="muted empty">${t("panes.searchPrompt")}</p>`;
  // 上次的结果卡留着(不重画),它们的夹线是当时那一档字号按 px 算死的 ⇒ 开面时按现在这一档重量一遍(同时间轴关面那条,fold.ts)。
  resettleFolds("#search-results");
  if (!box.querySelector(".card")) searchInput().focus();
}

// ---- 跳到回收站 / 归档册里那一条(159 / W3 A14,WM-07 / X-07)-------------------------------
// 此前点回收站里的命中只到回收站顶部,那条在屏外。⇒ 开面那趟读完、画好之后滚到那张卡、挂定位框;
// 回收站 159 起分「随记」「任务」两段,那张卡本来就画在它那一段里,滚到它就是到了对应段。
type Locate = { id: string; note: string | null };
let trashLocate: Locate | null = null;
let sealedLocate: Locate | null = null;

/** 下一次那一面画好时落到这一条(main.ts 开面**之前**调)。`note` = 落点卡上要说的一句(只在旧版本命中,A4)。 */
export function locateInPane(pane: "trash" | "sealed", id: string, note: string | null): void {
  if (pane === "trash") trashLocate = { id, note };
  else sealedLocate = { id, note };
}

function applyLocate(box: HTMLElement, sel: string, want: Locate): void {
  const card = box.querySelector<HTMLElement>(sel);
  if (!card) {
    showError(t("panes.locateGone")); // 期间被还原 / 彻底删 / 取消归档了:响亮说,不静默停在顶上
    return;
  }
  if (want.note !== null) {
    const p = document.createElement("p");
    p.className = "locate-note";
    p.textContent = want.note;
    card.querySelector(".body")?.append(p);
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  markLocated(card);
}

/** 切空间后清空各面的陈旧内容(面会随 pane 关闭,重开时现读)。 */
export function resetPanesForSpaceChange() {
  trashSeq++;
  sealedSeq++;
  searchSeq++;
  trashRows = [];
  trashImgs = [];
  trashRowImgs = new Map();
  trashOpenId = null;
  sealedRows = [];
  sealedOpenId = null;
  sealedBoard = null;
  clearConfirm();
  searchHits = [];
  shownQuery = "";
  askedQuery = "";
  window.clearTimeout(searchTimer);
  trashLocate = null;
  sealedLocate = null;
  $("trash-list").innerHTML = "";
  $("sealed-list").innerHTML = "";
  $("search-results").innerHTML = "";
  ($("search-input") as HTMLInputElement).value = "";
}

export function initPanes(d: Deps) {
  deps = d;
  $("trash-pane").addEventListener("click", onTrashClick);
  $("sealed-pane").addEventListener("click", onSealedClick);
  $("search-results").addEventListener("click", onSearchClick);
  $("search-btn").addEventListener("click", () => void runSearch());
  $("search-input").addEventListener("input", onSearchInput);
  // 组字上屏那一刻补排一趟(组字期间的 input 不排,见 scheduleSearch)。
  $("search-input").addEventListener("compositionend", scheduleSearch);
  watchCols($("trash-list"), renderTrash);
  watchCols($("sealed-list"), renderSealed);
  watchCols($("search-results"), renderHits);
  $("search-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).isComposing) return; // IME 组合期的 Enter 是上屏,不是搜索
    if ((e as KeyboardEvent).key !== "Enter") return;
    void runSearch(); // 不等去抖:回车就是「现在搜」
    // 165 / W5 Q9:键盘右下那颗键 = 收键盘(结果边打边出、早就在了;此前按了没变化、键盘一直挡着下半屏)。
    searchInput().blur();
  });
}
