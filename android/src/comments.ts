// 条目留言(identity-plan §4.7,314 第③笔)——手机端:时间轴卡上的 `💬 N` 徽章 +
// 从屏底滑入的留言层。桌面 `src/item-comments.ts` 的孪生,**三条纪律照搬**(315 定的形,
// 别在手机上另立一套):
//
//  1. **徽章与列表是两个真相源**:徽章走一次 `GROUP BY` 聚合计数,列表走 keyset 分页。
//     允许并发删除造成瞬时差异,**不为了「对齐」去全量拉留言正文**——那正是分页要躲开
//     的那件事(软闸下一条目也能有 500 × 200 KiB)。
//  2. **迟到响应判弃**:每次开层领一个 session **对象**,异步回调回来先核 `sheet === s`
//     (同 cardpanel 的形:同卡关掉再打开是新对象,ABA 天然不成立)与空间未变,再动 DOM。
//     跨空间那一半 api.ts 的业务包装不吞(它显式收 space、正常决议),故也归这里判。
//  3. **写命令带发起那刻的空间且正常决议**:in-flight 闸的 finally 必须跑得到,否则
//     「写下」按钮永久卡死(118 教训第三踩)。
//
// 端间刻意的两处不同(记档,别当漂移):
//  - **开层不自动弹键盘**:手机上先读后写,一开层就顶起键盘会把刚要读的列表压掉半屏;
//    桌面开层即 focus 输入框是对的,那儿键盘不占地方。
//  - **两拍确认走底部固定确认条**(ui-audit P0 #4,安卓全局约定),不做行内换话术;
//    弹条之前先 blur 收键盘,否则条子藏在键盘底下点不到。
import {
  addItemComment,
  deleteItemComment,
  getCurrentSpace,
  itemCommentCounts,
  listItemComments,
  type Comment,
} from "./api";
import { authorLabel } from "./identity";
import { createKbSheet, type KbSheet } from "./kbsheet";
import { $, confirmBar, esc, fmtWhen, hideConfirmBar, showBar, showError } from "./ui";

type Deps = {
  /** 写/删成功后的整轴重拉(main.ts 的 refresh,single-flight):徽章计数跟着走。 */
  refresh: () => Promise<void>;
  /** 返回键层账本(143):开层压一枚守门条目。 */
  pushLayer: () => void;
  /** UI 主动收层之后平掉那枚守门条目(popstate 关的层不许调)。 */
  settleHistory: () => void;
};

let deps: Deps;
let kb: KbSheet | null = null;

// ---- 徽章计数(按空间键住的模块快照,照 identity.ts 的形)-----------------------

let counts: { space: string; map: Map<string, number> } | null = null;

/** 取一次全库留言计数并落进快照。调用方在 `Promise.all` 里与时间轴查询**并发**发起。
 *  失败**不抛**——徽章同署名一样是装饰,不该让整屏内容陪葬(旧快照保留,下次刷新再试)。 */
export async function loadCommentCounts(space: string): Promise<void> {
  try {
    const m = await itemCommentCounts(space);
    counts = { space, map: new Map(Object.entries(m)) };
  } catch {
    /* 保留旧快照;徽章少更新一轮,不影响任何数据 */
  }
}

/** 卡上的 `💬 N` 徽章 HTML;**N=0 返回空串**(布局未定不显示,ui-guidelines)。
 *  N=0 时第一条留言的写入口不在这里——它在卡片操作面板的「留言」上(§4.7 第 1 条:
 *  手机没有 ⋯ 菜单,入口归操作面板,**必须有一个**)。 */
export function commentBadgeHtml(space: string, itemId: string): string {
  const n = counts && counts.space === space ? (counts.map.get(itemId) ?? 0) : 0;
  if (n === 0) return "";
  return `<button class="cm-badge" data-cm="${esc(itemId)}" aria-label="看留言">💬 ${n}</button>`;
}

// ---- 留言层 --------------------------------------------------------------------

type Sheet = {
  space: string;
  itemId: string;
  /** 分页游标:**只在整页成功进了 DOM 之后**才推进(失败重试不跳页、不重复 append)。 */
  cursor: [string, string] | null;
  /** 已翻过页 = 用户在往回读,自动重拉会把他弹回第一页。 */
  paged: boolean;
  loading: boolean;
  /** 写/删 in-flight:防双击(一次点击 = 一条留言,重复提交造不出「撤销」)。 */
  busy: boolean;
};

/** 全 app 至多一层(层只从时间轴开,而开着时遮罩压住时间轴,故天然不会叠)。 */
let sheet: Sheet | null = null;

