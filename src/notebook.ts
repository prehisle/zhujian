import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { mount as mountInbox, inboxHasStashedDraft, focusInboxItem } from "./inbox";
import { mount as mountBoard, boardHasStashedDraft, focusTask, focusBoardView } from "./board";
import { mount as mountTopics } from "./topics";
import { mount as mountSearch } from "./search";
import { parseDeepLink, consumePendingDeepLink } from "./deeplink";
import { initSync, seedSpaceStatuses, setSpaceNames, showToast, syncSpaceSwitched, DEFAULT_SYNC_URL } from "./sync";
import { initUpdate } from "./update";
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
// Segoe Fluent Icons (private-use codepoints, built from char codes to keep the
// source ASCII): 0xE923 = restore (shown when maximized), 0xE922 = maximize.
const GLYPH_RESTORE = String.fromCharCode(0xe923);
const GLYPH_MAXIMIZE = String.fromCharCode(0xe922);
async function syncMaxGlyph(): Promise<void> {
  if (!maxBtn) return;
  const max = await win.isMaximized();
  maxBtn.textContent = max ? GLYPH_RESTORE : GLYPH_MAXIMIZE;
  maxBtn.title = max ? "向下还原" : "最大化";
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
    sidebarToggle.title = collapsed ? "展开侧栏 (Ctrl+B)" : "折叠侧栏 (Ctrl+B)";
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
  if (focused) current?.onFocus?.();
});

// ---- 空间切换(97 多空间,sync-plan §六):brand 下入口 + 轻浮层菜单 -------------
// 入口一行当前空间名;菜单 = 空间列表(状态点 + 当前标)+ 新建 + 改名。切空间 =
// 记住选择 → 通知同步 UI 换数据源 → 当前视图原地重挂(新空间全量重查)。
const spaceEntry = document.getElementById("space-entry") as HTMLButtonElement;
const spaceNameEl = document.getElementById("space-name") as HTMLElement;

