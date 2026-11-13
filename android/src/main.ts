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
  addTaskTopic,
  captureIdea,
  captureTodo,
  deviceIdentity,
  setDeviceAlias,
  editNote,
  fileNoteToTopic,
  renameTask,
  listBoardColumns,
  listBoards,
  listSpaces,
  listTimeline,
  sealedCountsByBoard,
  listTasks,
  listTopicsFull,
  sealDoneTasks,
  spaceLabel,
  unsealTask,
  type SealedCount,
  type SearchHitItem,
  type SpaceInfo,
  type TaskItem,
  type TimelineItem,
} from "./api";
import {
  $,
  actionBar,
  cardTint,
  confirmBar,
  colsFor,
  contentHtml,
  dayKey,
  dayLabel,
  esc,
  fmtTimeOfDay,
  fmtWhen,
  hideConfirmBar,
  dismissStickyConfirm,
  dropErrorBar,
  markHits,
  markLocated,
  showBar,
  showError,
  showUndone,
  splitCols,
} from "./ui";
import { errDetail, errText, initErr, showErr } from "./err";
import { toggleChecklistLine } from "../../shared/checklist";
import { buildStamp, formatBuiltAt } from "../../shared/build-stamp";
import { applyChecklistMarker, dropEmptyChecklistItems, wireChecklistNewline } from "./checklist-input";
import {
  HOLDING,
  boardColumns,
  boardName,
  boardOfStage,
  currentView,
  defaultBoard,
  holdingCount,
  holdingLabel,
  isDoneStage,
  isHeldStage,
  isTaskStage,
  liveBoards,
  setBoards,
  setColumns,
  setCurrentView,
  stageLabel,
  switcherShown,
  viewId,
  type Board,
} from "./columns";
import { initTaskMove, inView } from "./taskmove";
import { initBoardScroll, restoreBoardScroll, scrollByFor } from "./boardscroll";
import { initChromeHide, showChrome, syncPeek } from "./chromehide";
import { capturePhoto, composeImages, compressImagesOn, PICK_MAX, pickImages, setCompressImages } from "./images";
import { INPUT_DEBOUNCE_MS } from "./timing";
// **平台接缝**(OH-d/D3):只在安卓壳里存在的那三条命令。鸿蒙那端由 vite 换成另一份实现。
import { HAS_BROWSER, HAS_NOTIFICATION, HAS_SAF_BRIDGE, HAS_TEXT_ZOOM, notifyPermissionGranted, notifyPermissionOk, takeDeepLink, takeSharedText, writeClipboard } from "./platform";
// **渠道接缝**(651):这份包发给谁 —— 鸿蒙那端同样由 vite 换成国内渠道那份。
import { checkUpdate, PRIVACY_URL, SITE_URL, SYNC_DEFAULT_URL, type MobileUpdate } from "./channel";
import { initDueReminder, reminderCfg, saveReminderCfg, sendTestNotification } from "./reminder";
import * as backup from "./backup";
import * as cardPanel from "./cardpanel";
import * as filter from "./filter";
import * as panes from "./panes";
import * as topics from "./topics";
import { closeDocs, docsAtLanding, docsBack, focusDoc, initDocs, openDocs, reloadDocs, resetDocsForSpaceChange, startDocFrom } from "./docs";
import { initCardSwipe } from "./swipe";
import { skewAsk } from "./skewask";
import { initCardDrag, isDragging } from "./carddrag";
import { loadIdentity, signatureFor } from "./identity";
import { createKbSheet, type KbSheet } from "./kbsheet";
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
import { closeEditSheetNow, initEditSheet, isEditSheetDirty, isEditSheetOpen, saveEditSheet } from "./editsheet";
import { closeDatePickNow, initDatePick, isDatePickOpen } from "./datepick";
import { closeMoreSheetNow, initMoreSheet, isMoreSheetOpen } from "./moresheet";
import { disconnectThumbObserver, fillThumb, hydrateThumbs } from "./thumbs";
import { onFoldClick, resettleFolds, settleFolds } from "./fold";
import { closeViewerNow, initViewer, isViewerOpen, openLocalViewer, openViewer } from "./viewer";
import {
  configuredServer,
  currentGone,
  dismissScanOverlay,
  forgetGone,
  goneSpaces,
  initSync,
  isBooting,
  prefillServer,
  pruneGone,
  renderSync,
  resetJoinForm,
  resetSyncTransient,
  type Spaced,
  type SyncStatus,
} from "./sync";
import { repaintDevices, rosterIds, shortIds } from "./devices";
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
/** 改名没成(159 / W3 A11,WD-08):框里留着刚打的字(`draft`),框下一行红字说为什么(`msg`,如「已有同名空间「…」」)
 *  —— 此前走顶部错误条、还带「出错:」。null = 没有挂着的错。行重画(远端刷新空间列表)也照它画回,字不丢。 */
let spaceRenameErr: { draft: string; msg: string } | null = null;
let resettingSpace: string | null = null; // 空间面板「重置」两拍确认中的行(epoch-plan §7)
let spaceMenuFor: string | null = null; // 空间行「⋯」展开态(ui-audit P1 #11:重置入口降权)

// ---- 主视图 mode(146):灵感/任务两面 = 同一条 live_timeline 的投影 ----------
// lastItems 恒存全量(卡片面板真值、跨面定位查 stage 都靠它),渲染按 mode 过滤;
// mode 从不压 history 层(不是层),启动恒落灵感面、不持久化。

type ViewMode = "ideas" | "tasks";
let viewMode: ViewMode = "ideas";
/** 每一面「上一发是不是筛着的 + 进筛选前读到的滚动位」(157 G4 / P11)。 */
const filterScroll: Record<ViewMode, { was: boolean; y: number }> = { ideas: { was: false, y: 0 }, tasks: { was: false, y: 0 } };
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
// (任务面专属)、切空间清零;新任务落面时随 settleFilterAfterSave 一并归零(免得新卡被藏)。
let taskStageFilter: string | null = null;
// 任务面的到期维(用户面 60-D,对齐桌面 502 顶栏那枚汇总钮):true = 只看今天到期与逾期
// 的任务。⛔ 同 taskStageFilter 刻意不进 filter.ts 的 FilterState(桌面这一维也长在
// board.ts 自己身上、不在共享件里);应用在共享 applyFilter 与状态维之后。
// **纯视野状态,不落 localStorage**(同桌面:重开就回全部)——它答的是「此刻我在看什么」,
// 不是设备偏好。切空间清零、记新任务清零、定位被它藏着时自己清自己。
let dueOnly = false;
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
const compImgs = composeImages($("compose-thumbs"), (items, idx) => void openLocalViewer(items, idx), true);
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
// 562:回车续待办项 +「＋ 待办」起一条。⛔ 那枚钮不进 `captureSaving/switching` 那道闸——
// 它只改框里的字、不打后端,锁定期照样该让人接着打(与「记下」「加图」性质不同)。
wireChecklistNewline($("text") as HTMLTextAreaElement);
$("compose-todo").addEventListener("click", () => applyChecklistMarker($("text") as HTMLTextAreaElement));
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

// 条目 → 它住哪一面。⭐ 0042 起按 core 给的**主归属** `kind` 判(longform-plan §1:随记 / 长文 /
// 任务的优先级只在 core 定义一处,带着 doc_at 的任务行归任务),⛔ 别再凭 stage 推「非任务就是
// 随记」—— 那样长文会混进随记面。长文不在时间轴上画,住「长文」面(docs.ts)。
// 未知值响亮抛(铁律:不写兜底)。
function homeOf(it: TimelineItem): ViewMode | "docs" {
  if (it.kind === "task") return "tasks";
  if (it.kind === "idea") return "ideas";
  if (it.kind === "doc") return "docs";
  throw new Error(`未知主归属:${String(it.kind)}`);
}

// 任务面的分组 = **当前空间真实的那几列**(B-f 第 1 段起从库里来;此前是四值字面量)。
// 序 = core 按 position 排好的序;空组不显;组内沿时间倒序 —— 手机不读 position、不做拖排,
// 组内时间序是本端自己的确定性顺序(146 §2.1)。
// ⚠ 0043 起已删但还扣着卡的列**不再**留在看板上,统一进收容区(multiboard-plan §3a;切换那排末尾那一枚)。
// 0043(multiboard-plan §6 第 4 段):只画**当前那块看板**的列;看着收容区时 = 收容区那几列,节头说来处。
const taskSections = (view: BoardView | null): { stage: string; label: string }[] => {
  if (view === null) return [];
  const held = view === HOLDING;
  return boardColumns(view).map((c) => ({ stage: c.id, label: held ? holdingLabel(c.id) : stageLabel(c.id)! }));
};
/** 看板与列这一轮落定了没有(切空间到新数据到达之间是空的 ⇒ 当前看板答不上,任务面一节都不分)。 */
const boardsReady = (): boolean => liveBoards().length > 0;
type BoardView = Board | typeof HOLDING;
/** 这一次投影画的是哪块看板(任务面 ∧ 看板已落定;否则 null)。mbopt M14:**每次投影只解析一次**(currentView 要读 localStorage
 *  再滤一遍看板),往下传给分节 / 筛选条 / 切换排;此前一次重画要解析七回左右。⛔ 只在 projectTimeline 里写。 */
let shownView: BoardView | null = null;
/** 横滚位置按「空间 + 看板」记的那枚身份串(boardscroll.ts;mbopt M4)。随 shownView 一起写。 */
let shownBoardKey = "";

/** 这次「记一笔」/ ＋ 在任务面上落哪块看板(plan §6 第 4 段:此刻看着的那块;看着收容区 ⇒ 默认看板)。 */
const composeBoard = (view: BoardView): Board => (view === HOLDING ? defaultBoard() : view);

/** 任务面上新卡放不进去的原因(mbopt R2):要落的那块看板落点 ⊥(core 解析:只剩完成列 / 一列都没有)⇒ 一句话;
 *  放得进 / 不在任务面 / 看板还没落定 = null。⇒ ＋ 与「记下」**事前**灰掉并说这句,⛔ 别等打完字才让 core 拒。 */
function landingBlocked(): string | null {
  if (viewMode !== "tasks" || shownView === null) return null;
  const b = composeBoard(shownView);
  return b.landing === null ? t("boards.noLanding", { board: boardName(b) }) : null;
}

// 优先级角标的三档词(1..3;下标 0 恒不取——priority 有值才画这枚 chip)。
// ⚠ 库里存 1/2/3,3 = **高** / 2 = 中 / 1 = 低(506 起一度是 P0 / P1 / P2 记号,903 用户拍换回)。
const PRIORITY_LABEL: Record<number, string> = {
  1: t("main.prioLow"),
  2: t("main.prioMid"),
  3: t("main.prioHigh"),
};

