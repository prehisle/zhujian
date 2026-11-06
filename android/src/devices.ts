// 设备管理面(identity-plan §5.8/§5.9;367「移除设备」第①笔·片⑤)——桌面
// `src/devices.ts` 的安卓孪生。
//
// **权威只有服务器一份**(§5.2/§5.4):名单是 `SyncStatus.roster`,会话结束即 `null`;
// 本地 `device_profile`(identity.ts)只负责把 device_id 翻成人话。⛔ `null` 一律当
// 「不知道」——不给操作面、不列名单,绝不折成空数组(§5.16.2-7)。
//
// **判据也只有服务器一份**:按「我是不是管理设备」显隐按钮(§5.3 三句话),但**不复算
// 「`admins` 不得变空」那条不变量** —— 客户端再写一遍就是第二个判定顺序,让服务器拒、
// 把它的原话如实显出来。
//
// ⚠ **端间刻意两处不同**(§4.7 那条记档纪律的第二例):
//  1. 桌面一行摊开(名字 + 短 id + 操作 + 行内确认);手机一行**先收起**,点开才见完整
//     ID、说明与操作 —— 竖屏宽度摆不下,而「说明」恰恰是本案最不能省的东西。
//  2. 破坏性第二拍走**底部固定确认条**(316 的安卓全局约定),故 §5.9 那段话在**点开
//     那一刻就在屏上**,不塞进只活 6 秒的确认条里 —— 那段话读不完 6 秒。
import { getCurrentSpace, sinvoke } from "./api";
import { aliasOf, loadIdentity } from "./identity";
import { t } from "./i18n";
import { writeClipboard } from "./platform";
import { markLeft, type SyncStatus } from "./sync";
import { $, confirmBar, esc, showBar, showError } from "./ui";
import { errHtml, isBusy } from "./err";

/** `sync_device_admin` 的 action(core `DeviceAction` 的变体名,认不出由 serde 当场拒)。 */
type DeviceAction = "Remove" | "GrantAdmin" | "RevokeAdmin";

/** 短 id 的下限位数;与桌面 `SHORT_ID_MIN` 同值(显示口径对齐 §2.4 / §4.7 的前 6 位)。 */
export const SHORT_ID_MIN = 6;

/** 显示用的短 id:对**当前名册**算最短唯一前缀(下限 6 位,最坏退到完整 26 位)。
 *  与桌面 `shortIds` 逐字一致 —— 别名是账户内任一设备都能改的 LWW 寄存器,而 ULID
 *  前部是时间戳(同时段创建的两台天然可能同前缀),两者都定位不了「是哪台」。 */
export function shortIds(ids: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    let n = SHORT_ID_MIN;
    while (n < id.length && ids.some((o) => o !== id && o.slice(0, n) === id.slice(0, n))) n++;
    out.set(id, id.slice(0, n));
  }
  return out;
}

// ---- 会话内名册差分(§5.8 末:「移除很安静」的解法是**用透明代替权限**)----

const lastRoster = new Map<string, { ids: string[]; short: Map<string, string> }>();
const selfRemoved = new Set<string>();
const seenKey = (space: string, device: string) => `${space} ${device}`;

export function noteSelfRemoval(space: string, device: string): void {
  selfRemoved.add(seenKey(space, device));
}

/** 喂一份新状态,交回「这一拍里消失了的设备」的显示名。三条刻意的空返回与桌面一致:
 *  `roster == null`(不知道,顺手忘掉基线)/ 本会话第一份(基线不是变化)/ 消失的是
 *  **本机自己**(§5.16.1 明确排除项:无「你已被移除」提示)。 */
export function rosterDeparted(space: string, s: SyncStatus): string[] {
  const roster = s.roster;
  if (!roster) {
    lastRoster.delete(space);
    for (const k of [...selfRemoved]) {
      if (k.startsWith(`${space} `)) selfRemoved.delete(k);
    }
    return [];
  }
  const ids = roster.map((e) => e.device);
  const prev = lastRoster.get(space);
  lastRoster.set(space, { ids, short: shortIds(ids) });
  if (!prev) return [];
  const now = new Set(ids);
  const names: string[] = [];
  for (const d of prev.ids) {
    if (now.has(d) || d === s.device_id) continue;
    if (selfRemoved.delete(seenKey(space, d))) continue;
    names.push(aliasOf(space, d) ?? prev.short.get(d) ?? d.slice(0, SHORT_ID_MIN));
  }
  return names;
}

// ---- 页面态(随面板生灭)----

