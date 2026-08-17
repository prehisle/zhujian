import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";
import { mount as mountInbox, inboxHasStashedDraft, focusInboxItem } from "./inbox";
import { mount as mountBoard, boardHasStashedDraft, focusTask, focusBoardView } from "./board";
import { mount as mountTopics } from "./topics";
import { mount as mountSearch } from "./search";
import { parseDeepLink, consumePendingDeepLink } from "./deeplink";
import { t, initLang, applyStaticI18n } from "./i18n";
import { initSync, seedSpaceStatuses, setSpaceNames, showToast, syncSpaceSwitched, DEFAULT_SYNC_URL } from "./sync";
import { initSettings, openSettingsPanel } from "./settings";
import { initZoom } from "./zoom";
import { initTheme } from "./theme-mode";
import { initUpdate, checkForUpdateOnFocus } from "./update";
import { initAutoBackupBanner } from "./backup";
import {
  createSpace,
  currentSpaceId,
  dotClass,
  initCurrentSpace,
  invokeInSpace,
  joinSpace,
  joinSpaceCancel,
  listSpaces,
  renameSpace,
  resetSpace,
  setCurrentSpace,
  spaceLabel,
} from "./space";
import type { SpaceInfo } from "./space";

// The notebook is one window hosting many views. Only one view is mounted into
// the shared content root at a time, so each view can own page-scoped DOM ids
// (e.g. #list) without colliding with its siblings.
export type ViewName = "inbox" | "board" | "topics" | "search";

export interface View {
  unmount(): void;
  /** Called when the notebook window regains focus (data may have changed). */
  onFocus?(): void;
}

export interface ViewCtx {
  /** Switch the content area to another view. */
  navigate(name: ViewName): void;
}

export type MountFn = (root: HTMLElement, ctx: ViewCtx) => View;

// ---- view registry -------------------------------------------------------
// inbox (灵感) is the default landing view; all four are reached from the sidebar.
const registry: Record<ViewName, MountFn> = {
  inbox: mountInbox,
  board: mountBoard,
  topics: mountTopics,
  search: mountSearch,
};

// ---- shell ----------------------------------------------------------------
const win = getCurrentWindow();

// mac 用系统原生红绿灯(壳层给 notebook 窗开了 titleBarStyle Overlay):打个 body
// 标记,让 CSS 隐藏自绘窗口按钮、并给左上角红绿灯让出侧栏顶部空间。WKWebView 的
// userAgent 在 macOS 上含「Macintosh」;Windows(WebView2)/Linux 不含,保持自绘按钮。
if (navigator.userAgent.includes("Macintosh")) {
  document.body.classList.add("is-macos");
}

const viewRoot = document.getElementById("view") as HTMLElement;
const navButtons = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".sidebar nav button"),
);

let current: View | null = null;
// 当前视图名:切空间时按它原地重挂(= 对新空间全量重查;各视图模块态里的筛选/
// 展开集合对新空间自然失配,失配的表现只是「筛不到/全收起」,点一下即回,v1 接受)。
let currentName: ViewName = "inbox";

const ctx: ViewCtx = { navigate };

// Remember the mounted view across real restarts. Hide-not-destroy already keeps
// the view alive within one run; this key only matters after 托盘退出 → relaunch.
// Device-local UI state, deliberately localStorage and NOT the DB — it is not
// user data and must never ride along into a future sync surface.
const LAST_VIEW_KEY = "zhujian.last-view";

// Switching views unmounts+remounts, so per-view state that should survive a switch
// (e.g. the board's 标签 filter, the 灵感 tab, the 搜索 query) lives at module scope in
// each view, NOT here.
function navigate(name: ViewName): void {
  current?.unmount();
  viewRoot.replaceChildren();
  current = registry[name](viewRoot, ctx);
  currentName = name;
  for (const b of navButtons) b.classList.toggle("active", b.dataset.view === name);
  localStorage.setItem(LAST_VIEW_KEY, name);
}

for (const b of navButtons) {
  b.addEventListener("click", () => navigate(b.dataset.view as ViewName));
}

document.getElementById("win-min")?.addEventListener("click", () => void win.minimize());
document.getElementById("win-close")?.addEventListener("click", () => void win.hide());