// 截止日期相对表达(抄桌面 src/tasktime.ts 的 dueState/dueLabel 算法,两端不共享代码——
// 同 PRIORITY_LABEL 那行既有的形)。今天/逾期用朱砂强调追平桌面看板「一眼看出」的效果;
// 完成态的视觉降噪交给 CSS 的 `.card.done .chip.due`(同 `.pill` 那条已有的做法),这里
// 不用管 done。
function localToday(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
type DueState = "overdue" | "today" | "future";
function dueState(due: string, today: string): DueState {
  if (due < today) return "overdue";
  if (due === today) return "today";
  return "future";
}
/** 两个 `YYYY-MM-DD` 之间差几个日历日(due − today),走 UTC 午夜算 —— 夏令时永不多算
 *  少算一天。与桌面 `dayDiff` 逐字同形。 */
function dayDiff(due: string, today: string): number {
  const [ay, am, ad] = due.split("-").map(Number);
  const [by, bm, bd] = today.split("-").map(Number);
  return Math.round((Date.UTC(ay, am - 1, ad) - Date.UTC(by, bm - 1, bd)) / 86_400_000);
}
/** 与桌面 dueLabel 逐字同形的相对表达;7 天外退化成 `M/D`(不翻译,数字两端通用)。
 *  `done`(158 G3 / Q4):已完成的卡不说「逾期 / 今天 / N 天后」,只留截止那天的 `M/D`(灰,CSS 那条)。 */
function dueLabel(due: string, today: string, done = false): string {
  const [, am, ad] = due.split("-").map(Number);
  if (done) return `${am}/${ad}`;
  const diff = dayDiff(due, today);
  if (diff === 0) return t("main.dueToday");
  if (diff === 1) return t("main.dueTomorrow");
  // 158 G3 / Q13(WD-34):逾期一天也说「逾期 1 天」—— 此前说「昨天」,与别处「逾期 N 天」不是一个口径。
  if (diff < 0) return t("main.dueOverdueDays", { n: -diff });
  if (diff <= 7) return t("main.dueInDays", { n: diff });
  return `${am}/${ad}`;
}

/** 「这条算不算进『今天该处理什么』」——与桌面 `dueAttentionState` 逐字同形:完成的任务
 *  恒不算(即使当初设过如今已过去的截止日,556-G 那条裁决)。⛔ 与卡片自己那颗 due chip
 *  的口径**刻意不同**:那颗答的是「这条哪天到期」这件事实,完成与否是另一回事,历史信息
 *  留着;「要不要吓人 / 算不算数」的地方才用这个。 */
function dueAttentionState(it: { stage: string; due_on: string | null }, today: string): DueState | "none" {
  if (isDoneStage(it.stage) || !it.due_on) return "none"; // 0043:按卡所在看板解析后的完成列判(plan §6)
  return dueState(it.due_on, today);
}

/** 「逾期 M · 今天 N」/「今天到期 N」—— 与桌面 `dueSummaryLabel` 逐字同形(那边这句还喂着
 *  每日提醒通知;这一端今天没有通知那条路)。调用方保证 late+now > 0。 */
function dueSummaryLabel(late: number, now: number): string {
  return late > 0 ? t("main.dueSoonLate", { late, now }) : t("main.dueSoonToday", { now });
}

/** 「快到期」的窗口 —— 与桌面 `DUE_SOON_DAYS` 同值(两端不共享代码,同 dueState 那一族的
 *  既有形);屏上那句话里的天数由它注入,⛔ 别在字典里写死。 */
const DUE_SOON_DAYS = 3;

/** 这条算不算「快到期」:未完成 · 有截止日 · 落在今天之后的 `DUE_SOON_DAYS` 天内。
 *  与桌面 `isDueSoon` 逐字同形,⛔ 同样刻意不做成 `DueState` 的第五档(那个枚举喂着卡片
 *  那颗 due chip 的上色,加一档会让 chip 跟着变脸)。 */
function isDueSoon(it: { stage: string; due_on: string | null }, today: string): boolean {
  if (dueAttentionState(it, today) !== "future") return false;
  return dayDiff(it.due_on as string, today) <= DUE_SOON_DAYS;
}

/** 汇总钮的整句 —— 在 `dueSummaryLabel` 之上再挂一段「{days} 天内 {n}」。与桌面
 *  `dueSummaryFullLabel` 逐字同形。调用方保证 late+now+soon > 0。 */
function dueSummaryFullLabel(late: number, now: number, soon: number): string {
  if (late + now === 0) return t("main.dueSoonNextOnly", { n: soon, days: DUE_SOON_DAYS });
  const head = dueSummaryLabel(late, now);
  return soon === 0 ? head : `${head} · ${t("main.dueSoonNext", { n: soon, days: DUE_SOON_DAYS })}`;
}

// ---- 统一时间轴 -------------------------------------------------------------

// hideTopic:恰好单选一枚标签筛选时,卡上那枚同名 chip 是纯冗余(筛出来的卡本就都带它),
// 直接不渲染(同桌面 218 灵感侧;安卓 chip 无拖拽去重等 DOM 依赖,面板真值走 lastItems)。
// underDayHead:这张卡挂在日期节头下面(随记时间轴)⇒ 时间戳只报时刻,别把节头那句再说一遍。
// ⛔ 只有随记面传 true —— 回收站与搜索是平铺的,那儿的卡必须保留完整日期(同桌面 inbox.ts
//    「想法 sits in a per-day timeline → time-of-day only; 回收站 is flat → full stamp」)。
function renderCard(it: TimelineItem, hideTopic: string | null, underDayHead = false): string {
  // 906(用户拍「卡片左边…那么丑,要做」):任务卡左边那枚勾完成的圆圈撤了 —— 「完成」是操作面第一层最前面那一枚
  // (cardpanel.ts renderActions,出现条件 = 原来画圆圈的条件),正文左缘与随记卡同一条线。已完成的卡在正文前带一枚朱砂 ✓
  // (index.html `.card.done .content::before`,同桌面看板完成列);挪回去走操作面的「列」那枚。
  const done = isDoneStage(it.stage);
  // ⛔ 卡上不再盖状态印(用户面 85 ④ / ui-consistency M10):任务面**恒按状态分段**
  // (projectTimeline 里每段头上就是 `stageLabel` 那一行),每张卡再印一遍等于把节头说第二遍;
  // 随记面上没有任务卡。状态改挂在 `data-stage` 上给工装认(swipe-undo 那支资产读它),
  // ⚠ 回收站 / 搜索结果那两枚 `.pill`(panes.ts)头上没有节头,不是冗余,别一起摘。
  const chips = it.topics
    .filter((t) => t.id !== hideTopic)
    .map(
      (t) =>
        `<span class="chip topic${t.color ? " tinted" : ""}"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
    )
    .join("");
  // 配图缩略(117):只渲染占位框,字节滚到可视区才拉(thumbObserver)。
  // 只读缩略图(点开看大图)。删图钮不在这儿——它挪进了编辑面(674:进编辑态才露删 ×),
  // 故此处不渲 `.thumb-del`,只读态永远不显删钮。
  const thumbs = it.images.length
    ? `<div class="thumbs">${it.images
        .map(
          (im) =>
            `<button class="thumb" data-img="${esc(im.id)}" data-seq="${im.seq}"
               aria-label="${t("main.viewImage", { n: im.seq })}"><span class="tag-n">${t("images.imageN", { n: im.seq })}</span></button>`,
        )
        .join("")}</div>`
    : "";
  // 120:data-id 供卡片操作面板定位;截止/优先级角标(任务行、有值才显)。截止追平桌面
  // 看板:相对日期文字 + 今天/逾期朱砂强调,不再是原始 ISO 串。
  const meta: string[] = [];
  if (it.due_on) {
    const today = localToday();
    // 已完成的卡(158 G3 / Q4):不带今天 / 逾期那档色,字也只留日期 —— 做完了的事不该还挂着「逾期」吓人。
    const st = done ? "past" : dueState(it.due_on, today);
    meta.push(`<span class="chip due ${st}" title="${esc(it.due_on)}">${dueLabel(it.due_on, today, done)}</span>`);
  }
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
  // ⭐ **先一律夹住、落 DOM 后再量**(projectTimeline 末尾的 settleFolds):夹子对短卡是空
  // 操作 ⇒ 量出来没夹到东西的当场摘掉,屏上与从前逐字同形、也不长钮。⛔ 反过来「先摊开、
  // 量完再夹」会让长卡首帧闪一下全文。⛔ 方框那条豁免不在这儿判,它要的是**夹后几何**。
  // 157 G4 / P13 起随记面也折(同八行):走查量到一张长随记就占半屏,滚过它得划两三下(WM-20 / WD-34)。
  // 此前「只夹任务面」的理由(随记是单列流水、长卡不挡别的卡)被用户推翻。
  const clamp = " clamped";
  const tint = cardTint(it.color);
  return `<article class="card${done ? " done" : ""}${tint.cls}"${tint.attr} data-id="${esc(it.id)}" data-stage="${esc(it.stage)}"><div class="body">
    <p class="content${clamp}">${contentHtml(it.content, true)}</p>${thumbs}
    <footer><time>${esc(underDayHead ? fmtTimeOfDay(it.created_at) : fmtWhen(it.created_at))}</time>${sig}${
      // 161 / W4 Q16(WP-24):来源挨着时间、「改过」放在它后面 —— 此前「06:00 改过 · zjd2」,「改过」紧挨着别人的名字,
      // 容易读成那台改的(其实名字是谁建的;谁改的不存,不做)。
      it.revised ? `<span class="edited-mark">${t("cardpanel.editedMark")}</span>` : "" /* 157 G4 / P5 */
    }${doneAt}${cmBadge}${meta.join("")}${chips}</footer>
  </div></article>`;
}

// ---- 长卡折叠(用户面 116,承桌面 704):159 起住 `fold.ts`(回收站 / 搜索两面也折)------------

// 随记在宽屏上分栏(docs/tablet-plan.md 格 1;用户 2026-09-30 拍「瀑布流 · 横三竖二」)。
// 栏数按**时间轴自己的宽**算,那组数(每栏下限 / 栏间距 / 最多几栏)住在 ui.ts::colsFor,回收站 / 归档 / 搜索三个面也吃它
// (tablet-plan 格 5)—— 1 栏时画出来的标记与分栏之前逐字相同。
let noteCols = 1;
function measureNoteCols(): number {
  const w = timelineW();
  // 面板开着时时间轴 display:none,量出来是 0 ⇒ 沿用上一次(关面那一下 ResizeObserver 会再量)
  if (w === 0) return noteCols;
  return colsFor(w);
}

/** 时间轴里卡片能占的宽 = 盒宽扣掉左右内边距(手机横放给悬浮 ＋ 让的那条右边距在里头,A48)。面板开着时是 0。 */
function timelineW(): number {
  const tl = $("timeline");
  const w = tl.clientWidth;
  if (w === 0) return 0;
  const cs = getComputedStyle(tl);
  return w - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
}

// 手机横放给悬浮 ＋ 让一条右边距(165 / W5 A48;CSS 与由头见 index.html `body.fab-gutter`)。只在宽屏、不是高屏(= 手机横放那 360–412 高)
// 时让,且只在让了之后栏数不变时让:宽 720–770 的横放让了就从两栏掉成一栏,那种照旧不让。判据只看时间轴的**盒宽**(`clientWidth`
// 含内边距,让不让都是同一个数)⇒ 打上类、内边距变了、ResizeObserver 再来一趟,答案不变,不自激。
// ⚠ 64 与 index.html 那条 `padding-right` 同一个数,改一处就得改另一处。
const FAB_GUTTER = 64;
const boardFit = (w: number): number => Math.max(1, Math.floor((w + BOARD_COL_GAP) / (BOARD_COL_MIN + BOARD_COL_GAP)));
function syncFabGutter(): void {
  const w = $("timeline").clientWidth;
  if (w === 0) return; // 面板开着:沿用上一次(时间轴不在屏上,＋ 也藏着)
  const b = document.body.classList;
  const short = b.contains("widescreen") && !b.contains("tallscreen");
  const on = short && (viewMode === "ideas" ? colsFor(w) === colsFor(w - FAB_GUTTER) : boardFit(w) === boardFit(w - FAB_GUTTER));
  b.toggle("fab-gutter", on);
}

/** 「现在是不是宽屏」—— 读 CSS 算出来的结果(index.html `:root` 的 `--wide`,由「宽屏」那段 `@media` 翻)。
 *  ⛔ 别在这儿再写一遍 720(tablet-plan:断点只写在 CSS 一处)。getComputedStyle 答的是此刻的布局 ⇒
 *  转屏、分屏拖宽窄之后再问,拿到的就是新答案。 */
const isWide = (): boolean => getComputedStyle(document.documentElement).getPropertyValue("--wide").trim() === "1";
/** 「此刻的视口是不是高屏」(宽屏且高 ≥ 600)—— 同 isWide,读 `--tall`。⛔ 别在这儿写 600。
 *  ⚠ 答的是**此刻的视口**:键盘起着时它会说「不是」;要窗口高的那个答案看 `body.tallscreen`(下面键盘那段打)。 */
const isTall = (): boolean => getComputedStyle(document.documentElement).getPropertyValue("--tall").trim() === "1";

// 宽屏看板每列多宽(tablet-plan 格 2;889 起「一排 + 横滚 + 每列自滚」,此前是 ③A「放不下就均匀折成几排」)。每列不窄于
// BOARD_COL_MIN(≈ 手机屏宽:卡片与操作面都是按手机宽做的);屏上放得下 k 列就把宽平分给 k 列、恰好露 k 列,多出来的
// 往右排、横滚看(按列对齐)。结果写进 `--board-col-w`,排法本身在 index.html「看板」那段。
// ⚠ BOARD_COL_GAP 与看板那排的 gap 12 是同一个数,改一处就得改另一处。
const BOARD_COL_MIN = 300;
const BOARD_COL_GAP = 12;
/** 放不下全部列时右边露出的下一列那截(含列间距之外的部分;889)。 */
const BOARD_PEEK = 24;
/** 只有一列的看板:那一列限宽、在看板里居中(mbopt M12;同桌面 board.css `.cols.single` 与归档册的 560,用户 2026-11-11 拍)。 */
const BOARD_SOLO_MAX = 560;
/** 屏上现在是不是看板(= 任务面 ∧ 宽屏)= body 上那枚 `board` 类(index.html「看板」那段全挂在它上面)。
 *  只由 projectTimeline 投影时写;时间轴的 ResizeObserver 拿它比「宽窄翻了没有」。 */
const boardShown = (): boolean => document.body.classList.contains("board");
function syncBoardCols(): void {
  const box = $("timeline");
  const w = timelineW();
  const n = box.querySelectorAll(":scope > .tl-group").length;
  box.classList.toggle("solo", n === 1); // 居中靠 CSS(index.html「看板」那段)
  // 面板开着时时间轴 0 宽、空态那句话没画列:都沿用上一次(关面那一下 ResizeObserver 会再算)
  if (w === 0 || n === 0) return;
  if (n === 1) {
    box.style.setProperty("--board-col-w", `${Math.min(w, BOARD_SOLO_MAX)}px`);
    syncBoardTop();
    return;
  }
  const k = Math.min(n, boardFit(w));
  // 放不下全部列时,让下一列在右边露出至多 BOARD_PEEK 那一截:不露的话平板竖放恰好两整列,看不出右边还有列可滑。
  // 列数优先 —— 只拿 k 列各取下限之后剩下的那点宽,不为了露这一截少放一整列(960 竖放三列只剩 8,就不露)。
  const peek = k < n ? Math.max(0, Math.min(BOARD_PEEK, w - BOARD_COL_MIN * k - BOARD_COL_GAP * (k - 1))) : 0;
  // 向下取整:小数宽累加起来可能比框宽多出零点几。
  box.style.setProperty("--board-col-w", `${Math.floor((w - peek - BOARD_COL_GAP * (k - 1)) / k)}px`);
  syncBoardTop();
}
/** 看板上沿离页顶多远 → `--board-top`(看板高 = 视口扣掉它与屏底留白,index.html「看板」那段)。上面那几样(顶栏、
 *  「空间已不在」条、筛选条连同各自的外边距)高度都会变,CSS 写不死 ⇒ 量。重投影、时间轴变宽窄、顶栏 / 筛选条变高时各量一次。
 *  不自激:写它只改时间轴的高,上沿不动。面板开着(时间轴不在屏上)/ 不是看板时不量,沿用上一次。 */
function syncBoardTop(): void {
  const box = $("timeline");
  if (!boardShown() || box.clientWidth === 0) return;
  // 扣掉此刻的上外边距:顶栏收着时(890)看板借了一个负的上外边距,收 / 露那 0.2 s 里它还在过渡 —— 直接量盒的上沿会量到
  // 半路的位置(890 第一版就这么把看板高算成 329、整页多滚一截)。扣掉之后量的恒是它在流里本来的上沿。
  const top = `${box.getBoundingClientRect().top + window.scrollY - parseFloat(getComputedStyle(box).marginTop)}px`;
  if (box.style.getPropertyValue("--board-top") !== top) box.style.setProperty("--board-top", top);
}

// 随记时间轴:同一天的卡归到一个日期节头下(用户面 86)。
// ⚠ **假定 items 已按 created_at 倒序**(后端保证,与平铺那版吃的是同一个序)⇒ 顺着扫、
//   `dayKey` 一变就起新段:不重排、不建索引,卡与卡之间的先后逐条与从前相同。
// ⛔ 别改成「先 group 再 sort」——那会引进一个本来不存在的排序真相源。
// 宽屏分栏分两种日子(tablet-plan 格 1 / 1b):
//  - **大日子**(条数 ≥ 栏数):节头横跨整排,组内**轮流分栏** —— 第 i 张进第 i % n 栏,栏里紧挨着往下排 ⇒ 最新的仍在
//    左上、没有「长卡旁边空一块」;点开一张只推它自己那栏(789 那版按行对齐,同一排另一张跟着留白)。
//  - **小日子**(条数 < 栏数)**连成一段**,整块(节头 + 它那几张卡)落进这一段里**条数最少**的那栏(一样少就靠左)。
//    1b 的由头:格 1 只有前一种,而真库里一两条的日子占多数(用户库 23 个日子里 15 个只有一条)—— 一条的日子
//    只能进第一栏,横放右半屏整片空着;截图台的数据全是「今天」一个日子,照不出来。
// ⛔ 别改成「放进当前最矮的一栏」:那要先量高,而缩略图晚到、折叠、操作面展开都会改高 ⇒ 卡会在栏间跳来跳去;
//   这里只看序号与条数,同一批数据恒排成同一个样子(节头按半张卡记,只为别让一串单条的日子全挤进同一栏)。
// 1 栏(手机竖放)时画出来的标记与分栏之前逐字相同;大日子的标记与 1b 之前逐字相同。
function renderDayGroups(items: TimelineItem[], hideTopic: string | null): string {
  const n = (noteCols = measureNoteCols());
  const days: { head: string; cards: string[] }[] = [];
  let key: string | null = null;
  for (const it of items) {
    const k = dayKey(it.created_at);
    if (k !== key) {
      days.push({ head: `<h3 class="tl-sec">${esc(dayLabel(it.created_at))}</h3>`, cards: [] });
      key = k;
    }
    days[days.length - 1].cards.push(renderCard(it, hideTopic, true));
  }
  const section = (d: { head: string; cards: string[] }, body: string) => `<section class="tl-group">${d.head}${body}</section>`;
  const flow = (c: string[][]) => `<div class="tl-cols tl-flow">${c.map((x) => `<div class="tl-col">${x.join("")}</div>`).join("")}</div>`;
  if (n === 1) return days.map((d) => section(d, d.cards.join(""))).join("");
  const out: string[] = [];
  let run: typeof days = [];
  const flush = () => {
    if (!run.length) return;
    const c: string[][] = Array.from({ length: n }, () => []);
    const load: number[] = Array(n).fill(0);
    for (const d of run) {
      const i = load.indexOf(Math.min(...load));
      c[i].push(section(d, d.cards.join("")));
      load[i] += d.cards.length + 0.5;
    }
    out.push(flow(c));
    run = [];
  };
  for (const d of days) {
    if (d.cards.length < n) {
      run.push(d);
      continue;
    }
    flush();
    out.push(section(d, splitCols(d.cards, n)));
  }
  flush();
  return out.join("");
}

// 时间轴最新一次渲染的条目快照(卡片操作面板的真值来源;refreshOnce 每轮重建)。
let lastItems = new Map<string, TimelineItem>();
/** 任务的看板手动序(id → 名次),同 lastItems 一起在成功读取后更新(157 G4 / P3)。 */
let taskOrder = new Map<string, number>();
/** 同一份看板手动序的全量列表(id + 列;含被筛掉的)—— 挪卡撤销回原位(taskmove.ts)与长按拖的落点都按它算。 */
let boardOrder: { id: string; stage: string }[] = [];

// ---- 返回键层账本(143):安卓返回键的第一本能是「关掉当前层」,此前直接退 app。
// WryActivity 内建「WebView 有历史先 goBack」,故开层(面板/大图)pushState 压一枚
// 守门条目,返回键触发 popstate 时关最上层;UI 主动关层则补一记 history.back() 把
// 守门条目消掉(popSuppress 标记让 popstate 只记账不再关层),账本与屏幕恒一致。
let histDepth = 0;
// ⭐ 滚动位归我们自己管(79,真机 A/B 量出来的):浏览器的「历史条目自动恢复滚动位」在这
// 本账上只会捣乱 —— 这里的 history 条目全是**守门层**(面板 / 大图 / 仪式),不是「另一个
// 页面」,给它们各自存一个滚动位没有任何意义。而 `settleHistory()` 那记 `history.back()`
// 一弹,浏览器就把守门条目上存的那个数(0)贴回来,**把 closePaneNow 刚还原好的位置冲掉**。
// vivo/Android 16 实测:关面同步读到的是 1200(我们写进去的),400ms 后变 0;
// 同一段脚本把这一行的值换成 `manual`,400ms 后仍是 1200。⇒ 两档只差这一个字。
history.scrollRestoration = "manual";
// popSuppress 兼任「back 在飞」标志(146 ▲▲M4):settleHistory 发出的 history.back()
// 到对应 popstate 之间,histDepth 还没递减——这段窗口内再调 settleHistory 会看着
// histDepth>0 又 back 一次(双弹)。settle 只在无 back 在飞时发;窗口内的开层请求
// DOM 照开、pushState 挂账(deferredLayers),popstate 收口后补压——账本与屏幕恒一致,
// 绝不让 pushState 与 back 乱序。
let popSuppress = 0;
let deferredLayers = 0;

// ⭐ 「搜索 → 结果」这一跳(159 / W3 A3,WM-02):此前从搜索结果点进一条,搜索面关掉时把守门条目一起平了,
// 落点上再按一次返回 = 无层可关 = 整个 app 退到手机桌面。现在:点结果时**只收搜索面的 DOM、守门条目留着**,
// 它从此代表「回到搜索结果」这一层;落点上按返回弹掉它 ⇒ 收落点那一面(若落在长文 / 回收站 / 归档册)、重开搜索面
// (词、结果、滚动位都在,A17)。不论落点是时间轴还是某一面,这一整段**只占一枚**守门条目(⛔ 别给落点那一面再压一枚:
// 用户从落点直接点别处走掉时,一次 settleHistory 只平得掉一枚,多压的那枚就成了「按一下没反应」的空炮)。
// 落点之上再开的层(大图 / 编辑 / 留言 / 记一笔)照旧各压各的,先收它们。
// 用户自己走开了(底栏换面、开别的面、切空间、点通知)= 不再回搜索:那枚条目要么被这次走开平掉,要么转给新开的面用。
// null = 当前不在「从搜索跳来」的状态;id = 落点那一条(长文落点要据它认「还在不在落点那一页」)。
let searchReturn: { id: string; parents: { name: string; y: number }[] } | null = null;

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
  // 政策全文那一页(161 / W4 A11,WM-07):盖在一切之上(首启告知、设置「关于」都开它),返回键先收它、回到开它的那一页。
  // 它**不压守门条目**(同扫码层):首启告知那会儿账本还没开张,压了反而多一枚「按一下没反应」的空炮。
  // 框里切页签是把那一份**写进**框里、框从不导航(showPolicyPage 那段)⇒ 点过「用户协议」也是一下就回。
  if (!$("policy-view").hidden) {
    closePolicy();
    return true;
  }
  if (document.body.classList.contains("scanning")) {
    dismissScanOverlay(); // 扫码层收掉(UI 收尾不等插件),下面的面板/时间轴原地不动
    return true;
  }
  // 878:sticky 的确认条(混版提醒)不会自己收 ⇒ 返回键先收它(= 先不用、不记),下面的层原地不动。它不压守门条目(同扫码层)。
  if (dismissStickyConfirm()) return true;
  // 挂账层必须先于「在飞合并」判(codex 终局审 M1):deferredLayers 只在
  // popSuppress>0 窗口内产生,后判就永远够不着——「UI 关层 back 在飞→重开层→
  // 硬件返回」会被合并吞掉、重开的层却还开着。挂账层没有已压的历史条目,直关销账。
  if (deferredLayers > 0) {
    if (isViewerOpen()) closeViewerNow();
    else if (isDatePickOpen()) closeDatePickNow();
    else if (isMoreSheetOpen()) closeMoreSheetNow();
    else if (isEditSheetOpen()) {
      if (isEditSheetDirty()) {
        saveEditSheet(); // 157 G4 / P1:离开 = 保存;存成了宿主照常收层销账,存不成层与挂账都留着
        return true;
      }
      dismissEditSheet();
    } else if (captureOpen) closeCaptureNow();
    else if (isCommentsOpen()) closeCommentsNow();
    else if (activePane === "docs" && !atSearchLanding() && docsBack()) return true; // 面里回上一页:面还开着,挂账照留
    else if (paneStack.length > 0 && activePane !== null) {
      backToParentPane(); // 子页回上一层(A11):面还开着,挂账照留
      return true;
    } else {
      const fromPane = activePane !== null;
      if (fromPane) closePaneNow();
      settleHistory(); // 销挂账(settleHistory 首分支),不发 back
      if (searchReturn !== null) backToSearch(fromPane); // 挂着的那枚就是「回搜索」那一层(A3)
      return true;
    }
    settleHistory(); // 销挂账(settleHistory 首分支),不发 back
    return true;
  }
  if (nativeBackPending || popSuppress > 0) return true; // back 在飞:合并
  if (histDepth > 0) {
    nativeBackPending = true;
    history.back();
    return true;
  }
  // 无层可关:卡片操作面还展开着就先收它(157 G1①;它不压守门条目,理由在 cardpanel.backOut)。
  if (cardPanel.backOut()) return true;
  // 158 G3 / Q8(WM-12):任务面上筛着东西 ⇒ 这一下先清筛选,再按才离开 app(此前筛着「读书」+ 过滤词
  // 按返回直接退到桌面,拉起来还筛着)。同操作面那条:不压守门条目,只在「无层可关」这一支问。
  return clearTaskFiltersByBack();
};

/** 返回键清任务面筛选(Q8):清了返回 true(本次返回已消费)。有卡片草稿时不动(重投影会拆草稿),放它走老路。 */
function clearTaskFiltersByBack(): boolean {
  if (activePane !== null || viewMode !== "tasks" || !lastRefreshOk) return false;
  if (!filter.filterActive(filters.tasks) && taskStageFilter === null && !dueOnly) return false;
  if (cardPanel.hasDirtyDraft()) return false;
  filters.tasks = { kind: "all", topics: [], text: "" };
  taskStageFilter = null;
  dueOnly = false;
  const ft = $("filter-text") as HTMLInputElement;
  ft.value = "";
  ft.blur();
  projectTimeline();
  showBar(t("main.filtersClearedByBack"), true);
  return true;
}

// 点截止提醒通知(158 G3 / Q10,WM-09):进任务面、只看到期(= 汇总钮按下那一态:逾期 + 今天 + 3 天内,
// 按截止升序,逾期最久的在最前 —— 与通知那句话数的是同一批)。其余筛选清掉,别让通知报的数在屏上少几张。
// 开着面板就收面;开着编辑 / 留言 / 大图 / 记一笔这些层、或有卡片草稿时不动(那是正在做的事,别被一条通知拽走)。
window.addEventListener("zhujian-notif-tap", () => {
  if (switching || captureSaving || !lastRefreshOk) return;
  if (cardPanel.hasDirtyDraft() || isViewerOpen() || isEditSheetOpen() || isDatePickOpen() || isMoreSheetOpen() || captureOpen || isCommentsOpen()) return;
  navSeq++; // 作废在途的定位(同主动导航)
  if (activePane !== null) {
    closePaneNow();
    settleHistory();
    searchReturn = null; // 那枚「回搜索」条目(若有)刚被上一行平掉
  } else dropSearchReturn(); // 被通知拽走了:不再回搜索(A3)
  filters.tasks = { kind: "all", topics: [], text: "" };
  taskStageFilter = null;
  dueOnly = true;
  if (viewMode !== "tasks") applyMode("tasks");
  else {
    ($("filter-text") as HTMLInputElement).value = "";
    projectTimeline();
  }
  window.scrollTo({ top: 0 });
});

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
  // 政策全文那一页开着时**也会走到这里**(161 / W4 A11,V1986A / WebView 156 真机量的):底下有守门条目(设置面开着)时,
  // 按返回键是 WebView **自己**在整页会话历史里后退 —— 原生那条 `__zhujianHandleBack` 根本没被问到(页内插桩:只见 popstate、
  // 不见入口被调),弹掉的是底下那一面的守门条目,于是政策页还盖着、设置面先没了。⇒ 这里同样先收政策页,
  // 把刚被弹掉的那枚守门条目补压回去(底下那一面还开着)。没有守门条目时(首启告知)WebView 退无可退,才轮到原生入口那一支。
  if (!$("policy-view").hidden) {
    closePolicy();
    pushLayer();
    return;
  }
  if (isViewerOpen()) {
    closeViewerNow();
    return;
  }
  // 选截止日期的月历层(904):返回键 = 取消,什么都不写;底下那排「截止」原样留着。
  if (isDatePickOpen()) {
    closeDatePickNow();
    return;
  }
  // 卡片「更多…」的屏底菜单(906):返回键 = 收层,什么都不做;卡片上的操作面原样留着。
  if (isMoreSheetOpen()) {
    closeMoreSheetNow();
    return;
  }
  // 编辑层(706)在最上头(留言层开着时它开不出来:遮罩压着卡片操作面)。
  // 正文改过 = 与点遮罩同规矩:157 G4 / P1 起离开就保存 —— 守门条目刚被弹掉,先补压一枚回去
  // (存成了宿主 closeEditSheet 照常平掉它;存不成层留着、守门条目也还在)。
  if (isEditSheetOpen()) {
    if (isEditSheetDirty()) {
      pushLayer();
      saveEditSheet();
      return;
    }
    dismissEditSheet();
    return;
  }
  // 捕获层(122):盖在时间轴 / 面板之上;草稿在 localStorage,收层不丢字。
  if (captureOpen) {
    closeCaptureNow();
    return;
  }
  // 留言层压在时间轴之上、面板之下(它只从时间轴开):返回键先收它。
  if (isCommentsOpen()) {
    closeCommentsNow();
    return;
  }
  // 长文面不在列表页:返回键 = 回上一页(编辑器先落一版)。面还开着 ⇒ 守门条目刚被弹掉,补压一枚。
  // 从搜索结果落到这一篇、还停在落点那一页时不走这条:返回 = 回搜索结果(A3),不是回长文列表。
  if (activePane === "docs" && !atSearchLanding() && docsBack()) {
    pushLayer();
    return;
  }
  // 从设置 / 同步点进来的子页(空间、诊断;161 / W4 A11):返回 = 回那一层(此前越过它、直接落回底下那页)。
  // 守门条目刚被弹掉、面还开着 ⇒ 补压一枚(同上面长文那一支)。
  if (paneStack.length > 0 && activePane !== null) {
    backToParentPane();
    pushLayer();
    return;
  }
  const fromPane = activePane !== null;
  if (fromPane) closePaneNow();
  // 弹掉的是「回搜索」那一枚(A3):重开搜索面。
  if (searchReturn !== null) {
    backToSearch(fromPane);
    return;
  }
  // 都没开 = 陈旧守门条目(空间切换复位等已把层收掉):静默吞,再按一次才退 app。
  // mode 从不压层:任务面按返回与灵感面同账,直接退 app(146 §2.3)。
});

/** 长文面开着、且还停在「从搜索点进来的那一篇」的阅读页主行(A3:这时按返回回搜索结果)。 */
function atSearchLanding(): boolean {
  return searchReturn !== null && activePane === "docs" && docsAtLanding(searchReturn.id);
}

/** 「回搜索」那枚守门条目刚被弹掉(落点那一面已收):重开搜索面 —— 它自己压一枚新的守门条目,再按一次返回回时间轴。
 *  `fromPane` = 落点是一面(长文 / 回收站 / 归档册)而不是时间轴。 */
function backToSearch(fromPane: boolean): void {
  const ret = searchReturn!;
  searchReturn = null;
  // 落点卡的操作面还展开着:先收它(同「无层可关」那一支的次序,157 G1①),那枚条目补压回去,再按一次才回搜索。
  if (!fromPane && cardPanel.backOut()) {
    searchReturn = ret;
    pushLayer();
    return;
  }
  openPane("search");
  // 被闸挡下(有卡片草稿 / 切换编排 / 记下在飞):条目补回,不让这一下把回去的路弄丢。
  if (activePane !== "search") {
    searchReturn = ret;
    pushLayer();
    return;
  }
  // A46:搜索原是回收站 / 归档的子页 ⇒ 接回那一层,再按返回回到它(滚动位照离开时)。
  if (ret.parents.length > 0) {
    paneStack = ret.parents;
    renderBottomBar();
  }
}

/** 用户自己走开了(底栏换面、点通知……):不再回搜索,那枚条目当场平掉(没有面开着时才轮到这里 ——
 *  有面开着的那几条路关面时的 settleHistory 已经平掉它,只需清账)。 */
function dropSearchReturn(): void {
  if (searchReturn === null) return;
  searchReturn = null;
  settleHistory();
}

/** 返回键收编辑层(706):守门条目已由 popstate 弹掉 ⇒ 只收 DOM(⛔ 不走 editsheet 那条
 *  会 settleHistory 的路),再让面板把草稿态收场(它随后调的 closeEditSheet 已是 no-op)。
 *  ⚠ 只在正文**没改过**时走到这儿(与「取消」钮同语义);改过了调用方先拦下(122)。 */
function dismissEditSheet(): void {
  closeEditSheetNow();
  cardPanel.editDismissed();
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

// ---- 正文里的待办方框(checklist.ts)-----------------------------------------------
// 点一下翻那一行的标记、把**整条正文**写回。⚠ 单飞 + 尾随:在飞的那一发回来之前只把
// 最新文本记在 ckLatest,回来再补发 —— ⛔ 别改成并发直发:每一发都是整条正文,乱序落地
// 会让先发的那份盖掉后发的(丢掉一勾)。屏上那份是**乐观**的,故与 lastItems 分开记。
const ckLatest = new Map<string, string>(); // itemId → 屏上这份(乐观)正文
let ckFlushing = false;

async function flushChecklist(space: string): Promise<void> {
  if (ckFlushing) return;
  ckFlushing = true;
  try {
    try {
      for (;;) {
        const first = ckLatest.entries().next();
        if (first.done === true) break;
        const [id, send] = first.value;
        ckLatest.delete(id);
        if (getCurrentSpace() !== space) break; // 期间切了空间:这几笔作废(同别处的编排闸)
        const it = lastItems.get(id);
        if (it === undefined) continue; // 卡已不在屏上(远端删了):放弃这一笔
        // 编辑走哪条命令按 stage 分,同卡片操作面板那处:任务 rename_task / 灵感 edit_note。
        if (isTaskStage(it.stage)) await renameTask(space, id, send);
        else await editNote(space, id, send);
      }
    } catch (err) {
      showErr(err);
      ckLatest.clear();
    }
    await refresh(); // 后端是真相源:成败都照它重画,⛔ 不猜该回滚到哪一版
  } finally {
    ckFlushing = false;
  }
  if (ckLatest.size > 0) void flushChecklist(space); // 重画那几毫秒里又点了:补发
}

function onChecklistTap(box: HTMLElement): void {
  const card = box.closest<HTMLElement>("article.card[data-id]");
  if (card === null) return;
  const id = card.dataset.id!;
  const base = ckLatest.get(id) ?? lastItems.get(id)?.content;
  if (base === undefined) return;
  const next = toggleChecklistLine(base, Number(box.dataset.ck));
  if (next === null) return; // 那一行已不是待办项(远端刚改过):放弃这一下,⛔ 别猜别的行
  ckLatest.set(id, next);
  // 乐观呈现:先把这一行翻面,不等 IPC(随后的 refresh 会整份重画)。勾没勾挂在外层
  // `.ckline` 上 —— 一处翻,方框与文字压淡同时跟着走。
  const row = box.closest<HTMLElement>(".ckline");
  const on = row === null ? false : row.classList.toggle("on");
  box.setAttribute("aria-label", on ? t("checklist.uncheck") : t("checklist.check"));
  void flushChecklist(getCurrentSpace());
}

$("timeline").addEventListener("click", (e) => {
  if (switching) return; // 切换编排中:屏上还是旧空间的卡,不接受任何取图请求
  const target = e.target as HTMLElement;
  // 操作面(.panel)内的点击整个归 cardpanel——这里不碰。ckbox/留言徽章/只读缩略图都不在 .panel。
  // ⚠ 706 起编辑那张表单不在 .panel 里了(它在屏底的编辑层,自己认自己的缩略图与删钮),
  // 这一条守的只剩「操作面上的钮别被时间轴的通用分支截走」。
  if (target.closest(".panel")) return;
  // 长卡折叠那枚钮(用户面 116;159 起逻辑住 fold.ts)。⛔ 它还得在 cardpanel 那条「各有其主」名单里,
  // 否则点一下会连带把操作面板开合。
  if (onFoldClick(target)) return;
  const ckBox = target.closest<HTMLElement>(".ckbox[data-ck]");
  if (ckBox) {
    onChecklistTap(ckBox);
    return;
  }
  const badge = target.closest<HTMLElement>(".cm-badge[data-cm]");
  if (badge) {
    openCommentsFor(badge.dataset.cm!);
    return;
  }
  const btn = target.closest<HTMLElement>(".thumb[data-img]");
  if (!btn) return;
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
/** 这一面一条都没有时的空态。初始同步还在拉(122):「还没有,点 ＋」是在误导 —— 东西在路上,
 *  不是没有;新装的手机刚配上对,最先看到的就是这一屏。 */
function emptyModeHtml(none: string, hint: string): string {
  if (isBooting()) return `<p class="muted empty">${t("main.emptyBooting")}</p>`;
  return `<p class="muted empty">${none}<br />${hint}</p>`;
}

/** 空看板那句「怎么放进第一张」(mbopt R3:只说**这块看板**的事)。落点 ⊥ ⇒ 说放不进的原因(＋ 此刻是灰的);
 *  「转待办」那半句只在默认看板上说(随记转待办落默认看板,别的看板上说了是指错路),别的看板指「放进看板」(同桌面 boards.emptyHintOther)。 */
function emptyTasksHint(view: BoardView | null): string {
  if (view === null || view === HOLDING) return t("main.emptyTasksHint");
  if (view.landing === null) return t("boards.noLanding", { board: esc(boardName(view)) });
  return view.is_default ? t("main.emptyTasksHintPromote") : t("main.emptyTasksHintOther");
}
const emptyTasksLines = (view: BoardView | null): string => `${t("main.emptyTasks")}<br />${emptyTasksHint(view)}`;

/** 这块看板一张都没有、而它的归档里有 ⇒ 空态下面补一句「归档了 N 张,在「归档」里」(165 / W5 Q15 查到手机同病:唯一那张归档后,
 *  任务页变回空态,像是那张没了)。张数要问后端(归档册不在时间轴快照里)⇒ 先占一行藏着,问到了 N > 0 才显;
 *  问不到只是少这一句(空态本身照常)。初始同步还在拉时不补(那时空态说的是「在拉」)。
 *  mbopt R3:只数**这块看板**的成就(按卡所在列的归属认);这块看板没有完成列 ⇒ 根本不提归档(它不产生成就)。 */
function sealedHintHtml(view: BoardView | null): string {
  if (isBooting() || view === null || view === HOLDING || view.done === null) return "";
  return `<p class="muted sealed-hint" data-sealed-hint hidden></p>`;
}
// 成就册按看板的条数一轮只问一次(mbopt M3):空看板每次重画(同步事件、切看板、筛选)都会走到这里,此前每回都重新调后端。
// 每轮 refreshOnce 落定时作废(`sealedCache = null`)—— 归档 / 取消归档都会触发一轮刷新,数不会旧过一轮。
// 第二波起问的是 core 的 `sealed_counts_by_board`(只要条数,不再拉整本成就册回来自己按列归看板)。
let sealedCache: { space: string; rows: Promise<SealedCount[]> } | null = null;
let sealedHintSeq = 0;
function fillSealedHint(box: HTMLElement, view: BoardView | null): void {
  const el = box.querySelector<HTMLElement>("[data-sealed-hint]");
  if (!el || view === null || view === HOLDING) return;
  const space = getCurrentSpace();
  const seq = ++sealedHintSeq;
  if (sealedCache === null || sealedCache.space !== space) {
    const rows = sealedCountsByBoard(space);
    sealedCache = { space, rows };
    rows.catch(() => {
      if (sealedCache?.rows === rows) sealedCache = null; // 问不到不缓存,下次重画再问
    });
  }
  const boardId = view.id;
  void sealedCache.rows.then(
    (rows) => {
      if (seq !== sealedHintSeq || space !== getCurrentSpace() || !el.isConnected) return;
      // 没有这块看板那一组 = 它一张成就都没有(core 只回条数 > 0 的组)。
      const n = rows.find((r) => r.board_id === boardId)?.n;
      if (n === undefined || n === 0) return;
      el.textContent = t("main.emptyTasksSealed", { n });
      el.hidden = false;
    },
    () => {
      /* 只是少一句提示,空态照常 */
    },
  );
}

function projectTimeline(): void {
  const box = $("timeline");
  // index.html 按面分排法(随记面的分栏在 renderDayGroups,不靠它)。
  // ⭐ 只在这里写 —— 投影是「屏上现在是哪一面」唯一落地的地方。
  document.body.dataset.view = viewMode;
  // 看板 = 任务面 ∧ 宽屏(tablet-plan 格 2);index.html「看板」那段全挂在这枚类上,理由同上、也只在这里写。
  const board = viewMode === "tasks" && isWide();
  document.body.classList.toggle("board", board);
  syncFabGutter(); // 让不让那条右边距要在量栏数 / 列数之前定(A48)
  disconnectThumbObserver();
  const items = [...lastItems.values()];
  // 0043:任务面只装**当前那块看板**(或收容区)的卡 —— 筛选条的计数、到期汇总、空态都按这一块说。
  const space = getCurrentSpace();
  const view: BoardView | null = viewMode === "tasks" && boardsReady() ? currentView(space) : null;
  shownView = view;
  shownBoardKey = view === null ? space : `${space}|${viewId(view)}`;
  const onBoard = view === null ? null : new Set(boardColumns(view).map((c) => c.id));
  const modeItems = items.filter((i) => homeOf(i) === viewMode && (onBoard === null || onBoard.has(i.stage)));
  const f = filters[viewMode];
  // 157 G4 / P11:从「没筛」进「筛着」那一刻记下读到哪儿,筛选全清掉时滚回去(此前留在筛选时的位置)。
  const fs = filterScroll[viewMode];
  const nowFiltered = filter.filterActive(f) || (viewMode === "tasks" && (taskStageFilter !== null || dueOnly));
  if (nowFiltered && !fs.was) fs.y = window.scrollY;
  // 死标签/死类型回落(纯状态,先于渲染 pills 与应用过滤,同桌面共享件次序)。
  filter.reconcileTopicFilter(f, allFilterTopics);
  filter.reconcileKindFilter(f, allFilterTopics);
  renderFilterBar(modeItems, view);
  syncLandingBlock();
  const shown = filter.applyFilter(modeItems, f, (i) => i.content, allFilterTopics);
  // 157 G4 / P10:筛着标签时卡上那枚胶囊照常显示 —— 218 起把它藏掉,用户读成「标签被摘了」(W1 走查 WM-32 / WD-18)。
  // ⛔ `soleTopicFilter` 留着(两端纯逻辑被 check-filter-parity 同压),只是不再拿它藏胶囊。
  const hideTopic: string | null = null;
  if (viewMode === "ideas") {
    // 按天分组(用户面 86):这一端是主力端,而随记正是天天往里扔东西的那一面 —— 平铺一条
    // 列表时「这一周记了什么」只能一张张读卡角的时刻。⭐ 不是新设计:桌面 `src/inbox.ts` 早
    // 就是 `.tl-group` + 日期节头,这里补的是它缺的那一半;节头沿用本面任务侧已有的 `.tl-sec`
    // (零新 CSS —— 「一组内容的头」在这一端就长这样)。
    // ⚠ 后端已按 created_at 倒序 ⇒ 顺着扫、`key` 一变就起新段即可,别再排一次。
    box.innerHTML = shown.length
      ? renderDayGroups(shown, hideTopic)
      : modeItems.length === 0
        ? emptyModeHtml(t("main.emptyIdeas"), t("main.emptyIdeasHint"))
        : filteredEmptyHtml(f);
    paintFilterSum(nowFiltered ? shown.length : null, f);
  } else {
    // 宽屏上任务面是看板(tablet-plan 格 2):**全部列都画**(空列一枚「空」,把一列的卡挪光、别的列不跟着变宽)、
    // 列头带计数(158 G3 起竖屏节头也带);「状态」那排收掉(列头就是状态,index.html)⇒ 状态维在看板上当「全部」—— 否则分屏拖窄时选过的
    // 状态,拖宽后成了一条看不见的筛选,看板只剩一列有卡。⚠ 只是**不应用**,不清:拖回窄屏,那排重新露出来时
    // 选中的那枚照旧亮着、照旧生效。窄屏(手机竖放):空节不画、状态那排在。
    const stageF = board ? null : taskStageFilter;
    // 本面专属的两维(状态 / 到期)最后应用,在共享三维之后:空态的话语权也按同序——
    // 词/标签/类型筛空的提示优先(shown 已空),三维有结果、被状态维筛空才说「该状态下
    // 没有任务」,两者都有结果、只被到期维筛空才说「到期的任务不在当前筛选里」。
    const today = localToday();
    const stageShown = stageF === null ? shown : shown.filter((t) => t.stage === stageF);
    const dueShown = dueOnly
      ? stageShown.filter((t) => {
          const st = dueAttentionState(t, today);
          return st === "today" || st === "overdue" || isDueSoon(t, today);
        })
      : stageShown;
    // 只看到期时段内按截止升序(逾期最久的排最前)—— 同桌面 556-B 的 sortByDue:这枚钮
    // 的目的就是「最紧急的先出现」,一堆到期卡按原序摊着等于还要自己找。⚠ 排的是 filter
    // 产出的新数组,不动 lastItems;dueShown 里每张卡必有 due_on(上面的谓词已经保证)。
    // `YYYY-MM-DD` 上的裸串比较就是日历日比较(同 dueState 里那句 `due < today` 的既有形)。
    const inSection = (stage: string): TimelineItem[] => {
      const rows = dueShown.filter((t) => t.stage === stage);
      if (!dueOnly) {
        // 看板手动序(157 G4 / P3);不在那份里的(两次读之间刚落的)排最后、彼此保持时间轴原序。
        const at = (t: TimelineItem): number => taskOrder.get(t.id) ?? Number.MAX_SAFE_INTEGER;
        return rows.map((t, i) => ({ t, i })).sort((a, b) => at(a.t) - at(b.t) || a.i - b.i).map((x) => x.t);
      }
      return rows.sort((a, b) => ((a.due_on ?? "") < (b.due_on ?? "") ? -1 : (a.due_on ?? "") > (b.due_on ?? "") ? 1 : 0));
    };
    // ⚠ 任务卡必须是 `.tl-group` 的**直接子元素**:横滑改状态靠 `card.parentElement` 认它那一节(swipe.ts),
    // 列头与「空」都和卡并排挂在节里,别往中间再套一层盒。列名走 esc():改过名的列是同步来的自由文本。
    // 158 G3 / Q9(WM-13):竖屏的节头也带计数(此前只有横屏列头有,四节串成一条长列表时数不出哪节有几张)。
    // 数的是这一节**画出来的**卡(筛选之后),同横屏列头口径。
    // Q3:「已完成」那一节头上挂「全部归档」(问一次、回执带撤销;同桌面列头那枚)。n 按这一列**全部**的卡说
    // (seal_done_tasks 归的是全部,含被筛掉的)。
    // 0043:「已完成」= 当前看板解析后的完成列;纯分类看板 / 收容区没有这一枚。
    const curDone = view === null || view === HOLDING ? null : view.done;
    const doneAll = curDone === null ? 0 : modeItems.filter((i) => i.stage === curDone).length;
    // `emptyHtml`:这一列空着时画什么(默认那枚「空」;空看板横放时第一列装空态那几句,mbopt M12)。
    const section = (s: { stage: string; label: string }, emptyHtml?: string): string => {
      const rows = inSection(s.stage);
      const count =
        `<span class="tl-count">${rows.length}</span>` +
        (s.stage === curDone && doneAll > 0
          ? `<button type="button" class="tl-act" data-seal-all="${doneAll}">${t("main.sealAll")}</button>`
          : "");
      const cards =
        board && rows.length === 0 ? (emptyHtml ?? `<p class="tl-empty">${t("main.boardEmpty")}</p>`) : rows.map((it) => renderCard(it, hideTopic)).join("");
      // data-col:长按拖认落点在哪一列(carddrag.ts)。
      return `<section class="tl-group" data-col="${esc(s.stage)}"><h3 class="tl-sec">${esc(s.label)}${count}</h3>${cards}</section>`;
    };
    const sections = taskSections(view);
    // 空看板(mbopt M12):横放的看板上照样画出各列 + 「空」,空态那几句放进第一列(同桌面画列;此前一句话盖掉全部列,
    // 看不出这块看板有哪几列)。初始同步还在拉 / 竖放 照旧一句话。
    const emptyBoardCols = board && !isBooting() && view !== null && sections.length > 0;
    // 看着收容区时那句说明(mbopt M10):竖放 = 时间轴首行、随内容滚走;横放的看板留在筛选条里压成一行(renderBoardPills)。
    const heldNote = view === HOLDING && !board ? `<p class="muted held-note">${t("boards.holdingBar")}</p>` : "";
    box.innerHTML = dueShown.length
      ? heldNote + (board ? sections : sections.filter((s) => dueShown.some((t) => t.stage === s.stage))).map((s) => section(s)).join("")
      : modeItems.length === 0
        ? emptyBoardCols
          ? sections
              .map((s, i) => section(s, i === 0 ? `<p class="tl-empty tl-empty-lead">${emptyTasksLines(view)}</p>${sealedHintHtml(view)}` : undefined))
              .join("")
          : emptyModeHtml(t("main.emptyTasks"), emptyTasksHint(view)) + sealedHintHtml(view)
        : shown.length > 0 && stageF !== null && stageShown.length === 0
          ? `<p class="muted empty">${t("main.noneUnderStage", { stage: esc(stageLabel(stageF)!) })}</p>`
          : stageShown.length > 0 && dueOnly
            ? `<p class="muted empty">${t("main.noneDue")}</p>`
            : filteredEmptyHtml(f);
    // 每排几列要在量折叠(settleFolds)**之前**定下来:列宽决定正文折几行。
    if (board) syncBoardCols();
    paintFilterSum(nowFiltered ? dueShown.length : null, f);
    fillSealedHint(box, view);
  }
  // 159 / W3 Q8(WM-26 / X-06):过滤词在卡上标红(同搜索命中;整串匹配,与 applyFilter 同一口径)。
  // ⚠ 排在量折叠之前:标红改了字重,夹线要按标完的样子量。
  const q = f.text.trim();
  if (q !== "") for (const el of box.querySelectorAll<HTMLElement>(".card .content")) markHits(el, [q]);
  hydrateThumbs(box);
  settleFolds(box); // ⚠ 必须在 restore **之前**:编辑态那张卡的正文被盖着,量出来两个高都是 0
  cardPanel.restore(box); // 展开态跨重画恢复(条目已不在=清态)
  restoreBoardScroll(); // 889:看板上列各自滚,整片重建会把它们清回 0 ⇒ 摆回去(不是看板时空操作)
  if (fs.was && !nowFiltered) window.scrollTo(0, fs.y);
  fs.was = nowFiltered;
}

/** 筛选条:本面有条目才显示(空面无可筛)。类型行 + 标签行由 filter.ts 渲染,文本框
 *  是常驻元素(不随 pills 重建、打字不丢焦点),值在 applyMode/清筛处另行同步。 */
function renderFilterBar(modeItems: TimelineItem[], view: BoardView | null): void {
  const bar = $("filterbar");
  // 0043:看板切换那排在,当前这块空着也得留着这条 —— 否则空看板上切不回别的看板。
  const boardsRow = renderBoardPills($("filter-boards"), view);
  bar.hidden = modeItems.length === 0 && !boardsRow;
  bar.classList.toggle("boards-on", boardsRow); // 横放:过滤框并进切换那排的右端(index.html「看板」那段,mbopt M9)
  if (boardsRow) revealActiveBoard(view!);
  const fmain = bar.querySelector<HTMLElement>(".fmain")!;
  fmain.hidden = modeItems.length === 0;
  if (modeItems.length === 0) {
    // 只剩看板那排:其余几排清掉(:empty 隐),别留着上一块看板的状态 / 类型钮。
    for (const id of ["filter-stages", "filter-kinds"]) $(id).replaceChildren();
    bar.classList.remove("boards-wrap");
    return;
  }
  renderStagePills($("filter-stages"), modeItems, view);
  const f = filters[viewMode];
  filter.renderKindPills($("filter-kinds"), modeItems, allFilterTopics, f, onFilterPick);
  filter.renderTopicPills($("filter-topics"), modeItems, allFilterTopics, f, onFilterPick);
  // 横放有切换排时,第一行 = 切换排 + 过滤框;下面还有到期钮 / 标签才断到第二行(index.html `.boards-wrap`,mbopt M9)。
  bar.classList.toggle("boards-wrap", boardsRow && ($("filter-topics").childElementCount > 0 || $("filter-stages").querySelector(".fdue") !== null));
  // 159 / W3 A5(WM-03 前半):筛选清掉的那一下,标签条滚回开头 —— 此前「所有」停在屏外(x=−245),
  // 看得见的几枚都没选中,看不出现在是「全部」。只在「筛着 → 不筛」那一下滚(平时自己横划到哪儿就停哪儿)。
  const was = barWasPicked[viewMode];
  if (was.topics && f.topics.length === 0) $("filter-topics").scrollLeft = 0;
  if (was.kind && f.kind === "all") $("filter-kinds").scrollLeft = 0;
  barWasPicked[viewMode] = { topics: f.topics.length > 0, kind: f.kind !== "all" };
  syncTagsToggle(); // pills 换了 = 「一行装不装得下」的答案可能也换了
}
/** 每一面上一发标签轴 / 类型轴是不是选着东西(A5 只在「选着 → 清掉」那一下把条滚回开头)。 */
const barWasPicked: Record<ViewMode, { topics: boolean; kind: boolean }> = {
  ideas: { topics: false, kind: false },
  tasks: { topics: false, kind: false },
};

/** 筛选条底下那一行(159 / W3 Q8,WM-26 / X-06):筛着时写「筛出 N 条」(同桌面 filter.count),选着标签时把选了哪几枚
 *  写全 —— 收起态的标签条是一行横滑,多选的第二枚往往在屏外,此前看不出选了哪几个。`n === null` = 没在筛;
 *  筛空(0)交给时间轴的空态那句,这里收起。 */
function paintFilterSum(n: number | null, f: filter.FilterState): void {
  const el = $("filter-sum");
  if (n === null || n === 0) {
    el.hidden = true;
    el.textContent = "";
    syncPeek();
    return;
  }
  const parts = [t("filter.count", { n })];
  if (f.topics.length === 1 && f.topics[0] === "none") parts.push(t("filter.none"));
  else if (f.topics.length > 0) {
    const labels = filter.selectedTopicLabels(f, allFilterTopics).join(t("main.listSep"));
    parts.push(f.topics.length > 1 ? t("main.filterSumTagsAny", { labels }) : t("main.filterSumTags", { labels }));
  }
  el.textContent = parts.join(" · ");
  el.hidden = false;
  syncPeek(); // 顶栏收着时屏顶那枚细条跟着这句走(890)
}

// ---- 筛选条常驻要的顶栏高度(604)---------------------------------------------
// `#filterbar` 是 sticky、要贴在顶栏下沿,而顶栏高度含 `env(safe-area-inset-top)`(刘海 /
// 状态栏那一条),**CSS 里写不死** ⇒ 量出来喂给 `--head-h`。转屏、字号(251 的 textZoom)、
// 空间徽章变长都会改它的高 ⇒ 接 ResizeObserver 跟着走,⛔ 别只在启动量一次(同下面那枚
// 摊开钮的由头)。不自激:这个变量只被 filterbar 的 `top` 吃,改不回顶栏自己的高。
{
  const head = document.querySelector("header")!;
  const syncHeadHeight = (): void =>
    // ⚠ 量小数高(getBoundingClientRect),别用 offsetHeight:后者取整,82.2 记成 82 ⇒ 吸顶的节头与筛选条之间
    // 漏一条零点几 px 的缝,卡片从缝里露出一线(157 G3 / WM-22 真机截图量到)。
    document.documentElement.style.setProperty("--head-h", `${head.getBoundingClientRect().height}px`);
  new ResizeObserver(() => {
    syncHeadHeight();
    syncBoardTop(); // 看板上沿跟着顶栏走(889)
  }).observe(head);
  syncHeadHeight();
}
// 时间轴节头吸顶要的筛选条高度(用户面 85 ④ / ui-consistency M10 的前置):节头贴在筛选条下沿,
// 而筛选条收起 / 摊开 / 整条 hidden 时高度都不同 ⇒ 同上量出来喂给 `--fbar-h`。hidden 时
// offsetHeight = 0,节头自然贴到顶栏下沿。不自激:这个变量只被 `.tl-sec` 的 `top` 吃。
{
  const bar = $("filterbar");
  const syncBarHeight = (): void =>
    document.documentElement.style.setProperty("--fbar-h", `${bar.getBoundingClientRect().height}px`); // 小数,理由同 --head-h
  new ResizeObserver(() => {
    syncBarHeight();
    syncBoardTop(); // 看板上沿跟着筛选条走(889:摊开 / 收起标签)
  }).observe(bar);
  syncBarHeight();
}
// 随记栏数跟着时间轴的宽走(tablet-plan 格 1):转屏、分屏拖宽窄、关掉面板(时间轴从 0 宽回来)都会改它。
// 栏数真变了才重投影;⛔ 有卡片草稿时不动(同 onFilterPick 的闸:重投影会拆掉草稿)—— 下一次投影照当时的宽重算,
// 自然排对。不自激:重投影只改高,栏数只看宽。
new ResizeObserver(() => {
  syncFabGutter(); // 宽窄 / 高矮翻了(转屏、分屏拖动):让不让 ＋ 那条右边距先定,下面按让完的宽量
  if (viewMode !== "ideas" || !lastRefreshOk || measureNoteCols() === noteCols) return;
  if (cardPanel.hasDirtyDraft()) return;
  projectTimeline();
}).observe($("timeline"));
// 看板同理(tablet-plan 格 2):宽窄翻了 = 排法换了(画不画空列与计数、状态维算不算)⇒ 重投影;没翻 = 只是每排
// 几列可能变了,改 `--board-col-w`(每列多宽,889)就够,不重画。⛔ 有卡片草稿时不重投影(同上);每排几列照改 —— 它只动排法,拆不掉草稿;
// 下一次投影照当时的宽窄画。不自激:重投影与改列数只改高,宽窄与每排几列只看宽。
new ResizeObserver(() => {
  if (viewMode !== "tasks" || !lastRefreshOk) return;
  if (isWide() !== boardShown() && !cardPanel.hasDirtyDraft()) projectTimeline();
  else if (boardShown()) syncBoardCols();
}).observe($("timeline"));

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

/** 过滤框**歇着**时多宽(它一聚焦就张到 11em;按张开时的宽去判「装不装得下」,打字时标签行就会在两种排法间来回跳)。 */
let ftextRestW = 0;
/** 收起态里**一行放不下、但单独占一行放得下**(159 / W3 A23 新撞):直接摊成那一行,不长 ▾ —— 此前空间里只有一枚标签时,
 *  「所有 / 无标签 / 家里」三枚挤在过滤框左边那一截里,第三枚被切成「○ 家」,而点 ▾ 摊开后也只有这一行。 */
let tagsAutoOpen = false;

/** 摊开 / 收起那枚钮与摊开态第一行的垫片(906)。⚠ 钮在摊开态被搬进标签块当最后一枚,而 filter.ts 每次重画都
 *  `replaceChildren` ⇒ 那一刻它不在文档里,⛔ 别在这一段里用 `$("filter-expand")` 现查,一律走这两枚引用。 */
const tagsBtn = $("filter-expand") as HTMLButtonElement;
const tagsSpacer = document.createElement("span");
tagsSpacer.className = "fspacer";
tagsSpacer.setAttribute("aria-hidden", "true");

/** 收起态那一行里**没露全**的标签钮有几枚(906:「更多 N ▾」的 N)。按标签行歇在开头(没横划过)时的排法数 ——
 *  横划之后这个数不跟着变(它说的是「这一行一共还藏着几枚」,不是此刻屏上的瞬时读数)。 */
function hiddenPillCount(topics: HTMLElement): number {
  const edge = topics.getBoundingClientRect().left + topics.clientWidth;
  let n = 0;
  for (const p of topics.querySelectorAll<HTMLElement>(":scope > .fpill")) {
    if (p.offsetWidth === 0) continue; // 收着的子标签不占位,不算
    if (p.getBoundingClientRect().right + topics.scrollLeft > edge + 1) n++;
  }
  return n;
}

/** 钮上的字:词 + 一枚不念出来的箭头(读屏念 aria-label)。 */
function setTagsBtnLabel(text: string, arrow: string): void {
  const a = document.createElement("span");
  a.className = "fexpand-arrow";
  a.setAttribute("aria-hidden", "true");
  a.textContent = arrow;
  tagsBtn.replaceChildren(text, a);
}

function syncTagsToggle(): void {
  const topics = $("filter-topics");
  const btn = tagsBtn;
  const ft = $("filter-text");
  const fmain = ft.parentElement as HTMLElement;
  // 907 T2:上一趟写死的行宽先摘掉 —— 下面所有量法(一行装不装得下、没露全的有几枚)都按标签行「自然」的宽算,量完再裁。
  topics.style.flex = "";
  $("filterbar").classList.remove("tags-cut");
  // 906:先把摊开态搬进标签块的那两样摘回原位(钮回到过滤框前头),下面的量法与「标签行空不空」都按 filter.ts 画的那几枚算。
  tagsSpacer.remove();
  if (btn.parentElement !== fmain) fmain.insertBefore(btn, ft);
  // 全部 pill 排成一行要多宽:逐枚量(⛔ 别用 scrollWidth —— 摊开态它恒等于 clientWidth,而这个数两态都要用)。
  // 收起的子标签(`.fpill.hidden`)宽 0,不算;gap 8 = `.ftopics` 的 gap。
  const pills = [...topics.children].filter((k): k is HTMLElement => k instanceof HTMLElement && k.offsetWidth > 0);
  const need = pills.reduce((w, k) => w + k.offsetWidth, 0) + 8 * Math.max(0, pills.length - 1);
  if (!ft.classList.contains("wide") && ft.offsetWidth > 0) ftextRestW = ft.offsetWidth;
  const full = (topics.parentElement as HTMLElement).clientWidth; // `.fmain` 一整行
  // 收起态那一行留给标签的宽 = 整行 − 歇着的过滤框 − gap 10(`.fmain` 的 gap)。⭐ 按「▾ 不在」算:
  // 此前拿当时的 scrollWidth / clientWidth 判,▾ 一旦现身就把自己那 40px 也算成「装不下」,过滤框张开过一次
  // (标签行被挤窄 ⇒ ▾ 现身)之后就再也藏不回去。
  const fitsInline = need <= full - ftextRestW - 10 + 1;
  // 有哪枚的名字正被省略号截着(`.fpill` 的 max-width:100% 按标签行的宽封顶)⇒ 它的宽随排法变,量出来的 need
  // 两态不一样,会在「摊开 / 收起」之间来回翻 ⇒ 那种不自动摊开,照旧给 ▾(超长名字本来也要摊开态才看得全)。
  const clipped = pills.some((p) => {
    const l = p.querySelector<HTMLElement>(".flabel");
    return l !== null && l.scrollWidth > l.clientWidth + 1;
  });
  // 看板形(`body.board`)的筛选条是另一套排法(`.fmain` 是 display:contents,量不出整行宽),不进这一格。
  // 165 / W5 A21:窄屏(手机竖放)上标签少到单独一行放得下时**一律**排成这一形(连「和过滤框一行也放得下」的那种 —— 412 宽的
  // 机器上第一枚短标签就是),好让下面「空着先占位」那一形的两行高与它逐像素相同:挂上 / 摘光第一个标签,卡都不跳。
  // 宽屏照旧只在一行放不下时才摊(那儿第一枚标签和过滤框一行放得下,也就不占位)。
  const board = document.body.classList.contains("board");
  const narrow = !isWide();
  tagsAutoOpen = !tagsOpen && (narrow || !fitsInline) && !clipped && need <= full + 1 && pills.length > 0 && !board;
  const empty = topics.childElementCount === 0; // ⚠ 赶在下面往标签块里搬东西之前读
  $("filterbar").classList.toggle("tags-open", tagsOpen || tagsAutoOpen);
  $("filterbar").classList.toggle("tags-fit", tagsAutoOpen);
  btn.classList.toggle("on", tagsOpen);
  btn.setAttribute("aria-label", tagsOpen ? t("shell.tagsCollapse") : t("shell.tagsExpand"));
  btn.setAttribute("aria-expanded", String(tagsOpen));
  // 一行装得下就整枚藏起(一枚点了没变化的钮比没有更糟);自动摊开那一形同理(摊开了也还是那一行)。
  // 摊开态(用户自己按的)照留「收起 ▴」,否则收不回来。
  // 标签行整行没发(一枚真标签都没有,filter.ts renderTopicPills)⇒ 摊开态也藏,别留一枚摊不出东西的钮。
  btn.hidden = empty || (!tagsOpen && (fitsInline || tagsAutoOpen));
  // 906(用户拍「收起钮放到标签末尾」):此前收起态是一枚只有「▾」的小圆钮,摊开后它连同「过滤…」另起一行靠右、左边空着。
  // 摊开态:钮写「收起 ▴」、搬进标签块当**最后一枚**;竖放上过滤框回到「标签 所有 无标签」那一行的右端 —— 那一行末尾垫一枚
  //   吃掉余宽的垫片(真标签从下一行排起),过滤框绝对定位叠在垫片上(它不能搬进标签块:filter.ts 每次重画整块换掉,
  //   搬进去打着字就丢焦点)。垫片的基宽 = 歇着的过滤框;一行连垫片都放不下(特大字号)时垫片自己落到第二行,过滤框跟着它。
  //   看板形(横放)不垫:那儿过滤框本来就和到期钮同一行(index.html `body.board` 那组)。
  // 收起态:钮写「更多 N ▾」(N = 这一行没露全的标签枚数,说法同桌面 `filter.more`);量不出一个站得住的数就只写「更多 ▾」。
  ft.style.top = "";
  if (tagsOpen && !empty) {
    setTagsBtnLabel(t("filter.less"), "▴");
    if (!board) {
      tagsSpacer.style.flexBasis = `${ftextRestW}px`;
      const firstTag = topics.querySelector(":scope > .fpill[data-topic-id]");
      if (firstTag) firstTag.before(tagsSpacer);
      else topics.append(tagsSpacer);
    }
    topics.append(btn);
    if (tagsSpacer.isConnected) ft.style.top = `${tagsSpacer.getBoundingClientRect().top - fmain.getBoundingClientRect().top + fmain.scrollTop}px`;
  } else if (!btn.hidden) {
    // 数字的位数会改钮的宽、钮的宽又改标签行的宽 ⇒ 写上去再量,量到「写的数 = 量的数」才算数(至多三拍);对不上就不写数。
    let n = pills.length;
    let settled = false;
    for (let i = 0; i < 3 && !settled; i++) {
      setTagsBtnLabel(t("filter.more", { n }), "▾");
      const got = hiddenPillCount(topics);
      settled = got === n;
      n = got;
    }
    // 钮摆上去之后一枚都没被藏住、也没有哪枚名字被截着 ⇒ 摊开了也不会多露出什么:整枚藏起(同上面「一行装得下」那条;
    // 看板形量不出整行宽、fitsInline 恒 false,宽屏上标签明明全露着也曾挂着一枚 ▾)。量的那一下恒在「钮摆着」时做 ⇒ 结论不随它显隐翻。
    if (settled && n === 0 && !clipped) btn.hidden = true;
    else if (!settled || n <= 0) setTagsBtnLabel(t("shell.tagsMore"), "▾");
    // 907 T2:行尾那枚别露半截(「无标签」剩「无标」)—— 把标签行收到「最后一枚整枚露着的」右沿为止,「更多 N」紧跟其后、过滤框照旧贴右
    // (`.tags-cut`)。N 数的本来就是「没露全的」,裁完那几枚从半截变成整枚不露,数不变。只在数站得住(settled)时裁;
    // 一枚钮都放不全(过滤框张开、行只剩几十像素)就不裁 —— 那时宁可露半截,也别让这一行空掉。看板形是另一套排法,不进这一格。
    // 选着某枚标签时也不裁:那时这一行会横滚到选中那枚(revealActiveTopic),行要留着自然的宽,选中那枚才整枚放得进来。
    // ⚠ 不自激:裁完的宽只由钮自己的宽与行的自然宽定,下一趟(ResizeObserver 被这次改宽叫起来)先摘再量、裁出同一个数。
    const picked = filters[viewMode].topics.length > 0; // 含「无标签」
    if (!btn.hidden && settled && n > 0 && !board && !picked) {
      const left = topics.getBoundingClientRect().left - topics.scrollLeft;
      const room = topics.clientWidth;
      let cut = 0;
      let wholePills = 0;
      for (const k of pills) {
        const right = k.getBoundingClientRect().right - left;
        if (right > room + 1) break;
        cut = right;
        if (k.classList.contains("fpill")) wholePills++;
      }
      if (wholePills > 0 && cut < room - 1) {
        topics.style.flex = `0 0 ${Math.ceil(cut)}px`;
        $("filterbar").classList.add("tags-cut");
      }
    }
  }
  // 标签行空了而类型轴还在 ⇒ 过滤框并进类型那一行右端,别独占一行(用户面 150;CSS 见 `.kinds-inline`)。
  const kindsInline = empty && $("filter-kinds").childElementCount > 0;
  $("filterbar").classList.toggle("kinds-inline", kindsInline);
  // 标签、类型两行都空着 ⇒ 过滤框并进「列」那排右端(mbopt M9;CSS 见 `.stages-inline`)。看板形有自己那套排法,不进这一格。
  const stagesInline = !board && empty && $("filter-kinds").childElementCount === 0 && $("filter-stages").childElementCount > 0;
  $("filterbar").classList.toggle("stages-inline", stagesInline);
  // ⛔ 一枚真标签都没有时不占标签行(879 用户拍,翻 165 / W5 A21 的 `.tags-reserve`;由头在 index.html `.tags-fit .ftext` 下面)。
}
tagsBtn.addEventListener("click", () => {
  tagsOpen = !tagsOpen;
  localStorage.setItem(TAGS_OPEN_KEY, tagsOpen ? "1" : "0");
  syncTagsToggle();
});
// 父标签上那枚箭头翻子标签显隐(filter.ts 就地改类,不重画、也不改标签行盒子的宽)⇒ 「没露全的有几枚」要跟着重数(906)。
$("filter-topics").addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest(".fcaret")) syncTagsToggle();
});
// ⚠ 那枚钮的显隐是**量出来的**,而量的结果会随视口(转屏)与字号(251 的 textZoom:
// `.ftext` 是 em,放大字号就吃掉更多横向空间)一起变 —— 只在 renderFilterBar 里算的话,
// 钮会停在上一个答案上。**实测**:把视口从 1138 压到 412,标签行溢出了而钮还藏着,
// 也就是这个功能在竖屏上整个消失。⇒ 再接一只 ResizeObserver 盯标签行自己的盒。
// 不会自激:159 起判据只吃 pill 自己的宽、整行宽与歇着的过滤框宽,三样都不随 ▾ 显隐、也不随摊开 / 收起变
// (名字被省略号截着的那种不自动摊开,理由在 syncTagsToggle 里)⇒ 量一次就稳。
new ResizeObserver(() => {
  syncTagsToggle();
  // 158 G2(W2 走查 A13 / WM-08):过滤框一张开,标签行被挤窄,选中的那枚被裁成半截或整个滚出视野
  // ⇒ 标签行盒子一变就把选中那枚滚回视野(只在它确实出界时滚;用户自己横划不改盒宽,不受打扰)。
  if (!tagsOpen && !tagsAutoOpen) revealActiveTopic();
}).observe($("filter-topics"));
// 过滤框歇着 6em、动笔才张到 11em(用户面 36:那个框此前吃掉窄屏三分之一宽,而这一行
// 真正要给的是标签)。⛔ 张开走**类**不走 `.ftext:focus`,理由印在 index.html 那条 CSS 上头。
{
  const ft = $("filter-text") as HTMLInputElement;
  ft.addEventListener("focusin", () => ft.classList.add("wide"));
  ft.addEventListener("focusout", () => ft.classList.remove("wide"));
  // 158 G2(W2 走查 A19 / WM-25):打完字按返回收了键盘,框仍握着焦点、×(type=search 自带的清除钮,
  // 只在框有焦点时画)还在;这时点 × ⇒ 字清了、键盘又弹起来盖半屏。键盘收着时点 × = 只想清掉 ⇒
  // 按下那一刻拦住默认动作,自己清(照常走 input 那条去抖投影),再放掉焦点(框缩回歇着的宽度)。
  // × 的位置:框右端、宽约一个框高的那一块(Chromium 把清除钮画在右内边距里;没有别的 API 认得出它)。
  // 键盘起着(`kb-up`)时不管:正在打字,点 × 清了接着打,键盘本来就在。
  ft.addEventListener("pointerdown", (e) => {
    if (document.activeElement !== ft || ft.value === "") return;
    if (document.documentElement.classList.contains("kb-up")) return;
    const r = ft.getBoundingClientRect();
    if (e.clientX < r.right - r.height) return;
    e.preventDefault();
    ft.value = "";
    ft.dispatchEvent(new Event("input", { bubbles: true }));
    ft.blur();
  });
}

