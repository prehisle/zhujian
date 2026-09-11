// 渠道接缝的**安卓 · 国内渠道**那一份(668 立)—— 配套 `android/src/channel.ts`
// (境外渠道,真相源),由 `android/vite.config.ts` 自己的 seam 在设了
// `ZJ_ANDROID_CHANNEL=cn` 时换进共用那棵树。
// ⛔ 导出名必须与 `channel.ts` **逐个对得上**(插件会比,少一个当场红)——
// 与 `ohos/src/channel.ts` 同一份纪律,那份是鸿蒙的国内渠道、这份是安卓的。
//
// 谁走这条渠道:华为应用市场 / 小米 / OPPO / vivo 等**国内安卓商店**上架的那只 APK
// (`node scripts/build-android.mjs --channel-cn` 出)。它连的是**境内**同步服务器,
// 一个字节都不出境,与 `ohos/src/channel.ts` 连的是**同一台**服务器。
//
// ⛔⛔ **这两个值绝不许指回 `zhujian.app`**:那台在境外,而国内版的隐私政策、
// 隐私标签、备案三处都按「不出境」写。填错不会报错,只会让上架时说的话变成假话。

/** 「创建账户」「加入空间」「网络诊断」三处输入框的默认服务器地址。
 *  境内那台 = 118.195.194.64(与备案官网同机),与 ohos 那份逐字同值。 */
export const SYNC_DEFAULT_URL = "wss://sync.zhujian.cool";

/** 首次启动那道隐私政策告知里的链接 —— 备案站上那份(境内版正文)。 */
export const PRIVACY_URL = "https://zhujian.cool/privacy.html";

// ⚠ 这个类型定义与 `channel.ts` / `ohos/src/channel.ts` 逐字重复,**故意不 import**:
// 三份文件的导出名靠 seam 的正则提取比对(只认 `export type NAME = …` 这种直接声明,
// `export type { NAME }` 这种转出写法它读不出来),import 反而会让这条自动核对失灵。
export type MobileUpdate = { version: string; versionCode: number; notes: string; url: string };

/**
 * 查更新:**这条渠道没有应用内自升级**。
 *
 * 国内商店审核规范禁自升级(华为/小米等一致);安卓「真机能力」上其实有更新通道
 * (`channel.ts` 那份走 `check_update` invoke 比对 `android.json`),但**这条渠道不许用**
 * —— 与 `ohos/src/channel.ts` 恒 `null` 同一个理由:有没有自升级是渠道政策,不是设备
 * 能力,不该在这儿另起一个判据。调用方本来就 `catch` 静默,这里给 null 只是让它连一次
 * IPC 都不发。
 */
export function checkUpdate(): Promise<MobileUpdate | null> {
  return Promise.resolve(null);
}