function refreshSpaceEntry(): void {
  void listSpaces().then((all) => {
    setSpaceNames(new Map(all.map((s) => [s.id, spaceLabel(s)])));
    // 状态基线一并喂给同步 UI(启动即 veto 的空间没有事件桥,红点全靠这份快照)。
    seedSpaceStatuses(all);
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
    showToast("这条所在的空间不在这台设备上");
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
    showToast(`打开失败:${String(e)}`);
    return;
  }
  if (!loc) {
    showToast("找不到这条(可能已删除)");
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
(window as unknown as { __zhujianOpenDeepLink?: (u: string) => void }).__zhujianOpenDeepLink = (u) =>
  void openDeepLink(u);

let spaceMenu: HTMLDivElement | null = null;

function closeSpaceMenu(): void {
  spaceMenu?.remove();
  spaceMenu = null;
  document.removeEventListener("mousedown", onSpaceMenuDoc, true);
  document.removeEventListener("keydown", onSpaceMenuKey, true);
}

function onSpaceMenuDoc(e: MouseEvent): void {
  const t = e.target as Node;
  if (spaceMenu && !spaceMenu.contains(t) && !spaceEntry.contains(t)) closeSpaceMenu();
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
  preparing: "准备中…",
  pairing: "正在配对…",
  booting: "正在拉取账户数据…",
  publishing: "正在落成空间…",
  integrating: "正在装入空间列表…",
};

void listen<{ attempt_id: string; phase: string; received: number; total: number }>(
  "join-progress",
  (e) => {
    const p = e.payload;
    if (p.attempt_id !== joinAttempt || !joinNoteEl) return;
    joinNoteEl.textContent =
      p.phase === "booting" && p.total > 0
        ? `正在拉取账户数据 ${(p.received / 1048576).toFixed(1)} / ${(p.total / 1048576).toFixed(1)} MB`
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
  note.textContent = "准备中…";
  go.disabled = true;
  try {
    const out = await joinSpace(serverUrl, code, attempt);
    if (out.kind === "integrated") {
      const warn = out.warnings.length ? `(注意:${out.warnings.join(";")})` : "";
      closeSpaceMenu();
      refreshSpaceEntry();
      // Integrated 不含强切(§3.2 / codex 一轮 H1):当前视图有未保存的输入
      // (compose/编辑卡都是 textarea;过滤框是 input[type=search] 不算)时**保持
      // 原前台**——桌面视图重挂会丢别的空间的草稿,只指路不代切。
      if (viewHasDirtyText()) {
        showToast(`已加入空间「${spaceLabel(out.space)}」${warn}——保存或清空正在编辑的内容后,从空间菜单切换过去`);
      } else {
        showToast(`已加入空间「${spaceLabel(out.space)}」${warn}`);
        switchSpace(out.space.id);
      }
    } else {
      // 空间已真实存在(账户已注册):如实提示重启后出现,**绝不当失败重试**。
      showToast(out.error);
      note.textContent = out.error;
      cancel.textContent = "关闭";
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
  row.textContent = "加入空间(输入配对码)…";
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const server = document.createElement("input");
    server.placeholder = "服务器地址(wss://…)";
    server.value = DEFAULT_SYNC_URL;
    server.spellcheck = false;
    const code = document.createElement("input");
    code.placeholder = "配对码(对方设备「添加设备」出示)";
    code.spellcheck = false;
    const go = document.createElement("button");
    go.textContent = "加入";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
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
  row.textContent = "重置当前空间…";
  row.addEventListener("click", () => {
    const form = document.createElement("div");
    form.className = "space-form";
    const warn = document.createElement("div");
    warn.className = "space-err";
    warn.textContent = configured
      ? "将删除本机此空间的全部数据,不可恢复。确认另一台设备有在线完整副本后再继续;重置后可用「加入空间」重新加入,旧设备身份请告知运营者吊销。"
      : "此空间未开启同步,本机就是唯一副本——重置=永久删除这个本子的全部内容,没有任何地方可以找回。";
    const ok = document.createElement("button");
    ok.textContent = "确认重置";
    const cancel = document.createElement("button");
    cancel.textContent = "取消";
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

async function openSpaceMenu(): Promise<void> {
  if (spaceMenu) {
    closeSpaceMenu();
    return;
  }
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
      row.title = s.status.error ?? "此空间未装载";
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
    spaceActionRow("＋ 新建空间", "空间名(比如「家庭」)", async (name) => {
      const info: SpaceInfo = await createSpace(name);
      closeSpaceMenu();
      switchSpace(info.id);
      showToast("空间已创建,现在就能记录。想多端同步,到「同步」里创建账户。");
    }),
  );
  menu.appendChild(spaceJoinRow());
  menu.appendChild(
    spaceActionRow("重命名当前空间", "新名字", async (name) => {
      await renameSpace(currentSpaceId(), name);
      closeSpaceMenu();
      refreshSpaceEntry();
    }),
  );
  menu.appendChild(
    spaceResetRow(all.find((s) => s.id === currentSpaceId())?.status.configured ?? false),
  );
  const r = spaceEntry.getBoundingClientRect();
  menu.style.left = `${Math.round(r.left)}px`;
  menu.style.top = `${Math.round(r.bottom + 4)}px`;
  document.body.appendChild(menu);
  spaceMenu = menu;
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
  await initSync({ refresh: () => current?.onFocus?.() });
  refreshSpaceEntry();

  // 自动更新(88):启动静默查一次。只在生产构建跑(dev/e2e 是 vite dev server,
  // import.meta.env.PROD 为 false),开发/测试期不打网络也不弹 banner。
  if (import.meta.env.PROD) void initUpdate();

  // Land on the last-used view. Absent or unknown (first run, a since-renamed
  // view name) is the first-run default, not an error path — land on inbox.
  const lastView = localStorage.getItem(LAST_VIEW_KEY);
  navigate(lastView !== null && lastView in registry ? (lastView as ViewName) : "inbox");
})();
