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
import type { SyncStatus } from "./sync";
import { $, confirmBar, esc, showBar, showError } from "./ui";

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
let pageErr = "";

export function resetDevices(): void {
  open = false;
  expanded = null;
  busy = false;
  refreshing = false;
  pageErr = "";
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
  snap = s;
  if (open) render();
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
  pageErr = "";
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
  pageErr = "";
  render();
  const space = getCurrentSpace();
  void sinvoke<void>("sync_roster_refresh")
    .then(
      () => {
        pageErr = "";
      },
      (e: unknown) => {
        pageErr = String(e);
      },
    )
    .then(() => {
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
      (pageErr ? `<div class="err">${esc(pageErr)}</div>` : "") +
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

  const head = !opsOpen
    ? `<div class="err">${esc(t("devices.noAdmin"))}</div>`
    : adminCount === 1 && roster.length >= 2
      ? `<p class="fine">${esc(t("devices.oneAdminHint"))}</p>`
      : "";

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
        if (expanded !== e.device) {
          return (
            `<button class="dev-row" data-dev="${esc(e.device)}">` +
            `<span class="dev-name">${esc(alias ?? sid)}</span>${badges}` +
            `<span class="dev-sid">${esc(sid)}…</span></button>`
          );
        }
        // 展开态:完整 26 位 + §5.9 那段话 + 操作。⛔ 说明必须在**按下破坏性按钮之前**
        // 就在屏上 —— 底部确认条只活 6 秒,那段话读不完。
        const canDestroy = opsOpen && (isMe || meAdmin);
        const facts = !canDestroy
          ? ""
          : `<ul class="dev-facts">` +
            (isMe
              ? [t("devices.leaveL1"), t("devices.leaveL2"), t("devices.leaveL3")]
              : [
                  t("devices.removeL1"),
                  t("devices.removeL2"),
                  t("devices.removeL3"),
                  t("devices.removeL4"),
                ]
            )
              .map((x) => `<li>${esc(x)}</li>`)
              .join("") +
            `</ul>`;
        let acts = "";
        if (opsOpen) {
          if (isMe) {
            // 任何设备都能移除自己(§5.3 第三句)。⛔ 这里**不判**「会不会把 admins 变空」
            // —— 那是服务器的不变量,客户端复算就是第二份判据。
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
          `<span class="dev-name">${esc(alias ?? sid)}</span>${badges}</button>` +
          `<code class="dev-id">${esc(e.device)}</code>` +
          `<div class="row"><button class="ghost" data-copy="${esc(e.device)}">${esc(t("devices.copyId"))}</button></div>` +
          facts +
          (acts ? `<div class="row">${acts}</div>` : "") +
          `</div>`
        );
      })
      .join("") +
    (pageErr ? `<div class="err">${esc(pageErr)}</div>` : "") +
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
  pageErr = "";
  render();
  const space = getCurrentSpace();
  try {
    await sinvoke<void>("sync_device_admin", { deviceId: device, action });
    if (action === "Remove") noteSelfRemoval(space, device);
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
    pageErr = String(err);
  } finally {
    busy = false;
    if (open) render();
  }
}

/** 挂设备面:入口按钮 + 一处事件委托(行开合 / 复制 / 三个动作 / 刷新)。 */
export function initDevices(): void {
  $("sync-devices-btn").addEventListener("click", toggle);
  $("sync-devices").addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest("[data-act],[data-copy],[data-dev],#dev-refresh");
    if (!(el instanceof HTMLElement)) return;
    if (el.id === "dev-refresh") {
      refresh();
      return;
    }
    const copy = el.dataset.copy;
    if (copy) {
      void navigator.clipboard.writeText(copy).then(
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
