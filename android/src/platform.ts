// **手机端的平台接缝**(OH-d/D3 立)。
//
// 两只手机壳(安卓 / 鸿蒙)**共用这一整棵前端源码树** —— 鸿蒙那边的 vite 直接 root 到
// `android/`,不复制一行(判据:8.5k 行 TS 抄两份,UI 每改一次要改两处,而仓里没有
// 任何一道门禁守得住这种规模的复制)。
//
// 绝大多数模块本来就是端无关的,少数带原生桥的也**天生降级**:
//   · `theme.ts` —— `window.__zhujianSystemBars?.setDark(…)`,桥不在就静默跳过。⭐ **它是这一栏里
//     唯一一个真站得住的**:明暗档本身由 CSS 生效(`<html data-theme>`)⇒ 用户选的那档**真的翻了**,
//     选中态没说谎;缺的只是「系统状态栏图标跟着翻」那一格(⚠ 鸿蒙上确实缺,记在 progress-log 471,
//     ⛔ 别读成"已修");
//   · `saf.ts` —— `hasBridge()` 返 false,备份那一节显式降级(⭐ 说哪一句由 `HAS_SAF_BRIDGE` 定,见下);
//   · `images.ts` —— 走的是 WebView 自己的 `<input type=file>`,压根没有桥。
//
// ⛔ **`textsize.ts` 曾经也被算进"天生降级"那一栏,那是错的**(469 真机逮到,用户面 33):
// 那条桥缺席时,字号那四档**点了会高亮、屏幕上一个像素不动**,冷启后还高亮在你选的那档
// ⇒ **界面在说谎**。⇒ 它不能靠 `?.` 兜,得靠下面的 `HAS_TEXT_ZOOM` 在**构建期**把整节摘掉。
//
// **只有这三样不是** —— 它们是三条 `invoke`,而那三条命令**只在安卓壳里存在**
// (Intent 薄桥的取走端 ×2 + `android.json` 更新检查)。在鸿蒙上调它们会被
// `Command xxx not found` 拒掉,其中 `take_shared_text` 那条的调用点还会
// `showError(...)` ⇒ **每次启动弹一次错**。
//
// ⛔ **刻意不用「运行期探一下是哪个端」那种写法** —— 那是静默兜底(铁律禁);
// ⛔ **也刻意不在鸿蒙壳里加三条恒返回 null 的假命令** —— 「不做」的意思是**入口不存在**,
//    不是"入口在、只是永远不说话"。
// ⇒ 用**构建期**替换:`ohos/vite.config.ts` 把 `./platform` 这个说明符换成
//    `ohos/src/platform.ts`(那一份逐条写明「这一端没有这条路」)。
//    ⭐ 加新的端专属 `invoke` 时,把它加到这个文件里,**别直接写在业务模块里**。
import { invoke } from "@tauri-apps/api/core";
import { cancel, checkPermissions, Format, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";

/** 安卓更新清单里的一条(`android.json` 与 `tauri.conf.json` 同源)。 */
export type MobileUpdate = { version: string; versionCode: number; notes: string; url: string };

// ---- 两条原生窄桥「这一端有没有」(471,用户面 33)-----------------------------------
//
// ⭐ 它们与 `HAS_SCANNER` 同族:**构建期常数,不是运行期探测**。为什么不直接问
// `window.__zhujianXxx` 在不在 —— 那答的是「今天挂上没有」,答不了「这一端**该不该**有」,
// 而这两件事的处置**正好相反**:该有却没有 = 构建坏了(要响亮),本来就没有 = 显式降级。

/**
 * 界面字号那四档(251)靠 WebView 的 textZoom,桥在安卓壳的 `MainActivity.kt`。
 *
 * ⛔ **false 时设置面里那一整节(标题 + 四档 + 说明)不渲染** —— 469 在鸿蒙真机上量到:
 * 桥不在时那四档**点了会高亮、整屏文字逐像素不变、冷启后还高亮着**,是「界面在说谎」。
 * ⇒ 同 `HAS_SCANNER` 的处置:入口**不存在**,而不是"入口在、只是永远不说话"。
 */
export const HAS_TEXT_ZOOM = true;

/**
 * 备份落点那条 SAF 桥(§17.5)在不在这一端。⚠ 与 `saf.hasBridge()` **不是一回事**,
 * 两个一起看才分得开备份那一节该说哪句话:
 *   · `HAS_SAF_BRIDGE=true` 而 `hasBridge()=false` ⇒ **该有却没挂上** = 前端与壳版本不配;
 *   · `HAS_SAF_BRIDGE=false` ⇒ **这一端本来就没有备份这条路**(鸿蒙),说的得是这句。
 */
export const HAS_SAF_BRIDGE = true;

// ---- 系统通知(用户面 39①,截止提醒的手机那半)------------------------------------
//
// 与上面两条同族:**构建期常数**。安卓这端挂的是 `tauri-plugin-notification`
// (壳里 `.plugin(tauri_plugin_notification::init())` + capability `notification:default`);
// 鸿蒙壳里没有这个插件 ⇒ 那一端设置面里「截止提醒」那一整节整个不渲染。
// ⛔ 别改成「留着开关、发不出去时静默」:那正是 469 逮到的「界面在说谎」(用户以为
//    每天会响,而它一声不响),铁律禁静默兜底。

/** 这一端有没有系统通知这条路。false ⇒ 设置面「截止提醒」那一节(标题 + 行 + 说明)整节摘掉。 */
export const HAS_NOTIFICATION = true;

/**
 * 要一次通知权限;拿不到返回 false(调用方负责说人话)。
 *
 * ⚠ **安卓 13+ 的 `POST_NOTIFICATIONS` 是运行期权限**(桌面没有这一格)——插件把
 * `requestPermission()` 映到系统那道对话框上。⇒ 默认开着的提醒**第一次到点时**会弹一次
 * 授权框(而不是启动就弹),那是刻意的:启动就弹 = 用户还没见过这个功能就被要权限。
 * ⚠ 用户按「不允许」两次之后系统不再弹框、恒答 denied —— 那时只能去系统设置里开,
 * 设置面那句人话说的就是这件事。
 */
export async function notifyPermissionOk(): Promise<boolean> {
  if (await isPermissionGranted()) return true;
  return (await requestPermission()) === "granted";
}

/** 发一条系统通知(权限由调用方先过 `notifyPermissionOk`)。 */
export function showNotification(title: string, body: string): void {
  sendNotification({ title, body });
}

/** 系统分享(ACTION_SEND)攒下的文本,取一条走一条;没有了返回 null。 */
export function takeSharedText(): Promise<string | null> {
  return invoke<string | null>("take_shared_text");
}

/** 深链接(ACTION_VIEW 的 `zhujian://`)攒下的 URI;没有返回 null。 */
export function takeDeepLink(): Promise<string | null> {
  return invoke<string | null>("take_deep_link");
}

/** 查更新:有更新回条目、已最新回 null。 */
export function checkUpdate(): Promise<MobileUpdate | null> {
  return invoke<MobileUpdate | null>("check_update");
}

// ---- 扫码配对(107)-----------------------------------------------------------------
//
// ⛔ **鸿蒙那一端没有这条路**,且这不是"还没做":`tauri-plugin-barcode-scanner` 的依赖
// gate 写死在 `target_os = android|ios`,在鸿蒙上**编不过**(ohos/src-tauri/Cargo.toml
// 里那三条"刻意不带"的第①条)。鸿蒙侧配对**走手输码**,加入空间仍走 core 的
// `JoiningSlot`/publish —— 协议一个字不改。
// ⇒ `HAS_SCANNER` 为 false 时,两枚「扫码」按钮**整个不渲染**(⛔ 不是禁用、更不是
//   点了报错:那两种都是「入口在、但说了不算」)。

/** 这一端有没有摄像头扫码。⚠ 它是**构建期常数**,不是运行期探测。 */
export const HAS_SCANNER = true;

/** 要一次相机权限;拿不到返回 false(调用方负责说人话)。 */
export async function ensureCameraPermission(): Promise<boolean> {
  let perm = await checkPermissions();
  if (perm !== "granted" && perm !== "denied") perm = await requestPermissions();
  return perm === "granted";
}

/** 扫一枚二维码,返回它的文本内容。 */
export async function scanQrContent(): Promise<string> {
  const got = await scan({ windowed: true, formats: [Format.QRCode] });
  return got.content;
}

/** 尽力取消一次在飞的扫码(⚠ 部分状态下它 resolve 了但挂着的 `scan()` 不 reject,
 *  故调用方的 UI 收尾**不许等它**——146 真机取证)。 */
export function cancelScan(): Promise<void> {
  return cancel();
}
