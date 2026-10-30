// 长文面(longform-plan 第 4 格;桌面那份是 src/docs.ts)。随记写长了「展开成长文」挪到这儿:
// 按 Markdown 显示,编辑时边写边存本机草稿、点「保存」或离开编辑器才落一版,任意两版可以比对。
//
// 它是一个**面**(main.ts 的 openPane("docs"),底栏「长文」钮按数据显形,同回收站 / 归档册);
// 面里四种页,`page` 说现在是哪种:
//   - list —— 全部长文(`list_docs`,core 的主归属判谁是长文,⛔ 这里不按 stage / doc_at 另判);
//   - doc  —— 一篇的阅读页;
//   - edit —— 编辑器(`id = null` = 还没存过的新长文,第一次保存走 `capture_doc` 才有 id);
//   - hist —— 历史与比对。
// ⭐ 返回键:面只压一枚守门条目。不在列表页时,返回键由 `docsBack()` 收成「回上一页」,main.ts
// 随后补压一枚(同编辑层「改过了就拦一句」那形);在列表页才轮到关面。
//
// ⭐ 全部写命令钉在**开面那刻的空间**(`space`):离开编辑器要落一版,而「离开」也可能是关面 /
// 面换面引起的 —— 后端只认前台空间,切走之后那一发会被响亮拒,草稿留在本机,下次打开会问。
//
// 渲染:正文走共用的 `shared/markdown-dom.ts`,比对走 `shared/diff-dom.ts`(两份都只用
// createElement + 文本节点,安全落点只在那两处);本文件只拿它们返回的节点直接挂,⛔ 不序列化
// 再拼、不另起链接提取器。其余面(时间轴 / 回收站 / 搜索 / 标签)照旧不渲染 Markdown(§3)。
// 本文件自己的外壳用 createElement 建;正文一个字都不进 innerHTML。
//
// 编辑器里的配图(152 补):已存过的篇同卡片编辑层(加图当场挂上、× 只做「保存时删」的标记),
// 新篇先暂存、第一次保存拿到 id 再挂(同桌面)。本期没有的:复制链接(手机随记也没有)。
// 跨空间移动在阅读页「更多…」里,照卡片操作面那套(§2.7)。
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  addItemImage,
  archiveNote,
  captureDoc,
  deleteItemImage,
  editNote,
  fileNoteToTopic,
  getCurrentSpace,
  distinctSpaceLabels,
  itemDeepLink,
  listDocs,
  listItemImages,
  listRevisions,
  listTopics,
  moveItemToSpace,
  movePartialClear,
  movePartialMark,
  movePartialNote,
  removeNoteTopic,
  restoreNote,
  revisionTexts,
  setDoc,
  type IdeaItem,
  type ImageMeta,
  type RevisionCatalog,
  type RevisionMeta,
  type SpaceInfo,
  type TopicItem,
} from "./api";
import { renderMarkdown } from "../../shared/markdown-dom";
import { imgRefText } from "../../shared/markdown";
import { renderDiff } from "../../shared/diff-dom";
import { toggleChecklistLine } from "../../shared/checklist";
import { HAS_BROWSER, writeClipboard } from "./platform";
import { commentBadgeHtml, loadCommentCounts } from "./comments";
import { figureSrc, hydrateThumbs } from "./thumbs";
import { openViewer } from "./viewer";
import { capturePhoto, PICK_MAX, pickImages, toBase64 } from "./images";
import { t } from "./i18n";
import { $, actionBar, confirmBar, fmtWhen, hideConfirmBar, showBar } from "./ui";
import { errDetail, showErr } from "./err";

type Deps = {
  /** 开留言层(main.ts openCommentsFor,与卡上 💬 徽章同一个入口)。 */
  openComments: (itemId: string) => void;
  /** 写成功后的整轴重拉(底栏「长文」钮的显形真值随它走)。 */
  refreshTimeline: () => Promise<void>;
  /** 当前空间列表(main.ts spacesCache 影子):「移动」按数量显形、选择器列它。 */
  getSpaces: () => SpaceInfo[];
};
let deps: Deps;

type Page = { kind: "list" } | { kind: "doc"; id: string } | { kind: "edit"; id: string | null } | { kind: "hist"; id: string };

let space = "";
let page: Page = { kind: "list" };
let docs: IdeaItem[] = [];
let loadSeq = 0;
/** 阅读页的底栏动作在哪一档:主行 / 「更多…」/ 标签 / 移动选择器。 */
let readerMode: "main" | "more" | "tags" | "move" = "main";
let busy = false;
/** 跨面「打开这一篇」(搜索命中 / 深链 / 展开后的回执):开面后第一次读到列表时落地。 */
let pendingFocus: string | null = null;
/** 编辑器开着时:离开它的那条路(保存再走)、返回键(存完回这一篇 —— 新篇建成了就回它的阅读页,
 *  同「保存」钮;⛔ 别按 `page.id` 判:新篇建成后它仍是 null)与关面那一发(不等、不碰 DOM)。 */
let editor: { leave: (then: () => void) => void; back: () => void; flush: () => void } | null = null;

const root = (): HTMLElement => $("docs-body");

// ---- 小件 ------------------------------------------------------------------------

type Kids = (Node | string | null)[];
function el(tag: string, cls: string, kids: Kids = []): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k !== null) e.append(k);
  return e;
}
function btn(label: string, onClick: () => void, cls = ""): HTMLButtonElement {
  const b = el("button", cls, [label]) as HTMLButtonElement;
  b.type = "button";
  b.disabled = busy;
  b.addEventListener("click", onClick);
  return b;
}

