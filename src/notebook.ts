import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { listen } from "@tauri-apps/api/event";
import { mount as mountInbox, inboxHasStashedDraft, focusInboxItem, focusInboxCompose } from "./inbox";
import { mount as mountBoard, boardHasStashedDraft, focusTask, focusBoardView } from "./board";
import { mount as mountTopics } from "./topics";
import { mount as mountDocs, focusDoc } from "./docs";
import { mount as mountSearch } from "./search";
import { parseDeepLink, consumePendingDeepLink } from "./deeplink";
import { t, initLang, applyStaticI18n } from "./i18n";
import { codeField, initSync, prefillServerUrl, seedSpaceStatuses, serverField, setSpaceNames, showToast, syncSpaceSwitched } from "./sync";
import { forgetGone, goneOf } from "./sync-gone";
import { initSettings, openSettingsPanel, reopenSettingsAfterReload } from "./settings";
import { bootCrashDiag } from "./about";
import { initZoom } from "./zoom";
import { initTheme } from "./theme-mode";
import { initUpdate, checkForUpdateOnFocus } from "./update";
import { armAppContextMenu } from "./context-menu";
import { initAutoBackupBanner } from "./backup";
import { initDueReminder } from "./reminder";
import {
  createSpace,
  currentSpaceId,
  dotClass,
  initCurrentSpace,
  invokeInSpace,
  joinSpace,
  joinSpaceCancel,
  listSpaces,
  MAIN_SPACE,
  renameSpace,
  resetSpace,
  setCurrentSpace,
  spaceLabel,
} from "./space";
import type { SpaceInfo } from "./space";
import { errDetail, errNode, errText } from "./err";
import { toastAction, toastGo, undoLast } from "./toast";
import { clearSearchBack, goSearchBack, searchBackArmed } from "./locate";
import { closeToTray } from "./tray-hint";
import { loadHotkeys } from "./hotkey-state";
import { holdKeyboard, type KeyboardHold } from "./dom";
import { initBoardNav, refreshBoardNav } from "./board-nav";

// The notebook is one window hosting many views. Only one view is mounted into
// the shared content root at a time, so each view can own page-scoped DOM ids
// (e.g. #list) without colliding with its siblings.
export type ViewName = "inbox" | "docs" | "board" | "topics" | "search";

export interface View {
  unmount(): void;
  /** Called when the notebook window regains focus (data may have changed). */
  onFocus?(): void;
  /** 已在这一视图时又点了侧栏同一枚(157 G4 / P8):返回 true = 视图自己处理了(回顶等),不重挂。 */
  reselect?(): boolean;
}

export interface ViewCtx {
  /** Switch the content area to another view. */
  navigate(name: ViewName): void;
  /** 切到 `space`(不同就切,并说一声「已切到…」)再定位那一条 —— 跨空间移动回执上的「去看看」
   *  (W3 159 / Q4)。与深链接同一条落点路(locate_item → 各视图的 focus 通道)。 */
  openItem(space: string, itemId: string): void;
}

export type MountFn = (root: HTMLElement, ctx: ViewCtx) => View;

