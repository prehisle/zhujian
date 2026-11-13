// 同步 UI 最小面(sync-protocol §8;P2-g)。侧栏底部一枚状态点 + 设置面板(创建
// 账户/发起配对[显示配对码]/加入账户[输配对码]/服务器地址)+ 非模态提示条。
// 创号曾接一页「恢复码强制仪式」(抄 52 位再回输核对)与一页「查看恢复码」,连同
// 压实重发码那条挂钩一起拆掉了 —— 它的设计用途早被备份码接走,见 backlog 用户面 125。未配置时只有一个安静入口,零打扰;远端 op 落地(sync-changed)
// 去抖后刷当前视图(视图 refresh 已幂等)。
// 97 多空间(sync-plan §六⑥):事件全部带空间标——状态按 space 留存(切回即见),
// 非当前空间的 changed 直接丢(切回时视图全量重查),toast 带空间名冒出来,
// 非当前空间有冻结/错误时点亮空间入口的红点(空间级提示,后台空间不许静默坏着)。
import { dotClass, invoke, invokeInSpace, currentSpaceId, MAIN_SPACE } from "./space";
import type { SyncStatus } from "./space";
import {
  openDevicesPage,
  renderDevices,
  resetDevicesPage,
  rosterDeparted,
  shortIds,
} from "./devices";
import { aliasOf, loadIdentity } from "./identity";
import { goneOf, onGoneChange, pruneGone, settleGone } from "./sync-gone";
import { listen } from "@tauri-apps/api/event";
import { generate } from "lean-qr";
import { toSvg } from "lean-qr/extras/svg";
import { TOAST_ERROR_MS } from "./timing";
import { t } from "./i18n";
import "./sync.css";
import { elText as el, btn, focusables, holdKeyboard, type KeyboardHold } from "./dom";
import { errLine, errNode, setErrSpaceLabel } from "./err";
import { copyButton } from "./clipboard";
import { noteFold } from "./backup";

// 同步服务器默认地址(官方那台)——创建账户/加入设备(本文件)+ 加入空间(notebook.ts)三处入口:从没连上过任何服务器时预填它,
// 地址框下那一行拿它判「这是不是官方服务器」(W4 Q2 / Q3)。
export const DEFAULT_SYNC_URL = "wss://sync.zhujian.app";

// ---- 服务器地址框(161 / W4 Q2 ★① / Q3 ★①,同手机 android/src/sync.ts 那一节)--------------------------------
// 加入 / 建账户的地址框预填「这台最近一次连上的服务器」(连上过才记,本机一份,localStorage 键同手机);从没连上过才填官方那台。
// 自建的人几乎所有账户都在自己那台上 —— 此前「加入空间」一律预填官方地址,填错时报的却是「配对码无效或已过期」。
// 预填是看得见、能改的,不是静默默认值;框上方标「服务器地址」,框下那一行跟着框里的值说这是不是官方服务器。
const LAST_SERVER_KEY = "zhujian.last-server";

/** 这台最近一次真连上的那台服务器(只在某个空间 online 时记);从没连上过 = 官方那台。 */
export function prefillServerUrl(): string {
  return localStorage.getItem(LAST_SERVER_KEY) ?? DEFAULT_SYNC_URL;
}

function noteLastServer(s: SyncStatus): void {
  if (s.state === "online" && s.server_url) localStorage.setItem(LAST_SERVER_KEY, s.server_url);
}

/** 地址框一组:上方标签 + 框 + 框下一行(官方 = 一般不用改;别的 = 那是另一套账户)。notebook.ts「加入空间」那张小表单也用它。
 *  `cls` = 框自己的类(同步浮层 `.sync-input`,空间菜单那张表单不带)。 */
export function serverField(value: string, cls = "sync-input"): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "sync-field");
  wrap.appendChild(el("span", "sync-label", t("sync.serverLabel")));
  const i = document.createElement("input");
  if (cls) i.className = cls;
  i.placeholder = t("sync.serverPlaceholder");
  i.value = value;
  i.spellcheck = false;
  i.inputMode = "url";
  wrap.appendChild(i);
  const hint = el("span", "sync-hint");
  const paint = () => {
    hint.textContent =
      i.value.trim() === DEFAULT_SYNC_URL
        ? t("sync.serverHintOfficial")
        : t("sync.serverHintOther", { url: DEFAULT_SYNC_URL });
  };
  i.addEventListener("input", paint);
  paint();
  wrap.appendChild(hint);
  return { wrap, input: i };
}

/** 配对码框一组:上方标签 + 框(灰字写长什么样,A27 / WD-30:此前要输错一次才知道)。 */
export function codeField(cls = "sync-input"): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "sync-field");
  wrap.appendChild(el("span", "sync-label", t("sync.codeLabel")));
  const i = document.createElement("input");
  if (cls) i.className = cls;
  i.placeholder = t("sync.pairCodePh");
  i.spellcheck = false;
  wrap.appendChild(i);
  return { wrap, input: i };
}

/** 后端 `err_code::SEAT_LIMIT` 那句人话的判别片段(core `transport.rs` 的诊断串,
 *  Rust 诊断不翻)。**匹配字面量,不是显示文案** —— 翻它会破坏判据。 */
const SEAT_LIMIT_MARK = "同步席位已满";

type Mode =
  | "home"
  | "create"
  | "join"
  | "pair"
  | "server"
  | "advanced"
  | "devices";

const STATE_WORD: Record<string, string> = {
  off: t("sync.stateOff"),
  connecting: t("sync.stateConnecting"),
  booting: t("sync.stateBooting"),
  online: t("sync.stateOnline"),
  offline: t("sync.stateOffline"),
};

