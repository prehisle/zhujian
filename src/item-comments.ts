// 条目留言(identity-plan §4)——灵感卡 / 任务看板卡共用的徽章 + 浮层,照
// item-images.ts 的形做成视图无关的共享件:同一个概念在两处必须长得一样、行为一样。
//
// 三条本模块特有的纪律:
//  1. **徽章与列表是两个真相源**(§4.14.2 第 4 条):徽章走一次 `GROUP BY` 聚合计数,
//     列表走 keyset 分页。允许并发删除造成瞬时差异——**不为了「对齐」去全量拉留言正文**
//     (那正是分页要躲开的那件事:软闸下一条目也能有 500 × 200 KiB)。
//  2. **迟到响应判弃**:浮层每次打开领一个会话号,所有异步回调先核会话号再动 DOM。
//     跨空间的迟到响应由 space.ts 的 invoke 包装吞掉;同一空间内「切了卡 / 关了面板」
//     的迟到响应它管不着,那是这里的事——否则 A 条目的留言会画到 B 上。
//  3. **写命令走 `invokeInSpace`**:统一包装的「永不决议」会让 in-flight 闸的 finally
//     永不执行、提交按钮永久卡死(118 教训第三踩)。这里显式带发起那刻的空间,响应恒
//     到达,动不动 UI 由会话号判。
//
// 浮层 portal 到 body:已登记进 hotkey-menu.ts 的 SATELLITE_LAYERS(卫星浮层白名单),
// 新增 portal 层也须进那份名单,否则点它会误触发别卡编辑态的默认保存。
import { invoke, invokeInSpace } from "./space";
import { authorLabel } from "./identity";
import { t } from "./i18n";
import { when } from "./tasktime";
import "./item-comments.css";

/** core `comments::Comment` 的镜像(壳直接返回 core 类型,故这里是唯一一份 TS 侧抄写)。 */
export type Comment = { id: string; content: string; created_at: string; born_device: string | null };

/** core `comments::CommentPage` 的镜像。`next_cursor` 是 `(created_at, id)` 元组,
 *  serde 把 Rust 元组序列化成数组——原样收下、原样传回,前端不解释它的内部结构。 */
export type CommentPage = { rows: Comment[]; next_cursor: [string, string] | null; has_more: boolean };

// ---- small DOM helper(与 item-images.ts 同款,保持共享件自足)-------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

// ---- 徽章聚合(按空间键住的模块快照,照 identity.ts 的形)-------------------

/** core `comments::CommentBadge` 的镜像(0038:留言数 + 有没有本机没看过的)。 */
export type CommentBadgeInfo = { n: number; unread: boolean };

let counts: { space: string; map: Map<string, CommentBadgeInfo> } | null = null;

/** 取一次全库徽章聚合并落进快照。视图在 `Promise.all` 里与列表查询**并发**发起。
 *  返回值给调用方进重渲指纹——同步来了新留言时,徽章数字与未读点都要跟着变。 */
export async function loadCommentCounts(space: string): Promise<Record<string, CommentBadgeInfo>> {
  const m = await invoke<Record<string, CommentBadgeInfo>>("item_comment_counts");
  counts = { space, map: new Map(Object.entries(m)) };
  return m;
}

/** 这条条目的留言数;快照没到 / 空间对不上 = 0(不猜,也不显徽章)。 */
export function commentCountFor(space: string, itemId: string): number {
  if (!counts || counts.space !== space) return 0;
  return counts.map.get(itemId)?.n ?? 0;
}

/** 卡片上的 `💬 N` 徽章;**N=0 返回 null**(布局未定不显示,ui-guidelines)。
 *  有本机没看过的留言时挂 `.unread` 点一枚朱砂点(0038;开过留言层即消)。
 *  N=0 时的写入口不在这里——它在卡片 ⋯ 菜单的「留言」上(否则第一条留言无从写起)。
 *
 *  `onOpen` = 点徽章时怎么开这一层。**不传 = 浮层**(看板:列窄到 200px,就地展开
 *  会把同列下面的卡全推走、列内滚动位置乱跳);随记那侧传「卡内就地展开」进来。
 *  两侧形不同是按容器形状算出来的,不是漂移——判据见本文件末 openInlineComments。 */
