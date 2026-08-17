// 卡片操作面板(120,codex 设计审+实现审两轮后的形):点时间轴卡片展开行内操作——
// 灵感卡:编辑 · 标签 · 转待办 · 删除;任务卡:编辑 · 标签 · 状态/截止/优先级 ·
// 撤回(仅 todo,两拍并提示会清截止/优先级)· 入册(仅 done)· 删除。
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
import {
  addItemImage,
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
  type SpaceInfo,
  type TaskStatus,
  type TimelineItem,
  type TopicItem,
} from "./api";
import { t } from "./i18n";
import { $, actionBar, confirmBar, esc, hideConfirmBar, isTaskStage, showBar, showError } from "./ui";
import { capturePhoto, PICK_MAX, pickImages, toBase64 } from "./images";

type Mode = "actions" | "edit" | "tags" | "move";

type PanelState = {
  space: string;
  id: string;
  mode: Mode;
  /** tags 面的全部标签(进入时现读;写后异步重读,失败不牵连业务写)。 */
  topics: TopicItem[];
  /** 编辑草稿(null=非编辑态)。真相在这,DOM 只是投影。 */
  editDraft: string | null;
  /** 标签新建输入草稿。 */
  tagDraft: string;
  /** listTopics 请求序号(三审 M3):enterTags/refreshTopics 共用,旧快照晚回不许
   *  覆盖新快照。 */
  topicsSeq: number;
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
};

const STATUSES: { key: TaskStatus; label: string }[] = [
  { key: "todo", label: t("ui.stageTodo") },
  { key: "doing", label: t("ui.stageDoing") },
  { key: "confirming", label: t("ui.stageConfirming") },
  { key: "done", label: t("ui.stageDone") },
];
const PRIORITIES: { key: 1 | 2 | 3 | null; label: string }[] = [
  { key: null, label: t("cardpanel.prioNone") },
  { key: 1, label: t("cardpanel.prioLow") },
  { key: 2, label: t("cardpanel.prioMid") },
  { key: 3, label: t("cardpanel.prioHigh") },
];

let deps: Deps;
let state: PanelState | null = null;
let busy = false; // 面板内写操作 in-flight:整面禁点(事件入口统一拒)

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
  state = null;
  document.querySelector("#timeline .panel")?.remove();
  clearImgManage();
  if (hadDraft) showBar(reason ?? t("cardpanel.draftDropped"));
  deps.onDraftClosed();
}