// Maximize / restore. The glyph follows the real window state (the button, a
// double-click on the header drag-region, or an OS maximize all funnel through
// onResized → syncMaxGlyph), so it never lies about whether we're maximized.
const maxBtn = document.getElementById("win-max");
// 图标走内联 SVG(不依赖 Windows 独有的 Segoe 图标字体,mac/Linux 同样渲染):
// 未最大化=单方框;已最大化=双叠方框(向下还原)。随窗口状态切换。
const SVG_MAXIMIZE =
  '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1" y="1" width="8" height="8" /></svg>';
const SVG_RESTORE =
  '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M3 3 V1 H9 V7 H7" /><rect x="1" y="3" width="6" height="6" /></svg>';
async function syncMaxGlyph(): Promise<void> {
  if (!maxBtn) return;
  const max = await win.isMaximized();
  maxBtn.innerHTML = max ? SVG_RESTORE : SVG_MAXIMIZE;
  maxBtn.title = max ? t("notebook.restoreDown") : t("notebook.maximize");
}
maxBtn?.addEventListener("click", () => void win.toggleMaximize());
win.onResized(() => void syncMaxGlyph());
void syncMaxGlyph();

// ---- 侧栏折叠(小按钮 + Ctrl+B)---------------------------------------------
// 设备本地 UI 状态,和 last-view 一样走 localStorage、绝不进 DB/同步。折叠把侧栏收成
// 细条、只藏 brand/nav/同步,留一个 » 作展开入口。双击 brand 刻意不接管(那是拖拽区
// 的「双击最大化窗口」)。
const SIDEBAR_KEY = "zhujian.sidebar-collapsed";
const sidebarToggle = document.getElementById("sidebar-toggle");
function applySidebar(collapsed: boolean): void {
  document.body.classList.toggle("sb-collapsed", collapsed);
  if (sidebarToggle) {
    sidebarToggle.textContent = collapsed ? "»" : "«";
    sidebarToggle.title = collapsed ? t("notebook.expandSidebar") : t("notebook.collapseSidebar");
  }
}
function toggleSidebar(): void {
  const next = !document.body.classList.contains("sb-collapsed");
  localStorage.setItem(SIDEBAR_KEY, next ? "1" : "0");
  applySidebar(next);
}
applySidebar(localStorage.getItem(SIDEBAR_KEY) === "1");
sidebarToggle?.addEventListener("click", toggleSidebar);
// Ctrl+B 全局切换。卡片单键 / 视图单键都在带修饰键时让位(hotkey-menu onKey /
// registerViewKeys 开头就 `if (ctrlKey||metaKey||altKey) return`),故与看板的 B(撤回)
// 不冲突;纯文本框里 Ctrl+B 本无默认动作,preventDefault 无害。
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && (e.key === "b" || e.key === "B")) {
    e.preventDefault();
    toggleSidebar();
  }
});

win.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    current?.onFocus?.();
    void checkClipboardForDeepLink(); // 回窗时:剪贴板若是自家深链接,弹「点此打开」
    if (import.meta.env.PROD) void checkForUpdateOnFocus(); // 回窗顺手查一次新版(节流)
  }
});

// ---- 空间切换(97 多空间,sync-plan §六):brand 下入口 + 轻浮层菜单 -------------
// 入口一行当前空间名;菜单 = 空间列表(状态点 + 当前标)+ 新建 + 改名。切空间 =
// 记住选择 → 通知同步 UI 换数据源 → 当前视图原地重挂(新空间全量重查)。
const spaceEntry = document.getElementById("space-entry") as HTMLButtonElement;
const spaceNameEl = document.getElementById("space-name") as HTMLElement;
// 同步入口:平时只是侧栏底部那枚钮,411/D2 起还兼任「空间菜单」的锚点(单空间时徽章藏起)。
const syncEntry = document.getElementById("sync-entry") as HTMLButtonElement;