// 每空间一份状态留存(§六⑥);状态点/面板只画当前空间的那份。
const statuses = new Map<string, SyncStatus>();
// 空间显示名(toast 前缀用);notebook.ts 的切换器每次拉列表后喂。
const spaceNames = new Map<string, string>();
let overlay: HTMLDivElement | null = null;
let hold: KeyboardHold | null = null;
let mode: Mode = "home";
// 一次性展示材料(关面板即弃,不留 DOM 外的副本)。
let pairCode = "";
let pairNote = "";
let pairFailed = false;
// 716:配对是**活在 core 里**的东西(槽到码过期为止,10 分钟),面板关了它也不消失。所以出码
// 那几格不再「关面板即弃」:pairSpace 记下发起它的空间,done / failed 之前关掉再开仍回到出码页。
let pairDone = false;
let pairSpace = "";
// 161 / W4 A43(WP-04 / X-03):「新设备已加入」那句写出加入的是哪台、对面一连上就收。
//  · `pairJoinedDevice` = core「设备 X 已注册」那一拍里的编号(sync-pair `registering` 的 detail);
//  · `pairPeersBase`    = 对方来到配对槽那一刻,这个空间「另有 N 台在线」的 N —— 新设备注册完、用自己的身份连上服务器,N 就涨一台。
// 配对码几点失效(Q16 / WP-25):码到手那一刻起算 10 分钟(core `PAIR_TIMEOUT_SECS` = 600,码到手才起算)。
let pairJoinedDevice: string | null = null;
let pairPeersBase: number | null = null;
let pairUntil: number | null = null;
const PAIR_TTL_MS = 600_000;
// 引导进度(用户面 121):每空间一份,只在该空间 state === "booting" 时画;状态一离开
// booting 就丢。此前 `sync-boot` 桥出来了却没人听 —— 桌面做加入方时只有一句「初始同步中…」。
const bootProgress = new Map<string, { received: number; total: number }>();
const fmtMb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

function clearPair(): void {
  pairCode = "";
  pairNote = "";
  pairFailed = false;
  pairDone = false;
  pairSpace = "";
  pairJoinedDevice = null;
  pairPeersBase = null;
  pairUntil = null;
}

/** 刚加入的那台在屏上叫什么:起过名用名,没起过用名单那一档的编号(最短唯一前缀,同设备名单 / A30)。 */
function pairJoinedName(): string {
  const id = pairJoinedDevice;
  if (!id) return t("sync.newDevice");
  const alias = aliasOf(pairSpace, id);
  if (alias) return alias;
  const ids = statuses.get(pairSpace)?.roster?.map((r) => r.device) ?? [];
  return shortIds(ids.includes(id) ? ids : [...ids, id]).get(id) ?? id;
}

/** 24 小时制「HH:MM」(配对码几点失效)。 */
function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ---- 断开 / 重连(161 / W4 Q14 ★① = A45,同手机)----------------------------------------------------
// 断开过(见过 offline)、还没再连上的空间;再连上那一刻说一声「已重新连上」。
// ⚠ 只说「已重新连上」—— SyncStatus 里没有待发条数,「断开时记的已发出」证不了,不说。
// ⚠ 断开之后状态在「离线 ↔ 连接中」之间来回(每次重拨都过一下「连接中」)⇒ 侧栏那个「离线」与浮层的「现在重连」在整段断开期间都在、
// 连接中那几拍只把钮置灰 —— 跟着状态显隐的话每隔几秒跳一下(手机真机量过)。
const offlineSeen = new Set<string>();
let reconnectBusy = false;
let reconnectErr: string | null = null;

/** 喂一份状态,交回「这一拍是不是刚从断开里连回来」。已不在账户里的那一本不算断开(那不是网络的事)。 */
function trackOffline(space: string, s: SyncStatus): boolean {
  if (!s.configured || goneOf(space) !== null) {
    offlineSeen.delete(space);
    return false;
  }
  if (s.state === "offline") {
    offlineSeen.add(space);
    return false;
  }
  if (s.state === "online") return offlineSeen.delete(space);
  return false;
}

/** 这一本此刻算不算「断开着」(离线,或断开后正在重拨)。 */
function disconnected(space: string, s: SyncStatus): boolean {
  return s.configured && goneOf(space) === null && (s.state === "offline" || (s.state === "connecting" && offlineSeen.has(space)));
}

/** 这个空间是否还有一场没收场的配对(码已到、或还在申请中)。 */
function pairAlive(): boolean {
  return pairSpace !== "" && pairSpace === currentSpaceId() && !pairFailed && !pairDone;
}

function cur(): SyncStatus | null {
  return statuses.get(currentSpaceId()) ?? null;
}

/** 当前空间服务器名册里的设备编号;`null` = 不知道(没连上 / 名册没到;⛔ 别折成空数组,identity-plan §5.16.2-7)。
 *  设置「本机别名」那行按它算编号该显几位(161 / W4 A30:与设备名单同一个最短唯一前缀)。 */
export function rosterIds(): string[] | null {
  return cur()?.roster?.map((r) => r.device) ?? null;
}

/** 某个空间此刻的同步状态;`null` = 还没拿到(启动基线之前)。混版提醒判「已配同步」用(doc-skew-ask.ts,878)。 */
export function syncStatusOf(space: string): SyncStatus | null {
  return statuses.get(space) ?? null;
}

/** 当前空间已配置的服务器;没配 / 还没拿到状态 = `null`(设置「关于」网络自检那格用,用户面 137)。 */
export function configuredServer(): string | null {
  return cur()?.server_url ?? null;
}

export function setSpaceNames(names: Map<string, string>): void {
  spaceNames.clear();
  for (const [k, v] of names) spaceNames.set(k, v);
  // 161 / W4 A41:「这个账户已被空间「X」使用」里的 X 是壳给的原话(起过的名 / 主空间没起名时的「默认空间」/ 空间 id),
  // 换成这台屏上的叫法(err.ts err.accountInUse)。认不出的原样。
  setErrSpaceLabel((raw) => spaceNames.get(raw) ?? (/^默认空间$/.test(raw) ? (spaceNames.get(MAIN_SPACE) ?? raw) : raw));
}

/** 用 list_spaces 快照给留存 Map 建基线(启动/刷列表时)。启动即被 veto 的空间没有
 *  事件桥,红点全靠这份基线。只补缺不覆盖:实时事件(listener 先于本快照注册)比
 *  快照新,旧快照不许倒灌。这是状态进 Map 的唯一快照口——单独 invoke sync_status
 *  再 set 会把请求前克隆的旧态盖到其后到达的事件上。 */