// 165 / W5 A47:筛选条那三行(列 / 类型 / 标签)能横划,被右缘裁掉的那一截此前没有任何「后面还有」的暗示(手机任务页「列」那行
// 第五枚「已完成」只露一道弧)⇒ 哪头还有没露出来的,那头淡出一截(index.html `.fade-l` / `.fade-r`)。
// 跟着三样走:自己横划(scroll)、盒子变宽窄(转屏 / 过滤框张开挤窄,ResizeObserver)、里头的钮换了或显隐翻了(重画 / 父标签箭头
// 翻子标签,MutationObserver —— 那几下不改盒子的宽,RO 看不见)。不自激:只读 scroll 几何、只改这三行自己的类(类不改宽)。
{
  const syncFade = (r: HTMLElement): void => {
    const max = r.scrollWidth - r.clientWidth;
    r.classList.toggle("fade-l", max > 1 && r.scrollLeft > 1);
    r.classList.toggle("fade-r", max > 1 && r.scrollLeft < max - 1);
  };
  for (const id of ["filter-boards", "filter-stages", "filter-kinds", "filter-topics"]) {
    const r = $(id);
    r.addEventListener("scroll", () => syncFade(r), { passive: true });
    new ResizeObserver(() => syncFade(r)).observe(r);
    new MutationObserver(() => syncFade(r)).observe(r, { childList: true, subtree: true, attributeFilter: ["class"] });
  }
}