function refreshSpaceEntry(): void {
  void listSpaces().then((all) => {
    setSpaceNames(new Map(all.map((s) => [s.id, spaceLabel(s)])));
    // 状态基线一并喂给同步 UI(启动即 veto 的空间没有事件桥,红点全靠这份快照)。
    seedSpaceStatuses(all);
    // D2(411,408 走查):单空间时「空间」这个概念整个不出现在侧栏——落点无歧义,
    // 菜单里那几项(切换/新建/加入/改名/重置)第一天全用不到。与安卓同源(116 捕获
    // 徽章、410 底栏「按数据显形」同一手法),捕获浮窗的 #cap-space 早就是这个规矩。
    // ⛔ 入口不许就此消失:新建 / 加入空间的**唯一**入口就在这枚徽章的菜单里,故同步
    // 面底部那行「空间…」是它的兜底,两者由「几个空间」互斥切换(sync.ts::renderHome)
    // ——永远恰有一条路,别只藏不补。
    spaceEntry.hidden = all.length <= 1;
    const curInfo = all.find((s) => s.id === currentSpaceId());
    if (curInfo) spaceNameEl.textContent = spaceLabel(curInfo);
  });
}

// 空间名变了(本地改名 / 远端改名落地 / 引导落名;space-name-sync-plan §4.7):
// 名字表全量重查——刻意**不分当前/非当前空间**(借道 sync-changed 会被「非当前
// 空间直接丢弃」的既有语义漏掉,codex 一轮 H5)。
void listen("space-name-changed", () => refreshSpaceEntry());

function switchSpace(id: string): void {
  if (id === currentSpaceId()) return;
  setCurrentSpace(id);
  refreshSpaceEntry();
  syncSpaceSwitched();
  navigate(currentName);
}

// 前台空间被别的窗切了(捕获浮窗切空间 = 方案 B「连带切 notebook」):壳侧 fg 是
// 单一真相源,notebook 跟随它整视图重挂。自己切空间也会收到这条回声——switchSpace
// 对同 id 是 no-op,幂等无害(setCurrentSpace 里已把 current 设成新值)。
void listen<string>("space-foreground", (e) => switchSpace(e.payload));

// ---- 深链接消费(zhujian://open?...)-----------------------------------------
// 壳收到一条深链接:解析 → 定位它属于本机哪个空间(acc 匹 account_id / space 匹 id)→
// 若不在当前空间先切过去(复用 switchSpace 的三步、但不先 navigate 当前视图,带着 focus
// 一次落到条目所在视图)→ 后端 locate_item 定位视图 → 复用搜索 jump 的 focus 通道高亮。
// 条目所属空间不在本机 / 条目已删 = 一句 toast 说清,不静默、不猜跳(fail-fast)。
function routeToItem(item: string, loc: string): void {
  switch (loc) {
    case "task":
      focusTask(item);
      navigate("board");
      break;
    case "sealed":
      focusTask(item);
      focusBoardView("sealed");
      navigate("board");
      break;
    case "trash-task":
      focusTask(item);
      focusBoardView("trash");
      navigate("board");
      break;
    case "inbox":
      focusInboxItem(item, "ideas");
      navigate("inbox");
      break;
    case "trash-idea":
      focusInboxItem(item, "archived");
      navigate("inbox");
      break;
    default:
      navigate(currentName); // 不认识的定位词:至少把主窗落到当前视图(不该发生)
  }
}

async function openDeepLink(raw: string): Promise<void> {
  const p = parseDeepLink(raw);
  if (!p) return; // 无关 URL 静默忽略
  // 主窗露出来 + 抢焦点:冷启动(app 被链接拉起)时主窗默认隐藏,只靠 navigate 换视图不会
  // 显窗;热启动 on_open_url 侧虽也 open_notebook,这里再显一次无害,且让 toast/定位都可见。
  void win.show();
  void win.setFocus();
  const all = await listSpaces();
  const target = p.acc
    ? (all.find((s) => s.alive && s.status.account_id === p.acc)?.id ?? null)
    : p.space
      ? (all.find((s) => s.alive && s.id === p.space)?.id ?? null)
      : null;
  if (!target) {
    showToast(t("notebook.spaceNotOnDevice"));
    return;
  }
  // 切到目标空间(若不同):不走 switchSpace 的「先 navigate 当前视图」——那会白挂一次,
  // 我们要带着 focus 一次落到条目所在视图。
  if (target !== currentSpaceId()) {
    setCurrentSpace(target);
    refreshSpaceEntry();
    syncSpaceSwitched();
  }
  let loc: string | null;
  try {
    loc = await invokeInSpace<string | null>(target, "locate_item", { itemId: p.item });
  } catch (e) {
    showToast(t("notebook.openFailed", { error: String(e) }));
    return;
  }
  if (!loc) {
    showToast(t("notebook.itemNotFound"));
    return;
  }
  routeToItem(p.item, loc);
}