/** 最近一次状态快照:名册的唯一出处。切空间 / 关面即由 [`resetDevices`] 清掉。 */
let snap: SyncStatus | null = null;
let open = false;
let expanded: string | null = null;
let busy = false;
let refreshing = false;
// 存的是 `errHtml` 出来的**已转义** HTML(用户面 126:「连不上」那句后面带一枚「网络自检」)。
let pageErr = "";
/** 写下 `pageErr` 那一刻的连接状态(161 / W4 A33,互配新撞-6):状态一变(断网时留下的「未连接服务器」、重新在线了)
 *  那句就过时了 —— 收掉,别挂着说过时的话。 */
let pageErrState: string | null = null;
/** 上一次「刷新」真从服务器取到名单的时刻(A14,互配新撞-4):服务器 5 秒内只答一次名单
 *  (`ROSTER_REQ_MIN_GAP_SECS`),连点两下第二下被说成「服务器繁忙」。5 秒内再点只重读名字、不去催服务器。 */
let lastRosterAt = 0;
const ROSTER_GAP_MS = 5_000;

function setPageErr(html: string): void {
  pageErr = html;
  pageErrState = html === "" ? null : (snap?.state ?? null);
}

export function resetDevices(): void {
  open = false;
  expanded = null;
  busy = false;
  refreshing = false;
  setPageErr("");
  snap = null;
  // ⛔ 差分基线也一起忘掉。手机壳的事件桥**只放行前台空间**(acceptSpaced),故切走
  // 期间那个空间的 `roster: null`(会话结束)根本不会经过 `rosterDeparted` —— 基线因此
  // 可能活过一次会话边界,回来时把「上个会话的名单」当基线,凭空报一条移除。清掉之后
  // 最坏只是**少报**(下一份名单重新当基线),那个方向是安全的。桌面没有这一格:它的
  // 状态监听对全部空间都跑差分,null 事件照样收得到。
  lastRoster.clear();
  selfRemoved.clear();
  $("sync-devices").hidden = true;
}

/** 同步面每收一份新状态就喂一次(renderSync 里调):名册变了当场重画那一块。 */
export function feedDevices(s: SyncStatus): void {
  // A33:连没连上变了(跨过「已连接」那条线),上一次留在名单下面的那句话说的就不是现在了。
  // ⚠ 只认跨线:断开期间状态在「离线 ↔ 连接中」之间每隔几秒来回一次,跟着它收,那句话刚冒出来就没了。
  if (pageErr !== "" && s.state !== pageErrState && (s.state === "online" || pageErrState === "online")) setPageErr("");
  snap = s;
  if (open) render();
}

/** 设备名字(身份面那份快照)刚重读过:名单开着就当场重画(161 / W4 A14,WM-03 / WP-12:另一台改了别名,
 *  随记卡上的来源十几秒就换了,开着的名单却还是编号 —— 名字一直是对的,只是名单没重画)。 */
export function repaintDevices(): void {
  if (open) render();
}

/** 当前空间名册里的全部 device_id(没有 = 不知道)。设置里别名框的占位要和名单显示的编号位数一致(A30)。 */
export function rosterIds(): string[] | null {
  return snap?.roster?.map((e) => e.device) ?? null;
}

/** 收起设备名单(同步面收起那一行时用,161 / W4 Q12:已不在账户里时整行不给;收着的账要和屏上一致,
 *  否则那一行回来时第一下点是「收」、像没反应)。差分基线不动 —— 那是会话的事,不是面板的事。 */
export function closeDevicesPanel(): void {
  open = false;
  expanded = null;
  $("sync-devices").hidden = true;
}

function toggle(): void {
  if (open) {
    open = false;
    $("sync-devices").hidden = true;
    return;
  }
  openDevicesPanel();
}

/** 展开设备面并拉一枚权威名册(§5.4 那张表第二行)。除了入口按钮,「席位已满」那条
 *  错误也走这里 —— 那句话要求「请先移除一台不用的设备」,得让人点得到地方(§5.8 末)。 */
export function openDevicesPanel(): void {
  open = true;
  $("sync-devices").hidden = false;
  expanded = null;
  setPageErr("");
  render();
  refresh();
  // 名字要靠身份面翻;失败不打断这一页(短 id 照样能唯一定位)。
  void loadIdentity(getCurrentSpace()).then(() => {
    if (open) render();
  });
}

/** 拉一枚权威名册(§5.4 那张表第二行:面板打开时拉一枚)。**回执只说成功与否,名单
 *  从 `sync_status.roster` 读** —— core 保证「回执到手时状态面已含本轮」。 */