// 158 G2(W2 走查 A10 / WM-07):提醒时间框点框身只选中一段(没有键盘、没有选择器),
// 只有右端小图标能改 ⇒ 点框身任一处都弹系统选择器(安卓的时间选择器里自带「键盘输入」那一档)。
// 截止日期那一格原先也走这条;904 起它不再是日期框(应用自己的月历层,datepick.ts)。
document.addEventListener("click", (e) => {
  const el = e.target;
  if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return;
  if (el.type !== "time") return;
  el.showPicker();
});

/** 任务面的状态 chips 行:全部 + 四态(固定成员,含 0 计数——行的成员不随数据增减,
 *  布局稳定),与标签/类型 pills 同皮(.fpill)。计数随标签 / 类型筛选收缩、不随文本收缩(158 Q9 / 192)。
 *  灵感面清空该行(CSS :empty 隐)。 */
function renderStagePills(bar: HTMLElement, modeItems: TimelineItem[], view: BoardView | null): void {
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
  // 158 G3 / Q9(WM-14):计数跟着标签 / 类型筛选走(选了「读书」只剩一张卡,此前这一排照旧报全量)。
  // ⚠ 文本维仍不收缩计数(192 那条口径:打字过程中一排数字跟着跳没有信息量);状态维与到期维是这一排
  // 自己 / 并排那枚的事,不叠进来。
  const f = filters[viewMode];
  const scoped = filter.applyFilter(modeItems, { ...f, text: "" }, (i) => i.content, allFilterTopics);
  for (const s of taskSections(view)) {
    nodes.push(mk(s.label, s.stage, scoped.filter((i) => i.stage === s.stage).length));
  }
  const due = dueSummaryPill(modeItems);
  if (due) nodes.unshift(due); // 最前,理由见 dueSummaryPill 的注释
  bar.replaceChildren(...nodes);
  revealActiveStage();
}

/** 选中的那一列整枚露在这一排里(907 T6):英文档 360 宽上,到期汇总钮一长(「1 overdue · 1 today · 1 within 3d」),
 *  排在它后面的「Column」与选中的「All」就被挤出右缘 —— 一进看板,看不出现在筛的是哪一列。⇒ 重画完把选中那枚滚进来。
 *  「露着」按淡出那一截之外算:这一排哪头还有没露出来的,那头的 32 是淡的(`.fade-l` / `.fade-r`),选中那枚压在里面等于半截看不清
 *  ⇒ 它后面 / 前面还有钮时多让出那 32。本来就整枚露在清楚的那一段里时一动不动;用户自己横划不重画,不受打扰。
 *  做法取「滚进视野」而不是把汇总钮的字收短:那句话与桌面逐字同形,两位数时怎么收都还会挤。 */
const STAGE_FADE = 32; // = index.html `.fade-l` / `.fade-r` 淡出那一截的宽
function revealActiveStage(): void {
  const row = $("filter-stages");
  const pill = row.querySelector<HTMLElement>(".fpill.active[data-stage]");
  if (!pill || row.clientWidth === 0) return; // 还没排版(面开着 / 条藏着):下回重画再滚
  const r = row.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  const over = p.right + (pill.nextElementSibling ? STAGE_FADE : 0) - r.right;
  if (over > 0) row.scrollLeft += Math.max(0, Math.min(over, p.left - r.left)); // 行比这一枚还窄时先保它的左沿
  else if (p.left < r.left) row.scrollLeft -= r.left - p.left + (pill.previousElementSibling ? STAGE_FADE : 0);
}

/** 到期汇总钮(用户面 60-D,对齐桌面 502 那枚):一眼答「今天该处理什么」,点一下只看
 *  这些。⭐ 计数按**整块任务面**算(`modeItems`,不随状态 / 标签 / 类型 / 文本任一维
 *  收缩)—— 同桌面的理由:那句话的意思不该被当前视野改写。
 *  ⭐ **摆在这一行最前面**(「状态」轴标之前),不是末尾:`.fstages` 是单行横滑的,窄屏上
 *  「全部 + 四态」本就已经滑出去了,摆末尾等于没做。两者皆零时整枚不渲染(同桌面 hidden)。 */
function dueSummaryPill(modeItems: TimelineItem[]): HTMLButtonElement | null {
  const today = localToday();
  let now = 0;
  let late = 0;
  let soon = 0; // 快到期(60-A)
  for (const it of modeItems) {
    const st = dueAttentionState(it, today);
    if (st === "today") now++;
    else if (st === "overdue") late++;
    else if (isDueSoon(it, today)) soon++;
  }
  // ⭐ **三者皆零才不渲染**:「今天没事、但后天有」正是提前预警最该说话的那天(同桌面)。
  if (now + late + soon === 0) {
    dueOnly = false; // 筛着到期时把最后一条做掉了:别留下一个筛空的面(同桌面 paintDueSoon)
    return null;
  }
  const b = document.createElement("button");
  b.type = "button";
  // ⛔ 朱砂只跟着逾期走(`late` 的条件一个字没动):快到期不是坏消息,不该抢眼。
  b.className = `fpill fdue${late > 0 ? " late" : ""}${dueOnly ? " active" : ""}`;
  b.textContent = dueSummaryFullLabel(late, now, soon);
  b.addEventListener("click", onDuePick);
  return b;
}

/** 点到期钮:同 onStagePick 的草稿闸,再翻这一维并重投影(纯客户端,不重新拉数据)。 */
function onDuePick(): void {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  dueOnly = !dueOnly;
  projectTimeline();
}

/** 任务面的看板切换那排(0043,multiboard-plan §6 手机「任务面顶上一枚看板切换」)。
 *  渐进式披露(§6 末 ①):只有一块活看板、收容区也空 ⇒ 整排不画(:empty 隐),手机上看不出有「看板」这回事。
 *  一枚一块活看板(core 给的序,最前 = 默认看板),收容区有卡时末尾多一枚「已删除的看板 / 列 N」。
 *  返回这排画没画。看着收容区时下面再挂一行说明(只能挪出去、怎么挪)。 */
function renderBoardPills(row: HTMLElement, view: BoardView | null): boolean {
  const note = $("board-note");
  if (view === null || !switcherShown()) {
    row.replaceChildren();
    note.hidden = true;
    return false;
  }
  const mk = (label: string, id: string, count: number | null): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    const on = view === HOLDING ? id === HOLDING : view.id === id;
    b.className = `fpill${on ? " active" : ""}`;
    b.dataset.board = id;
    b.dataset.label = label; // 横放收起顶栏后屏顶那枚细条写当前看板名(chromehide.ts syncPeek,mbopt M11)
    b.append(document.createTextNode(label));
    if (count !== null) {
      const n = document.createElement("span");
      n.className = "fn";
      n.textContent = String(count);
      b.append(n);
    }
    b.addEventListener("click", () => onBoardPick(id));
    return b;
  };
  const axis = document.createElement("span");
  axis.className = "faxis";
  axis.textContent = t("boards.axis");
  // 看板名右侧的灰小字 = 这块看板还没完成的卡数(mbopt C13 / R7:core 的 `open_items`,不在完成列的活卡;没有完成列 = 全部)。
  // 0 不显(同收容那枚 —— 空了就不写数)。⚠ 它与下面画的卡是两次独立读,并发写下可能差一拍,⛔ 别拿屏上卡数去校它。
  const nodes: HTMLElement[] = [axis, ...liveBoards().map((b) => mk(boardName(b), b.id, b.open_items > 0 ? b.open_items : null))];
  const held = holdingCount();
  if (held > 0) nodes.push(mk(t("boards.holdingPill"), HOLDING, held));
  row.replaceChildren(...nodes);
  // 收容区那句说明(mbopt M10):竖放时它是时间轴的首行、随内容滚走(projectTimeline 画),⛔ 别放回吸顶的筛选条里 ——
  // 那儿它压两三行、一直钉在屏顶。横放的看板整页不滚(列各自滚),没有「滚走」这回事 ⇒ 留在筛选条里、压成一行(index.html)。
  note.textContent = t("boards.holdingBar");
  note.hidden = view !== HOLDING || !document.body.classList.contains("board");
  return true;
}

/** 切到某块看板后(点切换排、「去看看」跳过去、记一笔从收容区落回默认看板…)那枚看板钮滚进视野(mbopt M13,仿 revealActiveTopic)。
 *  只在「看的看板换了」那一下滚:同一块看板上的重画(同步、筛选)不动 —— 用户自己横划到哪儿就停哪儿。 */
let revealedBoard = "";
function revealActiveBoard(view: BoardView): void {
  const key = shownBoardKey;
  if (key === revealedBoard) return;
  const row = $("filter-boards");
  const pill = row.querySelector<HTMLElement>(`.fpill[data-board="${viewId(view)}"]`);
  if (!pill || row.clientWidth === 0) return; // 还没排版(面开着 / 条藏着):下回重画再滚
  revealedBoard = key;
  const r = row.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  if (p.left < r.left || p.right > r.right) row.scrollLeft += p.left - r.left - 8;
}

/** 点看板钮:同 onStagePick 的草稿闸。换看板是本机 UI 态(不同步)。 */
function onBoardPick(id: string): void {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  enterBoard(getCurrentSpace(), id);
  window.scrollTo({ top: 0 });
  projectTimeline();
}

/** 换到另一块看板(或收容区)的唯一写口:记下这台在看哪块,并清掉跟着上一块走的筛选(不重投影,调用方投)。
 *  状态维 / 到期维:列是那块看板自己的。标签维 / 类型维(mbopt R5,用户 2026-11-12 拍):回「所有」—— 换了一块看板还筛着上一块的
 *  标签,新看板多半一张都不剩,读成「这块是空的」。过滤词不清(那是用户正在找的一个词,同切面照旧)。
 *  同一块看板上不算换,什么都不清。 */
function enterBoard(space: string, id: string): void {
  const cur = boardsReady() ? viewId(currentView(space)) : null;
  setCurrentView(space, id);
  if (cur === id) return;
  taskStageFilter = null;
  dueOnly = false;
  const f = filters.tasks;
  f.topics = [];
  f.kind = "all";
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
  // 157 G3(WM-14):摊开态下点了一枚标签 = 找到了,收回单行把屏还给结果(摊开时那块占三四成屏)。
  // 只收这一回、不改存着的偏好(下次进 app 仍按他上次自己按的那样摊着)。选中那枚滚进单行的视野里。
  const collapse = tagsOpen && patch.topics !== undefined;
  if (collapse) tagsOpen = false;
  Object.assign(filters[viewMode], patch);
  projectTimeline();
  if (collapse) revealActiveTopic();
}

function revealActiveTopic(): void {
  const row = $("filter-topics");
  const pill = row.querySelector<HTMLElement>(".fpill.active");
  if (!pill) return;
  const r = row.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  // 左边留 8 的引子;行窄到「引子 + 这一枚」放不下时(906:收起态那枚钮写了字、比原来的 ▾ 宽,过滤框一张开标签行只剩九十来宽)
  // 引子让出来,先保这一枚整枚在行里。
  const lead = Math.max(0, Math.min(8, r.width - p.width));
  if (p.left < r.left || p.right > r.right) row.scrollLeft += p.left - r.left - lead;
}

/** 筛空(本面有条目、被当前筛选滤没了)的空态文案:词优先,再标签,再类型——别让
 *  用户以为记录全没了。标签多选时把选中的名字全列出来(「A、B」下没有记录)。 */
function filteredEmptyHtml(f: filter.FilterState): string {
  const q = f.text.trim();
  // 157 G3(WD-29):名词跟着面走(随记 / 任务),与桌面同一个词;此前一律叫「记录」。
  const noun = viewMode === "tasks" ? t("main.nounTasks") : t("main.nounIdeas");
  const labels = filter.selectedTopicLabels(f, allFilterTopics);
  if (q) {
    // 157 G3(WM-15):词叠在标签 / 类型上筛空时把那一层也说出来,别让人以为只是词不对。
    const scope =
      labels.length === 1 && labels[0] === t("filter.none")
        ? t("main.scopeUntagged")
        : labels.length
          ? t("main.scopeTags", { labels: esc(labels.join(t("main.listSep"))) })
          : f.kind !== "all"
            ? t("main.scopeKind", { kind: esc(f.kind) })
            : null;
    return `<p class="muted empty">${
      scope ? t("main.noMatchTextIn", { scope, q: esc(q), noun }) : t("main.noMatchText", { q: esc(q), noun })
    }</p>`;
  }
  if (labels.length === 1 && labels[0] === t("filter.none"))
    return `<p class="muted empty">${t("main.noUntagged", { noun })}</p>`;
  if (labels.length) {
    return `<p class="muted empty">${t("main.noneUnderTags", { labels: esc(labels.join(t("main.listSep"))), noun })}</p>`;
  }
  if (f.kind !== "all") return `<p class="muted empty">${t("main.noneUnderKind", { kind: esc(f.kind), noun })}</p>`;
  return `<p class="muted empty">${t("main.noMatch", { noun })}</p>`;
}

/** 新记录落某面之后的筛选收尾(避免刚记的被停留的筛选藏起)。判的是一件事:**这条新记录
 *  在标签/类型两维下看得见吗** —— 看得见就把那两维原样留着(用户要的正是「在这个标签下
 *  记的东西留在这个标签下」),看不见才整份清零。三种看得见:①挂上了任一枚被筛的标签
 *  (OR 并集里挂一枚就入选);②压根没筛这两维;③筛的正是「无标签」——新记录生而无标签,
 *  天然在那一档里(⛔ 这一格此前跟着一起清了,是多余的,且与桌面 inbox/board 的判据不一致)。
 *  文本维与状态维恒清:新记录多半不含过滤词,且新任务必落 todo 列(筛着别的列就看不见)。
 *  到期维同理恒清:新任务生而无截止日,筛着到期时它一记下就隐身。 */
function settleFilterAfterSave(mode: ViewMode, tagged: number): void {
  if (mode === "tasks") {
    taskStageFilter = null; // 状态维不在 FilterState 里,单独清(新任务必可见)
    dueOnly = false; // 到期维同上:新任务无 due_on,不清的话刚记的当场看不见
  }
  const f = filters[mode];
  if (!filter.filterActive(f)) return;
  const visible =
    tagged > 0 || (f.kind === "all" && (f.topics.length === 0 || f.topics.includes("none")));
  filters[mode] = visible
    ? { kind: f.kind, topics: [...f.topics], text: "" }
    : { kind: "all", topics: [], text: "" };
  if (mode === viewMode) ($("filter-text") as HTMLInputElement).value = "";
}

