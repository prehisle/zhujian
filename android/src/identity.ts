// 设备署名(identity-plan §2/§3,0033)——把条目的 born_device 翻成人能读的名字。
// 桌面同名模块的安卓孪生:显示规则、名册口径、按空间键快照,三件逐条一致。
//
// **显示规则只有一条**(§3.7 + 2026-08-05 用户拍板):
//   出生设备已知 ∧ 不是本机 ∧ 那台**起过别名** → 显别名;其余一律不显。
// 未命名的设备刻意不显 id 片段——卡片上一串 K7M2QX 是噪音,不是信息。这条规则天然
// 涵盖了「单设备账户完全不显示」(本机自己恒被第二个条件挡掉)。
//
// ⚠ 名册口径是**「见过的设备」**,不是「当前在册的设备」:被服务端吊销的设备,它的
// 别名行照样在。这里只做显示,不承担「谁还在册」的判断(那是 §5 移除设备的事)。
import { deviceIdentity } from "./api";
import { t } from "./i18n";

/** 最近一次取回的身份面,**按空间键住**——设备身份是「设备 × 空间」粒度,拿甲空间的
 *  表去翻乙空间的 id 会张冠李戴。切空间后没重取之前一律不认。 */
let snapshot: { space: string; thisDevice: string; alias: Map<string, string> } | null = null;

/** 取一次身份面并落进模块快照。调用方在 `Promise.all` 里与时间轴查询**并发**发起,
 *  不给渲染加一跳延迟。失败**不抛**——署名是装饰,不该让整屏内容陪葬(旧快照保留,
 *  下次刷新再试)。 */
export async function loadIdentity(space: string): Promise<void> {
  try {
    const d = await deviceIdentity(space);
    const alias = new Map<string, string>();
    for (const e of d.devices) if (e.alias) alias.set(e.device_id, e.alias);
    snapshot = { space, thisDevice: d.this_device, alias };
  } catch {
    /* 保留旧快照;署名少显一轮,不影响任何数据 */
  }
}

/** 本机在当前空间的 device_id;快照还没到 = null。 */
export function thisDeviceId(space: string): string | null {
  return snapshot && snapshot.space === space ? snapshot.thisDevice : null;
}

/** 这台设备起过的别名;没起过 / 快照未到 / 空间对不上 = null。设备管理面(devices.ts)
 *  用它把权威名册的 device_id 翻成人话——**它只是显示层的补充**,谁在册由名册说了算
 *  (口径警告见文件头)。与桌面 `src/identity.ts` 的 `aliasOf` 逐字一致。 */
export function aliasOf(space: string, device: string): string | null {
  const s = snapshot;
  if (!s || s.space !== space) return null;
  return s.alias.get(device) ?? null;
}

/** 本机当前别名;没起过 / 快照未到 = null。设置面用它回填输入框。 */
export function myAlias(space: string): string | null {
  const s = snapshot;
  if (!s || s.space !== space) return null;
  return s.alias.get(s.thisDevice) ?? null;
}

/** 留言列表里那条「谁说的」(identity-plan §4.7)。**口径与卡片 chip 刻意不同**:
 *  卡片上的署名是装饰,未命名设备显 id 片段是纯噪音;留言是**逐条的话**,不知道是谁说的
 *  会让多设备账户根本读不懂,所以这里退到设置面那一档——有别名显别名,没别名显 id 前 6 位。
 *
 *  - `born_device` 为 null → 「作者未知」:唯一来源是跨空间搬迁(§4.5,空间=账户=独立库,
 *    源作者身份在目标名册里根本不存在)。**绝不署成当前设备**(§4.14.2 第 5 条);
 *  - 是本机 / 名册还没到手 → null(不显):自己说的话不必落款;名册没到就不猜。
 *
 *  与桌面 `src/identity.ts` 的同名函数逐字一致(两端同一句话得长一样)。 */
export function authorLabel(space: string, bornDevice: string | null | undefined): string | null {
  if (!bornDevice) return t("identity.authorUnknown");
  const s = snapshot;
  if (!s || s.space !== space) return null;
  if (bornDevice === s.thisDevice) return null;
  return s.alias.get(bornDevice) ?? bornDevice.slice(0, 6);
}

/** 这条条目该显的署名文字;null = 不显(未知出生设备 / 就是本机 / 那台没起过别名)。 */
export function signatureFor(space: string, bornDevice: string | null | undefined): string | null {
  if (!bornDevice) return null; // 0033 之前的存量行:未知不猜,也不显「未知设备」
  const s = snapshot;
  if (!s || s.space !== space) return null;
  if (bornDevice === s.thisDevice) return null;
  return s.alias.get(bornDevice) ?? null;
}