// OS 桥(4b):点击的 zhujian:// 链接由 deep-link 插件 on_open_url 暂存到壳,并发一个空
// "deep-link-open" 通知。冷启动(app 被链接拉起、监听还没挂上,emit 会丢)与热启动统一走
// 「取暂存」——consume 是 take 语义、原子取走即清,谁先到都只处理一次、不重放。启动时先
// 主动取一次兜冷启动。window 全局钩子供 e2e 直驱(同安卓 __zhujianHandleBack 先例)。
async function consumeDeepLink(): Promise<void> {
  const url = await consumePendingDeepLink();
  if (url) await openDeepLink(url);
}
void listen("deep-link-open", () => void consumeDeepLink());
void consumeDeepLink();

// 捕获窗热键冲突提示条「点此改键」:壳 open_settings 置待处理旗 + 唤起主窗 + 广播事件。
// 冷启动(主窗还是 about:blank、本文件尚未加载)时事件会丢,靠启动主动取旗兜底;热路
// 靠事件即时弹。两条都走 take 语义的 take_open_settings——谁先到谁弹,另一条取到 false
// 即 no-op,绝不重复弹、也不会把旧旗留到下次重启误弹。
async function consumeOpenSettings(): Promise<void> {
  try {
    if (await rawInvoke<boolean>("take_open_settings")) await openSettingsPanel();
  } catch {
    // 壳未就绪(不该发生):静默,设置入口另有侧栏「设置」可点。
  }
}
void listen("open-settings", () => void consumeOpenSettings());
void consumeOpenSettings();
(window as unknown as { __zhujianOpenDeepLink?: (u: string) => void }).__zhujianOpenDeepLink = (u) =>
  void openDeepLink(u);

// 剪贴板补路(桌面):OS scheme 桥(4b)要求用户「点」一个 zhujian:// 链接,但很多软件不把它
// 渲染成可点、点了又弹「用什么打开」。补一条更稳的:复制链接 → 切回朱简 → 回窗时读一次剪贴板,
// 若是自家合规深链接,就在角上弹一条非承诺式提示条「点此打开」——用户点了才跳,绝不自动劫持
// 当前视图。只认 zhujian://open&item=(parseDeepLink),别的剪贴板内容一律静默丢弃(隐私底线:
// 只碰自家 scheme、读到不匹配立即忘)。同一串只提示一次,免得每次回窗反复弹。安卓不接(系统每
// 次读剪贴板弹「已粘贴」toast,自动读又吵又像偷窥)。
let lastClipDeepLink: string | null = null;

/** 给定一段文本(剪贴板内容):是自家合规深链接且与上次不同就弹提示条,否则 no-op。
 *  抽出来供 e2e 直驱(驱动窗读 OS 剪贴板会挂起,同 deeplink.e2e 的既有取舍)。 */
function offerDeepLinkFromClipboard(text: string): void {
  const link = text.trim();
  if (link === lastClipDeepLink) return; // 这串已提示过,别反复弹
  if (!parseDeepLink(link)) return; // 非自家合规链接:静默忽略
  lastClipDeepLink = link;
  showDeepLinkPill(link);
}

async function checkClipboardForDeepLink(): Promise<void> {
  let text: string;
  try {
    text = await readClipboardText();
  } catch {
    return; // 剪贴板空/非文本/读不到:静默,不是错误路径
  }
  if (text) offerDeepLinkFromClipboard(text);
}
(window as unknown as { __zhujianOfferClipboardDeepLink?: (t: string) => void }).__zhujianOfferClipboardDeepLink =
  (t) => offerDeepLinkFromClipboard(t);

let deepLinkPillTimer: number | undefined;

function hideDeepLinkPill(): void {
  document.getElementById("deeplink-pill")?.classList.remove("show");
  window.clearTimeout(deepLinkPillTimer);
}

