// 卡片操作面板(120,codex 设计审+实现审两轮后的形):点时间轴卡片展开行内操作。
//
// ⭐ **706 瘦身**(用户 2026-09-19 当面报「这么多按钮体验太 low」):此前一张任务卡点开
// 就是 **17 个可点的东西**(七枚动作 + 五枚状态 + 日期框 + 四枚优先级),卡片正文两行、
// 操作区五行。病根不是「钮多」,是三件事挤在同一张表上:动词与值长得一模一样、没有频次
// 分层(天天点的「编辑」与一年一次的「历史」等重)、同一件事三条路(滑动 / 勾框 / 五枚状态)
// 而最难看的那条占了最大面积。⇒ 改成**两行**:
//   ① 动作行**四枚封顶** —— 任务:编辑 · 标签 · 留言 · 更多…;随记:编辑 · 标签 · 转待办 · 更多…
//   ② 值 chip 行(仅任务)—— 状态 / 截止 / 优先级 各一枚,**显示当前值**、点开才出候选,
//      选完自己回到 ①。
//   低频那几件(历史 · 移动 · 撤回为随记 · 归档 · 删除 · 随记的留言)收进「更多…」子面,
//   删除排最后、朱砂。数:随记 4 枚 / 任务 7 枚(改前 7 / 17)。
// ⛔ 别把三条 lane 摊回 actions 面 —— 那正是本轮要治的病。⛔ 也别往动作行里加第五枚:
//   四枚是**上限**不是巧合(它要在 360px 屏上排一行、且一眼数得完),新入口进「更多…」。
//
// ⭐ 编辑不在这儿画了(706 第二笔):正文编辑搬进屏底的**编辑层**(`editsheet.ts`),
// 本模块仍是它唯一的宿主 —— 草稿、session 判弃、写口 run() 一个字没挪。
//
// 契约(codex 120 设计审 H1/M7/M8 + 实现审 H1/M2/M3,勿回退):
// - **草稿在 state 不在 DOM**(实现审 H1):editDraft/tagDraft 随 input 事件实时入
//   state,一切重画(busy 禁用态/失败恢复/restore)都从 state 画回——后端失败
//   绝不丢她打了一半的字。
// - **草稿保护**:编辑态恒算脏、标签新建输入非空算脏——main.ts 的 refreshOnce 在
//   查询前与 DOM 写入前都查 `hasDirtyDraft()`,脏则整轮延后;切空间/切面同闸。
// - **判弃 = session 引用**(实现审 M2):异步操作捕获 `session = state` 对象引用,
//   回包检查 `state === session`(同卡关闭再打开是新对象,ABA 天然不成立)+ 空间
//   复核;busy 期间面板一切导航(开合/换卡)在事件入口整体拒。
// - **写与读解耦**(实现审 M3):run() 只包业务写——写成功即安排时间轴 refresh
//   (只要空间没换,与面板 session 是否还在无关);标签列表重读单独跑,失败只
//   提示「标签列表刷新失败」,绝不把已提交的写谎报成失败。
// - **两拍确认**:删除/撤回/入册,第一拍弹底部固定确认条(ui-audit P0 #4:原位换
//   话术会变宽换行+3s 复原,第二拍可能落到毗邻的单拍控件),第二拍在固定条上执行,
//   onYes 复核 session 未变;in-flight 期间整面禁点(防双击重复写)。
// - **外壳投影只有一个同步点**(706):`body.panel-open`(悬浮 ＋ 让位)与编辑层的开合,
//   一律由 `setState` / `setMode` 末尾那记 `syncShell()` 推出去 —— ⛔ 别在别处零散地
//   `state = …` 或 `session.mode = …`,漏一处的样子是「＋ 钮赖着不走」或「编辑层关不掉」。
import {
  addItemImage,
  deleteItemImage,
  archiveNote,
  archiveTask,
  addTaskTopic,
  addTaskTopicByTitle,
  distinctSpaceLabels,
  editNote,
  fileNoteToTopic,
  getCurrentSpace,
  listTopics,
  moveItemToSpace,
  movePartialClear,
  movePartialMark,
  movePartialNote,
  promoteNoteToTask,
  removeNoteTopic,
  removeTaskTopic,
  renameTask,
  restoreNote,
  restoreTask,
  revertTaskToInbox,
  sealTask,
  setTaskDue,
  setTaskPriority,
  unsealTask,
  updateTaskStatus,
  listNoteHistory,
  type ImageMeta,
  type RevisionItem,
  type SpaceInfo,
  type TaskStatus,
  type TimelineItem,
  type TopicItem,
} from "./api";
import { t } from "./i18n";
import { $, actionBar, confirmBar, esc, fmtWhen, hideConfirmBar, showBar, showError } from "./ui";
import { DONE_COLUMN, LANDING_COLUMN, isTaskStage, liveTaskColumns, stageLabel } from "./columns";
import { capturePhoto, PICK_MAX, pickImages, toBase64 } from "./images";
import { openViewer } from "./viewer";
import { closeEditSheet, openEditSheet, paintEditSheet, type EditHost } from "./editsheet";

// actions = 两行主面;more = 低频动作子面;status/due/prio = 值 chip 各自点开的那一排
// (选完自己回 actions);tags/move/history = 既有三张子面;edit = 屏底编辑层开着。
type Mode = "actions" | "more" | "edit" | "tags" | "move" | "history" | "status" | "due" | "prio";

type PanelState = {
  space: string;
  id: string;
  mode: Mode;
  /** tags 面的全部标签(进入时现读;写后异步重读,失败不牵连业务写)。 */
  topics: TopicItem[];
  /** 编辑草稿(null=非编辑态)。真相在这,DOM 只是投影。 */
  editDraft: string | null;
  /** 编辑态里这条的配图(进 edit 面时 = item.images 的拷贝;加/删就地改)。编辑态整轴
   *  刷新被草稿闸延后 ⇒ 不能靠 refresh 让新图冒出来,这份是编辑期间缩略图条的真相源;
   *  收场退出编辑时那轮补刷会拿到库里真值。null = 非编辑态。 */
  editImages: ImageMeta[] | null;
  /** 标签新建输入草稿。 */
  tagDraft: string;
  /** listTopics 请求序号(三审 M3):enterTags/refreshTopics 共用,旧快照晚回不许
   *  覆盖新快照。 */
  topicsSeq: number;
  /** history 面的旧版本(进入时现读;null = 还没读)。只读,⛔ 没有任何写口。 */
  revisions: RevisionItem[] | null;
};

