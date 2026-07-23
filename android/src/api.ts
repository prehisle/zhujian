// 全功能底座(119)的前端调用层:安卓壳业务命令的类型与包装,单一真相源。
// UI 各工序接线时从这里 import,不再手写 invoke 字符串。
//
// 两条纪律(全部来自 117 五轮 codex 审的结论,勿回退):
// - **业务包装一律显式收 `space` 参数**(读写皆然)且**正常 resolve/reject**:调用方
//   显式带「点击/发起那一刻的空间」,响应回来自行判弃(`space !== getCurrentSpace()`
//   = 弃)。117 审出 sinvoke 的「永不决议」会毒化 single-flight 闸/pending 表
//   (refresh 在飞闸、取图去重表被悬挂 Promise 堵死),业务路不再用它。
// - `sinvoke`(自动注入当前空间 + 迟到响应永不决议)只留给**孤立的状态类读**
//   (sync_status/db_info/恢复码——fire-and-forget 渲染,没有 finally/闸依赖)。
//
// currentSpace 影子(后端 foreground 的镜像)也在此:main.ts 切换/对账时写入,
// 所有读方(包括 main.ts 的判弃逻辑)从这里取。
import { invoke } from "@tauri-apps/api/core";

export const MAIN_SPACE = "main";

let currentSpace = MAIN_SPACE;

/** 后端 foreground 的影子。只有切换编排/对账代码可以写(main.ts);业务代码只读。 */
export function getCurrentSpace(): string {
  return currentSpace;
}

export function setCurrentSpace(id: string): void {
  currentSpace = id;
}

// ---- 空间列表(picker / chip 共用;调用层单一真相源,main.ts 从此 import) ----------

export type SpaceInfo = { id: string; name: string | null; configured: boolean; current: boolean };

/** 空间展示名(main=默认空间;无名非 main 带 ID 尾缀——space-entry-plan §3.6:
 *  加入的空间可能源侧从未命名,多个无名空间必须可辨识)。 */
export function spaceLabel(s: { id: string; name: string | null }): string {
  return s.name ?? (s.id === MAIN_SPACE ? "默认空间" : `未命名空间 · ${s.id.slice(-4)}`);
}

/** 全部空间(主库恒第一)。命令不带 space。 */
export const listSpaces = () => invoke<SpaceInfo[]>("list_spaces");

/** 状态类读的统一入口:注入当前 spaceId;响应回来时空间已切换 = 迟到响应,连同
 *  错误一起丢弃(永不决议)。⚠ 业务读写不走它(见文件头纪律),别扩大使用面。 */
export function sinvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const space = currentSpace;
  return invoke<T>(cmd, { ...args, spaceId: space }).then(
    (r) => (currentSpace === space ? r : new Promise<T>(() => {})),
    (e: unknown) => (currentSpace === space ? Promise.reject(e) : new Promise<T>(() => {})),
  );
}

// ---- 类型(与安卓壳 lib.rs 的 DTO 逐字段一致;后者又与桌面壳同形) ----------------

// 值域钉死在类型上(codex 119 一审 L1):状态/优先级写错在 tsc 就死,不等真机
// 才被 Rust 拒;状态映射可做编译期穷尽检查。词汇表与 core 的 CHECK 约束同源。
export type TaskStatus = "todo" | "doing" | "confirming" | "done";
export type IdeaStage = "inbox" | "filed";
/** items.stage 全部六态(时间轴行原样透传)。 */
export type ItemStage = IdeaStage | TaskStatus;
/** 搜索命中的视图词汇(repo::view_status)。 */
export type SearchStatus = "inbox" | "processed" | "task" | "archived" | "sealed";
export type TaskPriority = 1 | 2 | 3;

