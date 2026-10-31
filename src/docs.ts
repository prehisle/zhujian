// 长文视图(longform-plan 第 3 格)。随记写长了「展开成长文」挪到这儿:按 Markdown 显示,
// 编辑时边写边存本机草稿、点「保存」或离开编辑器才落一版,任意两版可以比对。
//
// 一个视图三种页面,`page` 说现在是哪种(模块态,切视图回来还在):
//   - list   —— 全部长文(`list_docs`,core 的主归属判谁是长文,⛔ 这里不按 stage / doc_at 另判);
//   - doc    —— 一篇的阅读页(读 / 编辑 / 历史三种 `sub`);
//   - new    —— 还没存过的新长文,只有编辑这一种 `sub`,第一次保存走 `capture_doc` 才有 id。
//
// ⭐ 全部写命令钉在 mount 那刻的空间(`invokeInSpace(mountSpace, …)`):离开编辑器要落一版,而
// 「离开」也可能是切空间引起的 unmount —— 那一刻 `invoke` 注入的已经是新空间,⛔ 别用它。
//
// 渲染:正文走共用的 `shared/markdown-dom.ts`,比对走 `shared/diff-dom.ts`(两份都只用
// createElement + 文本节点,安全落点只在那两处);本文件只拿它们返回的节点直接挂,⛔ 不序列化
// 再拼、不另起链接提取器。其余面(随记 / 任务 / 搜索 / 历史比对)照旧不渲染 Markdown(§3)。
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type MoveResult,
  type SpaceInfo,
  currentSpaceId,
  distinctSpaceLabels,
  invokeInSpace,
  listSpaces,
  moveItemToSpace,
  moveOutcomeText,
  movePartialClear,
  movePartialMark,
  movePartialNote,
  spaceLabel,
} from "./space";
import { dismissUndo, toastAction, toastError, toastUndo } from "./toast";
import { copyText } from "./clipboard";
import { buildItemDeepLink } from "./deeplink";
import { armLocate } from "./locate";
import { DOC_CARD_KEYS, DOC_VIEW_KEYS } from "./keymap";
import { type Act, armDismiss, createHotkeyController, registerViewKeys } from "./hotkey-menu";
import { t } from "./i18n";
import { type ImageMeta, attachBlob, figureSrc, getThumb, imageStrip, openLightbox, pasteImage } from "./item-images";
import { toggleChecklistLine } from "../shared/checklist";
import { type MdRendered, renderMarkdown } from "../shared/markdown-dom";
import { firstRefs, gutterStack, refInsertion, scanImgRefs } from "../shared/markdown";
import { renderDiff } from "../shared/diff-dom";
import { closeComments, commentBadge, commentCountFor, inlineCommentState, loadCommentCounts, openInlineComments } from "./item-comments";
import type { View, ViewCtx } from "./notebook";
import { applyTagColor } from "./tag-color";
import { renderTagPicker } from "./tag-picker";
import { when } from "./tasktime";
import { wireChecklistInput } from "./checklist-input";
import { el } from "./dom";
import { errDetail, errText } from "./err";
import "./docs.css";

// lib.rs `ProcessedItem` 里这个视图用到的字段(`list_docs` 恒带非空 doc_at)。
type DocTag = { id: string; title: string; color: string | null };
type DocItem = { id: string; content: string; created_at: string; doc_at: string; topics: DocTag[] };
type TopicItem = { id: string; title: string; color: string | null; kind: string | null };
// history.rs 的两条读命令(1b):目录不带正文,点了才取两份全文。
type RevisionMeta = { revision_id: number; archived_at: string; chars: number };
type RevisionCatalog = { entries: RevisionMeta[]; total: number; has_more: boolean };
type Pick = "current" | { rev: number };
type VersionText = { revision_id: number | null; archived_at: string | null; content: string };
type VersionPair = { a: VersionText; b: VersionText };

type Page = { kind: "list" } | { kind: "doc"; id: string } | { kind: "new" };

let page: Page = { kind: "list" };
// 列表页的滚动位置(同 inbox.ts savedScroll):切走再回来落回原处。
let savedScroll = 0;
// 写到哪 / 读到哪不丢(153 走查 D-M16:存完回阅读页再点编辑,光标与画面跳到全文末尾):离开编辑器那一刻的光标按篇记着
// (`${space}/${id}`,只在内存,同手机 docs.ts)。
const caretMemo = new Map<string, number>();
/** 原文第 `line` 行(`split("\n")` 口径)起于第几个码元。 */
function lineStart(v: string, line: number): number {
  let at = 0;
  for (let i = 0; i < line; i++) {
    const nl = v.indexOf("\n", at);
    if (nl < 0) return v.length;
    at = nl + 1;
  }
  return at;
}
/** 第 `off` 个码元在原文第几行。 */
function lineOf(v: string, off: number): number {
  let n = 0;
  for (let i = v.indexOf("\n"); i >= 0 && i < off; i = v.indexOf("\n", i + 1)) n++;
  return n;
}
// 跨视图「打开这一篇」(搜索命中 / 深链 / 标签):带发起那刻的空间,落地前切了空间就作废。
let pendingFocus: { id: string; space: string } | null = null;
export function focusDoc(id: string): void {
  pendingFocus = { id, space: currentSpaceId() };
}

// ---- 草稿(§2:只存本机、不同步、不进历史)-------------------------------------------
// 键 = 空间 + 条目(新建那篇用 "new");值带**代次**:正式保存成功后只清自己提交的那一代,
// 保存在途时又敲的字(更新的代次)留着。⛔ 不静默套用:重开一篇时草稿与正文不同,明说并给
// 「接着改 / 丢掉」。丢了最坏 = 回到上次保存那一版,所以存不进去只报一句、不拦正式保存。
// 草稿不随条目删除而清理(条目进了回收站还能还原);留下的孤键只是几行本机字。
type Draft = { text: string; gen: number; at: string };
const DRAFT_PREFIX = "zhujian.doc-draft:";
const DRAFT_IDLE_MS = 1000; // 停笔这么久存一次
let draftGen = Date.now(); // 单调递增即可;起点取时刻,跨重启也不会比旧代次小

function draftKey(space: string, id: string | null): string {
  return `${DRAFT_PREFIX}${space}:${id ?? "new"}`;
}
function loadDraft(space: string, id: string | null): Draft | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(draftKey(space, id));
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
function saveDraft(space: string, id: string | null, text: string): number {
  const gen = ++draftGen;
  localStorage.setItem(draftKey(space, id), JSON.stringify({ text, gen, at: new Date().toISOString() }));
  return gen;
}
/** 只清 `gen` 这一代(及更早);存着的是更新的一代就不动。 */
function clearDraft(space: string, id: string | null, gen: number | null): void {
  const d = loadDraft(space, id);
  if (d === null) return;
  if (gen !== null && d.gen > gen) return;
  try {
    localStorage.removeItem(draftKey(space, id));
  } catch {
    /* 清不掉 = 下次打开时再问一次「接着改 / 丢掉」,不影响正文 */
  }
}

/** 列表与标题栏用的题目:第一行非空字,去掉开头的 `#`。 */
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
/** 列表卡上题目下面那两行:去掉题目那一行,再把行首的 Markdown 记号(# / > / 列表符 / 勾选框)与
 *  行内的 ** __ ` 摘掉 —— 只是给眼睛扫的字,⛔ 不是渲染(列表卡不进 Markdown 渲染器)。 */
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

