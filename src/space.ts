// 多空间的前端真相源(sync-plan §六,97):当前空间 + invoke 包装层。
// 全部业务 invoke 都从这里走——统一注入 spaceId(后端命令面是显式 space_id,
// 无隐式 active 状态),响应回来时空间已切换 = 迟到响应,连同错误一起丢弃
// (切空间必然整视图重挂、重新拉数据;旧空间的数据/报错不许重画/惊扰新空间)。
//
// 工序 8(multispace-plan §9/§16.2)起捕获落「当前所在空间」:壳侧 ForegroundSpace
// 是权威(capture 与 notebook 是两个 WebView,模块态不跨窗)——notebook 的
// setCurrentSpace 同步喂壳;capture 浮窗听 "space-foreground" 显示目标名、保存
// 那刻 mirrorSpace 对齐注入目标,由后端复核(目标已变 = 响亮拒,草稿保留)。
import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/// 主库(默认空间/第一空间)的固定 space_id——spaces.rs::MAIN_SPACE 的镜像。
export const MAIN_SPACE = "main";
const LAST_SPACE_KEY = "zhujian.last-space";

// lib.rs sync_status / transport.rs::SyncStatus 的镜像(SpaceInfo 携带,故住这里;
// sync.ts import type 复用)。
export type SyncStatus = {
  configured: boolean;
  state: string; // off | connecting | booting | online | offline
  account_id: string | null;
  device_id: string | null;
  server_url: string | null;
  peers_online: number;
  error: string | null;
  frozen: string[];
  suspended: number;
  skew: boolean;
  clock_skew: boolean;
};

export type SpaceInfo = {
  id: string;
  /** 用户起的名;null = 从未改名(缺省显示由 spaceLabel 定,后端绝不主动写名)。 */
  name: string | null;
  status: SyncStatus;
  /** false = 启动时未装载(同一物理库的第二个名字被 hard veto):列出说明、不可切入。 */
  alive: boolean;
};

let current = MAIN_SPACE;

export function currentSpaceId(): string {
  return current;
}

/** notebook 壳启动时调一次:恢复上次空间(对照后端现有空间校验;缺省/已不存在/
 *  已变成未装载的 dead 空间 = 回默认空间,并清掉失效的记忆)。 */
export async function initCurrentSpace(): Promise<void> {
  const saved = localStorage.getItem(LAST_SPACE_KEY);
  if (!saved || saved === MAIN_SPACE) return;
  const all = await listSpaces();
  if (all.some((s) => s.id === saved && s.alive)) setCurrentSpace(saved);
  else localStorage.removeItem(LAST_SPACE_KEY);
}

export function setCurrentSpace(id: string): void {
  current = id;
  localStorage.setItem(LAST_SPACE_KEY, id);
  // 前台空间同步到壳(工序 8,§9):capture 浮窗是独立 WebView,模块态不跨窗——
  // 壳侧 ForegroundSpace 才是「捕获落哪」的权威,这里跟着视图切换喂它。失败只可能
  // 是空间不存在(切换入口本就只给存在空间),打日志不打断视图切换。
  void tauriInvoke("set_foreground_space", { spaceId: id }).catch((e: unknown) =>
    console.error("set_foreground_space:", e),
  );
}

/** capture 浮窗用:把本模块的注入目标对齐到「按下回车那刻看到的空间」——**不写
 *  localStorage**(那是 notebook 的视图记忆)。capture 保存期间此值不再变动,
 *  invoke 的响应恒不过期(stale() 的「永不决议」只该用于 notebook 的跨空间迟到
 *  读响应,吞掉保存响应会让按钮 finally 永不执行、草稿窗卡死,§16.2-4)。 */
export function mirrorSpace(id: string): void {
  current = id;
}

/** 永不决议:迟到响应的归宿(无人 then 它,随 GC 走;比抛错干净——旧视图早已被重挂替换,谁也不该再处理旧空间的结果)。 */
function stale<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/** 业务命令统一入口:注入当前 spaceId;跨空间迟到的响应与报错一律丢弃。 */
export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const space = current;
  return tauriInvoke<T>(cmd, { ...args, spaceId: space }).then(
    (r) => (current === space ? r : stale<T>()),
    (e: unknown) => (current === space ? Promise.reject(e) : stale<T>()),
  );
}

/** 必落账写命令(创建/挂图这类「点下那刻结算」的链):显式携带发起那刻的空间,
 *  响应**恒到达**——统一包装的「永不决议」会让 in-flight 闸的 finally 永不执行、
 *  保存永久锁死(moveItemToSpace 同因绕开包装;118 教训第三踩,codex P1 二审 H1)。
 *  调用方自己判断响应到达时空间/视图是否已切走,再决定动不动 UI。 */
export function invokeInSpace<T = unknown>(
  space: string,
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  return tauriInvoke<T>(cmd, { ...args, spaceId: space });
}

// ---- 跨空间移动(cross-space-move v1)----

/** 移动的结构化结果(spaces.rs::MoveResult 镜像)。UI 分道:只有 moved 做卡片
 *  离场;copied_but_source_kept 保留源卡片、如实展示原因(重复优于丢失);
 *  两预检拒各有话术。 */
export type MoveResult =
  | { outcome: "moved"; new_id: string; source_already_gone: boolean }
  | { outcome: "copied_but_source_kept"; new_id: string; reason: string }
  | { outcome: "copied_but_source_unconfirmed"; new_id: string; error: string }
  | { outcome: "images_pending"; count: number }
  | { outcome: "dangling_refs"; seqs: number[] };