function showDeepLinkPill(url: string): void {
  let pill = document.getElementById("deeplink-pill");
  if (!pill) {
    pill = document.createElement("div");
    pill.id = "deeplink-pill";
    document.body.appendChild(pill);
  }
  pill.textContent = "";
  const label = document.createElement("span");
  label.className = "deeplink-pill-label";
  label.textContent = t("notebook.clipboardLink");
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "deeplink-pill-open";
  openBtn.textContent = t("notebook.open");
  openBtn.addEventListener("click", () => {
    hideDeepLinkPill();
    void openDeepLink(url);
  });
  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "deeplink-pill-dismiss";
  dismiss.textContent = "×";
  dismiss.setAttribute("aria-label", t("notebook.close"));
  dismiss.addEventListener("click", () => hideDeepLinkPill());
  pill.append(label, openBtn, dismiss);
  pill.classList.add("show");
  window.clearTimeout(deepLinkPillTimer);
  deepLinkPillTimer = window.setTimeout(() => hideDeepLinkPill(), 8000);
}

let spaceMenu: HTMLDivElement | null = null;
// 菜单是谁点开的(411/D2 起有两个:侧栏徽章、以及徽章藏起时同步面里那行「空间…」)。
// 位置与「点自己不算点外面」都跟着它走,别再写死 spaceEntry。
let spaceMenuAnchor: HTMLElement = spaceEntry;
let spaceMenuResize: ResizeObserver | null = null;

/** 菜单贴锚点下沿,并**硬钳在视口内**:兜底入口(同步入口)贴在侧栏底部,不钳就整个
 *  掉出下沿 = 真实的「点不到」(㊱ 悬停菜单栽过同一课)。长高时由 ResizeObserver 复钳。 */
function clampSpaceMenu(): void {
  if (!spaceMenu) return;
  const r = spaceMenuAnchor.getBoundingClientRect();
  const h = spaceMenu.getBoundingClientRect().height;
  const top = Math.min(r.bottom + 4, window.innerHeight - h - 8);
  spaceMenu.style.left = `${Math.round(r.left)}px`;
  spaceMenu.style.top = `${Math.round(Math.max(8, top))}px`;
}

function closeSpaceMenu(): void {
  spaceMenuResize?.disconnect();
  spaceMenuResize = null;
  spaceMenu?.remove();
  spaceMenu = null;
  document.removeEventListener("mousedown", onSpaceMenuDoc, true);
  document.removeEventListener("keydown", onSpaceMenuKey, true);
}

function onSpaceMenuDoc(e: MouseEvent): void {
  const t = e.target as Node;
  if (spaceMenu && !spaceMenu.contains(t) && !spaceMenuAnchor.contains(t)) closeSpaceMenu();
}

function onSpaceMenuKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSpaceMenu();
  }
}

/** 菜单动作行:点击后原地换成「输入名字 + 回车提交」的小表单(新建/改名共用)。
 *  提交中置忙防连按(后端另有生命周期互斥兜底,这里只是不给用户造出第二次点击)。 */
function spaceActionRow(label: string, placeholder: string, submit: (name: string) => Promise<void>): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = label;
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const inp = document.createElement("input");
    inp.placeholder = placeholder;
    inp.spellcheck = false;
    const err = document.createElement("div");
    err.className = "space-err";
    form.appendChild(inp);
    form.appendChild(err);
    let busy = false;
    inp.addEventListener("keydown", (ke) => {
      ke.stopPropagation(); // 视图级单键(N/R/M…)别被输入截走
      if (ke.isComposing) return; // IME 组合期的 Enter/Esc 属于输入法(ui-audit P0 #1)
      if (ke.key === "Escape") closeSpaceMenu();
      if (ke.key !== "Enter" || busy) return;
      busy = true;
      inp.disabled = true;
      err.textContent = "";
      submit(inp.value).catch((e: unknown) => {
        busy = false;
        inp.disabled = false;
        err.textContent = String(e);
      });
    });
    row.replaceWith(form);
    inp.focus();
  });
  return row;
}

// ---- 加入空间(space-entry-plan §2/§3):独立入口直达 -------------------------

/** 当前 attempt 的 id(null=没有加入在跑);进度事件只接受当前 attempt(迟到拒)。 */
let joinAttempt: string | null = null;
let joinNoteEl: HTMLElement | null = null;

const JOIN_PHASE_LABEL: Record<string, string> = {
  preparing: t("notebook.joinPreparing"),
  pairing: t("notebook.joinPairing"),
  booting: t("notebook.joinBooting"),
  publishing: t("notebook.joinPublishing"),
  integrating: t("notebook.joinIntegrating"),
};

