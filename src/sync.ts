// 同步 UI 最小面(sync-protocol §8;P2-g)。侧栏底部一枚状态点 + 设置面板(创建
// 账户[恢复码强制仪式]/发起配对[显示配对码]/加入账户[输配对码]/服务器地址)+
// 非模态提示条。未配置时只有一个安静入口,零打扰;远端 op 落地(sync-changed)
// 去抖后刷当前视图(视图 refresh 已幂等)。
// 97 多空间(sync-plan §六⑥):事件全部带空间标——状态按 space 留存(切回即见),
// 非当前空间的 changed 直接丢(切回时视图全量重查),toast 带空间名冒出来,
// 非当前空间有冻结/错误时点亮空间入口的红点(空间级提示,后台空间不许静默坏着)。
import { dotClass, invoke, currentSpaceId, MAIN_SPACE } from "./space";
import type { SyncStatus } from "./space";
import {
  openDevicesPage,
  renderDevices,
  resetDevicesPage,
  rosterDeparted,
} from "./devices";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateManual } from "./update";
import { generate } from "lean-qr";
import { toSvg } from "lean-qr/extras/svg";
import { TOAST_ERROR_MS } from "./timing";
import { t } from "./i18n";
import "./sync.css";

// 同步服务器默认地址——创建账户/加入设备(本文件)+ 加入空间(notebook.ts)三处入口预填。
export const DEFAULT_SYNC_URL = "wss://sync.zhujian.app";

/** 后端 `err_code::SEAT_LIMIT` 那句人话的判别片段(core `transport.rs` 的诊断串,
 *  Rust 诊断不翻)。**匹配字面量,不是显示文案** —— 翻它会破坏判据。 */
const SEAT_LIMIT_MARK = "同步席位已满";

type Mode =
  | "home"
  | "create"
  | "join"
  | "ceremony"
  | "pair"
  | "recovery"
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
let mode: Mode = "home";
// 一次性展示材料(关面板即弃,不留 DOM 外的副本)。
let ceremonyCode = "";
let pairCode = "";
let pairNote = "";
let pairFailed = false;
let shownRecovery = "";
// 仪式收尾提示:创号与压实共用同一个 ceremony 页,完成话术不同。
const CEREMONY_MSG_CREATE = t("sync.ceremonyDoneCreate");
let ceremonyDoneMsg = CEREMONY_MSG_CREATE;
// 仪式页随附警告(压实已提交但装配失败时,错误必须跟着恢复码走到仪式页)。
let ceremonyWarn = "";

function cur(): SyncStatus | null {
  return statuses.get(currentSpaceId()) ?? null;
}

export function setSpaceNames(names: Map<string, string>): void {
  spaceNames.clear();
  for (const [k, v] of names) spaceNames.set(k, v);
}

/** 用 list_spaces 快照给留存 Map 建基线(启动/刷列表时)。启动即被 veto 的空间没有
 *  事件桥,红点全靠这份基线。只补缺不覆盖:实时事件(listener 先于本快照注册)比
 *  快照新,旧快照不许倒灌。这是状态进 Map 的唯一快照口——单独 invoke sync_status
 *  再 set 会把请求前克隆的旧态盖到其后到达的事件上。 */