const listEl = (): HTMLElement => $("cm-list");
const inputEl = (): HTMLTextAreaElement => $("cm-input") as HTMLTextAreaElement;

/** 本层还是不是这一发的(迟到响应判弃的唯一判据)。 */
function live(s: Sheet): boolean {
  return sheet === s && s.space === getCurrentSpace();
}

function setBusy(s: Sheet, v: boolean): void {
  s.busy = v;
  $("comments-sheet").classList.toggle("busy", v);
  ($("cm-send") as HTMLButtonElement).disabled = v;
}

export function initComments(d: Deps): void {
  deps = d;
  kb = createKbSheet({
    sheet: $("comments-sheet"),
    scrim: $("comments-scrim"),
    input: inputEl(),
    reserveTop: 72, // 顶上留一条背景,读得出「这是盖在时间轴上的一层」
    onOpen: () => document.body.classList.add("cm-open"), // 悬浮 ＋ 让位(它在遮罩之下)
    onClose: () => document.body.classList.remove("cm-open"),
    onDismiss: () => closeComments(), // 点遮罩 = 用户主动收层:守门条目要同轮平掉
  });
  $("cm-close").addEventListener("click", () => closeComments());
  $("cm-more").addEventListener("click", () => {
    const s = sheet;
    if (!s) return;
    s.paged = true; // 从此不自动重拉:用户在往回读,别把他弹回第一页
    void loadPage(s, true);
  });
  // 层内按钮不抢输入焦点,免点一下就收键盘、层跳一下(同捕获层的「记下」)。
  $("cm-send").addEventListener("mousedown", (e) => e.preventDefault());
  $("cm-send").addEventListener("click", () => void submit());
  listEl().addEventListener("click", onListClick);
  // ⚠ 刻意不接 Enter 发出:手机软键盘上的回车就是换行(桌面那条 Enter/Shift+Enter 的
  // 约定在这里会变成「想换行却发出去了」)。发出只走「写下」。
}

/** 开某条条目的留言层(徽章点击与操作面板「留言」共用这一个入口)。 */
export function openComments(space: string, itemId: string): void {
  if (!kb) return;
  const first = sheet === null;
  const s: Sheet = { space, itemId, cursor: null, paged: false, loading: false, busy: false };
  sheet = s;
  hideConfirmBar(); // 上一发挂着的确认不许作用到新语境
  setBusy(s, false);
  inputEl().value = "";
  listEl().innerHTML = `<p class="muted cm-empty">读取中…</p>`;
  $("cm-more").hidden = true;
  if (first) {
    kb.open();
    deps.pushLayer(); // 返回键第一本能 = 关掉这层
  }
  void loadPage(s, false);
}

/** 收层的 DOM 部分:popstate(返回键)与 UI 关层共用;history 账目由调用方处置
 *  ——UI 关层随后 settleHistory(),popstate 已经弹掉。 */
export function closeCommentsNow(): void {
  if (!sheet) return;
  sheet = null; // 在途响应随即作废(live 判据)
  hideConfirmBar();
  kb?.close();
  listEl().innerHTML = "";
  inputEl().value = "";
  $("comments-sheet").classList.remove("busy");
}

/** UI 主动收层(✕ / 点遮罩 / 宿主没了 / 切空间):顺带平掉那枚守门条目。 */
export function closeComments(): void {
  if (!sheet) return;
  closeCommentsNow();
  deps.settleHistory();
}

export function isCommentsOpen(): boolean {
  return sheet !== null;
}

// ---- 分页读 --------------------------------------------------------------------

function renderRow(space: string, c: Comment): string {
  const who = authorLabel(space, c.born_device);
  return `<article class="cm-item" data-cm-id="${esc(c.id)}">
    <p class="cm-text">${esc(c.content)}</p>
    <footer class="cm-meta"><time>${esc(fmtWhen(c.created_at))}</time>${
      who ? `<span class="cm-author">${esc(who)}</span>` : ""
    }<button class="cm-del" data-cm-del="${esc(c.id)}">删除</button></footer>
  </article>`;
}

/** 空态占位:列表里一条真行都没有才摆。删到最后一条、首页读回 0 行都走它。 */
function paintEmpty(): void {
  const list = listEl();
  const has = list.querySelector(".cm-item") !== null;
  const ph = list.querySelector(".cm-empty");
  if (has) ph?.remove();
  else if (!ph) list.innerHTML = `<p class="muted cm-empty">还没有留言。</p>`;
}

