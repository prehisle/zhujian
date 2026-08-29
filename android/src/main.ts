// P4-c 捕获页 + 统一时间轴 + 勾标完成;P4-d 接同步;107 扫码配对;
// 工序 7/8(multispace-plan):多空间——头部空间 chip(§9 捕获目标常显、点名可切)、
// 空间面板(列表/新建/改名/全部同步)、业务命令显式携带「点击时看到的 spaceId」
// (§16.2 提案 B:目标由后端协调器复核,切换中响亮拒、草稿成功落库才清)。
// currentSpace 只是后端 foreground 的影子:每次切换/恢复后从 foreground_space 对账。
// 119 起空间影子 + sinvoke + 业务命令包装上抬到 src/api.ts(全功能底座的调用层,
// 单一真相源);本文件只剩视图编排,业务调用一律走 api 包装——**app 级/空间管理命令
// 除外**(join_space/activate_space/create_space 等,豁免清单见 api.ts 文件头)。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { applyStaticI18n, currentLangChoice, initLang, setLangChoice, t, type LangChoice } from "./i18n";
import { currentThemeMode, initTheme, setThemeMode, type ThemeMode } from "./theme";
import { currentTextSize, initTextSize, setTextSize, type TextSize } from "./textsize";
import {
  getCurrentSpace,
  setCurrentSpace,
  sinvoke,
  captureIdea,
  captureTodo,
  completeTask,
  deviceIdentity,
  setDeviceAlias,
  deleteItemImage,
  listBoardColumns,
  listSpaces,
  listTimeline,
  listTopicsFull,
  paneCounts,
  spaceLabel,
  updateTaskStatus,
  type SpaceInfo,
  type TaskStatus,
  type TimelineItem,
} from "./api";
import { $, actionBar, confirmBar, esc, fmtWhen, hideConfirmBar, showBar, showError } from "./ui";
import { DONE_COLUMN, boardColumns, isTaskStage, setColumns, stageLabel } from "./columns";
import { capturePhoto, composeImages, PICK_MAX, pickImages } from "./images";
import { INPUT_DEBOUNCE_MS } from "./timing";
// **平台接缝**(OH-d/D3):只在安卓壳里存在的那三条命令。鸿蒙那端由 vite 换成另一份实现。
import { checkUpdate, HAS_SAF_BRIDGE, HAS_TEXT_ZOOM, takeDeepLink, takeSharedText, type MobileUpdate } from "./platform";
import * as backup from "./backup";
import * as cardPanel from "./cardpanel";
import * as filter from "./filter";
import * as panes from "./panes";
import * as topics from "./topics";
import { initCardSwipe } from "./swipe";
import { loadIdentity, signatureFor } from "./identity";
import { createKbSheet } from "./kbsheet";
import {
  closeComments,
  closeCommentsNow,
  commentBadgeHtml,
  initComments,
  isCommentsOpen,
  loadCommentCounts,
  openComments,
  refreshOpenComments,
} from "./comments";
import { disconnectThumbObserver, fillThumb, hydrateThumbs } from "./thumbs";
import { closeViewerNow, initViewer, isViewerOpen, openLocalViewer, openViewer } from "./viewer";
import {
  dismissScanOverlay,
  initSync,
  renderSync,
  resetSyncTransient,
  type Spaced,
  type SyncStatus,
} from "./sync";
import { openUrl } from "@tauri-apps/plugin-opener";

type DbInfo = {
  path: string;
  sqlite_version: string;
  journal_mode: string;
  user_version: number;
  device_id: string;
  items: number;
};
type ProbeStep = { name: string; ok: boolean; detail: string };
type SyncOutcome = {
  space: string;
  name: string | null;
  outcome: string;
  progressed: boolean;
  detail: string | null;
};
type SyncAllReport = { outcomes: SyncOutcome[]; restore_error: string | null };
// 事件桥的统一信封(后端 bridge_emit):space 标 + 代次 + 原 payload。前端按
// 「space=当前 且 generation ≥ 该空间已见最大代次」过滤——切换/回滚/遍历恢复
// 会重激活同一空间,旧桥 buffer 里的迟到事件不许盖过新代次的状态(§12)。
// 类型 Spaced<T> 随三个同步面监听住 sync.ts(310 第③笔);谓词与代次账本留这——
// space-foreground 监听要直写账本,sync.ts 经 Deps 拿谓词。

const seenGeneration: Record<string, number> = {};

function acceptSpaced(e: { space: string; generation: number }): boolean {
  if ((seenGeneration[e.space] ?? 0) > e.generation) return false;
  seenGeneration[e.space] = e.generation;
  return e.space === getCurrentSpace();
}

// 启动闸(工序 6):**默认封锁**——问闸之前不发任何数据面调用、不取分享暂存。
let gateBlocked = true;

// ---- 当前空间(影子在 api.ts,这里只剩切换编排的本地态) ----------------------

const LAST_SPACE_KEY = "zhujian.last-space";

let spacesCache: SpaceInfo[] = [];
let switching = false; // 切换编排进行中:禁保存/禁再切(后端 UserSwitching 拒兜底)
let renamingSpace = false; // 空间面板当前行的行内改名态
let resettingSpace: string | null = null; // 空间面板「重置」两拍确认中的行(epoch-plan §7)
let spaceMenuFor: string | null = null; // 空间行「⋯」展开态(ui-audit P1 #11:重置入口降权)

// ---- 主视图 mode(146):灵感/任务两面 = 同一条 live_timeline 的投影 ----------
// lastItems 恒存全量(卡片面板真值、跨面定位查 stage 都靠它),渲染按 mode 过滤;
// mode 从不压 history 层(不是层),启动恒落灵感面、不持久化。

type ViewMode = "ideas" | "tasks";
let viewMode: ViewMode = "ideas";
// 时间轴筛选(灵感/看板两面各持一份,同桌面 board/inbox 各自记忆自己的筛选):
// 切面保留、切空间清零。allFilterTopics 是带 kind 的全量标签(list_topics_full),
// 每轮刷新重取——类型轴的真相只在它上(per-item chip 不带 kind)。
const filters: Record<ViewMode, filter.FilterState> = {
  ideas: { kind: "all", topics: [], text: "" },
  tasks: { kind: "all", topics: [], text: "" },
};
// 任务面的状态维(404+1):null = 全部,否则只看该 stage 的段。⛔ 刻意不进 filter.ts 的
// FilterState——那是 check-filter-parity 钉住的两端共享纯逻辑,桌面没有这一维(看板四列
// 本就并排);本维在本文件外挂、应用在共享 applyFilter 之后。同 filters:切面无关
// (任务面专属)、切空间清零;新任务落面时随 clearFilter 一并归零(免得新卡被藏)。
let taskStageFilter: string | null = null;
let allFilterTopics: filter.FilterTopic[] = [];
// 用户主动导航(点 mode 钮)/开始保存 → ++,作废在途的 focus 定位(146 ▲M2/▲▲M3:
// 旧定位的内部切面不许反抢用户刚选的面、不许打破保存的「新卡在当前面」承诺)。
let navSeq = 0;
// 「记下」single-flight(146 ▲H1):在飞期间禁再点、禁 mode/pane/空间切换。
let captureSaving = false;
// 在飞期间发生过新输入/分享追加(哪怕后来又删空,实现审 L1):成功回执据此判
// 「用户正在打字」——不 blur、不抢焦点、不滚动;别用「框是否为空」当替身。
let captureLiveTouched = false;
// 草稿断电恢复(197 下一步①):compose 文字草稿走 localStorage(纯设备本地 UI 状态,
// 绝不进 DB/同步;图走 IndexedDB,见 images.ts)。输入即写、记下成功清、启动回填——
// 意外断电/杀进程后重开,上次没记下的文字还在。单条全局草稿(与文字框跨面/跨空间
// 复用同哲学,存到记下那刻落当前空间)。
const COMPOSE_DRAFT_KEY = "zhujian.compose-draft";
function persistComposeText(): void {
  const v = ($("text") as HTMLTextAreaElement).value;
  if (v) localStorage.setItem(COMPOSE_DRAFT_KEY, v);
  else localStorage.removeItem(COMPOSE_DRAFT_KEY);
}
$("text").addEventListener("input", () => {
  if (captureSaving) captureLiveTouched = true;
  persistComposeText();
});

// 记灵感时的暂存配图(195 slice1):点「加图」贴进 compose 暂存条,「记下」建条目后
// 随之挂上(save() 的两缓冲结算)。暂存不随切面/切空间清(与文字草稿同律),存到保存
// 那刻落到当前空间。取图/转码走共享件 images.ts,与卡片操作面「加图」同一套。
// 点缩略图看大图(用户面 36):暂存图还没入库、没有「图N」的号,故走查看器的 local 那一路
// ——字节(objectURL)由暂存条持有,查看器只读不 revoke;那边「删除」= 回调 remove 摘掉这张。
const compImgs = composeImages($("compose-thumbs"), (items, idx) => void openLocalViewer(items, idx));
function holdComposeImage(file: File): void {
  compImgs.add(file);
  if (captureSaving) captureLiveTouched = true; // 罕见:选图期间「记下」在飞=新输入
}
// 取图在飞(系统选择器开着 + 回来那几秒的降采样):两枚加图钮整体不受理。⛔ 没有这道闸
// 连点两下会**真的起两个系统选择器** —— `await` 期间按钮照样可点,而降采样是主线程活,
// 那几秒正是最容易被再戳一下的时候。
let picking = false;
// 取图/取消都回到输入:系统选择器会背景化 webview 让输入掉焦,回来须重聚焦——
// 捕获层(232)据此不误关、键盘回来,顺手写配文。
function refocusCompose(): void {
  ($("text") as HTMLTextAreaElement).focus();
}
$("compose-addimg").addEventListener("click", async () => {
  if (captureSaving || switching || picking) return; // 在飞/切换中不受理(与「记下」同闸)
  picking = true;
  refreshSaveDisabled(); // 骨架摆着的时候「记下」不许点(理由见那个函数)
  try {
    // 多选逐张交付(391):每张降采样完就进暂存条,缩略图一张张长出来。
    // reserve 那枚回调在**降采样之前**就跑(images.ts),于是这几秒屏上先有 N 个骨架在转。
    const res = await pickImages(holdComposeImage, (n) => compImgs.reserve(n));
    if (res.kind === "tooMany") showError(t("images.tooMany", { max: PICK_MAX, n: res.count }));
  } finally {
    compImgs.dropReserved(); // 与 reserve 配对:没被填上的骨架一律收掉(取消 / 中途抛)
    picking = false;
    refreshSaveDisabled();
    refocusCompose();
  }
});
$("compose-photo").addEventListener("click", async () => {
  if (captureSaving || switching || picking) return;
  picking = true;
  refreshSaveDisabled();
  try {
    const file = await capturePhoto(() => compImgs.reserve(1));
    if (file) holdComposeImage(file);
  } finally {
    compImgs.dropReserved();
    picking = false;
    refreshSaveDisabled();
    refocusCompose();
  }
});

/** 灵感那两列是**系统固定**的(不变量 2:不可改名 / 不可删 / 永不新增)⇒ 这两个字面量
 *  安全。⛔ 任务那边**没有**这样的常量表,别照着这里再抄一张。 */
const IDEA_STAGES = new Set(["inbox", "filed"]);

// stage → 主视图归属。未知值响亮抛(铁律:不写兜底)。
// ⭐ **B-f 第 1 段起任务那半靠列的 kind 判**,不再是一张六值映射表(不变量 3:灵感态 vs
// 任务态由 `board_column.kind` 说了算)。两边都答不上 = 库里出了一个谁都不认识的 stage
// (FK 保证它不可达)。
function modeOfStage(stage: string): ViewMode {
  if (isTaskStage(stage)) return "tasks";
  if (IDEA_STAGES.has(stage)) return "ideas";
  throw new Error(`未知 stage:${stage}`);
}

// 任务面的分组 = **当前空间真实的那几列**(B-f 第 1 段起从库里来;此前是四值字面量)。
// 序 = core 按 position 排好的序;空组不显;组内沿时间倒序 —— 手机不读 position、不做拖排,
// 组内时间序是本端自己的确定性顺序(146 §2.1)。
// ⚠ 已删但还扣着卡的列也在里面(§4.3 只读收容区),卡挪光后它自然不再出现。
const taskSections = (): { stage: string; label: string }[] =>
  boardColumns().map((c) => ({ stage: c.id, label: stageLabel(c.id)! }));