// ---- view registry -------------------------------------------------------
// inbox (灵感) is the default landing view; all four are reached from the sidebar.
const registry: Record<ViewName, MountFn> = {
  inbox: mountInbox,
  docs: mountDocs,
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

const ctx: ViewCtx = { navigate, openItem: (space, item) => void openItemInSpace(space, item) };

// 记着当前挂的是哪一页 —— 165 / W5 Q8 起**只给页面重载用**(改语言重载、截图台切档):冷启动(托盘退出再开)
// 一律回随记,见启动序末尾。Device-local UI state, deliberately localStorage and NOT the DB — it is not
// user data and must never ride along into a future sync surface.
const LAST_VIEW_KEY = "zhujian.last-view";

// Switching views unmounts+remounts, so per-view state that should survive a switch
// (e.g. the board's 标签 filter, the 灵感 tab, the 搜索 query) lives at module scope in
// each view, NOT here.
function navigate(name: ViewName): void {
  clearSearchBack(); // 人换了页(或跳转换页):落点上那枚「Esc 回搜索」作废(W5 Q11;搜索的跳转在这之后才登记)
  current?.unmount();
  viewRoot.replaceChildren();
  current = registry[name](viewRoot, ctx);
  currentName = name;
  for (const b of navButtons) b.classList.toggle("active", b.dataset.view === name);
  localStorage.setItem(LAST_VIEW_KEY, name);
}

// 0043 多看板:侧栏「看板」下面那一组(各块 / 新建 / 收容区)。点里面任一块 = 切到看板视图(那块已记成「在看的」)。
initBoardNav(document.getElementById("board-nav") as HTMLElement, { navigate: () => navigate("board") });

for (const b of navButtons) {
  b.addEventListener("click", () => {
    const name = b.dataset.view as ViewName;
    if (name === currentName && current?.reselect?.()) return;
    navigate(name);
  });
}

document.getElementById("win-min")?.addEventListener("click", () => void win.minimize());
// ✕ = 藏进托盘;第一次先说一句(W4 A5,见 tray-hint.ts)。
document.getElementById("win-close")?.addEventListener("click", () => closeToTray(() => void win.hide()));
// 三枚窗口钮按下不拿焦点:系统原生标题栏不抢网页里的键盘焦点,自绘的照样不该抢 —— 原先点完最大化 / 还原,
// 焦点停在钮上,接着打的字全部落空(153 走查 D-NEW-1)。只拦按下那一下的默认动作,click 照常发;Tab 仍走得到它们。
for (const id of ["win-min", "win-max", "win-close"]) {
  document.getElementById(id)?.addEventListener("mousedown", (e) => e.preventDefault());
}

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

// 输入法候选框开着时按标题栏,那一按只用来收掉候选框,⛔ 不起窗口拖动(用户面 146):
// 最大化的窗口这时会被还原成小窗。用户 10-10 在真微软拼音上录到的序列 —— 那一按是**单击**
// (detail=1,不是被算成双击),compositionend 比 mousedown 早 1–3ms(Chromium 按下即收组字),
// 拖拽区脚本照常发 start_dragging,进了系统的移动循环就还原;英文状态同一按不还原。
// ⇒ 窗口级捕获阶段先看:紧跟在组字结束后的那一按落在拖拽区上,就不让 Tauri 那只文档级监听
// 收到它(不 preventDefault:输入框照常失焦)。再按一次照常能拖、双击照常最大化。
let compositionEndAt = -Infinity;
document.addEventListener("compositionend", () => (compositionEndAt = performance.now()), true);
window.addEventListener(
  "mousedown",
  (e) => {
    if (performance.now() - compositionEndAt > 50) return;
    // 与拖拽区脚本同口径:我们的拖拽区全是光标记,只认直接按在带标记的那个元素上(按在顶栏里的钮上不归这儿)。
    if (!(e.target as HTMLElement).hasAttribute?.("data-tauri-drag-region")) return;
    e.stopImmediatePropagation();
  },
  true,
);
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

// Ctrl+F(mac 上 Cmd+F)= 打开搜索、光标进搜索框(W3 159 / Q9,WD-19:此前 Ctrl+F / Ctrl+K 都没反应)。
// ⚠ 一律 preventDefault:WebView2 的 Ctrl+F 原本会唤起它自己的页内查找条,那不是朱简的搜索。
// ⛔ 正在改东西的框里不跳:视图 unmount 只拆监听不 commit(各视图 teardownActiveEdit 那条),跳走 = 正在改的
// 字丢了。放行的只有三种不会丢字的框:记一笔(`.compose-input`,草稿跨挂载存着)、过滤框(type=search)、
// 搜索框自己。键照样吞掉,免得冒出查找条。
function ctrlFMayLeave(a: Element | null): boolean {
  if (!(a instanceof HTMLElement)) return true;
  if (a.isContentEditable) return false;
  if (a instanceof HTMLTextAreaElement) return a.classList.contains("compose-input");
  if (a instanceof HTMLInputElement) return a.type === "search" || a.id === "q";
  return true;
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey || (e.key !== "f" && e.key !== "F")) return;
  e.preventDefault();
  if (!ctrlFMayLeave(document.activeElement)) return;
  if (currentName === "search") {
    const q = document.querySelector<HTMLInputElement>(".v-search #q");
    q?.focus();
    q?.select();
    return;
  }
  navigate("search"); // 搜索视图挂载即聚焦搜索框(search.ts)
});