export function commentBadge(
  space: string,
  itemId: string,
  onChanged: () => void,
  onOpen?: () => void,
): HTMLElement | null {
  const info = counts && counts.space === space ? counts.map.get(itemId) : undefined;
  if (!info || info.n === 0) return null;
  const b = el("button", {
    className: info.unread ? "cm-badge unread" : "cm-badge",
    textContent: t("comments.badge", { n: info.n }),
    title: info.unread ? t("comments.badgeTitleUnread") : t("comments.badgeTitle"),
    draggable: false, // 看板卡可拖:点徽章绝不许变成拖卡片
  });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    if (onOpen) onOpen();
    else openComments(space, itemId, onChanged);
  });
  return b;
}

// ---- 浮层 -------------------------------------------------------------------

/** 这一层长在哪儿。`overlay` = portal 到 body 的居中浮层(看板);`inline` = 就地长在
 *  卡片里(随记)。**分野判据是容器形状,不是偏好**:随记是一整行全宽、纵向排,展开
 *  只影响自己下面的卡;看板是 200px 起的窄列、列自己还要滚,同一份内容塞不进去。 */
type PanelMode = "overlay" | "inline";

type Panel = {
  space: string;
  itemId: string;
  session: number;
  mode: PanelMode;
  close: () => void;
  /** 同步落地 / 视图重渲时重拉第一页(只在还没翻过页时;见 refreshOpenComments)。 */
  reloadFirstPage: () => void;
  /** 已翻过页 = 用户在读旧留言,自动重拉会把他弹回第一页。 */
  paged: boolean;
  /** 输入框里还没发出去的草稿。inline 那侧宿主卡片会被整列重渲换掉,重挂时得带回去
   *  ——照 compose 那条「敲过滤词不许毁正文」的先例(inbox refresh 里存/灌那一对)。 */
  draft: () => string;
  /** 本层已经推到的已读水位。inline 重挂时必须带回:新层的 `lastMarked` 是空的,会再推
   *  一次 `mark_item_comments_seen` → `onChanged` → 重渲 → 再挂 → 再推,**无限循环**。 */
  marked: () => string | null;
  /** 光标此刻是不是就在留言输入框里。重挂时只把焦点还给本来就握着它的人——用户在别处
   *  (compose 框 / 没焦点)时抢过来,等于同步一落地就把他的光标偷走。 */
  hasFocus: () => boolean;
};

/** 全视图至多一层(§4.14.2 第 6 条),两种形态共用这一格。 */
let open: Panel | null = null;
let sessionSeq = 0;

/** 打开某条条目的留言层。`onChanged` = 写/删成功后调,让宿主视图重取计数刷新徽章。
 *  `host` 非空 = 就地长在这个容器里(inline);为空 = 老的居中浮层。 */