export type TopicItem = { id: string; title: string; color: string | null };
export type ImageMeta = { id: string; seq: number; mime: string };
export type TimelineItem = {
  id: string;
  content: string;
  created_at: string;
  stage: ItemStage;
  /** 任务行的当前真值(卡片面板直读,不另拼 list_tasks);灵感行恒 null。 */
  due_on: string | null;
  priority: TaskPriority | null;
  /** 完成时刻(RFC3339,0030 done_at):done 行据它显示「完成于」;灵感/未完成行 null。 */
  done_at: string | null;
  topics: TopicItem[];
  images: ImageMeta[];
};
/** 统一回收站的一行(stage=冻结在入站前的原 stage;archived_at=删除时间轴)。 */
export type TrashItem = {
  id: string;
  content: string;
  created_at: string;
  archived_at: string;
  stage: ItemStage;
  topics: TopicItem[];
};
/** 一条灵感(回收站行冻结在入站前的 stage)。 */
export type IdeaItem = {
  id: string;
  content: string;
  created_at: string;
  stage: IdeaStage;
  topics: TopicItem[];
};
/** 一张看板卡(title=content、status=stage 的桌面前端契约)。 */
export type TaskItem = {
  id: string;
  title: string;
  status: TaskStatus;
  due_on: string | null;
  priority: TaskPriority | null;
  sealed_at: string | null;
  /** 完成时刻(RFC3339,0030 done_at),null = 未知老卡。归档册按 done_at ?? sealed_at
   *  显示/排序(完成日优先)。只增不清。 */
  done_at: string | null;
  topics: TopicItem[];
};
export type TopicNoteItem = { id: string; content: string; created_at: string };
export type TopicTreeItem = {
  id: string;
  title: string;
  color: string | null;
  /** 手动排序键(0031 frindex)或 null=未定序——标签管理面据它排序/拖动定位。 */
  position: string | null;
  /** 标签类型自由文本(0031)或 null=无类型。 */
  kind: string | null;
  notes: TopicNoteItem[];
};
export type SearchHitItem = {
  id: string;
  content: string;
  created_at: string;
  status: SearchStatus;
  topics: string[];
};
export type RevisionItem = { content: string; archived_at: string };
export type IdeaStats = { captured_week: number; born_inbox: number; converted: number };

// ---- 读(显式 space;调用方自行判弃迟到响应) ------------------------------------

export const listTimeline = (space: string) =>
  invoke<TimelineItem[]>("list_timeline", { spaceId: space });

export const listIdeas = (space: string) => invoke<IdeaItem[]>("list_ideas", { spaceId: space });

/** 灵感回收站(archived_at 轴)。 */
export const listArchivedIdeas = (space: string) =>
  invoke<IdeaItem[]>("list_archived", { spaceId: space });

/** weekStart = 按本地周一 00:00 换算的 UTC RFC3339(后端从不算本地时间)。 */
export const ideaStats = (space: string, weekStart: string) =>
  invoke<IdeaStats>("idea_stats", { spaceId: space, weekStart });

/** 全局搜索(连历史、覆盖灵感/任务/回收站/归档册)。空词后端响亮拒。 */
export const searchNotes = (space: string, query: string) =>
  invoke<SearchHitItem[]>("search_notes", { spaceId: space, query });

export const listNoteHistory = (space: string, id: string) =>
  invoke<RevisionItem[]>("list_note_history", { spaceId: space, id });

export const listTasks = (space: string) => invoke<TaskItem[]>("list_tasks", { spaceId: space });

/** 统一回收站(灵感+任务合并,最近删除在前)。 */
export const listTrash = (space: string) => invoke<TrashItem[]>("list_trash", { spaceId: space });

export const listArchivedTasks = (space: string) =>
  invoke<TaskItem[]>("list_archived_tasks", { spaceId: space });

export const listSealedTasks = (space: string) =>
  invoke<TaskItem[]>("list_sealed_tasks", { spaceId: space });

export const listTopics = (space: string) => invoke<TopicItem[]>("list_topics", { spaceId: space });

/** 按标签浏览(只含名下有灵感的标签)。 */
export const listTopicTree = (space: string) =>
  invoke<TopicTreeItem[]>("list_topic_tree", { spaceId: space });

/** 标签管理视图(含空标签)。 */
export const listTopicsFull = (space: string) =>
  invoke<TopicTreeItem[]>("list_topics_full", { spaceId: space });

export const listItemImages = (space: string, itemId: string) =>
  invoke<ImageMeta[]>("list_item_images", { spaceId: space, itemId });

/** 一张图的字节(`data:` URL)。全尺寸不小,取回后按需降采样、勿囤原图(117)。 */
export const getItemImage = (space: string, imageId: string) =>
  invoke<string>("get_item_image", { spaceId: space, imageId });