// ---- 全局三键(W5)----------------------------------------------------------
/** 焦点在能打字的框里(那里的 Ctrl+Z / Esc 归框自己)。 */
function inField(a: Element | null): boolean {
  return a instanceof HTMLElement && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT" || a.isContentEditable);
}
document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
  // Ctrl+,(mac Cmd+,)开设置(Q15,WD-28:此前没反应,从第 10 张卡 Shift+Tab 到「设置」要 34 下)。已开着 = 不动。
  if (e.key === ",") {
    e.preventDefault();
    void openSettingsPanel();
    return;
  }
  // Ctrl+Z = 点在场那条回执上的【撤销】(A1,WD-01)。⛔ 焦点在框里不接:那是撤销打字(清单输入那条 e2e 守着)。
  // 浮层里按的不会到这儿(holdKeyboard 截住了),这里只再挡一道 aria-modal(关窗那一问之类)。
  if (e.key === "z" || e.key === "Z") {
    if (inField(document.activeElement) || document.querySelector('[aria-modal="true"]')) return;
    if (undoLast()) e.preventDefault();
  }
});
// 落点上按 Esc 回搜索(Q11 ★①,WD-24)。挂在 **window 冒泡相**:document 上各层(⋯ 菜单 / 选择器 / 编辑框 / 确认 /
// 摊开的历史…)的 Esc 都先跑,接了就 preventDefault 或截住 —— 这里只收「没人要的那一记 Esc」。
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || !searchBackArmed()) return;
  if (inField(document.activeElement)) return;
  if (document.querySelector('[aria-modal="true"], .hk-menu, .space-menu')) return;
  e.preventDefault();
  goSearchBack();
});

// 「把朱简打开」之后光标进「随手记一笔」框(W4 WD-37 / Q11):手动启动、再点一次图标、托盘、主窗热键
// 都走壳里的 `summon_notebook`,它置一枚 take 旗再 emit 一次 —— 冷启动时这页多半还没起来、事件会丢,
// 所以启动序末尾也取一次(同「点此改键」那对 `take_open_settings` / `open-settings`)。
// 只在这几种情况下放:当前在随记页、身前没有浮层(设置 / 同步 / 管理列 / 历史…都是 aria-modal)、
// 焦点不在任何输入框里(正改着的东西不抢)。⛔ 别改成「每次回窗都放」:悬停卡片按单键靠的是焦点
// 不在框里,alt-tab 回来光标被塞进记一笔框,下一下 E / D 就打成了字。
async function summonFocus(): Promise<void> {
  if (!(await rawInvoke<boolean>("take_summon_focus"))) return;
  if (currentName !== "inbox") return;
  if (document.querySelector('[aria-modal="true"]')) return;
  const a = document.activeElement;
  if (a instanceof HTMLElement && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.isContentEditable)) return;
  focusInboxCompose();
}
void listen("notebook-summoned", () => void summonFocus());

win.onFocusChanged(({ payload: focused }) => {
  if (focused) {
    // 165 / W5 A23(WD-23):新用户空库第一次打开,光标不进框 —— 实测(走查构建、全新数据目录)启动序那一发 take 在
    // 壳置旗**之前**(页面 249 ms 取到 false),壳随后置旗、发的那条 notebook-summoned 页面没收到,旗一直挂着(21 s 后
    // 手动取仍是 true);窗口被 raise 拿到焦点的那一下(≈515 ms)倒是来了。⇒ 拿到焦点时也取一次:旗只在「有一次召唤还没
    // 兑现」时为真(兑现了 / 让位了都取走),所以普通回窗(alt-tab)取到的是 false、什么也不做 —— 不破上面那条「别每次
    // 回窗都放」。
    void summonFocus();
    current?.onFocus?.();
    void refreshBoardNav();
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
    // ⛔ 入口不许就此消失:新建 / 加入空间的入口就在这枚徽章的菜单里,故同步面底部那行
    // 「空间…」与设置「通用」里那行「空间…」恒在(W4 Q6 ★① 起不再随空间数藏起,sync.ts::renderHome)。
    spaceEntry.hidden = all.length <= 1;
    const curInfo = all.find((s) => s.id === currentSpaceId());
    if (curInfo) {
      spaceNameEl.textContent = spaceLabel(curInfo);
      // W4 A16(WD-09):侧栏这一格窄(约 80px),「未命名空间 · NEG6」被截成「未命名空间 ·…」——
      // 名字最多折两行(notebook.html 那条),再长的悬停看全名。
      spaceEntry.title = t("shell.switchSpaceNamed", { name: spaceLabel(curInfo) });
    }
    // 视图里写着空间名的地方各自重取(160:随记「记一笔」的灰字)。
    document.dispatchEvent(new CustomEvent("zhujian:space-names"));
  });
}