void listen<{ attempt_id: string; phase: string; received: number; total: number }>(
  "join-progress",
  (e) => {
    const p = e.payload;
    if (p.attempt_id !== joinAttempt || !joinNoteEl) return;
    joinNoteEl.textContent =
      p.phase === "booting" && p.total > 0
        ? t("notebook.joinBootingProgress", {
            received: (p.received / 1048576).toFixed(1),
            total: (p.total / 1048576).toFixed(1),
          })
        : (JOIN_PHASE_LABEL[p.phase] ?? p.phase);
  },
);

/** 当前是否有未保存的输入(草稿探针,codex 一轮 H1 + 二轮 H1):三个半边——
 *  ① DOM 里的 compose/编辑 textarea(过滤框是 input[type=search],不算);
 *  ② 灵感模块态(compose 文字存底 + 暂存图:compose 未渲染/切过子页时文字在
 *  `composeDraftSaved`、纯挂图无文字在 PendingImages,DOM 探不到);
 *  ③ 看板模块态(同款)。保守起见任一非空即算——宁可让用户自己点切换,不冒
 *  重挂清底丢内容的险。 */
function viewHasDirtyText(): boolean {
  const domDirty = Array.from(
    document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>(
      "#view textarea, #view input",
    ),
  ).some((el) => {
    if (el instanceof HTMLInputElement) {
      // 过滤/查询框不算草稿:标签/看板/灵感的过滤是 type=search;搜索视图的查询框
      // 是 #q(type=text,但只是查询词)。其余编辑型 input(新建标签名/合并标题/
      // 内联重命名/新建归入/截止日期)都算(codex 三轮 H1)。
      if (el.type === "search" || el.type === "checkbox" || el.type === "radio") return false;
      if (el.id === "q") return false;
    }
    return el.value.trim().length > 0;
  });
  return domDirty || inboxHasStashedDraft() || boardHasStashedDraft();
}

async function doJoinSpace(
  serverUrl: string,
  code: string,
  go: HTMLButtonElement,
  cancel: HTMLButtonElement,
  note: HTMLElement,
): Promise<void> {
  if (!serverUrl || !code || joinAttempt) return;
  const attempt = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  joinAttempt = attempt;
  joinNoteEl = note;
  note.textContent = t("notebook.joinPreparing");
  go.disabled = true;
  try {
    const out = await joinSpace(serverUrl, code, attempt);
    if (out.kind === "integrated") {
      const warn = out.warnings.length ? t("notebook.joinWarnSuffix", { warnings: out.warnings.join(";") }) : "";
      closeSpaceMenu();
      refreshSpaceEntry();
      // Integrated 不含强切(§3.2 / codex 一轮 H1):当前视图有未保存的输入
      // (compose/编辑卡都是 textarea;过滤框是 input[type=search] 不算)时**保持
      // 原前台**——桌面视图重挂会丢别的空间的草稿,只指路不代切。
      if (viewHasDirtyText()) {
        showToast(t("notebook.joinedStay", { name: spaceLabel(out.space), warn }));
      } else {
        showToast(t("notebook.joined", { name: spaceLabel(out.space), warn }));
        switchSpace(out.space.id);
      }
    } else {
      // 空间已真实存在(账户已注册):如实提示重启后出现,**绝不当失败重试**。
      showToast(out.error);
      note.textContent = out.error;
      cancel.textContent = t("notebook.close");
    }
  } catch (e: unknown) {
    note.textContent = String(e);
    go.disabled = false;
  } finally {
    joinAttempt = null;
    if (joinNoteEl === note) joinNoteEl = null;
  }
}

/** 「加入空间」行:点开换成「服务器 + 配对码 + 加入/取消」的小表单,进度就地显。
 *  取消在途加入 = join_space_cancel(只在提交前生效;提交与取消同时就绪成功优先)。 */