export function seedSpaceStatuses(list: { id: string; status: SyncStatus }[]): void {
  for (const s of list) {
    if (!statuses.has(s.id)) statuses.set(s.id, s.status);
  }
  // Q12:已经没了的空间从「已不在账户里」那本账上划掉;其余按手上这份对一遍账(开机第一次被拒之前就认得出)。
  pruneGone(list.map((s) => s.id));
  for (const [id, st] of statuses) {
    settleGone(id, st);
    noteLastServer(st);
  }
  renderDot();
}

function nameOf(space: string): string {
  return spaceNames.get(space) ?? t("sync.otherSpace");
}

/** notebook.ts 切完空间后调:状态点/面板改画新空间。留存 Map 由事件流 + 基线维护
 *  (有 transport 的空间每次变更都推事件;veto/dead 空间状态固化、基线值恒真),
 *  这里不再单独拉快照——请求前克隆的旧态会倒灌覆盖其后到达的事件。 */
export function syncSpaceSwitched(): void {
  renderDot();
  if (!overlay) return;
  if (mode === "home" || mode === "advanced") renderPanel();
}

/** 单空间时的空间入口兜底(411/D2):侧栏徽章藏起来了,菜单由 notebook.ts 注入这里打开。 */
let openSpaces: (() => void) | null = null;

/** 挂同步 UI。resolve = 五个事件监听都已注册完(调用方此后再拉状态基线,不漏事件)。 */
export async function initSync(opts: {
  refresh: () => void;
  openSpaces: () => void;
}): Promise<void> {
  const entry = document.getElementById("sync-entry");
  if (!entry) throw new Error("侧栏缺 #sync-entry(notebook.html 漂移?)");
  entry.addEventListener("click", () => openPanel());
  openSpaces = opts.openSpaces;
  // Q12:「已不在账户里」那一档变了(自己退出的回执 / 被拒 / 重置)⇒ 侧栏那个字与浮层跟着换;设备名单那一页要一条被服务器认的
  // 会话才有意义,已不在账户里就回首页(首页写明是哪一种)。
  onGoneChange(() => {
    renderDot();
    if (!overlay) return;
    if (mode === "devices" && goneOf(currentSpaceId()) !== null) mode = "home";
    if (mode === "home" || mode === "advanced") renderPanel();
  });

  let timer: number | undefined;
  await Promise.all([
    listen<{ space: string; status: SyncStatus }>("sync-status", (e) => {
      statuses.set(e.payload.space, e.payload.status);
      if (e.payload.status.state !== "booting") bootProgress.delete(e.payload.space);
      // Q12 / Q3 / Q14:每个空间都对账(桌面每个空间都常驻传输任务,后台那几本的状态也是活的)。
      settleGone(e.payload.space, e.payload.status);
      noteLastServer(e.payload.status);
      const reconnected = trackOffline(e.payload.space, e.payload.status);
      if (e.payload.status.state === "online") reconnectErr = null;
      renderAlert();
      // 名册变短 → 给**其它在线设备**一条提示(§5.8 末:「移除很安静」这个真问题的解法
      // 是**用透明代替权限**)。会话内差分、零持久状态、零协议增量;放在空间过滤**之前**
      // ——后台空间被人踢掉一台同样该说一声,照既有约定带空间名冒出来。
      for (const name of rosterDeparted(e.payload.space, e.payload.status)) {
        const msg = t("devices.departedToast", { name });
        showToast(
          e.payload.space === currentSpaceId()
            ? msg
            : t("sync.toastFromSpace", { space: nameOf(e.payload.space), msg }),
        );
      }
      if (e.payload.space !== currentSpaceId()) return; // 留存即可,不动当前画面
      if (reconnected) showToast(t("sync.reconnected"));
      pairPeerArrived(e.payload.status);
      renderDot();
      // 面板开着且在状态页/高级页/设备页(均只读画状态):跟着最新快照走(配对/仪式等
      // 一次性页面不被打断)。改服务器保存回高级页,事件晚到也不至于显旧地址。
      if (overlay && (mode === "home" || mode === "advanced" || mode === "devices")) {
        if (mode === "devices" && goneOf(e.payload.space) !== null) mode = "home";
        renderPanel();
      }
    }),
    listen<{ space: string }>("sync-changed", (e) => {
      // 非当前空间的落地直接丢:切回去时视图整个重挂、全量重查(§六⑥)。
      if (e.payload.space !== currentSpaceId()) return;
      // 追赶期一秒可来多帧:尾沿去抖,合并成一次视图刷新(refresh 幂等)。
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        opts.refresh();
        // 161 / W4 A14(WP-12):另一台改了别名,随记卡上的来源十几秒就换了,开着的设备名单却还是编号 —— 名单的名字来自
        // 身份面快照(identity.ts),它只在开页时取一次、此后没人叫这一页重画。⇒ 远端落地时设备页开着就重取一次再重画
        // (别名本来就是经同步来的 op,落地即这一拍;⛔ 名单取数那条路不动,谁在册仍只听服务器)。
        if (overlay && mode === "devices") {
          const space = currentSpaceId();
          void loadIdentity(space)
            .then(() => {
              if (overlay && mode === "devices" && currentSpaceId() === space) renderPanel();
            })
            .catch(() => {}); // 别名翻不动只是少个人话名,短 id 照样能唯一定位(同 openDevicesPage)
        }
      }, 300);
    }),
    listen<{ space: string; msg: string }>("sync-toast", (e) => {
      // 别的空间的提示(引导完成/图N翻案/冻结)不丢——带空间名冒出来。
      const { space, msg } = e.payload;
      showToast(space === currentSpaceId() ? msg : t("sync.toastFromSpace", { space: nameOf(space), msg }));
    }),
    listen<{ space: string; phase: string; detail: string }>("sync-pair", (e) => {
      // 配对进度只属于发起它的空间。716 起面板关着也记账:出码页可以关掉再开(码留在模块态),
      // 所以 done / failed 来时不管面板开没开、人此刻在哪个空间,都要落到这份状态上。
      if (e.payload.space !== pairSpace) return;
      const { phase, detail } = e.payload;
      // A43:对方来到配对槽那一刻记下「另有 N 台在线」的 N(它注册完、用自己的身份连上来,N 就涨一台);
      // 「设备 X 已注册」那一拍摘出编号(core ctx_impl 的诊断串;摘不到就叫「新设备」)。
      if (pairPeersBase === null && (phase === "joined" || phase === "registering" || phase === "done")) {
        pairPeersBase = statuses.get(pairSpace)?.peers_online ?? 0;
      }
      if (phase === "registering") pairJoinedDevice = /设备 (\S+) 已注册/.exec(detail)?.[1] ?? null;
      pairNote = detail;
      if (phase === "failed") pairFailed = true;
      if (phase === "done") pairDone = true;
      if (!overlay) {
        if (pairFailed || pairDone) clearPair(); // 已收场的配对没什么可留给下次开面板看的
        return;
      }
      // done 不再自动关面板(用户面 121):done = 对方注册完成 ≠ 对方引导完成,它此刻正从
      // 这台拉初始快照 —— 页面留着,把「这台别关」说出来,人看着对方显示已连接再关。
      if (mode === "pair") renderPanel();
    }),
    listen<{ space: string; received: number; total: number }>("sync-boot", (e) => {
      const { space, received, total } = e.payload;
      bootProgress.set(space, { received, total });
      if (space !== currentSpaceId()) return;
      // 块帧密(每 256 KiB 一枚),只重画进度那一块,不整面板重建。
      if (overlay && mode === "home") paintBoot();
    }),
  ]);
  // 状态基线不在这里拉:监听就绪后由 notebook.ts 的 refreshSpaceEntry →
  // seedSpaceStatuses 全量补缺(单独 invoke sync_status 有旧态倒灌竞态)。
}

