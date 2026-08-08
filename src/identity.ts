// 设备署名(identity-plan §2/§3,0033)——把条目的 born_device 翻成人能读的名字。
//
// 这个系统里没有「用户」,只有设备(device_id 是「设备 × 空间」粒度)。设备起了别名之后,
// 别的设备记下的条目就能显示一枚小字署名。
//
// **显示规则只有一条**(§3.7 + 2026-08-05 用户拍板):
//   出生设备已知 ∧ 不是本机 ∧ 那台**起过别名** → 显别名;其余一律不显。
// 未命名的设备刻意不显 id 片段——卡片上一串 K7M2QX 是噪音,不是信息。这条规则天然
// 涵盖了「单设备账户完全不显示」(本机自己恒被第二个条件挡掉)。
//
// ⚠ 名册的口径是**「见过的设备」**,不是「当前在册的设备」:被服务端吊销的设备,它的
// 别名行照样在。这里只做显示,不承担「谁还在册」的判断(那是 §5 移除设备的事)。
import { invoke } from "./space";
import "./identity.css";

export type DeviceEntry = { device_id: string; alias: string | null };
type DeviceIdentity = { this_device: string; devices: DeviceEntry[] };

/** 最近一次取回的身份面。**按空间键住**——切空间后没重取之前,旧空间的名册一律不认
 *  (设备身份是「设备 × 空间」粒度,拿甲空间的表去翻乙空间的 id 会张冠李戴)。 */
let snapshot: { space: string; thisDevice: string; alias: Map<string, string> } | null = null;

/** 取一次身份面并落进模块快照。视图在 `Promise.all` 里与列表查询**并发**发起,不给
 *  渲染加一跳延迟(163 那轮的教训:别为一个装饰性的小字拖慢主内容)。 */
export async function loadIdentity(space: string): Promise<void> {
  const d = await invoke<DeviceIdentity>("device_identity");
  const alias = new Map<string, string>();
  for (const e of d.devices) if (e.alias) alias.set(e.device_id, e.alias);
  snapshot = { space, thisDevice: d.this_device, alias };
}

/** 名册的指纹,给视图那道「refocus 重画短路」的判据用(317)。
 *
 *  为什么非有它不可:别台设备改了别名,**列表数据一个字节都没变** —— 变的只有卡上
 *  的署名 chip 与留言层里那行「谁说的」。`sync-changed` 会照常把 refresh 叫醒、
 *  `loadIdentity` 也在同一个 `Promise.all` 里照常重取,可指纹一样就当场 return 了,
 *  DOM 与浮层都不重建,于是要**关掉重开**才更新。留言计数 `cmCounts` 是同一格
 *  (314 已进指纹),这是它的第二例。
 *
 *  空间对不上 / 名册还没到 = 空串:那两种情况下署名一律不显,没有可比的东西。 */
export function identitySig(space: string): string {
  const s = snapshot;
  if (!s || s.space !== space) return "";
  // 自己排一次序再序列化:后端今天是 `ORDER BY device_id`(`identity::device_roster`),
  // 但指纹的稳定性不该挂在别人的排序承诺上——顺序抖一下就是一次无谓的整轮重画。
  const pairs = [...s.alias].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([s.thisDevice, pairs]);
}

/** 本机在当前空间的 device_id;快照还没到 = null。 */
export function thisDeviceId(space: string): string | null {
  return snapshot && snapshot.space === space ? snapshot.thisDevice : null;
}

/** 这条条目该显的署名文字;null = 不显(未知出生设备 / 就是本机 / 那台没起过别名)。 */
export function signatureFor(space: string, bornDevice: string | null | undefined): string | null {
  if (!bornDevice) return null; // 0033 之前的存量行:未知不猜,也不显「未知设备」
  const s = snapshot;
  if (!s || s.space !== space) return null;
  if (bornDevice === s.thisDevice) return null;
  return s.alias.get(bornDevice) ?? null;
}

/** 留言列表里那条「谁说的」(identity-plan §4.7)。**口径与卡片 chip 刻意不同**:
 *  卡片上的署名是装饰,未命名设备显 id 片段是纯噪音;留言列表是逐条的话,不知道
 *  是谁说的会让多设备账户根本读不懂,所以这里退到设置面那一档——有别名显别名,
 *  没别名显 id 前 6 位(同 §2.4)。
 *
 *  - `born_device` 为 null → 「作者未知」:唯一来源是跨空间搬迁(§4.5,空间=账户=
 *    独立库,源作者身份在目标名册里根本不存在)。**绝不署成当前设备**(§4.14.2 第 5 条);
 *  - 是本机 / 名册还没到手 → null(不显):自己说的话不必落款;名册没到就不猜。 */
export function authorLabel(space: string, bornDevice: string | null | undefined): string | null {
  if (!bornDevice) return "作者未知";
  const s = snapshot;
  if (!s || s.space !== space) return null;
  if (bornDevice === s.thisDevice) return null;
  return s.alias.get(bornDevice) ?? bornDevice.slice(0, 6);
}

/** 署名 chip;不该显时返回 null(调用方 `if (n) parent.append(n)`)。 */
export function signatureChip(space: string, bornDevice: string | null | undefined): HTMLElement | null {
  const name = signatureFor(space, bornDevice);
  if (!name) return null;
  const n = document.createElement("span");
  n.className = "sig-chip";
  n.textContent = name;
  n.title = `记于「${name}」`;
  return n;
}
