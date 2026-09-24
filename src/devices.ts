// 设备管理面(identity-plan §5.8/§5.9;367「移除设备」第①笔·片⑤)。
//
// 落点 = 同步面板的一页(§5.8):把「另有 N 台设备在线」升成一张真名单。
//
// **权威只有服务器一份**(§5.2/§5.4):名单是 `SyncStatus.roster`,会话结束即 `null`;
// 本地 `device_profile`(identity.ts)只负责把 device_id 翻成人话,它的口径是「见过的
// 设备」而不是「当前在册的设备」(§2.3)。⛔ `null` 一律当「不知道」——不给操作面、
// 不列名单,绝不折成空数组(§5.16.2-7)。
//
// **判据也只有服务器一份**:这里按「我是不是管理设备」显隐按钮(§5.3 三句话),但
// **不复算「`admins` 不得变空」那条不变量** —— 客户端再写一遍就是第二个判定顺序
// (§5.16.1 末那条 ⛔),让服务器拒、把它的原话如实显出来。
import { currentSpaceId, invokeInSpace } from "./space";
import type { RosterEntry, SyncStatus } from "./space";
import { aliasOf, loadIdentity } from "./identity";
import { t } from "./i18n";
import "./devices.css";
import { elText as el, btn } from "./dom";
import { errLine } from "./err";

/** `sync_device_admin` 的 action:直接用 core `DeviceAction` 的变体名(DTO 同源是
 *  编译期事实,认不出由 serde 当场拒;§5.7-6)。 */
type DeviceAction = "Remove" | "GrantAdmin" | "RevokeAdmin";

/** 短 id 的下限位数。**不是唯一性的要求**(唯一性由 [`shortIds`] 往上加位保证),
 *  只是显示口径的对齐——§2.4 的设置面与 §4.7 的留言署名都用前 6 位。 */
export const SHORT_ID_MIN = 6;

/** 显示用的短 id:对**当前名册**算最短唯一前缀(下限 6 位,最坏退到完整 26 位)。
 *
 *  为什么非它不可(§5.8 ⛔ 那条,设计审一轮 M3 把我原来的修法判成不够):别名是
 *  **账户内任一设备都能改**的 LWW 寄存器(`set_device_alias` 有意不锁本机),一台
 *  手滑或作恶的设备把 A 的别名改成 B 的,就能诱导管理设备移除错的那台;而「一律显
 *  id 前 6 位」同样不够 —— ULID 前部是时间戳,同一时段创建的两台天然可能同前缀,
 *  恶意设备还能挑前缀去撞。唯一前缀是对**当前这份名册**算的,故它恒能把两行分开。 */
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

/** 上一份见过的名单。**零持久状态、零协议增量**:只活在这个模块里,`roster` 回
 *  `null`(会话结束)即整条忘掉,故它绝不会跨会话把过期名单当基线。 */
const lastRoster = new Map<string, { ids: string[]; short: Map<string, string> }>();

/** 本机刚亲手移除掉的设备(`space` + NUL + `device`,写作 `\0`,⛔ 别用字面 NUL —— 那会让整个文件对 ripgrep 隐形,607)。它的消失已经由那条命令的成功回执
 *  报过一次,差分别再报第二遍;一次性消费,会话结束随名单一起清。 */
const selfRemoved = new Set<string>();

const seenKey = (space: string, device: string) => `${space}\0${device}`;

/** 记一笔「这台是本机自己移除的」,供 [`rosterDeparted`] 去重。 */
export function noteSelfRemoval(space: string, device: string): void {
  selfRemoved.add(seenKey(space, device));
}

/** 喂一份新状态,交回「这一拍里消失了的设备」的显示名(通常是空数组)。
 *
 *  三条刻意的空返回:①`roster == null`(会话结束/还没拿到)—— 那不是「有人被移除」,
 *  是「不知道」,同时把基线忘掉;②本会话第一份名单 —— 它是基线不是变化;③消失的是
 *  **本机自己** —— §5.16.1 的明确排除项里有「无『你已被移除』提示」,这条不许悄悄
 *  长回来。 */