// ---- 写(显式 space = 「点击那一刻看到的空间」;后端 coord 复核,切换中响亮拒) ----

export const captureIdea = (space: string, content: string) =>
  invoke<string>("capture_idea", { spaceId: space, content });

export const captureTodo = (space: string, content: string) =>
  invoke<string>("capture_todo", { spaceId: space, content });

/** 勾「标完成」(= 流转到 done 的便捷路)。 */
export const completeTask = (space: string, id: string) =>
  invoke<void>("complete_task", { spaceId: space, id });

/** 编辑条目正文(全 stage;旧版本自动入历史)。 */
export const editNote = (space: string, id: string, content: string) =>
  invoke<void>("edit_note", { spaceId: space, id, content });

/** 灵感删除 = 进回收站。 */
export const archiveNote = (space: string, id: string) =>
  invoke<void>("archive_note", { spaceId: space, id });

export const restoreNote = (space: string, id: string) =>
  invoke<void>("restore_note", { spaceId: space, id });

/** 彻底删除(仅回收站内;UI 须二次确认)。 */
export const purgeNote = (space: string, id: string) =>
  invoke<void>("purge_note", { spaceId: space, id });

/** 清空灵感回收站,返回删除条数。 */
export const purgeArchived = (space: string) =>
  invoke<number>("purge_archived", { spaceId: space });

/** 灵感转待办(翻 stage 零副本)。返回任务 id。 */
export const promoteNoteToTask = (space: string, id: string, title: string) =>
  invoke<string>("promote_note_to_task", { spaceId: space, id, title });

/** 待办撤回为灵感(仅 todo 列)。 */
export const revertTaskToInbox = (space: string, id: string) =>
  invoke<void>("revert_task_to_inbox", { spaceId: space, id });

/** 给灵感挂标签:topicId 与 newTitle 二选一。返回标签 id。 */
export const fileNoteToTopic = (
  space: string,
  id: string,
  topicId: string | null,
  newTitle: string | null,
) => invoke<string>("file_note_to_topic", { spaceId: space, id, topicId, newTitle });

/** 新建任务(生而 todo、置列首;可带截止/优先级/标签)。返回 id。 */
export const createTask = (
  space: string,
  title: string,
  dueOn: string | null,
  priority: number | null,
  topicId: string | null,
) => invoke<string>("create_task", { spaceId: space, title, dueOn, priority, topicId });

export const renameTask = (space: string, id: string, title: string) =>
  invoke<void>("rename_task", { spaceId: space, id, title });

/** 任务换列。 */
export const updateTaskStatus = (space: string, id: string, to: TaskStatus) =>
  invoke<void>("update_task_status", { spaceId: space, id, to });

/** 拖动排序(无过滤强契约路;orderedIds = 目标列完整新序,baseTargetIds = 拖前序)。 */
export const reorderTask = (
  space: string,
  id: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  baseTargetIds: string[],
  orderedIds: string[],
) =>
  invoke<void>("reorder_task", { spaceId: space, id, fromStatus, toStatus, baseTargetIds, orderedIds });

/** 过滤视图下的拖动排序(可见子集,后端 visible-merge)。 */
export const reorderTaskVisible = (
  space: string,
  id: string,
  fromStatus: TaskStatus,
  toStatus: TaskStatus,
  baseVisibleIds: string[],
  visibleAfter: string[],
) =>
  invoke<void>("reorder_task_visible", {
    spaceId: space,
    id,
    fromStatus,
    toStatus,
    baseVisibleIds,
    visibleAfter,
  });

/** 设/清截止日(`YYYY-MM-DD` 本地日历日,null=清)。 */
export const setTaskDue = (space: string, id: string, dueOn: string | null) =>
  invoke<void>("set_task_due", { spaceId: space, id, dueOn });

/** 设/清优先级(1/2/3=低/中/高,null=未设)。 */
export const setTaskPriority = (space: string, id: string, priority: TaskPriority | null) =>
  invoke<void>("set_task_priority", { spaceId: space, id, priority });

export const addTaskTopic = (space: string, id: string, topicId: string) =>
  invoke<void>("add_task_topic", { spaceId: space, id, topicId });

/** 按标题给任务挂标签(同名复用、缺则新建,原子)。返回标签 id。 */
export const addTaskTopicByTitle = (space: string, id: string, title: string) =>
  invoke<string>("add_task_topic_by_title", { spaceId: space, id, title });