export function seedSpaceStatuses(list: { id: string; status: SyncStatus }[]): void {
  for (const s of list) {
    if (!statuses.has(s.id)) statuses.set(s.id, s.status);
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

/** 挂同步 UI。resolve = 四个事件监听都已注册完(调用方此后再拉状态基线,不漏事件)。 */
export async function initSync(opts: {
  refresh: () => void;
  openSpaces: () => void;
}): Promise<void> {
  const entry = document.getElementById("sync-entry");
  if (!entry) throw new Error("侧栏缺 #sync-entry(notebook.html 漂移?)");
  entry.addEventListener("click", () => openPanel());
  openSpaces = opts.openSpaces;

  let timer: number | undefined;
  await Promise.all([
    listen<{ space: string; status: SyncStatus }>("sync-status", (e) => {
      statuses.set(e.payload.space, e.payload.status);
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
      renderDot();
      // 面板开着且在状态页/高级页/设备页(均只读画状态):跟着最新快照走(配对/仪式等
      // 一次性页面不被打断)。改服务器保存回高级页,事件晚到也不至于显旧地址。
      if (overlay && (mode === "home" || mode === "advanced" || mode === "devices")) renderPanel();
    }),
    listen<{ space: string }>("sync-changed", (e) => {
      // 非当前空间的落地直接丢:切回去时视图整个重挂、全量重查(§六⑥)。
      if (e.payload.space !== currentSpaceId()) return;
      // 追赶期一秒可来多帧:尾沿去抖,合并成一次视图刷新(refresh 幂等)。
      window.clearTimeout(timer);
      timer = window.setTimeout(() => opts.refresh(), 300);
    }),
    listen<{ space: string; msg: string }>("sync-toast", (e) => {
      // 别的空间的提示(引导完成/图N翻案/冻结)不丢——带空间名冒出来。
      const { space, msg } = e.payload;
      showToast(space === currentSpaceId() ? msg : t("sync.toastFromSpace", { space: nameOf(space), msg }));
    }),
    listen<{ space: string; phase: string; detail: string }>("sync-pair", (e) => {
      // 配对进度只属于发起它的空间(面板是模态,配对期间空间切不走)。
      if (mode !== "pair" || e.payload.space !== currentSpaceId()) return;
      const { phase, detail } = e.payload;
      pairNote = detail;
      if (phase === "failed") pairFailed = true;
      if (phase === "done") {
        window.setTimeout(() => {
          if (mode === "pair") closePanel();
        }, 1800);
      }
      if (overlay) renderPanel();
    }),
  ]);
  // 状态基线不在这里拉:监听就绪后由 notebook.ts 的 refreshSpaceEntry →
  // seedSpaceStatuses 全量补缺(单独 invoke sync_status 有旧态倒灌竞态)。
}

// ---- 状态点 ----

function renderDot(): void {
  const dot = document.getElementById("sync-dot");
  const entry = document.getElementById("sync-entry");
  if (!dot || !entry) return;
  const status = cur();
  dot.className = `sync-dot ${dotClass(status)}`;
  const word = status ? (STATE_WORD[status.state] ?? status.state) : "";
  entry.title = status?.configured ? t("sync.entryTitle", { state: word }) : t("sync.entryTitleOff");
  renderAlert();
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
  mode = "home";
  overlay = document.createElement("div");
  overlay.className = "sync-overlay";
  overlay.addEventListener("mousedown", (e) => {
    // 恢复码仪式不许点外关闭(抄没抄只能由「我已抄写」确认)。
    if (e.target === overlay && mode !== "ceremony") closePanel();
  });
  const panel = document.createElement("div");
  panel.className = "sync-panel";
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  document.addEventListener("keydown", onPanelKey);
  renderPanel();
}

function closePanel(): void {
  overlay?.remove();
  overlay = null;
  document.removeEventListener("keydown", onPanelKey);
  ceremonyCode = "";
  pairCode = "";
  pairNote = "";
  pairFailed = false;
  shownRecovery = "";
  ceremonyDoneMsg = CEREMONY_MSG_CREATE;
  ceremonyWarn = "";
  resetDevicesPage();
}

function onPanelKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && mode !== "ceremony") {
    e.stopPropagation();
    closePanel();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function input(placeholder: string, value = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.className = "sync-input";
  i.placeholder = placeholder;
  i.value = value;
  i.spellcheck = false;
  return i;
}

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

function renderPanel(): void {
  if (!overlay) return;
  const panel = overlay.querySelector(".sync-panel");
  if (!panel) return;
  panel.replaceChildren();
  panel.appendChild(el("h2", "sync-title", t("sync.panelTitle")));
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
    case "ceremony":
      renderCeremony(body);
      break;
    case "pair":
      renderPair(body);
      break;
    case "recovery":
      renderRecovery(body);
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
}

function goto(m: Mode): void {
  mode = m;
  renderPanel();
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
  renderPanel();
}

// ---- 各页 ----

function renderHome(body: HTMLElement): void {
  const s = cur();
  if (!s || !s.configured) {
    // 未配置却带 error = 身份被停用(整库复制的同 device 等):先说明,别只给创号入口。
    if (s?.error) body.appendChild(el("div", "sync-err", s.error));
    body.appendChild(
      el("p", "sync-note", t("sync.homeIntro")),
    );
    const acts = el("div", "sync-actions");
    acts.appendChild(btn(t("sync.createAccount"), "hbtn", () => goto("create")));
    // 「用配对码加入」只在 main(装机 onboarding,本机数据保留并合并;space-entry-
    // plan §4):非 main 空间同步唯一路 = 创号;「把别处的账户带过来」在空间菜单的
    // 「加入空间」——那是独立入口,不背到这里。
    if (currentSpaceId() === MAIN_SPACE) {
      acts.appendChild(btn(t("sync.joinWithCode"), "hbtn", () => goto("join")));
    } else {
      body.appendChild(
        el("p", "sync-dim", t("sync.nonMainHint")),
      );
    }
    body.appendChild(acts);
    if (spaceNames.size <= 1) body.appendChild(spacesEntryRow()); // 411/D2 兜底,见该函数
    void appendUpdateFooter(body);
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
    body.appendChild(el("div", "sync-err", s.error));
  }
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn(t("sync.addDevice"), "hbtn", () => {
      pairCode = "";
      pairNote = t("sync.pairRequesting");
      pairFailed = false;
      goto("pair");
      void invoke<string>("sync_pair_start")
        .then((code) => {
          pairCode = code;
          pairNote = t("sync.pairInstructions");
          if (mode === "pair") renderPanel();
        })
        .catch((e: unknown) => {
          pairFailed = true;
          pairNote = String(e);
          if (mode === "pair") renderPanel();
        });
    }),
  );
  // 设备名单(identity-plan §5.8):「另有 N 台设备在线」那句话背后的真名单,连同
  // 移除设备与管理设备名单都在里头。入口恒显——权限差别在**行上**表达,不藏入口
  // (藏了就没人知道自己能不能退出账户)。
  acts.appendChild(btn(t("devices.entry"), "hbtn", () => gotoDevices()));
  acts.appendChild(btn(t("sync.viewRecovery"), "hbtn", () => goto("recovery")));
  body.appendChild(acts);
  if (spaceNames.size <= 1) body.appendChild(spacesEntryRow()); // 411/D2 兜底,见该函数
  // 修改服务器收进「高级」:运维动作不与日常操作同屏(概念收敛)。
  body.appendChild(advancedEntryRow());
  void appendUpdateFooter(body);
}

/** 空间入口的兜底行(411/D2,与安卓 116 同源):单空间时侧栏徽章整个藏起,而新建 /
 *  加入空间的**唯一**入口就在那枚徽章的菜单里 —— 这行把它接回来。多空间时徽章就在
 *  侧栏上,这行随之收起:**两者互斥、永远恰有一条路**(判据同为「几个空间」)。
 *  空间数取自 `spaceNames`(notebook.ts 每次 refreshSpaceEntry 都灌一遍,与徽章显隐同源
 *  ——两处读同一个数,不会各判各的)。 */
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

// 版本 + 「检查更新」入口。更新是 app 级关切、非同步,但同步面板是唯一的设置面(克制:
// 不为它单开「关于」),故落这里;更新逻辑仍在 update.ts,本处只放一枚入口。版本异步读,
// 先占位后填,不阻塞面板渲染(row 在首个 await 前已挂上,位置不乱)。
async function appendUpdateFooter(body: HTMLElement): Promise<void> {
  const row = el("div", "sync-update-row");
  row.appendChild(btn(t("sync.checkUpdate"), "hbtn", () => void checkForUpdateManual()));
  const ver = el("span", "sync-dim", t("sync.versionLoading"));
  row.appendChild(ver);
  body.appendChild(row);
  ver.textContent = t("sync.versionCurrent", { v: await getVersion() });
}

function formErr(body: HTMLElement): HTMLElement {
  const e = el("div", "sync-err sync-form-err");
  body.appendChild(e);
  return e;
}

function renderCreate(body: HTMLElement): void {
  body.appendChild(
    el("p", "sync-note", t("sync.createIntro")),
  );
  const server = input(t("sync.serverPlaceholder"), DEFAULT_SYNC_URL);
  body.appendChild(server);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  const go = btn(t("sync.createGo"), "hbtn", () => {
    go.disabled = true;
    err.textContent = "";
    void invoke<string>("sync_create_account", {
      serverUrl: server.value.trim(),
    })
      .then((code) => {
        ceremonyCode = code;
        goto("ceremony");
      })
      .catch((e: unknown) => {
        go.disabled = false;
        err.textContent = String(e);
      });
  });
  acts.appendChild(go);
  acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("home")));
  body.appendChild(acts);
}