type Deps = {
  /** 时间轴最新一次渲染的条目快照(id → item);面板的真值来源。 */
  getItem: (id: string) => TimelineItem | undefined;
  /** 写成功后的整轴重拉(main.ts 的 refresh,single-flight)。 */
  refresh: () => Promise<void>;
  /** 草稿收场(保存成功/取消/被迫丢弃)后调:main.ts 借此补被延后的刷新。 */
  onDraftClosed: () => void;
  /** 切换编排进行中(main.ts 的 switching):面板不受理任何点击。 */
  isSwitching: () => boolean;
  /** 「记下」在飞(146 ▲▲M3):面板整体禁点——尤其不许进入 edit/tags 草稿态,
   *  否则保存后的 refresh 被草稿闸无限延后、新卡落不了 DOM。 */
  isCaptureSaving: () => boolean;
  /** 当前空间列表(spacesCache 影子):移动入口按数量决定是否出现、picker 列它。 */
  getSpaces: () => SpaceInfo[];
  /** 开留言层(main.ts openCommentsFor,与卡上 💬 徽章同一个入口)。**N=0 时这里是
   *  唯一入口**——徽章 N=0 不显示,没有它第一条留言就无从写起(§4.7 第 1 条)。 */
  openComments: (itemId: string) => void;
  /** 截止日的相对表达(「今天」/「逾期 3 天」/「8/27」)。706 值 chip 要它 —— 与**卡上那颗
   *  角标同一支笔**(main.ts 的 dueLabel),⛔ 别在这儿另写一份,更别把 ISO 原串摆上去:
   *  `2026-08-27` 在 360px 屏上一枚就吃掉半行,而它正是这一轮要治的「系统脸」。 */
  dueLabel: (due: string) => string;
};

// 状态 picker 的目标域 = **能落卡的那几列**(B-f 第 1 段起从库里来;已删的列不在内 ——
// core 的 `is_live_task_column` 会拒,UI 不给一条注定被拒的路)。
// ⚠ 卡自己正待在一个已删的列里时,它的当前态不在这一行 pill 里 ⇒ 一枚都不高亮,点哪一枚
// 就搬去哪一列。那正是 §4.3 要的:收容区里的卡**只能往外走**。
const statuses = (): { key: TaskStatus; label: string }[] =>
  liveTaskColumns().map((c) => ({ key: c.id, label: stageLabel(c.id)! }));
// 506:排列改成高档在前(无 · P0 · P1 · P2)—— P 记号下「P0 最高」是读法的一部分,
// 3→2→1 倒序列才读得顺,也与桌面 tasktime.ts::openPri 的 [3,2,1,清除] 同向。
// ⚠ key 仍是库里的 1/2/3(1=低),⛔ 别照 label 的顺序去改 key。「无」留在最前不动:
// 它是「未设」那一态、不是第四档,位置也是老用户的肌肉记忆。
const PRIORITIES: { key: 1 | 2 | 3 | null; label: string }[] = [
  { key: null, label: t("cardpanel.prioNone") },
  { key: 3, label: t("cardpanel.prioHigh") },
  { key: 2, label: t("cardpanel.prioMid") },
  { key: 1, label: t("cardpanel.prioLow") },
];

let deps: Deps;
let state: PanelState | null = null;
let busy = false; // 面板内写操作 in-flight:整面禁点(事件入口统一拒)

/** 面板态的两处**外壳投影**的唯一同步点(706):
 *  ① `body.panel-open` —— 悬浮 ＋ 让位(它是 fixed 的,压在操作面/编辑层的钮上,用户面报的);
 *  ② 编辑层 —— 只要面板不在 edit 态,层就该是收着的(换卡 / 进别的子面 / 收面 / 切空间同理)。
 *  ⛔ 别在别处零散地推这两样:漏一处的样子是「＋ 赖着不走」或「编辑层关不掉」。 */
function syncShell(): void {
  document.body.classList.toggle("panel-open", state !== null);
  if (!state || state.mode !== "edit") closeEditSheet();
}

/** 换面板态(开 / 收 / 换卡)。⛔ 一切 `state = …` 都走这里。 */
function setState(next: PanelState | null): void {
  state = next;
  syncShell();
}

/** 换子面。⛔ 一切 `session.mode = …` 都走这里。 */
function setMode(session: PanelState, mode: Mode): void {
  session.mode = mode;
  syncShell();
}

export function hasDirtyDraft(): boolean {
  if (!state) return false;
  if (state.mode === "edit") return true; // 编辑态恒脏:光标/选区也经不起重画
  return state.tagDraft.trim() !== "";
}

/** 静默收面板(切空间清屏/条目消失时用)。若正有草稿被迫丢弃,响一声不撒谎。
 *  onDraftClosed **无条件**调(三审 M1):曾被草稿延后的刷新不许因「后来草稿又
 *  被删空」而永远没人补;main 侧回调本就幂等,空调无副作用。 */
export function forceClose(reason?: string) {
  const hadDraft = hasDirtyDraft();
  clearConfirm();
  setState(null); // 编辑层随之收掉(syncShell)
  document.querySelector("#timeline .panel")?.remove();
  if (hadDraft) showBar(reason ?? t("cardpanel.draftDropped"));
  deps.onDraftClosed();
}

/** 返回键把编辑层弹掉了(main.ts 的 popstate 已收 DOM):这边只收草稿态。
 *  ⛔ 不在这里再调 closeEditSheet 的 settle 那条路 —— 守门条目已经弹过了。 */
export function editDismissed(): void {
  if (state?.mode !== "edit") return;
  closeDraft();
}

/** refresh 重建 DOM 后把展开态接回;条目已不在(被删/换空间)= 清态。 */
export function restore(scope: HTMLElement) {
  if (!state) return;
  if (state.space !== getCurrentSpace() || !deps.getItem(state.id)) {
    setState(null);
    clearConfirm(); // 条目已不在:挂着的确认一并作废
    return;
  }
  const card = scope.querySelector<HTMLElement>(`article.card[data-id="${state.id}"]`);
  if (!card) {
    setState(null);
    clearConfirm();
    return;
  }
  renderPanel(card);
}

/** 远端变更(sync-changed)时:tags 面的标签集可能已经旧了,空闲时重读。 */
export function onRemoteChanged() {
  if (state?.mode === "tags" && !busy) void refreshTopics(state, getCurrentSpace());
}