// ---- 状态点 ----

function renderDot(): void {
  const dot = document.getElementById("sync-dot");
  const entry = document.getElementById("sync-entry");
  const side = document.getElementById("sync-word");
  if (!dot || !entry) return;
  if (!side) throw new Error("侧栏缺 #sync-word(notebook.html 漂移?)");
  const status = cur();
  const gone = goneOf(currentSpaceId());
  dot.className = `sync-dot ${dotClass(status)}`;
  const word = gone === "left" ? t("sync.goneLeft") : gone === "revoked" ? t("sync.goneRevoked") : status ? (STATE_WORD[status.state] ?? status.state) : "";
  entry.title = status?.configured ? t("sync.entryTitle", { state: word }) : t("sync.entryTitleOff");
  // Q14 ★①(WP-09):「同步」后面直接写出来,不用悬停 —— 此前只有一颗 7px 的点变色,字要悬停才见,色弱的人分不出。
  // 只在断开着(整段断开期间都在,见 `disconnected`)与已不在账户里时写;连着 / 连接中 / 没开同步都不写(零打扰)。
  const sideText = gone !== null ? t("main.tagUnsynced") : status && disconnected(currentSpaceId(), status) ? t("sync.sideOffline") : "";
  side.textContent = sideText;
  side.hidden = sideText === "";
  renderAlert();
}

/** A43:配对成功之后,新设备用自己的身份连上来了(「另有 N 台在线」比它来到配对槽时多了)⇒ 出码页收起回首页,说一声它已连上、
 *  还在取内容(这一页此前一直挂着不收,两分多钟一字没变)。 */
function pairPeerArrived(s: SyncStatus): void {
  if (!pairDone || pairSpace !== currentSpaceId() || pairPeersBase === null) return;
  if (s.peers_online <= pairPeersBase) return;
  const name = pairJoinedName();
  clearPair();
  if (overlay && mode === "pair") goto("home");
  showToast(t("sync.pairDoneOnline", { name }));
}

/** 非当前空间有冻结/错误 → 空间入口右上一粒朱砂点(§六⑥ 的「空间级提示」)。 */
function renderAlert(): void {
  const entry = document.getElementById("space-entry");
  if (!entry) return;
  let alert = false;
  for (const [space, s] of statuses) {
    if (space === currentSpaceId()) continue;
    if (s.error || s.frozen.length > 0) alert = true;
  }
  entry.classList.toggle("alert", alert);
}

// ---- 面板骨架 ----

function openPanel(): void {
  if (overlay) return;
  // 716:这个空间还有一场活着的配对就直接回到出码页(码还在、还有效)。
  mode = pairAlive() ? "pair" : "home";
  overlay = document.createElement("div");
  overlay.className = "sync-overlay";
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePanel();
  });
  const panel = document.createElement("div");
  panel.className = "sync-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", t("sync.panelTitle"));
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onPanelKey);
  // 接管键盘(W4 A3,同设置浮层;dom.ts `holdKeyboard`):焦点进面板、Tab 圈在面板里、背后按不到,
  // 关掉后焦点回侧栏「同步」那枚钮。⚠ 先接管、后画:它在接管那一刻记下「打开它的那枚」(此刻
  // 焦点还在侧栏钮上);面板这时还是空的,焦点由下面那次 renderPanel("first") 放进去。
  hold = holdKeyboard(overlay, panel, { onEscape: () => escapeOneLevel() });
  renderPanel("first");
}

/** 打开同步浮层(侧栏「同步」那一下;随记页顶「已不在这个账户里」那条也点进这里,161 / W4 Q12)。 */
export function openSyncPanel(): void {
  openPanel();
}

/** 同步浮层开着就收掉(设置浮层从错误条「网络自检」打开时调:一次只开一层,W4 A9)。 */
export function closeSyncPanel(): void {
  if (overlay) closePanel();
}

function closePanel(): void {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onPanelKey);
  hold?.release();
  hold = null;
  // 716:配对还活着(申请中 / 码已到、未 done / failed)就留住 —— 槽在 core 里活到码过期,
  // 此前关面板即清码,再点「添加设备」只得到「已有配对在进行中」,用户对着一句红字干等十分钟。
  if (pairSpace === "" || pairFailed || pairDone) clearPair();
  reconnectErr = null; // 「现在重连」的回话只属于这一次开着的浮层
  resetDevicesPage();
}

/** 每一页按 Esc 退到哪(902 E6):与那一页自己的「返回」钮同一个去处;没有「返回」的两页(首页、出码页 —— 出码页自己
 *  那枚钮就叫「关闭」,配对活着时重开面板也直接回到它)= 关面板。⛔ 新增一页必须在这里登记(Record 穷尽,漏了编译不过)。 */