export function mount(root: HTMLElement, _ctx: ViewCtx): View {
  const mountSpace = currentSpaceId();
  const view = el("div", { className: "v-docs view" });
  const newBtn = el("button", { className: "hbtn", type: "button", title: t("docs.new") }, [
    el("span", { className: "lbl", textContent: t("docs.new") }),
    el("kbd", { className: "k", textContent: DOC_VIEW_KEYS.compose }),
  ]);
  const header = el("header", {}, [el("h1", { textContent: t("docs.title") }), el("span", { className: "head-tools" }, [newBtn])]);
  header.setAttribute("data-tauri-drag-region", "");
  const main = el("main", { className: "docs-main" });
  view.append(header, main);
  root.replaceChildren(view);

  const hk = createHotkeyController();
  let unmounted = false;
  let refreshSeq = 0;
  let lastSig = "";
  let docs: DocItem[] = [];
  let restorePending = true;
  // 编辑器开着时:离开它的那一条路(保存再走)。null = 没在编辑。
  let leaveEditor: ((then: () => void) => void) | null = null;
  // unmount 用:不等结果,尽力把正文落一版(同 leaveEditor,但不碰 DOM)。
  let flushEditor: (() => void) | null = null;
  // 阅读页里就地展开的选择器 / 确认:重画前收走它们挂在 document 上的监听。
  let pickerOff: (() => void) | null = null;
  // 阅读页 cm-host 的重挂登记(同 inbox.ts restoreComment)。
  let restoreComment: { itemId: string; draft: string; marked: string | null; focused: boolean } | null = null;
  // 下一次渲染列表时给哪张卡常亮(撤销收回 / 删除之后)。
  let locateId: string | null = null;
  // 上一发画的是哪一篇的阅读页(判「原地重画」还是「换了一篇」)
  let shownDocId: string | null = null;
  // 历史页开着时不因回窗刷新重画(那会把选好的两版冲掉);离开它走 go()。
  let historyOpen = false;
  // 刚从编辑器回阅读页:光标所在那一块摆到工具条底下(renderDoc 交出摆法,refresh 定完滚动位置后调)
  let readerAt: { id: string; caret: number } | null = null;
  let pinReader: (() => void) | null = null;

  const docById = (id: string): DocItem | undefined => docs.find((d) => d.id === id);

  // 可移入的其他空间(同 inbox.ts):挂载时取一次 —— 空间集变了必经切换 / 新建,视图随之重挂。
  let otherSpaces: SpaceInfo[] = [];
  void listSpaces()
    .then((all) => {
      otherSpaces = all.filter((s) => s.alive && s.id !== mountSpace);
    })
    .catch(() => {});

  function centerNode(big: string, detail: string): HTMLElement {
    return el("div", { className: "center" }, [el("div", { className: "big", textContent: big }), el("div", { textContent: detail })]);
  }

  function go(next: Page): void {
    if (page.kind === "list") savedScroll = main.scrollTop;
    page = next;
    lastSig = "";
    void refresh();
  }

  // ---- 共用的条目动作(列表卡与阅读页同一份)----------------------------------------
  async function doDelete(d: DocItem): Promise<void> {
    try {
      await invokeInSpace(mountSpace, "archive_note", { id: d.id });
    } catch (e) {
      toastError(errText(e));
      return;
    }
    if (page.kind === "doc" && page.id === d.id) page = { kind: "list" };
    void refresh();
    // 长文删掉进的是随记那边的回收站(回收站按冻结的 stage 分两页,长文的 stage 是随记那两档)
    toastUndo(t("docs.undoDeleted"), t("common.undo"), () => void undoVia("restore_note", { id: d.id }));
  }
  async function doCollapse(d: DocItem): Promise<void> {
    try {
      await invokeInSpace(mountSpace, "set_doc", { id: d.id, on: false });
    } catch (e) {
      toastError(errText(e));
      return;
    }
    if (page.kind === "doc" && page.id === d.id) page = { kind: "list" };
    void refresh();
    toastUndo(t("docs.undoCollapsed"), t("common.undo"), () => void undoVia("set_doc", { id: d.id, on: true }));
  }
  async function undoVia(cmd: string, args: Record<string, unknown>): Promise<void> {
    if (unmounted) return;
    try {
      await invokeInSpace(mountSpace, cmd, args);
    } catch (e) {
      toastError(t("common.undoFailed", { err: errDetail(e) }));
      return;
    }
    locateId = args.id as string;
    void refresh();
  }
  // ---- 移动到其他空间(cross-space-move v1,同随记那套)----------------------------------
  // 选择器先亮「历史随移动永久删除」(告知在提交之前);只有 moved 离场;两个部分成功态(目标已建、
  // 源还在 / 未知)**先落登记**再重画 —— 提示常驻卡面与阅读页、「移动」入口随之藏起,⛔ 绝不提供
  // 重跑(会造出第二份);两条预检拒可改再试。话术只用 space.ts::moveOutcomeText 那一份。
  function moveActs(host: HTMLElement, d: DocItem): Act[] {
    if (otherSpaces.length === 0 || movePartialNote(d.id, mountSpace) !== null) return [];
    return [{ label: t("docs.actMove"), key: DOC_CARD_KEYS.move, run: () => openMove(host, d) }];
  }
  function openMove(host: HTMLElement, d: DocItem): void {
    pickerOff?.();
    const labels = distinctSpaceLabels(otherSpaces);
    const err = el("p", { className: "form-err", hidden: true });
    let moving = false;
    const chipBtns = otherSpaces.map((s) =>
      el("button", { className: "chip", type: "button", textContent: labels.get(s.id) ?? spaceLabel(s), onclick: () => void doMove(s.id) }),
    );
    const form = el("div", { className: "inline-form doc-move" }, [
      el("label", { className: "form-label", textContent: t("docs.moveLabel") }),
      el("div", { className: "chips" }, chipBtns),
      err,
      el("div", { className: "form-actions" }, [el("button", { className: "no", type: "button", textContent: t("docs.cancel"), onclick: () => pickerOff?.() })]),
    ]);
    const close = (): void => {
      form.remove();
      pickerOff = null;
    };
    const off = armDismiss(form, close);
    pickerOff = () => {
      off();
      close();
    };
    host.append(form);
    const setBusy = (b: boolean): void => chipBtns.forEach((btn) => (btn.disabled = b));
    const fail = (msg: string): void => {
      err.textContent = msg;
      err.hidden = false;
      moving = false;
      setBusy(false);
    };

    async function doMove(target: string): Promise<void> {
      if (moving) return;
      moving = true;
      setBusy(true);
      let r: MoveResult;
      try {
        r = await moveItemToSpace(mountSpace, target, d.id);
      } catch (e) {
        // 抛错 = 目标什么都没建(目标 commit 之后的失败一律走结构化结果),可重试。
        fail(errText(e));
        return;
      }
      const text = moveOutcomeText(r, labels.get(target) ?? target);
      switch (r.outcome) {
        case "moved":
          toastAction(text);
          if (form.isConnected) pickerOff?.();
          if (page.kind === "doc" && page.id === d.id) page = { kind: "list" };
          void refresh();
          return;
        case "copied_but_source_kept":
        case "copied_but_source_unconfirmed":
          // 登记独立于 DOM:期间关了选择器 / 换了页 / 切了空间都冲不掉,重画时由它显提示
          movePartialMark(mountSpace, d.id, text);
          if (form.isConnected) pickerOff?.();
          void refresh();
          return;
        case "images_pending":
        case "dangling_refs":
          fail(text);
          return;
        default: {
          const exhaustive: never = r;
          return exhaustive;
        }
      }
    }
  }
  /** 部分成功登记在场时的常驻提示(卡面与阅读页同一份);处理完(手动删掉一边)点解除。 */
  function movePartialBar(d: DocItem): HTMLElement | null {
    const msg = movePartialNote(d.id, mountSpace);
    if (msg === null) return null;
    return el("div", { className: "move-partial" }, [
      el("span", { textContent: msg }),
      el("button", {
        className: "no",
        type: "button",
        textContent: t("docs.movePartialDone"),
        onclick: () => {
          movePartialClear(d.id, mountSpace);
          void refresh();
        },
      }),
    ]);
  }

  const copyFeedback = (d: DocItem) => async (): Promise<string> => {
    try {
      await copyText(d.content);
      return t("docs.copied");
    } catch {
      return t("docs.copyFailed");
    }
  };
  const copyLinkFeedback = (d: DocItem) => async (): Promise<string> => {
    try {
      await copyText(await buildItemDeepLink(d.id));
      return t("docs.copiedLink");
    } catch {
      return t("docs.copyFailed");
    }
  };

  // 打标签:与随记同一条命令(长文的 stage 就在随记那两档),选择器是共享件。
  async function openTags(host: HTMLElement, d: DocItem, onErr: (e: unknown) => void): Promise<void> {
    let allTopics: TopicItem[];
    try {
      allTopics = await invokeInSpace<TopicItem[]>(mountSpace, "list_topics");
    } catch (e) {
      onErr(e);
      return;
    }
    pickerOff?.();
    const picker = el("div", { className: "topic-picker" });
    const close = (): void => {
      picker.remove();
      pickerOff = null;
    };
    const off = armDismiss(picker, close);
    pickerOff = () => {
      off();
      close();
    };
    const write = async (cmd: string, args: Record<string, unknown>): Promise<void> => {
      off();
      close();
      try {
        await invokeInSpace(mountSpace, cmd, args);
      } catch (e) {
        onErr(e);
        return;
      }
      void refresh();
    };
    host.append(picker);
    renderTagPicker(picker, {
      allTopics,
      have: new Set(d.topics.map((x) => x.id)),
      onPick: (topicId) => void write("file_note_to_topic", { id: d.id, topicId, newTitle: null }),
      onUnpick: (topicId) => void write("remove_note_topic", { id: d.id, topicId }),
      onCreate: (title) => void write("file_note_to_topic", { id: d.id, topicId: null, newTitle: title }),
    });
  }

  function tagChips(d: DocItem): HTMLElement {
    return el(
      "div",
      { className: "tags" },
      d.topics.map((x) => {
        const chip = el("span", { className: "tag", textContent: x.title });
        applyTagColor(chip, x.color);
        return chip;
      }),
    );
  }

  // ---- 列表 ------------------------------------------------------------------------
  function card(d: DocItem): HTMLElement {
    const title = docTitle(d.content);
    const art = el("article", { className: "doc-card" });
    if (d.id === locateId) {
      locateId = null;
      art.classList.add("just-located");
      armLocate(art);
    }
    const err = el("p", { className: "form-err", hidden: true });
    const showErr = (e: unknown): void => {
      err.textContent = errText(e);
      err.hidden = false;
    };
    const open = (): void => go({ kind: "doc", id: d.id });
    const partialBar = movePartialBar(d);
    const body = el("div", { className: "doc-card-body" }, [
      el("h2", { className: title === "" ? "doc-card-title untitled" : "doc-card-title", textContent: title === "" ? t("docs.untitled") : title }),
      el("p", { className: "doc-card-ex", textContent: excerpt(d.content, title) }),
      el("time", { className: "doc-card-time", textContent: when(d.created_at) }),
      tagChips(d),
      ...(partialBar ? [partialBar] : []),
      err,
    ]);
    const handle = hk.register(
      art,
      () => [
        { label: t("docs.actOpen"), key: DOC_CARD_KEYS.open, run: open },
        { label: t("docs.actEdit"), key: DOC_CARD_KEYS.edit, run: () => openEditorFor(d.id) },
        { label: t("docs.actTag"), key: DOC_CARD_KEYS.tag, run: () => void openTags(body, d, showErr) },
        { label: t("docs.actCollapse"), key: DOC_CARD_KEYS.collapse, run: () => void doCollapse(d) },
        { label: t("docs.actCopy"), key: DOC_CARD_KEYS.copy, feedback: copyFeedback(d) },
        { label: t("docs.actCopyLink"), key: DOC_CARD_KEYS.copyLink, feedback: copyLinkFeedback(d) },
        ...moveActs(body, d),
        { label: t("docs.actDelete"), key: DOC_CARD_KEYS.delete, run: () => void doDelete(d), danger: true },
      ],
      () => body.querySelector(".topic-picker, .doc-move") !== null,
    );
    art.append(body, handle.menu());
    // 点卡片 = 打开(⋯ 菜单 / 选择器里的点击不算)
    art.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, .hk-menu-wrap, .topic-picker, .doc-move")) return;
      if (window.getSelection()?.toString()) return; // 在划选字,不是要打开
      open();
    });
    return art;
  }

  function renderList(): void {
    hk.reset();
    if (docs.length === 0) {
      main.replaceChildren(centerNode(t("docs.emptyTitle"), t("docs.emptyHint")));
      return;
    }
    main.replaceChildren(el("div", { className: "doc-list" }, docs.map(card)));
    main.querySelector<HTMLElement>(".just-located")?.scrollIntoView({ block: "center" });
  }

  // ---- 阅读页 ----------------------------------------------------------------------
  /** `narrow` = 阅读页那条:与正文同宽(编辑器 / 历史页在宽屏是两栏铺满,工具条跟着铺满)。 */
  function bar(left: HTMLElement[], right: HTMLElement[], narrow = false): HTMLElement {
    return el("div", { className: narrow ? "doc-bar narrow" : "doc-bar" }, [...left, el("span", { className: "doc-bar-gap" }), ...right]);
  }
  function backBtn(label: string, run: () => void): HTMLElement {
    return el("button", { className: "hbtn", type: "button", textContent: label, onclick: run });
  }

  /** 正文 → DOM(共用渲染器)。配图映射每篇建一次;勾方框走 edit_note 落一版(同随记,⛔ 不猜行)。
   *  `docId = null` = 还没建成的新篇(不会有图)。`shown` = 原位画成图的那几张的编号(阅读页与编辑器的
   *  缩略图条不再重复摆它们);`figs` = 逐个 `.md-fig` 是哪一张(渲染器按文档序逐个取 src,与
   *  `querySelectorAll(".md-fig")` 同序);`anchors` 交给编辑器对齐左右滚动。 */
  function renderBody(
    docId: string | null,
    content: string,
    imgs: ImageMeta[],
    imgsKnown: boolean,
    onToggle: ((line: number) => void) | null,
  ): { el: HTMLElement; shown: Set<number>; figs: ImageMeta[]; anchors: MdRendered["anchors"] } {
    const bySeq = new Map(imgs.map((m) => [m.seq, m]));
    const shown = new Set<number>();
    const figs: ImageMeta[] = [];
    const r = renderMarkdown(content, {
      openLink: (url) => void openUrl(url).catch(() => {}),
      image: (n) => {
        const m = bySeq.get(n);
        if (m === undefined || docId === null) return null;
        return {
          label: t("itemImages.badge", { n }),
          open: () => void openLightbox(imgs, imgs.indexOf(m)),
          src: () => {
            shown.add(n);
            figs.push(m);
            return figureSrc(docId, m.id);
          },
        };
      },
      // 对不上任何一张现存图的「图N」= 图删了(或从没有过):灰的带删除线,正文不改(154 G4,用户拍「对不上就算」)
      gone: (n) => (imgsKnown ? t("docs.imgGone", { n }) : null),
      checkbox: (checked, line) => ({
        label: onToggle === null ? (checked ? t("checklist.checked") : t("checklist.unchecked")) : checked ? t("checklist.uncheck") : t("checklist.check"),
        toggle: onToggle === null ? null : () => onToggle(line),
      }),
    });
    const wrap = el("div", { className: "doc-body" }, [r.root]);
    if (r.degraded !== null) wrap.prepend(el("p", { className: "doc-note", textContent: t("docs.degraded") }));
    return { el: wrap, shown, figs, anchors: r.anchors };
  }

  /** 阅读页的缩略图条只摆正文里没原位画出来的图(画了的再摆一遍就重复了;没引用到的图仍在这儿)。
   *  ⛔ 编辑器的条不藏:那条是管图的地方(× 删 / ↺ 撤回),张张都在(154 G1,用户嫌「条里缺原位那张」怪)。 */
  function hideShown(strip: HTMLElement, shown: Set<number>): void {
    let left = 0;
    for (const th of strip.querySelectorAll<HTMLElement>(".img-thumb")) {
      const inline = shown.has(Number(th.dataset.seq));
      th.hidden = inline;
      if (!inline) left++;
    }
    strip.classList.toggle("all-inline", left === 0);
  }

  /** 编辑器右栏:原位画出来的图各配一枚 ×(标记与条里那枚是同一份,
   *  保存时一起删)。图本身是按钮,× 不能嵌进去 ⇒ 套一层 `.md-fig-box` 并排挂。 */
  function figDels(body: HTMLElement, figs: ImageMeta[], strip: ReturnType<typeof imageStrip>): void {
    const els = body.querySelectorAll<HTMLElement>(".md-fig");
    if (els.length !== figs.length) throw new Error(`原位图 ${els.length} 枚、取过图的 ${figs.length} 张,对不上`);
    els.forEach((fig, i) => {
      const m = figs[i];
      const box = el("span", { className: "md-fig-box" });
      const del = el("button", { className: "img-del", type: "button" });
      const paint = (): void => {
        const on = strip.isMarked(m.id);
        box.classList.toggle("del-marked", on);
        del.textContent = on ? "↺" : "×";
        del.title = on ? t("itemImages.undoDelete") : t("itemImages.deleteImage");
      };
      paint();
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        strip.toggleMark(m.id);
        paint();
      });
      fig.replaceWith(box);
      box.append(fig, del);
    });
  }

  function renderDoc(d: DocItem): void {
    hk.reset();
    pickerOff?.();
    const art = el("article", { className: "doc-page" });
    const err = el("p", { className: "form-err", hidden: true });
    const showErr = (e: unknown): void => {
      err.textContent = errText(e);
      err.hidden = false;
    };
    let content = d.content;
    let imgs: ImageMeta[] = [];
    let imgsKnown = false; // 图列表读到之前「图N」⛔ 不划线(否则每次打开都先划一遍,154 G4)
    const bodyHost = el("div", {});
    // 勾方框:单飞 + 尾随(同 inbox.ts flushChecklist —— 每发都是整篇,乱序落地会互相覆盖)
    let ckFlushing = false;
    let ckPending: string | null = null;
    const flush = (): void => {
      if (ckFlushing || ckPending === null) return;
      const send = ckPending;
      ckPending = null;
      ckFlushing = true;
      invokeInSpace(mountSpace, "edit_note", { id: d.id, content: send }).then(
        () => {
          ckFlushing = false;
          if (ckPending !== null) flush();
        },
        (e) => {
          ckFlushing = false;
          ckPending = null;
          showErr(new Error(t("checklist.toggleFailed", { err: errDetail(e) })));
          lastSig = "";
          void refresh();
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
    let shown = new Set<number>();
    let strip: ReturnType<typeof imageStrip> | null = null;
    let anchors: MdRendered["anchors"] = [];
    // 刚从编辑器回来:光标所在那一块摆到工具条底下。图是陆续到的(上面的图撑开会把它往下推)、图单到了还整篇重画一遍 ⇒
    // 头两秒里每画一次 / 每到一张图就再摆一次;滚轮 / 按键 / 点一下就松手,不跟用户抢。
    let pinTo = readerAt !== null && readerAt.id === d.id ? lineOf(content, readerAt.caret) : null;
    readerAt = null;
    const pinUntil = performance.now() + 2000;
    const pin = (): void => {
      if (pinTo === null || performance.now() > pinUntil || !bodyHost.isConnected) return;
      let a = anchors[0];
      for (const x of anchors) if (x.line <= pinTo) a = x;
      if (a === undefined) return;
      const barEl = main.querySelector<HTMLElement>(".doc-bar");
      const under = barEl !== null ? barEl.getBoundingClientRect().bottom : main.getBoundingClientRect().top;
      main.scrollTop += a.el.getBoundingClientRect().top - under - 8;
    };
    pinReader = pin;
    if (pinTo !== null) {
      const letGo = (): void => {
        pinTo = null;
      };
      for (const ev of ["wheel", "mousedown", "keydown"] as const) main.addEventListener(ev, letGo, { once: true, passive: true });
      bodyHost.addEventListener("load", pin, true); // 图到货(load 不冒泡,捕获)
    }
    /** 从阅读页进编辑器时光标落在哪:点的那一块(双击)或工具条底下第一块(正读着的那一段)的行首;
     *  上次在这篇里离开编辑器时的光标正落在这一块里,就回到它。 */
    const startCaret = (from?: EventTarget | null): number => {
      const key = `${mountSpace}/${d.id}`;
      const barEl = main.querySelector<HTMLElement>(".doc-bar");
      const band = barEl !== null ? barEl.getBoundingClientRect().bottom : 0;
      let i = from instanceof Node ? anchors.findIndex((x) => x.el.contains(from)) : -1;
      if (i < 0) i = anchors.findIndex((x) => x.el.getBoundingClientRect().bottom > band);
      if (i < 0) return caretMemo.get(key) ?? 0;
      const lo = i === 0 ? 0 : lineStart(content, anchors[i].line);
      const hi = i + 1 < anchors.length ? lineStart(content, anchors[i + 1].line) : content.length + 1;
      const memo = caretMemo.get(key);
      return memo !== undefined && memo >= lo && memo < hi ? memo : lo;
    };
    const paint = (): void => {
      const b = renderBody(d.id, content, imgs, imgsKnown, toggle);
      bodyHost.replaceChildren(b.el);
      shown = b.shown;
      anchors = b.anchors;
      if (strip !== null) hideShown(strip.root, shown);
      pin();
    };
    paint();
    // ⚠ 乐观首帧在 imageStrip() 返回之前就同步调了 onMetas ⇒ 那一回 strip 还是 null,返回后补一次
    strip = imageStrip(d.id, {
      editable: false,
      onMetas: (m) => {
        imgs = m;
        imgsKnown = true;
        paint();
      },
    });
    hideShown(strip.root, shown);

    const draft = loadDraft(mountSpace, d.id);
    const draftBar =
      draft !== null && draft.text !== d.content
        ? el("div", { className: "doc-draft" }, [
            el("span", { textContent: t("docs.draftFound", { time: when(draft.at) }) }),
            el("button", { className: "no", type: "button", textContent: t("docs.draftResume"), onclick: () => openEditor(d, draft.text) }),
            el("button", {
              className: "no",
              type: "button",
              textContent: t("docs.draftDiscard"),
              onclick: () => {
                clearDraft(mountSpace, d.id, null);
                lastSig = "";
                void refresh();
              },
            }),
          ])
        : null;
    if (draft !== null && draft.text === d.content) clearDraft(mountSpace, d.id, draft.gen); // 已经存进去了的草稿,静默收掉

    const cmHost = el("div", { className: "cm-host" });
    const toggleComments = (restore?: { draft: string; marked: string | null; focused: boolean }): void => {
      if (!restore && inlineCommentState(mountSpace)?.itemId === d.id) {
        closeComments();
        return;
      }
      art.classList.add("commenting");
      openInlineComments(cmHost, mountSpace, d.id, () => void refresh(), {
        draft: restore?.draft,
        marked: restore?.marked,
        focus: restore ? restore.focused : true,
        remount: restore !== undefined,
        onClose: () => art.classList.remove("commenting"),
      });
    };
    const meta = el("div", { className: "doc-meta" }, [el("time", { textContent: t("docs.writtenAt", { time: when(d.created_at) }) })]);
    const badge = commentBadge(mountSpace, d.id, () => void refresh(), () => toggleComments());
    if (badge) meta.append(badge);
    const tagHost = el("div", { className: "doc-tags" }, [tagChips(d)]);

    const actions = (): Act[] => [
      { label: t("docs.actEdit"), key: DOC_CARD_KEYS.edit, run: () => openEditor(d, null, startCaret()) },
      { label: t("docs.actHistory"), key: DOC_CARD_KEYS.history, run: () => openHistory(d) },
      { label: t("docs.actTag"), key: DOC_CARD_KEYS.tag, run: () => void openTags(tagHost, d, showErr) },
      { label: t("docs.actComments"), key: DOC_CARD_KEYS.comments, run: () => toggleComments() },
      { label: t("docs.actCollapse"), key: DOC_CARD_KEYS.collapse, run: () => void doCollapse(d) },
      { label: t("docs.actCopy"), key: DOC_CARD_KEYS.copy, feedback: copyFeedback(d) },
      { label: t("docs.actCopyLink"), key: DOC_CARD_KEYS.copyLink, feedback: copyLinkFeedback(d) },
      ...moveActs(tagHost, d),
      { label: t("docs.actDelete"), key: DOC_CARD_KEYS.delete, run: () => void doDelete(d), danger: true },
    ];
    const handle = hk.register(art, actions, () => art.classList.contains("commenting") || tagHost.querySelector(".topic-picker, .doc-move") !== null);
    const partialBar = movePartialBar(d);
    art.append(...(partialBar ? [partialBar] : []), ...(draftBar ? [draftBar] : []), bodyHost, tagHost, strip.root, meta, err, cmHost, handle.menu());
    art.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("a, button, input, textarea, .hk-menu-wrap, .img-thumb, .cm-host")) return;
      openEditor(d, null, startCaret(e.target));
    });

    main.replaceChildren(
      bar(
        [backBtn(t("docs.back"), () => go({ kind: "list" }))],
        [
          el("button", { className: "hbtn", type: "button", onclick: () => openEditor(d, null, startCaret()) }, [
            el("span", { className: "lbl", textContent: t("docs.actEdit") }),
            el("kbd", { className: "k", textContent: DOC_CARD_KEYS.edit }),
          ]),
          el("button", { className: "hbtn", type: "button", onclick: () => openHistory(d) }, [
            el("span", { className: "lbl", textContent: t("docs.actHistory") }),
            el("kbd", { className: "k", textContent: DOC_CARD_KEYS.history }),
          ]),
        ],
        true,
      ),
      art,
    );
    // 重画前开着的留言:原样重挂(草稿 / 已读水位 / 焦点一起带回)
    const r = restoreComment;
    restoreComment = null;
    if (r !== null && r.itemId === d.id) toggleComments(r);
  }

  // ---- 编辑器(§2)-------------------------------------------------------------------
  function openEditorFor(id: string): void {
    const d = docById(id);
    if (d) openEditor(d, null);
  }

  /** `d = null` = 新建。`seed` = 从草稿接着改时的起始文字(否则用正文)。`at` = 光标放哪(阅读页给的是正读着 / 双击的那一块;
   *  不给 = 末尾:新篇、从草稿接着写)。 */
  function openEditor(d: DocItem | null, seed: string | null, at?: number): void {
    hk.reset();
    pinReader = null;
    pickerOff?.();
    closeComments();
    page = d === null ? { kind: "new" } : { kind: "doc", id: d.id };
    const id = d?.id ?? null;
    const base = d?.content ?? "";
    let saved = base; // 最近一次落库的正文(Ctrl+S 存完接着写,下一次比的是它)
    const area = el("textarea", { className: "doc-area", value: seed ?? base, spellcheck: false }) as HTMLTextAreaElement;
    area.placeholder = t("docs.placeholder");
    wireChecklistInput(area);
    const preview = el("div", { className: "doc-preview" });
    const status = el("span", { className: "doc-status" });
    const err = el("p", { className: "form-err", hidden: true });
    const imgErr = el("p", { className: "form-err", hidden: true });
    const showImgErr = (e: unknown): void => {
      imgErr.textContent = errText(e);
      imgErr.hidden = false;
    };

    // 配图:贴一张 = 当场挂上,并在粘贴那刻的光标处插一段「图N」(预览 / 阅读页原位显示)。新篇还
    // 没有 id ⇒ 第一张图进来那一刻先把它建出来(正文可以是空的),之后与已存过的篇同一条路。
    // ⚠ `previewDue` / `anchors` 必须先于 mountStrip 声明:乐观首帧会**同步**调 onMetas → paintPreview。
    let imgs: ImageMeta[] = [];
    let imgsKnown = id === null; // 图列表读到了没有(新篇没有图;没读到之前「图N」⛔ 不划线,154 G4)
    let previewDue: ReturnType<typeof setTimeout> | null = null;
    let anchors: MdRendered["anchors"] = [];
    let strip: ReturnType<typeof imageStrip> | null = null;
    const delNote = el("p", { className: "doc-note doc-del-note", hidden: true });
    const imgRow = el("div", { className: "img-editor" }, [imgErr, delNote]);
    function mountStrip(target: string): ReturnType<typeof imageStrip> {
      if (strip === null) {
        strip = imageStrip(target, { editable: true, onMetas: (m) => ((imgs = m), (imgsKnown = true), paintPreview(), paintHl(), paintDelNote()), onMark: () => paintGutterMarks() });
        imgRow.prepend(strip.root);
      }
      return strip;
    }

    // 逐张排队:编号按进来的先后、新篇只建一次;离开 / Ctrl+S 先等这条队走完,插进去的「图N」
    // 才赶得上那一版。三条路进同一条队:粘贴、「＋加图」钮、把图片文件拖进写字框(154 G5)。
    let attaching: Promise<void> = Promise.resolve();
    function addBlobs(blobs: Blob[]): void {
      const at = { value: area.value, end: area.selectionEnd };
      imgErr.hidden = true;
      for (const blob of blobs)
        attaching = attaching.then(async () => {
          try {
            const target = await ensureDoc();
            const meta = await attachBlob(target, blob, mountSpace);
            await mountStrip(target).reload();
            insertRef(meta.seq, at);
            revealCaret("nearest"); // 连加几张:插到哪就看到哪(153 走查 D-M05:execCommand 插完写字框不跟)
          } catch (e) {
            showImgErr(e);
          }
        });
    }
    /** 拖进来 / 选进来的一批文件:图片排进队,别的(文档、压缩包…)明说没收,⛔ 不默默丢掉。 */
    function takeFiles(files: File[]): void {
      const pics = files.filter((f) => f.type.startsWith("image/"));
      if (pics.length > 0) addBlobs(pics);
      if (pics.length < files.length) showImgErr(new Error(t("docs.dropNotImage", { n: files.length - pics.length })));
    }
    area.addEventListener("paste", (e) => pasteImage(e, (blob) => addBlobs([blob]), showImgErr));
    /** 新篇:第一张图进来时先建出来(正文可以是空的)。 */
    async function ensureDoc(): Promise<string> {
      const cur = id ?? newId;
      if (cur !== null) return cur;
      await commit(false, true);
      const made = id ?? newId;
      if (made === null) throw new Error(t("docs.imageNoDoc"));
      return made;
    }
    /** 在 `at`(图进来那刻的光标;等图期间又改过字、或同批前一张已经插过,就用当前光标)所在那一段的**段尾另起一段**
     *  插「图N」(154 G3,`refInsertion`;句中不拆、选中的字不替换),光标停在它后面。走 execCommand ⇒ 进撤销栈
     *  (Ctrl+Z 撤得掉),并照常触发 input(草稿 / 预览)。 */
    function insertRef(seq: number, at: { value: string; end: number }): void {
      if (!area.isConnected) return; // 编辑器已经关了:图挂上了(在缩略图条里),只是没插引用
      const r = refInsertion(area.value, area.value === at.value ? at.end : area.selectionEnd, seq);
      area.focus();
      area.setSelectionRange(r.at, r.at);
      if (!document.execCommand("insertText", false, r.text)) throw new Error("insertText 不可用");
      area.setSelectionRange(r.caret, r.caret);
    }

    function paintPreview(): void {
      previewDue = null;
      const b = renderBody(id ?? newId, area.value, imgs, imgsKnown, null);
      if (strip !== null) figDels(b.el, b.figs, strip);
      preview.replaceChildren(b.el);
      anchors = b.anchors;
      syncPreview();
    }

    // 宽屏左右并排:右边跟着左边滚,按块对齐 —— 左边某块起始行的高度 ↔ 右边那块元素的高度,块与块之间
    // 线性插值(两头钉在 0 与各自的最底)。⛔ 别退回按总高比例:一张图在右边几百像素、在左边只占一行,
    // 比例一算就整段错开。左边行高靠一只同宽同字体的影子 div 量(折行与 textarea 一致),正文或宽度变了才重量。
    // 影子层 / 探针排版用的宽 = 写字框的内框(含左右内边距、不含滚动条)。⛔ 别用 clientWidth:它取整,150% 缩放下内框是
    // 283.33px 这种小数,差的那零点几像素刚好让某一行在影子层里多折一行 ⇒ 底色、窄边、光标探针从那行起整体低一行(155;
    // 实测 116 个宽度里 7 个错一行,换成 ResizeObserver 给的 contentRect 后 231 个宽度一个不错)。打开那一刻 RO 还没回调,先拿 clientWidth 顶一拍。
    let areaW = area.clientWidth;
    let tops: { value: string; width: number; ys: number[] } | null = null;
    function lineTops(lines: number[]): number[] {
      if (tops !== null && tops.value === area.value && tops.width === areaW && tops.ys.length === lines.length) return tops.ys;
      const cs = getComputedStyle(area);
      const m = document.createElement("div");
      for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "tabSize", "paddingTop", "paddingLeft", "paddingRight", "whiteSpace", "overflowWrap", "wordBreak"] as const)
        m.style[k] = cs[k];
      Object.assign(m.style, { position: "absolute", visibility: "hidden", left: "-99999px", top: "0", boxSizing: "border-box", width: `${areaW}px`, border: "0" });
      const src = area.value.split("\n");
      const marks: HTMLElement[] = [];
      let from = 0;
      for (const ln of lines) {
        m.append(src.slice(from, ln).map((x) => `${x}\n`).join(""));
        const mark = document.createElement("span");
        marks.push(mark);
        m.append(mark);
        from = ln;
      }
      document.body.append(m);
      const ys = marks.map((x) => x.offsetTop);
      m.remove();
      tops = { value: area.value, width: areaW, ys };
      return ys;
    }
    function syncPreview(): void {
      if (!window.matchMedia("(min-width: 1180px)").matches) return;
      const srcMax = area.scrollHeight - area.clientHeight;
      const dstMax = preview.scrollHeight - preview.clientHeight;
      if (srcMax <= 0 || dstMax <= 0) return;
      const ys = lineTops(anchors.map((x) => x.line));
      const base = preview.getBoundingClientRect().top - preview.scrollTop;
      const src = [0];
      const dst = [0];
      anchors.forEach((x, k) => {
        const sy = Math.min(srcMax, ys[k]);
        const dy = Math.min(dstMax, x.el.getBoundingClientRect().top - base);
        if (sy > src[src.length - 1] && dy >= dst[dst.length - 1]) {
          src.push(sy);
          dst.push(dy);
        }
      });
      src.push(srcMax);
      dst.push(dstMax);
      const y = area.scrollTop;
      let k = 0;
      while (k < src.length - 2 && y >= src[k + 1]) k++;
      const span = src[k + 1] - src[k];
      preview.scrollTop = span > 0 ? dst[k] + ((y - src[k]) / span) * (dst[k + 1] - dst[k]) : dst[k];
    }
    // 写字框里的「图N」:能对上一张图的垫一层底色(对不上 = 引用断了,照普通字)。纯文本框给不了几个字单独上色 ⇒ 背后垫一层
    // 同字体同排版的影子层,只画底色,字仍是写字框自己的(光标 / 输入法 / 撤销一概不碰);写字框背景透明,纸色由外框给。
    // 排版参数逐项从写字框的计算样式抄(⛔ 别在 CSS 里另写一份:差一个字距,底色就和字错开)。
    // 窄边(154 G2):写字框**外面**右侧一列,每张图一枚缩略图(带「图N」角标),停在第一次提到它的那一行,挨得太近就往下错开;
    // ⛔ 别挪回框里 —— 那版按列数给写字框加右内边距,连没提到图的段落也一起让位,四列时正文只剩一条缝(153 走查 G2)。
    const hl = el("div", { className: "doc-hl" });
    hl.setAttribute("aria-hidden", "true");
    const gutIn = el("div", { className: "doc-gut-in" });
    const gut = el("div", { className: "doc-gut" }, [gutIn]);
    const edBox = el("div", { className: "doc-ed" }, [hl, area, gut]);
    const THUMB_H = 50; // 窄边一枚的高 44 + 上下留缝(docs.css .doc-gut .ref-thumb)
    const HL_COPY = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent",
      "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "whiteSpace", "overflowWrap", "wordBreak"] as const;
    function syncHl(): void {
      const cs = getComputedStyle(area);
      for (const k of HL_COPY) hl.style[k] = cs[k];
      Object.assign(hl.style, { top: `${area.clientTop}px`, left: `${area.clientLeft}px`, width: `${areaW}px`, height: `${area.clientHeight}px` });
      Object.assign(gut.style, { top: `${area.clientTop}px`, height: `${area.clientHeight}px` });
      hl.scrollTop = area.scrollTop;
      placeGutter();
    }
    /** 窄边那几枚各停到影子层里它那处「图N」所在的那一行(折行随宽度变 ⇒ 尺寸一变就重摆)。 */
    function placeGutter(): void {
      const marks = hl.querySelectorAll<HTMLElement>("mark.ref.first");
      const pins = gutIn.querySelectorAll<HTMLElement>(".ref-thumb");
      if (marks.length !== pins.length) throw new Error(`窄边 ${pins.length} 枚、影子层首提 ${marks.length} 处,对不上`);
      const o = hl.getBoundingClientRect().top - hl.scrollTop;
      const tops = gutterStack([...marks].map((m) => m.getBoundingClientRect().top - o), THUMB_H);
      pins.forEach((p, i) => (p.style.top = `${tops[i]}px`));
      gutIn.style.transform = `translateY(${-area.scrollTop}px)`;
    }
    function paintHl(): void {
      const v = area.value;
      const bySeq = new Map(imgs.map((m) => [m.seq, m]));
      const nodes: (string | HTMLElement)[] = [];
      const refs = scanImgRefs(v).filter((r) => bySeq.has(r.n));
      const first = new Set(firstRefs(refs));
      const pins: HTMLElement[] = [];
      let last = 0;
      refs.forEach((r, i) => {
        nodes.push(v.slice(last, r.a));
        const mark = el("mark", { className: first.has(i) ? "ref first" : "ref", textContent: v.slice(r.a, r.b) });
        nodes.push(mark);
        last = r.b;
        if (!first.has(i)) return;
        const m = bySeq.get(r.n)!;
        const img = el("img", { alt: "" });
        const pin = el("button", { className: "ref-thumb", type: "button", title: t("itemImages.badge", { n: m.seq }), tabIndex: -1 }, [
          img,
          el("span", { className: "n", textContent: t("itemImages.badge", { n: m.seq }) }),
        ]);
        pin.dataset.img = m.id;
        pin.classList.toggle("del-marked", strip?.isMarked(m.id) ?? false);
        pin.addEventListener("mousedown", (e) => e.preventDefault()); // 不抢写字框的焦点
        pin.addEventListener("click", () => void openLightbox(imgs, imgs.indexOf(m)));
        getThumb(m.id).then(
          (u) => {
            img.src = u;
          },
          () => pin.classList.add("broken"),
        );
        pins.push(pin);
      });
      // 一处都没标 ⇒ 影子层整个清空,⛔ 别留一份全文去排版(200 KiB 一篇逐键重排约 30 ms,桌面实测)
      if (nodes.length > 0) nodes.push(`${v.slice(last)}\n`); // 末尾那个空行也要占高(与写字框一致)
      edBox.classList.toggle("has-thumbs", pins.length > 0);
      hl.replaceChildren(...nodes);
      gutIn.replaceChildren(...pins);
      syncHl();
    }
    /** 标记一变(条里 / 大图角上的 ×),窄边那枚跟着变淡。 */
    function paintGutterMarks(): void {
      for (const th of gutIn.querySelectorAll<HTMLElement>(".ref-thumb")) th.classList.toggle("del-marked", strip?.isMarked(th.dataset.img!) ?? false);
      paintDelNote();
    }
    /** 标了删的图正文里提到几处(154 G4,用户拍「点 × 标记时提示、不弹框」):保存删掉后这几处变灰带删除线,正文一个字不改。
     *  标记或正文一变就重算;一张都没提到 ⇒ 不出。 */
    function paintDelNote(): void {
      const refs = scanImgRefs(area.value);
      const parts = imgs
        .filter((m) => strip?.isMarked(m.id))
        .map((m) => ({ n: m.seq, k: refs.filter((r) => r.n === m.seq).length }))
        .filter((x) => x.k > 0)
        .map((x) => t("docs.delRefsOne", x));
      delNote.hidden = parts.length === 0;
      delNote.textContent = parts.length === 0 ? "" : t("docs.delRefs", { list: parts.join(t("docs.listSep")) });
    }
    /** 光标那一行在写字框滚动内容里的上沿(textarea 量不到光标 ⇒ 同字体同宽的影子 div 只排光标前那截,同 lineTops)。 */
    function caretY(): { y: number; h: number } {
      const cs = getComputedStyle(area);
      const m = document.createElement("div");
      for (const k of HL_COPY) m.style[k] = cs[k];
      Object.assign(m.style, { position: "absolute", visibility: "hidden", left: "-99999px", top: "0", boxSizing: "border-box", width: `${areaW}px`, border: "0" });
      const mark = document.createElement("span");
      mark.textContent = "\u200b";
      m.append(area.value.slice(0, area.selectionStart), mark);
      document.body.append(m);
      const y = mark.offsetTop;
      m.remove();
      return { y, h: parseFloat(cs.lineHeight) };
    }
    /** 把光标那一行摆进写字框看得见的那一截(153 走查 D-M05 / M06 / M07:连贴几张图、PageDown、窗口拖小之后光标在框外)。
     *  `top` = 刚打开时摆到靠上(光标就在开头那一屏就不滚);否则只在出界时挪最少的一步。 */
    function revealCaret(mode: "top" | "nearest"): void {
      if (!area.isConnected || area.clientHeight === 0) return;
      const { y, h } = caretY();
      const pad = Math.round(h / 2);
      if (mode === "top") {
        area.scrollTop = y + h < area.clientHeight * 0.6 ? 0 : y - h;
        return;
      }
      if (y < area.scrollTop + pad) area.scrollTop = y - pad;
      else if (y + h > area.scrollTop + area.clientHeight - pad) area.scrollTop = y + h - area.clientHeight + pad;
    }
    const hlResize = new ResizeObserver((es) => {
      const cs = getComputedStyle(area);
      areaW = es[es.length - 1].contentRect.width + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      syncHl();
      if (document.activeElement === area) revealCaret("nearest"); // 窗口拖小 / 右栏冒出来:框变了,光标别掉出去
    });
    hlResize.observe(area);
    // PageUp / PageDown:Chromium 翻完页光标常落在框外(D-M06 量到上沿以上 25px),等它翻完再摆
    area.addEventListener("keydown", (e) => {
      if (e.key === "PageDown" || e.key === "PageUp") setTimeout(() => revealCaret("nearest"), 0);
    });

    let syncDue = false;
    area.addEventListener("scroll", () => {
      hl.scrollTop = area.scrollTop;
      gutIn.style.transform = `translateY(${-area.scrollTop}px)`;
      if (syncDue) return;
      syncDue = true;
      requestAnimationFrame(() => {
        syncDue = false;
        syncPreview();
      });
    });
    // 预览只在看得见时画,且停笔 300ms 后才画(200 KiB 一篇解析要几十毫秒,⛔ 别逐键同步算)
    const wide = window.matchMedia("(min-width: 1180px)");
    const previewVisible = (): boolean => edWrap.classList.contains("show-preview") || wide.matches;
    // 窗口拖宽跨过并排那条线:右栏冒出来时它还停在上一次画的那版(看不见时不画)⇒ 当场重画
    const onWide = (): void => {
      if (previewVisible()) paintPreview();
    };
    wide.addEventListener("change", onWide);
    function schedulePreview(): void {
      if (!previewVisible()) return;
      if (previewDue !== null) clearTimeout(previewDue);
      previewDue = setTimeout(paintPreview, 300);
    }

    // 停笔 1 秒存草稿
    let draftDue: ReturnType<typeof setTimeout> | null = null;
    let lastGen: number | null = null;
    function writeDraft(): void {
      draftDue = null;
      if (area.value === saved) {
        settle(id ?? newId, lastGen);
        status.textContent = "";
        return;
      }
      try {
        lastGen = saveDraft(mountSpace, id ?? newId, area.value);
        status.textContent = t("docs.draftSaved");
        status.classList.remove("bad");
      } catch (e) {
        status.textContent = t("docs.draftFailed", { err: errDetail(e) });
        status.classList.add("bad");
      }
    }
    area.addEventListener("input", () => {
      status.textContent = "";
      if (draftDue !== null) clearTimeout(draftDue);
      draftDue = setTimeout(writeDraft, DRAFT_IDLE_MS);
      schedulePreview();
      paintHl();
      paintDelNote();
    });

    // 落一版。新篇第一次:capture_doc(同一事务 create + set doc_at)拿到 id。`force` = 新篇正文
    // 还空着也建(第一张图进来那一刻,图得有篇可挂)。
    // "same" = 没有要写的(正文没变、没有待删的图),"failed" = 错误已写在编辑器里。
    // `final` = unmount 那一发:只落正文,⛔ 不删图(删图的命令认的是「当前空间」,切空间引起的
    // unmount 那一刻它已经指着别的空间;标了删的图随编辑器一起丢掉,同随记的 Esc)。
    let saving = false;
    let newId: string | null = null;
    async function commit(final = false, force = false): Promise<"wrote" | "same" | "failed"> {
      if (saving) return "failed";
      const text = area.value;
      const curId = id ?? newId;
      // 还没到点的那一代草稿先落下,拿到本次提交对应的代次(成功后只清这一代)
      if (draftDue !== null) {
        clearTimeout(draftDue);
        draftDue = null;
        writeDraftSafe(text);
      }
      const gen = lastGen;
      const st = strip;
      const imgsToDelete = !final && st !== null && st.pendingDeletes() > 0;
      if (curId === null ? !force && text.trim() === "" : text === saved && !imgsToDelete) {
        settle(curId, gen);
        return "same"; // 新篇一个字没写(也没贴图)就走 = 不建
      }
      saving = true;
      err.hidden = true;
      try {
        let target = curId;
        if (target === null) {
          target = await invokeInSpace<string>(mountSpace, "capture_doc", { content: text });
          newId = target;
          saved = text;
          settle(null, gen);
        } else if (text !== saved) {
          await invokeInSpace(mountSpace, "edit_note", { id: target, content: text });
          saved = text;
          settle(target, gen);
        }
        if (imgsToDelete && st !== null) await st.commitDeletes();
      } catch (e) {
        err.textContent = errText(e);
        err.hidden = false;
        saving = false;
        return "failed";
      }
      saving = false;
      return "wrote";
    }
    // 本次编辑写过草稿(gen 非空),或是从草稿「接着改」进来的(seed 非空)才清;否则存着的那份
    // 不是这个编辑器写的(他打开过别的草稿却没接着改),⛔ 别顺手删掉。
    function settle(target: string | null, gen: number | null): void {
      if (gen !== null || seed !== null) clearDraft(mountSpace, target, gen);
    }
    function writeDraftSafe(text: string): void {
      if (text === saved) return;
      try {
        lastGen = saveDraft(mountSpace, id ?? newId, text);
      } catch {
        /* 写不进去:提交照常,只是没有这一代可清 */
      }
    }

    function teardown(): void {
      const target = id ?? newId;
      if (target !== null) caretMemo.set(`${mountSpace}/${target}`, area.selectionStart);
      if (draftDue !== null) clearTimeout(draftDue);
      if (previewDue !== null) clearTimeout(previewDue);
      hlResize.disconnect();
      wide.removeEventListener("change", onWide);
      document.removeEventListener("keydown", onKey);
      leaveEditor = null;
      flushEditor = null;
    }
    const leave = (then: () => void): void => {
      void attaching.then(() => commit()).then((r) => {
        if (r === "failed" || unmounted) return;
        teardown();
        const target = id ?? newId;
        readerAt = target === null ? null : { id: target, caret: area.selectionStart }; // 回到阅读页:光标那一块摆到顶
        then();
      });
    };
    const done = (): void => {
      const target = id ?? newId;
      lastSig = "";
      go(target === null ? { kind: "list" } : { kind: "doc", id: target });
    };
    leaveEditor = leave;
    flushEditor = () => {
      // unmount:不等、不碰 DOM;没写进去的那份草稿还在,下次打开会问
      void commit(true);
      teardown();
    };

    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing) return;
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void attaching.then(() => commit()).then((r) => {
          if (r === "wrote" && !unmounted) status.textContent = t("docs.savedVersion");
        });
      } else if (e.key === "Escape") {
        if ((e.target as HTMLElement | null)?.closest?.(".hk-menu, .img-lightbox")) return;
        e.preventDefault();
        leave(done);
      }
    };
    document.addEventListener("keydown", onKey);

    const modeEdit = el("button", { className: "seg on", type: "button", textContent: t("docs.modeEdit") });
    const modePrev = el("button", { className: "seg", type: "button", textContent: t("docs.modePreview") });
    const edWrap = el("div", { className: "doc-editor" }, [edBox, preview]);
    modeEdit.onclick = () => {
      edWrap.classList.remove("show-preview");
      modeEdit.classList.add("on");
      modePrev.classList.remove("on");
      area.focus();
    };
    modePrev.onclick = () => {
      edWrap.classList.add("show-preview");
      modePrev.classList.add("on");
      modeEdit.classList.remove("on");
      paintPreview();
    };
    const saveBtn = el("button", { className: "do", type: "button", textContent: t("docs.save"), onclick: () => leave(done) });
    // 「＋加图」(154 G5:桌面此前只能贴):系统选文件框,插在哪同粘贴(光标所在段的段尾)。
    // ⚠ 按下不抢写字框的焦点 —— 选区留在原处,选完回来插到那一段后面
    const filePick = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true, hidden: true }) as HTMLInputElement;
    filePick.addEventListener("change", () => {
      const files = [...(filePick.files ?? [])];
      filePick.value = ""; // 同一张再选一次也要触发
      area.focus();
      takeFiles(files);
    });
    const addImgBtn = el("button", { className: "hbtn", type: "button", onclick: () => filePick.click() }, [
      el("span", { className: "lbl", textContent: t("docs.addImage") }),
    ]);
    addImgBtn.addEventListener("mousedown", (e) => e.preventDefault());
    // 拖文件进写字框(此前拖进来无反应无提示)。窗口关了 Tauri 的原生拖放(dragDropEnabled: false,看板拖卡要 HTML5 那套),
    // 文件照常以 DataTransfer.files 到页面。只接带文件的拖动 —— 写字框里拖字照旧。落点 = 当前光标所在段(同粘贴),不按松手的位置。
    const hasFiles = (e: DragEvent): boolean => e.dataTransfer?.types.includes("Files") ?? false;
    edBox.addEventListener("dragover", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "copy";
      edBox.classList.add("drop-on");
    });
    edBox.addEventListener("dragleave", (e) => {
      if (!edBox.contains(e.relatedTarget as Node | null)) edBox.classList.remove("drop-on");
    });
    edBox.addEventListener("drop", (e) => {
      edBox.classList.remove("drop-on");
      if (!hasFiles(e)) return;
      e.preventDefault();
      area.focus();
      takeFiles([...e.dataTransfer!.files]);
    });

    if (id !== null) mountStrip(id); // 已存过的篇:缩略图条(乐观首帧会同步画一次预览,故放在全部声明之后)
    main.replaceChildren(
      bar(
        [backBtn(id === null ? t("docs.back") : t("docs.backToDoc"), () => leave(done)), el("span", { className: "segs" }, [modeEdit, modePrev]), addImgBtn, filePick],
        [status, saveBtn],
      ),
      el("div", { className: "doc-edit-page" }, [edWrap, imgRow, err]),
    );
    if (previewVisible()) paintPreview();
    area.focus();
    const caret = Math.min(at ?? area.value.length, area.value.length);
    area.setSelectionRange(caret, caret);
    paintHl();
    revealCaret("top");
    syncPreview();
  }

  // ---- 历史与比对(§4)--------------------------------------------------------------
  function openHistory(d: DocItem): void {
    hk.reset();
    pickerOff?.();
    closeComments();
    const listEl = el("div", { className: "hv-list" });
    const more = el("button", { className: "hist-more", type: "button", textContent: t("docs.histMore"), hidden: true });
    const head = el("div", { className: "hv-head" });
    const note = el("p", { className: "doc-note", hidden: true });
    const out = el("div", { className: "hv-out" });
    const diffCol = el("div", { className: "hv-diff" }, [head, note, out]);
    main.replaceChildren(
      bar([backBtn(t("docs.backToDoc"), () => go({ kind: "doc", id: d.id }))], [el("span", { className: "hv-title", textContent: t("docs.histTitle", { title: docTitle(d.content) || t("docs.untitled") }) })]),
      el("div", { className: "hv" }, [el("div", { className: "hv-side" }, [listEl, more]), diffCol]),
    );

    const metaOf = new Map<number, RevisionMeta>();
    let old: Pick = "current";
    let neu: Pick = "current";
    const same = (a: Pick, b: Pick): boolean => (a === "current" ? b === "current" : b !== "current" && a.rev === b.rev);
    const label = (p: Pick): string => (p === "current" ? t("docs.histCurrent") : when(metaOf.get(p.rev)!.archived_at));
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
        out.replaceChildren(el("p", { className: "doc-note", textContent: t("docs.histSame") }));
        return;
      }
      out.replaceChildren(el("p", { className: "doc-note", textContent: t("docs.histLoading") }));
      let pair: VersionPair;
      try {
        pair = await invokeInSpace<VersionPair>(mountSpace, "revision_texts", { id: d.id, a: old, b: neu });
      } catch (e) {
        if (mine !== seq || !out.isConnected) return;
        out.replaceChildren(el("p", { className: "form-err", textContent: errText(e) }));
        return;
      }
      if (mine !== seq || !out.isConnected) return;
      if (pair.a.content === pair.b.content) {
        out.replaceChildren(el("p", { className: "doc-note", textContent: t("docs.histNoChange") }));
        return;
      }
      const r = renderDiff(pair.a.content, pair.b.content);
      if (r.degraded !== null) {
        note.textContent = t("docs.histDegraded");
        note.hidden = false;
        // 两份原文各加一行小标(文案是本端的,不来自正文)
        const [o, n] = Array.from(r.root.children) as HTMLElement[];
        o.before(el("div", { className: "hv-rawlbl", textContent: t("docs.histOldText") }));
        n.before(el("div", { className: "hv-rawlbl", textContent: t("docs.histNewText") }));
      } else if (r.limited) {
        note.textContent = t("docs.histLimited");
        note.hidden = false;
      }
      out.replaceChildren(r.root);
    }

    function addRow(pick: Pick, when_: string, chars: number | null): void {
      const oldBtn = el("button", { className: "hv-pick", type: "button", textContent: t("docs.histOld"), title: t("docs.histOldTitle") });
      const newBtn = el("button", { className: "hv-pick", type: "button", textContent: t("docs.histNew"), title: t("docs.histNewTitle") });
      oldBtn.onclick = () => {
        if (same(pick, neu)) neu = old; // 点到对面那一格 = 两边对调
        old = pick;
        void compare();
      };
      newBtn.onclick = () => {
        if (same(pick, old)) old = neu;
        neu = pick;
        void compare();
      };
      rows.push({ pick, oldBtn, newBtn });
      listEl.append(
        el("div", { className: "hv-row" }, [
          el("span", { className: "hv-when", textContent: when_ }),
          el("span", { className: "hv-chars", textContent: chars === null ? "" : t("docs.histChars", { n: chars }) }),
          el("span", { className: "hv-picks" }, [oldBtn, newBtn]),
        ]),
      );
    }

    function addPage(p: RevisionCatalog): void {
      for (const r of p.entries) {
        metaOf.set(r.revision_id, r);
        addRow({ rev: r.revision_id }, when(r.archived_at), r.chars);
      }
      more.hidden = !p.has_more;
      more.onclick = async () => {
        const before = p.entries[p.entries.length - 1].revision_id;
        more.disabled = true;
        try {
          const next = await invokeInSpace<RevisionCatalog>(mountSpace, "list_revisions", { id: d.id, before });
          if (!more.isConnected) return;
          addPage(next);
          paintMarks();
        } catch (e) {
          if (more.isConnected) toastError(errText(e));
        } finally {
          more.disabled = false;
        }
      };
    }

    const mine = ++seq;
    out.replaceChildren(el("p", { className: "doc-note", textContent: t("docs.histLoading") }));
    invokeInSpace<RevisionCatalog>(mountSpace, "list_revisions", { id: d.id, before: null }).then(
      (first) => {
        if (mine !== seq || !out.isConnected) return;
        if (first.total === 0) {
          out.replaceChildren(el("p", { className: "doc-note", textContent: t("docs.histNone") }));
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
        out.replaceChildren(el("p", { className: "form-err", textContent: errText(e) }));
      },
    );
    page = { kind: "doc", id: d.id };
    historyOpen = true;
  }

  // ---- 刷新 ------------------------------------------------------------------------
  async function refresh(refocus = false): Promise<void> {
    if (unmounted) return;
    if (refocus === true && (leaveEditor !== null || historyOpen)) return; // 编辑 / 比对中不重画
    historyOpen = false;
    if (leaveEditor !== null) return; // 编辑器开着:只有离开它的那条路(leave → go)能换页
    const seq = ++refreshSeq;
    let list: DocItem[];
    try {
      [list] = await Promise.all([invokeInSpace<DocItem[]>(mountSpace, "list_docs"), loadCommentCounts(mountSpace)]);
    } catch (e) {
      if (seq !== refreshSeq) return;
      lastSig = "";
      main.replaceChildren(
        el("div", { className: "center" }, [
          el("div", { className: "big", textContent: t("docs.loadFailed") }),
          el("div", { className: "err-box", textContent: errText(e) }),
          el("button", { className: "no", type: "button", textContent: t("docs.retry"), onclick: () => void refresh() }),
        ]),
      );
      return;
    }
    if (seq !== refreshSeq || unmounted) return;
    docs = list;

    let focus = pendingFocus;
    pendingFocus = null;
    if (focus && focus.space !== mountSpace) focus = null;
    if (focus) {
      if (docById(focus.id)) page = { kind: "doc", id: focus.id };
      else {
        page = { kind: "list" };
        toastError(t("docs.notFound"));
      }
      restorePending = false;
    }

    const sig = JSON.stringify([page, list, commentSig()]);
    if (refocus === true && sig === lastSig) return;
    lastSig = sig;

    newBtn.hidden = page.kind !== "list";
    const cm = inlineCommentState(mountSpace);
    restoreComment = cm;
    closeComments();
    pickerOff?.();
    if (page.kind === "doc") {
      const d = docById(page.id);
      if (d) {
        // 同一篇原地重画(写了留言 / 别处同步来改动)保住读到的位置;换了一篇才回顶
        const keep = shownDocId === d.id ? main.scrollTop : 0;
        renderDoc(d);
        shownDocId = d.id;
        main.scrollTop = keep;
        pinReader?.();
        return;
      }
      // 这篇已不在长文里(别处收回 / 转了任务 / 删了):回列表并明说
      page = { kind: "list" };
      newBtn.hidden = false;
      toastError(t("docs.notFound"));
    }
    if (page.kind === "new") {
      // 新篇只活在编辑器里;编辑器不在了(没存就切走又回来)就回列表 —— 草稿留着,点新建会问
      page = { kind: "list" };
      newBtn.hidden = false;
    }
    restoreComment = null;
    shownDocId = null;
    renderList();
    if (restorePending) {
      restorePending = false;
      main.scrollTop = savedScroll;
    }
  }
  // 留言计数进指纹:别的设备写了一条留言,列表一个字节没变,只有徽章要变(同 inbox.ts)
  function commentSig(): number[] {
    return docs.map((d) => commentCountFor(mountSpace, d.id));
  }

  function startNew(): void {
    if (leaveEditor !== null) return;
    const draft = loadDraft(mountSpace, null);
    openEditor(null, draft?.text ?? null);
  }
  newBtn.addEventListener("click", startNew);
  const teardownViewKeys = registerViewKeys([{ key: DOC_VIEW_KEYS.compose, run: () => page.kind === "list" && startNew() }]);
  // 阅读页里 Esc = 回列表(编辑器开着时 Esc 归编辑器,见 openEditor 的 onKey)
  // ⚠ 挂捕获阶段:⋯ 菜单那条 Esc 监听挂在冒泡阶段、先注册,它先跑就会先把菜单收掉,这里
  // 再看「有没有菜单开着」就看不到了 —— 一记 Esc 既关菜单又回列表。
  const onEsc = (e: KeyboardEvent): void => {
    if (e.key !== "Escape" || e.isComposing || e.defaultPrevented || leaveEditor !== null || page.kind !== "doc") return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
    if (document.querySelector(".hk-menu, .topic-picker, .doc-move") !== null || inlineCommentState(mountSpace) !== null) return;
    if (historyOpen) go({ kind: "doc", id: page.id });
    else go({ kind: "list" });
  };
  document.addEventListener("keydown", onEsc, true);

  if (page.kind === "new") page = { kind: "list" };
  void refresh();

  return {
    unmount() {
      if (page.kind === "list") savedScroll = main.scrollTop;
      // 离开编辑器 = 落一版(§2);钉在 mountSpace 上,切空间引起的 unmount 也写回原空间
      flushEditor?.();
      if (page.kind === "doc" && historyOpen) historyOpen = false;
      unmounted = true;
      refreshSeq++;
      dismissUndo();
      pickerOff?.();
      closeComments();
      teardownViewKeys();
      document.removeEventListener("keydown", onEsc, true);
      hk.destroy();
      root.replaceChildren();
    },
    onFocus() {
      void refresh(true);
    },
  };
}