// Crockford 抄录容错的规范化,与 core parse_recovery_code **严格同口径**(只容忍
// 空格与 `-`;实现审 L7:前端多容忍 tab/换行会让仪式通过、将来真恢复时被 core
// 拒)。大写、O→0、I/L→1。只用于仪式回验比对,不做解码。
function normalizeCode(s: string): string {
  return s
    .replace(/[- ]/g, "")
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

function renderCeremony(body: HTMLElement): void {
  body.appendChild(el("p", "sync-note", t("sync.ceremonyIntro")));
  body.appendChild(el("div", "sync-code sync-code--recovery", ceremonyCode));
  // 压实已提交但装配失败:错误随恢复码一起到仪式页(先抄码,再按指引重启)。
  if (ceremonyWarn) body.appendChild(el("div", "sync-err", ceremonyWarn));
  body.appendChild(
    el(
      "p",
      "sync-warn",
      t("sync.ceremonyWarn"),
    ),
  );
  // 强制仪式(§2):抄写后必须回输核对——「点过确认」不算抄过,输对才放行。
  const confirm = input(t("sync.ceremonyConfirmPh"));
  body.appendChild(confirm);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn(t("sync.ceremonyConfirm"), "hbtn", () => {
      if (normalizeCode(confirm.value) !== normalizeCode(ceremonyCode)) {
        err.textContent = t("sync.ceremonyMismatch");
        return;
      }
      showToast(ceremonyDoneMsg);
      closePanel();
    }),
  );
  body.appendChild(acts);
}

