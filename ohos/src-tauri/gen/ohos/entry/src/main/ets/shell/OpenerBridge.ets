import Want from '@ohos.app.ability.Want';
import common from '@ohos.app.ability.common';
import web_webview from '@ohos.web.webview';
import hilog from '@ohos.hilog';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN = 0x0301;
const TAG = 'ZHUJIAN';

/** 送回页面的那一枚结果。⚠ 形与 `ohos/src/opener.ts` 的 `OpenOutcome` 逐字对应,改一边就改另一边。 */
interface OpenOutcome {
  id: number;
  ok: boolean;
  code?: number;
  message?: string;
}

/**
 * 页面 → ArkTS 的第三座桥:把网址交给系统(W5 A54)。挂成页面里的 `window.__zhujianOpener`。
 *
 * **为什么要它**:鸿蒙上 `tauri-plugin-opener` 的 `openUrl` 恒错(Rust 那半编译目标是 linux、去调
 * `xdg-open`,这一端没有那个程序 —— 平台事实②),于是「关于」里官网 / 源码 / 更新日志三行此前只能摆成
 * 纯文字,点了没反应。拉起别的应用只有 ArkTS 够得着(`UIAbilityContext`),Rust 侧的 `ArkHelper`
 * 没有那一格 ⇒ 走桥。页面那半(`ohos/src/opener.ts`)经 `ohos/vite.config.ts` 的 opener 接缝顶替
 * `@tauri-apps/plugin-opener`,共用前端那几处 `openUrl(...)` 一行不改。
 *
 * **形**同扫码那座(`ScanBridge`):页面调 `open(id, url)` 发令(asyncMethodList 拿不到返回值),
 * 成败经 `runJavaScript` 回推到 `window.__zhujianOpenerDone({ id, ok, … })`。`id` 是页面那半发的号,
 * 连点几下各自回各自的。
 *
 * **两种地址,各走一条系统认的路**(⛔ 别「先试 A、失败再退 B」—— 那是静默兜底):
 * - `http(s)://` → 隐式 want `ohos.want.action.viewData` + `entity.system.browsable` = 系统浏览器
 *   (W5 O1 在 MatePad Pro 13 模拟器上用同一个 want 经 `aa start` 拉起过 `com.huawei.hmos.browser`);
 * - `mailto:` → `openLink`(隐式匹配声明了 mailto 的邮件应用;意见反馈那一框用)。⚠ 模拟器上没有邮件应用,
 *   这条只量到「没有能接的应用 → 16000019 回到页面、顶上报错」那一半;真机上拉不拉得起写信待鸿蒙真机复核。
 * - 其余协议一律回错(共用前端今天只交这两种;长文链接过 `validateHttpUrl`,只会是 http(s))。
 */
export class OpenerBridge {
  private ctx: common.UIAbilityContext;
  private ctrl: web_webview.WebviewController;

  constructor(ctx: common.UIAbilityContext, ctrl: web_webview.WebviewController) {
    this.ctx = ctx;
    this.ctrl = ctrl;
  }

  /** 页面发令。⚠ 名字与 `ohos/src/opener.ts` 里 `window.__zhujianOpener.open(id, url)` 那一处绑死。 */
  open(id: number, url: string): void {
    // ⚠ 只记协议,不记整条地址(hilog 是 public 格式,地址里可能带用户写进长文的东西)。
    const scheme = url.split(':')[0].toLowerCase();
    hilog.info(DOMAIN, TAG, 'opener: open #%{public}d scheme=%{public}s', id, scheme);
    let started: Promise<void>;
    // ⛔ 两个系统接口参数不对时是**同步抛**(401),不是 reject —— 不接住就一句不回,页面那半的 Promise
    // 永远不 settle(= W5 A5 那种「壳没回话、前端干等」)。⇒ 每条路都必须回一句。
    try {
      if (scheme === 'http' || scheme === 'https') {
        const want: Want = {
          action: 'ohos.want.action.viewData',
          entities: ['entity.system.browsable'],
          uri: url,
        };
        started = this.ctx.startAbility(want);
      } else if (scheme === 'mailto') {
        started = this.ctx.openLink(url, { appLinkingOnly: false });
      } else {
        const out: OpenOutcome = { id: id, ok: false, message: `unsupported scheme: ${scheme}` };
        this.deliver(out);
        return;
      }
    } catch (e) {
      const err = e as BusinessError;
      hilog.info(DOMAIN, TAG, 'opener: #%{public}d threw code=%{public}d msg=%{public}s', id, err.code, err.message);
      const out: OpenOutcome = { id: id, ok: false, code: err.code, message: err.message };
      this.deliver(out);
      return;
    }
    started
      .then(() => {
        const out: OpenOutcome = { id: id, ok: true };
        this.deliver(out);
      })
      .catch((e: BusinessError) => {
        hilog.info(DOMAIN, TAG, 'opener: #%{public}d err code=%{public}d msg=%{public}s', id, e.code, e.message);
        const out: OpenOutcome = { id: id, ok: false, code: e.code, message: e.message };
        this.deliver(out);
      });
  }

  private deliver(out: OpenOutcome): void {
    // JSON 是合法的 JS 字面量 ⇒ 直接内嵌(同 ScanBridge.deliver)。
    this.ctrl.runJavaScript(`window.__zhujianOpenerDone(${JSON.stringify(out)})`)
      .catch((e: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'opener: deliver failed code=%{public}d msg=%{public}s', e.code, e.message);
      });
  }
}