export const removeTaskTopic = (space: string, id: string, topicId: string) =>
  invoke<void>("remove_task_topic", { spaceId: space, id, topicId });

/** 任务删除 = 进回收站。 */
export const archiveTask = (space: string, id: string) =>
  invoke<void>("archive_task", { spaceId: space, id });

export const restoreTask = (space: string, id: string) =>
  invoke<void>("restore_task", { spaceId: space, id });

/** 彻底删除(仅回收站内;UI 须二次确认)。 */
export const purgeTask = (space: string, id: string) =>
  invoke<void>("purge_task", { spaceId: space, id });

/** 清空任务回收站,返回删除条数。 */
export const purgeArchivedTasks = (space: string) =>
  invoke<number>("purge_archived_tasks", { spaceId: space });

/** 一次清空统一回收站(灵感+任务,core 单事务;别用两条分域清空拼)。 */
export const purgeAllTrash = (space: string) =>
  invoke<number>("purge_all_trash", { spaceId: space });

/** 已完成任务入成就册(可查不可删)。 */
export const sealTask = (space: string, id: string) =>
  invoke<void>("seal_task", { spaceId: space, id });

/** 一键归档「已完成」列,返回条数。 */
export const sealDoneTasks = (space: string) => invoke<number>("seal_done_tasks", { spaceId: space });

/** 取消归档:回看板「已完成」列末尾。 */
export const unsealTask = (space: string, id: string) =>
  invoke<void>("unseal_task", { spaceId: space, id });

/** 新建标签。返回 id。 */
export const createTopic = (space: string, title: string) =>
  invoke<string>("create_topic", { spaceId: space, title });

/** 标签改名。 */
export const updateTopic = (space: string, id: string, title: string) =>
  invoke<void>("update_topic", { spaceId: space, id, title });

/** 设/清标签颜色(`#RRGGBB`,null=清)。 */
export const setTopicColor = (space: string, id: string, color: string | null) =>
  invoke<void>("set_topic_color", { spaceId: space, id, color });

/** 删标签(条目本身不动)。 */
export const deleteTopic = (space: string, id: string) =>
  invoke<void>("delete_topic", { spaceId: space, id });

/** 合并标签(来源并入目标,可顺带改名)。返回目标 id。 */
export const mergeTopics = (
  space: string,
  sourceIds: string[],
  targetId: string,
  newTitle: string | null,
) => invoke<string>("merge_topics", { spaceId: space, sourceIds, targetId, newTitle });

/** 标签手动重排(0031):把 id 挪到 prevId(null=列首)与 nextId(null=列尾)之间。 */
export const reorderTopic = (
  space: string,
  id: string,
  prevId: string | null,
  nextId: string | null,
) => invoke<void>("reorder_topic", { spaceId: space, id, prevId, nextId });

/** 设/清标签类型自由文本(0031;null=清)。 */
export const setTopicKind = (space: string, id: string, kind: string | null) =>
  invoke<void>("set_topic_kind", { spaceId: space, id, kind });

/** 挂一张图(dataB64 = 字节的 base64)。返回元数据(id + 「图N」编号 + MIME)。 */
export const addItemImage = (space: string, itemId: string, mime: string, dataB64: string) =>
  invoke<ImageMeta>("add_item_image", { spaceId: space, itemId, mime, dataB64 });

/** 删一张图(编号退役不重排)。 */
export const deleteItemImage = (space: string, imageId: string) =>
  invoke<void>("delete_item_image", { spaceId: space, imageId });

// ---- 同步:创号 / 邀请(phone-space-plan,与桌面对称;写类命令显式 space、正常决议) ----

/** 创号结果:core 一旦提交,恢复码必达(强制仪式的数据面);post-commit 阶段
 *  (目录刷新/上线 poke)的失败只在 post_commit_error 旁路报告,绝不吞码。 */
export type CreateAccountOutcome = {
  recovery_code: string;
  post_commit_error: string | null;
};

/** 创建同步账户(账户首台;open-signup 无感创号——账户 ULID 由 core 自生成,
 *  无码)。成功后调用方必须走强制仪式(展示+警示+回输核对)——即使空间已切走
 *  也要展示:码已提交,只出这一次机会窗。 */