const ESC_BACK: Record<Mode, Mode | null> = {
  home: null,
  pair: null,
  create: "home",
  join: "home",
  advanced: "home",
  devices: "home",
  server: "advanced",
};

/** Esc 只退一层(902 E6):在二级页上先回上一层,到了首页再按才关。此前不管在哪一页都整个关掉。 */
function escapeOneLevel(): void {
  const back = ESC_BACK[mode];
  if (back === null) closePanel();
  else goto(back);
}

function onPanelKey(e: KeyboardEvent): void {
  // 错误后面那枚「网络自检」(err.ts)会把设置面板叠在本面板上面:两只 Esc 监听都挂在
  // document 上、谁也拦不住谁,不让一步 ⇒ 一次 Esc 两层全关。上面那层先走。
  if (document.querySelector(".settings-overlay")) return;
  if (e.key === "Escape") {
    e.stopPropagation();
    escapeOneLevel();
  }
}

function input(placeholder: string, value = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.className = "sync-input";
  i.placeholder = placeholder;
  i.value = value;
  i.spellcheck = false;
  return i;
}

/**
 * 整面板重画。`refocus`(W4 A3):这只面板每来一枚状态事件就整个重画(home / 高级 / 设备三页),
 * 聚焦的那枚钮随之被换掉、焦点掉到 body ⇒ 键盘用户按着按着就「丢了」。
 *   `first` = 换页(goto)/ 刚打开:焦点落到这一页第一个控件(✕ 除外,它在标题行、谁都看得见);
 *   `keep`  = 同一页因状态事件重画:焦点原来在面板里的,落回同一枚(按可见文字认,认不出按序号)。
 */
function renderPanel(refocus: "first" | "keep" = "keep"): void {
  if (!overlay) return;
  const panel = overlay.querySelector<HTMLElement>(".sync-panel");
  if (!panel) return;
  const before = focusables(panel);
  const at = document.activeElement as HTMLElement | null;
  const wasIn = at !== null && panel.contains(at);
  const atIndex = wasIn ? before.indexOf(at) : -1;
  const atText = wasIn ? (at.textContent ?? "") : "";
  panel.replaceChildren();
  // 标题行 + ✕(W4 A24,WD-26:此前只能点外面 / 按 Esc,得猜)。形照设置浮层那枚(`.settings-close`)。
  const head = el("div", "sync-head");
  const close = el("button", "sync-close", "✕");
  close.title = t("settings.closeTitle");
  close.setAttribute("aria-label", t("settings.closeTitle"));
  close.addEventListener("click", () => closePanel());
  head.append(el("h2", "sync-title", t("sync.panelTitle")), close);
  panel.appendChild(head);
  const body = el("div", "sync-body");
  panel.appendChild(body);
  switch (mode) {
    case "home":
      renderHome(body);
      break;
    case "create":
      renderCreate(body);
      break;
    case "join":
      renderJoin(body);
      break;
    case "pair":
      renderPair(body);
      break;
    case "server":
      renderServer(body);
      break;
    case "advanced":
      renderAdvanced(body);
      break;
    case "devices":
      renderDevices(body, devicesDeps());
      break;
  }
  // 子块点名要焦点的那一枚(设备名单里刚展开的确认块的【取消】,W5 Q3)先于「落回原处」。只认一次。
  const auto = body.querySelector<HTMLElement>("[data-autofocus]");
  if (auto) {
    auto.removeAttribute("data-autofocus");
    auto.focus();
  } else if (refocus === "first") {
    (focusables(body)[0] ?? close).focus();
  } else if (wasIn) {
    const after = focusables(panel);
    const same = after.find((n) => n.tagName === at.tagName && (n.textContent ?? "") === atText);
    (same ?? after[Math.min(atIndex, after.length - 1)] ?? close).focus();
  }
}

function goto(m: Mode): void {
  mode = m;
  renderPanel("first");
}

/** 设备页的接线(identity-plan §5.8)。`status` 每次现取——名册的唯一出处是状态面,
 *  别在这边留第二份副本(core 那侧保证「回执到手时状态面已含本轮」)。 */
function devicesDeps() {
  return {
    status: cur(),
    space: currentSpaceId(),
    rerender: () => renderPanel(),
    back: () => goto("home"),
    toast: (m: string) => showToast(m),
  };
}

/** 进设备页:先把页面态清干净、拉一枚权威名册(§5.4 那张表的第二行),再画。 */
function gotoDevices(): void {
  mode = "devices";
  openDevicesPage(devicesDeps());
  renderPanel("first");
}

// ---- 各页 ----

function renderHome(body: HTMLElement): void {
  const s = cur();
  if (!s || !s.configured) {
    // 未配置却带 error = 身份被停用(整库复制的同 device 等):先说明,别只给创号入口。
    if (s?.error) body.appendChild(errLine("sync-err", s.error));
    body.appendChild(
      el("p", "sync-note", t("sync.homeIntro")),
    );
    // 902 F6 ①:这一屏只有一枚主钮「创建账户」;「用配对码加入」降成它下面一行淡字链接(此前两枚并排同形,
    // 第一次来的人看不出该点哪枚)。
    const acts = el("div", "sync-actions");
    acts.appendChild(btn(t("sync.createAccount"), "hbtn primary", () => goto("create")));
    // 「用配对码加入」只在 main(装机 onboarding,本机数据保留并合并;space-entry-
    // plan §4):非 main 空间同步唯一路 = 创号;「把别处的账户带过来」在空间菜单的
    // 「加入空间」——那是独立入口,不背到这里。
    const main = currentSpaceId() === MAIN_SPACE;
    if (!main) {
      body.appendChild(
        el("p", "sync-dim", t("sync.nonMainHint")),
      );
    }
    body.appendChild(acts);
    if (main) body.appendChild(btn(t("sync.joinLink"), "sync-link sync-join-link", () => goto("join")));
    body.appendChild(spacesEntryRow()); // 不管几个空间都在(W4 Q6 ★①),见该函数
    return;
  }
  const gone = goneOf(currentSpaceId());
  if (gone !== null) {
    renderGone(body, s, gone);
    return;
  }
  const word = STATE_WORD[s.state] ?? s.state;
  const line = el("div", "sync-stateline");
  line.appendChild(el("span", `sync-dot ${dotClass(s)}`));
  line.appendChild(el("b", "", word));
  if (s.state === "online") {
    line.appendChild(el("span", "sync-dim", t("sync.peersOnline", { n: s.peers_online })));
  }
  body.appendChild(line);
  if (s.state === "booting") body.appendChild(bootBlock());
  if (s.skew) {
    body.appendChild(el("div", "sync-warn", t("sync.skewWarn")));
  }
  if (s.clock_skew) {
    body.appendChild(
      el("div", "sync-warn", t("sync.clockSkewWarn")),
    );
  }
  if (s.frozen.length > 0) {
    body.appendChild(
      el("div", "sync-warn", t("sync.frozenWarn")),
    );
  }
  if (s.error) {
    body.appendChild(errLine("sync-err", s.error));
  }
  if (disconnected(currentSpaceId(), s)) body.appendChild(reconnectRow(s));
  const acts = el("div", "sync-actions");
  acts.appendChild(btn(t("sync.addDevice"), "hbtn", () => startPair()));
  // 设备名单(identity-plan §5.8):「另有 N 台设备在线」那句话背后的真名单,连同
  // 移除设备与管理设备名单都在里头。入口恒显——权限差别在**行上**表达,不藏入口
  // (藏了就没人知道自己能不能退出账户)。
  acts.appendChild(btn(t("devices.entry"), "hbtn", () => gotoDevices()));
  body.appendChild(acts);
  body.appendChild(spacesEntryRow()); // 不管几个空间都在(W4 Q6 ★①),见该函数
  // 修改服务器收进「高级」:运维动作不与日常操作同屏(概念收敛)。
  body.appendChild(advancedEntryRow());
}