/** 收起底部确认条(改卡/收面/写完/切空间都要收:旧确认不许挂在新语境上)。 */
function clearConfirm() {
  hideConfirmBar();
}


function currentCard(): HTMLElement | null {
  if (!state) return null;
  return document.querySelector<HTMLElement>(`#timeline article.card[data-id="${state.id}"]`);
}

// ---- 渲染(一切输入值从 state 画回,DOM 只是投影) -----------------------------

function pill(label: string, attrs: string, on: boolean, disabled = false): string {
  return `<button ${attrs} class="p${on ? " on" : ""}"${disabled ? " disabled" : ""}>${label}</button>`;
}

function actBtn(act: string, label: string, opts: { warn?: boolean } = {}): string {
  // 两拍确认不再原位变话术(ui-audit P0 #4):按钮几何恒定,确认在底部固定条。
  return `<button data-pact="${act}" class="${opts.warn ? "warn" : ""}"${busy ? " disabled" : ""}>${label}</button>`;
}

/** 值 chip(706):`键 值 ▾` 三段 —— 键是灰的小字,值是这条现在的样子,▾ 说明点得开。
 *  `set` = 设过值(截止/优先级),往朱砂上靠一档;状态恒有值,故恒 set。 */
function propBtn(act: "status" | "due" | "prio", key: string, value: string, set: boolean): string {
  return (
    `<button data-pact="${act}" class="prop${set ? " set" : ""}"${busy ? " disabled" : ""}>` +
    `<span class="k">${key}</span><span class="v">${esc(value)}</span><span class="k">▾</span></button>`
  );
}

function renderPanel(card: HTMLElement) {
  if (!state) return;
  const item = deps.getItem(state.id);
  if (!item) return;
  document.querySelector("#timeline .panel")?.remove();
  const panel = document.createElement("div");
  panel.className = "panel";
  if (state.mode === "tags") {
    panel.innerHTML = renderTags(item);
  } else if (state.mode === "move") {
    panel.innerHTML = renderMove();
  } else if (state.mode === "history") {
    panel.innerHTML = renderHistory();
  } else if (state.mode === "more") {
    panel.innerHTML = renderMore(item);
  } else if (state.mode === "status" || state.mode === "due" || state.mode === "prio") {
    panel.innerHTML = renderValuePicker(item, state.mode);
  } else {
    // actions,以及 edit —— 编辑态屏上的主角是屏底那层,遮罩底下这张卡照常画两行主面
    // (卡片正文也照常在,那才是「原地」:不跳页、改的是哪一条一眼看得见)。
    panel.innerHTML = renderActions(item);
  }
  card.querySelector(".body")!.appendChild(panel);
  if (state.mode === "edit") paintEditSheet(editView());
}

/** 递给编辑层的那份投影(真相仍在 state / lastItems)。 */
function editView() {
  const item = state ? deps.getItem(state.id) : undefined;
  return {
    text: state?.editDraft ?? "",
    topics: (item?.topics ?? []).map((tp) => ({ title: tp.title, color: tp.color })),
    images: state?.editImages ?? [],
    busy,
  };
}

function renderActions(item: TimelineItem): string {
  // 部分成功登记(kept/unconfirmed):目标已建、源仍在/未知——常驻提示 + 「我已处理」
  // 解除,且**藏掉「移动」入口**防重跑造第二份(cross-space-move §4/codex #5)。
  const partial = movePartialNote(item.id);
  const noteBlock = partial
    ? `<div class="movenote"><span>${esc(partial)}</span>` +
      `<button data-pact="move-ack" class="p">${t("cardpanel.moveAck")}</button></div>`
    : "";
  const task = isTaskStage(item.stage);
  // 动作行**四枚封顶**(706):前三枚按频次拍——任务卡日常是「改字 / 归类 / 留话」,
  // 随记卡是「改字 / 归类 / 转成待办」(转待办是产品主干路,⛔ 别把它埋进「更多…」)。
  // 加图 / 拍照在编辑层里(674 起就不在操作面)。
  const acts: string[] = [
    actBtn("edit", t("cardpanel.actEdit")),
    actBtn("tags", t("cardpanel.actTags")),
    task ? actBtn("comment", t("cardpanel.actComment")) : actBtn("promote", t("cardpanel.actPromote")),
    actBtn("more", t("cardpanel.actMore")),
  ];
  // 值 chip 行(仅任务):显示当前值、点开才出候选。⚠ 卡上的角标只在**设了**截止/优先级时
  // 才有 ⇒ 这三枚恒在,否则「还没设」那一态就没有入口了。
  const props = task
    ? `<div class="props">${[
        propBtn("status", t("cardpanel.laneStatus"), stageLabel(item.stage)!, true),
        propBtn(
          "due",
          t("cardpanel.laneDue"),
          item.due_on ? deps.dueLabel(item.due_on) : t("cardpanel.dueNone"),
          item.due_on !== null,
        ),
        propBtn(
          "prio",
          t("cardpanel.lanePriority"),
          PRIORITIES.find((p) => p.key === (item.priority ?? null))!.label,
          item.priority !== null,
        ),
      ].join("")}</div>`
    : "";
  return `${noteBlock}<div class="acts">${acts.join("")}</div>${props}`;
}

/** 「更多…」子面(706):低频那几件。次序 = 由轻到重,**删除永远在最后**并与上面隔开
 *  (它是这一面唯一的朱砂)。⛔ 别把这几枚挪回动作行 —— 一年点一次的东西不该天天占屏。 */
function renderMore(item: TimelineItem): string {
  const task = isTaskStage(item.stage);
  const acts: string[] = [];
  if (!task) acts.push(actBtn("comment", t("cardpanel.actComment"))); // 随记的留言让位给「转待办」
  acts.push(actBtn("history", t("cardpanel.actHistory")));
  // 移动入口:仅 ≥2 空间、且本条无未处理的部分移动登记时出现(§4)。
  if (!movePartialNote(item.id) && deps.getSpaces().length >= 2) acts.push(actBtn("move", t("cardpanel.actMove")));
  if (item.stage === LANDING_COLUMN) acts.push(actBtn("revert", t("cardpanel.actRevert"), { warn: true }));
  if (item.stage === DONE_COLUMN) acts.push(actBtn("seal", t("cardpanel.actSeal")));
  acts.push(actBtn("del", t("cardpanel.actDelete"), { warn: true }));
  return `<div class="acts">${acts.join("")}</div>
    <div class="acts"><button data-pact="back"${busy ? " disabled" : ""}>${t("cardpanel.back")}</button></div>`;
}