// 优先级角标的三档词(1..3;下标 0 恒不取——priority 有值才画这枚 chip)。
// ⚠ 506 起是 P 记号且方向相反:3 = **P0(最高)** / 2 = P1 / 1 = P2,库里仍存 1/2/3。
const PRIORITY_LABEL: Record<number, string> = {
  1: t("main.prioLow"),
  2: t("main.prioMid"),
  3: t("main.prioHigh"),
};

// ---- 统一时间轴 -------------------------------------------------------------

// hideTopic:恰好单选一枚标签筛选时,卡上那枚同名 chip 是纯冗余(筛出来的卡本就都带它),
// 直接不渲染(同桌面 218 灵感侧;安卓 chip 无拖拽去重等 DOM 依赖,面板真值走 lastItems)。
function renderCard(it: TimelineItem, hideTopic: string | null): string {
  const label = stageLabel(it.stage);
  const isTask = label !== undefined;
  const done = it.stage === DONE_COLUMN;
  const tick = isTask
    ? `<label class="tick"><input type="checkbox" data-id="${esc(it.id)}"
         ${done ? "checked disabled" : ""} /><span class="box"></span></label>`
    : "";
  const pill = isTask ? `<span class="pill">${label}</span>` : "";
  const chips = it.topics
    .filter((t) => t.id !== hideTopic)
    .map(
      (t) =>
        `<span class="chip${t.color ? " tinted" : ""}"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
    )
    .join("");
  // 配图缩略(117):只渲染占位框,字节滚到可视区才拉(thumbObserver)。
  const thumbs = it.images.length
    ? `<div class="thumbs">${it.images
        .map(
          (im) =>
            `<button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"
               aria-label="${t("main.viewImage", { n: im.seq })}"><span class="tag-n">${t("images.imageN", { n: im.seq })}</span><span class="thumb-del" role="button" aria-label="${t("main.deleteImage", { n: im.seq })}">×</span></button>`,
        )
        .join("")}</div>`
    : "";
  // 120:data-id 供卡片操作面板定位;截止/优先级角标(任务行、有值才显)。
  const meta: string[] = [];
  if (it.due_on) meta.push(`<span class="chip">${t("main.dueChip", { day: esc(it.due_on) })}</span>`);
  if (it.priority) meta.push(`<span class="chip">${t("main.priorityChip", { p: PRIORITY_LABEL[it.priority] })}</span>`);
  // 完成时刻(0030):已完成卡显示「完成于 <时刻>」;done_at 为 null(本功能前完成的老卡)则不显示。
  const doneAt = done && it.done_at ? `<time class="done-at">${t("main.doneAt", { when: esc(fmtWhen(it.done_at)) })}</time>` : "";
  // 署名(0033):只在「不是本机」且「那台起过别名」时显一枚小字;其余一律不显
  // (未命名设备刻意不显 id 片段——卡片上一串 K7M2QX 是噪音)。
  const sigName = signatureFor(getCurrentSpace(), it.born_device);
  const sig = sigName ? `<span class="sig-chip">${esc(sigName)}</span>` : "";
  // 留言徽章(0035):`💬 N`,N=0 不渲染(布局未定不显示)——第一条留言的入口在卡片
  // 操作面板的「留言」上。计数走 comments.ts 按空间键住的聚合快照,与列表两个真相源。
  const cmBadge = commentBadgeHtml(getCurrentSpace(), it.id);
  return `<article class="card${done ? " done" : ""}" data-id="${esc(it.id)}">${tick}<div class="body">
    <p class="content">${esc(it.content)}</p>${thumbs}
    <footer>${pill}<time>${esc(fmtWhen(it.created_at))}</time>${doneAt}${sig}${cmBadge}${meta.join("")}${chips}</footer>
  </div></article>`;
}

// 时间轴最新一次渲染的条目快照(卡片操作面板的真值来源;refreshOnce 每轮重建)。
let lastItems = new Map<string, TimelineItem>();

// ---- 返回键层账本(143):安卓返回键的第一本能是「关掉当前层」,此前直接退 app。
// WryActivity 内建「WebView 有历史先 goBack」,故开层(面板/大图)pushState 压一枚
// 守门条目,返回键触发 popstate 时关最上层;UI 主动关层则补一记 history.back() 把
// 守门条目消掉(popSuppress 标记让 popstate 只记账不再关层),账本与屏幕恒一致。
let histDepth = 0;
// popSuppress 兼任「back 在飞」标志(146 ▲▲M4):settleHistory 发出的 history.back()
// 到对应 popstate 之间,histDepth 还没递减——这段窗口内再调 settleHistory 会看着
// histDepth>0 又 back 一次(双弹)。settle 只在无 back 在飞时发;窗口内的开层请求
// DOM 照开、pushState 挂账(deferredLayers),popstate 收口后补压——账本与屏幕恒一致,
// 绝不让 pushState 与 back 乱序。
let popSuppress = 0;
let deferredLayers = 0;

function pushLayer() {
  if (popSuppress > 0) {
    deferredLayers++; // back 在飞:挂账,收口后补压(histDepth 由补压处递增)
    return;
  }
  histDepth++;
  history.pushState({ layer: histDepth }, "");
}

/** UI 主动收层之后调:消掉守门条目。层是 popstate 关的就不要再调。 */
function settleHistory() {
  if (deferredLayers > 0) {
    deferredLayers--; // 这层还没压进历史(挂账中):直接销账,不发 back
    return;
  }
  if (nativeBackPending) {
    // native 的 back 在飞、正要弹的就是这枚守门条目(codex 终局审 M1:此窗口内
    // 用户点 UI 关层,层已由 UI 关掉——把在飞的 pop 归因成本次 settle,改记
    // suppressed,popstate 到达时只记账不再关层;绝不再补发第二记 back)。
    nativeBackPending = false;
    popSuppress++;
    return;
  }
  if (popSuppress > 0) return; // 已有 back 在飞:幂等 no-op,收口时账目自然对齐
  if (histDepth > 0) {
    popSuppress++;
    history.back();
  }
}

// Kotlin 侧返回键的原子入口(146,codex 补审 M1/M2):判断+消费一体,返回 true=
// 本次返回已被页面消费,false=无层可关(Kotlin 走系统默认路退 app)。
// WebView.canGoBack() 对 pushState 同文档条目返回 false(真机取证),native 判定
// 不可用——账本是唯一真相源。窄窗全在这里收口:
// - 扫码层优先(它不压 history 层):走既有取消路收相机,消费本次返回;
// - back 在飞(native 发的/settleHistory 发的)期间重复按:合并吞掉,绝不补发
//   history.back()(双 pop 会把守门账本打穿);
// - 挂账层(deferredLayers,back 在飞窗口内开的层):没有已压的历史条目可弹,
//   直接关最上层并销账。
let nativeBackPending = false; // native 请求的 history.back() 已发、popstate 未归

(window as unknown as Record<string, unknown>).__zhujianHandleBack = (): boolean => {
  if (document.body.classList.contains("scanning")) {
    dismissScanOverlay(); // 扫码层收掉(UI 收尾不等插件),下面的面板/时间轴原地不动
    return true;
  }
  // 挂账层必须先于「在飞合并」判(codex 终局审 M1):deferredLayers 只在
  // popSuppress>0 窗口内产生,后判就永远够不着——「UI 关层 back 在飞→重开层→
  // 硬件返回」会被合并吞掉、重开的层却还开着。挂账层没有已压的历史条目,直关销账。
  if (deferredLayers > 0) {
    if (isViewerOpen()) closeViewerNow();
    else if (isCommentsOpen()) closeCommentsNow();
    else if (activePane !== null) closePaneNow();
    settleHistory(); // 销挂账(settleHistory 首分支),不发 back
    return true;
  }
  if (nativeBackPending || popSuppress > 0) return true; // back 在飞:合并
  if (histDepth > 0) {
    nativeBackPending = true;
    history.back();
    return true;
  }
  return false;
};

window.addEventListener("popstate", () => {
  nativeBackPending = false; // native 发的 back 已归账
  histDepth = Math.max(0, histDepth - 1);
  if (popSuppress > 0) {
    popSuppress--;
    while (deferredLayers > 0) {
      deferredLayers--; // back 已收口:把窗口内挂账的层补压进历史
      histDepth++;
      history.pushState({ layer: histDepth }, "");
    }
    return;
  }
  if (isViewerOpen()) {
    closeViewerNow();
    return;
  }
  // 留言层压在时间轴之上、面板之下(它只从时间轴开):返回键先收它。
  if (isCommentsOpen()) {
    closeCommentsNow();
    return;
  }
  if (activePane !== null) closePaneNow();
  // 都没开 = 陈旧守门条目(空间切换复位等已把层收掉):静默吞,再按一次才退 app。
  // mode 从不压层:任务面按返回与灵感面同账,直接退 app(146 §2.3)。
});

// 编辑态多图管理(cardpanel 给 actions 面开着的卡片挂 .imgmanage 露出缩略图 ×):删这张图。
// 两拍确认,与查看器删图(197)同律(图无回收站、编号退役不复用);删成刷新轴,缩略图随之消失。
// actions 面无脏草稿,refresh 不被草稿闸延后(edit 面恒脏才有那问题,故删图放 actions 面)。
function confirmDeleteImage(space: string, id: string, seq: string) {
  confirmBar(t("main.deleteImageQ", { n: seq }), t("main.deleteImageYes"), () => {
    if (getCurrentSpace() !== space) return; // 期间切空间:作废
    void (async () => {
      try {
        await deleteItemImage(space, id);
        await refresh();
        showBar(t("main.imageDeleted"), true);
      } catch (err) {
        showError(String(err));
      }
    })();
  });
}

/** 开留言层的单一入口(卡上的 💬 徽章与操作面板的「留言」共用):三道闸同 openPane
 *  ——切换编排中屏上还是旧空间的卡、「记下」在飞时刷新被锁、有草稿时层会把它盖住。 */
function openCommentsFor(itemId: string): void {
  if (switching || captureSaving) return;
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  openComments(getCurrentSpace(), itemId);
}

$("timeline").addEventListener("click", (e) => {
  if (switching) return; // 切换编排中:屏上还是旧空间的卡,不接受任何取图请求
  const target = e.target as HTMLElement;
  const badge = target.closest<HTMLElement>(".cm-badge[data-cm]");
  if (badge) {
    openCommentsFor(badge.dataset.cm!);
    return;
  }
  const btn = target.closest<HTMLElement>(".thumb[data-img]");
  if (!btn) return;
  if (target.closest(".thumb-del")) {
    // 露出的删图 ×(仅 .imgmanage 卡可见):两拍确认删,不落到看大图。
    confirmDeleteImage(getCurrentSpace(), btn.dataset.img!, btn.dataset.seq ?? "");
    return;
  }
  if (btn.classList.contains("err")) {
    btn.classList.remove("err"); // 暂态读错不判死:点一下重试
    void fillThumb(btn);
    return;
  }
  // 225:连同条目的整组图一起交给查看器(横滑翻页要的就是这个),组来自 lastItems——
  // 它与时间轴 DOM 在同一轮 refreshOnce 里由同一份 items 建出,天然同步。
  const card = btn.closest<HTMLElement>(".card[data-id]");
  const group = card ? (lastItems.get(card.dataset.id!)?.images ?? []) : [];
  const idx = group.findIndex((m) => m.id === btn.dataset.img);
  if (idx < 0) {
    showError(t("main.imageGone"));
    return;
  }
  void openViewer(group, idx);
});

// 读失败画在读的位置(时间轴区域),写失败亮在错误条——两个通道各管各的。
// single-flight + rerun(codex 二审):保存/勾完成/同步事件会重叠触发刷新——
// 并行跑两份,晚发先回时旧列表会盖掉新列表,且先回那份 observe 的占位框在后回
// 那份重建 DOM 后没人 disconnect(泄漏)。合并成一条在飞 + 循环重跑,**重入调用
// 拿到的是覆盖到最终一次重跑的同一个 Promise**(codex 四审:否则 await refresh()
// 在「已有在飞」时立即返回,切换路以为画完了、旧 DOM 还在屏上)。
// 刻意不走 sinvoke(它对迟到响应「永不决议」,会把在飞闸永久毒化):自己带空间标,
// 响应回来空间已切走 = 静默弃掉(错误同弃、不碰 DOM),现任那轮自己负责重建。
let refreshRun: Promise<void> | null = null;
let rerunRefresh = false;

// 草稿保护(120,codex H1):编辑态/未提交的新标签输入在场时,任何一轮重画都
// 延后——查询前早退是快路,**await 之后、动 DOM 之前必须复检**(刷新已在飞、
// 用户随后进入编辑,旧响应回来仍会冲掉草稿);错误分支同检。延后用独立标志,
// 不复用 rerunRefresh(持续同步事件会把 rerun 循环空转)。草稿收场时补刷。
let refreshDeferred = false;
// 快照有效性单一标志(146 ▲▲M2,收敛原 lastRefreshOk):true = lastItems 是本空间
// 一次成功读取的全量快照且已落过 DOM。读失败/清屏置 false——失效期间 mode 切换
// **不许把旧快照投影回可点击卡**(错误页保留、顺手重试);focus 定位也据此区分
// 「读取失败」与「条目真的已离开」。
let lastRefreshOk = false;

/** 投影提交(146 ▲M1 统一函数):observer 断开 → 按当前 mode 过滤重建 DOM →
 *  缩略图 hydrate → 面板 restore,四步收在一处;refresh 落 DOM 与 mode 切换共用。
 *  **写 DOM 这一刻读当前 viewMode**,绝不用请求发起时的旧 mode。 */
function projectTimeline(): void {
  const box = $("timeline");
  disconnectThumbObserver();
  const items = [...lastItems.values()];
  const modeItems = items.filter((i) => modeOfStage(i.stage) === viewMode);
  const f = filters[viewMode];
  // 死标签/死类型回落(纯状态,先于渲染 pills 与应用过滤,同桌面共享件次序)。
  filter.reconcileTopicFilter(f, allFilterTopics);
  filter.reconcileKindFilter(f, allFilterTopics);
  renderFilterBar(modeItems);
  const shown = filter.applyFilter(modeItems, f, (i) => i.content, allFilterTopics);
  const hideTopic = filter.soleTopicFilter(f); // 单选一枚标签时,卡上同名 chip 不渲染(218 同法)
  if (viewMode === "ideas") {
    box.innerHTML = shown.length
      ? shown.map((i) => renderCard(i, hideTopic)).join("")
      : modeItems.length === 0
        ? `<p class="muted empty">${t("main.emptyIdeas")}<br />${t("main.emptyIdeasHint")}</p>`
        : filteredEmptyHtml(f);
  } else {
    // 状态维最后应用(在共享三维之后):空态的话语权也按同序——词/标签/类型筛空的提示
    // 优先(shown 已空),三维有结果、被状态维筛空才说「该状态下没有任务」。
    const stageShown = taskStageFilter === null ? shown : shown.filter((t) => t.stage === taskStageFilter);
    box.innerHTML = stageShown.length
      ? taskSections().filter((s) => stageShown.some((t) => t.stage === s.stage))
          .map(
            (s) =>
              `<section class="tl-group"><h3 class="tl-sec">${s.label}</h3>${stageShown
                .filter((t) => t.stage === s.stage)
                .map((t) => renderCard(t, hideTopic))
                .join("")}</section>`,
          )
          .join("")
      : modeItems.length === 0
        ? `<p class="muted empty">${t("main.emptyTasks")}<br />${t("main.emptyTasksHint")}</p>`
        : shown.length > 0 && taskStageFilter !== null
          ? `<p class="muted empty">${t("main.noneUnderStage", { stage: stageLabel(taskStageFilter)! })}</p>`
          : filteredEmptyHtml(f);
  }
  hydrateThumbs(box);
  cardPanel.restore(box); // 展开态跨重画恢复(条目已不在=清态)
}

/** 筛选条:本面有条目才显示(空面无可筛)。类型行 + 标签行由 filter.ts 渲染,文本框
 *  是常驻元素(不随 pills 重建、打字不丢焦点),值在 applyMode/清筛处另行同步。 */
function renderFilterBar(modeItems: TimelineItem[]): void {
  const bar = $("filterbar");
  bar.hidden = modeItems.length === 0;
  if (modeItems.length === 0) return;
  renderStagePills($("filter-stages"), modeItems);
  const f = filters[viewMode];
  filter.renderKindPills($("filter-kinds"), modeItems, allFilterTopics, f, onFilterPick);
  filter.renderTopicPills($("filter-topics"), modeItems, allFilterTopics, f, onFilterPick);
  syncTagsToggle(); // pills 换了 = 「一行装不装得下」的答案可能也换了
}

// ---- 标签行摊开 / 收起(用户面 36)---------------------------------------------
// 标签行平时是**单行横滑**,窄屏上常常一枚真标签都露不出来(屏上只剩「所有 / 无标签」),
// 找标签只能盲着往右滑。这枚钮把它翻成多行全展 —— 桌面 `.topic-filter` 本来就是
// `flex-wrap: wrap` 全展开的,安卓这一格是当初为窄屏做的取舍,现在把选择权交回用户。
// ⛔ **它只翻布局,不动父子折叠**(那是父 pill 上那枚箭头的事)。
// 纯设备本地 UI 偏好,**不进同步** —— 同明暗档 / 字号:它是「这块屏幕多宽」的属性。
// ⛔ 刻意不放进 `filter.ts`:那份是与桌面逐字对齐、被 check-filter-parity 压着的纯逻辑,
//    而「这一端要不要换行」恰恰是两端**该**不一样的地方。
const TAGS_OPEN_KEY = "zhujian.filter-tags-open";
let tagsOpen = localStorage.getItem(TAGS_OPEN_KEY) === "1";

function syncTagsToggle(): void {
  const topics = $("filter-topics");
  const btn = $("filter-expand") as HTMLButtonElement;
  $("filterbar").classList.toggle("tags-open", tagsOpen);
  btn.classList.toggle("on", tagsOpen);
  btn.textContent = tagsOpen ? "▴" : "▾";
  btn.setAttribute("aria-label", tagsOpen ? t("shell.tagsCollapse") : t("shell.tagsExpand"));
  // 一行装得下就整枚藏起(一枚点了没变化的钮比没有更糟)。⚠ 量的是**收起态**装不装得下:
  // 摊开着的时候 scrollWidth 恒等于 clientWidth,直接问会恒答「装得下」⇒ 钮把自己藏了,
  // 再也收不回来。故 `!tagsOpen &&` 那半是短路,不是顺手写的。
  btn.hidden = !tagsOpen && topics.scrollWidth <= topics.clientWidth + 1;
}
$("filter-expand").addEventListener("click", () => {
  tagsOpen = !tagsOpen;
  localStorage.setItem(TAGS_OPEN_KEY, tagsOpen ? "1" : "0");
  syncTagsToggle();
});
// ⚠ 那枚钮的显隐是**量出来的**,而量的结果会随视口(转屏)与字号(251 的 textZoom:
// `.ftext` 是 em,放大字号就吃掉更多横向空间)一起变 —— 只在 renderFilterBar 里算的话,
// 钮会停在上一个答案上。**实测**:把视口从 1138 压到 412,标签行溢出了而钮还藏着,
// 也就是这个功能在竖屏上整个消失。⇒ 再接一只 ResizeObserver 盯标签行自己的盒。
// 不会自激:藏钮只会让它更宽(装得下的仍装得下)、显钮只会让它更窄(装不下的仍装不下),
// 两个方向都单调,量一次就稳。
new ResizeObserver(() => syncTagsToggle()).observe($("filter-topics"));
// 过滤框歇着 6em、动笔才张到 11em(用户面 36:那个框此前吃掉窄屏三分之一宽,而这一行
// 真正要给的是标签)。⛔ 张开走**类**不走 `.ftext:focus`,理由印在 index.html 那条 CSS 上头。
{
  const ft = $("filter-text");
  ft.addEventListener("focusin", () => ft.classList.add("wide"));
  ft.addEventListener("focusout", () => ft.classList.remove("wide"));
}

/** 任务面的状态 chips 行:全部 + 四态(固定成员,含 0 计数——行的成员不随数据增减,
 *  布局稳定),与标签/类型 pills 同皮(.fpill)、同全量计数口径(192:不随文本收缩)。
 *  灵感面清空该行(CSS :empty 隐)。 */
function renderStagePills(bar: HTMLElement, modeItems: TimelineItem[]): void {
  if (viewMode !== "tasks") {
    bar.replaceChildren();
    return;
  }
  const mk = (label: string, stage: string | null, count: number | null): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `fpill${taskStageFilter === stage ? " active" : ""}`;
    b.dataset.stage = stage ?? "all";
    b.append(document.createTextNode(label));
    if (count !== null) {
      const n = document.createElement("span");
      n.className = "fn";
      n.textContent = String(count);
      b.append(n);
    }
    b.addEventListener("click", () => onStagePick(stage));
    return b;
  };
  const axis = document.createElement("span");
  axis.className = "faxis";
  axis.textContent = t("main.stageAxis");
  const nodes: HTMLElement[] = [axis, mk(t("main.stageAll"), null, null)];
  for (const s of taskSections()) {
    nodes.push(mk(s.label, s.stage, modeItems.filter((i) => i.stage === s.stage).length));
  }
  bar.replaceChildren(...nodes);
}

/** 点状态 chip 的落点:同 onFilterPick 的草稿闸;点已选中的状态 = 回「全部」。 */
function onStagePick(stage: string | null): void {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  taskStageFilter = stage !== null && taskStageFilter === stage ? null : stage;
  projectTimeline();
}

/** 点 pill 的落点:先过草稿闸(卡片编辑未存时重投影会拆掉草稿),再改本面筛选状态
 *  并重投影(纯客户端,不重新拉数据)。切类型时 filter.ts 已带上 topic:"all"。 */
function onFilterPick(patch: Partial<filter.FilterState>): void {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  Object.assign(filters[viewMode], patch);
  projectTimeline();
}

/** 筛空(本面有条目、被当前筛选滤没了)的空态文案:词优先,再标签,再类型——别让
 *  用户以为记录全没了。标签多选时把选中的名字全列出来(「A、B」下没有记录)。 */
function filteredEmptyHtml(f: filter.FilterState): string {
  const q = f.text.trim();
  if (q) return `<p class="muted empty">${t("main.noMatchText", { q: esc(q) })}</p>`;
  const labels = filter.selectedTopicLabels(f, allFilterTopics);
  if (labels.length === 1 && labels[0] === t("filter.none"))
    return `<p class="muted empty">${t("main.noUntagged")}</p>`;
  if (labels.length) {
    return `<p class="muted empty">${t("main.noneUnderTags", { labels: esc(labels.join(t("main.listSep"))) })}</p>`;
  }
  if (f.kind !== "all") return `<p class="muted empty">${t("main.noneUnderKind", { kind: esc(f.kind) })}</p>`;
  return `<p class="muted empty">${t("main.noMatch")}</p>`;
}

/** 清掉某面的筛选并同步文本框(新记录落该面时用,避免被停留的筛选藏起)。 */
function clearFilter(mode: ViewMode): void {
  if (mode === "tasks") taskStageFilter = null; // 状态维不在 FilterState 里,单独清(新任务必可见)
  const f = filters[mode];
  if (!filter.filterActive(f)) return;
  filters[mode] = { kind: "all", topics: [], text: "" };
  if (mode === viewMode) ($("filter-text") as HTMLInputElement).value = "";
}

async function refreshOnce(): Promise<void> {
  if (cardPanel.hasDirtyDraft()) {
    refreshDeferred = true;
    return;
  }
  const space = getCurrentSpace();
  try {
    // 时间轴 + 带 kind 的全量标签一把取(同 space、同一轮):后者供筛选条的类型轴与
    // 标签色/死筛回落用(per-item chip 不带 kind、也不含当前无条目的标签)。
    // 设备名册(0033 署名)与前两者**并发**取,不给渲染加一跳延迟;它内部吞错,
    // 署名少显一轮也绝不让整屏内容陪葬。
    // 留言计数(0035 徽章)与设备名册同批并发:它是**聚合计数**这一个真相源,列表另走
    // 分页(§4.14.2 第 4 条)——别为了对齐把留言正文整批拉过来。同样内部吞错(装饰)。
    const [items, ftopics, counts, cols] = await Promise.all([
      listTimeline(space),
      listTopicsFull(space),
      paneCounts(space), // 底栏两枚 pane 钮的显形真值(408-A1);失败同走整轮错误页
      listBoardColumns(space), // 看板列(B-f 第 1 段):没有它连「这行是不是任务」都答不了 ⇒ 失败同走整轮错误页
      loadIdentity(space),
      loadCommentCounts(space),
    ]);
    if (space !== getCurrentSpace()) return;
    if (cardPanel.hasDirtyDraft()) {
      refreshDeferred = true;
      return;
    }
    // ⚠ **列必须先于任何投影落定**:renderCard / 分组 / 滑动链全问 columns.ts,
    // 早一行晚一行的差别是「这一帧的卡按新列画还是按旧列画」。
    setColumns(cols);
    // 状态维的死筛回落(同标签轴的 reconcile):被筛的那一列若已彻底消失(删掉且卡也挪光),
    // 该筛选就成了一条永远筛空的死路 ⇒ 清掉。⛔ 别改成在渲染处回落显 id。
    if (taskStageFilter !== null && !boardColumns().some((c) => c.id === taskStageFilter)) taskStageFilter = null;
    lastItems = new Map(items.map((i) => [i.id, i])); // 全量真值,只在成功读取后更新
    allFilterTopics = ftopics.map((t) => ({ id: t.id, title: t.title, color: t.color, kind: t.kind }));
    paneHas = { trash: counts.trash > 0, sealed: counts.sealed > 0 };
    renderBottomBar();
    lastRefreshOk = true;
    projectTimeline();
    // 留言层:宿主还在就重拉第一页(别端写的留言自己冒出来),已经不在这批里就收层
    // ——判据是「这个视图还认不认识它」,详见 comments.ts refreshOpenComments 的注释。
    refreshOpenComments(space, lastItems.keys());
  } catch (err) {
    if (space !== getCurrentSpace()) return;
    if (cardPanel.hasDirtyDraft()) {
      refreshDeferred = true;
      return;
    }
    disconnectThumbObserver();
    $("timeline").innerHTML =
      `<p class="empty warn-ink">${t("main.timelineLoadFailed", { error: esc(String(err)) })}</p>`;
    lastRefreshOk = false; // 快照失效:mode 切换不投影、定位不误报"已归档"
  }
}

function refresh(): Promise<void> {
  if (refreshRun) {
    rerunRefresh = true;
    return refreshRun;
  }
  refreshRun = (async () => {
    do {
      rerunRefresh = false;
      await refreshOnce();
    } while (rerunRefresh);
  })().finally(() => {
    refreshRun = null;
  });
  return refreshRun;
}

/** 空间已切换(currentSpace 刚翻):旧空间的时间轴立即离场(codex 四审——旧 DOM
 *  多留一拍,点它的缩略图/勾框就会拿旧条目 id 打到新空间;清屏 = 没有可点的旧目标),
 *  随后的 refresh 负责画新空间。 */
function blankTimelineForSpaceChange(): void {
  refreshDeferred = false; // 旧空间欠的刷新作废:新空间马上整轴重拉
  closeComments(); // 留言层指着旧空间的条目(没开就是 no-op)
  cardPanel.forceClose(t("main.spaceSwitchedDraftDropped")); // 有草稿才响,静默无草稿路
  resetPanesForSpaceChange(); // 统一复位:关全部面 + 清陈旧内容 + 诊断缓存作废
  disconnectThumbObserver();
  lastItems = new Map();
  // 列同 lastItems 一起作废:每个空间是自己一套列(B-f 第 1 段)。⭐ **清空比留着旧的安全** ——
  // 留着 = 万一有一帧漏网,卡会**安静地**顶着旧空间的列名画出来;清空 = `modeOfStage` 两条臂
  // 都答不上,当场响亮抛。⇒ 错的方向落在 fail-fast 这一侧。
  setColumns([]);
  paneHas = { trash: false, sealed: false }; // 旧空间的 pane 钮不许挂到新空间数据到达前
  renderBottomBar();
  lastRefreshOk = false; // 快照失效(146 ▲▲M2):新空间读到之前,mode 切换不许投影旧数据
  $("timeline").innerHTML = `<p class="muted empty">${t("main.loading")}</p>`;
}

// 勾「标完成」:写命令,带点击时看到的空间;成败都刷新,不吞错、不做静默幂等。
$("timeline").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.id;
  if (!id || input.disabled) return;
  if (switching) {
    input.checked = false; // 切换编排中:屏上还是旧空间的卡,勾选不受理、当场回弹
    return;
  }
  const space = getCurrentSpace();
  // 勾框与 lastItems 是同一次投影(勾框在屏 ⇒ 快照必有此行);done 卡勾框 disabled,
  // 故 from 必是前三态——撤销要回的就是它,不是固定回 todo。
  const from = lastItems.get(id)!.stage as TaskStatus;
  input.disabled = true;
  try {
    await completeTask(space, id);
  } catch (err) {
    showError(String(err));
    await refresh();
    return;
  }
  await refresh();
  // 操作型回执(§3.1「已完成 · 撤销」):误勾一点召回,不用进操作面翻状态。
  actionBar(t("main.completed"), t("ui.undo"), () => {
    if (switching || getCurrentSpace() !== space) return; // 换空间的旧撤销作废
    void (async () => {
      try {
        await updateTaskStatus(space, id, from);
      } catch (err) {
        showError(String(err));
      }
      await refresh();
    })();
  });
});

// ---- 捕获(146:seg 两态删除,落点=当前主视图,placeholder 随面换) -----------

// ---- 系统分享入口(M4):原生侧暂存,这里一次性取走、只预填不自动保存 ----------
// 分享文本只是**预填草稿**(§16.2 提案 B):草稿不带目标空间,保存那刻结算。

let pullingShare = false;
let rerunShare = false;

async function pullSharedText() {
  if (gateBlocked) return;
  if (pullingShare) {
    rerunShare = true;
    return;
  }
  pullingShare = true;
  try {
    for (;;) {
      const text = await takeSharedText();
      if (!text) break;
      const ta = $("text") as HTMLTextAreaElement;
      ta.value = ta.value.trim() ? `${ta.value}\n${text}` : text;
      persistComposeText(); // 分享追加的文字也持久化(程序改值不触发 input)
      if (captureSaving) captureLiveTouched = true; // 分享追加=在飞新输入(实现审 L1)
      ta.focus();
    }
  } catch (err) {
    showError(String(err));
  } finally {
    pullingShare = false;
    if (rerunShare) {
      rerunShare = false;
      void pullSharedText();
    }
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  void pullSharedText();
  void pullDeepLink(); // 回前台也取一次深链接(热启动 emit 可能丢,文件兜底)
  initUpdateThrottled(); // 后台切回也查一次新版(否则只有冷启动才提示;节流)
});
window.addEventListener("zhujian-share", () => void pullSharedText());
window.addEventListener("zhujian-deeplink", () => void pullDeepLink());

// ---- 深链接消费(4c,照抄分享薄桥)------------------------------------------
// zhujian://open?acc=<账户>&item=<条目> | space=<空间>&item=<条目>。take_deep_link 取走
// 原生暂存的 URI → 解析 → 匹本机空间(space= 按 id;acc= 走后端 find_space_by_account,因
// SpaceInfo 不暴露 account_id)→ 若非当前空间先切过去(异步、会停机)→ focusTimelineCard
// 定位高亮。与分享不同,深链接是一次性跳转、不做追加合并,简单 single-flight 去重即可。
// 回收站/归档册的条目 focusTimelineCard 会如实报「已不在」(v1 只覆盖灵感/任务两面)。
type ParsedDeepLink = { acc: string | null; space: string | null; item: string };
function parseDeepLink(raw: string): ParsedDeepLink | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "zhujian:" || u.host !== "open") return null;
  const item = u.searchParams.get("item");
  if (!item) return null;
  return { acc: u.searchParams.get("acc"), space: u.searchParams.get("space"), item };
}

let pullingDeepLink = false;
async function pullDeepLink(): Promise<void> {
  if (pullingDeepLink) return;
  pullingDeepLink = true;
  try {
    const raw = await takeDeepLink();
    if (!raw) return;
    const p = parseDeepLink(raw);
    if (!p) return;
    let target: string | null = null;
    if (p.space) {
      const spaces = await listSpaces();
      target = spaces.find((s) => s.id === p.space)?.id ?? null;
    } else if (p.acc) {
      target = await invoke<string | null>("find_space_by_account", { accountId: p.acc });
    }
    if (!target) {
      showError(t("main.spaceNotOnDevice"));
      return;
    }
    // 切到目标空间(若不同):switchSpace 是异步、有停机,返回即前台 runtime 就绪、
    // switching 已复位——之后再定位,躲开 focusTimelineCard 的 switching 守卫。
    if (target !== getCurrentSpace()) await switchSpace(target);
    await focusTimelineCard(p.item);
  } catch (e) {
    showError(String(e));
  } finally {
    pullingDeepLink = false;
  }
}

// 保存 = 写命令:显式携带「点击那刻看到的空间与 mode」,后端在协调状态内复核(切换中
// 响亮拒、目标已变响亮拒)。**两缓冲**(146 ▲H1▲▲M1,与 145 takeBatch「保存那刻冻结」
// 同律):点「记下」那刻**取走**草稿并清框,在飞期间的新输入/分享追加落进清空后的框
// (liveDraft),与已提交段互不沾染——绝不「保留全文再存一遍」(A 会重复入库)。
// 成功只消费取走的那份;失败放回(有新输入则合并,先写在前)。textarea 是静态节点、
// 从不重建,框内现值即 liveDraft 的单一真相源。刻意不走 sinvoke(§16.2-4)。
// 「记下」按钮禁用态:三根轴任一在飞就禁,**由状态派生**(单一入口免漏一处;此前是
// 逐处传真假,于是每个 finally 都要自己记得别的轴还在不在飞)。
// ⭐ `picking` 那根是用户面 36 加的:屏上摆着 N 个骨架时若还点得动「记下」,takeBatch 只
// 带走**已经有字节的那几张** —— 用户看着三张、实际入库一张,剩下两张悄悄落到下一条。
// ⛔ 那不是「在飞期间新贴的图属于下一条」那条契约管得住的(它管的是 save 往返那一段
// 窗口),是一次**静默的分批**。真机上第一次跑回归网就是这么红的:`记下` 抢在降采样
// 前面,三张只挂上一张。
function refreshSaveDisabled(): void {
  ($("save") as HTMLButtonElement).disabled = switching || captureSaving || picking;
}

// 捕获层(232)收起入口:由下方捕获块赋值,save() 存成功后调它收层露出新卡。
let dismissCapture: (() => void) | null = null;

async function save() {
  const ta = $("text") as HTMLTextAreaElement;
  if (captureSaving || picking) return; // picking:钮此刻是 disabled 的,这条兜非点击的路子
  if (!ta.value.trim()) {
    // 图不能独立成条(条目正文非空):只贴图没写字时给可辨识提示,不静默无反应。
    if (compImgs.count() > 0) showError(t("main.textBeforeImages"));
    return;
  }
  if (cardPanel.hasDirtyDraft()) {
    // ▲▲M3:卡片草稿在场时保存后的 refresh 会被无限延后、新卡落不了 DOM——响亮拒。
    showError(t("main.finishDraftFirst"));
    return;
  }
  const space = getCurrentSpace();
  const mode = viewMode; // 落点冻结在点击那刻,响应回来绝不重读
  const savingDraft = ta.value;
  ta.value = "";
  // 图与文字同刻冻结带走(两缓冲,同 takeBatch):在飞期间新贴的图属于下一条,清预览。
  const savingImgs = compImgs.takeBatch();
  localStorage.removeItem(COMPOSE_DRAFT_KEY); // 文字草稿同刻清(图持久化由 takeBatch 清)
  captureSaving = true;
  captureLiveTouched = false;
  navSeq++; // 作废在途 focus 定位:不许其内部切面打破「新卡在当前面」承诺
  refreshSaveDisabled();
  try {
    const capture = mode === "ideas" ? captureIdea : captureTodo;
    const newId = await capture(space, savingDraft);
    // 条目已建 → 把冻结的暂存图逐张挂上(失败按张计,条目在、图可去卡片「加图」重贴)。
    // 挂完再刷新,新卡带着缩略图一次呈现。
    if (savingImgs.length) {
      const { failed, why } = await compImgs.attachBatch(space, newId, savingImgs);
      // ⛔ why 说得准就**替掉**「可在该卡片『加图』重贴」那句(538,用户面 56):
      // 不支持的格式 / 过大都是确定性拒法,叫用户重贴等于支他去做一件注定失败的事。
      if (failed > 0)
        showError(t("main.imagesNotAttached", { n: failed, hint: why || t("images.retryHint") }));
    }
    // 新卡落 mode 面:清掉该面停留的筛选,免得刚记的记录被藏起(「记了却没出现」的
    // 错觉)。桌面在筛着标签时改为自动挂标签保留可见,安卓这版先取「清筛见新卡」的
    // 简单形(捕获不自动打标签,故没有可保留的标签维度)。
    clearFilter(mode);
    if (!captureLiveTouched) {
      // 在飞期间无新输入:现状回执——收键盘让新卡露出来,滚到顶闪一下
      // (ui-audit P1 #7:原 finally 无条件 ta.focus() 让键盘永不收、新卡被挡)。
      ta.blur();
      dismissCapture?.(); // 收起捕获层(232),露出刚记的新卡
      await refresh();
      const card = document.querySelector<HTMLElement>(`#timeline [data-id="${newId}"]`);
      if (card) {
        window.scrollTo({ top: 0 });
        card.classList.add("flash");
        window.setTimeout(() => card.classList.remove("flash"), 1200);
      }
    } else {
      // 用户正在续打(或分享追加了):不 blur、不抢焦点、不滚动,只刷新列表。
      await refresh();
    }
  } catch (err) {
    showError(String(err));
    // 失败:取走的那份放回。框里有新字就合并(先写的在前),光标置尾接着改。
    const live = ta.value;
    ta.value = live === "" ? savingDraft : `${savingDraft}\n${live}`;
    persistComposeText(); // 退回的文字重新持久化(程序改值不触发 input)
    compImgs.putBack(savingImgs); // 图同样退回预览条,可连同文字一起重试
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  } finally {
    captureSaving = false;
    refreshSaveDisabled();
  }
}
$("save").addEventListener("click", save);