function refresh(): void {
  if (refreshing) return;
  refreshing = true;
  setPageErr("");
  render();
  const space = getCurrentSpace();
  // A14:名字住身份面(不在名册里),「刷新」此前只拉名册 ⇒ 改了自己的别名点「刷新」还是旧名。两样一起重读。
  const names = loadIdentity(space);
  // 5 秒内刚取过名单、且手上那份还在(连着)就不去催服务器(它会答「繁忙」);名单本身每份状态都在推,几秒前那份就是现在的。
  // ⚠ 手上没有名单(断开了)时照常去问 —— 让它把「没连上」那句如实说出来,别一声不响。
  const roster =
    Date.now() - lastRosterAt < ROSTER_GAP_MS && (snap?.roster ?? null) !== null
      ? Promise.resolve()
      : sinvoke<void>("sync_roster_refresh").then(
          () => {
            lastRosterAt = Date.now();
          },
          (e: unknown) => {
            // 撞上服务器那道 5 秒闸(core 的周期取名单也算在里头)= 名单几秒前刚取过,不是出错。
            if (!isBusy(e)) setPageErr(errHtml(e));
          },
        );
  void Promise.all([names, roster]).then(() => {
    refreshing = false;
    // 空间切走 = 这一页已经不属于当前空间了(sinvoke 那侧已判弃迟到响应,这里只挡渲染)。
    if (open && getCurrentSpace() === space) render();
  });
}

// ---- 渲染(安卓侧全程 innerHTML + 事件委托,与本工程既有面一致)----