/** 值 chip 点开的那一排(706):一次只出一样,选完由写口把 mode 拨回 actions。
 *  ⚠ 状态那排的目标域仍是**能落卡的那几列**,当前那枚 disabled —— 判据与从前逐字一致。 */
function renderValuePicker(item: TimelineItem, which: "status" | "due" | "prio"): string {
  let lane: string;
  if (which === "status") {
    lane = `<span class="lab">${t("cardpanel.laneStatus")}</span><span class="pillrow">${statuses()
      .map((s) => pill(s.label, `data-status="${s.key}"`, item.stage === s.key, busy || item.stage === s.key))
      .join("")}</span>`;
  } else if (which === "due") {
    lane =
      `<span class="lab">${t("cardpanel.laneDue")}</span>` +
      `<input type="date" data-due value="${esc(item.due_on ?? "")}"${busy ? " disabled" : ""} />` +
      (item.due_on
        ? `<button data-pact="due-clear" class="p"${busy ? " disabled" : ""}>${t("cardpanel.dueClear")}</button>`
        : "");
  } else {
    lane = `<span class="lab">${t("cardpanel.lanePriority")}</span><span class="pillrow">${PRIORITIES.map((p) =>
      pill(
        p.label,
        `data-prio="${p.key ?? ""}"`,
        (item.priority ?? null) === p.key,
        busy || (item.priority ?? null) === p.key,
      ),
    ).join("")}</span>`;
  }
  return `<div class="lane">${lane}</div>
    <div class="acts"><button data-pact="back"${busy ? " disabled" : ""}>${t("cardpanel.back")}</button></div>`;
}

/** 移动 picker(§2.7 安卓入口):**永久删历史告知在选择之前**(§4)+ 其他空间按
 *  可辨识标签列出(重名缀尾)。目标按钮用 data-move-to(非 data-pact),点即执行。 */
function renderMove(): string {
  const cur = getCurrentSpace();
  const spaces = deps.getSpaces();
  const labels = distinctSpaceLabels(spaces);
  const rows = spaces
    .filter((s) => s.id !== cur)
    .map(
      (s) =>
        `<button data-move-to="${esc(s.id)}" class="p"${busy ? " disabled" : ""}>${esc(
          labels.get(s.id) ?? s.id,
        )}</button>`,
    )
    .join("");
  return `<div class="movewarn">${t("cardpanel.moveWarnPre")}<b>${t("cardpanel.moveWarnBold")}</b>${t("cardpanel.moveWarnPost")}</div>
    <div class="lane"><span class="pillrow">${rows || `<span class="lab">${t("cardpanel.noOtherSpace")}</span>`}</span></div>
    <div class="acts"><button data-pact="back"${busy ? " disabled" : ""}>${t("cardpanel.back")}</button></div>`;
}

/** 编辑历史面(用户面 87,677):这条改过的旧版本,新的在前,**只读** —— ⛔ 不给「恢复」
 *  (不可变性是历史级:想改回去就再改一版,走编辑)。桌面把它挂在编辑框下面;手机的编辑面是
 *  草稿态、进去就该写字,放那儿一眼看不到,故给它自己一格动作。没改过就说一句,不空着。 */
function renderHistory(): string {
  const revs = state?.revisions ?? [];
  const rows = revs
    .map(
      (r) =>
        `<div class="rev"><time>${esc(t("cardpanel.histEditedAt", { time: fmtWhen(r.archived_at) }))}</time><p>${esc(r.content)}</p></div>`,
    )
    .join("");
  return `<div class="hist">${rows || `<span class="lab">${t("cardpanel.histEmpty")}</span>`}</div>
    <div class="acts"><button data-pact="back"${busy ? " disabled" : ""}>${t("cardpanel.back")}</button></div>`;
}

function renderTags(item: TimelineItem): string {
  if (!state) return "";
  const linked = new Set(item.topics.map((t) => t.id));
  // 652:灵感与任务在这一排上同形——点亮的再点一次就摘掉(`remove_note_topic` /
  // `remove_task_topic`)。⛔ 别再按 stage 分岔:此前灵感的已挂标签是 disabled 的,
  // 而那句「core 没有该原语、与桌面能力一致」两头都不成立(原语一直在,桌面随记有 ✕)。
  const pills = state.topics
    .map((tp) => {
      const on = linked.has(tp.id);
      return `<button data-topic="${esc(tp.id)}" class="p${on ? " on" : ""}${tp.color ? " tinted" : ""}"${
        busy ? " disabled" : ""
      }${tp.color ? ` style="--tc:${esc(tp.color)}"` : ""}>${esc(tp.title)}</button>`;
    })
    .join("");
  return `<div class="lane"><span class="pillrow">${pills || `<span class="lab">${t("cardpanel.noTags")}</span>`}</span></div>
    <div class="lane">
      <input class="tagnew" placeholder="${t("cardpanel.newTagPh")}" autocapitalize="off" autocomplete="off"
             value="${esc(state.tagDraft)}"${busy ? " disabled" : ""} />
      <button data-pact="tagnew" class="p"${busy ? " disabled" : ""}>${t("cardpanel.createAndTag")}</button>
    </div>
    <div class="acts"><button data-pact="back"${busy ? " disabled" : ""}>${t("cardpanel.back")}</button></div>`;
}

// ---- 写操作统一收口(实现审 M2/M3 的形) ---------------------------------------

/** 面板业务写:session 引用判弃 + in-flight 闸 + 错误条;**写成功即安排时间轴
 *  refresh(只要空间没换),与面板 session 是否还在无关**。回调拆两道(146 ▲M4):
 *  `onCommitted` = 写成功且空间未换就执行、**与 session 是否存活无关**——跨面回执
 *  showBar 走这道(mode 重投影会让离场卡的 session 被 restore 清掉,session 绑定的
 *  回调会被吞);`afterSession` = 仅 session 未变时执行(收面板/清草稿等局部动作)。 */