// ---- 悬浮 ＋ 钮 + 底部捕获层(232 优化)--------------------------------------
// 平时零占屏:时间轴干净,只有右下角一颗悬浮 ＋。点 ＋(或任何路径聚焦到输入,如顶栏
// 「一步回捕获」/系统分享)→ 捕获层从屏底滑入。
//
// 键盘避让(232 重做)已上抬成共享件 `src/kbsheet.ts`(314 第③笔:留言层要的是同一套
// 几何,抄第二份必漂移)。那边有全部由头;这里只剩捕获层自己的接线:聚焦输入即开层、
// 不限高。回车仍换行;收层只由遮罩点击/保存成功/返回触发。
// ⭐ 键盘一起视口就真的缩(原生 `applyImeInsets()`),层贴 `bottom:0` 即在键盘上沿 ——
// 此处**不再有**「抢先抬」那类接线。
{
  const sheet = $("compose-card");
  const fab = $("capture-fab");
  const nav = $("bottombar");
  const ta = $("text") as HTMLTextAreaElement;
  const root = document.documentElement;
  const kb = createKbSheet({
    sheet,
    scrim: $("capture-scrim"),
    input: ta,
    openOnFocus: true, // 任何路径聚焦输入都进入捕获态(顶栏「一步回捕获」/系统分享追加)
    onOpen: () => {
      fab.hidden = true;
    },
    onClose: () => {
      // 只收界面;草稿(localStorage)/暂存图(pendingImages)由既有逻辑保留,下次点开还在。
      fab.hidden = false;
    },
  });
  dismissCapture = () => kb.close(); // 供 save() 存成功后收层

  fab.addEventListener("click", () => {
    kb.open();
    ta.focus(); // 键盘自动起
  });
  // 层内按钮不抢输入焦点,免点一下就收键盘、层跳一下。
  ($("save") as HTMLButtonElement).addEventListener("mousedown", (e) => e.preventDefault());
  $("compose-addimg").addEventListener("mousedown", (e) => e.preventDefault());

  // FAB 竖直位置吃底栏实高(含安全区);底栏极少变,稳妥观察。
  function setNavH(): void {
    root.style.setProperty("--nav-h", `${nav.offsetHeight}px`);
  }
  new ResizeObserver(setNavH).observe(nav);
  setNavH();

  // 层内点空白也聚焦输入(此前只有 textarea 本体响);按钮/缩略图不抢。
  sheet.addEventListener("click", (e) => {
    const el = e.target as HTMLElement;
    if (el === ta || el.closest("button") || el.closest(".cthumb")) return;
    ta.focus();
  });
}

