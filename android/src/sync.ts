// 同步面(P4-d):当前空间的输码一屏 + 引导进度 + 状态/恢复码;扫码加入(107)+
// 「一主两辅」互斥折叠(133)+ 加入空间(space-entry-plan §3)+ 创号恢复码强制仪式
// (phone-space-plan §2.1/§3)+ 邀请设备出码页(§2.2)。
// 310 第③笔:自 main.ts 纯搬迁成模块(initX(Deps) 的形,面内控件与事件桥监听全在
// initSync 里挂——main.ts 在模块体同一同步 tick 内调用,先于任何事件派发,启动期
// 事件不丢);空间切换编排与事件代次账本仍住 main.ts,经 Deps 注入。行为零改动。
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  scan,
  cancel,
  checkPermissions,
  requestPermissions,
  Format,
} from "@tauri-apps/plugin-barcode-scanner";
import {
  getCurrentSpace,
  sinvoke,
  spaceLabel,
  syncCreateAccount,
  syncPairJoin,
  syncPairStart,
  type SpaceInfo,
} from "./api";
import {
  feedDevices,
  initDevices,
  openDevicesPanel,
  resetDevices,
  rosterDeparted,
} from "./devices";
import { t } from "./i18n";
import { $, esc, showBar, showError } from "./ui";

/** 后端 `err_code::SEAT_LIMIT` 那句人话的判别片段(core `transport.rs` 的诊断串,
 *  Rust 诊断不翻)。**匹配字面量,不是显示文案** —— 翻它会破坏判据。 */
const SEAT_LIMIT_MARK = "同步席位已满";

// 事件桥的统一信封(后端 bridge_emit):space 标 + 代次 + 原 payload(§12)。过滤谓词
// acceptSpaced 与代次账本 seenGeneration 住 main.ts(space-foreground 监听要直写账本),
// 本模块经 Deps 拿谓词;类型随三个同步面监听搬来这边,main.ts 回头引用。
export type Spaced<T> = { space: string; generation: number; payload: T };

/** 服务器权威名册的一行(sync-proto `RosterEntry`;identity-plan §5.4)。**只有
 *  device_id 与管理标记,不带别名**——别名是 E2EE 的,服务器根本不知道。 */
export type RosterEntry = { device: string; admin: boolean };

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
  /** 服务器权威名册;**`null` = 不知道**(未连上 / attach 那枚推送丢了 / 服务器版本旧)。
   *  ⛔ 消费方不许把它折成空数组(§5.16.2-7):拿不到就不给操作面。会话结束即回 `null`。 */
  roster: RosterEntry[] | null;
};

type Deps = {
  /** 单一 activePane 的开面入口(main.ts openPane):同步面顶栏入口也走它。 */
  openPane: (name: string) => void;
  /** 事件桥过滤谓词(main.ts acceptSpaced):space+generation 双过滤,账本住 main.ts。 */
  acceptSpaced: (e: { space: string; generation: number }) => boolean;
  /** 空间列表影子(main.ts spacesCache):加入成功后的起名提示按多空间与否分话术。 */
  getSpaces: () => SpaceInfo[];
  /** 空间列表重拉(main.ts refreshSpaces)。 */
  refreshSpaces: () => Promise<void>;
  /** 草稿感知的空间切换(main.ts switchSpace):Integrated 后尝试切过去。 */
  switchSpace: (id: string) => Promise<void>;
  /** 卡片编辑草稿在场(cardpanel):加入空间的 Integrated 不许强切丢草稿。 */
  hasDirtyDraft: () => boolean;
};

let deps: Deps;

const fmtMb = (b: number) => `${(b / 1048576).toFixed(1)} MB`;

const STATE_LABEL: Record<string, string> = {
  off: t("sync.stateOff"),
  connecting: t("sync.stateConnecting"),
  booting: t("sync.stateBooting"),
  online: t("sync.stateOnline"),
  offline: t("sync.stateOffline"),
};

