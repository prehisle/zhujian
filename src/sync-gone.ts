// 「这台已不在这个账户里」(161 / W4 Q12 ★① 桌面那半;A37 / A39 / A40 的桌面对应)。
//
// 被移出账户 / 账户被停用 / 自己退出之后,此前同步浮层照旧写「离线,重连中…」+ 一行「不认这台设备了」、「添加设备」
// 与「设备名单」照旧 —— 看着和断网一模一样,人会一直以为「等等就好」接着记,然后为了连回去点「重置」把这几条删掉。
// ⇒ 换成明说的状态(同步浮层 / 随记页顶 / 侧栏 / 空间菜单那一行)。
// ⛔ **只改说法与入口,不碰同步客户端**:后台照旧重试(封禁解了还能自己回来,回来那一刻这里自己收),不退回「未开启」。
//
// 本机账本与手机**同键同语义**(android/src/sync.ts 那份;localStorage `zhujian.sync-gone`,按空间,连同当时的设备身份):
//  · `left`    = 本机自己点了「退出账户」、服务器回执成了(devices.ts commit 那一下记的,客户端知道);
//  · `revoked` = 服务器拒了这台(core `AUTH_FAILED`「账户被封禁,或本设备未注册/已吊销」那一句 —— 分不出是被移除还是被封禁,
//               两样一起写,⛔ 别猜)。
// 收掉的三条路:服务器又收了这台(在线 / 初始同步;只收 revoked 那形)、这一本换了身份(重置后重新加入)、这一本不再配同步。
// ⚠ 桌面每个空间都常驻着传输任务(状态全是活的),故按空间逐份对账,⛔ 不只对当前空间。
import type { SyncStatus } from "./space";
import { isRevoked } from "./err";

export type GoneWhy = "left" | "revoked";
type GoneBook = Record<string, { device: string; why: GoneWhy }>;
const GONE_KEY = "zhujian.sync-gone";

function readGone(): GoneBook {
  const raw = localStorage.getItem(GONE_KEY);
  if (raw === null) return {};
  const o = JSON.parse(raw) as GoneBook;
  if (typeof o !== "object" || o === null) throw new Error(`本机记的「已不在账户里」账坏了:${raw}`);
  return o;
}

function writeGone(o: GoneBook): void {
  if (Object.keys(o).length === 0) localStorage.removeItem(GONE_KEY);
  else localStorage.setItem(GONE_KEY, JSON.stringify(o));
}

const listeners = new Set<() => void>();

/** 任一空间的「已不在账户里」那一档变了就叫一声(随记页顶那条、侧栏、空间菜单跟着重画)。返回退订。 */
export function onGoneChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function changed(): void {
  for (const cb of [...listeners]) cb();
}

/** 本机刚退出了 `space` 的账户(devices.ts 在服务器回执成功那一刻调)。 */
export function markLeft(space: string, device: string): void {
  const o = readGone();
  o[space] = { device, why: "left" };
  writeGone(o);
  changed();
}

/** 这一本被重置了(本机数据删光 / 回到没开同步):它的账作废。 */
export function forgetGone(space: string): void {
  const o = readGone();
  if (!(space in o)) return;
  delete o[space];
  writeGone(o);
  changed();
}

/** 空间列表刚重拉过:已经不在的那几本(重置掉 / 删掉的)从账上划掉,别让死账一直攒着。 */
export function pruneGone(liveIds: string[]): void {
  const o = readGone();
  const live = new Set(liveIds);
  let dirty = false;
  for (const k of Object.keys(o)) {
    if (!live.has(k)) {
      delete o[k];
      dirty = true;
    }
  }
  if (dirty) {
    writeGone(o);
    changed();
  }
}

/** 这一本现在算不算「已不在账户里」;`null` = 不是(账上的,不现对状态 —— 对账走 `settleGone`)。 */
export function goneOf(space: string): GoneWhy | null {
  return readGone()[space]?.why ?? null;
}

/** 照这一份状态对一遍 `space` 的账,交回它现在算不算「已不在账户里」。逻辑与手机 `settleGone` 逐条同。 */
export function settleGone(space: string, s: SyncStatus): GoneWhy | null {
  const o = readGone();
  const had = o[space];
  let cur: GoneBook[string] | undefined = had;
  if (!s.configured) cur = undefined;
  else if (cur && s.device_id !== null && cur.device !== s.device_id) cur = undefined;
  // 服务器又收了这台(在线 / 初始同步)⇒ 被拒那一形收掉(封禁解了)。⚠ 自己退出的那一形**不**因此收:服务器回执「已退出」
  // 之后那条会话还要在线一小会儿才收场(手机真机量过约 1 秒),这一拍要是把账清了,接着鉴权被拒就会记成「被移出」。
  else if (cur?.why === "revoked" && (s.state === "online" || s.state === "booting")) cur = undefined;
  if (!cur && s.configured && s.device_id !== null && s.error !== null && isRevoked(s.error)) {
    cur = { device: s.device_id, why: "revoked" };
  }
  if (cur !== had) {
    if (cur) o[space] = cur;
    else delete o[space];
    writeGone(o);
    changed();
  }
  return cur ? cur.why : null;
}