// 空间名变了(本地改名 / 远端改名落地 / 引导落名;space-name-sync-plan §4.7):
// 名字表全量重查——刻意**不分当前/非当前空间**(借道 sync-changed 会被「非当前
// 空间直接丢弃」的既有语义漏掉,codex 一轮 H5)。
void listen("space-name-changed", () => refreshSpaceEntry());
// 捕获浮窗记下了一条(157 G3):当前视图就地重查(同回窗那条路),并说一句 —— 浮窗那边记完即收,交代归这里。
void listen<{ kind: "task" | "idea" }>("captured", (e) => {
  current?.onFocus?.();
  toastAction(e.payload.kind === "task" ? t("notebook.capturedTask") : t("notebook.capturedIdea"));
});

function switchSpace(id: string): void {
  if (id === currentSpaceId()) return;
  setCurrentSpace(id);
  refreshSpaceEntry();
  syncSpaceSwitched();
  navigate(currentName);
  void refreshBoardNav(); // 0043:看板名单是空间的
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
// ⚠ 看板三支是**先 navigate、后 focusTask**(W3 159 真实例复走逮到的):navigate 先 unmount 旧视图,而看板的
// unmount 会把模块级 focusId 清掉(「离开看板时取消没落地的定位」,codex 四审 H)—— 人本来就在看板上时
// (跨空间移动回执的「去看看」、在看板上点深链接)先登记的 focus 当场被清,落过去不高亮。新看板的 load()
// 在 await 之后才取走 focusId,同步登记赶得上。子视图(归档 / 回收站)那一格在**挂载时**读,仍须先于 navigate。
function routeToItem(item: string, loc: string): void {
  switch (loc) {
    case "task":
      navigate("board");
      focusTask(item);
      break;
    case "sealed":
      focusBoardView("sealed");
      navigate("board");
      focusTask(item);
      break;
    case "trash-task":
      focusBoardView("trash");
      navigate("board");
      focusTask(item);
      break;
    case "inbox":
      focusInboxItem(item, "ideas");
      navigate("inbox");
      break;
    case "trash-idea":
      focusInboxItem(item, "archived");
      navigate("inbox");
      break;
    case "doc":
      focusDoc(item);
      navigate("docs");
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
  await landOnItem(target, p.item, null);
}

/** 切到 `target`(若不同)再按 locate_item 落到那一条。不走 switchSpace 的「先 navigate 当前视图」——
 *  那会白挂一次,我们要带着 focus 一次落到条目所在视图。`label` 给了 = 切了空间就说一声(Q6)。 */
async function landOnItem(target: string, item: string, label: string | null): Promise<void> {
  if (target !== currentSpaceId()) {
    setCurrentSpace(target);
    refreshSpaceEntry();
    syncSpaceSwitched();
    if (label !== null) toastAction(t("notebook.switchedTo", { name: label }));
  }
  let loc: string | null;
  try {
    loc = await invokeInSpace<string | null>(target, "locate_item", { itemId: item });
  } catch (e) {
    showToast(t("notebook.openFailed", { error: errDetail(e) }));
    return;
  }
  if (!loc) {
    showToast(t("notebook.itemNotFound"));
    return;
  }
  routeToItem(item, loc);
}

/** 跨空间移动回执上的「去看看」(ViewCtx.openItem):目标空间此刻不在 / 已停 = 明说,不猜。 */
async function openItemInSpace(space: string, item: string): Promise<void> {
  const info = (await listSpaces()).find((s) => s.alive && s.id === space);
  if (!info) {
    showToast(t("notebook.spaceNotOnDevice"));
    return;
  }
  await landOnItem(space, item, spaceLabel(info));
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
    // 直接落在「快捷键」那一类:提示条说的就是「点此改键」,落在默认的「通用」上等于没接上。
    if (await rawInvoke<boolean>("take_open_settings")) await openSettingsPanel("hotkeys");
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
// 菜单接管键盘(W5 A6 / Q2,照 §3.5 设置浮层那套):打开焦点进菜单、↑ ↓ 走项、Tab 圈在里面、菜单里按的键不冒到
// 身后(此前 ↓ 在背后悄悄选中时间轴的卡,之后按单键就作用到那张)、Esc 关了焦点回打开它的那枚(此前掉到页面上)。
let spaceHold: KeyboardHold | null = null;

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

/** `restoreFocus`:Esc / 再点一次入口收起时焦点还给打开它的那枚;点外面收起不还(那一点已把焦点给了别处)。 */
function closeSpaceMenu(restoreFocus = false): void {
  spaceMenuResize?.disconnect();
  spaceMenuResize = null;
  spaceMenu?.remove();
  spaceMenu = null;
  document.removeEventListener("mousedown", onSpaceMenuDoc, true);
  document.removeEventListener("keydown", onSpaceMenuKey, true);
  const h = spaceHold;
  spaceHold = null;
  h?.release(restoreFocus);
}

function onSpaceMenuDoc(e: MouseEvent): void {
  const t = e.target as Node;
  if (spaceMenu && !spaceMenu.contains(t) && !spaceMenuAnchor.contains(t)) closeSpaceMenu();
}

function onSpaceMenuKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeSpaceMenu(true);
  }
}

/** 菜单里 ↑ ↓ Home End 在各行之间走(灰掉的「未装载」那行跳过;已换成小表单的那行不算一行)。 */
function onSpaceMenuNav(e: KeyboardEvent): void {
  if (!spaceMenu || e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.target instanceof HTMLInputElement) return; // 小表单里的框:方向键归光标
  const rows = [...spaceMenu.querySelectorAll<HTMLButtonElement>(".space-row")].filter((b) => !b.disabled);
  if (rows.length === 0) return;
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  let i: number;
  if (e.key === "ArrowDown") i = at < 0 ? 0 : (at + 1) % rows.length;
  else if (e.key === "ArrowUp") i = at < 0 ? rows.length - 1 : (at - 1 + rows.length) % rows.length;
  else if (e.key === "Home") i = 0;
  else if (e.key === "End") i = rows.length - 1;
  else return;
  e.preventDefault();
  rows[i].focus();
}

/** 新建 / 改名空间失败的那句红字(W3 159 / A11,WD-08)。撞名是**认得出的错**,core 那句「已有同名空间「X」」
 *  本身就是人话 ⇒ 原样给、不挂「出错:」(§4.3:「出错:」只给认不出的);其余照 errText。⛔ 只认 core 那一种
 *  句形(spaces.rs::ensure_space_name_free),别放宽成「含『同名』」。同标签页那条(topics.ts::nameErrText)。 */
function spaceNameErrText(e: unknown): string {
  const s = String(e);
  return /^已有同名空间「.+」$/.test(s) ? s : errText(e);
}

/** 菜单动作行:点击后原地换成「输入名字 + 回车提交」的小表单(新建/改名共用)。
 *  提交中置忙防连按(后端另有生命周期互斥兜底,这里只是不给用户造出第二次点击)。
 *  `initial` 给了 = 框里预填它并全选(改名:W3 159 / Q12,WD-39,同标签改名);原样回车 = 不改、只收菜单。
 *  失败时字留在框里、红字在框下、焦点还回框里(A11)。 */
function spaceActionRow(
  label: string,
  placeholder: string,
  submit: (name: string) => Promise<void>,
  initial = "",
): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = label;
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const inp = document.createElement("input");
    inp.placeholder = placeholder;
    inp.spellcheck = false;
    inp.value = initial;
    const err = document.createElement("div");
    err.className = "space-err";
    form.appendChild(inp);
    form.appendChild(err);
    let busy = false;
    inp.addEventListener("keydown", (ke) => {
      ke.stopPropagation(); // 视图级单键(N/R/M…)别被输入截走
      if (ke.isComposing) return; // IME 组合期的 Enter/Esc 属于输入法(ui-audit P0 #1)
      if (ke.key === "Escape") closeSpaceMenu(true);
      if (ke.key !== "Enter" || busy) return;
      if (initial !== "" && inp.value.trim() === initial.trim()) {
        closeSpaceMenu(); // 没改:不发命令(免得把显示名「默认空间」当真名写进去)
        return;
      }
      busy = true;
      inp.disabled = true;
      err.textContent = "";
      submit(inp.value).catch((e: unknown) => {
        busy = false;
        inp.disabled = false;
        err.textContent = spaceNameErrText(e);
        inp.focus();
      });
    });
    row.replaceWith(form);
    inp.focus();
    inp.select();
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
        switchSpace(out.space.id);
        // 161 / W4 Q13 ★①(A44 / WP-07 / X-01,同手机):回执里写明这一本**在这台叫什么** —— 对方那本没起过名时这里先叫
        // 「未命名空间 · XXXX」,和这台已有的一本同名时点出来(「空间不能重名」只拦新建与改名,加入进来的会撞);旁边一枚
        // 「改名」直达(空间菜单里那一行)。⛔ 名字怎么来的不动(space-entry-plan §3.6:没起过名那本不落名字记录);只改说法。
        const label = spaceLabel(out.space);
        const all = await listSpaces();
        const twin = all.some((x) => x.id !== out.space.id && spaceLabel(x).toLowerCase() === label.toLowerCase());
        if (!out.space.name || twin) {
          toastGo(
            !out.space.name ? t("sync.joinedUnnamed", { name: label, warn }) : t("sync.joinedTwin", { name: label, warn }),
            t("notebook.renameGo"),
            () => void openSpaceMenu(spaceEntry.hidden ? syncEntry : spaceEntry, "rename"),
          );
        } else {
          showToast(t("notebook.joined", { name: label, warn }));
        }
      }
    } else {
      // 空间已真实存在(账户已注册):如实提示重启后出现,**绝不当失败重试**。
      showToast(out.error);
      note.textContent = out.error;
      cancel.textContent = t("notebook.close");
    }
  } catch (e: unknown) {
    // A8 / A41 / A42:人话在前、原文降一档、带「!」(errNode);连不上的那几类后面挂「网络自检」测刚填的那台。
    note.replaceChildren(errNode(e, serverUrl));
    go.disabled = false;
  } finally {
    joinAttempt = null;
    if (joinNoteEl === note) joinNoteEl = null;
  }
}