function openPanel(
  space: string,
  itemId: string,
  onChanged: () => void,
  mode: PanelMode,
  host: HTMLElement | null,
  opts: { draft?: string; marked?: string | null; focus?: boolean; remount?: boolean; onClose?: () => void } = {},
): void {
  open?.close(); // 单层:再开一个先关掉旧的(它的会话号随即作废)
  const session = ++sessionSeq;
  const live = (): boolean => open !== null && open.session === session;

  const list = el("div", { className: "cm-list" });
  const err = el("p", { className: "cm-err", hidden: true });
  const more = el("button", { className: "cm-more", textContent: t("comments.loadMore"), hidden: true });
  const area = el("textarea", {
    className: "cm-input",
    rows: 2,
    placeholder: t("comments.inputPlaceholder"),
    value: opts.draft ?? "",
  });
  const send = el("button", { className: "cm-send", textContent: t("comments.send") });
  const panel = el("div", { className: mode === "inline" ? "cm-panel cm-inline" : "cm-panel" }, [
    el("header", { className: "cm-head" }, [
      el("h3", { className: "cm-title", textContent: t("comments.title") }),
      el("button", { className: "cm-close", textContent: "✕", title: t("comments.closeTitle") }),
    ]),
    list,
    more,
    err,
    el("div", { className: "cm-compose" }, [area, send]),
  ]);
  // 遮罩只属于浮层那一形。inline 那侧刻意**没有**遮罩、也没有「点别处收起」:它是卡片的
  // 一部分(同编辑态),而框里可能有半打的草稿——点旁边看一眼就把话弄丢是不能接受的。
  // 收起只有三条路:再点一次徽章、点 ✕、Esc。
  const overlay = mode === "overlay" ? el("div", { className: "cm-overlay" }, [panel]) : null;

  const showErr = (e: unknown): void => {
    // 后端的话原样展示(200 KiB / 500 软闸 / 宿主不存在都是有话可说的拒绝),不吞不改写。
    err.textContent = String(e);
    err.hidden = false;
  };
  const clearErr = (): void => {
    err.hidden = true;
  };

  // ---- 分页:cursor 只在**成功纳入页面之后**推进 ----------------------------
  let cursor: [string, string] | null = null;
  let loading = false;
  // ---- 已读水位(0038):第一页渲染成功 = 「看见了」,把水位推到页首那条 -------
  // 只在**值真的前进**时才推并刷徽章 —— refreshOpenComments(视图刷新)会重拉第一页,
  // 若无条件推+onChanged,会形成「推 → 刷视图 → 重拉 → 再推」的循环。
  let lastMarked: string | null = opts.marked ?? null;
  function markSeen(page: CommentPage): void {
    const top = page.rows[0]?.id;
    if (!top || top === lastMarked) return;
    lastMarked = top;
    // 纯本地簿记:写失败唯一后果是红点多亮一轮,弹给用户反而莫名其妙 —— 记 console 即可
    // (这不是「静默吞错」:数据面命令的失败仍然全部上屏,这里吞的只是装饰的簿记)。
    invokeInSpace(space, "mark_item_comments_seen", { itemId, seenId: top })
      .then(() => onChanged())
      .catch((e) => console.error("留言已读水位没推上去:", e));
  }
  function renderRow(c: Comment): HTMLElement {
    const row = el("article", { className: "cm-item" });
    const text = el("p", { className: "cm-text", textContent: c.content });
    const who = authorLabel(space, c.born_device);
    const meta = el("div", { className: "cm-meta" }, [
      // 时间口径走 tasktime 的 when()(回收站 / 编辑历史 / 搜索同一把尺):「6月13日 14:23」,
      // 跨年补年份。别在这里另起一个 Intl 格式化器——那是第二把尺。
      el("time", { className: "cm-time", textContent: when(c.created_at) }),
    ]);
    if (who) meta.append(el("span", { className: "cm-author", textContent: who }));
    const del = el("button", { className: "cm-del", textContent: t("comments.delete"), title: t("comments.deleteTitle") });
    // 两拍确认:留言**不进回收站,删了就没了**(用户 2026-08-06 拍板),所以这一拍是
    // 唯一的挽回机会。就地把按钮换成问句 + 两个按钮,同看板 confirmInline 的形。
    del.addEventListener("click", () => {
      const q = el("span", { className: "cm-confirm", textContent: t("comments.confirmDestroy") });
      const yes = el("button", { className: "cm-del danger", textContent: t("comments.destroy") });
      const no = el("button", { className: "cm-no", textContent: t("comments.cancel") });
      yes.addEventListener("click", () => void destroy(c.id, row));
      no.addEventListener("click", () => meta.replaceChildren(...metaKids));
      meta.replaceChildren(metaKids[0], q, yes, no);
    });
    meta.append(del);
    const metaKids = [...meta.childNodes];
    row.append(text, meta);
    return row;
  }
  function appendRows(page: CommentPage): void {
    for (const c of page.rows) list.append(renderRow(c));
    cursor = page.next_cursor; // 只有整页真的进了 DOM 才推进——失败重试不许跳页
    more.hidden = !page.has_more;
    if (list.childElementCount === 0) list.append(el("p", { className: "cm-empty", textContent: t("comments.empty") }));
  }
  async function loadPage(next: boolean): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      const page = await invoke<CommentPage>("list_item_comments", { itemId, cursor: next ? cursor : null });
      if (!live()) return;
      if (!next) list.replaceChildren();
      appendRows(page);
      clearErr();
      if (!next) markSeen(page); // 翻旧页不推:旧留言的 id 都在水位之下

    } catch (e) {
      if (live()) showErr(e);
    } finally {
      loading = false;
    }
  }
  more.addEventListener("click", () => {
    if (open) open.paged = true; // 从此不自动重拉:用户在往回读,别把他弹回第一页
    void loadPage(true);
  });

  // ---- 写 --------------------------------------------------------------------
  let sending = false;
  async function submit(): Promise<void> {
    const content = area.value.trim();
    if (content === "") return;
    if (sending) return; // 防双击:一次点击 = 一条留言(重复提交造不出「撤销」)
    sending = true;
    send.disabled = true;
    try {
      // 必落账写:显式带发起那刻的空间,响应恒到达(统一包装会把它变成永不决议)。
      await invokeInSpace(space, "add_item_comment", { itemId, content });
      if (!live()) return; // 面板已关 / 已换卡:库里已经写下了,只是不再动这块 DOM
      area.value = "";
      clearErr();
      cursor = null;
      if (open) open.paged = false; // 自己写的那条在第一页顶上,回到第一页是对的
      await loadPage(false);
      onChanged();
    } catch (e) {
      if (live()) showErr(e);
    } finally {
      sending = false;
      send.disabled = false;
    }
  }
  async function destroy(id: string, row: HTMLElement): Promise<void> {
    try {
      await invokeInSpace(space, "delete_item_comment", { id });
      if (!live()) return;
      row.remove();
      if (list.childElementCount === 0) list.append(el("p", { className: "cm-empty", textContent: t("comments.empty") }));
      clearErr();
      onChanged();
    } catch (e) {
      if (live()) showErr(e);
    }
  }
  send.addEventListener("click", () => void submit());
  area.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的 Enter 属于输入法(ui-audit P0 #1)
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  });

  // ---- 生命周期 --------------------------------------------------------------
  function close(): void {
    if (open?.session !== session) return; // 已被后来者顶掉:别去拆别人的层
    open = null;
    (overlay ?? panel).remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.(); // 宿主收尾(inline:把卡片的 commenting 标记摘掉)
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    close();
  }
  overlay?.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close(); // 点浮层以外收起(同 ⋯ 菜单 / 内联选择器的约定)
  });
  panel.querySelector<HTMLButtonElement>(".cm-close")?.addEventListener("click", () => close());
  document.addEventListener("keydown", onKey, true);

  open = {
    space,
    itemId,
    session,
    mode,
    close,
    reloadFirstPage: () => void loadPage(false),
    paged: false,
    draft: () => area.value,
    marked: () => lastMarked,
    hasFocus: () => document.activeElement === area,
  };
  if (overlay) document.body.append(overlay);
  else host!.append(panel);
  void loadPage(false);
  if (opts.focus !== false) area.focus();
  // 滚动只在 inline 那一形要管(浮层天然居中)。`nearest` 一律 = 已经看得见就不动。
  //  · 手点展开:把**整块**带进视口(用户要读的是列表);
  //  · 重挂(整列重渲后):滚**输入框**——写完一条会多出一行、把框顶到视口外,而他多半
  //    正要接着写第二条;把面板顶部再对齐一次反而是抢他的位置。
  //  · 重挂且焦点不在框里:一下都不滚(他正在别处,同步落地不该动他的视口)。
  if (mode === "inline") {
    if (!opts.remount) panel.scrollIntoView({ block: "nearest" });
    else if (opts.focus !== false) area.scrollIntoView({ block: "nearest" });
  }
}