async function loadPage(s: Sheet, next: boolean): Promise<void> {
  if (s.loading) return;
  s.loading = true;
  try {
    const page = await listItemComments(s.space, s.itemId, next ? s.cursor : null);
    if (!live(s)) return;
    const html = page.rows.map((c) => renderRow(s.space, c)).join("");
    if (next) listEl().insertAdjacentHTML("beforeend", html);
    else listEl().innerHTML = html;
    s.cursor = page.next_cursor; // 只有整页真的进了 DOM 才推进
    $("cm-more").hidden = !page.has_more; // has_more=false 才摘掉加载入口
    paintEmpty();
  } catch (err) {
    if (!live(s)) return;
    // 后端的话原样展示(宿主不存在 / 游标不合形都是有话可说的拒绝),不吞不改写。
    showError(String(err));
    if (!next) listEl().innerHTML = `<p class="cm-empty" style="color: var(--seal)">留言读取失败</p>`;
  } finally {
    s.loading = false;
  }
}

// ---- 写与销毁 ------------------------------------------------------------------

async function submit(): Promise<void> {
  const s = sheet;
  if (!s || s.busy) return;
  const ta = inputEl();
  const content = ta.value.trim();
  if (content === "") return;
  setBusy(s, true);
  try {
    await addItemComment(s.space, s.itemId, content);
    if (live(s)) {
      ta.value = "";
      s.cursor = null;
      s.paged = false; // 自己写的那条在第一页顶上,回到第一页是对的
      await loadPage(s, false);
    }
    // 写已提交:徽章数字必须跟着走,与层是否还在无关(只要空间没换)。
    if (s.space === getCurrentSpace()) void deps.refresh();
  } catch (err) {
    // 四道拒(空正文 / 200 KiB / 宿主不存在 / 500 软闸)原样报后端的话。
    if (live(s)) showError(String(err));
  } finally {
    if (sheet === s) setBusy(s, false);
    else s.busy = false;
  }
}

/** 点某条的「删除」:先收键盘(底部确认条在键盘之下,不收就看不见也点不到),
 *  再弹两拍确认——留言**不进回收站,删了就没了**(用户 2026-08-06 拍板),这一拍是
 *  唯一的挽回机会。第二拍复核 session 未变(期间换卡/收层/切空间的旧确认一律作废)。 */
function onListClick(e: Event): void {
  const s = sheet;
  if (!s || s.busy) return;
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-cm-del]")?.dataset.cmDel;
  if (!id) return;
  inputEl().blur();
  confirmBar("销毁这条留言?不进回收站、无法找回", "销毁", () => {
    if (sheet !== s || s.busy) return;
    void destroy(s, id);
  });
}

async function destroy(s: Sheet, id: string): Promise<void> {
  setBusy(s, true);
  try {
    await deleteItemComment(s.space, id);
    if (live(s)) {
      // ULID 只含字母数字,选择器安全(同 main.ts 的定位选择器)。
      listEl().querySelector(`[data-cm-id="${id}"]`)?.remove();
      paintEmpty();
    }
    if (s.space === getCurrentSpace()) void deps.refresh(); // 徽章跟着走
  } catch (err) {
    if (live(s)) showError(String(err));
  } finally {
    if (sheet === s) setBusy(s, false);
    else s.busy = false;
  }
}

// ---- 视图刷新后的两件事 --------------------------------------------------------

/** 时间轴每成功刷一次就调一次,`aliveItemIds` = 这一发拿到的**全部**条目 id。两件事:
 *  ① 宿主不在这批里了 → 收层。判据刻意是「这个视图还认不认识它」而不是「行没了」:
 *     条目被彻底删掉 / 移去别的空间 都该收起这层附属 UI;**灵感转成待办不算**——手机的
 *     灵感与任务是同一条时间轴的两个投影,那条目还在这批里,层照开(与桌面同一条判据,
 *     只是手机这个视图认识的东西更多)。⚠ 软删进回收站在手机上确实会收层:回收站是**另
 *     一张面**,不是同一视图的另一个 tab(桌面那边它在同一视图里,故不收)——同一条判据
 *     落在两端不同的视图形状上,不是两套规矩。
 *  ② 还在,且用户**没翻过页** → 重拉第一页,让别的设备写的留言自己冒出来;翻过页就不
 *     自动重拉(那是在往回读,弹回第一页是打扰)。徽章数字仍会更新——两个真相源允许
 *     瞬时不一致。 */
export function refreshOpenComments(space: string, aliveItemIds: Iterable<string>): void {
  const s = sheet;
  if (!s || s.space !== space) return;
  let alive = false;
  for (const id of aliveItemIds) {
    if (id === s.itemId) {
      alive = true;
      break;
    }
  }
  if (!alive) {
    closeComments();
    showBar("这条记录已不在,留言面已收起", true);
    return;
  }
  if (!s.paged && !s.busy) void loadPage(s, false);
}