async function run(
  op: (space: string) => Promise<unknown>,
  opts: { onCommitted?: () => void; afterSession?: () => void } = {},
): Promise<void> {
  if (busy || !state) return;
  const session = state;
  const space = getCurrentSpace();
  busy = true;
  const c = currentCard();
  if (c) renderPanel(c); // 立即画出禁用态(输入值从 state 画回,不丢草稿)
  let wrote = false;
  try {
    await op(space);
    wrote = true;
  } catch (err) {
    if (space === getCurrentSpace() && state === session) showError(String(err));
  } finally {
    busy = false;
    clearConfirm();
    if (wrote && space === getCurrentSpace()) {
      opts.onCommitted?.(); // 写已提交:回执不随面板 session 陪葬
      if (state === session) opts.afterSession?.();
      if (state === null) document.querySelector("#timeline .panel")?.remove();
      void deps.refresh(); // 写已提交:轴必须重拉,不随面板 session 陪葬
    }
    const card = currentCard();
    if (card) renderPanel(card);
  }
}

/** 跨空间移动的专用收口(§2.7 安卓入口;不复用 run()——结果是 MoveResult 五分道、
 *  且部分成功必须**先于任何 session/空间/DOM 判弃**落登记,codex #5)。moveItemToSpace
 *  恒决议(raw invoke),迟到语义靠登记不靠丢弃。 */