/** 居中浮层(看板)。徽章点击与 ⋯ 菜单「留言」共用这一个入口。 */
export function openComments(space: string, itemId: string, onChanged: () => void): void {
  openPanel(space, itemId, onChanged, "overlay", null);
}

/** 卡片内就地展开(随记)。`host` = 卡片里那个空容器,面板直接长在它下面。
 *
 *  ⚠ 宿主视图整列重渲(`list.replaceChildren`)会把这块 DOM 连根换掉,故**宿主自己
 *  负责重挂**:重渲前读 `inlineCommentState()` 存下,重渲后对同一条目再调一次本函数、
 *  把 `draft` / `marked` 原样传回。不传 `marked` 会推出无限重渲(见 Panel.marked)。
 *  重挂会丢掉「翻到第几页」和列表滚动位置——刻意接受:这一形是给「一条卡上几句短话」
 *  的量级设计的,真长成讨论串该重新论证形,而不是在这里补状态。 */
export function openInlineComments(
  host: HTMLElement,
  space: string,
  itemId: string,
  onChanged: () => void,
  opts: { draft?: string; marked?: string | null; focus?: boolean; remount?: boolean; onClose?: () => void } = {},
): void {
  openPanel(space, itemId, onChanged, "inline", host, opts);
}

/** 当前就地展开着的是哪条、框里有什么没发出去的话、已读水位推到哪儿、光标在不在框里。
 *  不是 inline / 没开 / 空间对不上 = null。宿主重渲前后就靠这一格接力。 */