/** refresh 重建 DOM 后把展开态接回;条目已不在(被删/换空间)= 清态。 */
export function restore(scope: HTMLElement) {
  if (!state) return;
  if (state.space !== getCurrentSpace() || !deps.getItem(state.id)) {
    state = null;
    clearConfirm(); // 条目已不在:挂着的确认一并作废
    return;
  }
  const card = scope.querySelector<HTMLElement>(`article.card[data-id="${state.id}"]`);
  if (!card) {
    state = null;
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

/** 摘掉缩略图删图 × 的显隐标记(面板拆除时用;renderPanel 里换卡自会摘旧上新)。 */
function clearImgManage() {
  document.querySelector("#timeline .card.imgmanage")?.classList.remove("imgmanage");
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

function renderPanel(card: HTMLElement) {
  if (!state) return;
  const item = deps.getItem(state.id);
  if (!item) return;
  document.querySelector("#timeline .panel")?.remove();
  const panel = document.createElement("div");
  panel.className = "panel";
  if (state.mode === "edit") {
    panel.innerHTML = renderEdit();
  } else if (state.mode === "tags") {
    panel.innerHTML = renderTags(item);
  } else if (state.mode === "move") {
    panel.innerHTML = renderMove();
  } else {
    panel.innerHTML = renderActions(item);
  }
  card.querySelector(".body")!.appendChild(panel);
  // 编辑态多图管理:仅 actions 面露出缩略图删图 ×(main.ts 接管删除)。同一时刻只一张卡开面,
  // 先摘所有旧标记再给当前卡上——换卡/进 edit·tags·move 面都会随之收起 ×。
  document
    .querySelectorAll<HTMLElement>("#timeline .card.imgmanage")
    .forEach((c) => c.classList.remove("imgmanage"));
  if (state.mode === "actions") card.classList.add("imgmanage");
  if (state.mode === "edit" && !busy) {
    const ta = panel.querySelector<HTMLTextAreaElement>("textarea.edit")!;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
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
  const acts: string[] = [
    actBtn("edit", t("cardpanel.actEdit")),
    actBtn("tags", t("cardpanel.actTags")),
    actBtn("addimg", t("cardpanel.actAddImg")),
    actBtn("photo", t("cardpanel.actPhoto")),
    actBtn("comment", t("cardpanel.actComment")),
  ];
  if (!task) acts.push(actBtn("promote", t("cardpanel.actPromote")));
  if (item.stage === "todo") acts.push(actBtn("revert", t("cardpanel.actRevert"), { warn: true }));
  if (item.stage === "done") acts.push(actBtn("seal", t("cardpanel.actSeal")));
  // 移动入口:仅 ≥2 空间、且本条无未处理的部分移动登记时出现(§4)。
  if (!partial && deps.getSpaces().length >= 2) acts.push(actBtn("move", t("cardpanel.actMove")));
  acts.push(actBtn("del", t("cardpanel.actDelete"), { warn: true }));
  const lanes = task
    ? `<div class="lane"><span class="lab">${t("cardpanel.laneStatus")}</span><span class="pillrow">${STATUSES.map((s) =>
        pill(s.label, `data-status="${s.key}"`, item.stage === s.key, busy || item.stage === s.key),
      ).join("")}</span></div>
      <div class="lane"><span class="lab">${t("cardpanel.laneDue")}</span>
        <input type="date" data-due value="${esc(item.due_on ?? "")}"${busy ? " disabled" : ""} />
        ${item.due_on ? `<button data-pact="due-clear" class="p"${busy ? " disabled" : ""}>${t("cardpanel.dueClear")}</button>` : ""}
      </div>
      <div class="lane"><span class="lab">${t("cardpanel.lanePriority")}</span><span class="pillrow">${PRIORITIES.map((p) =>
        pill(
          p.label,
          `data-prio="${p.key ?? ""}"`,
          (item.priority ?? null) === p.key,
          busy || (item.priority ?? null) === p.key,
        ),
      ).join("")}</span></div>`
    : "";
  return `${noteBlock}<div class="acts">${acts.join("")}</div>${lanes}`;
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

function renderEdit(): string {
  return `<textarea class="edit">${esc(state?.editDraft ?? "")}</textarea>
    <div class="acts">
      <button data-pact="save" class="confirm"${busy ? " disabled" : ""}>${t("cardpanel.save")}</button>
      <button data-pact="cancel"${busy ? " disabled" : ""}>${t("cardpanel.cancel")}</button>
    </div>`;
}

function renderTags(item: TimelineItem): string {
  if (!state) return "";
  const task = isTaskStage(item.stage);
  const linked = new Set(item.topics.map((t) => t.id));
  const pills = state.topics
    .map((tp) => {
      const on = linked.has(tp.id);
      // 灵感的已挂标签不可摘(core 没有该原语,与桌面能力一致——不造假入口)。
      const disabled = busy || (!task && on);
      return `<button data-topic="${esc(tp.id)}" class="p${on ? " on" : ""}${tp.color ? " tinted" : ""}"${
        disabled ? " disabled" : ""
      }${!task && on ? ` title="${t("cardpanel.tagLocked")}" aria-disabled="true"` : ""}${
        tp.color ? ` style="--tc:${esc(tp.color)}"` : ""
      }>${esc(tp.title)}</button>`;
    })
    .join("");
  // 有已挂标签的灵感:一行弱提示把「禁点」讲明白(实现审 L8,克制不造假入口)。
  const ideaHint =
    !task && item.topics.length
      ? `<div class="lane"><span class="lab">${t("cardpanel.ideaTagAddOnly")}</span></div>`
      : "";
  return `<div class="lane"><span class="pillrow">${pills || `<span class="lab">${t("cardpanel.noTags")}</span>`}</span></div>
    ${ideaHint}
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
        if (state === session) state = null;
        if (here) {
          showBar(t("cardpanel.moved", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "copied_but_source_kept":
        if (state === session) session.mode = "actions"; // 回 actions 面显登记提示、藏移动入口
        if (here) {
          showBar(t("cardpanel.movedKept", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "copied_but_source_unconfirmed":
        // 源删除状态未知,绝不谎报「保留」(codex 实现审 #2)。
        if (state === session) session.mode = "actions";
        if (here) {
          showBar(t("cardpanel.movedUnconfirmed", { name: targetLabel }), true);
          void deps.refresh();
        }
        break;
      case "images_pending":
        if (here && state === session) {
          session.mode = "actions";
          showError(t("cardpanel.imagesPending", { n: result.count }));
        }
        break;
      case "dangling_refs":
        if (here && state === session) {
          session.mode = "actions";
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
  const seq = ++session.topicsSeq;
  try {
    const topics = await listTopics(space);
    // 在途期间面板可自由导航(此处不 busy):session 换了/空间换了/更新的请求
    // 出发了/用户已进编辑态/「记下」开始在飞(实现审 M1:锁定期不许新开草稿态面)
    // ——一律弃,不许把 mode 硬翻回 tags 踩掉编辑。
    if (
      state !== session ||
      space !== getCurrentSpace() ||
      seq !== session.topicsSeq ||
      session.mode !== "actions" ||
      deps.isCaptureSaving()
    ) {
      return;
    }
    session.mode = "tags";
    session.topics = topics;
    const c = currentCard() ?? card;
    renderPanel(c);
  } catch (err) {
    if (state === session && space === getCurrentSpace() && seq === session.topicsSeq) {
      showError(String(err));
    }
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
        session.mode = "actions";
        deps.onDraftClosed();
      },
    },
  );
}

/** 编辑/标签草稿收场(取消/同值/返回):回 actions 面,补被延后的刷新。 */
function closeDraft() {
  if (!state) return;
  state.editDraft = null;
  state.tagDraft = "";
  state.mode = "actions";
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
  let ok = 0;
  let firstErr = "";
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
          await addItemImage(space, itemId, f.type, b64);
          ok += 1;
        } catch (err) {
          if (!firstErr) firstErr = String(err);
        }
      }
    },
    {
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

// ---- 事件接线 ----------------------------------------------------------------

function onTimelineClick(e: Event) {
  if (deps.isSwitching() || deps.isCaptureSaving()) return;
  if (busy) return; // in-flight:面板一切导航(开合/换卡/控件)整体拒(实现审 M2)
  const el = e.target as HTMLElement;
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
    if (!task && linked) return; // 灵感已挂:不可摘(按钮本就 disabled,兜底)
    void run(
      async (space) => {
        if (task) {
          if (linked) await removeTaskTopic(space, item.id, topicId);
          else await addTaskTopic(space, item.id, topicId);
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
  const statusBtn = el.closest<HTMLElement>("[data-status]");
  if (statusBtn && state) {
    const session = state;
    const to = statusBtn.dataset.status as TaskStatus;
    void run((space) => updateTaskStatus(space, session.id, to));
    return;
  }
  const prioBtn = el.closest<HTMLElement>("[data-prio]");
  if (prioBtn && state) {
    const session = state;
    const raw = prioBtn.dataset.prio!;
    const prio = raw === "" ? null : (Number(raw) as 1 | 2 | 3);
    void run((space) => setTaskPriority(space, session.id, prio));
    return;
  }
  // 面板内其余区域(textarea/输入框等)不冒泡成开合。
  if (el.closest(".panel")) return;
  // 勾框、缩略图、留言徽章各有其主(main.ts),不抢——徽章漏在这里的话,点它会连带
  // 把操作面板开合一次(留言层滑上来,底下的面板悄悄换了态)。
  if (el.closest(".tick") || el.closest(".thumb") || el.closest(".cm-badge")) return;
  const card = el.closest<HTMLElement>("article.card[data-id]");
  if (!card) return;
  const id = card.dataset.id!;
  if (state?.id === id) {
    if (hasDirtyDraft()) return; // 有草稿不许点空白收面(误触丢字)
    clearConfirm();
    state = null;
    card.querySelector(".panel")?.remove();
    card.classList.remove("imgmanage");
    deps.onDraftClosed(); // 三审 M1:收面即「草稿域收场」,补被延后的刷新
    return;
  }
  if (hasDirtyDraft()) {
    showError(t("cardpanel.finishDraftFirst"));
    return;
  }
  clearConfirm();
  state = {
    space: getCurrentSpace(),
    id,
    mode: "actions",
    topics: [],
    editDraft: null,
    tagDraft: "",
    topicsSeq: 0,
  };
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
      session.mode = "edit";
      session.editDraft = item.content;
      renderPanel(card);
      return;
    case "tags":
      clearConfirm();
      void enterTags(card);
      return;
    case "addimg":
      clearConfirm();
      void addImages(session.id);
      return;
    case "photo":
      clearConfirm();
      void addPhoto(session.id);
      return;
    case "comment":
      // 留言层盖在面板之上;面板留着不收(收层回来还在原处)。写/删由留言层自己走
      // 命令与刷新,不经 run()——它不是面板的业务写。
      clearConfirm();
      deps.openComments(session.id);
      return;
    case "move":
      clearConfirm();
      session.mode = "move";
      renderPanel(card);
      return;
    case "move-ack":
      // 「我已处理」:清部分移动登记(源条目已由用户自行处置),回 actions 面
      // (移动入口随之复现)。登记键 = 当前空间/id(面板恒开在当前空间)。
      movePartialClear(item.id);
      renderPanel(card);
      return;
    case "back":
    case "cancel":
      closeDraft();
      return;
    case "save":
      void saveEdit();
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
      void run((space) => setTaskDue(space, item.id, null));
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
            state = null;
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
            state = null;
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
  void run((space) => setTaskDue(space, session.id, v === "" ? null : v));
}

/** 草稿实时入 state(实现审 H1:真相在 state,重画从 state 画回)。 */
function onTimelineInput(e: Event) {
  const t = e.target as HTMLElement;
  if (!state) return;
  if (deps.isCaptureSaving()) {
    // 锁定期不受理新草稿(146 实现审 M1):tagDraft 变脏会把「记下」后的 refresh
    // 无限延后、新卡落不了 DOM——DOM 回写成 state,不留「看得见、state 没有」的假草稿。
    if (t.matches("textarea.edit")) (t as HTMLTextAreaElement).value = state.editDraft ?? "";
    else if (t.matches("input.tagnew")) (t as HTMLInputElement).value = state.tagDraft;
    return;
  }
  if (t.matches("textarea.edit")) {
    state.editDraft = (t as HTMLTextAreaElement).value;
  } else if (t.matches("input.tagnew")) {
    state.tagDraft = (t as HTMLInputElement).value;
  }
}

export function initCardPanel(d: Deps) {
  deps = d;
  const timeline = $("timeline");
  timeline.addEventListener("click", onTimelineClick);
  timeline.addEventListener("change", onTimelineChange);
  timeline.addEventListener("input", onTimelineInput);
}