async function refreshOnce(): Promise<void> {
  // 长按拖着一张卡时也延后(158 G3 / Q7):重画会把手里那张卡换掉;放下时由 onDone 补上。
  if (cardPanel.hasDirtyDraft() || isDragging()) {
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
    // 159 / W3 Q2:底栏「回收站」「归档」两格空了也常在 ⇒ 不再为它俩的显形取 pane_counts。
    const [items, ftopics, cols, bds, , , tasksInOrder] = await Promise.all([
      listTimeline(space),
      listTopicsFull(space),
      listBoardColumns(space), // 看板列(B-f 第 1 段):没有它连「这行是不是任务」都答不了 ⇒ 失败同走整轮错误页
      listBoards(space), // 0043:落点 / 完成列 / 默认看板都在这里(core 解析过);与列同批取、同批落
      loadIdentity(space),
      loadCommentCounts(space),
      // 157 G4 / P3:任务面每一节的卡序 = 看板的手动序(同桌面看板默认那一档)⇒ 刚转成的待办落在「待办」最上,
      // 与桌面同一处。时间轴本身是按创建时间倒序的,转待办的老随记会沉到那一节最底下(W1 走查 WM-17)。
      listTasks(space),
    ]);
    if (space !== getCurrentSpace()) return;
    // 161 / W4 A14(WM-03 / WP-12):设备名字刚随这一轮重读过 —— 开着的设备名单跟着换(此前卡上的来源十几秒就换了,名单还是编号)。
    repaintDevices();
    if (cardPanel.hasDirtyDraft() || isDragging()) {
      refreshDeferred = true;
      return;
    }
    // ⚠ **列必须先于任何投影落定**:renderCard / 分组 / 滑动链全问 columns.ts,
    // 早一行晚一行的差别是「这一帧的卡按新列画还是按旧列画」。
    setColumns(cols);
    setBoards(bds);
    // 状态维的死筛回落(同标签轴的 reconcile):被筛的那一列若已不在当前看板上(删掉 / 看板换了),
    // 该筛选就成了一条永远筛空的死路 ⇒ 清掉。⛔ 别改成在渲染处回落显 id。
    if (taskStageFilter !== null && !boardColumns(currentView(space)).some((c) => c.id === taskStageFilter)) taskStageFilter = null;
    lastItems = new Map(items.map((i) => [i.id, i])); // 全量真值,只在成功读取后更新
    taskOrder = new Map(tasksInOrder.map((x, i) => [x.id, i]));
    boardOrder = tasksInOrder.map((x) => ({ id: x.id, stage: x.status }));
    allFilterTopics = ftopics.map((t) => ({ id: t.id, title: t.title, color: t.color, kind: t.kind }));
    // 长文钮的显形真值 = 同一份时间轴快照里有没有主归属是长文的条目(不另起一条计数查询)。
    hasDocs = items.some((i) => i.kind === "doc");
    renderBottomBar();
    lastRefreshOk = true;
    sealedCache = null; // 成就册张数随这一轮作废(空看板那句提示要时再问一次,mbopt M3)
    projectTimeline();
    // Q6:这份筛选 / 位置从此归这个空间;切回来的那一下还它上次读到的位置(落的是同一面才还)。
    viewSpace = space;
    if (pendingSpaceAt !== null && pendingSpaceAt.space === space) {
      const at = pendingSpaceAt;
      pendingSpaceAt = null;
      if (at.mode === viewMode) {
        if (activePane === null) window.scrollTo(0, at.y);
        else timelineScrollY = at.y; // 面还开着:关面时还到这儿
      }
    }
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
      `<p class="empty warn-ink">${t("main.timelineLoadFailed", { error: esc(errDetail(err)) })}</p>`;
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
 *  多留一拍,点它的缩略图/操作面就会拿旧条目 id 打到新空间;清屏 = 没有可点的旧目标),
 *  随后的 refresh 负责画新空间。 */
function blankTimelineForSpaceChange(): void {
  refreshDeferred = false; // 旧空间欠的刷新作废:新空间马上整轴重拉
  closeComments(); // 留言层指着旧空间的条目(没开就是 no-op)
  cardPanel.forceClose(t("main.spaceSwitchedDraftDropped")); // 有草稿才响,静默无草稿路
  resetPanesForSpaceChange(); // 统一复位:关全部面 + 清陈旧内容 + 诊断缓存作废
  disconnectThumbObserver();
  lastItems = new Map();
  boardOrder = []; // 同 lastItems:旧空间的序别留给新空间的挪卡算落点
  // 列同 lastItems 一起作废:每个空间是自己一套列(B-f 第 1 段)。⭐ **清空比留着旧的安全** ——
  // 留着 = 万一有一帧漏网,卡会**安静地**顶着旧空间的列名画出来;清空 = 列登记处(`stageLabel` / `isTaskStage`)
  // 一律答不上,任务面一节都分不出来。⇒ 错的方向落在「画不出」而不是「画错」这一侧。
  setColumns([]);
  setBoards([]); // 同列:看板也是每个空间自己一套
  hasDocs = false; // 旧空间的「长文」钮不许挂到新空间数据到达前
  renderBottomBar();
  lastRefreshOk = false; // 快照失效(146 ▲▲M2):新空间读到之前,mode 切换不许投影旧数据
  $("timeline").innerHTML = `<p class="muted empty">${t("main.loading")}</p>`;
}

// 「全部归档」(158 G3 / Q3,WM-28):「已完成」节头那枚。问一次(归档后可查、不可删,这件事要在动手前说),
// 回执带「撤销」(逐条取消归档 —— 同桌面 sealAllDone)与「去看看」(开归档页)。单张归档不问(cardpanel)。
$("timeline").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-seal-all]");
  if (!btn) return;
  if (switching) return;
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  const space = getCurrentSpace();
  // 0043:归的是**当前那块看板**的完成列(钮只画在它的节头上)。
  const view = currentView(space);
  if (view === HOLDING || view.done === null) return;
  const { id: boardId, done } = view;
  const ids = [...lastItems.values()].filter((i) => i.stage === done).map((i) => i.id);
  if (ids.length === 0) return;
  // mbopt R4:点名的是**这块看板的完成列**(名字可改、各块不同),⛔ 别写死「已完成」。
  confirmBar(t("main.sealAllQ", { n: ids.length, col: stageLabel(done)! }), t("main.sealAllYes"), () => {
    if (switching || space !== getCurrentSpace()) return;
    void (async () => {
      // 撤销要逐条取消归档的那一批按**库里此刻**的「已完成」列取(屏上那份快照可能比库旧一拍 —— 刚撤销的单张归档
      // 回来了而轴还没重画,撤销就会漏掉它);回执的数用命令自己报的条数。
      let sealed: string[];
      let n: number;
      try {
        sealed = (await listTasks(space)).filter((x) => x.status === done).map((x) => x.id);
        n = await sealDoneTasks(space, boardId);
      } catch (err) {
        showErr(err);
        await refresh();
        return;
      }
      await refresh();
      if (space !== getCurrentSpace()) return;
      actionBar(
        t("main.sealedAll", { n }),
        t("ui.undo"),
        () => {
          if (switching || space !== getCurrentSpace()) return; // 换空间的旧撤销作废
          void (async () => {
            let failed = 0;
            for (const id of sealed) {
              try {
                await unsealTask(space, id);
              } catch (err) {
                failed++;
                showErr(err); // 逐条撤:撤不回的那条照实报(多半是别处已动过它),其余照撤
              }
            }
            await refresh();
            if (failed === 0 && space === getCurrentSpace()) showUndone(); // 165 / W5 Q6(有撤不回的那条,错误条留着别盖掉)
          })();
        },
        { label: t("cardpanel.goSee"), on: () => activePane !== "sealed" && openPane("sealed") },
      );
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
    showErr(err);
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
// ⛔ 别改回 `new URL(raw).host === "open"`(152 在 MuMu 上量到):非特殊 scheme 的 host 老 WebView 解析不出来 ——
// Chrome 110 给 `host: ""`、`pathname: "//open"` ⇒ 每条链接都被静默丢掉,新 WebView(vivo 151)上才对。
// 认前缀不认引擎:链接是我们自己生成的那个形(桌面 deeplink.ts / 本端 api.ts::itemDeepLink)。
type ParsedDeepLink = { acc: string | null; space: string | null; item: string };
const DEEP_LINK_PREFIX = "zhujian://open?";
function parseDeepLink(raw: string): ParsedDeepLink | null {
  if (!raw.startsWith(DEEP_LINK_PREFIX)) return null;
  const q = new URLSearchParams(raw.slice(DEEP_LINK_PREFIX.length));
  const item = q.get("item");
  if (!item) return null;
  return { acc: q.get("acc"), space: q.get("space"), item };
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
    showErr(e);
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
  ($("save") as HTMLButtonElement).disabled = switching || captureSaving || picking || landingBlocked() !== null;
}

/** 任务面上这块看板放不进卡时(mbopt R2):＋ 灰掉(点它说原因、不开记一笔)、「记下」灰掉、记一笔框的灰字换成原因。
 *  每次投影调一次(看的看板、它的落点、面都可能变了)。⛔ 别让 core 在用户打完字之后才拒。 */
function syncLandingBlock(): void {
  const why = landingBlocked();
  const fab = $("capture-fab");
  fab.classList.toggle("blocked", why !== null);
  if (why !== null) fab.setAttribute("aria-disabled", "true");
  else fab.removeAttribute("aria-disabled");
  refreshSaveDisabled();
  paintComposePh();
}

// 捕获层(232)的开合账。122 起它也压返回键守门条目(此前不压 ⇒ 键盘收掉后的下一记返回
// 直接退 app,冷启只回填草稿不开层,用户看到的是一条空时间轴)。收层两条路,同编辑层:
// UI 收(点遮罩 / 存成功)走 `dismissCapture` 顺带平条目;返回键(popstate 已弹)走 `closeCaptureNow`。
let captureKb: KbSheet | null = null;
let captureOpen = false; // 由 kbsheet 的 onOpen / onClose 维护,⛔ 别在别处写

function closeCaptureNow(): void {
  captureKb!.close();
}

function dismissCapture(): void {
  if (!captureOpen) return;
  closeCaptureNow();
  settleHistory();
}

/** 这张卡是不是时间轴里最靠上的那一张(多栏时每栏头一张一样高,都算)。只在「记下」落地那一下问一次。 */
function isTopmostCard(card: HTMLElement): boolean {
  let min = Infinity;
  for (const c of document.querySelectorAll<HTMLElement>("#timeline article.card")) {
    const r = c.getBoundingClientRect();
    if (r.height > 0 && r.top < min) min = r.top;
  }
  return card.getBoundingClientRect().top <= min + 1;
}

async function save() {
  const ta = $("text") as HTMLTextAreaElement;
  if (captureSaving || picking) return; // picking:钮此刻是 disabled 的,这条兜非点击的路子
  // 901:空的清单项在提交这一刻摘掉(只摘送出去的那份;框里的字不动,失败退回的也是原文)。摘完为空 = 没写字,走下面那句。
  const cleaned = dropEmptyChecklistItems(ta.value);
  if (!cleaned.trim()) {
    // 图不能独立成条(条目正文非空):只贴图没写字时给可辨识提示,不静默无反应。
    // 158 G2(W2 走查 A16 / WM-18):一个字没写就点「记下」也说一声(此前层不收、什么都不说)。
    showError(compImgs.count() > 0 ? t("main.textBeforeImages") : t("main.nothingToSave"));
    return;
  }
  if (cardPanel.hasDirtyDraft()) {
    // ▲▲M3:卡片草稿在场时保存后的 refresh 会被无限延后、新卡落不了 DOM——响亮拒。
    showError(t("main.finishDraftFirst"));
    return;
  }
  // mbopt R2:这块看板放不进卡 ——「记下」此刻本是灰的(refreshSaveDisabled),这条兜非点击的路子;草稿原样留在框里。
  const blocked = landingBlocked();
  if (blocked !== null) {
    showError(blocked);
    return;
  }
  const space = getCurrentSpace();
  const mode = viewMode; // 落点冻结在点击那刻,响应回来绝不重读
  // 「筛着标签记录 → 那几枚标签全挂上」的待挂集,同刻冻结(同 mode / 图批):往返期间
  // 用户点 pill 改了筛选,挂的仍是点「记下」那一刻筛着的几枚。
  const autoTags = filter.autoTagTopicIds(filters[mode]);
  const rawDraft = ta.value;
  const savingDraft = cleaned;
  ta.value = "";
  // 图与文字同刻冻结带走(两缓冲,同 takeBatch):在飞期间新贴的图属于下一条,清预览。
  const savingImgs = compImgs.takeBatch();
  localStorage.removeItem(COMPOSE_DRAFT_KEY); // 文字草稿同刻清(图持久化由 takeBatch 清)
  captureSaving = true;
  captureLiveTouched = false;
  navSeq++; // 作废在途 focus 定位:不许其内部切面打破「新卡在当前面」承诺
  refreshSaveDisabled();
  try {
    // 0043:任务面记的落**此刻看着的那块看板**的落点(plan §6 第 4 段);看着收容区(只出不进)⇒ 落默认看板并切过去。
    let boardId: string | null = null;
    if (mode === "tasks" && boardsReady()) {
      const view = currentView(space);
      if (view === HOLDING) setCurrentView(space, defaultBoard().id);
      else boardId = view.id;
    }
    const newId = mode === "ideas" ? await captureIdea(space, savingDraft) : await captureTodo(space, savingDraft, boardId);
    // 条目已建 → 把冻结的暂存图逐张挂上(失败按张计,条目在、图可去卡片「加图」重贴)。
    // 挂完再刷新,新卡带着缩略图一次呈现。
    if (savingImgs.length) {
      const { failed, why } = await compImgs.attachBatch(space, newId, savingImgs);
      // ⛔ why 说得准就**替掉**「可在该卡片『加图』重贴」那句(538,用户面 56):
      // 不支持的格式 / 过大都是确定性拒法,叫用户重贴等于支他去做一件注定失败的事。
      if (failed > 0)
        showError(t("main.imagesNotAttached", { n: failed, hint: why || t("images.retryHint") }));
    }
    // 筛着标签记录 → 被筛的那几枚**全挂上**(用户 2026-08-31 拍板「相关的标签都打上才
    // 符合直觉」,并同轮点名手机要跟上桌面这条行为;此前手机只做「清筛见新卡」的简单形)。
    // 命令面按 stage 分家:任务面走 add_task_topic,灵感面走 file_note_to_topic。
    // ⛔ 串行不并行:几笔标签写落在同一行上,并发只是自找写锁竞争,枚数是个位数。
    // 部分成功照登记:挂上几枚算几枚,失败数提示一句——条目已在,不回滚也不吞掉。
    let tagged = 0;
    for (const topicId of autoTags) {
      try {
        if (mode === "tasks") await addTaskTopic(space, newId, topicId);
        else await fileNoteToTopic(space, newId, topicId, null);
        tagged++;
      } catch {
        /* 逐枚计数,循环末统一提示;失败不中断其余几枚 */
      }
    }
    if (tagged < autoTags.length)
      showError(t("main.tagsNotAttached", { n: autoTags.length - tagged }));
    // 新卡落 mode 面:挂上了任一枚就留着筛选(OR 并集下新卡必然入选,用户要的正是「在这个
    // 标签下记的东西留在这个标签下」);一枚也没挂上才清筛,免得刚记的记录被藏起(「记了
    // 却没出现」的错觉)。
    settleFilterAfterSave(mode, tagged);
    if (!captureLiveTouched) {
      // 在飞期间无新输入:现状回执——收键盘让新卡露出来,滚到顶闪一下
      // (ui-audit P1 #7:原 finally 无条件 ta.focus() 让键盘永不收、新卡被挡)。
      ta.blur();
      dismissCapture(); // 收起捕获层(232),露出刚记的新卡
      await refresh();
      const card = document.querySelector<HTMLElement>(`#timeline [data-id="${newId}"]`);
      if (card) {
        // 158 G2(W2 走查 A16 / WM-19):滚到中段新建,保存后被拉回顶部、读到哪儿全丢 ⇒ 不再强拉。
        // 新卡就在屏上 = 闪一下;不在屏上 = 回执带「去看看」,点了才过去(同 157 P3 转待办那枚)。
        // 889:看板上列自己滚 / 看板横滚,卡可能在本列滚走的那截或屏外那列里 —— 只认 taskmove 那把带列框的尺子。
        // 900(应用评审二轮 M1):随记面也认同一把尺子。此前这一支拿整个视口量(`bottom > 0 && top < innerHeight`),
        // 而顶栏 + 筛选条吸在上面、底栏盖在下面 ⇒ 列表只滚了一两屏的边上,新卡压在吸顶条底下也算「在屏上」,
        // 那记脉冲闪在看不见的地方、回执又不出 = 记下之后什么信号都没有。⛔ 不强拉回顶(158 G2 拍的)。
        // 904(用户 2026-11-13 拍,改掉 158 G2 / 900 在**随记面**上那一半):随记面上自己记下的那一条不在眼前 ⇒ 自己滚回顶让它露出来
        // (新随记恒在列表最上),回执「已记下」照出、不再挂「去看看」。瞬时滚,不用平滑:那记闪只有 1.2 s,滚完就过了。
        // 看板 / 任务面照旧(不拉、带「去看看」):新卡落的是某一列 / 某一节的头上,不在页顶。
        // ⛔ 这只管「自己刚记下的」;对端同步来的新条目照旧不动读到的位置(重画保锚那条,ui-guidelines §3.1)。
        let shown = inView(card);
        let revealed = false;
        if (mode === "ideas" && !shown) {
          // 手机横放时顶栏可能正收着(890):这一下是「一帧跳大半屏」的程序滚动,chromehide 不把它当「滚回顶 = 露」⇒ 明着叫回来,
          // 否则人在页顶、顶栏却收着,上面空出一条(真机实撞)。
          showChrome();
          window.scrollTo({ top: 0 });
          // ⚠ 这一刻键盘多半还没落完(刚 blur),视口还是让过键盘的那一截 —— 手机横放时只剩一百来高,顶栏 + 筛选条一占,
          // `inView` 对哪张卡都答「不在」(真机逐事件量的:先滚、几十毫秒后视口才长回来)。⇒ 人真在页顶(scrollY 归零了)、新卡又是最上面那张 = 键盘一落它就在眼前,
          // 照「露出来了」办;⛔ 别在这儿拿 `inView` 一票否决再去 scrollIntoView —— 那会把页面从顶上又推下去、回执挂回「去看看」。
          shown = inView(card) || (window.scrollY < 1 && isTopmostCard(card));
          if (!shown) {
            card.scrollIntoView({ block: "center" }); // 滚回顶它也不是最上面那张(顶上另有东西占着)⇒ 直接滚到它
            shown = inView(card);
          }
          revealed = shown;
        }
        if (shown) {
          if (revealed) showBar(t("main.saved"), true);
          // 165 / W5 Q15:多栏(随记分栏 / 看板)上新记一条、其余每张都换一栏,1.2 s 那记脉冲还没找到它就过完了 ⇒ 描边常亮约 3 s 再淡
          // (index.html `.flash-hold`,与搜索落点框同长)。一栏(手机竖放)照旧那一记:新卡就在最上面,一眼看得见。
          const hold = noteCols > 1 || boardShown();
          const cls = hold ? "flash-hold" : "flash";
          card.classList.add(cls);
          window.setTimeout(() => card.classList.remove(cls), hold ? 3800 : 1200);
        } else {
          actionBar(t("main.saved"), t("cardpanel.goSee"), () => void focusTimelineCard(newId));
        }
      }
    } else {
      // 用户正在续打(或分享追加了):不 blur、不抢焦点、不滚动,只刷新列表。
      await refresh();
    }
  } catch (err) {
    showErr(err);
    // 失败:取走的那份放回。框里有新字就合并(先写的在前),光标置尾接着改。
    const live = ta.value;
    ta.value = live === "" ? rawDraft : `${rawDraft}\n${live}`;
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

// 「长文」(831,backlog 152 ③):把框里的字与暂存图带进一篇新长文。⛔ 取图在飞时不受理:屏上
// 摆着骨架时 takeBatch 只带走有字节的那几张(同「记下」那条 picking 闸的理由)。卡片草稿挡开面,
// 先问过再收层 —— 否则层收了、面没开,用户落回时间轴。字交给长文那边落成草稿之后才清这边。
// 878:新建长文第一次落盘发 doc_at ⇒ 已配同步的空间先过混版提醒(skewask.ts);「先不用」= 什么都没动,字和图还在框里。
$("compose-doc").addEventListener("click", () => {
  if (captureSaving || switching || picking) return;
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  const sp = getCurrentSpace();
  skewAsk(sp, () => {
    // 中间隔着一次读与一次确认:前提重新核一遍(换了空间 / 又在写 / 又有了卡片草稿 = 这一下作罢)
    if (captureSaving || switching || picking || getCurrentSpace() !== sp) return;
    if (cardPanel.hasDirtyDraft()) {
      showError(t("main.finishDraftFirst"));
      return;
    }
    const ta = $("text") as HTMLTextAreaElement;
    ta.blur();
    dismissCapture();
    openPane("docs");
    if (activePane !== "docs") throw new Error("长文:开面没成(闸已在上面问过,不该到这儿)"); // 框里的字还在
    startDocFrom(ta.value, compImgs.takeBatch());
    ta.value = "";
    localStorage.removeItem(COMPOSE_DRAFT_KEY); // 图的那份由 takeBatch 清
  });
});

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
      captureOpen = true;
      pushLayer(); // 返回键第一本能 = 关掉这层(122)
    },
    onClose: () => {
      // 只收界面;草稿(localStorage)/暂存图(pendingImages)由既有逻辑保留,下次点开还在。
      fab.hidden = false;
      captureOpen = false;
    },
    onDismiss: dismissCapture, // 点遮罩 = UI 收层,顺带平掉守门条目
  });
  captureKb = kb;

  fab.addEventListener("click", () => {
    // mbopt R2:这块看板放不进卡 ⇒ 不开记一笔,说原因(＋ 此刻是灰的,syncLandingBlock)。
    const blocked = landingBlocked();
    if (blocked !== null) {
      showError(blocked);
      return;
    }
    kb.open();
    ta.focus(); // 键盘自动起
  });
  // 层内按钮不抢输入焦点,免点一下就收键盘、层跳一下。
  ($("save") as HTMLButtonElement).addEventListener("mousedown", (e) => e.preventDefault());
  $("compose-addimg").addEventListener("mousedown", (e) => e.preventDefault());
  // 562:「＋ 待办」尤其不能失焦——失了焦 execCommand 就落不到输入框身上。
  $("compose-todo").addEventListener("mousedown", (e) => e.preventDefault());

  // FAB 竖直位置吃底栏实高(含安全区);底栏极少变,稳妥观察。宽屏上底栏搬进了顶栏,这里量到的是它在顶栏里的高,
  // 没人吃 —— `body.widescreen` 那一层把 `--nav-h` 改写成「屏底只有安全区」盖在上面(index.html「导航并进顶栏」)。
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
/** 随记页顶那一条(161 / W4 Q12 ★①):当前空间这台已不在账户里时挂着,说是哪一种(同同步面那一行),点了进同步页。 */
function paintGoneBar(): void {
  // ⚠ 先问本机那本账:刚重置 / 刚切走时,`currentGone` 还是上一份状态说的,下一份到之前别替这一本挂着。
  const gone = goneSpaces().has(getCurrentSpace()) ? currentGone() : null;
  $("sync-gone-bar").hidden = gone === null;
  $("sync-gone-bar-head").textContent = gone === "left" ? t("sync.goneLeft") : gone === "revoked" ? t("sync.goneRevoked") : "";
}

function renderSpaceChip() {
  const cur = spacesCache.find((s) => s.id === getCurrentSpace());
  const single = spacesCache.length <= 1;
  const chip = $("space-chip") as HTMLButtonElement;
  chip.hidden = single;
  chip.textContent = cur ? spaceLabel(cur) : t("api.defaultSpace");
  // 161 / W4 Q6 ★①(X-14):不管几个空间都留着 —— 此前有了第二个空间它就藏起(「徽章即入口」),可人照着
  //   指南「同步页里那个也在」去找就扑空。已不在账户里时同步面那一块自带一枚「空间…」(紧挨着「去重置」那句,
  //   Q12),底下这枚就不再摆第二枚。
  $("sync-spaces-btn").hidden = currentGone() !== null;
  $("sync-title").textContent = single
    ? t("main.syncTitle")
    : t("main.syncTitleSpaced", { name: cur ? spaceLabel(cur) : t("api.defaultSpace") });
  paintComposePh();
}

/** 记一笔框的灰字(随面换,146)。159 / W3 Q6(WM-17):**有多个空间时**写上会记进哪个空间(同桌面
 *  inbox.composePlaceholderSpace);只有一个空间时照旧(那时「空间」整个藏着,同 renderSpaceChip 的原则)。 */
function paintComposePh(): void {
  const cur = spacesCache.length > 1 ? spacesCache.find((s) => s.id === getCurrentSpace()) : undefined;
  const ta = $("text") as HTMLTextAreaElement;
  const blocked = landingBlocked(); // mbopt R2:放不进卡时灰字就说为什么(「记下」同时是灰的)
  if (blocked !== null) {
    ta.placeholder = blocked;
    return;
  }
  if (cur === undefined) {
    ta.placeholder = viewMode === "ideas" ? t("main.composeIdeaPh") : t("main.composeTaskPh");
    return;
  }
  const space = spaceLabel(cur);
  ta.placeholder = viewMode === "ideas" ? t("main.composeIdeaPhSpace", { space }) : t("main.composeTaskPhSpace", { space });
}

function renderSpaceList() {
  const box = $("space-list");
  const gone = goneSpaces();
  box.innerHTML = spacesCache
    .map((s) => {
      const label = esc(spaceLabel(s));
      if (s.current && renamingSpace) {
        const err = spaceRenameErr;
        return `<div class="space-row current${err ? " has-err" : ""}">
          <input class="rename" id="space-rename-input" value="${esc(err ? err.draft : (s.name ?? ""))}"
                 placeholder="${label}" autocapitalize="off" autocomplete="off" />
          <button class="act" data-rename-ok="1">${t("main.renameOk")}</button>
          <button class="act" data-rename-cancel="1">${t("main.renameCancel")}</button>${
            err ? `<p class="space-err" role="alert">${esc(err.msg)}</p>` : ""
          }
        </div>`;
      }
      // 重置两拍确认(epoch-plan §7,multispace §20 门 4 的警告义务):红字说清
      // 「删的是本机副本、须另一台在线完整副本、旧设备身份报运营者吊销」。
      // 确认钮全宽独行、与「取消」拉开(ui-audit P1 #11:别让最重操作挨着毗邻控件)。
      if (resettingSpace === s.id) {
        // 重置话术分流(space-entry-plan §5):已开同步的空间=清本机副本、可重新
        // 加入;仅本机的本子=删除**唯一副本**,不再用「清库重配」安抚。
        // 161 / W4 Q12(A40):已不在账户里的那一本,确认里点出「之后在这台记的那几条只在这里」。
        const warnText = gone.has(s.id)
          ? t("main.resetWarnGone")
          : s.configured
            ? t("main.resetWarnSynced")
            : t("main.resetWarnLocalOnly");
        return `<div class="space-row current" data-space="${esc(s.id)}">
          <div style="flex:1">
            <div>${label}</div>
            <div class="tag warn" style="display:block;white-space:normal">${warnText}</div>
            <button class="act warn reset-confirm" data-reset-ok="${esc(s.id)}">${t("main.resetConfirm")}</button>
            <button class="act reset-cancel" data-reset-cancel="1">${t("main.renameCancel")}</button>
          </div>
        </div>`;
      }
      // Q12(A40 / WP-13):已不在账户里的那一本标「已不再同步」(此前和平时一模一样,看不出已被移除)。
      const tag =
        (s.current ? `<span class="tag warn">${t("main.tagCurrent")}</span>` : "") +
        (gone.has(s.id)
          ? `<span class="tag warn">${t("main.tagUnsynced")}</span>`
          : s.current || s.configured
            ? ""
            : `<span class="tag">${t("main.tagLocalOnly")}</span>`);
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
    showErr(err);
    return;
  }
  pruneGone(spacesCache.map((s) => s.id)); // Q12 那本账:不在了的空间划掉
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

/** `announce = false` 只给启动时那次「回到上次的空间」用(900 / 应用评审二轮 M7):那不是用户切的 —— 设置里换语言会重载页面,
 *  重载完这儿把人送回原来的空间,却冒一句「已切换到 …」;冷启动落在非默认空间时同一句。用户自己切(含新建后自动切、深链定位)照旧说。 */
async function switchSpace(id: string, announce = true) {
  showChrome(); // 换空间:顶栏露着(890)
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
    // 159 / W3 Q6(WM-17):切过去说一声(此前只有新建空间说话;同桌面 notebook.switchedTo)。
    // 新建空间那条路随后会用「空间已创建」顶掉这一句(同一条通道,后来的赢)。
    const now = spacesCache.find((s) => s.id === id);
    if (announce && getCurrentSpace() === id && now) showBar(t("main.switchedTo", { name: spaceLabel(now) }), true);
  } catch (err) {
    showErr(err);
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
  docs: "docs-pane",
  trash: "trash-pane",
  sealed: "sealed-pane",
  topics: "topics-pane",
  settings: "settings-pane",
  diag: "diag",
  // 设置的二级页(906):名字 = 那一页的元素 id;都只从设置首页的入口行进(openSubPane)。
  "set-compress": "set-compress",
  "set-remind": "set-remind",
  "set-alias": "set-alias",
  "set-backup": "set-backup",
  "set-about": "set-about",
};
let activePane: string | null = null;
/** 子页的上一层(161 / W4 A11,WM-02 / N-2):从设置点进「空间…」「诊断」、从同步点进「空间…」、
 *  同步红条点「网络自检」进诊断 —— 这几跳是「面里的下一层」,返回键该回到点进来的那一层(此前越过它、直接落回底下那页;
 *  从同步红条进诊断再返回,同步面板也没了)。栈底 = 最先开的那一面;每格记着离开时滚到哪儿,回去时还原。
 *  ⭐ 整段仍只占**一枚**守门条目(面换面同层那条不变):返回弹掉它时回上一层并补压一枚(同长文面「回上一页」那一支);
 *  用户自己点别处走开(顶栏 / 底栏 / 换面)= 栈清空,一次 settleHistory 就平了,不留「按一下没反应」的空炮。 */
let paneStack: { name: string; y: number }[] = [];

/** 底栏「长文」按数据显形(用户 2026-10-29 拍「有长文才出现」):真值每轮 refresh 随时间轴快照更新;
 *  初值 false = 未证实有长文就不显(空库首帧不闪)。
 *  ⭐ 「回收站」「归档」两格 159 起**常在**(W3 走查 Q2,用户拍 ①;WM-08 / X-10):此前它俩也按数据显形(408-A1),
 *  清空回收站之后那一格当场没了、想进空回收站无路,而它一出一没其余几格都跟着挪位。空的时候点进去,页里自己说「是空的」。 */
let hasDocs = false;
/** 这一次进长文面那一刻有没有长文(161 / W4 A36,WM-28):「那一面开着时钮保显」只给**有长文时进来**的那一趟。
 *  零篇时从记一笔「长文」进来、一个字没写就退出 —— 此前底栏凭空冒出一格「长文」,回随记又没了。 */
let docsCellPinned = false;

/** 顶栏四枚入口各开哪一面(161 / W4 Q11,WM-29 前半):那一面开着时它点亮。 */
const HEAD_PANE: Record<string, string> = { topics: "topics-toggle", search: "search-toggle", sync: "sync-toggle", settings: "settings-toggle" };

/** 底栏高亮的单一渲染点(146 ▲M3):pane 开着高亮 pane 钮,否则高亮当前 mode 钮
 *  ——popstate/closePaneNow 关面后必须回到 mode 高亮,不能清光。「长文」的显形也收在这里:
 *  那一面正开着时钮保显(否则最后一篇删掉的那一刻,高亮着的关面入口凭空消失)—— 只限进来时就有长文的那一趟(A36)。
 *  161 / W4 Q11(WM-29):顶栏那四枚入口的点亮也收在这里(同一个渲染点,开关面的每条路都会走到);子页亮它的上一层。 */
/** 「空间」「诊断」两页顶上那枚回上一层的钮(907 T13①):这两页有好几个来路(设置 / 同步 / 顶栏徽章 / 错误条里的「网络自检」),
 *  所以字不写死 —— 写上一层那一面自己的标题(从设置进来 = 「设置」,与另外五张二级页同形);没有上一层就不出。
 *  跟着 paneStack 走:每次它变了都会重画底栏(renderBottomBar),挂在那儿。点它走的是 `[data-set-back]` 那条现成的路。 */
function paintSubBack(): void {
  const parent = paneStack.length > 0 ? paneStack[paneStack.length - 1].name : null;
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-sub-back]")) {
    const title = parent === null ? null : $(PANE_EL[parent]).querySelector("h2")?.textContent ?? null;
    b.hidden = title === null;
    if (title === null) continue;
    b.querySelector("span")!.textContent = title;
    b.setAttribute("aria-label", parent === "settings" ? t("settings.back") : t("cardpanel.back"));
  }
}

function renderBottomBar() {
  paintSubBack();
  document.querySelectorAll<HTMLButtonElement>("#bottombar button").forEach((b) => {
    // 长文(第 4 格):主内容,站在分隔线左边、不算覆盖面。
    if (b.dataset.pane === "docs") b.hidden = !hasDocs && !(activePane === "docs" && docsCellPinned);
    b.classList.toggle(
      "active",
      activePane !== null ? b.dataset.pane === activePane : b.dataset.mode === viewMode,
    );
  });
  // 子页点亮它的根(设置 → 空间… 亮「设置」);根不在顶栏(回收站 / 归档点进来的搜索,A46)就亮它自己。
  const root = paneStack.length > 0 && paneStack[0].name in HEAD_PANE ? paneStack[0].name : activePane;
  for (const [pane, id] of Object.entries(HEAD_PANE)) {
    const on = root === pane;
    $(id).classList.toggle("on", on);
    $(id).setAttribute("aria-pressed", String(on));
  }
}

/** 开面前时间轴滚到哪儿(用户面 79 / ui-guidelines §3.6 第一条:「openPane 记 scrollY,
 *  closePaneNow 后恢复」)。⚠ 这一端的面板与时间轴共用**文档滚动**,`pane-open` 把
 *  `.compose`/`#filterbar`/`#timeline` 一起 display:none ⇒ 文档变矮、`scrollY` 被浏览器
 *  钳到新的文档底,**面板于是从时间轴停的那一段开始显示**(真机 CDP 量:时间轴在
 *  `scrollTop=1200` 时开标签面,页面停在 550,标签面第一行落在视口上方 405px、前几枚在屏外)。
 *  面板是另一堆内容,不是时间轴的续篇 ⇒ 开面归零、关面还原。 */
let timelineScrollY = 0;

/** 哪几个面**离开再回来**要回到上次读到的地方(159 / W3 A17,WM-12:回收站划到中段 → 点「随记」→ 再点「回收站」,
 *  此前回到顶,连续整理要每次从头划)。其余面照旧从自己的顶部开(79):设置 / 同步这类是「一张表」,
 *  从头看才对。离开那一刻记、开面那一刻还;切空间整个作废(另一份内容,偏移量没有意义)。 */
// 159 / W3 A17 搜索那半(WM-12 C / WD-28 同形):从结果点进去再回来、或顶栏再开一次,结果列表别回到顶。
// 161 / W4 Q11(WM-29 后半)一度让设置也回到上次读到的位置;903(用户拍)改回:**每次打开设置都从最上面开始**。
// ⚠ 从设置进子面(诊断 / 备份…)再返回时回原位置的那条不归这张表管(paneStack 自己记的 y,backToParentPane 还),照旧。
const KEEP_PANE_SCROLL = new Set(["trash", "search"]);
let paneScrollY: Record<string, number> = {};
function rememberPaneScroll(): void {
  if (activePane !== null && KEEP_PANE_SCROLL.has(activePane)) paneScrollY[activePane] = window.scrollY;
}

/** 从 `activePane` 那一面点进它的下一层 `name`(见 paneStack)。没开着面时就是普通开面。 */
function openSubPane(name: string): void {
  const parent = activePane;
  const y = window.scrollY;
  const keep = paneStack;
  openPane(name);
  if (activePane !== name || parent === null || parent === name) return; // 被闸挡下 / 本来就不在面里:不是子页
  paneStack = [...keep, { name: parent, y }];
  renderBottomBar(); // 顶栏点亮的是上一层(openPane 里那次画的时候栈还是空的)
}

/** 正在「回上一层」(openPane 据此不复位那一面的表单:回到的是刚才那张表,161 / W4 A50)。 */
let returningToParent = false;

/** 回上一层:换回那一面、滚回离开时的位置。守门条目由调用方处置(popstate 补压 / 挂账照留)。 */
function backToParentPane(): void {
  const keep = paneStack;
  const prev = keep[keep.length - 1];
  returningToParent = true;
  try {
    openPane(prev.name);
  } finally {
    returningToParent = false;
  }
  if (activePane !== prev.name) {
    paneStack = keep; // 被开面那几道闸挡下(切换编排 / 记下在飞 / 卡片草稿):还停在子页,上一层照旧记着
    return;
  }
  paneStack = keep.slice(0, -1);
  renderBottomBar();
  window.scrollTo({ top: prev.y });
}

/** 关面回时间轴的 DOM 部分(143 拆出):popstate(返回键)与 UI 关面共用;
 *  history 账目由调用方处置——UI 关面随后 settleHistory(),popstate 已经弹掉。 */
function closePaneNow() {
  showChrome(); // 关面回到时间轴:顶栏露着,往下划再收(890)
  // 备份码仪式还开着就让后端把那把**只在内存里**的钥丢掉(盘上此刻什么都没写过 ⇒
  // 下次是干净的首次使用)。⛔ 反过来「先落盘再让用户抄」会留下一把没人抄过的钥。
  if (activePane === "set-backup") backup.closeBackup(); // 906:备份那一节住进了自己的二级页
  if (activePane === "docs") closeDocs(); // 编辑器开着就落一版(不等;没写进去草稿还在)
  rememberPaneScroll();
  activePane = null;
  paneStack = []; // 子页那几层随面一起收(A11)
  hideConfirmBar(); // 关面 = 放弃面内挂着的两拍确认(ui-audit P0 #4)
  dropErrorBar(); // 164:同上,别盖在时间轴顶上
  for (const id of Object.values(PANE_EL)) $(id).hidden = true;
  document.body.classList.remove("pane-open"); // 恢复 compose+时间轴
  // 折叠上限跟着界面字号重算(705)。⛔ 夹在这两行**中间**不是随手放的:上一行之后时间轴
  // 才量得到真高(隐藏时行高读得出、但那趟白算),而它会改文档高度 ⇒ 必须赶在下面 scrollTo 之前。
  resettleFolds("#timeline");
  restoreBoardScroll(); // 889:时间轴 display:none 那一段把看板各列的滚动位置清了 ⇒ 摆回去(不是看板时空操作)
  // 还原开面前的位置 —— ⛔ 必须在上一行**之后**:时间轴还 display:none 时文档不够高,
  // 滚过去会被当场钳回文档底(正是本条要修的那个钳)。
  window.scrollTo({ top: timelineScrollY });
  renderBottomBar();
}

/** `landing` = 从搜索结果跳过来的那一面(A3):守门条目沿用「回搜索」那一枚、不另压,`searchReturn` 留着。
 *  其余开面(用户自己点的)一律把 `searchReturn` 清掉:那枚条目从此归新开的面用(时间轴上开面时不另压)。 */
function openPane(name: string, landing = false) {
  if (switching || captureSaving) return; // 146 ▲▲M3:切换编排/保存在飞期间面不动
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  if (activePane === name) {
    closePaneNow(); // 再点同一入口 = 收面(toggle)
    settleHistory();
    searchReturn = null; // 落点那一面被用户自己收了:那唯一一枚条目上一行已平掉,不再回搜索
    return;
  }
  const wasOpen = activePane !== null;
  // ⚠ 只在「从时间轴进面板」那一次记账:面换面同层,此刻的 scrollY 是**上一个面板**的
  // 位置,记了就把时间轴那个数冲掉(关面还原到面板的偏移量 = 更怪的一跳)。
  if (!wasOpen) timelineScrollY = window.scrollY;
  if (activePane === "set-backup") backup.closeBackup(); // 面换面同理(toggle 那条走 closePaneNow;回设置首页也算离开)
  if (activePane === "docs") closeDocs(); // 面换面同理
  rememberPaneScroll(); // 面换面:离开的那一面若要记位置,此刻记(159 / A17)
  activePane = name;
  paneStack = []; // 用户自己换了一面 = 不再是谁的子页(A11);openSubPane / backToParentPane 随后自己写回
  if (name === "docs") docsCellPinned = hasDocs; // A36:进来那一刻有长文,这一趟「长文」格才保显
  hideConfirmBar(); // 面换面:上一面挂着的确认作废
  dropErrorBar(); // 164:上一面的错误条别盖在这一面的钮上
  for (const [key, id] of Object.entries(PANE_EL)) $(id).hidden = key !== name;
  document.body.classList.add("pane-open"); // 开面板接管视图:收 compose+时间轴
  // 面板从自己的顶部开始(79);面换面同样归零。KEEP_PANE_SCROLL 里那几面回到上次读到的地方(159 / A17)——
  // 列表 DOM 是上次画的、还在,先滚过去;新数据到了原地换,换的时候保滚动位(panes.ts renderTrash)。
  window.scrollTo({ top: KEEP_PANE_SCROLL.has(name) ? (paneScrollY[name] ?? 0) : 0 });
  renderBottomBar();
  // 首层才压守门条目;面换面同层,返回键一次回时间轴。从搜索跳来的那段已经握着一枚(A3)⇒ 不另压:
  // 落点开面沿用它(`landing`),用户自己再开别的面就把它接过去当自己的(searchReturn 随即清掉)。
  if (!wasOpen && searchReturn === null) pushLayer();
  if (!landing) searchReturn = null;
  if (name === "spaces") {
    spaceMenuFor = null; // 重开面板不带上次的「⋯」展开残留
    // 161 / W4 A50 / A33(WP-22 / N-1):开空间页 = 一张新表 ——「加入空间(输入配对码)」收起、旧码清掉,上次「全部同步」那行也收
    // (状态变了,那句话就过时了)。⚠ 从它的子页(诊断)回来不算:那是回到刚才那张表,表里填了一半的照留。
    if (!returningToParent) {
      resetJoinForm();
      $("sync-all-result").textContent = "";
    }
    void refreshSpaces();
  }
  else if (name === "trash") void panes.loadTrash();
  else if (name === "sealed") void panes.loadSealed(true); // 开面那一下:筛选预选当前看板
  else if (name === "docs") openDocs();
  else if (name === "topics") void topics.loadTopics();
  else if (name === "search") {
    panes.focusSearch(); // 有结果时不抢焦点(那会滚回顶、弹键盘),A17
    // 结果卡按现在的字号重量过一遍(resettleFolds)⇒ 卡高可能变了,位置照上次的再落一次。
    window.scrollTo({ top: paneScrollY.search ?? 0 });
  }
  else if (name === "settings") {
    // 906:首页只剩三排分段钮 + 入口行;各节住进自己的二级页,进那一页才画 / 才读(下面几支)。
    paintThemeSeg();
    paintTextSizeSeg();
    paintLangSeg();
    paintSettingsSummaries();
  }
  else if (name === "set-compress") paintCompressSeg();
  else if (name === "set-remind") {
    paintRemindRow();
    paintRemindPermission();
  }
  else if (name === "set-alias") void loadAlias();
  else if (name === "set-about") void loadAbout();
  else if (name === "set-backup") {
    // 备份一节(§17):⛔ 每次开面都重新问一遍状态 —— 回调不是真相源(进程可能在
    // 系统选择器开着的时候被杀,那时挂在 JS 里的 promise 早就没了)。
    backup.loadBackup();
  }
  else if (name === "diag") {
    // 161 / W4 A10(WM-05 / N-4):**每次进页都现跑**,地址框按当前账户的服务器填(没账户才留上回的 / 渠道默认)。
    // 此前只在第一次进页跑、之后一直挂着那一次的结果,不写时间:同步明明在线,页上还是二十分钟前那个红 ✗,
    // 地址框里是上回手打的地址。⇒ 进页那一刻旧结果就被「正在自检…」换掉,不会把旧的当成现在的。
    // 错误条那枚「网络自检」带着刚才连不上的那台进来(initErr 先写好框再开面),这里不覆盖它。
    if (!probeUrlPinned) {
      const cfg = configuredServer();
      if (cfg) ($("url") as HTMLInputElement).value = cfg;
    }
    probeUrlPinned = false;
    void loadDb();
    void runProbe();
  }
}

// ---- 主视图切换(146 §2.3 状态机) --------------------------------------------

/** 切面落地:翻 mode → placeholder/底栏高亮 → 投影。快照失效(读失败/清屏中)时
 *  不投影旧数据——错误页/载入页保留,顺手触发一次重试(▲▲M2)。 */
function applyMode(target: ViewMode) {
  showChrome(); // 切面 = 刚点过顶栏里的导航:露着(890)
  viewMode = target;
  paintComposePh();
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
  if (hadPane) openPane(activePane!); // toggle 关面(无草稿必然关成;从搜索跳来的那枚条目随之平掉)
  else dropSearchReturn(); // 在落点时间轴上点底栏走开了:不再回搜索(A3)
  if (target === viewMode) {
    // 157 G4 / P8:已在这一面再点一下 = 回顶(长列表读到底下,此前只有点「朱简」两字才回得去)。
    // 已经在顶上才落到老行为(拉起记一笔)。面板刚关的那一下不算(用户是要回这一面,不是要回顶)。
    if (hadPane) return;
    if (document.scrollingElement!.scrollTop > 0) window.scrollTo({ top: 0, behavior: "smooth" });
    else {
      // mbopt R2(第一波小账):这块看板放不进卡时 ＋ 是灰的,这条「一步回捕获」也拦 —— 同点灰 ＋:不开记一笔,说原因。
      const blocked = landingBlocked();
      if (blocked !== null) showError(blocked);
      else ($("text") as HTMLTextAreaElement).focus();
    }
    return;
  }
  // 165 / W5 A27:随记与任务各记各的滚动位置。此前切面不动 scrollY ⇒ 从随记划到中段再点「任务」,看板落在半中间
  // (横放时右边「进行中 3」只剩列头吸着、下面一片空,像是进行中的任务没了);切回来随记也不在刚才那儿。
  modeScrollY[viewMode] = window.scrollY; // 面板刚关的那一下,这里已是关面还原回来的时间轴位置
  applyMode(target);
  window.scrollTo({ top: modeScrollY[target] });
}
/** 两个主视图各自上次滚到哪儿(A27)。只在底栏 / 顶栏点面切换时记、还;换空间清零(另一份内容)。 */
const modeScrollY: Record<ViewMode, number> = { ideas: 0, tasks: 0 };

/** 空间变化的统一复位(实现审 M5):关全部面、activePane 归零、诊断缓存作废
 *  (diagLoaded 跨空间残留会把 A 空间的库信息端给 B)、低频面内容清空。 */
function resetPanesForSpaceChange() {
  // Q6:先把要走的那个空间的视野记下(⚠ 排在关面之前:面开着时时间轴的位置在 timelineScrollY 里)。
  stashSpaceView();
  // 新空间是另一份时间轴 ⇒ 旧空间那个偏移量没有意义,先清账再关面(79)。
  timelineScrollY = 0;
  modeScrollY.ideas = modeScrollY.tasks = 0; // 同上(A27 两个主视图各记的位置)
  closePaneNow();
  paneScrollY = {}; // 同上:各面记的位置是旧空间那份内容的(⚠ 排在关面之后 —— 关面那一下会再记一笔)
  settleHistory(); // 守门条目同轮消掉,不给返回键留「按一下没反应」的空炮
  searchReturn = null; // 「回搜索」那一枚(若有)上一行已平掉;搜索结果是旧空间的,也回不去了
  $("db").innerHTML = `<span class="muted">${t("main.diagLoading")}</span>`;
  $("probe").innerHTML = `<span class="muted">${t("main.probeIdle")}</span>`;
  diagReport.db = [];
  diagReport.probe = [];
  panes.resetPanesForSpaceChange();
  topics.resetTopicsForSpaceChange();
  resetDocsForSpaceChange();
  // 筛选是 A 空间的标签 id/词,绝不带进 B 空间(allFilterTopics 随下轮刷新重取)。
  // 159 / W3 Q6(WM-17):但 B 空间**自己上次**的筛选与读到的位置要还回来(切走再切回,此前两样都没了)。
  restoreSpaceView();
  allFilterTopics = [];
  ($("filter-text") as HTMLInputElement).value = filters[viewMode].text;
}

// ---- 每个空间各记自己的视野(159 / W3 Q6,WM-17)-------------------------------------------
// 切走再切回,筛选(标签 / 类型 / 过滤词 / 列 / 到期)与读到的位置都还原。只记在内存里(同筛选本身:
// 「此刻在看什么」不是设备偏好,重开 app 照旧回全部);落在哪一面不归它管(那是全局的 viewMode,
// 切过去落在切换前那一面,复核员三次实测的规律,不动)。
// ⚠ 标签 id 是那个空间自己的(ULID,跨空间撞不上);还回来时那枚已删 / 合并掉的,由 projectTimeline 的
// reconcile 照常剔掉 —— 而首次投影之前 refreshOnce 已把新空间的 allFilterTopics 取齐,不会被误剔。
type SpaceView = {
  filters: Record<ViewMode, filter.FilterState>;
  taskStageFilter: string | null;
  dueOnly: boolean;
  filterScroll: Record<ViewMode, { was: boolean; y: number }>;
  /** 离开时停在哪一面、时间轴滚到哪儿;回来时落的是同一面才还位置。 */
  at: { mode: ViewMode; y: number };
};
const spaceViews = new Map<string, SpaceView>();
/** 当前这份筛选 / 位置属于哪个空间(切换那一刻 getCurrentSpace 已换成新的,旧的靠它认)。 */
let viewSpace: string | null = null;
/** 新空间首次投影之后要还的位置(refreshOnce 里用掉)。 */
let pendingSpaceAt: { space: string; mode: ViewMode; y: number } | null = null;
const copyFilter = (f: filter.FilterState): filter.FilterState => ({ kind: f.kind, topics: [...f.topics], text: f.text });

function stashSpaceView(): void {
  if (viewSpace === null) return;
  spaceViews.set(viewSpace, {
    filters: { ideas: copyFilter(filters.ideas), tasks: copyFilter(filters.tasks) },
    taskStageFilter,
    dueOnly,
    filterScroll: { ideas: { ...filterScroll.ideas }, tasks: { ...filterScroll.tasks } },
    at: { mode: viewMode, y: activePane !== null ? timelineScrollY : window.scrollY },
  });
}

function restoreSpaceView(): void {
  const space = getCurrentSpace();
  viewSpace = space;
  const v = spaceViews.get(space);
  filters.ideas = v ? copyFilter(v.filters.ideas) : { kind: "all", topics: [], text: "" };
  filters.tasks = v ? copyFilter(v.filters.tasks) : { kind: "all", topics: [], text: "" };
  taskStageFilter = v?.taskStageFilter ?? null;
  dueOnly = v?.dueOnly ?? false; // 到期维同状态维:是那个空间自己的视野
  filterScroll.ideas = v ? { ...v.filterScroll.ideas } : { was: false, y: 0 };
  filterScroll.tasks = v ? { ...v.filterScroll.tasks } : { was: false, y: 0 };
  pendingSpaceAt = v ? { space, ...v.at } : null;
}

/** 远端变更时活动面也要跟上(实现审 M6):回收站/归档册打开着就重载,不给
 *  幽灵条目;搜索维持「显式点搜」契约不自动重跑。 */
function refreshActivePane() {
  if (activePane === "trash") void panes.loadTrash();
  else if (activePane === "sealed") void panes.loadSealed();
  else if (activePane === "docs") reloadDocs();
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
/** `cold` = 冷着陆(159 / W3 A14:从搜索结果、挪到别的空间之后的「去看看」)—— 落点卡挂常亮一会儿再褪的定位框
 *  (`markLocated`),不是 1.2 s 的 `.flash`(那记脉冲在平滑滚动停下之前就过完了,卡落在一串长得一样的卡中间认不出)。
 *  `search` = 从搜索结果来(A3):搜索面只收 DOM、守门条目留着当「回搜索」那一层。`note` = 落点卡上要说的一句(A4)。 */
type FocusOpts = { cold?: boolean; search?: boolean; note?: string | null };
async function focusTimelineCard(id: string, opts: FocusOpts = {}) {
  if (cardPanel.hasDirtyDraft()) {
    showError(t("main.finishDraftFirst"));
    return;
  }
  const space = getCurrentSpace();
  const seq = ++focusSeq;
  const nav = navSeq;
  if (opts.search && activePane === "search") leaveSearch(id);
  else if (activePane) openPane(activePane); // 发起面本身无草稿,必然关成
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
  const target = homeOf(item);
  if (target === "docs") {
    // 长文不在时间轴上:开长文面、直接落到那一篇(面里找不到会自己明说)。
    focusDoc(id);
    openPane("docs", searchReturn !== null && searchReturn.id === id);
    if (opts.note) showBar(opts.note, true); // 长文阅读页没有「卡」可挂那一句,走提示条(A4)
    return;
  }
  if (target === "tasks") {
    // 定位目标被本面专属的两维藏着:各自清自己(标签/文本维的既有行为不动,单轮单件事)。
    // ⚠ 两维合用一次重投影 —— 各投一次会让屏幕连跳两帧。
    let cleared = false;
    // 0043:卡在别的看板上(转待办落默认看板、挪到看板、取消归档回原列…)⇒ 先切到它那块(或收容区)。
    const home = isHeldStage(item.stage) ? HOLDING : boardOfStage(item.stage)?.id;
    if (home === undefined) throw new Error(`task ${id} is on column ${item.stage}, which has no board`);
    if (viewId(currentView(space)) !== home) {
      enterBoard(space, home); // 换看板连带清掉跟着上一块走的筛选(mbopt R5)
      cleared = true;
    }
    if (taskStageFilter !== null && item.stage !== taskStageFilter) {
      taskStageFilter = null;
      cleared = true;
    }
    if (dueOnly) {
      const today = localToday();
      const st = dueAttentionState(item, today);
      if (st !== "today" && st !== "overdue" && !isDueSoon(item, today)) {
        dueOnly = false;
        cleared = true;
      }
    }
    if (cleared && viewMode === "tasks") projectTimeline();
  }
  if (target !== viewMode) applyMode(target); // 快照有效,applyMode 同步投影
  const card = document.querySelector<HTMLElement>(`#timeline [data-id="${id}"]`); // ULID 仅字母数字,选择器安全
  if (!card) {
    showError(t("main.itemGone"));
    return;
  }
  card.scrollIntoView({ block: "center", behavior: "smooth" });
  if (opts.cold) {
    // A4:只在旧版本里命中的,卡上说一句「去哪儿看那一版」(同桌面 locate-note;随下一次重画自然消失)。
    if (opts.note) {
      const p = document.createElement("p");
      p.className = "locate-note";
      p.textContent = opts.note;
      card.querySelector(".body")?.append(p);
    }
    markLocated(card);
    return;
  }
  card.classList.add("flash");
  window.setTimeout(() => card.classList.remove("flash"), 1200);
}

/** 点了搜索结果之后离开搜索面(A3):只收 DOM(记下结果列表滚到哪儿,A17),**守门条目留着** —— 它从此是「回搜索」那一层。 */
function leaveSearch(id: string): void {
  const parents = paneStack; // 搜索是从回收站 / 归档点进来的(A46):回搜索时连那一层一起接回去
  closePaneNow();
  searchReturn = { id, parents };
}

/** 搜索结果点进去(panes.ts onSearchClick → 这里):活条目回时间轴 / 长文定位;回收站 / 归档册的命中切到那一面、
 *  滚到那一条并挂定位框(A14)。落点上按一次返回回到搜索结果(A3)。 */
function jumpFromSearch(hit: SearchHitItem): void {
  if (activePane !== "search" || switching || captureSaving) return;
  // A4:只在改过的旧版本里命中 —— 落点卡上的字里没有那个词,说一声去哪儿看那一版(桌面 search.landedOld* 的手机形)。
  const note = !hit.history_only
    ? null
    : hit.status === "archived"
      ? t("main.landedOldTrash")
      : hit.status === "sealed"
        ? t("main.landedOldSealed")
        : hit.status === "doc"
          ? t("main.landedOldDoc")
          : t("main.landedOld");
  if (hit.status === "archived" || hit.status === "sealed") {
    const pane = hit.status === "archived" ? "trash" : "sealed";
    panes.locateInPane(pane, hit.id, note); // 先登记,开面那趟读完画好就落过去
    leaveSearch(hit.id);
    openPane(pane, true);
    return;
  }
  void focusTimelineCard(hit.id, { cold: true, search: true, note });
}

/** 挪到别的空间之后回执上那枚「去看看」(159 / W3 Q4,WM-18):切到目标空间、落到新生的那一条。
 *  切不过去(有草稿 / 正在切)各自已经说过话,这里就停。 */
async function goSeeInSpace(spaceId: string, itemId: string): Promise<void> {
  if (spaceId !== getCurrentSpace()) await switchSpace(spaceId);
  if (spaceId !== getCurrentSpace()) return;
  await focusTimelineCard(itemId, { cold: true });
}

// 点头部「朱简」= 回时间轴(143):面板开着就收面,和「再点一次入口」同一条 toggle 路。
// ⭐ 604 补:**已经在时间轴上时补上另一半 —— 回到顶部**。此前那一支是空的(没开面板时点它
// 一点反应都没有),而两支说的是同一件事:「朱简」= 回起点,有面板挡着就先收面板,没挡着
// 就回列表顶。⛔ 这不是新功能,是把写了一半的行为补完。
// ⛔ **不做平滑滚动**:条目多时离顶好几屏(用户库里随记 53 条 ≈ 9 屏),smooth 要滚几秒还晕;
// save() 成功后那处回顶用的也是瞬移,两处保持一致。
// ⚠ 回顶入口刻意不放底栏「再点当前 tab」——那个位置已经是「一步回捕获」(onModeButton 里
// `target === viewMode` 那支聚焦输入框),抢过来等于回退一个用户已经在用的手势。
document.querySelector("header h1")!.addEventListener("click", (e) => {
  if ((e.target as HTMLElement).closest("#space-chip")) return; // chip 自己开空间面板
  if (activePane !== null) openPane(activePane);
  else if (boardShown()) {
    // 889:看板上整页不滚、列各滚各的 ⇒ 「回顶」= 每列回到列顶(横向停在哪儿不动)。
    for (const col of $("timeline").querySelectorAll<HTMLElement>(":scope > .tl-group")) col.scrollTop = 0;
  } else window.scrollTo({ top: 0 });
});
// 滚出一屏才让「朱简」底下那条线浮出来(CSS `.seal.totop`)。⚠ 阈值取一屏是有由头的:
// 不到一屏时一划就到顶,提示只会是纯噪音。⛔ 别每帧写 DOM —— 只在**跨过阈值那一刻**改 class;
// passive 监听,别挡滚动。
{
  const seal = document.querySelector("header h1 .seal")!;
  let shown = false;
  const syncToTopHint = (): void => {
    const now = window.scrollY > window.innerHeight;
    if (now === shown) return;
    shown = now;
    seal.classList.toggle("totop", now);
  };
  window.addEventListener("scroll", syncToTopHint, { passive: true });
  syncToTopHint();
}
$("space-chip").addEventListener("click", () => openPane("spaces"));
// 同步页 / 设置里那两枚「空间…」开的是**子页**(161 / W4 A11):返回键回到点进来的那一层。
$("sync-spaces-btn").addEventListener("click", () => openSubPane("spaces"));
// 159 / W3 Q7(WM-16 / X-08):设置里也有一行「空间…」,开的是同一页(同步页那个留着)。此前只有一个空间时
// 顶栏不显示空间名、设置里没有「空间」,入口只挂在「同步」下面,找不到。
$("settings-spaces-btn").addEventListener("click", () => openSubPane("spaces"));
$("topics-toggle").addEventListener("click", () => openPane("topics"));
// 165 / W5 A46(WM-20):从回收站 / 归档点「搜索」= 那一面的子页(paneStack,同设置 → 空间…)—— 点结果、返回两下
// 回到回收站 / 归档(此前落回进它们之前那个主视图)。从别处开照旧是一面。
$("search-toggle").addEventListener("click", () =>
  activePane === "trash" || activePane === "sealed" ? openSubPane("search") : openPane("search"),
);
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
// 165 / W5 Q9:「过滤…」按回车 / 键盘右下那颗键 = 收键盘(结果边打边出,早就在了;此前按了没变化、键盘一直挡着下半屏)。
// 还没到点的那一趟去抖当场投影,收起来看到的就是这个词的结果。组字期的回车是上屏(§3.3)。
$("filter-text").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  if (filterTextTimer !== undefined) {
    window.clearTimeout(filterTextTimer);
    filterTextTimer = undefined;
    projectTimeline();
  }
  ($("filter-text") as HTMLInputElement).blur();
});
$("bottombar").addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("#bottombar button");
  if (!btn) return;
  if (btn.dataset.pane) openPane(btn.dataset.pane);
  else if (btn.dataset.mode) onModeButton(btn.dataset.mode as ViewMode);
});
// 宽屏上导航并进顶栏(tablet-plan 格 3;用户拍 ①A):**把底栏这同一枚元素搬进顶栏**(「朱简」与右边四枚之间),窄屏搬回原位。
// 同一枚 ⇒ 上面那只点击委托、renderBottomBar 的高亮与显形、各台架按 `#bottombar [data-mode=…]` 找钮,一处都不用跟着改。
// 搬的同时在 body 上挂 `widescreen`,index.html「导航并进顶栏」那段全挂在它上面(为什么不进 `@media`、为什么不叫 `wide`,见那段头注)。
// ⚠ 什么时候再问一次宽窄:挂在 window 的 resize 上 —— 面板开着也触发。⛔ 别照抄看板那只盯时间轴的 ResizeObserver:
//   面板开着时时间轴 0 宽、转屏根本不触发,而导航在设置面里转屏也得跟着搬;`body.board` 也只在投影时打、只管任务面。
{
  const nav = $("bottombar");
  const head = document.querySelector("body > header")!;
  const acts = head.querySelector(".head-acts")!;
  // 搬回来的锚:不靠「它原来挨着谁」。标签串写 ASCII —— 注释节点不上屏,但 check-i18n-drift 分不出,中文串会被当成写死的可见文案
  const home = document.createComment("bottombar-home");
  nav.before(home);
  const place = (): void => {
    const wide = isWide();
    if (wide === document.body.classList.contains("widescreen")) return;
    document.body.classList.toggle("widescreen", wide);
    if (wide) head.insertBefore(nav, acts);
    else home.after(nav);
  };
  window.addEventListener("resize", place);
  place();
}
// 键盘起着(焦点在文字输入里 + 视口真缩了)⇒ 根上挂 `kb-up`,两件事吃它(用户面 117,鸿蒙真机量出来的):
//  ①底栏让位:键盘一起视口就真缩(837 → 523),`bottom:0` 的底栏跟着浮到键盘上沿,压住面板里贴着
//    它的输入框(设置页「本机别名」压掉 9.6px);而输入框仍算「在视口里」,浏览器不滚 ⇒ 只能让底栏走开。
//    用 visibility 而非 display:底栏实高不变 ⇒ `--nav-h` 不跳、悬浮 ＋ 不跟着掉下来。
//  ②底部层(捕获 / 编辑 / 留言)收掉底边那段 `env(safe-area-inset-bottom)`:手势条此刻压在键盘底下,
//    ArkWeb 却照样报它的高 ⇒ 「记下」那排钮与键盘之间白空一截。安卓原生侧收键盘 inset 时已把它归零
//    (`MainActivity.applyImeInsets()`),那边这条是空操作。
// ⭐ 两个条件缺一不可:
//  - 光看焦点不够:返回键第一下只收键盘、焦点留在框里,底栏就会一直没了;
//  - 光看视口缩不够:分屏 / 窗口拉矮也会缩,那时没人在打字。
// 基准高 = 这个宽度下见过的最高视口(转屏换宽即换基准);缩掉四分之一以上才算键盘在。
// ⛔ 这不是「猜键盘多高」(kbsheet.ts 头上否掉的那套):只问在不在,几何仍全归原生那半。
// ⛔ 别改用 `:has(:focus)`:这一端 WebView 跨度大(见 `.trow.has-kids` 那条)。
// 同一份基准高还管第三件:高屏 `body.tallscreen`(tablet-plan 格 4;index.html「浮窗」那段挂在它上面)。它要的是**窗口**高:
// 打着字、视口比基准矮(= 让给了键盘)时沿用上一次的判断,其余时候照 CSS 的 `--tall` 翻 —— 否则平板横放一打字,
// 视口缩到 600 以下,浮窗就跳成满幅底栏、收键盘再跳回来。这里「矮」不打七五折:让出去多少都不该翻。
// 只在 resize 上问、不在焦点进出时问:那一刻键盘还没起 / 还没落完,视口是半截的,问了就是一次「浮窗 → 底栏 → 浮窗」的闪。
{
  let baseW = 0;
  let baseH = 0;
  // 每个宽度见过的最高视口(165 / W5 A25)。此前只记「当前这个宽度」的一份,换宽就拿此刻的高当基准 ⇒ 打着字转屏(键盘一直起着),
  // 新那一向的基准就是让过键盘的矮视口,`kb-up` 当场掉了:长文页头那两排又吸回顶上、压住前几段,底栏浮到键盘上沿。
  // 转回原来那一向时用记着的那份;头一回进这一向、又是打着字转过来的,按「转屏 = 宽高对调」拿上一向的宽当这一向的满高。
  const maxH = new Map<number, number>();
  const isTextEntry = (el: EventTarget | null): boolean =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !/^(button|checkbox|radio|range|file|submit|reset|color)$/.test(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);
  const sync = (focused: EventTarget | null): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== baseW) {
      // ⚠ 对调那一项不能只在「这一向没见过」时用:头一回是打着字转进来的,记下的只有让过键盘的矮视口。
      const typing = isTextEntry(focused) && document.documentElement.classList.contains("kb-up");
      baseH = Math.max(h, maxH.get(w) ?? 0, typing ? baseW : 0);
      baseW = w;
    } else if (h > baseH) baseH = h;
    maxH.set(w, Math.max(maxH.get(w) ?? 0, h));
    document.documentElement.classList.toggle("kb-up", isTextEntry(focused) && h < baseH * 0.75);
  };
  const tall = (): void => {
    if (isTextEntry(document.activeElement) && window.innerHeight < baseH) return;
    document.body.classList.toggle("tallscreen", isTall());
  };
  // 焦点挪进另一个文字输入(键盘不落)⇒ 当场照它判。⛔ 焦点离开文字输入(focusout,或 focusin 到钮上)别当场摘,
  // 等键盘真落下来那次 resize 再摘(837,vivo 真点逐事件量过)。
  // 点击的落点是在焦点换走**之后**才判的,而这时键盘还起着、视口还是矮的 ⇒ 当场摘 = 底栏当场在键盘上沿现身、
  // 正好盖住刚点的那一处,点击落到底栏的钮上(长文窄边贴着键盘的那枚缩略图一点,点成了「长文」= 收面)。
  document.addEventListener("focusin", (e) => {
    if (isTextEntry(e.target)) sync(e.target);
  });
  window.addEventListener("resize", () => {
    sync(document.activeElement);
    tall();
  });
  sync(document.activeElement);
  tall();
}
// ---- 转屏保住正看着的那一块(165 / W5 A28 / A29 / A35 / A26)--------------------------------------------------
// 视口一换宽(转屏、分屏拖动),排法跟着变(随记一栏 ↔ 两三栏、看板一列 ↔ 2×2 ↔ 一排四列、设置 360 ↔ 720 阅读宽),而滚动位置
// 只是一个像素数 ⇒ 像素没变,眼前那几张全换了(A28:随记转横,刚才在看的那张得重新找;A35:设置读到中段转屏,位置往回退)。
// ⇒ 平时记着「正看着的那一块」= 可视区上沿(顶栏 + 吸顶筛选条之下)往下第一个露着的块,和它离上沿多远;一换宽,等这一拍排完
// (时间轴那只 ResizeObserver 重投影完),把它摆回同一个偏移(规范 §3.6 那条「重画前记住正看着的那张卡、重画后放回同一偏移」
// 的手机转屏版)。
//  - 块是什么:时间轴上是卡片;**操作面开着时就是开着的那张**,摆完再把面上那排钮摆进来(A29:竖着开的操作面转横后整排钮在屏外、
//    页面不跟着滚,看不出开着还是关了)。面板里是那一面里的卡片(回收站 / 归档 / 搜索),没有卡片就是那一面的直接子块(设置的各节)。
//    长文编辑器自己管(docs.ts::revealCaret,转屏把光标那行摆进来),这里不碰。
//  - ⚠ 记的那一刻必须是**旧**排法:resize 事件来的时候页面已经按新宽排了 ⇒ 平时在**用户**滚动停下 100ms 后记(长文阅读页记到
//    正文顶层那一块),宽度一变就冻住。摆完**不重记**(摆回去那一下的滚动也不算):转过去再转回来,锚还是用户最后看着的那一块,
//    不会每转一次就按新排法换一块、越转越偏。转屏时安卓会连发几次 resize(先换宽、键盘再让一次高),等它们停 120ms 再摆。
//  - 页里的输入框(设置「本机别名」那类)正握着焦点时,摆完再把它那一行(连同旁边那枚「保存」)摆进可见区(A26:横过来框和「保存」
//    都在键盘下面,要等打了字页面才跟着光标露出来)。只在宽或高变了之后做一次;浮层(记一笔 / 编辑 / 留言)、吸顶条、
//    时间轴卡里的输入各有自己的那一套,不碰。
{
  type Anchor = { el: HTMLElement; id: string | null; off: number };
  let anchor: Anchor | null = null;
  let stableW = window.innerWidth;
  let settling: number | undefined;
  let idle: number | undefined;
  let quietUntil = 0; // 摆回去那一下自己引起的滚动,不当成用户滚动重记
  const bandTop = (): number => {
    const cs = getComputedStyle(document.documentElement);
    const head = parseFloat(cs.getPropertyValue("--head-h")) || 0;
    return activePane === null ? head + (parseFloat(cs.getPropertyValue("--fbar-h")) || 0) : head;
  };
  /** 此刻在看的是哪一个容器(时间轴 / 开着的那一面);长文编辑器开着时 null(它自己管)。 */
  const scope = (): HTMLElement | null => {
    if (activePane === null) return $("timeline");
    const root = $(PANE_EL[activePane]);
    return root.querySelector(".doc-area") ? null : root;
  };
  const record = (): void => {
    const root = scope();
    if (!root) {
      anchor = null;
      return;
    }
    const top = bandTop();
    const open = activePane === null ? root.querySelector<HTMLElement>(".panel")?.closest<HTMLElement>("article.card[data-id]") : null;
    // 露着的那几块里**最靠上**的那一块(一样高就取靠左的):多栏时文档序是一栏一栏排的,第一栏里露着的那张未必是最上面那张。
    const firstShown = (els: Iterable<HTMLElement>): HTMLElement | null => {
      let best: HTMLElement | null = null;
      let bt = Infinity;
      let bl = Infinity;
      for (const e of els) {
        const r = e.getBoundingClientRect();
        // 889:看板横滚 ⇒ 屏外那几列的卡也有一样的纵坐标,横向也得露着才算。
        if (r.height === 0 || r.bottom <= top + 1 || r.top >= window.innerHeight || r.right <= 0 || r.left >= window.innerWidth) continue;
        if (r.top < bt - 0.5 || (Math.abs(r.top - bt) <= 0.5 && r.left < bl)) {
          best = e;
          bt = r.top;
          bl = r.left;
        }
      }
      return best;
    };
    const el =
      open ??
      firstShown(root.querySelectorAll<HTMLElement>("article.card[data-id]")) ??
      (activePane === null
        ? null
        : (firstShown(root.querySelectorAll<HTMLElement>(".doc-body > * > *")) ?? firstShown(root.querySelectorAll<HTMLElement>(":scope > *"))));
    anchor = el ? { el, id: el.matches("article.card[data-id]") ? el.dataset.id! : null, off: el.getBoundingClientRect().top - top } : null;
  };
  const restore = (): void => {
    const a = anchor;
    const root = scope();
    if (a && root) {
      // 时间轴重投影会整片重建 ⇒ 卡片按 id 现找;面板里的子块没被重建,还是那一个。
      const el = a.id !== null ? root.querySelector<HTMLElement>(`article.card[data-id="${CSS.escape(a.id)}"]`) : a.el.isConnected ? a.el : null;
      if (el && el.getClientRects().length > 0) {
        quietUntil = performance.now() + 400;
        scrollByFor(el, el.getBoundingClientRect().top - bandTop() - a.off); // 看板上推的是它那一列(889)
      }
      if (activePane === null && root.querySelector(".panel")) cardPanel.revealPanel();
    }
    revealFocusedRow();
  };
  /** 页里那一面(设置 / 同步 / 空间 / 标签 / 搜索)里握着焦点的输入框:它那一行不在可见区就摆进来(A26)。 */
  const revealFocusedRow = (): void => {
    const f = document.activeElement;
    if (activePane === null || !(f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement)) return;
    if (f.closest(".doc-area, .compose, .cmsheet, header") || !f.closest(`#${PANE_EL[activePane]}`)) return;
    const row = f.closest<HTMLElement>(".row") ?? f;
    const r = row.getBoundingClientRect();
    // 留 8 的边;横放打着字时可见那一截只剩四十几(视口 130 − 顶栏 82),一行框就占满,边距收到正好放下为止(两头均分)。
    const room = window.innerHeight - bandTop();
    const pad = Math.max(0, Math.min(8, (room - r.height) / 2));
    const top = bandTop() + pad;
    const bottom = window.innerHeight - pad;
    if (r.bottom > bottom) window.scrollBy(0, Math.min(r.bottom - bottom, r.top - top));
    else if (r.top < top) window.scrollBy(0, r.top - top);
  };
  const onScroll = (): void => {
    if (performance.now() < quietUntil) return;
    clearTimeout(idle);
    idle = window.setTimeout(() => {
      if (settling === undefined && window.innerWidth === stableW && performance.now() >= quietUntil) record();
    }, 100);
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  // 889:看板上滚的是列 / 看板本身,事件不冒泡到 window ⇒ 捕获阶段在时间轴上也收一份。
  $("timeline").addEventListener("scroll", onScroll, { capture: true, passive: true });
  let lastH = window.innerHeight;
  window.addEventListener("resize", () => {
    const wChanged = window.innerWidth !== stableW;
    const hChanged = window.innerHeight !== lastH;
    lastH = window.innerHeight;
    if (!wChanged && settling === undefined) {
      if (hChanged) window.setTimeout(revealFocusedRow, 120); // 只是键盘起落:不动锚,只管握着焦点的那一行
      return;
    }
    cardPanel.holdThroughRelayout(700); // 排完(120)+ 摆回去那一下(400)之前,开着的操作面不按「滚走了」收(A29)
    if (settling === undefined && anchor === null) record(); // 没滚过就转屏:锚还没记过(旧排法已经没了,记个近似)
    clearTimeout(settling);
    settling = window.setTimeout(() => {
      settling = undefined;
      stableW = window.innerWidth;
      restore();
    }, 120);
  });
  // 开面 / 关面 / 切面之后那一面的「正看着的」换了:下一次滚动会重记;开面那一刻先按当时的样子记一份(用户开了面就转屏、一下没滚)。
  for (const id of Object.values(PANE_EL)) {
    new MutationObserver(() => {
      if (settling === undefined && window.innerWidth === stableW) record();
    }).observe($(id), { attributes: true, attributeFilter: ["hidden"] });
  }
}

$("settings-toggle").addEventListener("click", () => openPane("settings"));
$("settings-diag-btn").addEventListener("click", () => openSubPane("diag"));
// 906:设置首页的入口行 → 各自的二级页(设置的子页:返回键回首页、回到进去前的滚动位置,同「诊断」那一跳)。
$("settings-entries").addEventListener("click", (e) => {
  const page = (e.target as HTMLElement).closest<HTMLElement>("[data-set-page]")?.dataset.setPage;
  if (page) openSubPane(page);
});
// 二级页顶上那枚「设置」:与返回键同一条路(回上一层、滚回原位);守门条目不动 —— 整段只占一枚,面还开着(paneStack 头注)。
document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest("[data-set-back]")) return;
  if (paneStack.length > 0 && activePane !== null) backToParentPane();
});