export function inlineCommentState(
  space: string,
): { itemId: string; draft: string; marked: string | null; focused: boolean } | null {
  if (!open || open.mode !== "inline" || open.space !== space) return null;
  return { itemId: open.itemId, draft: open.draft(), marked: open.marked(), focused: open.hasFocus() };
}

/** 视图刷新(本地写 / 同步落地 / 定时重拉)后调一次,`aliveItemIds` = 本视图这一发
 *  拿到的**全部**条目 id(灵感:想法 + 回收站;看板:三列 + 回收站 + 归档册)。两件事:
 *  ① 宿主不在这批里了 → 关掉浮层。判据刻意是「这个视图还认不认识它」而不是「行没了」:
 *     条目被彻底删掉 / 移去别的空间 / 从灵感转成待办,都该收起这层附属 UI;而**软删进
 *     回收站不算** —— 那条目还在,留言也照 §4.4 原样留着,关掉反而是丢状态;
 *  ② 还在,且用户**没翻过页** → 重拉第一页,让别的设备写的留言自己冒出来。
 *  翻过页就不自动重拉:那说明他正在往回读,弹回第一页是打扰(徽章数字仍会更新,
 *  两个真相源允许瞬时不一致)。 */
export function refreshOpenComments(space: string, aliveItemIds: Iterable<string>): void {
  const p = open;
  if (!p || p.space !== space) return;
  // inline 那侧这一层就长在即将被 replaceChildren 换掉的卡片里:重拉第一页画给一块马上
  // 要脱离文档的 DOM 毫无意义,而留着 `open` 指向它 = document 上那记 Esc 监听泄漏(按
  // Esc 会「关掉」一个看不见的层)。一律先收,重挂由宿主按 inlineCommentState() 负责。
  // ⚠ 调用方必须**先读 inlineCommentState() 再调本函数**,否则草稿与已读水位就丢了。
  if (p.mode === "inline") {
    p.close();
    return;
  }
  let alive = false;
  for (const id of aliveItemIds) {
    if (id === p.itemId) {
      alive = true;
      break;
    }
  }
  if (!alive) {
    p.close();
    return;
  }
  if (!p.paged) p.reloadFirstPage();
}

/** 视图卸载 / 切空间时调:留下的浮层会指着已经不存在的空间。 */
export function closeComments(): void {
  open?.close();
}
