import { NodeContent } from "@kit.ArkUI";
import common from "@ohos.app.ability.common";
import window from "@ohos.window";
import web_webview from "@ohos.web.webview";
import hilog from "@ohos.hilog";
import {
  ArkHelper,
  WebViewInitData as NativeWebViewInitData,
  WindowAvoidAreaInfo,
} from "@ohos-rs/ability/src/main/ets/ability/type";
import { exit, requestPermission } from "@ohos-rs/ability/src/main/ets/helper";
import { Loadable } from "@ohos-rs/ability/src/main/ets/helper/loadable";
import { RustWebviewNodeController, WebviewStyle, WebviewInitData } from "@ohos-rs/ability";
import { ScanBridge } from "./ScanBridge";
import { SystemBarsBridge } from "./SystemBars";

const DOMAIN = 0x0301;
const TAG = "ZHUJIAN";

/**
 * 承载 WebView 的那个组件 —— **照抄 `@ohos-rs/ability` 0.4.0-beta.5 的 `DefaultXComponent`**,
 * 只多了一件事:给 WebView 挂**页面 → ArkTS 的桥**(`registerJavaScriptProxy`)。
 *
 * ⭐ **为什么要抄而不是用它的**:那份把 `WebviewController` 建在自己肚子里、不露出来,
 * 而 ArkWeb 注册 JS 接口只认真正的 controller(`JsHelper` 那层只有 `runJavaScript`)。
 * 657 之前「页面 → ArkTS 那条路在这套依赖上不存在」说的就是这件事;这份抄本把路开了。
 * ⛔ 抄的部分**一行都别改**(`helper` 那四个方法、`render` / `ContentSlot` 的接线),
 * 依赖升级时用它新版的 `DefaultXComponent` 逐行对一遍再合。
 * ⚠ Web 组件本身(`Web(...)` 那个 builder)**仍是依赖里那份** —— `build-ohos.mjs` 给它打的
 * `domStorageAccess` 补丁照旧生效(468),这里没有复制它。
 *
 * **桥怎么挂**:controller 自己建、交给依赖去建 Web 组件;第一次 `onLoadIntercept`(页面
 * 还没开始加载、但 controller 已经绑上 Web 组件)时注册接口。⛔ 别挪到 `addWebview` 刚返回
 * 那一刻 —— 那时 Web 组件可能还没 attach,`registerJavaScriptProxy` 会抛 17100001。
 *
 * ⭐ 以后再加桥(通知 / 分享)就在 `bridges()` 里多注册一个对象,别再开第二条路。今天两座:
 * 扫码(`ScanBridge`)、系统栏明暗(`SystemBarsBridge`,659)。
 */
@Component
export struct ZhujianXComponent {
  moduleName: string = "";
  private rootSlot = new NodeContent();
  private webviewController = new RustWebviewNodeController(this.getUIContext());
  private nativeModule: ESObject;
  private bridged = false;
  private helper: ArkHelper = {
    exit,
    requestPermission: async (permission: string | string[]): Promise<number | number[]> => {
      const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
      return await requestPermission(context, permission);
    },
    getWindowAvoidArea: (type: number): WindowAvoidAreaInfo | undefined => {
      try {
        const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
        const win = context.windowStage.getMainWindowSync();
        const avoidType = type as window.AvoidAreaType;
        return {
          type: avoidType,
          area: win.getWindowAvoidArea(avoidType),
        } as WindowAvoidAreaInfo;
      } catch (_) {
        return undefined;
      }
    },
    createWebview: (data: NativeWebViewInitData) => {
      const initScripts: ScriptItem[] = (data?.initializationScripts || []).map((i) => {
        return {
          script: i,
          scriptRules: ["*"],
        } as ScriptItem;
      });
      // ⭐ 与依赖那份的唯一分叉:controller 我们自己建、桥在第一次拦截时挂上。
      const webTag: string = data?.id || "zhujian";
      const ctrl = new web_webview.WebviewController(webTag);
      const upstreamNav = data?.onNavigationRequest;
      const init: WebviewInitData = {
        webTag,
        url: data?.url,
        html: data?.html,
        headers: data?.headers,
        controller: ctrl,
        style: (data.style || {}) as WebviewStyle,
        javascriptEnable: data?.javascriptEnable ?? true,
        userAgent: data?.userAgent,
        devtools: data?.devtools,
        autoplay: data?.autoplay,
        initializationScripts: initScripts,
        onDragAndDrop: data?.onDragAndDrop,
        onDownloadStart: data?.onDownloadStart,
        onDownloadEnd: data?.onDownloadEnd,
        onNavigationRequest: (url: string): boolean => {
          this.bridges(ctrl);
          if (typeof upstreamNav === "function") {
            return upstreamNav(url);
          }
          return false;
        },
        onTitleChange: data?.onTitleChange,
      } as WebviewInitData;

      if (data?.transparent && !init.style?.backgroundColor) {
        init.style!.backgroundColor = Color.Transparent;
      }
      const ret = this.webviewController.addWebview(init);

      ret.controller.setBackgroundColor = (color: string) => {
        init.style!.backgroundColor = color;
        const node = this.webviewController.getWebviewNode(ret.webTag);
        node?.update(init);
      };

      ret.controller.setVisible = (visible: boolean) => {
        init.style!.visible = visible ? "visible" : "hidden";
        const node = this.webviewController.getWebviewNode(ret.webTag);
        node?.update(init);
      };

      return ret.controller;
    },
  };
  @StorageProp("loadMode") loadMode: "async" | "sync" = "async";

  /** 一次性:把各座桥挂到页面的 `window` 上。名字与 `ohos/src/platform.ts` 逐字绑死。 */
  private bridges(ctrl: web_webview.WebviewController): void {
    if (this.bridged) {
      return;
    }
    this.bridged = true;
    const context = this.getUIContext().getHostContext() as common.UIAbilityContext;
    try {
      ctrl.registerJavaScriptProxy(new ScanBridge(context, ctrl), "__zhujianScan", [], ["start"]);
      hilog.info(DOMAIN, TAG, "bridge: __zhujianScan registered");
      const win = context.windowStage.getMainWindowSync();
      ctrl.registerJavaScriptProxy(new SystemBarsBridge(win), "__zhujianSystemBars", [], ["setDark"]);
      hilog.info(DOMAIN, TAG, "bridge: __zhujianSystemBars registered");
    } catch (e) {
      // ⛔ 响亮:桥没挂上 = 页面那半会在点扫码时报「壳没接上扫码桥」,这里先留一行凭据。
      hilog.error(DOMAIN, TAG, "bridge: registerJavaScriptProxy failed: %{public}s", String(e));
    }
  }

  async aboutToAppear(): Promise<void> {
    const moduleName = this.moduleName.trim();
    if (!moduleName) {
      throw new Error("ZhujianXComponent.moduleName is required");
    }
    this.nativeModule = await Loadable.load(moduleName, this.loadMode);
    this.nativeModule.render(this.helper, this.rootSlot);
  }

  build() {
    Stack() {
      ContentSlot(this.rootSlot)
      Row() {
        Column() {
          NodeContainer(this.webviewController)
            .height("100%")
            .width("100%")
        }.width("100%")
      }
      .height("100%")
      .hitTestBehavior(HitTestMode.Transparent)
    };
  }
}
