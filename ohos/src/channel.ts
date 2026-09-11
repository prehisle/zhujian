// 渠道接缝的**国内渠道**那一份(651 立)—— 配套 `android/src/channel.ts`,
// 由 `ohos/vite.config.ts` 的 seam 插件在构建期换进共用那棵树。
// ⛔ 导出名必须与那一份**逐个对得上**(插件会比,少一个当场红)。
//
// 谁走这条渠道:**华为应用市场**上架的那只 HAP。它连的是**境内**同步服务器,
// 一个字节都不出境 —— 这正是 651 改路线的全部意义(9-04 华为驳回里「用户隐私」
// 两条 + 备案一条都指向数据出境这条线)。
//
// ⛔⛔ **这两个值绝不许指回 `zhujian.app`**:那台在境外,而国内版的隐私政策、
// 隐私标签、备案三处都按「不出境」写。填错不会报错,只会让上架时说的话变成假话。

/** 「创建账户」「加入空间」「网络诊断」三处输入框的默认服务器地址。
 *  境内那台 = 118.195.194.64(与备案官网同机),运维见 `ops/zhujian-cool/`。 */
export const SYNC_DEFAULT_URL = "wss://sync.zhujian.cool";

/** 首次启动那道隐私政策告知里的链接 —— 备案站上那份(境内版正文)。 */
export const PRIVACY_URL = "https://zhujian.cool/privacy.html";

/** 与安卓那份同名同形(那边是 `android.json` 里的一条)。 */
export type MobileUpdate = { version: string; versionCode: number; notes: string; url: string };

/**
 * 查更新:**这一端没有更新通道**(668 起从 `platform.ts` 挪来这根轴,原因见
 * `android/src/channel.ts` 头注 —— 有没有自升级是渠道政策不是平台能力)。
 *
 * 鸿蒙自用装机走 `hdc file send` + `bm install`(还绕不过华为 ID 与设备 UDID 白名单,
 * backlog「鸿蒙(HarmonyOS)适配」)⇒ **没有可以比对的清单**,也没有"下载装上"这个动作。
 * ⚠ 返回 null 的语义是「不提示更新」,调用方那边本来就 `catch` 静默 —— 这里给 null
 * 只是让它连一次失败的 IPC 都不发。
 */
export function checkUpdate(): Promise<MobileUpdate | null> {
  return Promise.resolve(null);
}