export function rosterDeparted(space: string, s: SyncStatus): string[] {
  const roster = s.roster;
  if (!roster) {
    lastRoster.delete(space);
    for (const k of [...selfRemoved]) {
      if (k.startsWith(`${space}\0`)) selfRemoved.delete(k);
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
    const key = seenKey(space, d);
    if (selfRemoved.delete(key)) continue;
    names.push(aliasOf(space, d) ?? prev.short.get(d) ?? d.slice(0, SHORT_ID_MIN));
  }
  return names;
}

// ---- 页面态(全部随面板生灭;开页与关面板各清一次)----

type Pending = { device: string; action: DeviceAction };

let confirming: Pending | null = null;
let expanded: string | null = null;
let busy = false;
let actErr = "";
let refreshing = false;
let refreshErr = "";

export function resetDevicesPage(): void {
  confirming = null;
  expanded = null;
  busy = false;
  actErr = "";
  refreshing = false;
  refreshErr = "";
}

type Deps = {
  /** 当前空间的状态快照(名册的唯一出处)。 */
  status: SyncStatus | null;
  /** 打开这一页那刻的空间;迟到响应按它判弃。 */
  space: string;
  /** 重画整个面板(sync.ts renderPanel)。 */
  rerender: () => void;
  /** 回同步首页。 */
  back: () => void;
  /** 非模态提示条。 */
  toast: (msg: string) => void;
};

/** 进入设备页:清页面态,并按 §5.4 那张表**主动拉一枚名册**(attach 那枚推送允许丢,
 *  故面板不能只等推送)。同轮重取一次身份面——名字要靠它翻,而这一页可能是用户打开
 *  面板后看到的第一屏。 */
export function openDevicesPage(deps: Deps): void {
  resetDevicesPage();
  refreshDevices(deps);
  void loadIdentity(deps.space)
    .then(() => deps.rerender())
    .catch(() => {}); // 别名翻不动只是少个人话名,短 id 照样能唯一定位,不打断这一页
}

/** 拉一枚权威名册。**回执只说成功与否,名单从 `sync_status.roster` 读** —— core 保证
 *  「回执到手时状态面已含本轮」(状态面先写、再结账,§5.7-6)。 */
export function refreshDevices(deps: Deps): void {
  if (refreshing) return;
  refreshing = true;
  refreshErr = "";
  deps.rerender();
  void invokeInSpace(deps.space, "sync_roster_refresh")
    .then(
      () => {
        refreshErr = "";
      },
      (e: unknown) => {
        refreshErr = String(e);
      },
    )
    .then(() => {
      refreshing = false;
      // 空间已切走 = 这一页早被重挂,别把旧空间的结果画到新空间上。
      if (currentSpaceId() === deps.space) deps.rerender();
    });
}

// ---- 渲染 ----

export function renderDevices(body: HTMLElement, deps: Deps): void {
  const s = deps.status;
  const roster = s?.roster ?? null;

  if (!roster) {
    // §5.8 M4:措辞是「尚未确认服务器支持,暂不可用」,**不是**「服务器版本较旧」——
    // 新服务器的 attach 推送同样可能丢,断言版本旧是不诚实的。
    body.appendChild(el("p", "sync-note", refreshing ? t("devices.loading") : t("devices.unavailable")));
    if (refreshErr) body.appendChild(errLine("sync-err dev-refresh-err", refreshErr));
    body.appendChild(footRow(deps, !refreshing));
    return;
  }

  const me = s?.device_id ?? null;
  const meAdmin = roster.some((e) => e.device === me && e.admin);
  const adminCount = roster.filter((e) => e.admin).length;
  // 存量账户还没被运营者点过管理设备:整条用户面 fail-closed(§5.3 不变量的第 3 件),
  // **含自助退出** —— 不变量只说「不得**变**空」,对已经是空的账户约束为零,放行自助
  // 退出就能把账户逐台退到封存(首版自检第 6 条挡下的)。
  const opsOpen = adminCount > 0;
  const short = shortIds(roster.map((e) => e.device));

  if (!opsOpen) body.appendChild(el("div", "sync-warn", t("devices.noAdmin")));
  else {
    // 谁能移除谁,一句说清(用户面 121)—— 行上不显示没权限的按钮是对的,但得有一句
    // 告诉非管理设备「这是权限,不是漏做」。
    body.appendChild(el("p", "sync-note", t("devices.whoCanRemove")));
    if (adminCount === 1 && roster.length >= 2) {
      body.appendChild(el("p", "sync-note", t("devices.oneAdminHint")));
    }
  }

  const list = el("div", "dev-list");
  // 本机置顶,其余按 device_id 升序(与服务端 `ORDER BY device_id` 同序,稳定)。
  const rows = [...roster].sort((a, b) => {
    if ((a.device === me) !== (b.device === me)) return a.device === me ? -1 : 1;
    return a.device < b.device ? -1 : 1;
  });
  for (const e of rows) list.appendChild(deviceRow(e, { deps, me, meAdmin, opsOpen, short }));
  body.appendChild(list);

  // 两条错误分类名:动作失败与「拉名册失败」是两件事,合成一个类名会让「动作真的报错了
  // 没有」这条判据被另一条恒亮的错误背书成绿(假绿同族)。
  if (actErr) body.appendChild(errLine("sync-err dev-act-err", actErr));
  if (refreshErr) body.appendChild(errLine("sync-err dev-refresh-err", refreshErr));
  body.appendChild(footRow(deps, !refreshing));
}

function footRow(deps: Deps, canRefresh: boolean): HTMLElement {
  const acts = el("div", "sync-actions");
  const r = btn(canRefresh ? t("devices.refresh") : t("devices.refreshing"), "hbtn", () =>
    refreshDevices(deps),
  );
  r.disabled = !canRefresh;
  acts.appendChild(r);
  acts.appendChild(btn(t("sync.back"), "hbtn", () => deps.back()));
  return acts;
}

type RowCtx = {
  deps: Deps;
  me: string | null;
  meAdmin: boolean;
  opsOpen: boolean;
  short: Map<string, string>;
};

function deviceRow(e: RosterEntry, ctx: RowCtx): HTMLElement {
  const { deps, me, meAdmin, opsOpen, short } = ctx;
  const sid = short.get(e.device) ?? e.device.slice(0, SHORT_ID_MIN);
  const alias = aliasOf(deps.space, e.device);
  const isMe = e.device === me;

  const row = el("div", "dev-row");
  const head = el("div", "dev-head");
  head.appendChild(el("span", "dev-name", alias ?? sid));
  if (isMe) head.appendChild(el("span", "dev-badge", t("devices.badgeThis")));
  if (e.admin) head.appendChild(el("span", "dev-badge dev-badge--admin", t("devices.badgeAdmin")));
  row.appendChild(head);

  // 唯一定位那一格:短 id 常显,点开是完整 26 位 + 复制(§5.8 ⛔)。
  row.appendChild(idLine(e.device, sid, deps));

  if (confirming?.device === e.device) {
    row.appendChild(confirmBlock(e, ctx));
    return row;
  }

  if (!opsOpen) return row;
  const acts = el("div", "dev-acts");
  if (isMe) {
    // 任何设备都能移除自己(§5.3 第三句)。⛔ 这里**不判**「会不会把 admins 变空」——
    // 那是服务器的不变量,客户端复算就是第二份判据;会拒就让它拒,把原话显出来。
    acts.appendChild(btn(t("devices.leave"), "hbtn dev-danger", () => arm(e.device, "Remove", deps)));
  } else if (meAdmin) {
    acts.appendChild(
      btn(e.admin ? t("devices.revokeAdmin") : t("devices.grantAdmin"), "hbtn", () =>
        arm(e.device, e.admin ? "RevokeAdmin" : "GrantAdmin", deps),
      ),
    );
    acts.appendChild(btn(t("devices.remove"), "hbtn dev-danger", () => arm(e.device, "Remove", deps)));
  }
  // 非管理设备在别人行上一个按钮都不显示(§5.8:没有权限的动作不显示按钮,也不显示灰的)。
  if (acts.childElementCount > 0) row.appendChild(acts);
  return row;
}

function idLine(device: string, sid: string, deps: Deps): HTMLElement {
  const wrap = el("div", "dev-idline");
  const open = expanded === device;
  const b = btn(open ? device : `${sid}…`, "dev-id", () => {
    expanded = open ? null : device;
    deps.rerender();
  });
  b.title = open ? t("devices.idCollapse") : t("devices.idExpand");
  wrap.appendChild(b);
  if (open) {
    wrap.appendChild(
      btn(t("devices.copyId"), "hbtn dev-copy", () => {
        void navigator.clipboard.writeText(device).then(
          () => deps.toast(t("devices.idCopied")),
          () => deps.toast(t("devices.copyFailed")),
        );
      }),
    );
  }
  return wrap;
}

function arm(device: string, action: DeviceAction, deps: Deps): void {
  confirming = { device, action };
  actErr = "";
  deps.rerender();
}

/** 第二拍的宿主。破坏性那两支要把 §5.9 的话讲全 —— **一句都不能省**。 */
function confirmBlock(e: RosterEntry, ctx: RowCtx): HTMLElement {
  const { deps, short } = ctx;
  const action = confirming?.action ?? "Remove";
  const sid = short.get(e.device) ?? e.device.slice(0, SHORT_ID_MIN);
  const name = aliasOf(deps.space, e.device) ?? sid;
  const isMe = e.device === (ctx.me ?? "");

  const box = el("div", "dev-confirm");
  const q =
    action === "Remove"
      ? isMe
        ? t("devices.leaveQ")
        : t("devices.removeQ", { name })
      : action === "GrantAdmin"
        ? t("devices.grantQ", { name })
        : t("devices.revokeQ", { name });
  box.appendChild(el("div", "dev-confirm-q", q));
  // 完整 26 位随确认面一起给:别名是可被别的设备改的,只有它能唯一定位那台设备。
  box.appendChild(el("div", "dev-confirm-id", e.device));

  const lines =
    action === "Remove"
      ? isMe
        ? [t("devices.leaveL1"), t("devices.leaveL2"), t("devices.leaveL3")]
        : [t("devices.removeL1"), t("devices.removeL2"), t("devices.removeL3"), t("devices.removeL4")]
      : action === "GrantAdmin"
        ? [t("devices.grantL1")]
        : [t("devices.revokeL1")];
  const ul = el("ul", "dev-confirm-list");
  for (const line of lines) ul.appendChild(el("li", "", line));
  box.appendChild(ul);

  const acts = el("div", "dev-acts");
  const yes = btn(
    action === "Remove" ? (isMe ? t("devices.leaveYes") : t("devices.removeYes")) : t("devices.ok"),
    "hbtn dev-danger",
    () => void commit(e.device, action, deps),
  );
  yes.disabled = busy;
  acts.appendChild(yes);
  const no = btn(t("devices.cancel"), "hbtn", () => {
    confirming = null;
    deps.rerender();
  });
  no.disabled = busy;
  acts.appendChild(no);
  box.appendChild(acts);
  return box;
}

async function commit(device: string, action: DeviceAction, deps: Deps): Promise<void> {
  if (busy) return;
  busy = true;
  actErr = "";
  deps.rerender();
  const name = aliasOf(deps.space, device) ?? device.slice(0, SHORT_ID_MIN);
  try {
    // 必落账写命令走 invokeInSpace(响应恒到达),空间是否切走由这里自己判 —— 统一
    // 包装的「永不决议」会让 busy 永久锁死(118 教训第三踩)。
    await invokeInSpace(deps.space, "sync_device_admin", { deviceId: device, action });
    if (action === "Remove") noteSelfRemoval(deps.space, device);
    confirming = null;
    deps.toast(
      action === "Remove"
        ? device === deps.status?.device_id
          ? t("devices.leftToast")
          : t("devices.removedToast", { name })
        : action === "GrantAdmin"
          ? t("devices.grantedToast", { name })
          : t("devices.revokedToast", { name }),
    );
  } catch (err) {
    // 服务器的原话如实显出来 —— 不变量、限频、H-ABA 都在这条通道上回话,客户端
    // 复述它们等于再写一份判据。断连那句尤其不许改写(命令**可能已经执行了**)。
    actErr = String(err);
  } finally {
    busy = false;
    if (currentSpaceId() === deps.space) deps.rerender();
  }
}