/** 设置首页入口行右边那句摘要(906):每次开首页重读一遍。⛔ 拿不到就空着,不写假值;异步那几样在回来之前留着上一次的
 *  (别先清空再长回来,行尾会闪),读失败 / 这一端没有才清掉。 */
function paintSettingsSummaries(): void {
  const put = (id: string, text: string): void => {
    $(id).textContent = text;
  };
  put("set-sum-spaces", spacesCache.length > 0 ? t("settings.sumSpaces", { n: spacesCache.length }) : "");
  put("set-sum-compress", compressImagesOn() ? t("settings.compressOn") : t("settings.compressOff"));
  if (HAS_NOTIFICATION) {
    const cfg = reminderCfg();
    put("set-sum-remind", cfg.on ? t("settings.sumRemindOn", { time: cfg.time }) : t("settings.sumRemindOff"));
  }
  const space = getCurrentSpace();
  void deviceIdentity(space).then(
    (d) => {
      if (space !== getCurrentSpace()) return;
      put("set-sum-alias", d.devices.find((x) => x.device_id === d.this_device)?.alias ?? "");
    },
    () => put("set-sum-alias", ""),
  );
  void backup.backupSummary().then(
    (text) => put("set-sum-backup", text ?? ""),
    () => put("set-sum-backup", ""),
  );
  void getVersion().then(
    (v) => put("set-sum-about", `v${v}`),
    () => put("set-sum-about", ""),
  );
}