export function renderSync(s: SyncStatus) {
  const dot = $("sync-dot");
  // 断网/出错态类名用 off 不用 error:全局 .error 是左上角 fixed 的错误提示条,
  // 状态点若带 error 类会被它命中、断网时被拽到左上角盖住「朱」(真机 bug)。
  dot.className =
    "dot " +
    (s.state === "online"
      ? "online"
      : s.state === "connecting" || s.state === "booting"
        ? "busy"
        : s.error || s.state === "offline"
          ? "off"
          : "");
  const err = s.error ? `<div class="err">${esc(s.error)}</div>` : "";
  const frozen = s.frozen.length
    ? `<div class="err">${t("sync.frozen", { list: esc(s.frozen.join(t("sync.listSep"))) })}</div>`
    : "";
  $("sync-state").innerHTML =
    `<b>${esc(STATE_LABEL[s.state] ?? s.state)}</b>${err}${frozen}`;
  $("sync-join").hidden = s.configured;
  // 未配置态的路数按空间分(space-entry-plan §4):main 保留「一主两辅」(装机
  // onboarding:扫码/输码把本机并进已有账户);**非 main 只有创号一条路**——
  // 「把别处的账户带过来」的入口是空间面板的「加入空间」,不在这里。
  const isMain = getCurrentSpace() === "main";
  (($("sync-scan-btn").parentElement) as HTMLElement).hidden = !isMain;
  $("sync-alt-pair").hidden = !isMain;
  const altCreate = $("sync-alt-create") as HTMLButtonElement;
  altCreate.textContent = isMain ? t("sync.altCreateMain") : t("sync.altCreateOther");
  altCreate.classList.toggle("ghost", isMain);
  $("sync-boot").hidden = s.state !== "booting";
  $("sync-online").hidden = !s.configured;
  // 名册的唯一出处是状态面(§5.7-6):每份新快照都喂给设备面,开着就当场重画。
  feedDevices(s);
  if (s.configured) {
    const rows: [string, string][] = [
      [t("sync.infoAccount"), s.account_id ?? ""],
      [t("sync.infoServer"), s.server_url ?? ""],
      [t("sync.infoPeers"), String(s.peers_online)],
    ];
    $("sync-info").innerHTML = rows
      .map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>`)
      .join("");
  }
}

// 辅路互斥折叠(codex 审:两条路对当前空间是互斥决策,共享的服务器地址行只在
// 任一辅路展开时显示;重复点当前项收起)。切空间时复位并清掉旧材料——上一空间
// 的配对码不许带进新空间(创号自 open-signup 起无码,无材料可清)。
type SecondaryMode = null | "pair" | "create";
let secondary: SecondaryMode = null;

function renderSecondary() {
  $("sync-manual").hidden = secondary !== "pair";
  $("sync-create").hidden = secondary !== "create";
  $("sync-server-row").hidden = secondary === null;
}

function resetSecondary() {
  secondary = null;
  ($("sync-code") as HTMLInputElement).value = "";
  renderSecondary();
}

/** 同步面的一次性展示态全体复位:出码页/恢复码/连接信息/辅路折叠与输了一半的码。
 *  切空间必调——旧空间的恢复码挂在新空间的同步页上=把错误密钥当新空间的交付
 *  (codex 实现审必修 1);空间重置后同理。调用点在 main.ts(onSpaceChanged / 空间重置)。 */
export function resetSyncTransient() {
  // 名册是「设备 × 空间」粒度的服务器事实:旧空间那份一个字都不许留到新空间上。
  resetDevices();
  $("sync-pair-out").hidden = true;
  const recovery = $("sync-recovery");
  recovery.hidden = true;
  recovery.textContent = "";
  $("sync-recovery-note").hidden = true;
  $("sync-info").hidden = true;
  resetSecondary();
}

// 手输与扫码共用同一条加入路(107 抽出:后端 sync_pair_join 不区分码怎么来的)。
// 配对目标 = 点击那刻的当前空间(写类命令,不走 sinvoke,明确处理响应)。
async function doJoin(serverUrl: string, code: string) {
  if (!serverUrl || !code) return;
  const target = getCurrentSpace();
  const btn = $("sync-join-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("sync.joining");
  try {
    await syncPairJoin(target, serverUrl, code);
    resetSecondary(); // 码已消费,收起辅路清掉旧材料。
    await deps.refreshSpaces();
    const cur = deps.getSpaces().find((s) => s.id === target);
    // 起名提示只在多空间时给(codex 审:单空间用户刚扫完码,别把「空间」概念抛回来)。
    showBar(
      deps.getSpaces().length > 1 && cur && !cur.name
        ? t("sync.connectedNameHint")
        : t("sync.connected"),
      true,
    );
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = t("sync.join");
  }
}

// ---- 扫码加入(107):桌面「发起配对」旁出二维码,扫到即自动加入 ----------------

type PairPayload = { server: string; code: string };

function parsePairQr(text: string): PairPayload {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("这不是朱简的配对二维码");
  }
  if (o?.zhujian !== "pair" || typeof o.server !== "string" || typeof o.code !== "string") {
    throw new Error("这不是朱简的配对二维码");
  }
  if (o.v !== 1) throw new Error("二维码版本较新:请先升级手机端朱简再扫");
  return { server: o.server, code: o.code };
}

let scanCancelled = false;

/** 收扫码层(146 真机取证):plugin 的 cancel 命令会 resolve,但**部分状态下不
 *  reject 挂着的 scan()**——页面若只等 startScan.finally 收尾,会永远停在挖空态
 *  (「取消扫码」按钮此前同患)。故 UI 收尾自己做、不等插件:cancel 尽力发出,
 *  scanning/挖空层立即收,与 startScan.finally 幂等;返回键与取消按钮共用这一条。 */
export function dismissScanOverlay() {
  scanCancelled = true;
  void cancel().catch(() => {});
  document.body.classList.remove("scanning");
  $("scan").hidden = true;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 扫码取一枚配对载荷,交给 `onGot` 路由(两条消费路:main 装机配对 doJoin /
 *  「加入空间」doJoinSpace——扫码只管拿码,去哪由入口按钮决定)。 */
async function startScan(onGot: (p: PairPayload) => Promise<void>) {
  let perm = await checkPermissions();
  if (perm !== "granted" && perm !== "denied") perm = await requestPermissions();
  if (perm !== "granted") {
    showError(t("sync.noCamera"));
    return;
  }
  scanCancelled = false;
  document.body.classList.add("scanning");
  $("scan").hidden = false;
  try {
    const got = await scan({ windowed: true, formats: [Format.QRCode] });
    const p = parsePairQr(got.content);
    document.body.classList.remove("scanning");
    $("scan").hidden = true;
    await onGot(p);
  } catch (err) {
    if (!scanCancelled) showError(errMsg(err));
  } finally {
    document.body.classList.remove("scanning");
    $("scan").hidden = true;
  }
}

// ---- 加入空间(space-entry-plan §3:app 级入口,不收目标 space_id) -------------

type JoinOutcome =
  | {
      kind: "integrated";
      space: { id: string; name: string | null; configured: boolean };
      warnings: string[];
    }
  | { kind: "published_needs_restart"; space_id: string; error: string };

const JOIN_PHASE_LABEL: Record<string, string> = {
  preparing: t("sync.phasePreparing"),
  pairing: t("sync.phasePairing"),
  booting: t("sync.phaseBooting"),
  publishing: t("sync.phasePublishing"),
  integrating: t("sync.phaseIntegrating"),
};

/** 当前 attempt 的 id(null=没有加入在跑)。进度事件只接受当前 attempt、terminal
 *  后拒迟到事件(取消旧加入后 WebView 队列里的旧进度不许画到新一次加入上,§3.2)。 */
let joinAttempt: string | null = null;

function renderJoinProgress(text: string | null) {
  const box = $("join-progress");
  box.hidden = !text;
  box.textContent = text ?? "";
  $("join-cancel-row").hidden = joinAttempt === null;
}

async function doJoinSpace(serverUrl: string, code: string) {
  if (!serverUrl || !code) return;
  if (joinAttempt) {
    showError(t("sync.joinInFlight"));
    return;
  }
  const attempt = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  joinAttempt = attempt;
  renderJoinProgress(t("sync.phasePreparing"));
  const goBtn = $("join-go") as HTMLButtonElement;
  const scanBtn = $("join-scan-btn") as HTMLButtonElement;
  goBtn.disabled = true;
  scanBtn.disabled = true;
  try {
    const out = await invoke<JoinOutcome>("join_space", {
      serverUrl,
      code,
      attemptId: attempt,
    });
    // 结果分道**先于**任何后续收尾(codex 一轮 M4):后端事实(Integrated /
    // PublishedNeedsRestart)不许被前端刷新的任何闪失盖成「普通失败」。
    $("join-form").hidden = true;
    ($("join-code") as HTMLInputElement).value = "";
    if (out.kind === "integrated") {
      const label = spaceLabel({ id: out.space.id, name: out.space.name });
      const warn = out.warnings.length ? t("sync.joinWarn", { list: out.warnings.join(t("sync.warnSep")) }) : "";
      await deps.refreshSpaces();
      // Integrated 不含视图切换(§3.2 二轮 H3):经现有**草稿感知**入口尝试切换,
      // 草稿挡住就保持原前台、指路即可——绝不 reconcileForeground 强切丢草稿。
      if (!deps.hasDirtyDraft()) await deps.switchSpace(out.space.id);
      if (getCurrentSpace() === out.space.id) {
        showBar(t("sync.joined", { name: label, warn }), true);
      } else {
        showBar(t("sync.joinedStay", { name: label, warn }), true);
      }
    } else {
      // 空间已真实存在(账户已注册):只提示重启后出现,绝不谎报失败(三轮 M5)。
      showError(out.error);
    }
  } catch (err) {
    showError(String(err));
  } finally {
    joinAttempt = null;
    renderJoinProgress(null);
    goBtn.disabled = false;
    scanBtn.disabled = false;
  }
}

// ---- 创号 + 恢复码强制仪式(phone-space-plan §2.1/§3,与桌面对称) --------------

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

let ritualCode = "";

/** 强制仪式:展示+警示+回输核对,输对才放行。post-commit 错误(目录刷新失败等)
 *  随码一起亮出——账户已创建是事实,码必须交付,错误只旁路提示(codex r1 #5)。 */
function openRitual(code: string, postErr: string | null) {
  ritualCode = code;
  $("ritual-code").textContent = code;
  const post = $("ritual-post");
  post.hidden = !postErr;
  post.textContent = postErr ?? "";
  ($("ritual-confirm") as HTMLInputElement).value = "";
  $("ritual-err").textContent = "";
  $("ritual").hidden = false;
}

async function doCreateAccount() {
  const serverUrl = ($("sync-server") as HTMLInputElement).value.trim();
  if (!serverUrl) return;
  const target = getCurrentSpace();
  const btn = $("sync-create-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("sync.creating");
  try {
    // 刻意不判弃迟到响应:码一旦提交只出这一次机会窗,即使空间已切走也必须
    // 走完仪式(api.ts 注释同款纪律)。
    const out = await syncCreateAccount(target, serverUrl);
    openRitual(out.recovery_code, out.post_commit_error);
  } catch (err) {
    showError(String(err));
  } finally {
    btn.disabled = false;
    btn.textContent = t("sync.createAccount");
  }
}

// ---- 邀请设备(老设备侧出码;phone-space-plan §2.2/§3) -------------------------

async function doInviteDevice() {
  const target = getCurrentSpace();
  const btn = $("sync-invite-btn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = t("sync.requestingCode");
  try {
    // 码与服务器地址由后端同 runtime 原子取(实现审 M3),不从状态缓存拼。
    const { code, server_url: server } = await syncPairStart(target);
    if (target !== getCurrentSpace()) return; // 出码页属于该空间,已切走就不画
    $("sync-pair-kv").innerHTML = (
      [
        [t("sync.pairServer"), server],
        [t("sync.pairCode"), code],
      ] as const
    )
      .map(
        ([k, v]) =>
          `<span class="k">${esc(k)}</span><span class="v" style="user-select:text">${esc(v)}</span>`,
      )
      .join("");
    $("sync-pair-copy").dataset.copy = t("sync.pairCopyText", { server, code });
    $("sync-pair-note").textContent = t("sync.pairNote");
    $("sync-pair-out").hidden = false;
  } catch (err) {
    showError(String(err));
    // 「席位已满:请先移除一台不用的设备」那句话得点得到能移除设备的地方(§5.8 末)。
    // 桌面在失败页上多给一枚入口按钮;手机这一格是折叠区,直接把它展开——同一件事,
    // 形态随端(端间差异见 devices.ts 头注)。
    if (String(err).includes(SEAT_LIMIT_MARK)) openDevicesPanel();
  } finally {
    btn.disabled = false;
    btn.textContent = t("sync.addDevice");
  }
}

export function initSync(d: Deps): void {
  deps = d;
  $("sync-toggle").addEventListener("click", () => deps.openPane("sync"));
  $("sync-alt-pair").addEventListener("click", () => {
    secondary = secondary === "pair" ? null : "pair";
    renderSecondary();
  });
  $("sync-alt-create").addEventListener("click", () => {
    secondary = secondary === "create" ? null : "create";
    renderSecondary();
  });
  $("sync-join-btn").addEventListener("click", () => {
    void doJoin(
      ($("sync-server") as HTMLInputElement).value.trim(),
      ($("sync-code") as HTMLInputElement).value.trim(),
    );
  });
  $("sync-scan-btn").addEventListener("click", () =>
    void startScan(async (p) => {
      ($("sync-server") as HTMLInputElement).value = p.server;
      ($("sync-code") as HTMLInputElement).value = p.code;
      await doJoin(p.server, p.code);
    }).catch((e) => showError(errMsg(e))),
  );
  $("scan-cancel").addEventListener("click", dismissScanOverlay);
  void listen<{ attempt_id: string; phase: string; received: number; total: number }>(
    "join-progress",
    (e) => {
      const p = e.payload;
      if (p.attempt_id !== joinAttempt) return; // 只接受当前 attempt(迟到事件拒)
      renderJoinProgress(
        p.phase === "booting" && p.total > 0
          ? t("sync.bootProgress", { received: fmtMb(p.received), total: fmtMb(p.total) })
          : (JOIN_PHASE_LABEL[p.phase] ?? p.phase),
      );
    },
  );
  $("join-scan-btn").addEventListener("click", () =>
    void startScan(async (p) => {
      await doJoinSpace(p.server, p.code);
    }).catch((e) => showError(errMsg(e))),
  );
  $("join-alt-btn").addEventListener("click", () => {
    const f = $("join-form");
    f.hidden = !f.hidden;
  });
  $("join-go").addEventListener("click", () => {
    void doJoinSpace(
      ($("join-server") as HTMLInputElement).value.trim(),
      ($("join-code") as HTMLInputElement).value.trim(),
    );
  });
  $("join-cancel").addEventListener("click", () => {
    void invoke("join_space_cancel").catch(() => {});
  });
  $("sync-recovery-btn").addEventListener("click", async () => {
    const box = $("sync-recovery");
    try {
      box.textContent = await sinvoke<string>("sync_recovery_code");
      // 警示随码同现(codex 审:「恢复码≠数据备份」必须跟着码走,防误当备份)。
      $("sync-recovery-note").hidden = false;
      box.hidden = false;
    } catch (err) {
      showError(String(err));
    }
  });
  // 连接信息(账户/服务器/同伴)折叠:唯一出处,点开才见。
  $("sync-conninfo-btn").addEventListener("click", () => {
    const info = $("sync-info");
    info.hidden = !info.hidden;
  });
  $("ritual-done").addEventListener("click", () => {
    const typed = ($("ritual-confirm") as HTMLInputElement).value;
    if (normalizeCode(typed) !== normalizeCode(ritualCode)) {
      $("ritual-err").textContent = t("sync.recoveryMismatch");
      return;
    }
    ritualCode = "";
    $("ritual").hidden = true;
    showBar(t("sync.accountCreated"), true);
    resetSecondary(); // 创号完成,收起辅路。
    void deps.refreshSpaces();
    void sinvoke<SyncStatus>("sync_status").then(renderSync).catch(() => {});
  });
  $("sync-create-btn").addEventListener("click", () => void doCreateAccount());
  $("sync-invite-btn").addEventListener("click", () => void doInviteDevice());
  $("sync-pair-copy").addEventListener("click", () => {
    const text = $("sync-pair-copy").dataset.copy ?? "";
    navigator.clipboard.writeText(text).then(
      () => showBar(t("sync.copied"), true),
      () => showError(t("sync.copyFailed")),
    );
  });
  initDevices();
  // 事件桥统一信封的三个同步面监听(过滤谓词 acceptSpaced 经 Deps 注入,账本住 main.ts)。
  void listen<Spaced<SyncStatus>>("sync-status", (e) => {
    if (!deps.acceptSpaced(e.payload)) return;
    // 名册变短 → 一条提示(§5.8 末:「移除很安静」这个真问题的解法是**用透明代替权限**)。
    // 会话内差分、零持久状态、零协议增量。⚠ 手机壳的 acceptSpaced 只放行前台空间的事件,
    // 故这里天然只对当前空间做差分——与桌面「后台空间也报、带空间名」是承载差异,不是判据差异。
    for (const name of rosterDeparted(e.payload.space, e.payload.payload)) {
      showBar(t("devices.departedToast", { name }), true);
    }
    renderSync(e.payload.payload);
  });
  void listen<Spaced<{ received: number; total: number }>>("sync-boot", (e) => {
    if (!deps.acceptSpaced(e.payload)) return;
    const { received, total } = e.payload.payload;
    const pct = total > 0 ? Math.floor((received / total) * 100) : 0;
    ($("sync-boot-fill") as HTMLElement).style.width = `${pct}%`;
    $("sync-boot-text").textContent =
      received >= total
        ? t("sync.snapshotDone", { total: fmtMb(total) })
        : t("sync.snapshotProgress", { received: fmtMb(received), total: fmtMb(total), pct });
  });
  // 邀请方配对进度(phone-space-plan §2.2)。done=注册完成≠对方引导完成(codex r2
  // N4):不自动关出码页,提示等电脑端初始同步完成。
  void listen<Spaced<{ phase: string; detail: string }>>("sync-pair", (e) => {
    if (!deps.acceptSpaced(e.payload)) return;
    const { phase, detail } = e.payload.payload;
    $("sync-pair-note").textContent =
      phase === "done"
        ? t("sync.pairDone", { detail })
        : phase === "failed"
          ? t("sync.pairFailed", { detail })
          : detail;
  });
}