// ---- 空间面板(工序 7/8):列表可切、新建、当前空间改名、全部同步 --------------

// 单空间时「空间」概念整个隐藏(116 捕获徽章同源原则):徽章藏起、同步标题不带名,
// 空间面板从同步面底部「空间…」兜底可达;多空间时徽章即入口、兜底收起。三个状态
// 在同一处原子维护,启动时静态 HTML 徽章即 hidden,不闪。
function renderSpaceChip() {
  const cur = spacesCache.find((s) => s.id === getCurrentSpace());
  const single = spacesCache.length <= 1;
  const chip = $("space-chip") as HTMLButtonElement;
  chip.hidden = single;
  chip.textContent = cur ? spaceLabel(cur) : t("api.defaultSpace");
  $("sync-spaces-btn").hidden = !single;
  $("sync-title").textContent = single
    ? t("main.syncTitle")
    : t("main.syncTitleSpaced", { name: cur ? spaceLabel(cur) : t("api.defaultSpace") });
}

function renderSpaceList() {
  const box = $("space-list");
  box.innerHTML = spacesCache
    .map((s) => {
      const label = esc(spaceLabel(s));
      if (s.current && renamingSpace) {
        return `<div class="space-row current">
          <input class="rename" id="space-rename-input" value="${esc(s.name ?? "")}"
                 placeholder="${label}" autocapitalize="off" autocomplete="off" />
          <button class="act" data-rename-ok="1">${t("main.renameOk")}</button>
          <button class="act" data-rename-cancel="1">${t("main.renameCancel")}</button>
        </div>`;
      }
      // 重置两拍确认(epoch-plan §7,multispace §20 门 4 的警告义务):红字说清
      // 「删的是本机副本、须另一台在线完整副本、旧设备身份报运营者吊销」。
      // 确认钮全宽独行、与「取消」拉开(ui-audit P1 #11:别让最重操作挨着毗邻控件)。
      if (resettingSpace === s.id) {
        // 重置话术分流(space-entry-plan §5):已开同步的空间=清本机副本、可重新
        // 加入;仅本机的本子=删除**唯一副本**,不再用「清库重配」安抚。
        const warnText = s.configured ? t("main.resetWarnSynced") : t("main.resetWarnLocalOnly");
        return `<div class="space-row current" data-space="${esc(s.id)}">
          <div style="flex:1">
            <div>${label}</div>
            <div class="tag warn" style="display:block;white-space:normal">${warnText}</div>
            <button class="act warn reset-confirm" data-reset-ok="${esc(s.id)}">${t("main.resetConfirm")}</button>
            <button class="act reset-cancel" data-reset-cancel="1">${t("main.renameCancel")}</button>
          </div>
        </div>`;
      }
      const tag = s.current
        ? `<span class="tag warn">${t("main.tagCurrent")}</span>`
        : s.configured
          ? ""
          : `<span class="tag">${t("main.tagLocalOnly")}</span>`;
      // 「重置」= 删本机全部数据的最重操作,不常驻行上(ui-audit P1 #11):收进「⋯」。
      const act =
        (s.current ? `<button class="act" data-rename="1">${t("main.rename")}</button>` : "") +
        `<button class="act" data-more="${esc(s.id)}" aria-label="${t("main.moreActions")}">⋯</button>`;
      const more =
        spaceMenuFor === s.id
          ? `<div class="space-row sub"><button class="act warn" data-reset="${esc(s.id)}">${t("main.resetEntry")}</button></div>`
          : "";
      return `<div class="space-row${s.current ? " current" : ""}" data-space="${esc(s.id)}">
        <button class="sname" data-switch="${esc(s.id)}">${label}</button>${tag}${act}
      </div>${more}`;
    })
    .join("");
}