async function runMove(target: string, targetLabel: string): Promise<void> {
  if (busy || !state) return;
  const session = state;
  const source = getCurrentSpace();
  const id = session.id;
  busy = true;
  const c = currentCard();
  if (c) renderPanel(c); // 禁用态
  let result: Awaited<ReturnType<typeof moveItemToSpace>> | null = null;
  try {
    result = await moveItemToSpace(source, target, id);
  } catch (err) {
    if (source === getCurrentSpace() && state === session) showError(String(err));
  } finally {
    busy = false;
    clearConfirm();
  }
  if (result) {
    // 登记先行(独立于 UI 是否还在):目标已建的事实切走/重画都不能丢。
    if (result.outcome === "copied_but_source_kept") {
      movePartialMark(source, id, t("cardpanel.moveKept", { name: targetLabel, reason: result.reason }));
    } else if (result.outcome === "copied_but_source_unconfirmed") {
      movePartialMark(
        source,
        id,
        t("cardpanel.moveUnconfirmedNote", { name: targetLabel, error: result.error }),
      );
    }
    // 以下 UI 反馈只给还停在本空间/本 session 的人(登记已落)。
    const here = source === getCurrentSpace();
    switch (result.outcome) {
      case "moved":
        if (state === session) setState(null);
        if (here) {
          showBar(t("cardpanel.moved", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "copied_but_source_kept":
        if (state === session) setMode(session, "actions"); // 回 actions 面显登记提示、藏移动入口
        if (here) {
          showBar(t("cardpanel.movedKept", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "copied_but_source_unconfirmed":
        // 源删除状态未知,绝不谎报「保留」(codex 实现审 #2)。
        if (state === session) setMode(session, "actions");
        if (here) {
          showBar(t("cardpanel.movedUnconfirmed", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "images_pending":
        if (here && state === session) {
          setMode(session, "actions");
          showError(t("cardpanel.imagesPending", { n: result.count }));
        }
        break;
      case "dangling_refs":
        if (here && state === session) {
          setMode(session, "actions");
          showError(t("cardpanel.danglingRefs"));
        }
        break;
    }
  }
  const card = currentCard();
  if (card) renderPanel(card);
}

/** 标签列表重读(与业务写解耦):失败只轻提示,绝不谎报业务写失败。
 *  seq 判弃(三审 M3):旧快照晚回不覆盖新快照。**重画收窄**(三审 M6):只在
 *  tags 面、输入干净、非 busy 时才换 DOM——脏输入期间只更缓存,不打断手机键盘
 *  的焦点与输入法组合态;别的 mode 下数据已入 state,下次重画自然带上。 */
async function refreshTopics(session: PanelState, space: string) {
  const seq = ++session.topicsSeq;
  try {
    const topics = await listTopics(space);
    if (state !== session || space !== getCurrentSpace() || seq !== session.topicsSeq) return;
    session.topics = topics;
    if (session.mode === "tags" && session.tagDraft.trim() === "" && !busy) {
      const card = currentCard();
      if (card) renderPanel(card);
    }
  } catch {
    if (state === session && space === getCurrentSpace() && seq === session.topicsSeq) {
      showBar(t("cardpanel.topicsRefreshFailed"));
    }
  }
}

async function enterTags(card: HTMLElement) {
  if (!state) return;
  const session = state;
  const space = getCurrentSpace();
  const from = session.mode; // ⚠ 判据是「还停在出发那张面上吗」,⛔ 不是「是不是 actions 面」
  const seq = ++session.topicsSeq;
  try {
    const topics = await listTopics(space);
    // 在途期间面板可自由导航(此处不 busy):session 换了/空间换了/更新的请求
    // 出发了/用户已翻到别的面(含进编辑态)/「记下」开始在飞(实现审 M1:锁定期不许
    // 新开草稿态面)——一律弃,不许把 mode 硬翻回 tags 踩掉编辑。
    if (
      state !== session ||
      space !== getCurrentSpace() ||
      seq !== session.topicsSeq ||
      session.mode !== from ||
      deps.isCaptureSaving()
    ) {
      return;
    }
    setMode(session, "tags");
    session.topics = topics;
    const c = currentCard() ?? card;
    renderPanel(c);
  } catch (err) {
    if (state === session && space === getCurrentSpace() && seq === session.topicsSeq) {
      showError(String(err));
    }
  }
}

/** 进历史面:现读旧版本再翻 mode(同 enterTags 的形:在途期间面板可自由导航,回来时 session /
 *  空间 / mode 任一变了就弃,⛔ 不许把 mode 硬翻回去踩掉编辑)。
 *  ⚠⚠ **判据是「还停在出发那张面上吗」,⛔ 不是「是不是 actions 面」**:706 起「历史」是从
 *  「更多…」子面点的(出发时 mode = `more`),写死 `actions` 会把每一次都判弃 —— 屏上的样子是
 *  「点历史没反应」,而且**一格错误都不报**。note-history 那支资产当场逮到,别再写回去。 */
async function enterHistory(card: HTMLElement) {
  if (!state) return;
  const session = state;
  const space = getCurrentSpace();
  const from = session.mode;
  try {
    const revisions = await listNoteHistory(space, session.id);
    if (state !== session || space !== getCurrentSpace() || session.mode !== from || deps.isCaptureSaving()) return;
    setMode(session, "history");
    session.revisions = revisions;
    renderPanel(currentCard() ?? card);
  } catch (err) {
    if (state === session && space === getCurrentSpace()) showError(String(err));
  }
}

async function saveEdit() {
  if (!state) return;
  const session = state;
  const item = deps.getItem(state.id);
  if (!item || session.editDraft === null) return;
  const draft = session.editDraft;
  const trimmed = draft.trim();
  if (!trimmed) {
    showError(t("cardpanel.emptyContent"));
    return; // 留在编辑态,草稿不丢
  }
  const task = isTaskStage(item.stage);
  // 同值不写(codex L10):任务比 trim 后标题、灵感比原字符串——未改直接收起,
  // 不产生一条内容相同的历史版本和同步 op。
  if (task ? trimmed === item.content : draft === item.content) {
    closeDraft();
    return;
  }
  await run(
    (space) => (task ? renameTask(space, session.id, draft) : editNote(space, session.id, draft)),
    {
      afterSession: () => {
        session.editDraft = null;
        session.editImages = null;
        setMode(session, "actions"); // 编辑层随之收掉(syncShell)
        deps.onDraftClosed();
      },
    },
  );
}

/** 编辑/标签草稿收场(取消/同值/返回):回 actions 面,收掉编辑层,补被延后的刷新。 */
function closeDraft() {
  if (!state) return;
  state.editDraft = null;
  state.editImages = null;
  state.tagDraft = "";
  setMode(state, "actions"); // 编辑层随之收掉(syncShell)
  const c = currentCard();
  if (c) renderPanel(c);
  deps.onDraftClosed();
}

// ---- 操作面「加图」/「拍照」(取图/转码走共享件 images.ts,与 compose 记灵感同源) ----

/** 逐张挂到本条,走面板统一写口 run()(写成功刷新轴、缩略图现出)。图挂在既有条目上,
 *  与正文编辑草稿无关,刷新干净。**逐张 try 不中断**:后端限 png/jpeg/webp/gif ≤32MiB,
 *  一张被拒不该连累同批其余的(HEIC 混在相册多选里就是这个形)。回执三分:全成功 /
 *  部分失败(带上后端第一条原话,不静默吞)/ 单张失败(就报原话,与 195 的行为一致)。 */
async function attachImages(itemId: string, files: File[]): Promise<void> {
  if (!state || busy || !files.length) return;
  const session = state;
  let ok = 0;
  let firstErr = "";
  const added: ImageMeta[] = [];
  await run(
    async (space) => {
      for (const f of files) {
        let b64: string;
        try {
          b64 = await toBase64(f);
        } catch {
          if (!firstErr) firstErr = t("cardpanel.imageReadFailed"); // 转码炸了没有后端原话可报
          continue;
        }
        try {
          added.push(await addItemImage(space, itemId, f.type, b64));
          ok += 1;
        } catch (err) {
          if (!firstErr) firstErr = String(err);
        }
      }
    },
    {
      // 编辑态整轴刷新被草稿闸延后 ⇒ 新图当场现出只能靠就地并进 editImages(run 的 finally
      // 随之重画编辑面、缩略图冒出来)。session 未变才并——换卡/收面后落到旧 session 无意义。
      afterSession: () => {
        if (session.editImages) session.editImages.push(...added);
      },
      onCommitted: () => {
        const failed = files.length - ok;
        if (!failed) {
          showBar(ok === 1 ? t("cardpanel.imageAdded") : t("cardpanel.imagesAdded", { n: ok }), true);
        } else if (!ok && files.length === 1) {
          showError(firstErr);
        } else {
          showError(`${t("cardpanel.imagesPartial", { ok, failed })} ${firstErr}`);
        }
      },
    },
  );
}

/** 点「加图」:唤起系统相册**多选**(≤ PICK_MAX 张,借 WebView onShowFileChooser,无插件)。
 *  取图这一路每张降采样要几百 ms,逐张收进 batch 后一并写(写口 run() 是单飞的,不能
 *  边选边写);取消(没选)静默返回,超上界响亮说清楚。 */
async function addImages(itemId: string): Promise<void> {
  if (!state || busy) return;
  const batch: File[] = [];
  const res = await pickImages((f) => batch.push(f));
  if (res.kind === "tooMany") {
    showError(t("images.tooMany", { max: PICK_MAX, n: res.count }));
    return;
  }
  await attachImages(itemId, batch);
}

/** 点「拍照」:当场开系统相机拍一张,拍完直接挂到本条(不进任何暂存)。 */
async function addPhoto(itemId: string): Promise<void> {
  if (!state || busy) return;
  const file = await capturePhoto();
  if (!file) return;
  await attachImages(itemId, [file]);
}

/** 编辑面缩略图删图(674):两拍确认,就地删 + 从 editImages 摘掉(run 的 finally 重画编辑面)。
 *  ⛔ 不走整轴 refresh——编辑态它被草稿闸延后,退出编辑那刻才补;缩略图条的真相在 editImages。 */
function confirmDeleteEditImage(imgId: string, seq: string): void {
  if (!state || busy) return;
  const session = state;
  confirmBar(t("main.deleteImageQ", { n: seq }), t("main.deleteImageYes"), () => {
    if (state !== session || busy) return;
    void run((space) => deleteItemImage(space, imgId), {
      afterSession: () => {
        if (session.editImages) session.editImages = session.editImages.filter((m) => m.id !== imgId);
      },
      onCommitted: () => showBar(t("main.imageDeleted"), true),
    });
  });
}

// ---- 事件接线 ----------------------------------------------------------------

function onTimelineClick(e: Event) {
  if (deps.isSwitching() || deps.isCaptureSaving()) return;
  if (busy) return; // in-flight:面板一切导航(开合/换卡/控件)整体拒(实现审 M2)
  const el = e.target as HTMLElement;
  // ⚠ 编辑态的缩略图(看大图 / 删)不在这儿:它们住屏底的编辑层,由 editsheet.ts 认,
  // 回调进本模块的 editHost。这里只剩时间轴上的东西。
  // 面板控件优先。
  const pact = el.closest<HTMLElement>("[data-pact]")?.dataset.pact;
  if (pact && state) {
    const card = currentCard();
    if (!card) return;
    handleAct(pact, card);
    return;
  }
  const topicBtn = el.closest<HTMLElement>("[data-topic]");
  if (topicBtn && state?.mode === "tags") {
    const session = state;
    const item = deps.getItem(session.id);
    if (!item) return;
    const topicId = topicBtn.dataset.topic!;
    const linked = item.topics.some((x) => x.id === topicId);
    const task = isTaskStage(item.stage);
    void run(
      async (space) => {
        if (task) {
          if (linked) await removeTaskTopic(space, item.id, topicId);
          else await addTaskTopic(space, item.id, topicId);
        } else if (linked) {
          // 摘掉最后一个标签会把「已整理」退回「未归类」,两个 stage 都在随记面里
          // (`IDEA_STAGES`),故卡片只是标签消失、不会跳走。
          await removeNoteTopic(space, item.id, topicId);
        } else {
          await fileNoteToTopic(space, item.id, topicId, null);
        }
      },
      { afterSession: () => void refreshTopics(session, getCurrentSpace()) },
    );
    return;
  }
  const moveBtn = el.closest<HTMLElement>("[data-move-to]");
  if (moveBtn && state?.mode === "move") {
    const target = moveBtn.dataset.moveTo!;
    const label = distinctSpaceLabels(deps.getSpaces()).get(target) ?? target;
    void runMove(target, label);
    return;
  }
  // 状态 / 优先级选完自己回主面(706:值 chip 那条路是「点开 → 选 → 收」,
  // 留在候选排上等人再点一记「返回」是多余的一步)。写失败不回——错误条旁边就该是那一排。
  const statusBtn = el.closest<HTMLElement>("[data-status]");
  if (statusBtn && state) {
    const session = state;
    const to = statusBtn.dataset.status as TaskStatus;
    void run((space) => updateTaskStatus(space, session.id, to), {
      afterSession: () => setMode(session, "actions"),
    });
    return;
  }
  const prioBtn = el.closest<HTMLElement>("[data-prio]");
  if (prioBtn && state) {
    const session = state;
    const raw = prioBtn.dataset.prio!;
    const prio = raw === "" ? null : (Number(raw) as 1 | 2 | 3);
    void run((space) => setTaskPriority(space, session.id, prio), {
      afterSession: () => setMode(session, "actions"),
    });
    return;
  }
  // 面板内其余区域(textarea/输入框等)不冒泡成开合。
  if (el.closest(".panel")) return;
  // 勾框、正文里的待办方框、缩略图、留言徽章各有其主(main.ts),不抢——徽章漏在这里的
  // 话,点它会连带把操作面板开合一次(留言层滑上来,底下的面板悄悄换了态)。
  if (
    el.closest(".tick") ||
    el.closest(".ckbox") ||
    el.closest(".thumb") ||
    el.closest(".cm-badge") ||
    el.closest(".fold-toggle") // 长卡折叠(用户面 116):整行可点且贴着正文,漏在这里 = 展开的同时开了面板
  )
    return;
  const card = el.closest<HTMLElement>("article.card[data-id]");
  if (!card) return;
  const id = card.dataset.id!;
  if (state?.id === id) {
    if (hasDirtyDraft()) return; // 有草稿不许点空白收面(误触丢字)
    clearConfirm();
    setState(null);
    card.querySelector(".panel")?.remove();
    deps.onDraftClosed(); // 三审 M1:收面即「草稿域收场」,补被延后的刷新
    return;
  }
  if (hasDirtyDraft()) {
    showError(t("cardpanel.finishDraftFirst"));
    return;
  }
  clearConfirm();
  setState({
    space: getCurrentSpace(),
    id,
    mode: "actions",
    topics: [],
    editDraft: null,
    editImages: null,
    tagDraft: "",
    topicsSeq: 0,
    revisions: null,
  });
  deps.onDraftClosed(); // 换卡 = 旧草稿域收场(同上)
  renderPanel(card);
}

function handleAct(act: string, card: HTMLElement) {
  if (!state) return;
  const session = state;
  const item = deps.getItem(session.id);
  if (!item) return;
  switch (act) {
    case "edit":
      clearConfirm();
      session.editDraft = item.content;
      session.editImages = [...item.images]; // 进编辑态时拷一份现有配图;加/删就地改这一份
      setMode(session, "edit");
      openEditSheet(editView(), editHost); // 屏底的编辑层接手打字这件事(706)
      renderPanel(card); // 遮罩底下的卡照常画主面
      return;
    case "tags":
      clearConfirm();
      void enterTags(card);
      return;
    case "history":
      clearConfirm();
      void enterHistory(card);
      return;
    case "more":
    case "status":
    case "due":
    case "prio":
      clearConfirm();
      setMode(session, act);
      renderPanel(card);
      return;
    case "comment":
      // 留言层盖在面板之上;面板留着不收(收层回来还在原处)。写/删由留言层自己走
      // 命令与刷新,不经 run()——它不是面板的业务写。
      clearConfirm();
      deps.openComments(session.id);
      return;
    case "move":
      clearConfirm();
      setMode(session, "move");
      renderPanel(card);
      return;
    case "move-ack":
      // 「我已处理」:清部分移动登记(源条目已由用户自行处置),回 actions 面
      // (移动入口随之复现)。登记键 = 当前空间/id(面板恒开在当前空间)。
      movePartialClear(item.id);
      setMode(session, "actions");
      renderPanel(card);
      return;
    case "back":
      closeDraft();
      return;
    case "promote":
      // 146:卡离开灵感面——回执指路,且走 onCommitted(重投影清掉 session 也要响)。
      void run((space) => promoteNoteToTask(space, item.id, item.content), {
        onCommitted: () => showBar(t("cardpanel.promoted"), true),
      });
      return;
    case "tagnew": {
      const title = session.tagDraft.trim();
      if (!title) {
        showError(t("cardpanel.tagNameRequired"));
        return;
      }
      const task = isTaskStage(item.stage);
      void run(
        (space) =>
          task
            ? addTaskTopicByTitle(space, item.id, title)
            : fileNoteToTopic(space, item.id, null, title),
        {
          afterSession: () => {
            session.tagDraft = ""; // 挂上了才清草稿 = 草稿收场,补被延后的刷新
            deps.onDraftClosed();
            void refreshTopics(session, getCurrentSpace());
          },
        },
      );
      return;
    }
    case "due-clear":
      void run((space) => setTaskDue(space, item.id, null), {
        afterSession: () => setMode(session, "actions"), // 同状态/优先级:清完就回主面
      });
      return;
    // 两拍类:第一拍弹底部固定确认条,第二拍在条上执行(onYes 复核 session 未变——
    // 期间换卡/收面/切空间的旧确认一律作废,不许作用到新语境)。
    case "del":
      confirmBar(t("cardpanel.deleteQ"), t("cardpanel.deleteYes"), () => {
        if (state !== session || busy) return;
        // 确认期间远端可能已翻 stage(灵感→任务):按现行条目分流,不用第一拍的快照。
        const cur = deps.getItem(session.id);
        if (!cur) return;
        const task = isTaskStage(cur.stage);
        void run((space) => (task ? archiveTask(space, cur.id) : archiveNote(space, cur.id)), {
          // 操作型回执(§3.1):软删可逆,撤销=按删除那刻的 stage 分流捞回(同回收站
          // 「恢复」)。onCommitted 只在空间未换时被调 ⇒ 此刻 getCurrentSpace()=写时空间。
          onCommitted: () => {
            const space = getCurrentSpace();
            actionBar(t("cardpanel.deleted"), t("ui.undo"), () => {
              if (deps.isSwitching() || getCurrentSpace() !== space) return; // 换空间的旧撤销作废
              void (async () => {
                try {
                  await (task ? restoreTask(space, cur.id) : restoreNote(space, cur.id));
                } catch (err) {
                  showError(String(err));
                }
                await deps.refresh();
              })();
            });
          },
          afterSession: () => {
            setState(null);
          },
        });
      });
      return;
    case "revert": {
      const hasMeta = item.due_on !== null || item.priority !== null;
      confirmBar(
        hasMeta ? t("cardpanel.revertQMeta") : t("cardpanel.revertQ"),
        t("cardpanel.revertYes"),
        () => {
          if (state !== session || busy) return;
          // 146:卡离开任务面——回执指路,走 onCommitted(理由同 promote)。
          void run((space) => revertTaskToInbox(space, item.id), {
            onCommitted: () => showBar(t("cardpanel.reverted"), true),
          });
        },
      );
      return;
    }
    case "seal":
      confirmBar(t("cardpanel.sealQ"), t("cardpanel.sealYes"), () => {
        if (state !== session || busy) return;
        void run((space) => sealTask(space, item.id), {
          // 操作型回执(§3.1):归档可取消(unseal 回 done),撤销=一点回来,
          // 不用去归档册再走一遍「取消归档」。space 取法同 del。
          onCommitted: () => {
            const space = getCurrentSpace();
            actionBar(t("cardpanel.sealed"), t("ui.undo"), () => {
              if (deps.isSwitching() || getCurrentSpace() !== space) return; // 换空间的旧撤销作废
              void (async () => {
                try {
                  await unsealTask(space, item.id);
                } catch (err) {
                  showError(String(err));
                }
                await deps.refresh();
              })();
            });
          },
          afterSession: () => {
            setState(null);
          },
        });
      });
      return;
  }
}

function onTimelineChange(e: Event) {
  const input = e.target as HTMLInputElement;
  if (!input.matches("input[data-due]") || !state || busy) return;
  if (deps.isCaptureSaving()) {
    // 锁定期不受理写(146 实现审 M1):DOM 回写成真值,不留「拨了没写」的假象。
    input.value = deps.getItem(state.id)?.due_on ?? "";
    return;
  }
  const session = state;
  const v = input.value; // "" = 清
  void run((space) => setTaskDue(space, session.id, v === "" ? null : v), {
    afterSession: () => setMode(session, "actions"), // 拨完就回主面(同状态/优先级)
  });
}

/** 标签新建草稿实时入 state(实现审 H1:真相在 state,重画从 state 画回)。
 *  ⚠ 正文草稿不在这条路上了 —— 它住编辑层,经 editHost.onInput 回来。 */
function onTimelineInput(e: Event) {
  const el = e.target as HTMLElement;
  if (!state || !el.matches("input.tagnew")) return;
  if (deps.isCaptureSaving()) {
    // 锁定期不受理新草稿(146 实现审 M1):tagDraft 变脏会把「记下」后的 refresh
    // 无限延后、新卡落不了 DOM——DOM 回写成 state,不留「看得见、state 没有」的假草稿。
    (el as HTMLInputElement).value = state.tagDraft;
    return;
  }
  state.tagDraft = (el as HTMLInputElement).value;
}

/** 编辑层的动作入口闸 —— 与 `onTimelineClick` 开头那三行**同一条判据**:写在飞 / 切换编排中 /
 *  「记下」在飞时,层上的一切动作整体拒(钮已是禁用态,但遮罩与缩略图不是)。
 *  ⛔ 打字不吃这道闸:草稿实时入 state 是正当的,禁它等于写在飞时把人打的字吞掉。 */
function editBlocked(): boolean {
  return busy || deps.isSwitching() || deps.isCaptureSaving();
}

/** 编辑层回调进来的那一头(层只管 DOM,写库/判弃/确认全在这边)。 */
const editHost: EditHost = {
  onInput: (text) => {
    if (!state || state.mode !== "edit") return;
    // 锁定期不受理新草稿(理由同 onTimelineInput):把框回写成 state,不留假草稿。
    if (deps.isCaptureSaving()) {
      paintEditSheet(editView());
      return;
    }
    state.editDraft = text;
  },
  onSave: () => {
    if (!editBlocked()) void saveEdit();
  },
  onCancel: () => {
    if (!editBlocked()) closeDraft();
  },
  onAddImage: () => {
    if (state && !editBlocked()) void addImages(state.id);
  },
  onPhoto: () => {
    if (state && !editBlocked()) void addPhoto(state.id);
  },
  onDeleteImage: (id, seq) => {
    if (!editBlocked()) confirmDeleteEditImage(id, seq);
  },
  onViewImage: (idx) => {
    const imgs = state?.editImages ?? [];
    if (idx >= 0 && idx < imgs.length) void openViewer(imgs, idx, true);
  },
  // 「改过没有」与 saveEdit 的同值判据**逐字同一条**(任务比 trim 后标题、随记比原字符串):
  // 两边分岔的话会出现「点遮罩被拦住、点保存却说没改」这种自相矛盾的回执。
  isDirty: () => {
    if (!state || state.editDraft === null) return false;
    const item = deps.getItem(state.id);
    if (!item) return false;
    return isTaskStage(item.stage)
      ? state.editDraft.trim() !== item.content
      : state.editDraft !== item.content;
  },
};

export function initCardPanel(d: Deps) {
  deps = d;
  const timeline = $("timeline");
  timeline.addEventListener("click", onTimelineClick);
  timeline.addEventListener("change", onTimelineChange);
  timeline.addEventListener("input", onTimelineInput);
}