/** Q14 ★①(A45):断开时给一枚「现在重连」—— 把本来就会做的那次重连提前一次(壳里 `sync_reconnect_now`,只在离线时才发;
 *  在线时发会断掉现在的会话,那一道判在 Rust 那边,同一把状态锁里)。整段断开期间都在,「连接中」那几拍置灰(别跳版)。
 *  此前服务器回来后要干等二十几秒(断得越久等得越久,退避上限约 60 秒)。 */
function reconnectRow(s: SyncStatus): HTMLElement {
  const box = el("div", "sync-reconnect");
  const row = el("div", "sync-reconnect-row");
  const b = btn(t("sync.reconnectNow"), "hbtn", () => {
    reconnectBusy = true;
    reconnectErr = null;
    renderPanel();
    // invokeInSpace(回话恒到达):统一包装对切走了空间的迟到回话「永不决议」,busy 就永远放不开(118 那条教训)。
    void invokeInSpace<boolean>(currentSpaceId(), "sync_reconnect_now")
      .catch((e: unknown) => {
        reconnectErr = String(e);
      })
      .finally(() => {
        reconnectBusy = false;
        renderPanel();
      });
  });
  b.disabled = reconnectBusy || s.state !== "offline";
  row.appendChild(b);
  box.appendChild(row);
  if (reconnectErr) box.appendChild(errLine("sync-err", reconnectErr));
  return box;
}

/** Q12 ★①(A37 / A39 / A40 的桌面对应):这台已不在这个账户里 —— 明说是哪一种(自己退出 / 被拒,分不出移除还是停用就两样一起写),
 *  ⛔ 不写「重连中」、不挂「连不上」那句原话(那是网络话);同一处写清两件事:这台上的内容都还在、之后记的只留在这台;想重新加入
 *  先复制、再重置、再输码。收起「添加设备」与「设备名单」(那两样要一条被服务器认的会话;此前点了说「未连接服务器(重连中)」、
 *  名单说「尚未确认服务器支持」,都把原因说成网络)。⛔ 后台照旧重试(封禁解了还能自己回来,回来那一刻这一档自己收)。 */
function renderGone(body: HTMLElement, s: SyncStatus, gone: "left" | "revoked"): void {
  const line = el("div", "sync-stateline");
  line.appendChild(el("span", `sync-dot ${dotClass(s)}`));
  line.appendChild(el("b", "", gone === "left" ? t("sync.goneLeft") : t("sync.goneRevoked")));
  body.appendChild(line);
  body.appendChild(el("p", "sync-note", t("sync.goneKeep")));
  body.appendChild(el("p", "sync-note", t("sync.goneRejoinDesk")));
  body.appendChild(spacesEntryRow());
  body.appendChild(advancedEntryRow());
}

/** 「添加设备」与失败页的「重新出码」共用这一条(用户面 121):向 core 要一枚配对码、进出码页。 */
function startPair(): void {
  // 716:活着的那场直接再显,不重新开槽(core 会拒「已有配对在进行中」)。
  if (pairAlive()) {
    goto("pair");
    return;
  }
  clearPair();
  pairSpace = currentSpaceId();
  pairNote = t("sync.pairRequesting");
  goto("pair");
  void invoke<string>("sync_pair_start")
    .then((code) => {
      pairCode = code;
      pairUntil = Date.now() + PAIR_TTL_MS;
      pairNote = t("sync.pairInstructions", { until: hhmm(pairUntil) });
      if (mode === "pair") renderPanel();
    })
    .catch((e: unknown) => {
      pairFailed = true;
      pairNote = String(e);
      if (mode === "pair") renderPanel();
    });
}

/** 引导进度那一块(用户面 121;与安卓 `#sync-boot` 同形):细条 + 一行字 + 一句原因。
 *  还没收到任何进度事件时说「正在等另一台设备发来初始快照」;引导为什么停着(今天只有
 *  「没有在线设备」一句)由 core 写在 `status.boot_hint` —— 它独占一格,与 `error` 里要人
 *  动手的真错误互不遮盖,两者可以同时在屏上。 */
function bootBlock(): HTMLElement {
  const box = el("div", "sync-boot");
  const bar = el("div", "sync-boot-bar");
  bar.appendChild(el("i", "sync-boot-fill"));
  box.appendChild(bar);
  box.appendChild(el("div", "sync-dim sync-boot-text"));
  box.appendChild(el("div", "sync-warn sync-boot-hint"));
  paintBoot(box);
  return box;
}