async function refreshSpaces() {
  try {
    spacesCache = await listSpaces();
  } catch (err) {
    showError(String(err));
    return;
  }
  renderSpaceChip();
  renderSpaceList();
}

/** 空间切换后的整页重拉(chip/列表/同步状态/时间轴)。幂等,多来一次无害。 */
async function onSpaceChanged() {
  renderSpaceChip();
  // 出码页属于旧空间的会话,切走即失效(旧配对流由 stop→core 收口烧槽)。
  resetSyncTransient();
  await refreshSpaces();
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  await refresh();
}

/** 与后端 foreground 对账:不一致就跟上(后端是权威,§16.2 提案 B)。 */
async function reconcileForeground() {
  try {
    const fg = await invoke<string>("foreground_space");
    if (fg !== getCurrentSpace()) {
      setCurrentSpace(fg);
      blankTimelineForSpaceChange(); // 同 switchSpace:过期 DOM 不许多留一拍
      localStorage.setItem(LAST_SPACE_KEY, fg);
      await onSpaceChanged();
    }
  } catch {
    /* 封锁态/极端错误:保持现状。 */
  }
}

async function switchSpace(id: string) {
  if (switching || captureSaving || id === getCurrentSpace()) return;
  if (cardPanel.hasDirtyDraft()) {
    // 用户主动切换(含新建空间后的自动切)被草稿挡下;后端强制的前台变更走
    // reconcileForeground → blankTimelineForSpaceChange 丢草稿并响一声。
    showError(t("main.finishDraftBeforeSwitch"));
    return;
  }
  switching = true;
  refreshSaveDisabled();
  try {
    await invoke("activate_space", { spaceId: id });
    setCurrentSpace(id);
    blankTimelineForSpaceChange(); // 旧空间 DOM 立即离场,不留可点的过期目标
    localStorage.setItem(LAST_SPACE_KEY, id);
    await onSpaceChanged();
  } catch (err) {
    showError(String(err));
    await reconcileForeground(); // 失败已回滚(§9):对账回真前台。
  } finally {
    switching = false;
    refreshSaveDisabled();
  }
}

// ---- 单一 activePane(120,codex L11):空间/同步/搜索/回收站/归档册/诊断
// 同刻只开一个;开合都过草稿闸(编辑中不许把面从脚下抽走)。 ------------------

const PANE_EL: Record<string, string> = {
  spaces: "spaces",
  sync: "sync",
  search: "search-pane",
  trash: "trash-pane",
  sealed: "sealed-pane",
  topics: "topics-pane",
  settings: "settings-pane",
  diag: "diag",
};
let activePane: string | null = null;

/** 底栏「回收站/归档册」按数据显形(408-A1):两面空则不渲染那枚钮——第一天的底栏
 *  只有「随记/任务」,第一次删除/归档时回执指路、钮随之出现,清空后再隐。真值每轮
 *  refresh 随 pane_counts 更新;初值 false = 未证实有数据就不显(空库首帧不闪)。 */
let paneHas = { trash: false, sealed: false };

/** 底栏高亮的单一渲染点(146 ▲M3):pane 开着高亮 pane 钮,否则高亮当前 mode 钮
 *  ——popstate/closePaneNow 关面后必须回到 mode 高亮,不能清光。显形也收在这里:
 *  该面正开着时钮保显(否则清空回收站的那一刻,高亮着的关面入口凭空消失)。 */
function renderBottomBar() {
  document.querySelectorAll<HTMLButtonElement>("#bottombar button").forEach((b) => {
    const pane = b.dataset.pane;
    if (pane === "trash" || pane === "sealed")
      b.hidden = !paneHas[pane] && activePane !== pane;
    b.classList.toggle(
      "active",
      activePane !== null ? b.dataset.pane === activePane : b.dataset.mode === viewMode,
    );
  });
}

/** 关面回时间轴的 DOM 部分(143 拆出):popstate(返回键)与 UI 关面共用;
 *  history 账目由调用方处置——UI 关面随后 settleHistory(),popstate 已经弹掉。 */