// 意见反馈的复制钮(国内上架 17)。⭐ **地址从那个 input 的 value 读**,⛔ 不在这儿再写一份
// 常数 —— 静态壳里那一处是唯一出处,写两份就是等着它们哪天各说各的。
// 161 / W4 A19(WM-10):回执改走顶上那条会自己收的提示条(同同步面「账户号已复制」)。此前插进本节的 #feedback-msg,
// 把下面「关于」整节往下推、而且一直挂着(四分钟后、去别页转一圈回来都在)。
// ⚠ 复制失败那句刻意告诉用户「长按选中手动复制」—— 地址是 readonly input,选得中,
// 这条路真的走得通(同 sync.copyFailed / devices.copyFailed 那两句)。
$("feedback-copy").addEventListener("click", () => {
  const mail = ($("feedback-mail") as HTMLInputElement).value;
  writeClipboard(mail).then(
    () => showBar(t("feedback.copied"), true),
    () => showError(t("feedback.copyFailed")),
  );
});
// 161 / W4 Q11(WM-32 前半):邮箱点了拉起写信。⚠ 只在交得出网址的端(HAS_BROWSER):安卓走真插件;鸿蒙 W5 A54 起
// 也是 true —— 那一端的 openUrl 被 `ohos/vite.config.ts` 的 opener 接缝换成壳桥 `__zhujianOpener`(平台事实②),
// 没有能接 mailto 的应用时响亮报错(`opener.ts`),不会点了没反应。复制钮两端照留(没有邮件应用的机器靠它)。
// 长按照旧能选中这一框(readonly input),手指一按就走的是 click,不碍选字。
if (HAS_BROWSER) {
  const mailBox = $("feedback-mail") as HTMLInputElement;
  mailBox.classList.add("mail-link");
  mailBox.addEventListener("click", () => {
    void openUrl(`mailto:${mailBox.value}`).catch((err) => showErr(err));
  });
}
// 161 / W4 Q11(WM-32 前半):「关于」那句里的「意见反馈」—— 滚到那一节。
// 906:「关于」住进了二级页、意见反馈留在首页 ⇒ 先回首页(同返回键那条路),再滚到那一节。
$("about-feedback-link").addEventListener("click", () => {
  if (paneStack.length > 0 && activePane === "set-about") backToParentPane();
  if (activePane !== "settings") return; // 被开面那几道闸挡下
  $("feedback-title").scrollIntoView({ block: "start" });
});

// 明暗三档(250):点哪档写哪档,高亮回来按当前档整排重画(单一渲染点,不在点击处
// 各自 toggle);立刻生效,没有确认也没有回执——手势即回执,整屏换色就是最大的回执。
$("theme-seg").addEventListener("click", (e) => {
  const m = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme-mode]")?.dataset
    .themeMode;
  if (!m) return;
  setThemeMode(m as ThemeMode);
  paintThemeSeg();
});

/** 设置里那几排分段钮(明暗 / 字号 / 语言 / 压缩大图 / 截止提醒)的选中态:样子(朱底 + 加粗)之外,读屏也要读得出哪一段是选中的
 *  (165 / W5 A41 查到手机这头:此前只有样子、没有 aria-pressed,读屏念不出;规范「状态不单靠颜色」)。 */
function markSeg(b: HTMLButtonElement, on: boolean): void {
  b.classList.toggle("on", on);
  b.setAttribute("aria-pressed", String(on));
}

function paintThemeSeg() {
  const now = currentThemeMode();
  $("theme-seg")
    .querySelectorAll<HTMLButtonElement>("[data-theme-mode]")
    .forEach((b) => markSeg(b, b.dataset.themeMode === now));
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
    .forEach((b) => markSeg(b, b.dataset.textsize === now));
}

// 语言三档(358 第②笔):同上两排的形,只是回执不同——生效语言真变了就 reload
// (i18n.ts 里判),此时整页换文案就是回执;auto↔解析同语言时页面不动,只刷高亮。
// 161 / W4 A13(WM-06):重载完回到设置的语言那一行(此前不管从哪页进的,一律落到随记、要再开设置从头划)。
// 只记一笔在 sessionStorage(本窗重载活得过、进程没了就没了),启动收尾时消费(init 末尾)。
$("lang-seg").addEventListener("click", (e) => {
  const c = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-lang]")?.dataset.lang;
  if (!c) return;
  if (setLangChoice(c as LangChoice)) {
    sessionStorage.setItem(REOPEN_AT_KEY, "lang");
    reloadFromBase();
    return;
  }
  paintLangSeg();
});

/** 重载整页(改语言那一下),**先把守门条目退干净**(161 / W4 A13,V1986A 真机逮到):设置面开着就压着一枚条目,
 *  直接 reload 的话那几枚成了「上一个文档」的会话历史 —— WebView 从此自己接返回键去后退(= 再重载一遍),
 *  时间轴上按返回退不出 app(此前改语言本来就有这一形,只是重载完落在随记、没人连按到那一下)。
 *  ⇒ 退回底那一格再重载:底下没有东西,返回键照旧回原生那条路。popstate 不来就照样重载(语言已经存了,页面必须换)。 */
function reloadFromBase(): void {
  if (histDepth === 0) {
    location.reload();
    return;
  }
  // ⚠ 捕获期 + 截住:不让 main 那只 popstate 去关面(马上就重载,关了只是一闪)。
  window.addEventListener(
    "popstate",
    (ev) => {
      ev.stopImmediatePropagation();
      location.reload();
    },
    { once: true, capture: true },
  );
  history.go(-histDepth);
  window.setTimeout(() => location.reload(), 1500);
}

/** 重载之后要回到哪儿(A13)。今天只有一个值:"lang" = 设置面的语言那一行。 */
const REOPEN_AT_KEY = "zhujian.reopen-at";

function paintLangSeg() {
  const now = currentLangChoice();
  $("lang-seg")
    .querySelectorAll<HTMLButtonElement>("[data-lang]")
    .forEach((b) => markSeg(b, b.dataset.lang === now));
}

// 压缩大图(用户面 147):开 / 关两档,默认关;同上两排的形,规则在 images.ts。
$("compress-seg").addEventListener("click", (e) => {
  const c = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-compress]")?.dataset.compress;
  if (!c) return;
  setCompressImages(c === "on");
  paintCompressSeg();
});

function paintCompressSeg() {
  const on = compressImagesOn();
  $("compress-seg")
    .querySelectorAll<HTMLButtonElement>("[data-compress]")
    .forEach((b) => markSeg(b, (b.dataset.compress === "on") === on));
}

// ---- 截止提醒(用户面 39①;调度与水位在 reminder.ts,那儿的文件头写着范围与两处端间差异)----
//
// ⭐ 这里只有两样东西:**设置面那一节的接线**,与**「今天该报什么」那把尺**(下面的
// `dueDigest`)。尺留在本文件是刻意的 —— 它必须与任务面那枚汇总钮(558)逐字同源,
// 而 `dueAttentionState` / `dueSummaryLabel` 都在这儿。

/** 喂通知的那句话;null = 今天没有逾期 / 今天到期(⇒ 不响)。说的那句 158 G3 / Q10 起是汇总钮的整句
 *  `dueSummaryFullLabel`(带「3 天内 K」,用户 2026-11-01 取 ★);响不响的判据没变,理由见 reminder.ts 文件头。 */
function dueDigest(tasks: TaskItem[], today: string): string | null {
  let late = 0;
  let now = 0;
  let soon = 0;
  for (const it of tasks) {
    // ⚠ `list_tasks` 那条前端契约里这一列叫 `status`,时间轴那条叫 `stage`(同一列两个名字,
    // ㉞ 起的既有契约)⇒ 这里显式换个名再喂尺,⛔ 别去改 `dueAttentionState` 的入参形
    // (它同时喂着卡片那颗 due chip,而那条路拿到的是 `stage`)。
    const row = { stage: it.status, due_on: it.due_on };
    const st = dueAttentionState(row, today);
    if (st === "overdue") late++;
    else if (st === "today") now++;
    else if (isDueSoon(row, today)) soon++;
  }
  // 158 G3 / Q10(WM-09):通知那句与任务面汇总钮逐字同一句(补上「3 天内 K」)—— 点通知进去看到的正是那一批。
  // ⚠ 响不响仍只看逾期 + 今天(「只在真出事时才说话」那条不变):只有 3 天内的日子照旧不响。
  return late + now === 0 ? null : dueSummaryFullLabel(late, now, soon);
}

function paintRemindRow() {
  // 161 / W4 Q9:说明里那个天数与任务面到期钮同一个常数(静态壳里留空,理由见 index.html 那一行)。
  // 901:第一句常显(#remind-sub),带天数的那几句住进节下的「说明」折叠(#remind-more)。
  $("remind-sub").textContent = t("reminder.sub");
  $("remind-more").textContent = t("reminder.more", { days: DUE_SOON_DAYS });
  const cfg = reminderCfg();
  $("remind-seg")
    .querySelectorAll<HTMLButtonElement>("[data-remind]")
    .forEach((b) => markSeg(b, (b.dataset.remind === "on") === cfg.on));
  const time = $("remind-time") as HTMLInputElement;
  time.value = cfg.time;
  time.disabled = !cfg.on;
}

/** 开着却被系统拒着(122):提醒默认开、到点才要权限 ⇒ 拒过一次之后设置面此前照样亮着「开」,
 *  而到点一声不响。⇒ 每次开设置面照实问一遍(⛔ 不弹框),拒着就把那句人话挂出来。
 *  ⚠ 只挂在开面那一下,不挂进 `paintRemindRow`:拨到「开」那一拍正要弹授权框,这边抢先
 *  问到的「还没许」会在框上面先闪一行红字。 */
function paintRemindPermission(): void {
  if (!HAS_NOTIFICATION || !reminderCfg().on) return;
  void notifyPermissionGranted().then((ok) => {
    const denied = t("reminder.permDenied");
    if (!ok && reminderCfg().on) showRemindMsg(denied, true);
    else if (ok && $("remind-msg").textContent === denied) showRemindMsg("", false); // 去系统设置开过了
  });
}

function showRemindMsg(text: string, bad: boolean) {
  const msg = $("remind-msg");
  if (text === "") {
    msg.hidden = true;
    return;
  }
  msg.textContent = text;
  msg.classList.toggle("warn-ink", bad); // 红字走修饰类(同 alias-msg;样式住样式层,门禁看得见)
  msg.hidden = false;
}

$("remind-seg").addEventListener("click", (e) => {
  const c = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-remind]")?.dataset.remind;
  if (!c) return;
  const on = c === "on";
  saveReminderCfg({ ...reminderCfg(), on });
  paintRemindRow();
  if (!on) {
    showRemindMsg("", false);
    return;
  }
  // 拨到「开」的那一刻就把权限问清:被系统拒着的话,到点才发现「怎么一直没响」是最糟的形。
  // ⚠ 安卓 13+ 这一记会真的弹系统授权框(桌面上通常已授、静默过)。
  void notifyPermissionOk().then((ok) => showRemindMsg(ok ? "" : t("reminder.permDenied"), !ok));
});

$("remind-time").addEventListener("change", () => {
  const time = $("remind-time") as HTMLInputElement;
  // 清空时 value 是 "":不落半配置,回显已存值(同桌面)。
  if (!/^\d{2}:\d{2}$/.test(time.value)) {
    paintRemindRow();
    return;
  }
  saveReminderCfg({ ...reminderCfg(), time: time.value });
  showBar(t("reminder.saved", { time: time.value }), true); // 回执走提示条(161 / W4 A19),⛔ 别插进页面推走下面那几节
});

// 「试一条」的回执同上走提示条(A19,WM-10:此前那行「已发送,请下拉看通知栏」两分钟后还挂着,像刚发生)。
// 发不出去的那句照旧留在本节(#remind-msg):那是要人去处置的状态(多半是系统没许通知),不是一闪而过的回执。
$("remind-test").addEventListener("click", () => {
  const btn = $("remind-test") as HTMLButtonElement;
  btn.disabled = true;
  sendTestNotification()
    .then(() => {
      showRemindMsg("", false);
      showBar(t("reminder.testSent"), true);
    })
    .catch((e) => showRemindMsg(errText(e), true))
    .finally(() => {
      btn.disabled = false;
    });
});

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
    // 没起名时,id 前几位是这台设备唯一能自证身份的东西。**卡片上刻意不显 id 片段**
    // (那是噪音),但这里的语境正是「这是哪台」,显它才有用。
    // 161 / W4 A30(WP-15):位数与设备名单显示的一致(名单按「刚好能分开」取最短前缀,两台前 6 位相同就显 7 位;
    // 此前这里固定 6 位,两处对不上)。名册在手就按名册算,没连上过就按本机认得的那几台。
    const ids = rosterIds() ?? d.devices.map((x) => x.device_id);
    const short = shortIds(ids.includes(d.this_device) ? ids : [...ids, d.this_device]);
    input.placeholder = t("main.aliasUnnamed", { id: short.get(d.this_device) ?? d.this_device });
    input.disabled = false;
    save.disabled = false;
  } catch (e) {
    showAliasMsg(errText(e));
  }
}

/** 本节里那行红字:只剩**失败**用它(取不到身份 / 后端拒了);成了的回执 161 / W4 A19 起走提示条。 */
function showAliasMsg(text: string) {
  const msg = $("alias-msg");
  msg.textContent = text;
  // 红字走 .warn-ink 类(样式住样式层,门禁看得见)。
  msg.classList.add("warn-ink");
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
    // 161 / W4 A19(WM-10):成了的那句走顶上的提示条(此前插进本节、把「备份」整节往下推还一直挂着);
    // 失败那句照旧留在框下(要人照着改的,贴着框才好找)。
    $("alias-msg").hidden = true;
    showBar(next === "" ? t("main.aliasCleared") : t("main.aliasSaved"), true);
    // A14:本机自己的名字 —— 名单与卡上的来源都读身份面那份快照,改完重读一遍(此前名单要收起再展开才换)。
    void loadIdentity(space).then(repaintDevices);
  } catch (e) {
    input.value = aliasSaved; // 后端拒了(超长等):回显旧值 + 后端原话
    showAliasMsg(errText(e));
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
    // 仅本机的本子没有账户可「重新加入」(与确认条的话术分流同一判据)。
    const wasSynced = spacesCache.find((s) => s.id === id)?.configured;
    spaceViews.delete(id); // Q6:重置 = 另一份内容,记着的筛选 / 位置作废
    try {
      await invoke("reset_space", { spaceId: id });
      forgetGone(id); // Q12:本机这一本的数据删光了,「已不在账户里」那笔账跟着作废
      paintGoneBar();
      showError(wasSynced ? t("main.spaceReset") : t("main.spaceResetLocalOnly"));
      resetSyncTransient(); // 重置空间的出码页等一次性展示随之作废。
      await reconcileForeground(); // 前台可能已落回 main(后端广播为准,这里对账兜底)。
      await refreshSpaces();
    } catch (err) {
      showErr(err);
      await refreshSpaces();
    }
    return;
  }
  if (el.dataset.rename) {
    renamingSpace = true;
    spaceRenameErr = null;
    spaceMenuFor = null; // 进改名态顺带收「⋯」,改完/取消不回弹重置入口(codex L)
    renderSpaceList();
    ($("space-rename-input") as HTMLInputElement | null)?.focus();
    return;
  }
  if (el.dataset.renameCancel) {
    renamingSpace = false;
    spaceRenameErr = null;
    renderSpaceList();
    return;
  }
  if (el.dataset.renameOk) {
    const input = $("space-rename-input") as HTMLInputElement;
    const draft = input.value;
    const name = draft.trim();
    // A11(WD-08 / X-13 同形):没成的两种都留字、框下红字,不弹顶部错误条、不带「出错:」。
    const fail = (msg: string): void => {
      spaceRenameErr = { draft, msg };
      renderSpaceList();
      ($("space-rename-input") as HTMLInputElement | null)?.focus();
    };
    if (!name) {
      fail(t("main.spaceNameRequired"));
      return;
    }
    try {
      await invoke("rename_space", { spaceId: getCurrentSpace(), name });
    } catch (err) {
      // core 的话本来就是人话(「已有同名空间「…」」,213e3c7a);认得出的那几类照旧换成人话(errDetail 不加「出错:」)。
      fail(errDetail(err));
      return;
    }
    renamingSpace = false;
    spaceRenameErr = null;
    await refreshSpaces();
    showBar(t("main.spaceRenamed", { name }), true); // 做完说一声(同桌面 notebook.spaceRenamed)
  }
});
// 改着名的框里一动笔,上一次的红字就收(同标签面 `.tn-err` 那条);字照旧是框里的。
$("space-list").addEventListener("input", (e) => {
  if ((e.target as HTMLElement).id !== "space-rename-input" || spaceRenameErr === null) return;
  spaceRenameErr = null;
  $("space-list").querySelector(".space-err")?.remove();
  $("space-list").querySelector(".space-row.has-err")?.classList.remove("has-err");
});