/** 「加入空间」行:点开换成「服务器 + 配对码 + 加入/取消」的小表单,进度就地显。
 *  取消在途加入 = join_space_cancel(只在提交前生效;提交与取消同时就绪成功优先)。
 *  `canMerge` = 同步面板此刻有没有「用配对码加入」那枚钮(主空间且还没开同步;判据同 sync.ts::renderHome)。 */
function spaceJoinRow(canMerge: boolean): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = t("notebook.joinSpace");
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    // 161 / W4 Q2 / Q3 ★①(WD-13 顺带 / N-6):地址框上方标「服务器地址」、框下一行说是不是官方服务器;预填这台最近一次连上的
    // 那台(从没连过才是官方)—— 此前一律预填官方地址,自建的人填错时报的却是「配对码无效或已过期」。
    // A27(WD-30):配对码框有标签,灰字写长什么样(此前要输错一次才知道)。
    const serverF = serverField(prefillServerUrl(), "");
    const codeF = codeField("");
    const server = serverF.input;
    const code = codeF.input;
    // W4 A22(WD-16):「加入」「取消」此前是浏览器默认的整行灰底黑边方块钮,与全应用两个样子 ⇒
    // 走同步面板那一族的 `.hbtn`,并排靠右(`.space-form-acts`)。
    const go = document.createElement("button");
    go.className = "hbtn";
    go.textContent = t("notebook.join");
    const cancel = document.createElement("button");
    cancel.className = "hbtn";
    cancel.textContent = t("notebook.cancel");
    const acts = document.createElement("div");
    acts.className = "space-form-acts";
    acts.append(go, cancel);
    const note = document.createElement("div");
    note.className = "space-err";
    // 「另开一个空间 vs 并进当前空间」一句说清(用户面 121):这条路加的是**新空间**,当前
    // 空间不动。W4 A22(WD-13):后半句此前一律叫人去同步面板点「用配对码加入」—— 那枚钮只在
    // **主空间、还没开同步**时才有(sync.ts::renderHome 同一条判据),建好账户后照着找是死路。
    // ⇒ 那半句只在它真的在时才说;别的时候照实说这一本已经并不进去了。
    const hint = document.createElement("p");
    hint.className = "space-hint";
    hint.textContent = canMerge ? t("notebook.joinHint") : t("notebook.joinHintNoMerge");
    for (const inp of [server, code]) {
      inp.addEventListener("keydown", (ke) => {
        ke.stopPropagation();
        if (ke.isComposing) return;
        if (ke.key === "Escape" && joinAttempt === null) closeSpaceMenu(true);
        if (ke.key === "Enter") go.click();
      });
    }
    go.addEventListener("click", () => {
      void doJoinSpace(server.value.trim(), code.value.trim(), go, cancel, note);
    });
    cancel.addEventListener("click", () => {
      if (joinAttempt) void joinSpaceCancel().catch(() => {});
      else closeSpaceMenu(true);
    });
    form.appendChild(hint);
    form.appendChild(serverF.wrap);
    form.appendChild(codeF.wrap);
    form.appendChild(acts);
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
function spaceResetRow(configured: boolean, gone: boolean): HTMLElement {
  const row = document.createElement("button");
  row.className = "space-row action";
  row.textContent = t("notebook.resetSpace");
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const warn = document.createElement("div");
    warn.className = "space-err";
    warn.textContent = gone
      ? t("notebook.resetWarnGone")
      : configured
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
          forgetGone(id); // Q12:这一本的本机数据删光了,「已不在账户里」那笔账跟着作废
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
          err.textContent = errText(e);
        });
    });
    cancel.addEventListener("click", () => closeSpaceMenu(true));
    form.appendChild(warn);
    form.appendChild(ok);
    form.appendChild(cancel);
    form.appendChild(err);
    row.replaceWith(form);
    // W5 Q3 ★①:确认一出来焦点停【取消】(删的是整本的数据 —— 回车不做这件事,要做 Tab 回到红钮)。
    cancel.focus();
  });
  return row;
}