function closePaneNow() {
  // 备份码仪式还开着就让后端把那把**只在内存里**的钥丢掉(盘上此刻什么都没写过 ⇒
  // 下次是干净的首次使用)。⛔ 反过来「先落盘再让用户抄」会留下一把没人抄过的钥。
  if (activePane === "settings") backup.closeBackup();
  activePane = null;
  hideConfirmBar(); // 关面 = 放弃面内挂着的两拍确认(ui-audit P0 #4)
  for (const id of Object.values(PANE_EL)) $(id).hidden = true;
  document.body.classList.remove("pane-open"); // 恢复 compose+时间轴
  renderBottomBar();
}

function openPane(name: string) {
  if (switching || captureSaving) return; // 146 ▲▲M3:切换编排/保存在飞期间面不动
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  if (activePane === name) {
    closePaneNow(); // 再点同一入口 = 收面(toggle)
    settleHistory();
    return;
  }
  const wasOpen = activePane !== null;
  if (activePane === "settings") backup.closeBackup(); // 面换面同理(toggle 那条走 closePaneNow)
  activePane = name;
  hideConfirmBar(); // 面换面:上一面挂着的确认作废
  for (const [key, id] of Object.entries(PANE_EL)) $(id).hidden = key !== name;
  document.body.classList.add("pane-open"); // 开面板接管视图:收 compose+时间轴
  renderBottomBar();
  if (!wasOpen) pushLayer(); // 首层才压守门条目;面换面同层,返回键一次回时间轴
  if (name === "spaces") {
    spaceMenuFor = null; // 重开面板不带上次的「⋯」展开残留
    void refreshSpaces();
  }
  else if (name === "trash") void panes.loadTrash();
  else if (name === "sealed") void panes.loadSealed();
  else if (name === "topics") void topics.loadTopics();
  else if (name === "search") panes.focusSearch();
  else if (name === "settings") {
    paintThemeSeg();
    paintTextSizeSeg();
    paintLangSeg();
    void loadAlias();
    void loadAbout();
    // 备份一节(§17):⛔ 每次开面都重新问一遍状态 —— 回调不是真相源(进程可能在
    // 系统选择器开着的时候被杀,那时挂在 JS 里的 promise 早就没了)。
    backup.loadBackup();
  }
  else if (name === "diag" && !diagLoaded) {
    diagLoaded = true;
    loadDb();
    runProbe();
  }
}

// ---- 主视图切换(146 §2.3 状态机) --------------------------------------------

/** 切面落地:翻 mode → placeholder/底栏高亮 → 投影。快照失效(读失败/清屏中)时
 *  不投影旧数据——错误页/载入页保留,顺手触发一次重试(▲▲M2)。 */
function applyMode(target: ViewMode) {
  viewMode = target;
  ($("text") as HTMLTextAreaElement).placeholder =
    target === "ideas" ? t("main.composeIdeaPh") : t("main.composeTaskPh");
  ($("filter-text") as HTMLInputElement).value = filters[target].text; // 各面记忆自己的过滤词
  renderBottomBar();
  if (lastRefreshOk) projectTimeline();
  else void refresh();
}

/** 底栏 mode 钮:受理条件 !switching && !captureSaving;卡片编辑草稿挡切面
 *  (compose 草稿不挡,随面走);pane 开着=先关面(settleHistory 恰一次,由
 *  openPane 的 toggle 路负责),关面后不自动弹键盘;无 pane 重复点当前面=聚焦
 *  输入框(143「一步回捕获」推广到两面)。 */
function onModeButton(target: ViewMode) {
  if (switching || captureSaving) return;
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  navSeq++; // 用户主动导航:作废在途 focus 定位(▲M2)
  const hadPane = activePane !== null;
  if (hadPane) openPane(activePane!); // toggle 关面(无草稿必然关成)
  if (target === viewMode) {
    if (!hadPane) ($("text") as HTMLTextAreaElement).focus();
    return;
  }
  applyMode(target);
}

/** 空间变化的统一复位(实现审 M5):关全部面、activePane 归零、诊断缓存作废
 *  (diagLoaded 跨空间残留会把 A 空间的库信息端给 B)、低频面内容清空。 */
function resetPanesForSpaceChange() {
  closePaneNow();
  settleHistory(); // 守门条目同轮消掉,不给返回键留「按一下没反应」的空炮
  diagLoaded = false;
  $("db").innerHTML = `<span class="muted">${t("main.diagLoading")}</span>`;
  $("probe").innerHTML = `<span class="muted">${t("main.probeIdle")}</span>`;
  panes.resetPanesForSpaceChange();
  topics.resetTopicsForSpaceChange();
  // 筛选是 A 空间的标签 id/词,绝不带进 B 空间(allFilterTopics 随下轮刷新重取)。
  filters.ideas = { kind: "all", topics: [], text: "" };
  filters.tasks = { kind: "all", topics: [], text: "" };
  taskStageFilter = null;
  allFilterTopics = [];
  ($("filter-text") as HTMLInputElement).value = "";
}

/** 远端变更时活动面也要跟上(实现审 M6):回收站/归档册打开着就重载,不给
 *  幽灵条目;搜索维持「显式点搜」契约不自动重跑。 */
function refreshActivePane() {
  if (activePane === "trash") void panes.loadTrash();
  else if (activePane === "sealed") void panes.loadSealed();
  // 标签面:拖动/类型编辑进行中不被动重载(免把正在操作的行从脚下拆掉),空闲才重读。
  else if (activePane === "topics" && !topics.topicsInteracting()) void topics.loadTopics();
  cardPanel.onRemoteChanged(); // tags 面的标签集标脏重读
}

/** 搜索命中活跃条目:收面 + 按条目 stage 切到它住的面(146 起灵感/任务分面)+ 滚到
 *  那张卡并闪一下(定位,不自动开操作面板——与桌面「跳看板高亮」同一克制)。
 *  codex H3:草稿在场时 openPane 会拒绝关面(卡还盖着,滚下去看不见),故先响亮拒、不跳。
 *  codex H4:目标可能还没进 timeline DOM——关面后先 await refresh() 把快照刷到最新再找;
 *  仍找不到(归档/入册/删的窄窗)响亮提示、不静默吞。
 *  ▲M2:内部为定位切面不作废自己;用户点 mode 钮/开始保存(navSeq++)则作废本次定位。 */
let focusSeq = 0;
async function focusTimelineCard(id: string) {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  const space = getCurrentSpace();
  const seq = ++focusSeq;
  const nav = navSeq;
  if (activePane) openPane(activePane); // 发起面本身无草稿,必然关成
  await refresh(); // 快照刷到最新,避免目标卡尚未落 DOM 就判"找不到"
  // await 期间用户可能切空间 / 再点定位 / 手动切面或保存(navSeq)/ 开别的面 / 进编辑 /
  // 正切换编排(codex 二审 H2 + ▲▲M3):任一发生就放弃这次旧定位,让最新动作赢。
  if (
    seq !== focusSeq ||
    nav !== navSeq ||
    space !== getCurrentSpace() ||
    switching ||
    captureSaving ||
    activePane !== null ||
    cardPanel.hasDirtyDraft()
  ) {
    return;
  }
  if (!lastRefreshOk) {
    showError(t("main.timelineRetry")); // 读失败 ≠ 条目已离开,别误报
    return;
  }
  const item = lastItems.get(id); // 全量真值:住哪个面由 stage 定(穷尽映射)
  if (!item) {
    showError(t("main.itemGone"));
    return;
  }
  const target = modeOfStage(item.stage);
  if (target === "tasks" && taskStageFilter !== null && item.stage !== taskStageFilter) {
    // 定位目标被状态维藏着:这一维自己清自己(标签/文本维的既有行为不动,单轮单件事)。
    taskStageFilter = null;
    if (viewMode === "tasks") projectTimeline();
  }
  if (target !== viewMode) applyMode(target); // 快照有效,applyMode 同步投影
  const card = document.querySelector<HTMLElement>(`#timeline [data-id="${id}"]`); // ULID 仅字母数字,选择器安全
  if (!card) {
    showError(t("main.itemGone"));
    return;
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  card.classList.add("flash");
  window.setTimeout(() => card.classList.remove("flash"), 1200);
}

// 点头部「朱简」= 回时间轴(143):面板开着就收面,和「再点一次入口」同一条 toggle 路。
document.querySelector("header h1")!.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#space-chip")) return; // chip 自己开空间面板
  if (activePane !== null) openPane(activePane);
});
$("space-chip").addEventListener("click", () => openPane("spaces"));
$("sync-spaces-btn").addEventListener("click", () => openPane("spaces"));
$("topics-toggle").addEventListener("click", () => openPane("topics"));
$("search-toggle").addEventListener("click", () => openPane("search"));
// 文本过滤(常驻框,不随 pills 重建):输入即筛,走 projectTimeline 单一渲染路径。
// 卡片编辑草稿在场时不受理(重投影会拆掉草稿)——把框回退到已存值、响一声,不静默毁稿。
// 去抖(§2.4 `INPUT_DEBOUNCE`,两端同值):投影虽是纯客户端(无 IPC,比桌面轻一档),
// 但中文 IME 组合期每次候选变化都触发 input,几百张卡上每击键 innerHTML 全量重建 +
// thumbObserver 重挂是白付的抖动。照桌面 filter-bar 的两条边界:模块态 `filters[].text`
// **当场**写(切视图恢复靠它,不能等窗口闭合);迟到的定时器只是对当前态多投影一次,无害。
let filterTextTimer: number | undefined;
$("filter-text").addEventListener("input", () => {
  const input = $("filter-text") as HTMLInputElement;
  if (cardPanel.hasDirtyDraft()) {
    input.value = filters[viewMode].text;
    showError(t("main.finishDraftFirst"));
    return;
  }
  filters[viewMode].text = input.value;
  window.clearTimeout(filterTextTimer);
  filterTextTimer = window.setTimeout(projectTimeline, INPUT_DEBOUNCE_MS);
});
$("bottombar").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("#bottombar button");
  if (!btn) return;
  if (btn.dataset.pane) openPane(btn.dataset.pane);
  else if (btn.dataset.mode) onModeButton(btn.dataset.mode as ViewMode);
});
$("settings-toggle").addEventListener("click", () => openPane("settings"));
$("settings-diag-btn").addEventListener("click", () => openPane("diag"));

// 明暗三档(250):点哪档写哪档,高亮回来按当前档整排重画(单一渲染点,不在点击处
// 各自 toggle);立刻生效,没有确认也没有回执——手势即回执,整屏换色就是最大的回执。
$("theme-seg").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-mode]")?.dataset
    .themeMode;
  if (!m) return;
  setThemeMode(m as ThemeMode);
  paintThemeSeg();
});

function paintThemeSeg() {
  const now = currentThemeMode();
  $("theme-seg")
    .querySelectorAll<HTMLButtonElement>("[data-theme-mode]")
    .forEach((b) => b.classList.toggle("on", b.dataset.themeMode === now));
}

// 界面字号(251):与明暗三档同形——点哪档写哪档,整排按当前档重画;立刻生效,
// 全屏文字变大就是回执。
$("textsize-seg").addEventListener("click", (e) => {
  const raw = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-textsize]")?.dataset
    .textsize;
  if (!raw) return;
  setTextSize(Number(raw) as TextSize);
  paintTextSizeSeg();
});

function paintTextSizeSeg() {
  const now = String(currentTextSize());
  $("textsize-seg")
    .querySelectorAll<HTMLButtonElement>("[data-textsize]")
    .forEach((b) => b.classList.toggle("on", b.dataset.textsize === now));
}

// 语言三档(358 第②笔):同上两排的形,只是回执不同——生效语言真变了就 reload
// (i18n.ts 里判),此时整页换文案就是回执;auto↔解析同语言时页面不动,只刷高亮。
$("lang-seg").addEventListener("click", (e) => {
  const c = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-lang]")?.dataset.lang;
  if (!c) return;
  setLangChoice(c as LangChoice);
  paintLangSeg();
});

function paintLangSeg() {
  const now = currentLangChoice();
  $("lang-seg")
    .querySelectorAll<HTMLButtonElement>("[data-lang]")
    .forEach((b) => b.classList.toggle("on", b.dataset.lang === now));
}