function paintBoot(box: HTMLElement | null = overlay?.querySelector<HTMLElement>(".sync-boot") ?? null): void {
  if (!box) return;
  const fill = box.querySelector<HTMLElement>(".sync-boot-fill");
  const text = box.querySelector<HTMLElement>(".sync-boot-text");
  const hint = box.querySelector<HTMLElement>(".sync-boot-hint");
  if (!fill || !text || !hint) throw new Error("引导进度块缺子元素(bootBlock 漂移?)");
  hint.textContent = cur()?.boot_hint ?? "";
  const p = bootProgress.get(currentSpaceId());
  if (!p) {
    fill.style.width = "0%";
    text.textContent = t("sync.bootWaiting");
    return;
  }
  const pct = p.total > 0 ? Math.floor((p.received / p.total) * 100) : 0;
  fill.style.width = `${pct}%`;
  text.textContent =
    p.received >= p.total
      ? t("sync.snapshotDone", { total: fmtMb(p.total) })
      : t("sync.snapshotProgress", { received: fmtMb(p.received), total: fmtMb(p.total), pct });
}

/** 空间入口那一行(411/D2,与安卓 116 同源):单空间时侧栏徽章整个藏起,而新建 /
 *  加入空间的入口就在那枚徽章的菜单里 —— 这行把它接回来。
 *  ⭐ W4 Q6 ★①(WD-17 / WP-17 / X-14,用户拍板)**推翻了 411/D2 那条「两者互斥」**:此前多空间时这行随之
 *  收起,入口从同步浮层挪到左上角,人按指南「同步页里那个也在」去找就是空的。⇒ 不管几个空间都留着
 *  (设置「通用」里也有一行「空间…」,同手机)。菜单挂在哪由 notebook.ts 的 openSpaces 定。 */
function spacesEntryRow(): HTMLElement {
  const row = el("div", "sync-update-row");
  row.appendChild(
    btn(t("shell.spacesEntry"), "hbtn", () => {
      if (!openSpaces) throw new Error("同步面板没接空间入口(initSync 漏传 openSpaces?)");
      closePanel(); // 空间菜单是轻浮层,不与模态面板同屏
      openSpaces();
    }),
  );
  return row;
}

/** 「高级」低调入口:服务器信息与运维动作的收纳处。 */
function advancedEntryRow(): HTMLElement {
  const row = el("div", "sync-update-row");
  row.appendChild(btn(t("sync.advanced"), "hbtn", () => goto("advanced")));
  return row;
}

function renderAdvanced(body: HTMLElement): void {
  const s = cur();
  if (s?.configured) {
    // 账户号(盈利准备 C4):客服对号 / 人工开通都要用户报出这一串 —— 看得见、抄得走。
    const account = s.account_id ?? "";
    body.appendChild(el("div", "sync-kv", t("sync.accountKv", { id: account })));
    const accActs = el("div", "sync-actions");
    accActs.appendChild(copyButton(account, "hbtn", t("sync.copyAccount")));
    body.appendChild(accActs);
    // 服务器地址的唯一常显出处(首屏已收走)。
    body.appendChild(el("div", "sync-kv", t("sync.serverKv", { url: s.server_url ?? "" })));
    const acts = el("div", "sync-actions");
    acts.appendChild(btn(t("sync.changeServer"), "hbtn", () => goto("server")));
    body.appendChild(acts);
  }
  const acts = el("div", "sync-actions");
  acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("home")));
  body.appendChild(acts);
}

function formErr(body: HTMLElement): HTMLElement {
  const e = el("div", "sync-err sync-form-err");
  body.appendChild(e);
  return e;
}

/** 创号 / 加入两张表单共用的提交形(161 / W4 A8 / A19,WD-10 / WD-19):
 *  - 等的那两秒在钮后面写「正在连接…」(此前上一条红字先没了、钮无声变灰,不说在干什么);
 *  - 上一条红字**留着**直到这一次有了结果(此前一点就抹掉,出结果再冒出来 —— 钮跟着上下跳);
 *  - 红字落在钮那一行**下面**(`formErr` 排在 acts 之后),每报一次错钮都不挪位。 */
function submitRow(
  body: HTMLElement,
  label: string,
  run: () => Promise<unknown>,
  url: () => string,
  done: () => void,
  goCls = "hbtn",
): void {
  const acts = el("div", "sync-actions");
  const busy = el("span", "sync-busy");
  const err = el("div", "sync-err sync-form-err");
  const go = btn(label, goCls, () => {
    if (go.disabled) return;
    go.disabled = true;
    busy.textContent = t("sync.connecting");
    void run()
      .then(() => done())
      .catch((e: unknown) => {
        go.disabled = false;
        busy.textContent = "";
        err.replaceChildren(errNode(e, url()));
      });
  });
  acts.appendChild(go);
  acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("home")));
  acts.appendChild(busy);
  body.appendChild(acts);
  body.appendChild(err);
}

function renderCreate(body: HTMLElement): void {
  // 902 F6 ②(用户拍板;此前 W4 Q2 ★① 是三段说明全摊开 + 地址框常显,一屏字压着一枚钮):
  //  · 「这是在做什么」与「钥匙丢了回不来」两句**常显**;
  //  · 「同步是可选的…」那段在上一屏刚读过(同一个键),这里收进「说明」折叠 —— ⛔ 收纳不是删;
  //  · 服务器地址收成一行「服务器:官方(sync.zhujian.app)」+「更改…」,点了才摊开原来那组(标签 + 框 + 框下提示);
  //    预填的不是官方地址(这台上次连的是自建那台)⇒ 一来就摊开,别把「这不是官方服务器」藏在一枚链接后面。
  body.appendChild(el("p", "sync-note", t("sync.createIntro")));
  body.appendChild(el("p", "sync-note", t("sync.createLoseNote")));
  body.appendChild(noteFold(t("sync.homeIntro")));
  // Q2 / Q3:地址框有标签、框下一行说是不是官方服务器;预填这台最近一次连上的那台。
  const server = serverField(prefillServerUrl());
  if (server.input.value.trim() === DEFAULT_SYNC_URL) {
    const line = el("div", "sync-server-line");
    line.appendChild(el("span", "", t("sync.serverOfficialLine", { host: new URL(DEFAULT_SYNC_URL).host })));
    line.appendChild(
      btn(t("sync.serverChange"), "sync-link sync-server-change", () => {
        line.replaceWith(server.wrap);
        server.input.focus();
        server.input.select();
      }),
    );
    body.appendChild(line);
  } else {
    body.appendChild(server.wrap);
  }
  submitRow(
    body,
    t("sync.createGo"),
    () => invoke<void>("sync_create_account", { serverUrl: server.input.value.trim() }),
    () => server.input.value.trim(),
    () => {
      // 一步到位回状态页:下一步是「添加设备」,就在那一页上;状态行随 sync-status
      // 事件从「未启用」翻到「连接中 / 已连接」(事件到了 home 页会自己重画)。
      showToast(t("sync.accountCreated"));
      goto("home");
    },
    "hbtn primary", // 「创建」是这一屏的主钮,「返回」照旧淡
  );
}

