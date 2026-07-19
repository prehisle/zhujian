// 同步 UI 最小面(sync-protocol §8;P2-g)。侧栏底部一枚状态点 + 设置面板(创建
// 账户[恢复码强制仪式]/发起配对[显示配对码]/加入账户[输配对码]/服务器地址)+
// 非模态提示条。未配置时只有一个安静入口,零打扰;远端 op 落地(sync-changed)
// 去抖后刷当前视图(视图 refresh 已幂等)。
// 97 多空间(sync-plan §六⑥):事件全部带空间标——状态按 space 留存(切回即见),
// 非当前空间的 changed 直接丢(切回时视图全量重查),toast 带空间名冒出来,
// 非当前空间有冻结/错误时点亮空间入口的红点(空间级提示,后台空间不许静默坏着)。
import { dotClass, invoke, currentSpaceId, MAIN_SPACE } from "./space";
import type { SyncStatus } from "./space";
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { checkForUpdateManual } from "./update";
import { generate } from "lean-qr";
import { toSvg } from "lean-qr/extras/svg";
import "./sync.css";

type Mode =
  | "home"
  | "create"
  | "join"
  | "ceremony"
  | "pair"
  | "recovery"
  | "server"
  | "advanced";

const STATE_WORD: Record<string, string> = {
  off: "未启用",
  connecting: "连接中…",
  booting: "初始同步中…",
  online: "已连接",
  offline: "离线,重连中…",
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
const CEREMONY_MSG_CREATE = "账户已创建,同步已开启";
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
  return spaceNames.get(space) ?? "另一空间";
}

/** notebook.ts 切完空间后调:状态点/面板改画新空间。留存 Map 由事件流 + 基线维护
 *  (有 transport 的空间每次变更都推事件;veto/dead 空间状态固化、基线值恒真),
 *  这里不再单独拉快照——请求前克隆的旧态会倒灌覆盖其后到达的事件。 */
export function syncSpaceSwitched(): void {
  renderDot();
  if (!overlay) return;
  if (mode === "home" || mode === "advanced") renderPanel();
}