// ---- 本机别名(identity-plan §2.4)------------------------------------------------
//
// 与外观 / 字号的关键差别:**别名进同步**(和空间名同族),那两样是设备环境属性。
// 别搞混——这也是它下面那句说明里「同步」二字加粗的原因。

/** 面板里的「已保存值」影子:同值不发命令(后端也是 no-op),失败回退到它。 */
let aliasSaved = "";
/** 本机 device_id,由 loadAlias 落下。null = 还没取到 → 整行禁用,保存路径直接不走
 *  (**不在保存时再查一次**:那是第二次往返,还给「查到的是切走后那个空间」留了口子)。 */
let aliasDevice: string | null = null;

/** 开设置面时回填。**取不到就整行禁用,不编造占位值**(design-rules:绝不回退兜底)。 */
async function loadAlias() {
  const input = $("alias-input") as HTMLInputElement;
  const save = $("alias-save") as HTMLButtonElement;
  const msg = $("alias-msg");
  msg.hidden = true;
  input.disabled = true;
  save.disabled = true;
  aliasDevice = null;
  const space = getCurrentSpace();
  try {
    const d = await deviceIdentity(space);
    if (space !== getCurrentSpace()) return; // 迟到响应:切走了就不动这个面
    aliasDevice = d.this_device;
    aliasSaved = d.devices.find((x) => x.device_id === d.this_device)?.alias ?? "";
    input.value = aliasSaved;
    // 没起名时,id 前 6 位是这台设备唯一能自证身份的东西。**卡片上刻意不显 id 片段**
    // (那是噪音),但这里的语境正是「这是哪台」,显它才有用。
    input.placeholder = t("main.aliasUnnamed", { id: d.this_device.slice(0, 6) });
    input.disabled = false;
    save.disabled = false;
  } catch (e) {
    showAliasMsg(String(e), true);
  }
}

function showAliasMsg(text: string, bad: boolean) {
  const msg = $("alias-msg");
  msg.textContent = text;
  // 红字走 .warn-ink 类(样式住样式层,门禁看得见);默认色由 .fine 自己给。
  msg.classList.toggle("warn-ink", bad);
  msg.hidden = false;
}

async function saveAlias() {
  const input = $("alias-input") as HTMLInputElement;
  const save = $("alias-save") as HTMLButtonElement;
  const device = aliasDevice;
  if (device === null) return; // 身份没取到:整行本就禁用,这里是第二道
  const next = input.value.trim();
  if (next === aliasSaved) {
    $("alias-msg").hidden = true;
    return;
  }
  const space = getCurrentSpace();
  save.disabled = true;
  try {
    // 空串 = 清名(后端 trim 后为空即落 null,显式清名是规范表示)。
    await setDeviceAlias(space, device, next === "" ? null : next);
    aliasSaved = next;
    input.value = next;
    input.blur(); // 收键盘,给一个「这一笔完了」的手势回执(ui-guidelines:手势即回执)
    showAliasMsg(next === "" ? t("main.aliasCleared") : t("main.aliasSaved"), false);
  } catch (e) {
    input.value = aliasSaved; // 后端拒了(超长等):回显旧值 + 后端原话
    showAliasMsg(String(e), true);
  } finally {
    save.disabled = false;
  }
}

$("alias-save").addEventListener("click", () => void saveAlias());
$("alias-input").addEventListener("keydown", (e) => {
  if ((e as KeyboardEvent).key === "Enter") {
    e.preventDefault();
    void saveAlias();
  }
});

$("space-list").addEventListener("click", async (e) => {
  const el = e.target as HTMLElement;
  const sw = el.closest<HTMLElement>("[data-switch]")?.dataset.switch;
  if (sw && sw !== getCurrentSpace()) {
    spaceMenuFor = null;
    await switchSpace(sw);
    return;
  }
  if (el.dataset.more) {
    // 「⋯」开合重置入口(P1 #11);重开即收上一行的,恒最多一行展开。
    spaceMenuFor = spaceMenuFor === el.dataset.more ? null : el.dataset.more;
    resettingSpace = null;
    renderSpaceList();
    return;
  }
  if (el.dataset.reset) {
    resettingSpace = el.dataset.reset; // 第一拍:亮红字确认,不动数据。
    renamingSpace = false;
    spaceMenuFor = null;
    renderSpaceList();
    return;
  }
  if (el.dataset.resetCancel) {
    resettingSpace = null;
    renderSpaceList();
    return;
  }
  if (el.dataset.resetOk) {
    const id = el.dataset.resetOk;
    resettingSpace = null;
    try {
      await invoke("reset_space", { spaceId: id });
      showError(t("main.spaceReset"));
      resetSyncTransient(); // 重置空间的恢复码/出码页等一次性展示随之作废。
      await reconcileForeground(); // 前台可能已落回 main(后端广播为准,这里对账兜底)。
      await refreshSpaces();
    } catch (err) {
      showError(String(err));
      await refreshSpaces();
    }
    return;
  }
  if (el.dataset.rename) {
    renamingSpace = true;
    spaceMenuFor = null; // 进改名态顺带收「⋯」,改完/取消不回弹重置入口(codex L)
    renderSpaceList();
    ($("space-rename-input") as HTMLInputElement | null)?.focus();
    return;
  }
  if (el.dataset.renameCancel) {
    renamingSpace = false;
    renderSpaceList();
    return;
  }
  if (el.dataset.renameOk) {
    const name = ($("space-rename-input") as HTMLInputElement).value.trim();
    if (!name) {
      showError(t("main.spaceNameRequired"));
      return;
    }
    try {
      await invoke("rename_space", { spaceId: getCurrentSpace(), name });
      renamingSpace = false;
      await refreshSpaces();
    } catch (err) {
      showError(String(err));
    }
  }
});

$("space-create").addEventListener("click", async () => {
  // 草稿闸前置(实现审 M4):创建+自动切换是不可拆的一体动作,后端调用之前就拒
  // ——否则建出一个用户并不想留的空空间、切换又被草稿挡下,现场撕裂。
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  const input = $("space-new-name") as HTMLInputElement;
  const name = input.value.trim();
  if (!name) {
    showError(t("main.spaceNamePrompt"));
    return;
  }
  const btn = $("space-create") as HTMLButtonElement;
  btn.disabled = true;
  try {
    const id = await invoke<string>("create_space", { name });
    input.value = "";
    await refreshSpaces();
    // 创建在途期间用户可能又开了编辑(三审 M4 的 TOCTOU 窗口):切换会被草稿闸
    // 或并发切换挡下——只有真切过去了才说「已创建并切换」,否则如实分开说。
    await switchSpace(id); // 创建即切过去——新本子即建即用,人就该在那个空间里。
    if (getCurrentSpace() === id) {
      showBar(t("main.spaceCreated"), true);
    } else {
      showBar(t("main.spaceCreatedNoSwitch"), true);
    }
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
  }
});

// 全部同步(§7 lean-B):有界 best-effort;结果只显「试了 N 个」,绝不显「全部完成」。
const OUTCOME_LABEL: Record<string, string> = {
  boot_completed: t("main.outcomeBootCompleted"),
  connected: t("main.outcomeConnected"),
  no_boot_peer: t("main.outcomeNoBootPeer"),
  timed_out: t("main.outcomeTimedOut"),
  failed: t("main.outcomeFailed"),
  cancelled: t("main.outcomeCancelled"),
};

$("sync-all-btn").addEventListener("click", async () => {
  const btn = $("sync-all-btn") as HTMLButtonElement;
  const box = $("sync-all-result");
  btn.disabled = true;
  box.textContent = t("main.syncAllRunning");
  try {
    const report = await invoke<SyncAllReport>("sync_all_spaces");
    const outcomes = report.outcomes;
    if (!outcomes.length) {
      // 「全部同步」只遍历开了同步的空间——纯本地本子被跳过是预期(space-entry-plan §5)。
      box.textContent = t("main.syncAllNoSpaces");
    } else {
      const progressed = outcomes.filter((o) => o.progressed).length;
      const lines = outcomes
        .map((o) => {
          const label = esc(spaceLabel({ id: o.space, name: o.name }));
          const verdict = OUTCOME_LABEL[o.outcome] ?? o.outcome;
          const detail = o.detail ? `:${esc(o.detail)}` : "";
          return `<div>${label} — ${verdict}${o.progressed ? t("main.syncAllProgressed") : ""}${detail}</div>`;
        })
        .join("");
      const restore = report.restore_error
        ? `<div class="warn-ink">${t("main.syncAllRestoreError", { error: esc(report.restore_error) })}</div>`
        : "";
      box.innerHTML = `<div>${t("main.syncAllSummary", { n: outcomes.length, progressed })}</div>${lines}${restore}`;
    }
    await reconcileForeground();
    await refresh(); // 前台空间在遍历期间可能收到过草稿保存,重拉一次。
  } catch (err) {
    showError(String(err));
    box.textContent = "";
    await reconcileForeground();
  } finally {
    btn.disabled = false;
  }
});

void listen<{ space: string; done: number; total: number }>("sync-all-progress", (e) => {
  $("sync-all-result").textContent = t("main.syncAllProgress", { done: e.payload.done, total: e.payload.total });
});

// ---- 诊断面(P4-b 收编:打开才读库、才跑网络闸门;120 起入口在底部工具行) -----

let diagLoaded = false;