/** 打开空间菜单。`anchor` = 菜单挂在谁下面(默认侧栏徽章;411/D2 的兜底入口传同步入口)。
 *  `open = "rename"`:打开即展开「重命名当前空间」那一行(加入回执上那枚「改名」,161 / W4 Q13)。 */
async function openSpaceMenu(anchor: HTMLElement = spaceEntry, open: "rename" | null = null): Promise<void> {
  if (spaceMenu) {
    closeSpaceMenu(true);
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
    // 161 / W4 Q13 ★① = A44(WP-07 / X-01):主空间从没起过名时屏上叫「默认空间」,可这个名字不跟着走 —— 别的设备加入后叫
    // 「未命名空间 · XXXX」。标出来,让人知道它到别处不叫这个名。⛔ 不落名字(space-entry-plan §3.6)。
    // 非主空间没起过名的本来就叫「未命名空间 · XXXX」(屏上已经说了),不再标。
    if (s.id === MAIN_SPACE && s.name === null) {
      const mark = document.createElement("span");
      mark.className = "space-row-mark";
      mark.textContent = t("notebook.unnamedMark");
      mark.title = t("notebook.unnamedMarkTitle");
      row.appendChild(mark);
    }
    // Q12 ★①:已不在账户里的那一本(被移出 / 自己退出)标「已不再同步」(同手机空间页那一行)。
    if (goneOf(s.id) !== null) {
      const tag = document.createElement("span");
      tag.className = "space-row-tag";
      tag.textContent = t("main.tagUnsynced");
      row.appendChild(tag);
    }
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
        if (s.id === currentSpaceId()) return; // 点当前空间 = 只关菜单
        switchSpace(s.id);
        // Q6(WD-17):切过去说一声(此前只有侧栏顶那一行字变了,整页再没别处写着在哪个空间)。
        toastAction(t("notebook.switchedTo", { name: spaceLabel(s) }));
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
  const curInfo = all.find((s) => s.id === currentSpaceId());
  menu.appendChild(spaceJoinRow(currentSpaceId() === MAIN_SPACE && curInfo !== undefined && !curInfo.status.configured));
  const renameRow = spaceActionRow(
    t("notebook.renameSpace"),
    t("notebook.renameSpacePh"),
    async (name) => {
      await renameSpace(currentSpaceId(), name);
      closeSpaceMenu();
      refreshSpaceEntry();
      toastAction(t("notebook.spaceRenamed", { name: name.trim() })); // Q6(WD-17):改完说一声
    },
    curInfo ? spaceLabel(curInfo) : "",
  );
  menu.appendChild(renameRow);
  menu.appendChild(
    spaceResetRow(curInfo?.status.configured ?? false, goneOf(currentSpaceId()) !== null),
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
  menu.addEventListener("keydown", onSpaceMenuNav); // ⚠ 先于 holdKeyboard 那只挂(同一元素按注册序跑)
  // 焦点落在当前那一本上(没有就第一行)—— 此前留在入口钮上,菜单 6 项排在整页最末,倒着进去第一站是「重置当前空间…」。
  spaceHold = holdKeyboard(menu, menu, {
    onEscape: () => closeSpaceMenu(true),
    focus: menu.querySelector<HTMLButtonElement>(".space-row.cur") ?? menu.querySelector<HTMLButtonElement>(".space-row:not(:disabled)"),
  });
  if (open === "rename") renameRow.click(); // 换成改名小表单、原名预填全选、光标进框(spaceActionRow)
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
    refresh: () => {
      current?.onFocus?.();
      void refreshBoardNav(); // 0043:别台建 / 删 / 改名 / 排序了看板,侧栏那一组跟着变
    },
    openSpaces: () => void openSpaceMenu(syncEntry),
  });
  refreshSpaceEntry();
  // 设置面板(232):全局热键 + 界面字号 …… 外加两条通往外面的路(W4):「空间…」开空间菜单(Q6,
  // 菜单挂在此刻看得见的那枚入口下:有侧栏徽章挂徽章,单空间时挂同步入口 —— 同 openSpaces 那条),
  // 恢复回执的「去看看」切到那个空间并说一声(A16,同空间菜单里切空间那句)。
  initSettings({
    openSpaces: () => void openSpaceMenu(spaceEntry.hidden ? syncEntry : spaceEntry),
    gotoSpace: (id, label) => {
      switchSpace(id);
      toastAction(t("notebook.switchedTo", { name: label }));
    },
  });

  // 崩溃弹框(C9)的「复制诊断信息」:把设置「关于」那份诊断先递给壳留着。不 await ——
  // 它不挡任何一条用户路径。
  void bootCrashDiag();

  // 界面字号缩放:恢复上次字号并挂 Ctrl+/-/0 与 Ctrl+滚轮。纯设备本地、不进同步。
  initZoom();

  // 明暗三档(250):首帧的定色已由 notebook.html 头里的内联脚本做掉,这里接上「自动」
  // 档跟随系统变化 + 跨窗改档广播。同样纯设备本地、不进同步。
  initTheme();

  // 多语言(358):壳层静态文案按 data-i18n 覆写(zh 下写回同文 = 零可见变化),
  // 并挂「别窗改档 → 本窗 reload」。同样纯设备本地、不进同步。
  initLang();
  applyStaticI18n();

  // 505:卡片以外的右键也归应用管 —— 列空白 / 看板背景 / 侧栏 / 标签视图上不再弹
  // WebView2 那份「返回 · 刷新 · 另存为 · 打印 · 检查」(那个「刷新」点下去是重载整个
  // app)。输入框 / 链接与图片 / 选区照旧让位,判据与卡片那条路共读一份。
  armAppContextMenu();

  // 自动更新(88):启动静默查一次。只在生产构建跑(dev/e2e 是 vite dev server,
  // import.meta.env.PROD 为 false),开发/测试期不打网络也不弹 banner。
  if (import.meta.env.PROD) void initUpdate();

  // 自动备份的提示条(笔①-b)。⚠ **不加 PROD 门**:它不打网络,而 e2e 正是靠注入
  // `backup://auto` 事件来验「弹一次 / 同因不再弹 / 异因仍弹」那三格(定时器本身在
  // e2e 下根本不起,见 lib.rs)。启动时它还会主动拉一次状态,把「结论没能记下来」
  // 那枚只活在进程内的通知补显出来(backup-plan §15.5)。
  initAutoBackupBanner();

  // 截止提醒(39):每天到点一条系统通知「逾期 M · 今天 N」。开关/报点纯设备本地,
  // 只挂在 notebook 这一窗(✕ 只是 hide,webview 常驻;capture 不挂 = 单一发声源)。
  // ⚠ 同 initAutoBackupBanner 不加 PROD 门:e2e 靠注入 zhujian:due-remind-check 事件验
  // 判定与水位,自动那条首查延后 10 秒 + wdio before 钩子预置「今天已处理」⇒ 测试里安静。
  initDueReminder();

  // 两枚全局热键此刻生效没有(W4 A6 / Q8 ①):随记页顶那条「点此改键」与空态那句「或按 …」
  // 挂载时就要读 ⇒ 先于第一次挂视图拉好(一次很快的 IPC;没拉到就挂,页面会以为不知道,不会猜)。
  await loadHotkeys();

  // 165 / W5 Q8 ★①(WX-04):**冷启动一律回随记**、光标进记一笔框(指南「打开朱简……光标在『随手记一笔』框里」)——
  // 此前回到上次停的那页,停在长文 / 标签回来那页没有框、光标也不在任何框里;手机冷启动本来就回随记,两台都用的人
  // 以为「朱简记得我上次在哪」,到手机上每次被送回随记。⛔ 别动「上次在哪个空间」(initCurrentSpace 那一份,另一件事)。
  // 只有**页面重载**(改语言重载、截图台写 last-view 再 reload)才回到重载前那一页 —— 那不是「关掉再开」。
  // 判据 = 这一次文档载入的导航类型(重载 = "reload";进程冷启动 / 首启 = "navigate")。
  // 存的视图名不认识(改过名的旧视图)照旧落随记,不是错误路径。
  const navType = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  const lastView = navType === "reload" ? localStorage.getItem(LAST_VIEW_KEY) : null;
  navigate(lastView !== null && lastView in registry ? (lastView as ViewName) : "inbox");
  void summonFocus();
  // 刚因为改语言重载过:把设置开回「语言」那一行(W4 Q11 / WD-36)。
  reopenSettingsAfterReload();
})();