function render(): void {
  const box = $("sync-devices");
  const s = snap;
  const roster = s?.roster ?? null;
  if (!roster) {
    // §5.8 M4:「尚未确认服务器支持,暂不可用」,**不是**「服务器版本较旧」—— 新服务器
    // 的 attach 推送同样可能丢,断言版本旧是不诚实的。
    box.innerHTML =
      `<p class="fine">${esc(refreshing ? t("devices.loading") : t("devices.unavailable"))}</p>` +
      (pageErr ? `<div class="err">${pageErr}</div>` : "") +
      refreshRow();
    return;
  }
  const me = s?.device_id ?? null;
  const meAdmin = roster.some((e) => e.device === me && e.admin);
  const adminCount = roster.filter((e) => e.admin).length;
  // 存量账户还没被运营者点过管理设备:整条用户面 fail-closed(§5.3 不变量第 3 件),
  // **含自助退出** —— 不变量只说「不得**变**空」,对已经空的账户约束为零。
  const opsOpen = adminCount > 0;
  const short = shortIds(roster.map((e) => e.device));
  const rows = [...roster].sort((a, b) => {
    if ((a.device === me) !== (b.device === me)) return a.device === me ? -1 : 1;
    return a.device < b.device ? -1 : 1;
  });

  // 谁能移除谁,一句说清(用户面 121)—— 行上不显示没权限的按钮是对的,但得告诉非管理
  // 设备「这是权限,不是漏做」。
  // 161 / W4 A49(WP-08 后半):「建议再设一台管理设备,万一这台丢了」只对管理设备说 —— 别的设备设不了,「这台」也说不清指谁。
  const head = !opsOpen
    ? `<div class="err">${esc(t("devices.noAdmin"))}</div>`
    : `<p class="fine">${esc(t("devices.whoCanRemove"))}</p>` +
      (meAdmin && adminCount === 1 && roster.length >= 2
        ? `<p class="fine">${esc(t("devices.oneAdminHint"))}</p>`
        : "");

  box.innerHTML =
    head +
    rows
      .map((e) => {
        const sid = short.get(e.device) ?? e.device.slice(0, SHORT_ID_MIN);
        const alias = aliasOf(getCurrentSpace(), e.device);
        const isMe = e.device === me;
        const badges =
          (isMe ? `<span class="dev-badge">${esc(t("devices.badgeThis"))}</span>` : "") +
          (e.admin ? `<span class="dev-badge admin">${esc(t("devices.badgeAdmin"))}</span>` : "");
        // 161 / W4 A30(WM-22 / WP-15):没起名的那行,名字那格就是编号(等宽)—— 此前右边灰字再写一遍;
        // 起过名的照旧右边灰字带编号(名字可被任一设备改写,编号才定得死是哪台)。
        // Q16(WP-15 后半):没起名的那行下面一句去哪儿起名(本机 / 那台,说法不同)。
        const nameCell = alias
          ? `<span class="dev-name">${esc(alias)}</span>`
          : `<span class="dev-name mono">${esc(sid)}</span>`;
        const unnamedHint = alias
          ? ""
          : `<span class="dev-hint">${esc(isMe ? t("devices.unnamedHintSelf") : t("devices.unnamedHint"))}</span>`;
        if (expanded !== e.device) {
          return (
            `<button class="dev-row" data-dev="${esc(e.device)}">` +
            `${nameCell}${badges}<span class="dev-end">` +
            (alias ? `<span class="dev-sid">${esc(sid)}…</span>` : "") +
            // A49(WP-08 后半):收着的行看得出能点开。
            `<span class="dev-chev" aria-hidden="true"></span></span>${unnamedHint}</button>`
          );
        }
        // 展开态:完整 26 位 + §5.9 那段话 + 操作。⛔ 说明必须在**按下破坏性按钮之前**
        // 就在屏上 —— 底部确认条只活 6 秒,那段话读不完。
        // 161 / W4 A7 = Q7 ★①(WM-08 / WP-20):只剩本机这一台管理设备时不给「退出账户」—— 换成一行灰字说为什么、怎么办。
        // ⚠ 只按名单里已有的「管理」徽章在本机判(不复算服务器的不变量,服务器那条「至少留一台」照旧兜底);
        // 此前是先给钮、点了确认才被拒,拒绝那句还常驻插在名单里。
        const lastAdmin = isMe && e.admin && adminCount === 1;
        const canDestroy = opsOpen && !lastAdmin && (isMe || meAdmin);
        const facts = !canDestroy
          ? ""
          : `<ul class="dev-facts">` +
            (isMe
              ? [t("devices.leaveL1"), t("devices.leaveL2"), t("devices.leaveL3")]
              : [
                  t("devices.removeL1"),
                  t("devices.removeL2"),
                  // 161 / W4 A38(WP-02):指南「一句不省」的第三条此前漏了 —— 丢了手机去移除的人会以为这就安全了(桌面同修)。
                  t("devices.removeKeys"),
                  t("devices.removeL3"),
                  t("devices.removeL4"),
                ]
            )
              .map((x) => `<li>${esc(x)}</li>`)
              .join("") +
            `</ul>` +
            // A38:「想彻底隔离,移除不够」要指到能做的事 —— 只能重置整个账户,那条路走写信;一枚「意见反馈」开设置、滚到那一节。
            (isMe
              ? ""
              : `<p class="fine dev-isolate">${esc(t("devices.removeIsolate"))} ` +
                `<button type="button" class="inline-link" data-feedback>${esc(t("devices.removeIsolateGo"))}</button></p>`);
        let acts = "";
        if (opsOpen) {
          if (isMe && lastAdmin) {
            acts = "";
          } else if (isMe) {
            // 任何设备都能移除自己(§5.3 第三句)。唯一一台管理设备那一形上面已经换成灰字(A7);
            // 别的情形(比如还有别的管理设备)照旧由服务器裁决 —— ⛔ 不在这儿复算「会不会把 admins 变空」。
            acts = `<button class="danger" data-act="Remove" data-dev="${esc(e.device)}">${esc(t("devices.leave"))}</button>`;
          } else if (meAdmin) {
            const g = e.admin ? "RevokeAdmin" : "GrantAdmin";
            acts =
              `<button class="ghost" data-act="${g}" data-dev="${esc(e.device)}">${esc(e.admin ? t("devices.revokeAdmin") : t("devices.grantAdmin"))}</button>` +
              `<button class="danger" data-act="Remove" data-dev="${esc(e.device)}">${esc(t("devices.remove"))}</button>`;
          }
          // 非管理设备在别人行上一个按钮都不显示(§5.8:不显示按钮,也不显示灰的)。
        }
        return (
          `<div class="dev-row open">` +
          `<button class="dev-head" data-dev="${esc(e.device)}">` +
          `${nameCell}${badges}<span class="dev-end"><span class="dev-chev" aria-hidden="true"></span></span></button>` +
          `<code class="dev-id">${esc(e.device)}</code>` +
          `<div class="row"><button class="ghost" data-copy="${esc(e.device)}">${esc(t("devices.copyId"))}</button></div>` +
          (alias ? "" : `<p class="dev-note">${esc(isMe ? t("devices.unnamedHintSelf") : t("devices.unnamedHint"))}</p>`) +
          facts +
          (acts ? `<div class="row">${acts}</div>` : "") +
          (lastAdmin && opsOpen ? `<p class="dev-note">${esc(t("devices.lastAdminNoLeave"))}</p>` : "") +
          `</div>`
        );
      })
      .join("") +
    (pageErr ? `<div class="err">${pageErr}</div>` : "") +
    refreshRow();
}