async function loadDb() {
  const box = $("db");
  try {
    const d = await sinvoke<DbInfo>("db_info");
    const rows: [string, string][] = [
      ["SQLite", d.sqlite_version],
      ["journal_mode", d.journal_mode],
      [t("main.diagMigration"), String(d.user_version)],
      ["device_id", d.device_id],
      [t("main.diagItems"), String(d.items)],
      [t("main.diagPath"), d.path],
    ];
    box.innerHTML = rows
      .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`)
      .join("");
  } catch (e) {
    box.innerHTML = `<span class="v warn-ink">${t("main.diagDbFailed", { error: esc(String(e)) })}</span>`;
  }
}

async function runProbe() {
  const btn = $("run") as HTMLButtonElement;
  const box = $("probe");
  const url = ($("url") as HTMLInputElement).value.trim();
  btn.disabled = true;
  box.innerHTML = `<span class="muted">${t("main.probeRunning")}</span>`;
  try {
    const steps = await invoke<ProbeStep[]>("net_probe", { url });
    box.innerHTML = steps
      .map(
        (s) => `<div class="step ${s.ok ? "ok" : "fail"}">
          <span class="mark">${s.ok ? "✓" : "✗"}</span>
          <span class="name">${esc(s.name)}</span>
          <span class="detail">${esc(s.detail)}</span>
        </div>`,
      )
      .join("");
  } catch (e) {
    box.innerHTML = `<span class="v warn-ink">${t("main.probeFailed", { error: esc(String(e)) })}</span>`;
  } finally {
    btn.disabled = false;
  }
}
$("run").addEventListener("click", runProbe);

// ---- 关于(250):这台机上装的是哪一版。手机端此前没处看版本号,排查问题第一句总是
// 「你手机上是几点几」;版本取自 tauri.conf.json,与更新清单 android.json 同源。
async function loadAbout() {
  const box = $("about");
  try {
    const v = await getVersion();
    box.innerHTML =
      `<span class="k">${t("main.aboutVersion")}</span><span class="v">v${esc(v)}</span>` +
      `<span class="k">${t("main.aboutSite")}</span><span class="v">zhujian.app</span>`;
  } catch (e) {
    box.innerHTML = `<span class="v warn-ink">${t("main.aboutFailed", { error: esc(String(e)) })}</span>`;
  }
}

// ---- 半自动更新(106):启动静默查 + 后台切回再查(149 后用户点名),有新版出提示条 ----

// ⚠ 类型与那条 invoke 一起住在平台接缝 `platform.ts` 里(OH-d/D3):鸿蒙那端没有更新通道。

// 检查会被反复触发(启动 + 每次回前台),按钮监听只在模块加载挂一次、经这两个
// 模块态取当前值;「以后再说」按 versionCode 记账,同一版本本会话内不再打扰
// (进程被杀重开自然复位=旧「重启才再提示」语义不变)。
let updateFound: MobileUpdate | null = null;
let updateDismissedCode = 0;

// 更新说明值不值得显(296):空的不显;只是把版本号又说一遍的也不显——历史发版的
// notes 恒是 CI 写死的「朱简安卓版 vX.Y.Z」,显出来就是紧挨着「有新版 v0.3.22」
// 再重复一次。剥不干净(将来换了措辞)就照显:宁可多显一行,不可把真说明吞掉。
// ⚠ 与桌面 `src/update.ts::meaningfulNotes` 同一份判据,两端是独立工程,改一处要同改。
export function meaningfulNotes(notes: string | undefined, version: string): string {
  const s = (notes ?? "").trim();
  if (!s) return "";
  const residue = s
    .replaceAll("朱简", "")
    .replaceAll("安卓版", "")
    .replaceAll(version, "")
    .replace(/[\sv·、,，。:：\-—]/g, "");
  return residue === "" ? "" : s;
}

async function initUpdate() {
  lastUpdateCheckedAt = Date.now();
  try {
    const u = await checkUpdate();
    if (!u || u.versionCode === updateDismissedCode) return;
    updateFound = u;
    $("update-msg").textContent = t("main.updateFound", { version: u.version });
    const notes = meaningfulNotes(u.notes, u.version);
    $("update-notes").textContent = notes;
    $("update-notes").hidden = notes === "";
    $("update").hidden = false;
  } catch {
    /* 离线/端点不可达:静默,下次回前台/启动再查。 */
  }
}

// 回前台查更新的节流:短时间内反复切前后台只查一次,不空转 android.json。
const UPDATE_CHECK_THROTTLE_MS = 10 * 60 * 1000;
let lastUpdateCheckedAt = 0;
function initUpdateThrottled() {
  if (Date.now() - lastUpdateCheckedAt < UPDATE_CHECK_THROTTLE_MS) return;
  void initUpdate();
}
$("update-go").addEventListener("click", () => {
  if (!updateFound) return;
  void openUrl(updateFound.url).catch((err) => showError(String(err)));
});
$("update-later").addEventListener("click", () => {
  $("update").hidden = true;
  if (updateFound) updateDismissedCode = updateFound.versionCode;
});

// 远端变更 → 去抖刷新时间轴(追赶期一批 op 一次重画)+ 活动面跟上(实现审 M6)。
let refreshTimer: number | undefined;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => {
    void refresh();
    refreshActivePane();
  }, 200);
}

// 事件桥统一信封(工序 8):按 space+generation 过滤(acceptSpaced)——非当前
// 空间(「全部同步」遍历期间的临时 session)与迟到代次一律丢弃。
void listen<Spaced<unknown>>("sync-changed", (e) => {
  if (!acceptSpaced(e.payload)) return;
  refreshSoon();
});
// 空间名变了(本地改名/远端改名落地/引导落名/全部同步收尾兜底;space-name-sync-plan
// §4.7):刻意**不按 space+generation 过滤**——名字挂 chip/空间列表层,任何空间的
// 改名都要刷。先经 `rescan_spaces` 串行重扫 catalog(list_spaces 读内存快照,不重扫
// 白刷;重扫在命令面做,桥里并发重扫有旧快照后写竞态——codex 实现审 H1)。
// 失败不静默吞(codex 二轮 M1):有界重试一次(3s),再失败响亮提示——名字已落库,
// 只是列表刷新失败,下次事件/动作再追。
async function rescanThenRefreshSpaces(retryLeft: number): Promise<void> {
  try {
    await invoke("rescan_spaces");
  } catch (err) {
    if (retryLeft > 0) {
      window.setTimeout(() => void rescanThenRefreshSpaces(retryLeft - 1), 3000);
      return;
    }
    showError(t("main.spaceRenamedRefreshFailed", { error: String(err) }));
    return;
  }
  await refreshSpaces();
}
void listen("space-name-changed", () => {
  void rescanThenRefreshSpaces(1);
});
void listen<Spaced<string>>("sync-toast", (e) => {
  if (!acceptSpaced(e.payload)) return;
  showBar(e.payload.payload, true);
});
// 后端 foreground 变更(切换成功/失败回滚/遍历恢复)——先立代次水位(同空间
// 重激活后,旧桥 buffer 里还没吐完的旧代次事件从此被拒,工序 7/8 二审 L1;
// generation=0 表示代次未知,只对账不立水位),再对账跟上。
void listen<{ space: string; generation: number }>("space-foreground", (e) => {
  const { space, generation } = e.payload;
  if (generation > (seenGeneration[space] ?? 0)) seenGeneration[space] = generation;
  void reconcileForeground();
});
// 配对落库(本窗发起的在 doJoin 里已处理;这里兜底刷新列表的 configured 标)。
void listen<string>("space-configured", () => void refreshSpaces());

// ---- 卡片操作面板 + 低频面接线(120) -----------------------------------------

cardPanel.initCardPanel({
  getItem: (id) => lastItems.get(id),
  refresh,
  // 草稿收场(保存/取消/被迫丢弃):把被草稿保护延后的那轮刷新补上。
  onDraftClosed: () => {
    if (refreshDeferred) {
      refreshDeferred = false;
      void refresh();
    }
  },
  isSwitching: () => switching,
  // 「记下」在飞(146 ▲▲M3):面板整体禁点——尤其不得进入 edit/tags 草稿态,
  // 否则保存后的 refresh 被草稿闸无限延后、新卡落不了 DOM。
  isCaptureSaving: () => captureSaving,
  // 移动入口按空间数决定是否出现;picker 列其他空间(main.ts 的 spacesCache 影子)。
  getSpaces: () => spacesCache,
  openComments: openCommentsFor,
});
// 留言层(314 第③笔):写/删成功即整轴重拉(徽章计数跟着走),开合各压/平一枚返回键守门条目。
initComments({ refresh, pushLayer, settleHistory });
// 大图查看器(310 第③笔):返回键层账本仍住 main.ts,经 Deps 注入(留言层同形)。
initViewer({ pushLayer, settleHistory, refresh });
// 同步面(310 第③笔):接线即挂全部监听(面内控件 + sync-status/sync-boot/sync-pair/
// join-progress)——本调用在模块体同一同步 tick 内、先于任何事件派发,启动期事件不丢;
// acceptSpaced 账本与空间切换编排仍住 main.ts,经 Deps 注入。
initSync({
  openPane,
  acceptSpaced,
  getSpaces: () => spacesCache,
  refreshSpaces,
  switchSpace,
  hasDirtyDraft: () => cardPanel.hasDirtyDraft(),
});
initCardSwipe({
  getItem: (id) => lastItems.get(id),
  getCurrentSpace,
  isSwitching: () => switching,
  hasDirtyDraft: () => cardPanel.hasDirtyDraft(),
  refresh,
});
panes.initPanes({ refreshTimeline: refresh, focusCard: focusTimelineCard, showPane: openPane });
topics.initTopicsPane({ refreshTimeline: refresh, isSwitching: () => switching });

// ---- 启动闸(工序 6)+ 上次空间恢复(工序 8) --------------------------------

// 安卓首启偶发:前端 bundle 执行(void init())时 WebView 的 IPC 桥可能还没接好,
// 发出的**首个 invoke 会被丢弃**、promise 永不 settle,前端就永远卡在「正在检查
// 本机空间…」——startup_gate 只 clone managed Gate,「重启即好」正是时序不同躲过
// 了这个窗口(132 观察债)。startup_gate 幂等,故超时或出错就重发;装配(含前滚
// 升级)在后端 blocking worker 上跑,`pending` 期间轮询等待(codex 设计审 H4);
// 封锁由 `blocked` 状态作**返回值**携带(不是抛异常),不会被重试逻辑吞掉。
type GateStatus =
  | { status: "pending" }
  | { status: "ready" }
  | {
      status: "blocked";
      kind: "upgrade-required" | "retryable" | "repair-required" | "reset-required";
      message: string;
    };

async function resolveStartupGate(): Promise<GateStatus & { status: "blocked" } | null> {
  const TIMEOUT_MS = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      const timedOut = Symbol("timeout");
      const r = await Promise.race([
        invoke<GateStatus>("startup_gate"),
        new Promise<typeof timedOut>((res) => setTimeout(() => res(timedOut), TIMEOUT_MS)),
      ]);
      if (r !== timedOut) {
        const g = r as GateStatus;
        if (g.status === "ready") return null;
        if (g.status === "blocked") return g;
        // pending:装配还在跑(可能正在升级数据格式),提示后继续轮询。
        if (attempt >= 3) $("gate-checking").textContent = t("main.gatePreparing");
        await new Promise((res) => setTimeout(res, 150));
        continue;
      }
    } catch {
      // manage(Gate) 之前的窗口会抛「state not managed」:歇一下重发,不当封锁。
    }
    if (attempt >= 3) $("gate-checking").textContent = t("main.gateRetrying");
    await new Promise((res) => setTimeout(res, 150));
  }
}

async function init() {
  // 明暗三档(250):首帧定色已由 index.html 头里的内联脚本做掉,这里只接上「自动」档
  // 对系统的跟随。放在启动闸之前——封锁页也得是用户选的那个色。
  initTheme();
  // 界面字号(251):首帧应用同样已由内联脚本做掉,这里兜同一规则(幂等)。
  initTextSize();
  // 471(用户面 33):**这一端没有的桥,静态壳里对应那几块整个摘掉**。⛔ 不是禁用、更不是
  // 留着让它点了高亮却什么也不动(469 在鸿蒙真机上量到的正是后者 = 界面在说谎),也不是
  // 留着几句只有另一端才成立的说明(471 真机上第二眼看见的那三句备份脚注)。
  // ⚠ 放在启动闸之前:这些都是静态壳的一部分,摘早不摘晚(晚一帧就是"闪一下才消失")。
  // ⭐ 加新的桥专属 UI 时:元素上挂 data-needs="<桥名>",然后在这张表里加一行。
  for (const [need, has] of [["textzoom", HAS_TEXT_ZOOM], ["saf", HAS_SAF_BRIDGE]] as const) {
    if (has) continue;
    document.querySelectorAll<HTMLElement>(`[data-needs="${need}"]`).forEach((e) => (e.hidden = true));
  }
  // 语言(358 第②笔):壳里保留中文原文防首帧闪(163 契约),这里按生效语言统一
  // 覆写静态文案 + 落 <html lang>。放在启动闸之前——封锁页也要说用户那门语言。
  initLang();
  applyStaticI18n();
  // 先用空缓存画一次空间入口(按单空间态:chip 藏、兜底「空间…」显)——否则首次
  // list_spaces 失败时 chip 与兜底都停在静态 hidden,空间面板整个不可达(codex 必修 3)。
  renderSpaceChip();
  const blocked = await resolveStartupGate();
  if (blocked !== null) {
    // 封锁处置按 kind 四分流(codex 设计审 H3 + 实现审 H1):只有 reset-required
    // 才出现「清除数据」;升级/重试/修复三页都明示「不要清除数据」。
    $("gate-checking").hidden = true;
    const pane =
      blocked.kind === "upgrade-required"
        ? "upgrade"
        : blocked.kind === "retryable"
          ? "retry"
          : blocked.kind === "repair-required"
            ? "repair"
            : "reset";
    $(`gate-msg-${pane}`).textContent = blocked.message;
    $(`gate-${pane}`).hidden = false;
    $("gate-blocked").hidden = false;
    return; // gateBlocked 保持 true
  }
  gateBlocked = false;
  $("gate").hidden = true;
  // 草稿断电恢复(197 下一步①):闸放行即回填 compose 上次没记下的文字 + 暂存图。
  // 先于下方 pullSharedText——冷启动被分享拉起时,分享文本追加在已恢复的草稿之后。
  const draftText = localStorage.getItem(COMPOSE_DRAFT_KEY);
  if (draftText) ($("text") as HTMLTextAreaElement).value = draftText;
  void compImgs.restore();
  // 上次空间恢复(设备本地 UI 记忆,与桌面 zhujian.last-space 同哲学):后端启动
  // 恒在 main,记忆指向别的空间就切过去;失效记忆清掉。
  await refreshSpaces();
  const last = localStorage.getItem(LAST_SPACE_KEY);
  if (last && last !== getCurrentSpace()) {
    if (spacesCache.some((s) => s.id === last)) {
      await switchSpace(last);
    } else {
      localStorage.removeItem(LAST_SPACE_KEY);
    }
  }
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  void pullSharedText();
  void pullDeepLink(); // 冷启动:被 zhujian:// 链接拉起时取走暂存的 URI 并定位(空间已恢复后)
  void initUpdate();
  void refresh();
}

void init();
