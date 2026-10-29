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
import { currentSpaceId, invokeInSpace } from "./space";
import { autoGrow } from "./autogrow";
import { dismissUndo, toastError, toastUndo } from "./toast";
import { copyText } from "./clipboard";
import { buildItemDeepLink } from "./deeplink";
import { armLocate } from "./locate";
import { DOC_CARD_KEYS, DOC_VIEW_KEYS } from "./keymap";
import { type Act, armDismiss, createHotkeyController, registerViewKeys } from "./hotkey-menu";
import { t } from "./i18n";
import { type ImageMeta, REPASTE_HINT, imageStrip, openLightbox, pendingImages, wirePasteToAttach } from "./item-images";
import { toggleChecklistLine } from "../shared/checklist";
import { renderMarkdown } from "../shared/markdown-dom";
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

  const docById = (id: string): DocItem | undefined => docs.find((d) => d.id === id);

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
    const body = el("div", { className: "doc-card-body" }, [
      el("h2", { className: title === "" ? "doc-card-title untitled" : "doc-card-title", textContent: title === "" ? t("docs.untitled") : title }),
      el("p", { className: "doc-card-ex", textContent: excerpt(d.content, title) }),
      el("time", { className: "doc-card-time", textContent: when(d.created_at) }),
      tagChips(d),
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
        { label: t("docs.actDelete"), key: DOC_CARD_KEYS.delete, run: () => void doDelete(d), danger: true },
      ],
      () => body.querySelector(".topic-picker") !== null,
    );
    art.append(body, handle.menu());
    // 点卡片 = 打开(⋯ 菜单 / 选择器里的点击不算)
    art.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button, input, .hk-menu-wrap, .topic-picker")) return;
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

  /** 正文 → DOM(共用渲染器)。配图映射每篇建一次;勾方框走 edit_note 落一版(同随记,⛔ 不猜行)。 */
  function renderBody(content: string, imgs: ImageMeta[], onToggle: ((line: number) => void) | null): HTMLElement {
    const bySeq = new Map(imgs.map((m) => [m.seq, m]));
    const r = renderMarkdown(content, {
      openLink: (url) => void openUrl(url).catch(() => {}),
      image: (n) => {
        const m = bySeq.get(n);
        if (m === undefined) return null;
        return { label: t("itemImages.badge", { n }), open: () => void openLightbox(imgs, imgs.indexOf(m)) };
      },
      checkbox: (checked, line) => ({
        label: onToggle === null ? (checked ? t("checklist.checked") : t("checklist.unchecked")) : checked ? t("checklist.uncheck") : t("checklist.check"),
        toggle: onToggle === null ? null : () => onToggle(line),
      }),
    });
    const wrap = el("div", { className: "doc-body" }, [r.root]);
    if (r.degraded !== null) wrap.prepend(el("p", { className: "doc-note", textContent: t("docs.degraded") }));
    return wrap;
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
    const paint = (): void => {
      bodyHost.replaceChildren(renderBody(content, imgs, toggle));
    };
    paint();
    const strip = imageStrip(d.id, {
      editable: false,
      onMetas: (m) => {
        imgs = m;
        paint();
      },
    });

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
      { label: t("docs.actEdit"), key: DOC_CARD_KEYS.edit, run: () => openEditor(d, null) },
      { label: t("docs.actHistory"), key: DOC_CARD_KEYS.history, run: () => openHistory(d) },
      { label: t("docs.actTag"), key: DOC_CARD_KEYS.tag, run: () => void openTags(tagHost, d, showErr) },
      { label: t("docs.actComments"), key: DOC_CARD_KEYS.comments, run: () => toggleComments() },
      { label: t("docs.actCollapse"), key: DOC_CARD_KEYS.collapse, run: () => void doCollapse(d) },
      { label: t("docs.actCopy"), key: DOC_CARD_KEYS.copy, feedback: copyFeedback(d) },
      { label: t("docs.actCopyLink"), key: DOC_CARD_KEYS.copyLink, feedback: copyLinkFeedback(d) },
      { label: t("docs.actDelete"), key: DOC_CARD_KEYS.delete, run: () => void doDelete(d), danger: true },
    ];
    const handle = hk.register(art, actions, () => art.classList.contains("commenting") || tagHost.querySelector(".topic-picker") !== null);
    art.append(...(draftBar ? [draftBar] : []), bodyHost, tagHost, strip.root, meta, err, cmHost, handle.menu());
    art.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("a, button, input, textarea, .hk-menu-wrap, .img-thumb, .cm-host")) return;
      openEditor(d, null);
    });

    main.replaceChildren(
      bar(
        [backBtn(t("docs.back"), () => go({ kind: "list" }))],
        [
          el("button", { className: "hbtn", type: "button", onclick: () => openEditor(d, null) }, [
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

  /** `d = null` = 新建。`seed` = 从草稿接着改时的起始文字(否则用正文)。 */
  function openEditor(d: DocItem | null, seed: string | null): void {
    hk.reset();
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

    // 配图:已存过的篇直接挂;新篇还没有 id,先暂存、第一次保存拿到 id 再挂(同「记下」那几处)。
    // ⚠ `previewDue` 必须先于 imageStrip 声明:它的乐观首帧会**同步**调 onMetas → paintPreview。
    let imgs: ImageMeta[] = [];
    let previewDue: ReturnType<typeof setTimeout> | null = null;
    const strip = id !== null ? imageStrip(id, { editable: true, onMetas: (m) => ((imgs = m), paintPreview()) }) : null;
    const pending = id === null ? pendingImages() : null;
    if (strip && id !== null) wirePasteToAttach(area, id, () => void strip.reload(), showImgErr);
    if (pending) pending.wire(area);

    function paintPreview(): void {
      previewDue = null;
      preview.replaceChildren(renderBody(area.value, imgs, null));
    }
    // 预览只在看得见时画,且停笔 300ms 后才画(200 KiB 一篇解析要几十毫秒,⛔ 别逐键同步算)
    const previewVisible = (): boolean => edWrap.classList.contains("show-preview") || window.matchMedia("(min-width: 1180px)").matches;
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
        lastGen = saveDraft(mountSpace, id, area.value);
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
    });

    // 落一版。新篇第一次:capture_doc(同一事务 create + set doc_at)拿到 id,再挂暂存图。
    // "same" = 没有要写的(正文没变、没有待删 / 暂存的图),"failed" = 错误已写在编辑器里。
    // `final` = unmount 那一发:只落正文,⛔ 不删图(删图的命令认的是「当前空间」,切空间引起的
    // unmount 那一刻它已经指着别的空间;标了删的图随编辑器一起丢掉,同随记的 Esc)。
    let saving = false;
    let newId: string | null = null;
    async function commit(final = false): Promise<"wrote" | "same" | "failed"> {
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
      const imgsToDelete = !final && strip !== null && strip.pendingDeletes() > 0;
      const imgsToAttach = pending !== null && pending.count() > 0;
      if (text === saved && !imgsToDelete && !imgsToAttach) {
        settle(curId, gen);
        return "same";
      }
      if (curId === null && text.trim() === "") {
        settle(null, gen);
        return "same"; // 新篇一个字没写就走 = 不建(暂存的图随编辑器丢掉)
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
        if (imgsToAttach && pending !== null) {
          const out = await pending.attachBatch(target, pending.takeBatch(), mountSpace);
          if (out.failed > 0) toastError(t("inbox.savedImagesFailed", { n: out.failed }) + (out.why || REPASTE_HINT));
        }
        if (imgsToDelete && strip !== null) await strip.commitDeletes();
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
      if (draftDue !== null) clearTimeout(draftDue);
      if (previewDue !== null) clearTimeout(previewDue);
      document.removeEventListener("keydown", onKey);
      leaveEditor = null;
      flushEditor = null;
    }
    const leave = (then: () => void): void => {
      void commit().then((r) => {
        if (r === "failed" || unmounted) return;
        teardown();
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
        void commit().then((r) => {
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
    const edWrap = el("div", { className: "doc-editor" }, [area, preview]);
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
    const imgRow = el("div", { className: "img-editor" }, [...(strip ? [strip.root] : []), ...(pending ? [pending.root] : []), imgErr]);

    main.replaceChildren(
      bar(
        [backBtn(id === null ? t("docs.back") : t("docs.backToDoc"), () => leave(done)), el("span", { className: "segs" }, [modeEdit, modePrev])],
        [status, saveBtn],
      ),
      el("div", { className: "doc-edit-page" }, [edWrap, imgRow, err]),
    );
    if (previewVisible()) paintPreview();
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
    autoGrow(area);
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
    if (document.querySelector(".hk-menu, .topic-picker") !== null || inlineCommentState(mountSpace) !== null) return;
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
