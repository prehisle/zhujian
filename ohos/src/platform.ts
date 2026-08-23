// **鸿蒙那一份平台接缝**(OH-d/D3)。与 `android/src/platform.ts` 同一个导出面 ——
// 那一份是真实现,这一份逐条写明「这一端没有这条路」。
//
// ⭐ **它是怎么被用上的**:`ohos/vite.config.ts` 里一个 resolve 插件,把从
// `android/src/**` 发出的 `./platform` 说明符改指到本文件。⇒ 产品前端那 8.5k 行 TS
// **一份源码两端共用**,零复制。
//
// ⛔ **这里的每一条都不许"看起来能用"**:返回 null 的两条是**真的没有待取的东西**
// (这一端根本没有系统分享 / 深链接那两条入口),不是"暂时取不到";
// `HAS_SCANNER = false` 会让两枚扫码按钮**整个不渲染**,而不是渲染出来点了报错。
//
// ⚠ 将来真给鸿蒙接上其中某一条时,**改的是这个文件**,不是去业务模块里加 if。

/** 与安卓那份同名同形(那边是 `android.json` 里的一条)。这一端恒不产生它。 */
export type MobileUpdate = { version: string; versionCode: number; notes: string; url: string };

// ---- 两条原生窄桥:这一端一条都没有(471,用户面 33)---------------------------------
//
// 三条窄桥全长在安卓壳的 `MainActivity.kt` 上(`__zhujianSystemBars` / `__zhujianTextSize` /
// `__zhujianSaf`),鸿蒙壳里一条都没有。⇒ 下面两个常数**不是"还没接"的占位**,
// 它们就是这一端今天的事实;真接上其中一条时改的是这个文件。

/**
 * ⛔ 这一端没有 textZoom(ArkWeb 有没有对位 API 今天**没有字据**,别当"马上就能补")。
 * ⇒ 设置面里「界面字号」那一整节不渲染 —— 469 真机实测:留着它就是四档点了会高亮、
 * 屏幕上一个像素不动,而铁律禁静默兜底。
 */
export const HAS_TEXT_ZOOM = false;

/**
 * ⛔ 这一端没有 SAF(那是安卓的文档选择器,鸿蒙的对位物要另写一条 ArkTS 桥)。
 * ⇒ 备份那一节说的是「这一端还没有备份」,⛔ **不是**安卓那句「前端与壳版本不配」
 * (468 补记到的那格:说法错、虽然没骗人)。备份要在电脑版上做,同 backup-plan §17.2 那条边界。
 */
export const HAS_SAF_BRIDGE = false;

/**
 * 系统分享:**这一端没有这条入口**。
 *
 * 安卓那半是 MainActivity 接 `ACTION_SEND` 落一个文件、Rust 侧取走;鸿蒙要接的是
 * ability 的 `want`,那是 ArkTS 侧的活,今天不存在(OH-e)。⇒ 恒无待取。
 */
export function takeSharedText(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * 深链接(`zhujian://`):**这一端没有这条入口**,同上(要在 `module.json5` 里声明
 * skill、再由 ability 的 `want` 送进来)。⇒ 恒无待取。
 */
export function takeDeepLink(): Promise<string | null> {
  return Promise.resolve(null);
}

/**
 * 查更新:**这一端没有更新通道**。
 *
 * 安卓那条是拉 `android.json` 比 versionCode、提示条跳浏览器装 APK;鸿蒙的自用装机
 * 走的是 `hdc file send` + `bm install`(还绕不过华为 ID 与设备 UDID 白名单,
 * backlog 条 18)⇒ **没有可以比对的清单**,也没有"下载装上"这个动作。
 * ⚠ 返回 null 的语义是「不提示更新」,调用方那边本来就 `catch` 静默 —— 这里给 null
 * 只是让它连一次失败的 IPC 都不发。
 */
export function checkUpdate(): Promise<MobileUpdate | null> {
  return Promise.resolve(null);
}

// ---- 扫码配对:这一端没有 ----------------------------------------------------------
//
// `tauri-plugin-barcode-scanner` 的依赖 gate 写死 `target_os = android|ios`,在鸿蒙上
// **编不过**(ohos/src-tauri/Cargo.toml 里"刻意不带的三样"第①条)。配对**走手输码**,
// 加入空间仍走 core 的 `JoiningSlot`/publish —— 协议一个字不改。

/** ⛔ false ⇒ 两枚扫码按钮整个不渲染,「输码」那半直接摊开(见 sync.ts 那两处)。 */
export const HAS_SCANNER = false;

/** 够不着相机。⚠ 它不该被调到(`HAS_SCANNER` 已经把入口摘了),真被调到就是接线漏了。 */
export function ensureCameraPermission(): Promise<boolean> {
  return Promise.resolve(false);
}

/** 同上:不该被调到。⛔ **响亮**,别返回空串 —— 空串会被当成一枚扫到的码去解析。 */
export function scanQrContent(): Promise<string> {
  return Promise.reject(new Error("这一端没有扫码(HAS_SCANNER=false 却走到了扫码路径)"));
}

/** 没有在飞的扫码可取消。 */
export function cancelScan(): Promise<void> {
  return Promise.resolve();
}