function spaceJoinRow(): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = t("notebook.joinSpace");
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const server = document.createElement("input");
    server.placeholder = t("notebook.joinServerPh");
    server.value = DEFAULT_SYNC_URL;
    server.spellcheck = false;
    const code = document.createElement("input");
    code.placeholder = t("notebook.joinCodePh");
    code.spellcheck = false;
    const go = document.createElement("button");
    go.textContent = t("notebook.join");
    const cancel = document.createElement("button");
    cancel.textContent = t("notebook.cancel");
    const note = document.createElement("div");
    note.className = "space-err";
    for (const inp of [server, code]) {
      inp.addEventListener("keydown", (ke) => {
        ke.stopPropagation();
        if (ke.isComposing) return;
        if (ke.key === "Escape" && joinAttempt === null) closeSpaceMenu();
        if (ke.key === "Enter") go.click();
      });
    }
    go.addEventListener("click", () => {
      void doJoinSpace(server.value.trim(), code.value.trim(), go, cancel, note);
    });
    cancel.addEventListener("click", () => {
      if (joinAttempt) void joinSpaceCancel().catch(() => {});
      else closeSpaceMenu();
    });
    form.appendChild(server);
    form.appendChild(code);
    form.appendChild(go);
    form.appendChild(cancel);
    form.appendChild(note);
    row.replaceWith(form);
    server.focus();
  });
  return row;
}

/** 重置当前空间(epoch-plan §7):两拍确认——点开换成红字警告 + 确认/取消,
 *  绝不一键删数据。非 main 重置后本机此空间消失,切回主空间;main 重置后原地已是
 *  fresh 未配置空库,留在 main 重载视图。已开同步的空间之后走「加入空间」重新加入;
 *  **仅本机空间 = 删除唯一副本**,警示话术分流(space-entry-plan §5)。 */
function spaceResetRow(configured: boolean): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = t("notebook.resetSpace");
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const warn = document.createElement("div");
    warn.className = "space-err";
    warn.textContent = configured
      ? t("notebook.resetWarnSynced")
      : t("notebook.resetWarnLocalOnly");
    const ok = document.createElement("button");
    ok.textContent = t("notebook.resetConfirm");
    const cancel = document.createElement("button");
    cancel.textContent = t("notebook.cancel");
    const err = document.createElement("div");
    err.className = "space-err";
    let busy = false;
    ok.addEventListener("click", () => {
      if (busy) return;
      busy = true;
      err.textContent = "";
      const id = currentSpaceId();
      resetSpace(id)
        .then(() => {
          closeSpaceMenu();
          if (id !== "main") {
            switchSpace("main");
          } else {
            refreshSpaceEntry();
            syncSpaceSwitched();
            navigate(currentName);
          }
        })
        .catch((e: unknown) => {
          busy = false;
          err.textContent = String(e);
        });
    });
    cancel.addEventListener("click", () => closeSpaceMenu());
    form.appendChild(warn);
    form.appendChild(ok);
    form.appendChild(cancel);
    form.appendChild(err);
    row.replaceWith(form);
  });
  return row;
}

/** 打开空间菜单。`anchor` = 菜单挂在谁下面(默认侧栏徽章;411/D2 的兜底入口传同步入口)。 */
async function openSpaceMenu(anchor: HTMLElement = spaceEntry): Promise<void> {
  if (spaceMenu) {
    closeSpaceMenu();
    return;
  }
  spaceMenuAnchor = anchor;
  const all = await listSpaces();
  setSpaceNames(new Map(all.map((s) => [s.id, spaceLabel(s)])));
  const menu = document.createElement("div");
  menu.className = "space-menu";
  for (const s of all) {
    const row = document.createElement("button");
    row.className = "space-row" + (s.id === currentSpaceId() ? " cur" : "");
    const dot = document.createElement("span");
    dot.className = `sync-dot ${dotClass(s.status)}`;
    const name = document.createElement("span");
    name.className = "space-row-name";
    name.textContent = spaceLabel(s);
    row.appendChild(dot);
    row.appendChild(name);
    if (!s.alive) {
      // 未装载的空间(同一物理库的第二个名字):列出说明,不可切入。
      row.disabled = true;
      row.title = s.status.error ?? t("notebook.spaceNotLoaded");
    } else {
      if (s.id === currentSpaceId()) {
        const mark = document.createElement("span");
        mark.className = "space-cur-mark";
        mark.textContent = "✓";
        row.appendChild(mark);
      }
      row.addEventListener("click", () => {
        closeSpaceMenu();
        switchSpace(s.id); // 点当前空间 = 只关菜单(switchSpace 对同 id 是 no-op)
      });
    }
    menu.appendChild(row);
  }
  // 新建空间(不设上限,109 决定①;入口常驻;即建即用的纯本地本子)+ 加入空间
  // (space-entry-plan §2 独立入口)+ 改当前空间名。
  menu.appendChild(
    spaceActionRow(t("notebook.newSpace"), t("notebook.newSpacePh"), async (name) => {
      const info: SpaceInfo = await createSpace(name);
      closeSpaceMenu();
      switchSpace(info.id);
      showToast(t("notebook.spaceCreated"));
    }),
  );
  menu.appendChild(spaceJoinRow());
  menu.appendChild(
    spaceActionRow(t("notebook.renameSpace"), t("notebook.renameSpacePh"), async (name) => {
      await renameSpace(currentSpaceId(), name);
      closeSpaceMenu();
      refreshSpaceEntry();
    }),
  );
  menu.appendChild(
    spaceResetRow(all.find((s) => s.id === currentSpaceId())?.status.configured ?? false),
  );
  // 先挂上再定位:量到真高度才钳得住(见 clampSpaceMenu)。菜单还会**就地长高**
  // (「新建/加入/改名」那几行点开换成表单),故钳位挂在 ResizeObserver 上、不是只做一次。
  document.body.appendChild(menu);
  spaceMenu = menu;
  clampSpaceMenu();
  spaceMenuResize = new ResizeObserver(() => clampSpaceMenu());
  spaceMenuResize.observe(menu);
  document.addEventListener("mousedown", onSpaceMenuDoc, true);
  document.addEventListener("keydown", onSpaceMenuKey, true);
}