/** 新建空间那一行框下的红字(A11):`null` = 收起。 */
function paintSpaceNewErr(msg: string | null): void {
  const p = $("space-new-err");
  p.hidden = msg === null;
  p.textContent = msg ?? "";
}
$("space-new-name").addEventListener("input", () => paintSpaceNewErr(null));

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
    paintSpaceNewErr(t("main.spaceNamePrompt"));
    input.focus();
    return;
  }
  const btn = $("space-create") as HTMLButtonElement;
  btn.disabled = true;
  let id: string;
  try {
    id = await invoke<string>("create_space", { name });
  } catch (err) {
    // A11(WD-13 / X-13 同形):重名等建不成的,字留在框里、框下红字(core 原话「已有同名空间「…」」),不带「出错:」。
    paintSpaceNewErr(errDetail(err));
    btn.disabled = false;
    return;
  }
  paintSpaceNewErr(null);
  try {
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
    showErr(err);
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
      // 161 / W4 A33 / Q11(WM-33 / N-1):用提示条说(中性那档:什么都没发生),⛔ 不留在页上 —— 此前那行一直挂着,开了同步再进来还在,说的已经是错的。
      box.textContent = "";
      showBar(t("main.syncAllNoSpaces"), false, true);
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
    showErr(err);
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

/** 诊断面那两段的文字形(161 / W4 Q5:「复制诊断信息」照电脑那份的形 —— 版本 + 构建 / [本机库] / [网络自检])。
 *  画到屏上的同时记一份;切空间时清掉(那是另一个空间的库)。 */
const diagReport: { db: string[]; probe: string[] } = { db: [], probe: [] };
/** 下一次进诊断面时别拿当前账户的服务器盖掉框里那个地址(错误条带着「刚才连不上的那台」进来时置位,A10)。 */
let probeUrlPinned = false;
/** 只认最后一次自检的结果(连点「再测一次」、或进页自动跑与手点叠在一起时,迟到的那次不许盖掉新的)。 */
let probeSeq = 0;

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
    diagReport.db = rows.map(([k, v]) => `${k}: ${v}`);
  } catch (e) {
    const line = t("main.diagDbFailed", { error: errDetail(e) });
    box.innerHTML = `<span class="v warn-ink">${esc(line)}</span>`;
    diagReport.db = [line];
  }
}

async function runProbe() {
  const btn = $("run") as HTMLButtonElement;
  const box = $("probe");
  const url = ($("url") as HTMLInputElement).value.trim();
  // 空框就点(161 / W4 Q5):此前照样跑、结论那句会是「连不上 :…」—— 先说一句、光标进框(同 sync.ts::lacksInput)。
  if (!url) {
    showError(t("sync.needServer"));
    $("url").focus();
    return;
  }
  const seq = ++probeSeq;
  btn.disabled = true;
  box.innerHTML = `<span class="muted">${t("main.probeRunning")}</span>`;
  diagReport.probe = [];
  try {
    const steps = await invoke<ProbeStep[]>("net_probe", { url });
    if (seq !== probeSeq) return;
    // 161 / W4 Q5(WD-22 / WM-13 后半 / X-09):最上面一句人话结论(两端逐字同的那一对键),术语那几行照旧留在下面。
    // 判据 = 六项全过才算「能连上」:前几项是本机的加密件,坏了的话连上也同步不了,说「能连上」就是骗人。
    const ok = steps.every((s) => s.ok);
    const verdict = ok ? t("probe.verdictOk", { url }) : t("probe.verdictFail", { url });
    box.innerHTML =
      `<p class="probe-verdict${ok ? "" : " fail"}">${esc(verdict)}</p>` +
      steps
        .map(
          (s) => `<div class="step ${s.ok ? "ok" : "fail"}">
          <span class="mark">${s.ok ? "✓" : "✗"}</span>
          <span class="name">${esc(s.name)}</span>
          <span class="detail">${esc(s.detail)}</span>
        </div>`,
        )
        .join("");
    diagReport.probe = [verdict, url, ...steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name} — ${s.detail}`)];
  } catch (e) {
    if (seq !== probeSeq) return;
    const line = t("main.probeFailed", { error: errDetail(e) });
    box.innerHTML = `<span class="v warn-ink">${esc(line)}</span>`;
    diagReport.probe = [url, line];
  } finally {
    if (seq === probeSeq) btn.disabled = false;
  }
}
$("run").addEventListener("click", () => void runProbe());

/** 「复制诊断信息」那段文字:形照电脑 `src/about.ts::reportText`(应用名 + 版本 / 构建 / 两段带方括号的小节)。 */
async function diagText(): Promise<string> {
  const v = await getVersion();
  const b = buildStamp();
  const stamp = `${b.commit} · ${formatBuiltAt(b.at)}`;
  return [
    `${t("shell.appName")} v${v}`,
    b.dirty ? t("main.aboutBuildDirty", { stamp }) : stamp,
    "",
    `[${t("shell.diagDbTitle")}]`,
    ...(diagReport.db.length ? diagReport.db : [t("main.diagLoading")]),
    "",
    `[${t("shell.diagNetTitle")}]`,
    ...(diagReport.probe.length ? diagReport.probe : [t("main.probeIdle")]),
  ].join("\n");
}
$("diag-copy").addEventListener("click", () => {
  void diagText()
    .then((text) => writeClipboard(text))
    .then(
      () => showBar(t("main.diagCopied"), true),
      () => showError(t("main.diagCopyFailed")),
    );
});

// ---- 关于(250):这台机上装的是哪一版。手机端此前没处看版本号,排查问题第一句总是
// 「你手机上是几点几」;版本取自 tauri.conf.json,与更新清单 android.json 同源。
//
// ⭐ 701 起多一行**构建身份戳**:用户那台 vivo 从此常年跑未发版的测试包,而它与正式包
// 的 versionName 一模一样 ⇒ 版本号那一行答不出「你手上那只是哪棵树」。为什么要有它、
// 脏是怎么判的,全在 `scripts/lib/build-stamp.mjs` 顶注。
//
// 官网 / 源码 / 更新日志 / 用户指南四行(前三行用户 2026-09-25 拍板,桌面那半同文案;第四行见 loadAbout 里那条):官网与更新日志从渠道接缝的
// `SITE_URL` 拼(国内渠道是 zhujian.cool,⛔ 别写死);源码仓两个渠道同一个。值格摆的是**地址本身**
// —— 交不出浏览器的端(`HAS_BROWSER=false`;今天没有这样的端,鸿蒙 W5 A54 起经壳桥也交得出)上它就是纯文字,用户照抄也能到。
// ⛔ 别把构建身份戳链到 GitHub 提交:那串 sha 是私有工作仓的,公开仓是白名单导出快照、sha 不同,链过去 404。
const SOURCE_URL = "https://github.com/prehisle/zhujian";
function aboutLinkRow(label: string, url: string): string {
  const shown = esc(url.replace(/^https:\/\//, ""));
  const v = HAS_BROWSER ? `<a class="v about-link" href="${esc(url)}">${shown}</a>` : `<span class="v">${shown}</span>`;
  return `<span class="k">${label}</span>${v}`;
}
async function loadAbout() {
  const box = $("about");
  try {
    const v = await getVersion();
    const b = buildStamp();
    // `{stamp}` 是十六进制 + 日期,没有可译的字;只有「含未提交改动」那句要过字典。
    const stamp = `${b.commit} · ${formatBuiltAt(b.at)}`;
    box.innerHTML =
      `<span class="k">${t("main.aboutVersion")}</span><span class="v">v${esc(v)}</span>` +
      `<span class="k">${t("main.aboutBuild")}</span><span class="v mono">` +
      `${esc(b.dirty ? t("main.aboutBuildDirty", { stamp }) : stamp)}</span>` +
      aboutLinkRow(t("main.aboutSite"), SITE_URL) +
      aboutLinkRow(t("main.aboutSource"), SOURCE_URL) +
      aboutLinkRow(t("main.aboutChangelog"), `${SITE_URL}/changelog.html`) +
      // 900(应用评审二轮 M11):用户指南(文档中心 `/docs/`,两个站都有)。同桌面 about.ts `GUIDE_URL` 的做法:
      // 从渠道接缝的 `SITE_URL` 拼,国内包去 zhujian.cool、境外包去 zhujian.app,⛔ 别写死域名。
      aboutLinkRow(t("main.aboutGuide"), `${SITE_URL}/docs/`);
    // 裸 href 会把 WebView 自己导走 —— 一律交给系统浏览器(同更新条「下载」那条路)。
    box.querySelectorAll<HTMLAnchorElement>("a.about-link").forEach((a) =>
      a.addEventListener("click", (e) => {
        e.preventDefault();
        void openUrl(a.getAttribute("href")!).catch((err) => showErr(err));
      }),
    );
  } catch (e) {
    box.innerHTML = `<span class="v warn-ink">${t("main.aboutFailed", { error: esc(errDetail(e)) })}</span>`;
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

/** 有新版就把启动时那条提示亮出来(启动查、回前台查、「关于」里手动查,三条路同一个出口)。 */
function showUpdate(u: MobileUpdate): void {
  updateFound = u;
  $("update-msg").textContent = t("main.updateFound", { version: u.version });
  const notes = meaningfulNotes(u.notes, u.version);
  $("update-notes").textContent = notes;
  $("update-notes").hidden = notes === "";
  $("update").hidden = false;
}

async function initUpdate() {
  if (checkUpdate === null) return; // 这条渠道没有应用内更新(国内商店 / 鸿蒙,channel.ts)
  lastUpdateCheckedAt = Date.now();
  try {
    const u = await checkUpdate();
    if (!u || u.versionCode === updateDismissedCode) return;
    showUpdate(u);
  } catch {
    /* 离线/端点不可达:静默,下次回前台/启动再查。 */
  }
}

// 161 / W4 Q10(WM-31):「关于」里手动查一次。有新版走启动时那条提示(手动查的不管「稍后」记过没有 —— 人是来问的);
// 没有就说「已是最新 vX」;查不成照实说(⛔ 不像启动那次静默:这一下是人按的,得有回音)。
// ⭐ 这一行只在**有应用内更新**的渠道上在:checkUpdate 为 null 的渠道(国内商店包 / 鸿蒙)启动时本来就不查,
//    那里的这枚钮只会永远说「已是最新」—— 由 init 摘掉整行(构建期渠道接缝,不是运行期探测)。
$("update-check").addEventListener("click", () => {
  const check = checkUpdate;
  if (check === null) throw new Error("这条渠道没有应用内更新,「检查更新」那一行本该在 init 里摘掉");
  const btn = $("update-check") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("main.updateChecking");
  lastUpdateCheckedAt = Date.now();
  void Promise.all([check(), getVersion()])
    .then(([u, v]) => {
      if (u) showUpdate(u);
      else showBar(t("main.updateLatest", { version: v }), true);
    })
    .catch((e) => showError(t("main.updateCheckFailed", { error: errDetail(e) })))
    .finally(() => {
      btn.disabled = false;
      btn.textContent = t("shell.checkUpdate");
    });
});

// 回前台查更新的节流:短时间内反复切前后台只查一次,不空转 android.json。
const UPDATE_CHECK_THROTTLE_MS = 10 * 60 * 1000;
let lastUpdateCheckedAt = 0;
function initUpdateThrottled() {
  if (Date.now() - lastUpdateCheckedAt < UPDATE_CHECK_THROTTLE_MS) return;
  void initUpdate();
}
$("update-go").addEventListener("click", () => {
  if (!updateFound) return;
  void openUrl(updateFound.url).catch((err) => showErr(err));
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
    showError(t("main.spaceRenamedRefreshFailed", { error: errDetail(err) }));
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
  // 「展开成长文」回执上那枚「打开」:开长文面直接落到那一篇。
  openDoc: (id) => {
    focusDoc(id);
    openPane("docs");
  },
  focusCard: (id) => void focusTimelineCard(id),
  goSeeMoved: (spaceId, itemId) => void goSeeInSpace(spaceId, itemId),
  // 值 chip 上的截止文字与卡上那颗角标同一支笔(⛔ 别让面板自己算第二份)。
  dueLabel: (due, done) => dueLabel(due, localToday(), done),
});
/** core / coord 原话里的空间名 → 屏上的叫法(161 / W4 A41):coord 给的是名字、「默认空间」(main 没起名时,core 不翻)
 *  或空间 id(非 main 没起名时)。认得出就按这一端的 spaceLabel 说(「未命名空间 · XXXX」、英文档的 Default space),
 *  认不出照原样。 */
function spaceLabelFromCore(raw: string): string {
  const byId = spacesCache.find((s) => s.id === raw);
  if (byId) return spaceLabel(byId);
  if (/^默认空间$/.test(raw)) {
    const main = spacesCache.find((s) => s.id === "main");
    if (main) return spaceLabel(main);
  }
  return raw;
}
// 编辑层(706):正文编辑那座底部层。宿主是 cardpanel(草稿/写口/判弃都在那边),
// 这里只给它返回键层账本的两把手(同留言层与大图查看器的形)。
// 错误文案后面那枚「网络诊断」(err.ts,用户面 126)开的是设置里的「诊断」面,测**刚才连不上
// 的那台**(用户面 137):出错那条路给了地址就用它,否则用当前空间已配置的;两样都没有才留着
// 框里原有的(渠道默认或用户手改的)。面加载过一次之后 openPane 不再自动跑 ⇒ 这里补跑。
// 161 / W4 A10 / A11:诊断面每次进都现跑(openPane 那一支);从同步 / 空间面上的红条进来的,是那一面的**子页**,返回键回去。
initErr((url) => {
  const target = url ?? configuredServer();
  if (target) ($("url") as HTMLInputElement).value = target;
  if (activePane === "diag") {
    void runProbe();
    return;
  }
  probeUrlPinned = true; // 框里刚写的就是要测的那台,开面那一支别再拿当前账户的盖掉
  openSubPane("diag");
  probeUrlPinned = false; // 被闸挡下没开成时也别把这一笔留给下一次
}, spaceLabelFromCore);
initEditSheet({ pushLayer, settleHistory });
initDatePick({ pushLayer, settleHistory });
initMoreSheet({ pushLayer, settleHistory });
// 留言层(314 第③笔):写/删成功即整轴重拉(徽章计数跟着走),开合各压/平一枚返回键守门条目。
initComments({ refresh, pushLayer, settleHistory });
// 长文面(longform-plan 第 4 格):留言走同一个入口;写成功后整轴重拉(底栏「长文」钮跟着显形)。
initDocs({
  openComments: openCommentsFor,
  refreshTimeline: refresh,
  // 161 / W4(M1 留下的那条,A36 的后半):一篇长文都没有时进来、新建的那篇一个字没写就退出 —— 别停在空的长文列表(底栏一格不亮),
  // 回到进长文前那一面(收面;返回键那条路的守门条目由 openPane 的 toggle 一并平掉)。有长文时照旧回列表。
  // ⚠ 判据是「这一趟进来时底栏那一格亮没亮」(docsCellPinned,A36):有长文时进来、把最后一篇删了再新建又不写 ——
  //   那时格子还亮着、列表就是进来的那一面,照旧回列表。
  leaveEmptyNew: () => {
    if (activePane !== "docs" || docsCellPinned) return false;
    openPane("docs");
    return true;
  },
  getSpaces: () => spacesCache,
  goSeeMoved: (spaceId, itemId) => void goSeeInSpace(spaceId, itemId),
});
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
  onBootingChange: () => {
    if (lastRefreshOk) projectTimeline();
  },
  onGoneChange: () => {
    paintGoneBar();
    renderSpaceChip();
    renderSpaceList();
  },
  renameSpace: (id) => {
    // Q13:回执上那枚「改名」—— 开空间页、那一行进改名态(只有当前空间改得了名;回执只在切过去之后才挂这枚)。
    if (id !== getCurrentSpace()) return;
    if (activePane !== "spaces") openPane("spaces");
    if (activePane !== "spaces") return; // 被开面那几道闸挡下
    renamingSpace = true;
    spaceRenameErr = null;
    spaceMenuFor = null;
    renderSpaceList();
    // ⚠ 开面那一下还挂着一趟列表重拉(openPane → refreshSpaces),它会把这一行重画一遍、焦点跟着丢 ⇒ 等它落地再把光标放进框。
    void refreshSpaces().then(() => ($("space-rename-input") as HTMLInputElement | null)?.focus());
  },
  openFeedback: () => {
    openSubPane("settings");
    if (activePane !== "settings") return; // 被开面那几道闸挡下
    $("feedback-title").scrollIntoView({ block: "start" });
  },
});
// 161 / W4 Q12 ★①:随记页顶那一条(点了进同步页)与同步面里那枚「空间…」(去重置)。
$("sync-gone-bar").addEventListener("click", () => openPane("sync"));
$("sync-gone-spaces").addEventListener("click", () => openSubPane("spaces"));
initCardSwipe({
  getItem: (id) => lastItems.get(id),
  getCurrentSpace,
  isSwitching: () => switching,
  hasDirtyDraft: () => cardPanel.hasDirtyDraft(),
  refresh,
});
initBoardScroll(() => shownBoardKey); // 横滚位置按「空间 + 看板」各记(mbopt M4)
initChromeHide();
initCardDrag({
  getItem: (id) => lastItems.get(id),
  getCurrentSpace,
  isSwitching: () => switching,
  hasDirtyDraft: () => cardPanel.hasDirtyDraft(),
  dueSorted: () => dueOnly,
  order: () => boardOrder,
  refresh,
  onDone: () => {
    if (refreshDeferred && !cardPanel.hasDirtyDraft()) {
      refreshDeferred = false;
      void refresh();
    }
  },
});
initTaskMove({
  order: () => boardOrder,
  refresh,
  focusCard: (id) => void focusTimelineCard(id),
  isSwitching: () => switching,
  getCurrentSpace,
});
panes.initPanes({
  refreshTimeline: refresh,
  focusCard: (id) => void focusTimelineCard(id),
  jumpFromSearch,
  getSpaces: () => spacesCache,
  // 907 T13②:搜索结果只带标签名(core 的 search 不回颜色)⇒ 按名字到这个空间的全量标签里查(同一空间里标签名唯一)。
  topicColor: (title) => allFilterTopics.find((tp) => tp.title === title)?.color ?? null,
});
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

/** 「这台设备已经同意过隐私政策」。⚠ 与 index.html 头里那段内联脚本**共用同一个键与
 *  同一条判据**(值恰等于 "1"),改一处必须改两处 —— 它们一个管首帧、一个管接线。
 *  纯设备本地、不进同步(同语言 / 明暗 / 字号那一族)。 */
const PRIVACY_KEY = "zhujian.privacy";

/** 首启隐私政策告知(651;华为 2026-09-04 驳回第 3 条)。
 *
 *  已同意 = 立即返回;没同意 = 就挡在这儿,直到用户点「同意」。
 *  ⛔ 点「不同意」时这个 Promise **永不兑现** —— 那是刻意的:`app_exit` 是异步的,
 *  在进程真的没掉之前,后面那些启动动作(装配空间 / 查更新)一步都不该开始跑。
 *  ⚠ 那一页**默认就在场**(静态壳里没有 hidden),所以这里不需要"显示"它,只接线。 */
// ---- 政策全文那一页(651 首启告知开它;161 / W4 A12 起设置「关于」也开它)---------------------------
// ⛔ **不跳浏览器**:鸿蒙上 `openUrl` 会去调 `xdg-open`(它的编译目标是 linux),
// 真机报 `No such file or directory (os error 2)` —— 651 实撞。政策页由构建期插件
// 按渠道烤进产物(三份:隐私政策 / 隐私权利 / 用户协议),这里就地展开;
// `PRIVACY_URL` 只用来告诉用户最新版发布在哪儿(包里这份是构建那一刻的快照)。
//
// 161 / W4 A34 / A11(WM-25 / WM-07 / N-2):
//  · 框里切页签(三份互链)时,上方那行「最新版本发布在」跟着换成正在看的那一份(此前切到「用户协议」仍写 privacy.html);
//  · ⛔⛔ **框从不导航**:页面取回来(`fetch` 包里那一份)写进框里那份初始空白文档(`document.write`),切页签同样重写。
//    框里的导航会进**整页的会话历史**:WM-07 / N-2 那一形(点过几个页签就要多按几下返回、面板上按返回退到后台)就是它;
//    改成 `location.replace` 也不行 —— V1986A 真机量过:框导航过一次之后,我们自己那一记 `history.back()` 有时连
//    popstate 都不发(落点是框里的那一份),账本就卡在「back 在飞」,之后每一记返回都被吞,直到重启。不导航 = 框不进会话历史。
const policyFrame = $("policy-frame") as HTMLIFrameElement;
$("policy-canonical").textContent = PRIVACY_URL; // 首启告知那一页一出来就印着(打开哪一份,下面按那一份改写)
/** 只认最后一次要看的那一份(连点两个页签时,先到的那份不许盖掉后点的)。 */
let policySeq = 0;

/** 把包里的 `page`(三份之一)写进框里。取不到 = 包里那几页不在了(构建坏了),响亮。 */
async function showPolicyPage(page: string): Promise<void> {
  const seq = ++policySeq;
  $("policy-canonical").textContent = new URL(page, PRIVACY_URL).href;
  const res = await fetch(page);
  if (!res.ok) throw new Error(`包里的政策页 ${page} 取不到(HTTP ${res.status})`);
  const html = await res.text();
  if (seq !== policySeq) return;
  const doc = policyFrame.contentDocument;
  if (!doc) throw new Error("政策页框里的文档读不到");
  doc.open();
  doc.write(html);
  doc.close();
  // 165 / W5 A33(WM-15):换一份就从顶上读起 —— 框里那份文档是重写的、滚动位却留着上一份的,切「隐私权利」「用户协议」
  // 从半句话开始、标题在框外,像没切过去。
  policyFrame.contentWindow?.scrollTo(0, 0);
  policyFrame.dataset.page = page; // 现在框里是哪一份(验收资产读它;框的地址恒是初始那份,读不出)
  // 三份互链(policy-asset.mjs 已把其余链接摘掉):点了就把那一份写进来。⚠ `document.open` 会抹掉文档上的监听,每写一次重挂一次。
  doc.addEventListener("click", (e) => {
    const a = (e.target as Element | null)?.closest?.("a[href]");
    if (!a) return;
    e.preventDefault();
    void showPolicyPage(a.getAttribute("href")!).catch((err) => showErr(err));
  });
}

/** 打开政策全文的那枚钮(关掉时焦点还给它,165 / W5 A52)。 */
let policyOpener: HTMLElement | null = null;

/** 打开政策全文,落在 `page`(三份之一)。`from` = 点的那一枚(关掉时焦点还给它)。 */
function openPolicy(page: string, from: HTMLElement): void {
  policyOpener = from;
  $("policy-view").hidden = false;
  void showPolicyPage(page).catch((err) => showErr(err));
}

/** 关政策全文(返回键 / 「关闭」两条路同一个收尾):焦点还给打开它的那枚(165 / W5 A52,§3.5「关掉焦点还给打开它的那枚」)——
 *  此前按返回焦点停在已经藏起来的框里、点「关闭」掉到页面上,外接键盘 / 读屏的人得重新摸。那枚已不在屏上就放下焦点。 */
function closePolicy(): void {
  $("policy-view").hidden = true;
  const back = policyOpener;
  policyOpener = null;
  if (back && back.isConnected && back.getClientRects().length > 0) back.focus({ preventScroll: true });
  else (document.activeElement as HTMLElement | null)?.blur();
}

$("privacy-link").addEventListener("click", (e) => {
  e.preventDefault();
  openPolicy("privacy.html", $("privacy-link"));
});
$("policy-close").addEventListener("click", closePolicy);
// 设置「关于」那三枚(A12)。
document.querySelectorAll<HTMLButtonElement>("[data-policy]").forEach((b) =>
  b.addEventListener("click", () => openPolicy(b.dataset.policy!, b)),
);

function privacyGate(): Promise<void> {
  if (localStorage.getItem(PRIVACY_KEY) === "1") return Promise.resolve();
  return new Promise<void>((resolve) => {
    $("privacy-agree").addEventListener("click", () => {
      localStorage.setItem(PRIVACY_KEY, "1");
      document.documentElement.dataset.privacy = "ok";
      resolve();
    });
    // ⛔ JS 关不掉原生应用 ⇒ 这颗钮唯一的出口是壳里那条命令(mobile/src/shell.rs)。
    $("privacy-decline").addEventListener("click", () => {
      void invoke("app_exit").catch((err) => showErr(err));
    });
  });
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
  for (const [need, has] of [["textzoom", HAS_TEXT_ZOOM], ["saf", HAS_SAF_BRIDGE], ["notification", HAS_NOTIFICATION]] as const) {
    if (has) continue;
    document.querySelectorAll<HTMLElement>(`[data-needs="${need}"]`).forEach((e) => (e.hidden = true));
  }
  // 「检查更新」那一行只在有应用内更新的渠道上在(161 / W4 Q10;理由见那枚钮的监听)。渠道接缝,不是平台接缝 ⇒ 不进上面那张表。
  if (checkUpdate === null) $("update-check-row").remove();
  // 651(渠道接缝):三处服务器地址输入框的默认值来自**渠道**,不再写死在静态壳里
  // (国内渠道连境内那台,境外渠道连 sync.zhujian.app)。⛔ 静态壳里刻意不留 value ——
  // 这段没跑到就是**空框**,而空框会被创号/加入那两条路当场拒(`sync.ts::lacksInput`)。
  // 留个旧值在那儿才危险:那是「不报错、只连去另一台服务器」。
  // 161 / W4 Q3:加入 / 建账户那两格预填「这台最近一次连上的服务器」(从没连上过才是渠道默认,sync.ts::prefillServer);
  // 诊断那一格进页时按当前账户的服务器填(A10),首帧留渠道默认。
  document.querySelectorAll<HTMLInputElement>("input[data-default-server]").forEach((e) => {
    if (e.id === "url") e.value = SYNC_DEFAULT_URL;
    else prefillServer(e);
  });
  // 语言(358 第②笔):壳里保留中文原文防首帧闪(163 契约),这里按生效语言统一
  // 覆写静态文案 + 落 <html lang>。放在启动闸之前——封锁页也要说用户那门语言。
  initLang();
  applyStaticI18n();
  // 165 / W5 A34(WM-07):同步第一屏那句指去「设置 → 备份」—— 没有备份这条路的端(鸿蒙,HAS_SAF_BRIDGE = false)上
  // 那是一句指错路的话,换成这一端的那句(同上面 data-needs 那张表:构建期常数,⛔ 不是运行期探测)。
  if (!HAS_SAF_BRIDGE) $("sync-intro").textContent = t("sync.introOffNoBackup");
  // 651:首启隐私政策告知。⭐ **位置是有讲究的** —— 语言已经生效(告知要说用户那门
  // 话),而后面每一件会碰数据或联网的事(装配空间 / 查更新)都还没开始。
  await privacyGate();
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
      await switchSpace(last, false);
    } else {
      localStorage.removeItem(LAST_SPACE_KEY);
    }
  }
  void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  void pullSharedText();
  void pullDeepLink(); // 冷启动:被 zhujian:// 链接拉起时取走暂存的 URI 并定位(空间已恢复后)
  void initUpdate();
  // 截止提醒(用户面 39①):**接在闸放行与空间恢复之后** —— 它第一件事就是读当前空间的
  // 任务,早了会撞上「正在切换空间」那道响亮拒(那一形只会白丢一拍,但没必要)。
  // ⭐ 装配本身也由 `HAS_NOTIFICATION` 门着(不只是把设置面那一节摘掉):没有通知这条路
  // 的端上,那 30 秒一拍的取数与判定**是纯浪费**,而判定完还会走到 `showNotification`
  // 那个刻意「响亮抛」的桩上去。⇒ 那一端连定时拍都不起。
  if (HAS_NOTIFICATION) initDueReminder(dueDigest);
  void refresh();
  // 161 / W4 A13(WM-06):改了语言、页面重载完 ⇒ 回到设置的语言那一行(那一笔是 lang-seg 的监听在 reload 前写下的)。
  if (sessionStorage.getItem(REOPEN_AT_KEY) === "lang") {
    sessionStorage.removeItem(REOPEN_AT_KEY);
    openPane("settings");
    $("lang-seg").scrollIntoView({ block: "center" });
  }
}

void init();