/** 挂同步 UI。resolve = 四个事件监听都已注册完(调用方此后再拉状态基线,不漏事件)。 */
export async function initSync(opts: { refresh: () => void }): Promise<void> {
  const entry = document.getElementById("sync-entry");
  if (!entry) throw new Error("侧栏缺 #sync-entry(notebook.html 漂移?)");
  entry.addEventListener("click", () => openPanel());

  let timer: number | undefined;
  await Promise.all([
    listen<{ space: string; status: SyncStatus }>("sync-status", (e) => {
      statuses.set(e.payload.space, e.payload.status);
      renderAlert();
      if (e.payload.space !== currentSpaceId()) return; // 留存即可,不动当前画面
      renderDot();
      // 面板开着且在状态页/高级页(均只读画状态):跟着最新快照走(配对/仪式等
      // 一次性页面不被打断)。改服务器保存回高级页,事件晚到也不至于显旧地址。
      if (overlay && (mode === "home" || mode === "advanced")) renderPanel();
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
      showToast(space === currentSpaceId() ? msg : `「${nameOf(space)}」${msg}`);
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
  entry.title = status?.configured ? `同步:${word}` : "同步(未启用)";
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
  panel.appendChild(el("h2", "sync-title", "同步"));
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
  }
}

function goto(m: Mode): void {
  mode = m;
  renderPanel();
}

// ---- 各页 ----

function renderHome(body: HTMLElement): void {
  const s = cur();
  if (!s || !s.configured) {
    // 未配置却带 error = 身份被停用(整库复制的同 device 等):先说明,别只给创号入口。
    if (s?.error) body.appendChild(el("div", "sync-err", s.error));
    body.appendChild(
      el("p", "sync-note", "多设备同步,内容端到端加密——服务器看不到记录内容。"),
    );
    const acts = el("div", "sync-actions");
    acts.appendChild(btn("创建账户(第一台设备)", "hbtn", () => goto("create")));
    // 「用配对码加入」只在 main(装机 onboarding,本机数据保留并合并;space-entry-
    // plan §4):非 main 空间同步唯一路 = 创号;「把别处的账户带过来」在空间菜单的
    // 「加入空间」——那是独立入口,不背到这里。
    if (currentSpaceId() === MAIN_SPACE) {
      acts.appendChild(btn("用配对码加入", "hbtn", () => goto("join")));
    } else {
      body.appendChild(
        el("p", "sync-dim", "要把别处的账户带到这台电脑,用左上空间菜单里的「加入空间」。"),
      );
    }
    body.appendChild(acts);
    void appendUpdateFooter(body);
    return;
  }
  const word = STATE_WORD[s.state] ?? s.state;
  const line = el("div", "sync-stateline");
  line.appendChild(el("span", `sync-dot ${dotClass(s)}`));
  line.appendChild(el("b", "", word));
  if (s.state === "online") {
    line.appendChild(el("span", "sync-dim", ` · 另有 ${s.peers_online} 台设备在线`));
  }
  body.appendChild(line);
  if (s.skew) {
    body.appendChild(el("div", "sync-warn", "对端版本较新:请升级朱笺后继续同步。"));
  }
  if (s.clock_skew) {
    body.appendChild(
      el("div", "sync-warn", "另一台设备的系统时间明显偏快,可能让它的编辑总是「胜出」:请核对两台设备的时间。"),
    );
  }
  if (s.frozen.length > 0) {
    body.appendChild(
      el("div", "sync-warn", "检测到设备历史分叉,已冻结该设备的同步(需人工处理)。"),
    );
  }
  if (s.error) {
    body.appendChild(el("div", "sync-err", s.error));
  }
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn("添加设备", "hbtn", () => {
      pairCode = "";
      pairNote = "正在向服务器申请配对码…";
      pairFailed = false;
      goto("pair");
      void invoke<string>("sync_pair_start")
        .then((code) => {
          pairCode = code;
          pairNote =
            "用手机朱笺「同步」里的「扫码连接电脑」直接扫;或在新设备上选「用配对码加入」,输入服务器地址和这串码。10 分钟内有效,只能用一次。";
          if (mode === "pair") renderPanel();
        })
        .catch((e: unknown) => {
          pairFailed = true;
          pairNote = String(e);
          if (mode === "pair") renderPanel();
        });
    }),
  );
  acts.appendChild(btn("查看恢复码", "hbtn", () => goto("recovery")));
  body.appendChild(acts);
  // 修改服务器收进「高级」:运维动作不与日常操作同屏(概念收敛)。
  body.appendChild(advancedEntryRow());
  void appendUpdateFooter(body);
}

/** 「高级」低调入口:服务器信息与运维动作的收纳处。 */
function advancedEntryRow(): HTMLElement {
  const row = el("div", "sync-update-row");
  row.appendChild(btn("高级…", "hbtn", () => goto("advanced")));
  return row;
}

function renderAdvanced(body: HTMLElement): void {
  const s = cur();
  if (s?.configured) {
    // 服务器地址的唯一常显出处(首屏已收走)。
    body.appendChild(el("div", "sync-kv", `服务器 ${s.server_url ?? ""}`));
    const acts = el("div", "sync-actions");
    acts.appendChild(btn("修改服务器", "hbtn", () => goto("server")));
    body.appendChild(acts);
  }
  const acts = el("div", "sync-actions");
  acts.appendChild(btn("返回", "hbtn", () => goto("home")));
  body.appendChild(acts);
}

// 版本 + 「检查更新」入口。更新是 app 级关切、非同步,但同步面板是唯一的设置面(克制:
// 不为它单开「关于」),故落这里;更新逻辑仍在 update.ts,本处只放一枚入口。版本异步读,
// 先占位后填,不阻塞面板渲染(row 在首个 await 前已挂上,位置不乱)。
async function appendUpdateFooter(body: HTMLElement): Promise<void> {
  const row = el("div", "sync-update-row");
  row.appendChild(btn("检查更新", "hbtn", () => void checkForUpdateManual()));
  const ver = el("span", "sync-dim", "当前 v…");
  row.appendChild(ver);
  body.appendChild(row);
  ver.textContent = `当前 v${await getVersion()}`;
}

function formErr(body: HTMLElement): HTMLElement {
  const e = el("div", "sync-err sync-form-err");
  body.appendChild(e);
  return e;
}

function renderCreate(body: HTMLElement): void {
  body.appendChild(
    el("p", "sync-note", "把本机创建为账户的第一台设备,其他设备之后配对加入。"),
  );
  const server = input("服务器地址(wss://… 或 ws://…)");
  body.appendChild(server);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  const go = btn("创建", "hbtn", () => {
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
  acts.appendChild(btn("返回", "hbtn", () => goto("home")));
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
  body.appendChild(el("p", "sync-note", "这是账户恢复码——请抄写在纸上,存放在安全的地方。"));
  body.appendChild(el("div", "sync-code sync-code--recovery", ceremonyCode));
  // 压实已提交但装配失败:错误随恢复码一起到仪式页(先抄码,再按指引重启)。
  if (ceremonyWarn) body.appendChild(el("div", "sync-err", ceremonyWarn));
  body.appendChild(
    el(
      "p",
      "sync-warn",
      "恢复码是账户密钥,不是数据备份:恢复数据还必须有至少一台在线的完整副本。它不存在服务器上,丢了无人能帮你找回。",
    ),
  );
  // 强制仪式(§2):抄写后必须回输核对——「点过确认」不算抄过,输对才放行。
  const confirm = input("抄写完成后,在这里重新输入一遍以确认");
  body.appendChild(confirm);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn("我已抄写,完成", "hbtn", () => {
      if (normalizeCode(confirm.value) !== normalizeCode(ceremonyCode)) {
        err.textContent = "输入与恢复码不符——请对照纸上抄写的内容逐组核对。";
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
    el("p", "sync-note", "在老设备上点「添加设备」得到服务器地址和配对码,两项都填。本机已有的数据会保留并合并。"),
  );
  const server = input("服务器地址(wss://… 或 ws://…)");
  const code = input("配对码(形如 123456789-XXXX-XXXX)");
  body.appendChild(server);
  body.appendChild(code);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  const go = btn("加入", "hbtn", () => {
    go.disabled = true;
    err.textContent = "";
    void invoke("sync_pair_join", { serverUrl: server.value.trim(), code: code.value.trim() })
      .then(() => {
        showToast("已连接,正在初始同步…");
        closePanel();
      })
      .catch((e: unknown) => {
        go.disabled = false;
        err.textContent = String(e);
      });
  });
  acts.appendChild(go);
  acts.appendChild(btn("返回", "hbtn", () => goto("home")));
  body.appendChild(acts);
}

function renderPair(body: HTMLElement): void {
  if (pairCode) {
    // 手输路要抄两项(服务器地址+码),都在本页给全——首屏已不再常显服务器。
    const srv = cur()?.server_url;
    if (srv) body.appendChild(el("div", "sync-kv", `服务器 ${srv}`));
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
  acts.appendChild(btn("关闭", "hbtn", () => closePanel()));
  body.appendChild(acts);
}

function renderRecovery(body: HTMLElement): void {
  if (!shownRecovery) {
    body.appendChild(
      el("p", "sync-note", "恢复码是账户密钥,确认周围无人再显示。"),
    );
    const acts = el("div", "sync-actions");
    acts.appendChild(
      btn("显示恢复码", "hbtn", () => {
        void invoke<string>("sync_recovery_code")
          .then((code) => {
            shownRecovery = code;
            if (mode === "recovery") renderPanel();
          })
          .catch((e: unknown) => showToast(String(e)));
      }),
    );
    acts.appendChild(btn("返回", "hbtn", () => goto("home")));
    body.appendChild(acts);
    return;
  }
  body.appendChild(el("div", "sync-code sync-code--recovery", shownRecovery));
  body.appendChild(
    el(
      "p",
      "sync-warn",
      "恢复码是账户密钥,不是数据备份:恢复还需要至少一台在线的完整副本。抄写在纸上,别截图、别存网盘。",
    ),
  );
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn("收起", "hbtn", () => {
      shownRecovery = "";
      goto("home");
    }),
  );
  body.appendChild(acts);
}

function renderServer(body: HTMLElement): void {
  body.appendChild(el("p", "sync-note", "运营者迁移服务器时改这里,保存后立即重连。"));
  const server = input("服务器地址(wss://… 或 ws://…)", cur()?.server_url ?? "");
  body.appendChild(server);
  const err = formErr(body);
  const acts = el("div", "sync-actions");
  acts.appendChild(
    btn("保存", "hbtn", () => {
      err.textContent = "";
      void invoke("sync_set_server", { serverUrl: server.value.trim() })
        .then(() => goto("advanced"))
        .catch((e: unknown) => {
          err.textContent = String(e);
        });
    }),
  );
  acts.appendChild(btn("返回", "hbtn", () => goto("advanced")));
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
  toastTimer = window.setTimeout(() => t.classList.remove("show"), 6000);
}