spaceEntry.addEventListener("click", () => void openSpaceMenu());

// ---- 启动序 ---------------------------------------------------------------
// 先恢复上次空间(此后 invoke 包装层注入的才是对的 spaceId),再挂同步 UI 与首个
// 视图;capture 浮窗不走这条初始化——它是壳侧 ForegroundSpace 的影子(工序 8,§9)。
void (async () => {
  await initCurrentSpace();

  // 同步 UI(侧栏状态点/设置面板/提示条):远端 op 落地后借用视图的 onFocus 刷新
  // ——和「窗口回前台刷一遍」同一条幂等路径,不另造刷新机制。
  // await:四个事件监听注册完才拉状态基线(顺序反了会漏两者之间的事件)。
  // openSpaces = 411/D2 的兜底:单空间时侧栏徽章藏起,同步面里那行「空间…」代它开菜单
  // ——菜单挂在同步入口下面(那枚钮恒显),不挂已经 hidden 的徽章(hidden 元素量出来
  // 是零矩形,菜单会飞到左上角 0,0)。
  await initSync({
    refresh: () => current?.onFocus?.(),
    openSpaces: () => void openSpaceMenu(syncEntry),
  });
  refreshSpaceEntry();
  // 设置面板(232):全局热键 + 界面字号,与空间/同步无关,挂个入口即可。
  initSettings();

  // 界面字号缩放:恢复上次字号并挂 Ctrl+/-/0 与 Ctrl+滚轮。纯设备本地、不进同步。
  initZoom();

  // 明暗三档(250):首帧的定色已由 notebook.html 头里的内联脚本做掉,这里接上「自动」
  // 档跟随系统变化 + 跨窗改档广播。同样纯设备本地、不进同步。
  initTheme();

  // 多语言(358):壳层静态文案按 data-i18n 覆写(zh 下写回同文 = 零可见变化),
  // 并挂「别窗改档 → 本窗 reload」。同样纯设备本地、不进同步。
  initLang();
  applyStaticI18n();

  // 自动更新(88):启动静默查一次。只在生产构建跑(dev/e2e 是 vite dev server,
  // import.meta.env.PROD 为 false),开发/测试期不打网络也不弹 banner。
  if (import.meta.env.PROD) void initUpdate();

  // 自动备份的提示条(笔①-b)。⚠ **不加 PROD 门**:它不打网络,而 e2e 正是靠注入
  // `backup://auto` 事件来验「弹一次 / 同因不再弹 / 异因仍弹」那三格(定时器本身在
  // e2e 下根本不起,见 lib.rs)。启动时它还会主动拉一次状态,把「结论没能记下来」
  // 那枚只活在进程内的通知补显出来(backup-plan §15.5)。
  initAutoBackupBanner();

  // Land on the last-used view. Absent or unknown (first run, a since-renamed
  // view name) is the first-run default, not an error path — land on inbox.
  const lastView = localStorage.getItem(LAST_VIEW_KEY);
  navigate(lastView !== null && lastView in registry ? (lastView as ViewName) : "inbox");
})();