export const syncCreateAccount = (space: string, serverUrl: string) =>
  invoke<CreateAccountOutcome>("sync_create_account", { spaceId: space, serverUrl });

/** 出码结果:码与服务器地址同 runtime 原子取(实现审 M3——前端自己从状态缓存拼
 *  server_url,切空间窗口里会给出「新空间的码 + 旧空间的地址」)。 */
export type PairStartOutcome = { code: string; server_url: string };

/** 发起配对(老设备侧,出配对码)。出码页两项都要展示,对方两项都要填。超时
 *  所有权在 core(开槽 15s/码 TTL 10 分钟)。 */
export const syncPairStart = (space: string) =>
  invoke<PairStartOutcome>("sync_pair_start", { spaceId: space });

// ---- 跨空间移动(cross-space-move-plan §2.7 安卓入口;镜像桌面 src/space.ts) ----

/** 移动结果五分道(core::move_item::MoveResult 的 JSON 镜像;字段名由 core 的
 *  move_result_serde_contract 测试钉死,谁改 Rust 变体名那测即红)。UI 按 outcome
 *  分道:moved 卡离场;copied_but_source_* 保留源卡+登记;两预检拒各有话术。 */
export type MoveResult =
  | { outcome: "moved"; new_id: string; source_already_gone: boolean }
  | { outcome: "copied_but_source_kept"; new_id: string; reason: string }
  | { outcome: "copied_but_source_unconfirmed"; new_id: string; error: string }
  | { outcome: "images_pending"; count: number }
  | { outcome: "dangling_refs"; seqs: number[] };

/** 把 sourceSpaceId 的一条条目移进 targetSpaceId。**刻意用 raw invoke、不走 sinvoke
 *  决议丢弃包装**——移动期间切走空间的话,sinvoke 把响应变永不决议,部分成功(目标
 *  已建)就永远写不进登记、诱导用户重跑造第二份(桌面二审教训)。这里恒决议,迟到
 *  语义由调用方按登记处理。 */
export const moveItemToSpace = (sourceSpaceId: string, targetSpaceId: string, itemId: string) =>
  invoke<MoveResult>("move_item_to_space", {
    spaceId: sourceSpaceId,
    targetSpaceId,
    itemId,
  });

// 部分成功登记(kept/unconfirmed = 目标已建、源仍在/未知):这个事实独立于任何 DOM——
// 取消、重画、切空间、重启都不能让它消失,否则用户重跑造第二份。localStorage 持久化,
// 键 `${源空间}/${itemId}`,值 = 给用户看的原话。
const MOVE_PARTIAL_KEY = "zhujian.move-partial";

function loadMovePartials(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MOVE_PARTIAL_KEY) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

export function movePartialMark(spaceId: string, itemId: string, message: string): void {
  const m = loadMovePartials();
  m[`${spaceId}/${itemId}`] = message;
  localStorage.setItem(MOVE_PARTIAL_KEY, JSON.stringify(m));
}

export function movePartialNote(itemId: string, spaceId = getCurrentSpace()): string | null {
  return loadMovePartials()[`${spaceId}/${itemId}`] ?? null;
}

export function movePartialClear(itemId: string, spaceId = getCurrentSpace()): void {
  const m = loadMovePartials();
  delete m[`${spaceId}/${itemId}`];
  localStorage.setItem(MOVE_PARTIAL_KEY, JSON.stringify(m));
}

/** 移动目标的可辨识标签:重名空间(多端并发合法产物)必须能分清——main 缀
 *  「(默认空间)」、其余缀 ULID 尾 6 位;选错目标 = 源条目与编辑历史白删,不能让
 *  用户对两个一样的按钮赌运气。不重名时就是 spaceLabel 原样。 */
export function distinctSpaceLabels(list: SpaceInfo[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const s of list) {
    const base = spaceLabel(s);
    count.set(base, (count.get(base) ?? 0) + 1);
  }
  return new Map(
    list.map((s) => {
      const base = spaceLabel(s);
      if ((count.get(base) ?? 0) <= 1) return [s.id, base] as const;
      const tail = s.id === MAIN_SPACE ? "(默认空间)" : ` · ${s.id.slice(-6)}`;
      return [s.id, `${base}${tail}`] as const;
    }),
  );
}