function renderJoin(body: HTMLElement): void {
  body.appendChild(
    el("p", "sync-note", t("sync.joinIntro")),
  );
  const server = input(t("sync.serverPlaceholder"), DEFAULT_SYNC_URL);
  const code = input(t("sync.pairCodePh"));
  body.appendChild(server);
  body.appendChild(code);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  const go = btn(t("sync.joinGo"), "hbtn", () => {
    go.disabled = true;
    err.textContent = "";
    void invoke("sync_pair_join", { serverUrl: server.value.trim(), code: code.value.trim() })
      .then(() => {
        showToast(t("sync.joinedToast"));
        closePanel();
      })
      .catch((e: unknown) => {
        go.disabled = false;
        err.textContent = String(e);
      });
  });
  acts.appendChild(go);
  acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("home")));
  body.appendChild(acts);
}

function renderPair(body: HTMLElement): void {
  if (pairCode) {
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
  body.appendChild(el("p", pairFailed ? "sync-err" : "sync-note", pairNote));
  const acts = el("div", "sync-actions");
  // 「席位已满:请先移除一台不用的设备」——那句话得点得进能移除设备的地方(§5.8 末)。
  // 判据是后端诊断串的一个片段(Rust 诊断不翻,i18n 边界);它是**匹配字面量不是文案**,
  // 已逐值登记在 scripts/check-i18n-drift.mjs,与 update.ts 剥版本噪音那两条同族。
  if (pairFailed && pairNote.includes(SEAT_LIMIT_MARK)) {
    acts.appendChild(btn(t("devices.entry"), "hbtn", () => gotoDevices()));
  }
  acts.appendChild(btn(t("sync.close"), "hbtn", () => closePanel()));
  body.appendChild(acts);
}

function renderRecovery(body: HTMLElement): void {
  if (!shownRecovery) {
    body.appendChild(
      el("p", "sync-note", t("sync.recoveryIntro")),
    );
    const acts = el("div", "sync-actions");
    acts.appendChild(
      btn(t("sync.showRecovery"), "hbtn", () => {
        void invoke<string>("sync_recovery_code")
          .then((code) => {
            shownRecovery = code;
            if (mode === "recovery") renderPanel();
          })
          .catch((e: unknown) => showToast(String(e)));
      }),
    );
    acts.appendChild(btn(t("sync.back"), "hbtn", () => goto("home")));
    body.appendChild(acts);
    return;
  }
  body.appendChild(el("div", "sync-code sync-code--recovery", shownRecovery));
  body.appendChild(
    el(
      "p",
      "sync-warn",
      t("sync.recoveryWarn"),
    ),
  );
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn(t("sync.hideRecovery"), "hbtn", () => {
      shownRecovery = "";
      goto("home");
    }),
  );
  body.appendChild(acts);
}

function renderServer(body: HTMLElement): void {
  body.appendChild(el("p", "sync-note", t("sync.serverIntro")));
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
          err.textContent = String(e);
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