function refreshRow(): string {
  const label = refreshing ? t("devices.refreshing") : t("devices.refresh");
  return `<div class="row"><button class="ghost" id="dev-refresh"${refreshing || busy ? " disabled" : ""}>${esc(label)}</button></div>`;
}

// ---- 动作 ----

function arm(device: string, action: DeviceAction): void {
  const s = snap;
  const roster = s?.roster ?? null;
  if (!roster || busy) return;
  const short = shortIds(roster.map((e) => e.device));
  const sid = short.get(device) ?? device.slice(0, SHORT_ID_MIN);
  const name = aliasOf(getCurrentSpace(), device) ?? sid;
  const isMe = device === s?.device_id;
  // 第二拍走底部固定确认条(316 的安卓全局约定)。破坏性那两支的说明已经在屏上,
  // 条上只留「是哪一台」;授权那支的说明短,直接进问句 —— 它必须把授出去的权力说明白。
  const q =
    action === "Remove"
      ? isMe
        ? t("devices.leaveQ")
        : t("devices.removeQ", { name })
      : action === "GrantAdmin"
        ? `${t("devices.grantQ", { name })}${t("devices.grantL1")}`
        : `${t("devices.revokeQ", { name })}${t("devices.revokeL1")}`;
  const yes =
    action === "Remove" ? (isMe ? t("devices.leaveYes") : t("devices.removeYes")) : t("devices.ok");
  confirmBar(q, yes, () => void commit(device, action, name));
}

async function commit(device: string, action: DeviceAction, name: string): Promise<void> {
  if (busy) return;
  busy = true;
  setPageErr("");
  render();
  const space = getCurrentSpace();
  try {
    await sinvoke<void>("sync_device_admin", { deviceId: device, action });
    if (action === "Remove") noteSelfRemoval(space, device);
    // 161 / W4 Q12(A39):本机自己退出的 —— 客户端知道,记一笔;同步面据此说「你已退出这个账户」(不是「被踢了」)。
    if (action === "Remove" && device === snap?.device_id) markLeft(space, device);
    expanded = null;
    showBar(
      action === "Remove"
        ? device === snap?.device_id
          ? t("devices.leftToast")
          : t("devices.removedToast", { name })
        : action === "GrantAdmin"
          ? t("devices.grantedToast", { name })
          : t("devices.revokedToast", { name }),
      true,
    );
  } catch (err) {
    // 服务器的原话如实显出来 —— 不变量、限频、H-ABA 都在这条通道上回话;断连那句尤其
    // 不许改写(命令**可能已经在服务器上执行了**,UI 的义务是以新名册为准而不是重试)。
    // ⚠ 刻意**不**走全局 showError:那条提示条几秒就走,而这几句话是要读完的;它就落在
    // 刚动过手的那张名单下面,留到下一次动作为止。
    setPageErr(errHtml(err));
  } finally {
    busy = false;
    if (open) render();
  }
}

/** 挂设备面:入口按钮 + 一处事件委托(行开合 / 复制 / 三个动作 / 刷新)。 */
/** `openFeedback` = 开设置面、滚到「意见反馈」那一节(main 的 openSubPane 住那边;移除确认里那枚 A38)。 */
export function initDevices(openFeedback: () => void): void {
  $("sync-devices-btn").addEventListener("click", toggle);
  $("sync-devices").addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest("[data-act],[data-copy],[data-dev],[data-feedback],#dev-refresh");
    if (!(el instanceof HTMLElement)) return;
    if (el.hasAttribute("data-feedback")) {
      openFeedback();
      return;
    }
    if (el.id === "dev-refresh") {
      refresh();
      return;
    }
    const copy = el.dataset.copy;
    if (copy) {
      // 696:改走平台接缝 —— 安卓 WebView 的 `navigator.clipboard` 恒拒(判据在 platform.ts)。
      void writeClipboard(copy).then(
        () => showBar(t("devices.idCopied"), true),
        () => showError(t("devices.copyFailed")),
      );
      return;
    }
    const dev = el.dataset.dev;
    if (!dev) return;
    const act = el.dataset.act;
    if (act) {
      arm(dev, act as DeviceAction);
      return;
    }
    expanded = expanded === dev ? null : dev;
    render();
  });
}
