// **鸿蒙那一份平台接缝**(OH-d/D3)。与 `android/src/platform.ts` 同一个导出面 ——
// 那一份是真实现,这一份逐条写明「这一端没有这条路」。
//
// ⭐ **它是怎么被用上的**:`ohos/vite.config.ts` 里一个 resolve 插件,把从
// `android/src/**` 发出的 `./platform` 说明符改指到本文件。⇒ 产品前端那 8.5k 行 TS
// **一份源码两端共用**,零复制。
//
// ⛔ **这里的每一条都不许"看起来能用"**:返回 null 的两条是**真的没有待取的东西**
// (这一端根本没有系统分享 / 深链接那两条入口),不是"暂时取不到";
// `HAS_TEXT_ZOOM = false` 那一族会让对应那块 UI **整个不渲染**,而不是渲染出来点了报错。
// ⭐ 扫码是这一端**第一条真接上的桥**(658,Scan Kit),形见文末那一节。
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
 * ⛔ 这一端没有系统通知(壳里没挂 `tauri-plugin-notification`;鸿蒙的对位物是
 * `@ohos.notificationManager`,要另写一条 ArkTS 桥,今天不存在)。
 * ⇒ 设置面里「截止提醒」那一整节不渲染 —— 留着它就是「开关点了会亮、到点一声不响」,
 * 与 469 在真机上逮到的字号那四档同形(界面在说谎)。
 */
export const HAS_NOTIFICATION = false;

/** 够不着通知权限。⚠ 它不该被调到(`HAS_NOTIFICATION` 已经把整节摘了),真被调到就是接线漏了。 */
export function notifyPermissionOk(): Promise<boolean> {
  return Promise.resolve(false);
}

/** 同上:不该被调到。⛔ **响亮**,别静默返回 —— 静默 = 用户以为发出去了。 */
export function showNotification(_title: string, _body: string): void {
  throw new Error("这一端没有系统通知(HAS_NOTIFICATION=false 却走到了发送路径)");
}

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

// ---- 扫码配对:走华为 Scan Kit 的系统扫码页(658 起) ------------------------------
//
// `tauri-plugin-barcode-scanner` 在鸿蒙上编不过(依赖 gate 写死 `target_os = android|ios`,
// ohos/src-tauri/Cargo.toml 里"刻意不带的三样"第①条),这一端的扫码是**另一座桥**:
// 壳里 `shell/ScanBridge.ets` 经 `registerJavaScriptProxy` 挂成 `window.__zhujianScan`,
// 页面调 `start()` 发令、结果由壳 `runJavaScript` 回推到 `window.__zhujianScanDone`
// (ArkWeb 的异步接口拿不到返回值,只能这么来回)。扫到的文本喂给同一条 `parsePairQr` →
// 加入路,协议一个字不改。
//
// ⚠ 与安卓那条的三处形差,调用方(`sync.ts::startScan`)不用知道:
//   · 相机权限:Scan Kit 默认界面拿的是系统预授权,本 app 不申请 ⇒ `ensureCameraPermission` 恒 true;
//   · 取景框:系统扫码页整页盖上来,`#scan` 那层挖空取景框被盖在底下(不碍事,也不用摘);
//   · 取消:系统页自带返回,`cancelScan` 无事可做;用户按返回时 Scan Kit 以错误码回来,
//     这里把它翻成 `name = "ScanCancelled"` 的错,`startScan` 见到就静默收场。

/** 这一端有摄像头扫码(经 Scan Kit)。⚠ 构建期常数,不是运行期探测。 */
export const HAS_SCANNER = true;

/** 与壳 `ScanBridge.ets` 的 `ScanOutcome` 逐字对应,改一边就改另一边。 */
type ScanOutcome = { ok: boolean; text?: string; code?: number; message?: string };

declare global {
  interface Window {
    __zhujianScan?: { start(): void };
    __zhujianScanDone?: (out: ScanOutcome) => void;
  }
}

/** Scan Kit 报「用户退出扫码页」用的错误码(1000500002 "The user canceled the barcode scanning.",
 *  Mate 60 Pro 真机实测,见 progress-log 658;⚠ 网上两种说法 201 / 1300006 都不对,别照抄)。 */
const SCAN_CANCEL_CODES = new Set<number>([1000500002]);

/** Scan Kit 默认界面不需要本 app 的相机权限 ⇒ 恒 true。 */
export function ensureCameraPermission(): Promise<boolean> {
  return Promise.resolve(true);
}

/** 拉起系统扫码页,扫到一枚二维码就返回它的文本。 */
export function scanQrContent(): Promise<string> {
  const bridge = window.__zhujianScan;
  // ⛔ 响亮:桥缺席 = 壳没接上(`ZhujianXComponent.bridges()` 没跑到),不是"这一端没有扫码"。
  if (!bridge) return Promise.reject(new Error("壳没接上扫码桥(window.__zhujianScan 缺席)"));
  return new Promise<string>((resolve, reject) => {
    window.__zhujianScanDone = (out) => {
      window.__zhujianScanDone = undefined;
      if (out.ok && typeof out.text === "string") {
        resolve(out.text);
        return;
      }
      const err = new Error(`扫码失败(${out.code ?? "?"}):${out.message ?? ""}`);
      if (out.code !== undefined && SCAN_CANCEL_CODES.has(out.code)) err.name = "ScanCancelled";
      reject(err);
    };
    bridge.start();
  });
}

/** 系统扫码页自带返回,这一端没有可从页面取消的在飞扫码。 */
export function cancelScan(): Promise<void> {
  return Promise.resolve();
}
