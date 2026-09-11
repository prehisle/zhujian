// 渠道接缝(651 立)—— **这份包发给谁**,因而连哪台服务器、隐私政策指哪一份、
// 有没有应用内自升级。
//
// ⛔ **「平台」与「渠道」是两根轴,别合并**:
// · 平台(`platform.ts`)= 这一端有没有那座桥(扫码 / 文本缩放 / SAF / 系统通知);
// · 渠道(本文件)      = 这份包从哪儿发出去、因而受哪套规矩管。
// 判据:安卓将来是**同一个平台、两个渠道**(国内商店 / zhujian.app 官网),
// 平台接缝表达不了它 —— 那正是 651 另开一根轴而不是往 platform.ts 里塞的理由。
//
// 换法与平台接缝**同形**,但这根轴上挂了三份文件:
// · `ohos/vite.config.ts` 的 seam 插件把共用树发出的 `./channel` 改指到
//   `ohos/src/channel.ts`(鸿蒙,恒国内渠道);
// · `android/vite.config.ts` 自己的 seam(668 立)在设了 `ZJ_ANDROID_CHANNEL=cn`
//   时把它改指到 `./channel.cn.ts`(安卓的国内商店渠道包);
// · 不设该变量时安卓就用**这份文件本身**(境外渠道,今天在用的默认路径,零改动)。
// 三份的导出名必须逐个对得上,少一个当场构建期红 —— 否则运行期 `undefined`,
// `vite build` 一声不吭。
//
// 本文件 = **境外渠道**(`zhujian.app` 官网下载的安卓包)。存量用户都在这条渠道上,
// ⛔ 它的值一个都别动 —— 动了就是在替存量设备搬家(用户 2026-09-10 拍板:不迁移)。
//
// ⭐ **668 起 `checkUpdate` 从 `platform.ts` 挪到这根轴**(与 `HAS_SCANNER` 那几条
// 曾经同族)。为什么搬:「有没有应用内自升级」是**店铺政策**不是**设备能力**——国内商店
// 禁自升级,而鸿蒙那端本来就靠 `checkUpdate()` 恒 `null` 让更新条不出现;若再给渠道接缝
// 加一枚 `HAS_SELF_UPDATE` 布尔位,就是同一件事两个开关(「停止扩张线」要防的)。挪过来后
// **一根轴管到底**:哪个渠道禁自升级,让那个渠道自己的 `checkUpdate` 返回 null 即可
// (`channel.cn.ts` 正是这么做的)。
import { invoke } from "@tauri-apps/api/core";

/** 安卓更新清单里的一条(`android.json` 与 `tauri.conf.json` 同源)。 */
export type MobileUpdate = { version: string; versionCode: number; notes: string; url: string };

/** 查更新:有更新回条目、已最新回 null。 */
export function checkUpdate(): Promise<MobileUpdate | null> {
  return invoke<MobileUpdate | null>("check_update");
}

/** 「创建账户」「加入空间」「网络诊断」三处输入框的默认服务器地址。 */
export const SYNC_DEFAULT_URL = "wss://sync.zhujian.app";

/** 首次启动那道隐私政策告知里的链接。⚠ 必须是**活的**页面 —— 审核员和用户都会点它。 */
export const PRIVACY_URL = "https://zhujian.app/privacy.html";
