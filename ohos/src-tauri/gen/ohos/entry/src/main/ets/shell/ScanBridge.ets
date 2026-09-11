import { scanBarcode, scanCore } from '@kit.ScanKit';
import { BusinessError } from '@kit.BasicServicesKit';
import web_webview from '@ohos.web.webview';
import common from '@ohos.app.ability.common';
import hilog from '@ohos.hilog';

/** 与 Rust 那只 `hilog.rs` 同一个 domain / tag(0x0301 / ZHUJIAN),`ohos-drive.mjs` 的报告按它挑行。 */
const DOMAIN = 0x0301;
const TAG = 'ZHUJIAN';

/** 送回页面的那一枚结果。⚠ 形与 `ohos/src/platform.ts` 的 `ScanOutcome` 逐字对应,改一边就改另一边。 */
interface ScanOutcome {
  ok: boolean;
  text?: string;
  code?: number;
  message?: string;
}

/**
 * 页面 → ArkTS 的第一座桥:扫码(鸿蒙那份 `platform.ts` 的 `scanQrContent`)。
 *
 * **形**:`registerJavaScriptProxy` 把本类挂成页面里的 `window.__zhujianScan`,页面调
 * `start()`(异步方法 —— ArkWeb 的 asyncMethodList **拿不到返回值**,只能当「发令」用),
 * 扫码结果由本类经 `runJavaScript` 回推到页面的 `window.__zhujianScanDone(...)`。
 * 与安卓壳 `MainActivity.kt` 那三座桥同一种形(JS 接口 + 回推),只是接口注册走 ArkWeb 的 API。
 *
 * **扫码用的是华为 Scan Kit 的默认界面**(`startScanForResult`):系统自己的扫码页盖上来、
 * 扫到就回,⚠ **不需要本 app 申请相机权限**(Scan Kit 拿的是系统预授权,module.json5 里
 * 不声明 CAMERA)。⇒ 安卓那条「先要相机权限」在这一端是空操作。
 *
 * ⚠ `enableAlbum: true`:扫码页上带「相册」入口,配对码是截图发过来的也能扫。
 */
export class ScanBridge {
  private ctx: common.UIAbilityContext;
  private ctrl: web_webview.WebviewController;

  constructor(ctx: common.UIAbilityContext, ctrl: web_webview.WebviewController) {
    this.ctx = ctx;
    this.ctrl = ctrl;
  }

  /** 页面发令。⚠ 名字与 `platform.ts` 里 `window.__zhujianScan.start()` 那一处绑死。 */
  start(): void {
    const options: scanBarcode.ScanOptions = {
      scanTypes: [scanCore.ScanType.QR_CODE],
      enableMultiMode: false,
      enableAlbum: true,
    };
    hilog.info(DOMAIN, TAG, 'scan: start');
    scanBarcode.startScanForResult(this.ctx, options)
      .then((r: scanBarcode.ScanResult) => {
        hilog.info(DOMAIN, TAG, 'scan: got %{public}d chars', r.originalValue.length);
        const out: ScanOutcome = { ok: true, text: r.originalValue };
        this.deliver(out);
      })
      .catch((e: BusinessError) => {
        // 用户在系统扫码页按返回也走这条(哪个 code 是「取消」由页面那半判,这里只如实转)。
        hilog.info(DOMAIN, TAG, 'scan: err code=%{public}d msg=%{public}s', e.code, e.message);
        const out: ScanOutcome = { ok: false, code: e.code, message: e.message };
        this.deliver(out);
      });
  }

  private deliver(out: ScanOutcome): void {
    // JSON 是合法的 JS 字面量 ⇒ 直接内嵌;二维码里的内容经 JSON.stringify 转义过,不会闯出字符串。
    this.ctrl.runJavaScript(`window.__zhujianScanDone(${JSON.stringify(out)})`)
      .catch((e: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'scan: deliver failed code=%{public}d msg=%{public}s', e.code, e.message);
      });
  }
}