/** 列表与标签展开面用的题目:第一行非空字,去掉开头的 `#`(同桌面 docTitle)。 */
export function docTitle(content: string): string {
  let from = 0;
  while (from < content.length) {
    let end = content.indexOf("\n", from);
    if (end < 0) end = content.length;
    const s = content.slice(from, end).replace(/^#{1,6}\s+/, "").trim();
    if (s !== "") return s;
    from = end + 1;
  }
  return "";
}
/** 列表卡上题目下面那两行:摘掉行首的 Markdown 记号与行内 ** __ ` —— 只是给眼睛扫的字,
 *  ⛔ 不是渲染(列表卡不进 Markdown 渲染器)。同桌面 excerpt。 */
function excerpt(content: string, title: string): string {
  const head = content.slice(0, 600);
  const at = title === "" ? 0 : head.indexOf(title);
  const rest = at < 0 ? head : head.slice(at + title.length);
  return rest
    .split("\n")
    .map((l) => l.replace(/^\s*(#{1,6}\s+|>\s?|(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|`{3,}.*$|-{3,}\s*$)/, "").replace(/\*\*|__|`/g, ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 草稿(§2:只存本机、不同步、不进历史)-------------------------------------------
// 键 = 空间 + 条目(新建那篇用 "new");值带**代次**:正式保存成功后只清自己提交的那一代,
// 保存在途时又敲的字(更新的代次)留着。⛔ 不静默套用:重开一篇时草稿与正文不同,明说并给
// 「接着改 / 丢掉」。丢了最坏 = 回到上次保存那一版,所以存不进去只报一句、不拦正式保存。
type Draft = { text: string; gen: number; at: string };
const DRAFT_PREFIX = "zhujian.doc-draft:";
const DRAFT_IDLE_MS = 1000; // 停笔这么久存一次
let draftGen = Date.now(); // 单调递增即可;起点取时刻,跨重启也不会比旧代次小

function draftKey(sp: string, id: string | null): string {
  return `${DRAFT_PREFIX}${sp}:${id ?? "new"}`;
}
function loadDraft(sp: string, id: string | null): Draft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(draftKey(sp, id));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<Draft>;
    if (typeof v.text !== "string" || typeof v.gen !== "number" || typeof v.at !== "string") return null;
    return { text: v.text, gen: v.gen, at: v.at };
  } catch {
    return null;
  }
}
/** 写一代草稿,返回代次;写不进去照抛(调用方要让人知道)。 */
function saveDraft(sp: string, id: string | null, text: string): number {
  const gen = ++draftGen;
  localStorage.setItem(draftKey(sp, id), JSON.stringify({ text, gen, at: new Date().toISOString() }));
  return gen;
}
/** 只清 `gen` 这一代(及更早);存着的是更新的一代就不动。`gen = null` = 不论代次都清。 */
function clearDraft(sp: string, id: string | null, gen: number | null): void {
  const d = loadDraft(sp, id);
  if (d === null) return;
  if (gen !== null && d.gen > gen) return;
  try {
    localStorage.removeItem(draftKey(sp, id));
  } catch {
    /* 清不掉 = 下次打开时再问一次「接着改 / 丢掉」,不影响正文 */
  }
}

// ---- 入口(main.ts 调)------------------------------------------------------------

export function initDocs(d: Deps): void {
  deps = d;
  $("docs-new").addEventListener("click", () => {
    if (page.kind !== "list" || busy) return;
    openEditor(null, loadDraft(space, null)?.text ?? null, []);
  });
}

/** 开面(main.ts openPane("docs")):回列表页、现读;有挂着的定位就直接落到那一篇。 */
export function openDocs(): void {
  space = getCurrentSpace();
  page = { kind: "list" };
  readerMode = "main";
  void load();
}

/** 从「记一笔」起一篇新长文(main.ts 开面之后调;backlog 152 ③:一篇长文都没有时底栏没有
 *  「长文」钮,第一篇从这儿进)。框里的字接在没写完的新篇草稿后面(⛔ 不覆盖它),先落成一代
 *  草稿再交给编辑器 —— 调用方随即清掉「记一笔」那份,杀进程时字在这边。暂存图进新篇那条纯内存
 *  暂存条(第一次保存才挂上,同新篇自己加的图)。 */
export function startDocFrom(text: string, files: File[]): void {
  loadSeq++; // 开面那趟读列表作废:读失败会整页换成报错,把编辑器冲掉
  const prior = loadDraft(space, null)?.text ?? "";
  const seed = prior !== "" && text !== "" ? `${prior}\n\n${text}` : prior + text;
  if (text !== "") {
    try {
      saveDraft(space, null, seed);
    } catch {
      /* 存不进去:字仍在编辑器里,停笔那一发会再试并明说(同编辑器自己的草稿) */
    }
  }
  openEditor(null, seed === "" ? null : seed, files);
}

/** 跨面打开某一篇:先记下,开面后读到列表时落地(找不到就明说)。 */
export function focusDoc(id: string): void {
  pendingFocus = id;
}

/** 返回键(面开着时):不在列表页就回上一页并返回 true;在列表页返回 false(由 main.ts 关面)。 */
export function docsBack(): boolean {
  hideConfirmBar();
  if (page.kind === "list") return false;
  if (page.kind === "edit") {
    editor?.back();
    return true;
  }
  if (page.kind === "hist") go({ kind: "doc", id: page.id });
  else if (page.kind === "doc" && readerMode !== "main") {
    readerMode = readerMode === "move" ? "more" : "main";
    render();
  } else go({ kind: "list" });
  return true;
}

/** 面被关掉 / 换成别的面(main.ts closePaneNow / openPane):编辑器开着就落一版(不等)。 */
export function closeDocs(): void {
  editor?.flush();
  page = { kind: "list" };
  readerMode = "main";
  loadSeq++;
}

/** 远端变更时面开着(main.ts refreshActivePane):编辑 / 比对中不重画(会把输入与选好的两版冲掉)。 */
export function reloadDocs(): void {
  if (page.kind === "edit" || page.kind === "hist" || busy) return;
  void load();
}

/** 换空间:另一份库,旧空间的列表与定位一律作废。 */
export function resetDocsForSpaceChange(): void {
  closeDocs();
  docs = [];
  pendingFocus = null;
  root().replaceChildren();
}

// ---- 读与页面切换 ------------------------------------------------------------------

function go(next: Page): void {
  hideConfirmBar();
  page = next;
  readerMode = "main";
  void load();
}

async function load(): Promise<void> {
  const sp = space;
  const seq = ++loadSeq;
  if (docs.length === 0) root().replaceChildren(el("p", "muted empty", [t("docs.loading")]));
  let list: IdeaItem[];
  try {
    [list] = await Promise.all([listDocs(sp), loadCommentCounts(sp)]);
  } catch (err) {
    if (seq !== loadSeq || sp !== getCurrentSpace()) return;
    root().replaceChildren(el("p", "empty warn-ink", [t("docs.loadFailed", { error: errDetail(err) })]));
    return;
  }
  if (seq !== loadSeq || sp !== getCurrentSpace()) return;
  docs = list;
  if (pendingFocus !== null) {
    const id = pendingFocus;
    pendingFocus = null;
    if (docs.some((d) => d.id === id)) page = { kind: "doc", id };
    else {
      page = { kind: "list" };
      showBar(t("docs.notFound"));
    }
  }
  if ((page.kind === "doc" || page.kind === "hist") && !docs.some((d) => d.id === (page as { id: string }).id)) {
    // 这篇已不在长文里(别处收回 / 转了任务 / 删了):回列表并明说
    page = { kind: "list" };
    showBar(t("docs.notFound"));
  }
  render();
}

function render(): void {
  ($("docs-new") as HTMLButtonElement).hidden = page.kind !== "list";
  if (page.kind === "list") renderList();
  else if (page.kind === "doc") {
    const id = page.id;
    renderDoc(docs.find((d) => d.id === id)!);
  } else if (page.kind === "hist") {
    const id = page.id;
    renderHistory(docs.find((d) => d.id === id)!);
  }
  // edit 页由 openEditor 自己画,读完列表不重画它
}

function tagChips(d: IdeaItem): HTMLElement {
  const box = el("span", "doc-tags");
  for (const tp of d.topics) {
    const c = el("span", tp.color ? "chip tinted" : "chip", [tp.title]);
    if (tp.color) c.style.setProperty("--tc", tp.color);
    box.append(c);
  }
  return box;
}

// ---- 列表 ------------------------------------------------------------------------

function renderList(): void {
  if (docs.length === 0) {
    root().replaceChildren(el("p", "muted empty", [t("docs.empty")]));
    return;
  }
  const list = el("div", "timeline doc-list");
  for (const d of docs) {
    const title = docTitle(d.content);
    const art = el("article", "card doc-card", [
      el("div", "body", [
        el("h3", title === "" ? "doc-title untitled" : "doc-title", [title === "" ? t("docs.untitled") : title]),
        el("p", "doc-ex", [excerpt(d.content, title)]),
        el("footer", "", [el("time", "", [fmtWhen(d.created_at)]), tagChips(d)]),
      ]),
    ]);
    art.dataset.doc = d.id;
    art.addEventListener("click", () => go({ kind: "doc", id: d.id }));
    list.append(art);
  }
  root().replaceChildren(list);
}

// ---- 阅读页 ----------------------------------------------------------------------

/** 页头那一行:`.row` 那套面板钮(实心主钮 / 描边次级 `ghost`,自己长够 44)。 */
function bar(left: HTMLElement[], right: HTMLElement[]): HTMLElement {
  return el("div", "row doc-bar", [...left, el("span", "doc-gap"), ...right]);
}

/** 正文 → DOM(共用渲染器)。配图映射每篇建一次;勾方框走 edit_note 落一版(同随记,⛔ 不猜行)。
 *  链接:安卓把校验过的地址直接交 opener;鸿蒙交不出浏览器(`HAS_BROWSER = false`)⇒ `openLink: null`,
 *  只显示文字与地址(共用渲染器那形)。`docId = null` = 还没建成的新篇(不会有图);`shown` = 原位
 *  画成图的那几张的编号(阅读页的缩略图条不再重复摆它们)。 */
function renderBody(
  sp: string,
  docId: string | null,
  content: string,
  imgs: ImageMeta[],
  onToggle: ((line: number) => void) | null,
): { el: HTMLElement; shown: Set<number> } {
  const bySeq = new Map(imgs.map((m) => [m.seq, m]));
  const shown = new Set<number>();
  const r = renderMarkdown(content, {
    openLink: HAS_BROWSER ? (url) => void openUrl(url).catch((err) => showErr(err)) : null,
    image: (n) => {
      const m = bySeq.get(n);
      if (m === undefined || docId === null) return null;
      return {
        label: t("images.imageN", { n }),
        open: () => void openViewer(imgs, imgs.indexOf(m), true),
        src: () => {
          shown.add(n);
          return figureSrc(sp, docId, m.id);
        },
      };
    },
    checkbox: (checked, line) => ({
      label: onToggle === null ? (checked ? t("checklist.checked") : t("checklist.unchecked")) : checked ? t("checklist.uncheck") : t("checklist.check"),
      toggle: onToggle === null ? null : () => onToggle(line),
    }),
  });
  const wrap = el("div", "doc-body", [r.root]);
  if (r.degraded !== null) wrap.prepend(el("p", "doc-note", [t("docs.degraded")]));
  return { el: wrap, shown };
}

/** 阅读页的缩略图条只摆正文里没原位画出来的图(画了的再摆一遍就重复了;没引用到的图仍在这儿)。 */
function hideShown(thumbs: HTMLElement, shown: Set<number>): void {
  let left = 0;
  for (const b of thumbs.querySelectorAll<HTMLElement>(".thumb[data-seq]")) {
    const inline = shown.has(Number(b.dataset.seq));
    b.hidden = inline;
    if (!inline) left++;
  }
  thumbs.classList.toggle("all-inline", left === 0);
}

/** 正文框随内容长高、整页只有一层滚动(⛔ 别回到「min-height + 框里再滚」:框里一层、页面一层)。
 *  先塌成 auto 再量会让外层滚动位置被夹住,量完原样放回。 */
function fitArea(a: HTMLTextAreaElement): void {
  const keep: [Element, number][] = [];
  for (let e: Element | null = a.parentElement; e !== null; e = e.parentElement) if (e.scrollTop > 0) keep.push([e, e.scrollTop]);
  const se = document.scrollingElement;
  if (se !== null && se.scrollTop > 0) keep.push([se, se.scrollTop]);
  a.style.height = "auto";
  a.style.height = `${a.scrollHeight + a.offsetHeight - a.clientHeight}px`;
  for (const [e, y] of keep) e.scrollTop = y;
}

function renderDoc(d: IdeaItem): void {
  const sp = space;
  let content = d.content;
  let imgs: ImageMeta[] = [];
  const bodyHost = el("div", "");
  // 勾方框:单飞 + 尾随(同 main.ts flushChecklist —— 每发都是整篇,乱序落地会互相覆盖)
  let ckFlushing = false;
  let ckPending: string | null = null;
  const flush = (): void => {
    if (ckFlushing || ckPending === null) return;
    const send = ckPending;
    ckPending = null;
    ckFlushing = true;
    editNote(sp, d.id, send).then(
      () => {
        ckFlushing = false;
        if (ckPending !== null) flush();
      },
      (err) => {
        ckFlushing = false;
        ckPending = null;
        showErr(err); // 后端是真相源:照它重画,⛔ 不猜该回滚到哪一版(同时间轴的方框)
        void load();
      },
    );
  };
  const toggle = (line: number): void => {
    const next = toggleChecklistLine(content, line);
    if (next === null) return;
    content = next;
    d.content = next;
    paint();
    ckPending = next;
    flush();
  };
  // 配图:读这一篇的图元数据(列表那发不带),缩略图滚到可视区才拉字节(同时间轴)。
  const thumbs = el("div", "thumbs");
  thumbs.hidden = true;
  const paint = (): void => {
    const b = renderBody(sp, d.id, content, imgs, toggle);
    bodyHost.replaceChildren(b.el);
    hideShown(thumbs, b.shown);
  };
  paint();
  void listItemImages(sp, d.id).then(
    (m) => {
      if (sp !== getCurrentSpace() || !thumbs.isConnected) return;
      imgs = m;
      paint();
      thumbs.replaceChildren(
        ...m.map((im) => {
          const b = el("button", "thumb", [el("span", "tag-n", [t("images.imageN", { n: im.seq })])]);
          b.dataset.img = im.id;
          b.dataset.seq = String(im.seq);
          b.setAttribute("aria-label", t("main.viewImage", { n: im.seq }));
          b.addEventListener("click", () => void openViewer(m, m.indexOf(im), true));
          return b;
        }),
      );
      thumbs.hidden = m.length === 0;
      paint(); // 缩略图条画好了再画一遍正文:原位显示了的那几张从条里藏掉
      hydrateThumbs(thumbs);
    },
    () => {
      /* 图读不到只是少显几张缩略图,正文照常(同时间轴缩略图的「装饰不陪葬」) */
    },
  );

  const draft = loadDraft(sp, d.id);
  const draftBar =
    draft !== null && draft.text !== d.content
      ? el("div", "row doc-draft", [
          el("span", "", [t("docs.draftFound", { time: fmtWhen(draft.at) })]),
          btn(t("docs.draftResume"), () => openEditor(d, draft.text, [])),
          btn(t("docs.draftDiscard"), () => {
            clearDraft(sp, d.id, null);
            render();
          }, "ghost"),
        ])
      : null;
  if (draft !== null && draft.text === d.content) clearDraft(sp, d.id, draft.gen); // 已经存进去了的草稿,静默收掉

  const meta = el("div", "doc-meta", [el("time", "", [t("docs.writtenAt", { time: fmtWhen(d.created_at) })])]);
  // 留言徽章:comments.ts 出的是转义过的固定形 HTML(数字 + 固定文案),不含正文
  const badge = commentBadgeHtml(sp, d.id);
  if (badge !== "") {
    const host = el("span", "");
    host.innerHTML = badge;
    host.addEventListener("click", () => deps.openComments(d.id));
    meta.append(host);
  }

  const art = el("article", "doc-page", [draftBar, bodyHost, thumbs, tagChips(d), meta]);
  root().replaceChildren(
    bar(
      [btn(t("docs.back"), () => go({ kind: "list" }), "ghost")],
      [btn(t("docs.actEdit"), () => openEditor(d, null, []), "ghost"), btn(t("docs.actHistory"), () => go({ kind: "hist", id: d.id }), "ghost")],
    ),
    art,
    readerActions(d),
  );
}

/** 阅读页底下那排动作(同卡片操作面的形:主行四枚封顶,低频的收进「更多…」)。 */
function readerActions(d: IdeaItem): HTMLElement {
  const sp = space;
  const panel = el("div", "panel doc-acts");
  if (readerMode === "tags") {
    void renderTags(panel, d);
    return panel;
  }
  if (readerMode === "move") {
    renderMove(panel, d);
    return panel;
  }
  // 部分移动登记在场(目标已建、这边还在 / 未知):常驻提示 + 「我已处理」,「移动」入口随之藏起
  // (⛔ 不给重跑,会造出第二份;同卡片操作面 renderActions)。登记键 = 开面那刻的空间。
  const partial = movePartialNote(d.id, sp);
  if (partial !== null) {
    panel.append(
      el("div", "movenote", [
        el("span", "", [partial]),
        btn(t("cardpanel.moveAck"), () => {
          movePartialClear(d.id, sp);
          render();
        }, "p"),
      ]),
    );
  }
  const acts = el("div", "acts");
  if (readerMode === "main") {
    acts.append(
      btn(t("docs.actTags"), () => {
        readerMode = "tags";
        render();
      }),
      btn(t("docs.actComments"), () => deps.openComments(d.id)),
      btn(t("docs.actMore"), () => {
        readerMode = "more";
        render();
      }),
    );
  } else {
    acts.append(
      btn(t("docs.actCollapse"), () =>
        void write(() => setDoc(sp, d.id, false), () => {
          page = { kind: "list" };
          actionBar(t("docs.collapsed"), t("docs.undo"), () => void undo(() => setDoc(sp, d.id, true)));
        }),
      ),
      btn(t("docs.actCopy"), () =>
        writeClipboard(d.content).then(
          () => showBar(t("docs.copied"), true),
          (err) => showBar(t("docs.copyFailed", { error: errDetail(err) })),
        ),
      ),
      btn(t("docs.actCopyLink"), () =>
        itemDeepLink(sp, d.id)
          .then(writeClipboard)
          .then(
            () => showBar(t("docs.linkCopied"), true),
            (err) => showBar(t("docs.copyFailed", { error: errDetail(err) })),
          ),
      ),
      // 仅 ≥2 空间、且没有未处理的部分移动登记时出现(同卡片「更多…」)
      ...(partial === null && deps.getSpaces().length >= 2
        ? [
            btn(t("docs.actMove"), () => {
              readerMode = "move";
              render();
            }),
          ]
        : []),
      btn(
        t("docs.actDelete"),
        () =>
          confirmBar(t("docs.deleteQ"), t("docs.deleteYes"), () => {
            if (busy || page.kind !== "doc" || page.id !== d.id) return;
            void write(() => archiveNote(sp, d.id), () => {
              page = { kind: "list" };
              actionBar(t("docs.deleted"), t("docs.undo"), () => void undo(() => restoreNote(sp, d.id)));
            });
          }),
        "warn",
      ),
    );
    panel.append(acts, el("div", "acts", [btn(t("cardpanel.back"), () => docsBack())]));
    return panel;
  }
  panel.append(acts);
  return panel;
}

/** 面里的业务写:in-flight 整面禁点;成功后整轴重拉(底栏「长文」钮的显形跟着变)再重读本面。 */
// 跨空间移动(cross-space-move §2.7,照卡片操作面 cardpanel.ts renderMove / runMove):永久删历史的
// 告知在选择之前;点目标再两拍确认。只有 moved 离场;两个部分成功态**先落登记**(独立于这一面
// 还在不在)再回主行显提示;两条预检拒在原处报、可再点。
function renderMove(panel: HTMLElement, d: IdeaItem): void {
  const labels = distinctSpaceLabels(deps.getSpaces());
  const rows = deps
    .getSpaces()
    .filter((s) => s.id !== space)
    .map((s) => {
      const label = labels.get(s.id) ?? s.id;
      return btn(label, () =>
        confirmBar(t("docs.moveQ", { name: label }), t("cardpanel.moveYes"), () => {
          if (busy || page.kind !== "doc" || page.id !== d.id || readerMode !== "move") return;
          void runMove(d.id, s.id, label);
        }),
      "p");
    });
  const warn = el("div", "movewarn", [t("docs.moveWarnPre"), el("b", "", [t("docs.moveWarnBold")]), t("docs.moveWarnPost")]);
  const lane = el("div", "lane", [
    el("span", "pillrow", rows.length > 0 ? rows : [el("span", "lab", [t("cardpanel.noOtherSpace")])]),
  ]);
  panel.append(
    warn,
    lane,
    el("div", "acts", [
      btn(t("cardpanel.back"), () => {
        hideConfirmBar();
        readerMode = "more";
        render();
      }),
    ]),
  );
}

async function runMove(id: string, target: string, label: string): Promise<void> {
  if (busy) return;
  const sp = space;
  busy = true;
  render();
  let r: Awaited<ReturnType<typeof moveItemToSpace>> | null = null;
  try {
    r = await moveItemToSpace(sp, target, id);
  } catch (err) {
    // 抛错 = 目标什么都没建(目标落库之后的失败一律走结构化结果),可再点
    if (sp === getCurrentSpace()) showErr(err);
  } finally {
    busy = false;
  }
  // 登记先行:目标已建的事实,切走 / 关面 / 重画都不能丢
  if (r?.outcome === "copied_but_source_kept") movePartialMark(sp, id, t("cardpanel.moveKept", { name: label, reason: r.reason }));
  else if (r?.outcome === "copied_but_source_unconfirmed")
    movePartialMark(sp, id, t("cardpanel.moveUnconfirmedNote", { name: label, error: r.error }));
  if (sp !== getCurrentSpace()) return;
  const here = page.kind === "doc" && page.id === id;
  switch (r?.outcome) {
    case undefined:
      break;
    case "moved":
      if (here) page = { kind: "list" }; // 先离场,免得重读时多报一句「已不在长文里」
      showBar(t("cardpanel.moved", { name: label }), true);
      void deps.refreshTimeline();
      break;
    case "copied_but_source_kept":
      if (here) readerMode = "main";
      showBar(t("cardpanel.movedKept", { name: label }), true);
      void deps.refreshTimeline();
      break;
    case "copied_but_source_unconfirmed":
      // 源删除状态未知,绝不谎报「保留」
      if (here) readerMode = "main";
      showBar(t("cardpanel.movedUnconfirmed", { name: label }), true);
      void deps.refreshTimeline();
      break;
    case "images_pending":
      showBar(t("cardpanel.imagesPending", { n: r.count }));
      break;
    case "dangling_refs":
      showBar(t("cardpanel.danglingRefs"));
      break;
    default: {
      const exhaustive: never = r;
      return exhaustive;
    }
  }
  void load();
}

async function write(op: () => Promise<unknown>, onDone: () => void): Promise<void> {
  if (busy) return;
  const sp = space;
  busy = true;
  render();
  let ok = false;
  try {
    await op();
    ok = true;
  } catch (err) {
    if (sp === getCurrentSpace()) showErr(err);
  } finally {
    busy = false;
  }
  if (sp !== getCurrentSpace()) return;
  if (ok) {
    onDone();
    void deps.refreshTimeline();
  }
  void load();
}

async function undo(op: () => Promise<unknown>): Promise<void> {
  try {
    await op();
  } catch (err) {
    showErr(err);
    return;
  }
  void deps.refreshTimeline();
  if (page.kind === "list") void load();
}

// 打标签:与随记同一条命令(长文的 stage 就在随记那两档)。同卡片操作面的标签那排:点亮的再点就摘。
async function renderTags(panel: HTMLElement, d: IdeaItem): Promise<void> {
  const sp = space;
  panel.replaceChildren(el("p", "muted", [t("docs.loading")]));
  let all: TopicItem[];
  try {
    all = await listTopics(sp);
  } catch (err) {
    if (sp === getCurrentSpace()) showErr(err);
    readerMode = "main";
    if (panel.isConnected) render();
    return;
  }
  if (!panel.isConnected || sp !== getCurrentSpace()) return;
  const have = new Set(d.topics.map((x) => x.id));
  const pills = el("span", "pillrow");
  for (const tp of all) {
    const on = have.has(tp.id);
    const p = btn(tp.title, () =>
      void write(() => (on ? removeNoteTopic(sp, d.id, tp.id) : fileNoteToTopic(sp, d.id, tp.id, null)), () => {}),
      `p${on ? " on" : ""}${tp.color ? " tinted" : ""}`,
    );
    if (tp.color) p.style.setProperty("--tc", tp.color);
    pills.append(p);
  }
  if (all.length === 0) pills.append(el("span", "lab", [t("docs.noTags")]));
  const input = el("input", "tagnew") as HTMLInputElement;
  input.placeholder = t("docs.newTagPh");
  input.autocomplete = "off";
  input.setAttribute("autocapitalize", "off");
  const create = btn(t("docs.createAndTag"), () => {
    const title = input.value.trim();
    if (!title) {
      showBar(t("docs.tagNameRequired"));
      return;
    }
    void write(() => fileNoteToTopic(sp, d.id, null, title), () => {});
  }, "p");
  panel.replaceChildren(
    el("div", "lane", [pills]),
    el("div", "lane", [input, create]),
    el("div", "acts", [
      btn(t("docs.done"), () => {
        readerMode = "main";
        render();
      }),
    ]),
  );
}

// ---- 编辑器(§2)-------------------------------------------------------------------

/** `d = null` = 新建。`seed` = 从草稿接着改时的起始文字(否则用正文)。`carried` = 从「记一笔」
 *  带过来的暂存图(只有新篇会有;编辑器一开就把这篇建出来、挂上,引用接在正文末尾)。 */
function openEditor(d: IdeaItem | null, seed: string | null, carried: File[]): void {
  hideConfirmBar();
  const sp = space;
  const id = d?.id ?? null;
  page = { kind: "edit", id };
  ($("docs-new") as HTMLButtonElement).hidden = true;
  let saved = d?.content ?? ""; // 最近一次落库的正文
  const area = el("textarea", "doc-area") as HTMLTextAreaElement;
  area.value = seed ?? saved;
  area.placeholder = t("docs.placeholder");
  area.spellcheck = false;
  const preview = el("div", "doc-preview");
  preview.hidden = true;
  const status = el("span", "doc-status");
  const err = el("p", "doc-err warn-ink");
  err.hidden = true;

  // 配图:加图 = 当场挂上(同卡片编辑层 attachImages),并在加图那刻的光标处插一段「图N」(预览 /
  // 阅读页原位显示);新篇还没有 id ⇒ 第一张图进来那一刻先把它建出来(正文可以是空的,同桌面)。
  // × 只切换「保存时删」的标记(148 同律,保存时那一删 = 进回收站)。
  let imgs: ImageMeta[] = [];
  const marked = new Set<string>();
  const thumbs = el("div", "thumbs");
  thumbs.hidden = true;
  /** 取图在飞(系统选择器开着 + 回来那几秒的降采样 + 逐张挂上):两枚钮不受理、离开编辑器先拦
   *  一句 —— 走了的话插进去的「图N」赶不上那一版。 */
  let picking = false;
  function paintThumbs(): void {
    thumbs.replaceChildren(
      ...imgs.map((im) => {
        const del = el("span", "thumb-del");
        const b = el("button", "thumb", [el("span", "tag-n", [t("images.imageN", { n: im.seq })]), del]);
        const paintMark = (): void => {
          const on = marked.has(im.id);
          b.classList.toggle("marked", on);
          del.textContent = on ? "↺" : "×";
          del.setAttribute("aria-label", on ? t("main.undoDeleteImage", { n: im.seq }) : t("main.deleteImage", { n: im.seq }));
        };
        paintMark();
        b.dataset.img = im.id;
        b.dataset.seq = String(im.seq);
        b.setAttribute("aria-label", t("main.viewImage", { n: im.seq }));
        // 只切标记、就地改类名(⛔ 不整条重建:已填好字节的小图会闪一下)
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          if (saving) return;
          if (marked.has(im.id)) marked.delete(im.id);
          else marked.add(im.id);
          paintMark();
        });
        b.addEventListener("click", () => void openViewer(imgs, imgs.indexOf(im), true));
        return b;
      }),
    );
    thumbs.hidden = imgs.length === 0;
    hydrateThumbs(thumbs);
  }
  area.addEventListener("input", () => fitArea(area));
  if (id !== null) {
    void listItemImages(sp, id).then(
      (m) => {
        if (!thumbs.isConnected) return;
        imgs = m;
        paintThumbs();
      },
      (e) => {
        if (!thumbs.isConnected) return;
        err.textContent = t("docs.imagesLoadFailed", { error: errDetail(e) });
        err.hidden = false;
      },
    );
  }
  /** 逐张挂上、逐张 try 不中断(一张被拒不连累同批,回执三分同卡片编辑层),挂上一张就在 `at`
   *  插一段它的「图N」。编辑器若已被关掉照样挂完 —— 用户选了的图该挂上(在缩略图条里,只是没插
   *  引用);回执走屏底条,哪一页都看得见。 */
  async function attachNow(target: string, files: File[], at: Sel): Promise<void> {
    let ok = 0;
    let firstErr = "";
    for (const f of files) {
      try {
        const meta = await addItemImage(sp, target, f.type, await toBase64(f));
        imgs = [...imgs, meta];
        insertRef(meta.seq, at);
        ok += 1;
      } catch (e) {
        if (!firstErr) firstErr = errDetail(e);
      }
    }
    if (thumbs.isConnected) paintThumbs();
    const failed = files.length - ok;
    if (!failed) showBar(ok === 1 ? t("cardpanel.imageAdded") : t("cardpanel.imagesAdded", { n: ok }), true);
    else if (!ok && files.length === 1) showBar(firstErr);
    else showBar(`${t("cardpanel.imagesPartial", { ok, failed })} ${firstErr}`);
  }
  type Sel = { value: string; start: number; end: number };
  const selNow = (): Sel => ({ value: area.value, start: area.selectionStart, end: area.selectionEnd });
  /** 在 `at`(加图那刻的选区;等图期间又改过字、或同批前一张已经插过,就用当前光标)插一段「图N」:
   *  前后各空一行,自成一段才原位显示。⛔ 不 focus(手机上一 focus 就弹键盘);照常发 input(草稿 /
   *  长高跟着走)。⚠「图N」是正文语法(`imgRefText`,与界面语言无关),不是界面文案。 */
  function insertRef(seq: number, at: Sel): void {
    if (!area.isConnected) return;
    const v = area.value;
    const [a, b] = v === at.value ? [at.start, at.end] : [area.selectionStart, area.selectionEnd];
    const before = v.slice(0, a);
    const after = v.slice(b);
    const pre = before === "" || before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
    const post = after.startsWith("\n\n") ? "" : after.startsWith("\n") ? "\n" : "\n\n";
    area.setRangeText(`${pre}${imgRefText(seq)}${post}`, a, b, "end");
    area.dispatchEvent(new Event("input", { bubbles: true }));
  }
  /** 新篇:第一张图进来时先建出来(正文可以是空的)。 */
  async function ensureDoc(): Promise<string> {
    const cur = id ?? newId;
    if (cur !== null) return cur;
    await commit(true);
    const made = id ?? newId;
    if (made === null) throw new Error(t("docs.imageNoDoc"));
    return made;
  }
  async function addFiles(files: File[], at: Sel): Promise<void> {
    if (!files.length) return;
    let target: string;
    try {
      target = await ensureDoc();
    } catch (e) {
      showBar(errDetail(e));
      return;
    }
    await attachNow(target, files, at);
  }
  async function pick(photo: boolean): Promise<void> {
    if (picking || saving) return;
    picking = true;
    const at = selNow();
    try {
      const batch: File[] = [];
      if (photo) {
        const f = await capturePhoto();
        if (f) batch.push(f);
      } else {
        const res = await pickImages((f) => batch.push(f));
        if (res.kind === "tooMany") showBar(t("images.tooMany", { max: PICK_MAX, n: res.count }));
      }
      await addFiles(batch, at);
    } finally {
      picking = false;
    }
  }

  // 停笔 1 秒存草稿
  let draftDue: ReturnType<typeof setTimeout> | null = null;
  let lastGen: number | null = null;
  let newId: string | null = null;
  function writeDraft(): void {
    draftDue = null;
    if (area.value === saved) {
      settle(id ?? newId, lastGen);
      status.textContent = "";
      return;
    }
    try {
      lastGen = saveDraft(sp, id ?? newId, area.value);
      status.textContent = t("docs.draftSaved");
      status.classList.remove("bad");
    } catch (e) {
      status.textContent = t("docs.draftFailed", { error: errDetail(e) });
      status.classList.add("bad");
    }
  }
  area.addEventListener("input", () => {
    status.textContent = "";
    if (draftDue !== null) clearTimeout(draftDue);
    draftDue = setTimeout(writeDraft, DRAFT_IDLE_MS);
  });

  // 本次编辑写过草稿(gen 非空),或是从草稿「接着改」进来的(seed 非空)才清;否则存着的那份
  // 不是这个编辑器写的,⛔ 别顺手删掉(同桌面)。
  function settle(target: string | null, gen: number | null): void {
    if (gen !== null || seed !== null) clearDraft(sp, target, gen);
  }

  // 落一版。新篇第一次:capture_doc(同一事务 create + set doc_at)拿到 id;`force` = 新篇正文还空着
  // 也建(第一张图进来那一刻,图得有篇可挂)。标了删的图最后删(同桌面:正文写成功、删图失败后
  // 重试,`saved` 已跟上,正文不会再写一遍)。
  // "same" = 没有要写的(正文没变、没有标删的图),"failed" = 没写进去(草稿留着)。
  let saving = false;
  async function commit(force = false): Promise<"wrote" | "same" | "failed"> {
    if (saving) return "failed";
    const text = area.value;
    const curId = id ?? newId;
    // 还没到点的那一代草稿先落下,拿到本次提交对应的代次(成功后只清这一代)
    if (draftDue !== null) {
      clearTimeout(draftDue);
      draftDue = null;
      if (text !== saved) {
        try {
          lastGen = saveDraft(sp, curId, text);
        } catch {
          /* 写不进去:提交照常,只是没有这一代可清 */
        }
      }
    }
    const gen = lastGen;
    if (curId === null ? !force && text.trim() === "" : text === saved && marked.size === 0) {
      settle(curId, gen);
      return "same"; // 新篇一个字没写(也没加图)就走 = 不建
    }
    saving = true;
    try {
      let target = curId;
      if (target === null) {
        target = newId = await captureDoc(sp, text);
        saved = text;
        settle(null, gen);
      } else if (text !== saved) {
        await editNote(sp, target, text);
        saved = text;
        settle(target, gen);
      }
      for (const imgId of [...marked]) {
        await deleteItemImage(sp, imgId);
        marked.delete(imgId); // 删到一半失败:已删的当场摘掉,重试只删剩下的
        imgs = imgs.filter((m) => m.id !== imgId);
      }
    } catch (e) {
      saving = false;
      if (thumbs.isConnected) paintThumbs();
      err.textContent = t("docs.saveFailed", { error: errDetail(e) });
      err.hidden = false;
      return "failed";
    }
    saving = false;
    void deps.refreshTimeline();
    return "wrote";
  }
  function teardown(): void {
    if (draftDue !== null) clearTimeout(draftDue);
    editor = null;
  }
  editor = {
    back: () => editor?.leave(done),
    leave: (then) => {
      if (picking) {
        showBar(t("docs.imagesBusy"));
        return;
      }
      void commit().then((r) => {
        if (r === "failed" || editor === null) return;
        teardown();
        then();
      });
    },
    flush: () => {
      // 关面:不等、不碰 DOM;没写进去的那份草稿还在,下次打开会问
      // ⚠ 先把这一刻的字落成一代草稿(停笔还不到 1 秒的那几个字也在):换空间引起的关面,
      // 后端会拒这一发写(只认前台空间),那时草稿是唯一的副本。
      // 配图:标了删的图 ⛔ 一张不删(同桌面 unmount 那一发:删图命令认的是前台空间)。
      teardown();
      const text = area.value;
      const curId = id ?? newId;
      if (text === saved || (curId === null && text.trim() === "")) return;
      let gen = lastGen;
      try {
        gen = saveDraft(sp, curId, text);
      } catch {
        /* 存不进去:照常试正式保存 */
      }
      void (async () => {
        try {
          if (curId === null) await captureDoc(sp, text);
          else await editNote(sp, curId, text);
          clearDraft(sp, curId, gen);
          void deps.refreshTimeline();
        } catch (e) {
          showBar(t("docs.saveFailed", { error: errDetail(e) }));
        }
      })();
    },
  };
  const done = (): void => {
    const target = id ?? newId;
    go(target === null ? { kind: "list" } : { kind: "doc", id: target });
  };

  const modeEdit = btn(t("docs.modeEdit"), () => {
    modeEdit.classList.add("on");
    modePrev.classList.remove("on");
    preview.hidden = true;
    area.hidden = false;
    area.focus();
  }, "on");
  const modePrev = btn(t("docs.modePreview"), () => {
    modePrev.classList.add("on");
    modeEdit.classList.remove("on");
    // 预览只在切过去那一刻画一次(200 KiB 一篇解析要几十毫秒,⛔ 别逐键同步算);只读,方框禁用
    preview.replaceChildren(renderBody(sp, id ?? newId, area.value, imgs, null).el);
    preview.hidden = false;
    area.hidden = true;
  }, "");
  root().replaceChildren(
    bar(
      [btn(id === null ? t("docs.back") : t("docs.backToDoc"), () => editor?.leave(done), "ghost")],
      [status, btn(t("docs.save"), () => editor?.leave(done))],
    ),
    // 加图两枚钮与「编辑 / 预览」同一排、缩略图紧跟在下面 —— ⛔ 别挪到正文框底下:框有 60vh,
    // 矮屏(360×640)上那一排正好压在底栏下面,新篇加的图还没有回执,点了像没反应
    // ⚠ `.row` 只包那两枚钮:它的 `button` 规则是实心主钮,包住分段钮会把没选中的那段刷成实心红
    el("div", "doc-tools", [
      el("div", "seg doc-seg", [modeEdit, modePrev]),
      el("div", "row", [btn(t("shell.addImage"), () => void pick(false), "ghost"), btn(t("shell.takePhoto"), () => void pick(true), "ghost")]),
    ]),
    el("div", "doc-imgs", [thumbs]),
    err,
    area,
    preview,
  );
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  fitArea(area);
  if (carried.length) {
    // 从「记一笔」带过来的图:当场建篇挂上,引用接在正文末尾(挂完之前同「取图在飞」,离开先拦)
    picking = true;
    void addFiles(carried, { value: area.value, start: area.value.length, end: area.value.length }).finally(() => {
      picking = false;
    });
  }
}

// ---- 历史与比对(§4)--------------------------------------------------------------

type Pick = "current" | { rev: number };

function renderHistory(d: IdeaItem): void {
  const sp = space;
  const listEl = el("div", "hv-list");
  const more = btn(t("docs.histMore"), () => {}, "hv-more");
  more.hidden = true;
  const head = el("p", "hv-head");
  const note = el("p", "doc-note");
  note.hidden = true;
  const out = el("div", "hv-out", [el("p", "muted", [t("docs.loading")])]);
  root().replaceChildren(
    bar([btn(t("docs.backToDoc"), () => go({ kind: "doc", id: d.id }), "ghost")], [el("span", "hv-title", [docTitle(d.content) || t("docs.untitled")])]),
    el("div", "hv-side", [listEl, more]),
    head,
    note,
    out,
  );

  const metaOf = new Map<number, RevisionMeta>();
  let old: Pick = "current";
  let neu: Pick = "current";
  const same = (a: Pick, b: Pick): boolean => (a === "current" ? b === "current" : b !== "current" && a.rev === b.rev);
  const label = (p: Pick): string => (p === "current" ? t("docs.histCurrent") : fmtWhen(metaOf.get(p.rev)!.archived_at));
  const rows: { pick: Pick; oldBtn: HTMLElement; newBtn: HTMLElement }[] = [];
  // 在途请求的代次:换了选择 / 离开历史页之后,旧回包 ⛔ 不许盖新的
  let seq = 0;

  function paintMarks(): void {
    for (const r of rows) {
      r.oldBtn.classList.toggle("on", same(r.pick, old));
      r.newBtn.classList.toggle("on", same(r.pick, neu));
    }
  }
  async function compare(): Promise<void> {
    paintMarks();
    const mine = ++seq;
    head.textContent = t("docs.histPair", { old: label(old), new: label(neu) });
    note.hidden = true;
    if (same(old, neu)) {
      out.replaceChildren(el("p", "doc-note", [t("docs.histSame")]));
      return;
    }
    out.replaceChildren(el("p", "muted", [t("docs.loading")]));
    let pair: Awaited<ReturnType<typeof revisionTexts>>;
    try {
      pair = await revisionTexts(sp, d.id, old, neu);
    } catch (e) {
      if (mine !== seq || !out.isConnected) return;
      out.replaceChildren(el("p", "warn-ink", [errDetail(e)]));
      return;
    }
    if (mine !== seq || !out.isConnected) return;
    if (pair.a.content === pair.b.content) {
      out.replaceChildren(el("p", "doc-note", [t("docs.histNoChange")]));
      return;
    }
    const r = renderDiff(pair.a.content, pair.b.content);
    if (r.degraded !== null) {
      note.textContent = t("docs.histDegraded");
      note.hidden = false;
      // 两份原文各加一行小标(文案是本端的,不来自正文)
      const [o, n] = Array.from(r.root.children) as HTMLElement[];
      o.before(el("div", "hv-rawlbl", [t("docs.histOldText")]));
      n.before(el("div", "hv-rawlbl", [t("docs.histNewText")]));
    } else if (r.limited) {
      note.textContent = t("docs.histLimited");
      note.hidden = false;
    }
    out.replaceChildren(r.root);
  }

  function addRow(pick: Pick, when: string, chars: number | null): void {
    const oldBtn = btn(t("docs.histOld"), () => {
      if (same(pick, neu)) neu = old; // 点到对面那一格 = 两边对调
      old = pick;
      void compare();
    }, "hv-pick");
    const newBtn = btn(t("docs.histNew"), () => {
      if (same(pick, old)) old = neu;
      neu = pick;
      void compare();
    }, "hv-pick");
    oldBtn.setAttribute("aria-label", t("docs.histOldAria", { when }));
    newBtn.setAttribute("aria-label", t("docs.histNewAria", { when }));
    rows.push({ pick, oldBtn, newBtn });
    listEl.append(
      el("div", "hv-row", [
        el("span", "hv-when", [when]),
        el("span", "hv-chars", [chars === null ? "" : t("docs.histChars", { n: chars })]),
        oldBtn,
        newBtn,
      ]),
    );
  }

  function addPage(p: RevisionCatalog): void {
    for (const r of p.entries) {
      metaOf.set(r.revision_id, r);
      addRow({ rev: r.revision_id }, fmtWhen(r.archived_at), r.chars);
    }
    more.hidden = !p.has_more;
    more.onclick = async () => {
      const before = p.entries[p.entries.length - 1].revision_id;
      more.disabled = true;
      try {
        const next = await listRevisions(sp, d.id, before);
        if (!more.isConnected) return;
        addPage(next);
        paintMarks();
      } catch (e) {
        if (more.isConnected) showErr(e);
      } finally {
        more.disabled = false;
      }
    };
  }

  const mine = ++seq;
  listRevisions(sp, d.id, null).then(
    (first) => {
      if (mine !== seq || !out.isConnected) return;
      if (first.total === 0) {
        out.replaceChildren(el("p", "doc-note", [t("docs.histNone")]));
        return;
      }
      addRow("current", t("docs.histCurrent"), Array.from(d.content).length);
      addPage(first);
      // 默认:上一版 → 当前
      old = { rev: first.entries[0].revision_id };
      neu = "current";
      void compare();
    },
    (e) => {
      if (mine !== seq || !out.isConnected) return;
      out.replaceChildren(el("p", "warn-ink", [errDetail(e)]));
    },
  );
}