function renderJoin(body: HTMLElement): void {
  body.appendChild(el("p", "sync-note", t("sync.joinIntro")));
  const server = serverField(prefillServerUrl());
  const code = codeField();
  body.appendChild(server.wrap);
  body.appendChild(code.wrap);
  submitRow(
    body,
    t("sync.joinGo"),
    () => invoke("sync_pair_join", { serverUrl: server.input.value.trim(), code: code.input.value.trim() }),
    () => server.input.value.trim(),
    () => {
      // 回状态页而不是关面板(用户面 121):加入成功 = 引导刚开始,进度条与「没有设备在线」
      // 那句原因都画在状态页上,关了面板就什么也看不见。
      showToast(t("sync.joinedToast"));
      goto("home");
    },
  );
}

function renderPair(body: HTMLElement): void {
  // 码与二维码只在它还有效时显(用户面 121):done = 码已用掉、failed = 码已作废,
  // 再挂在页上就是引人去扫一枚死码。
  if (pairCode && !pairDone && !pairFailed) {
    // 手输路要抄两项(服务器地址+码),都在本页给全——首屏已不再常显服务器。
    const srv = cur()?.server_url;
    if (srv) body.appendChild(el("div", "sync-kv", t("sync.serverKv", { url: srv })));
    body.appendChild(el("div", "sync-code", pairCode));
    // 107 扫码配对:同一串码的二维码形态,载荷再带上服务器地址(手机扫到即自动加入,
    // 一个字不用输)。安全面不变:码本来就是 10 分钟一次性,能看到这块屏幕就能抄码。
    const server = cur()?.server_url;
    if (server) {
      const wrap = el("div", "sync-qr");
      wrap.appendChild(
        toSvg(generate(JSON.stringify({ zhujian: "pair", v: 1, server, code: pairCode })), document, {
          on: "#000000",
          off: "#ffffff",
          pad: 2,
        }),
      );
      body.appendChild(wrap);
    }
  }
  if (pairDone) {
    // 对方注册完成、正在取初始快照:说清「这台别关」,以及对面上真会出现的那两句(161 / W4 A43:此前叫人等对面那个
    // 「初始同步中…」—— 经同步页加入时只闪约 0.2 秒,经空间页加入时根本不出现)。写出加入的是哪台。
    // ⛔ 别拿「已连接」当「取完了」的信号(用户面 138);本机收不到「对方引导完了」这一拍,协议里没有 ——
    // 能看见的只有「它用自己的身份连上来了」(`pairPeerArrived`),那一拍这一页收起、换成一条提示。
    body.appendChild(el("p", "sync-note", t("sync.pairDoneNote", { name: pairJoinedName() })));
  } else {
    body.appendChild(pairFailed ? errLine("sync-err", pairNote, "p") : el("p", "sync-note", pairNote));
    // 码在手上的这一页就把「保持在线」说出来 —— 手机做老设备时早有这句,桌面一直没有。
    if (pairCode && !pairFailed) body.appendChild(el("p", "sync-note", t("sync.pairKeepOn")));
  }
  const acts = el("div", "sync-actions");
  // 失败页给一枚「重新出码」(用户面 121):此前只能关面板再点一次「添加设备」。
  if (pairFailed) acts.appendChild(btn(t("sync.pairAgain"), "hbtn", () => startPair()));
  // 「席位已满:请先移除一台不用的设备」——那句话得点得进能移除设备的地方(§5.8 末)。
  // 判据是后端诊断串的一个片段(Rust 诊断不翻,i18n 边界);它是**匹配字面量不是文案**,
  // 已逐值登记在 scripts/check-i18n-drift.mjs,与 update.ts 剥版本噪音那两条同族。
  if (pairFailed && pairNote.includes(SEAT_LIMIT_MARK)) {
    acts.appendChild(btn(t("devices.entry"), "hbtn", () => gotoDevices()));
  }
  acts.appendChild(btn(t("sync.close"), "hbtn", () => closePanel()));
  body.appendChild(acts);
}

function renderServer(body: HTMLElement): void {
  body.appendChild(el("p", "sync-note", t("sync.serverIntro")));
  // W4 Q11 / WD-25:指南那条警告搬到改地址的这一屏(此前只在指南里):它不是「换到别的服务器」用的。
  body.appendChild(el("p", "sync-warn", t("sync.serverWarn")));
  const server = input(t("sync.serverPlaceholder"), cur()?.server_url ?? "");
  body.appendChild(server);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn(t("sync.save"), "hbtn", () => {
      err.textContent = "";
      void invoke("sync_set_server", { serverUrl: server.value.trim() })
        .then(() => goto("advanced"))
        .catch((e: unknown) => {
          err.replaceChildren(errNode(e, server.value.trim()));
        });
    }),
  );
  acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("advanced")));
  body.appendChild(acts);
}

// ---- 提示条 ----

let toastTimer: number | undefined;

export function showToast(msg: string): void {
  let t = document.getElementById("sync-toast");
  if (!t) {
    t = el("div", "");
    t.id = "sync-toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  window.clearTimeout(toastTimer);
  // 同步面板这条是**第三条**回执通道(228 定的两条通用通道之外),合并是另一笔;
  // 340 先让它的时长不再是个孤立字面量 —— 它承载的就是后端原话,同 TOAST_ERROR。
  toastTimer = window.setTimeout(() => t.classList.remove("show"), TOAST_ERROR_MS);
}