/** 把当前空间的一条条目移进 `targetSpaceId`。**刻意不走统一 invoke 包装**——移动
 *  期间用户切走空间的话,包装层会把响应变成永不决议,部分成功(目标已建)的结果
 *  就永远写不进登记、下次回来还能重跑整个移动(codex 实现审二轮)。这里显式捕获
 *  发起那一刻的空间,响应恒到达;迟到语义由调用方按登记处理,不靠丢弃。 */
export function moveItemToSpace(
  sourceSpaceId: string,
  targetSpaceId: string,
  itemId: string,
): Promise<MoveResult> {
  return tauriInvoke<MoveResult>("move_item_to_space", {
    spaceId: sourceSpaceId,
    targetSpaceId,
    itemId,
  });
}

// ---- 部分成功登记(cross-space-move §4/codex 实现审二轮) -------------------------
// kept / unconfirmed = 目标已建、源仍在或状态未知:这个事实独立于任何 DOM——取消、重渲、
// 切空间、重启都不能让它消失,否则用户会重跑整个移动制造第二份。localStorage
// 持久化,键 `${源空间}/${itemId}`,值 = 给用户看的原话;卡片渲染时读它:显提示、
// 藏「移动」入口;「我已处理」显式解除(源条目被手动删掉后卡片不再渲染,标记
// 自然沉底,无害)。

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

export function movePartialNote(itemId: string, spaceId = currentSpaceId()): string | null {
  return loadMovePartials()[`${spaceId}/${itemId}`] ?? null;
}

export function movePartialClear(itemId: string, spaceId = currentSpaceId()): void {
  const m = loadMovePartials();
  delete m[`${spaceId}/${itemId}`];
  localStorage.setItem(MOVE_PARTIAL_KEY, JSON.stringify(m));
}

/** 移动目标的可辨识标签:重名空间(多端并发是合法产物)必须能分清——main 缀
 *  「(默认空间)」、其余缀 ULID 尾 6 位;选错目标 = 源条目与编辑历史白删,不能让
 *  用户对两个一模一样的按钮赌运气。不重名时就是 spaceLabel 原样。 */
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

// ---- 空间管理命令(app 级,不注 spaceId;rename 的目标空间是显式参数) ----

export function listSpaces(): Promise<SpaceInfo[]> {
  return tauriInvoke<SpaceInfo[]>("list_spaces");
}

export function createSpace(name: string): Promise<SpaceInfo> {
  return tauriInvoke<SpaceInfo>("create_space", { name });
}

export function renameSpace(spaceId: string, name: string): Promise<void> {
  return tauriInvoke<void>("rename_space", { spaceId, name });
}

/** 「加入空间」结果(lib.rs::JoinOutcome 镜像;space-entry-plan §3.2 三轮 M5)。
 *  integrated = 空间已进列表(前端走正常切换入口);published_needs_restart =
 *  空间已真实存在但装配失败——只提示重启后出现,**绝不当失败重试**(账户已注册,
 *  重试会二次加入)。 */
export type JoinOutcome =
  | { kind: "integrated"; space: SpaceInfo; warnings: string[] }
  | { kind: "published_needs_restart"; space_id: string; error: string };

/** 「加入空间」(space-entry-plan §2/§3,app 级、不收目标 spaceId):加入一个已在
 *  别处存在的账户,后台 staging 完成配对+引导,成功才出现为空间。**刻意不走统一
 *  invoke 包装**(必落账:切空间不许把结果变成永不决议)。 */
export function joinSpace(serverUrl: string, code: string, attemptId: string): Promise<JoinOutcome> {
  return tauriInvoke<JoinOutcome>("join_space", { serverUrl, code, attemptId });
}

/** 取消进行中的「加入空间」(只在提交前生效;提交与取消同时就绪成功优先)。 */
export function joinSpaceCancel(): Promise<void> {
  return tauriInvoke<void>("join_space_cancel");
}

/** 重置空间(epoch-plan §7):清除本机该空间副本;main 由后端原地重建 fresh 空库。
 *  调用方义务:先过两拍确认红字(数据将删除/须另一台在线完整副本/旧身份报吊销)。 */
export function resetSpace(spaceId: string): Promise<void> {
  return tauriInvoke<void>("reset_space", { spaceId });
}

/** 显示名:用户起过名用名;缺省的人话由前端定(§六⑦ 后端不写缺省名)。
 *  main 槽位缺省「默认空间」(§16.1:不再叫「个人空间」——第一个空间是本地槽位
 *  不是身份,家人手机的 main 配的就是家庭账户;也不用「当前空间」,「当前」是
 *  瞬时状态,出现在非当前行自相矛盾)。 */
export function spaceLabel(s: { id: string; name: string | null }): string {
  // 无名非 main 带 ID 尾缀(space-entry-plan §3.6):加入的空间可能源侧从未命名,
  // 多个无名空间必须可辨识。
  return s.name ?? (s.id === MAIN_SPACE ? "默认空间" : `未命名空间 · ${s.id.slice(-4)}`);
}

/** 状态点四态(off 灰 / on 绿 / busy 琥珀 / err 朱砂)。侧栏状态点与空间菜单行共用。
 *  error 排最前:身份四不变量被停用的空间未必 configured,也必须一眼见红。 */
export function dotClass(s: SyncStatus | null): string {
  if (!s) return "off";
  if (s.error || s.frozen.length > 0 || s.skew) return "err";
  if (!s.configured) return "off";
  if (s.state === "online") return "on";
  if (s.state === "connecting" || s.state === "booting") return "busy";
  return "err"; // offline
}
