import common from "@ohos.app.ability.common";
import { Loadable } from "@ohos-rs/ability/src/main/ets/helper/loadable";
import { ShellWeb, ZhujianXComponent } from "./ZhujianXComponent";

/** `EntryAbility` 用 `loadContentByName` 按这个名字装本页(`defaultPage = false` 之后依赖那页不再装)。 */
export const RouteName = "ZhujianShell";

/**
 * 照抄 `@ohos-rs/ability` 的 `MainPage`,只改两处:`DefaultXComponent` 换成带桥的 `ZhujianXComponent`;
 * `onBackPress` 先问页面(见那个方法的注释)。
 */
@Entry({ routeName: RouteName })
@Component
struct ZhujianPage {
  @StorageProp("moduleName") moduleNames: string | string[] = "";
  @StorageProp("loadMode") loadMode: "async" | "sync" = "async";
  private nativeModule: ESObject = null;
  @State private primaryModuleName: string = "";

  async aboutToAppear(): Promise<void> {
    const moduleName = Loadable.resolvePrimaryModuleName(this.moduleNames);
    if (!moduleName) {
      throw new Error("dynamic moduleName is empty");
    }

    this.nativeModule = await Loadable.load(moduleName, this.loadMode);
    this.primaryModuleName = moduleName;
  }

  private backInFlight = false;

  /**
   * 返回键先问页面要不要(用户面 117):页面开着层(捕获 / 面板 / 编辑层 / 留言 / 大图 / 扫码)就只收
   * 那一层,没有层才退到后台。此前这里只转给 Rust 那条拦截,而没有任何人注册它 ⇒ 恒 false ⇒ 系统
   * 默认路 —— 捕获层开着按第二下整个 app 就没了。形照安卓 `MainActivity` 那只回调:
   * - 问的是页内原子入口 `window.__zhujianHandleBack()`(判断 + 消费一体,账本在页面里);
   * - `runJavaScript` 是异步的而本方法要同步答 ⇒ 先答 true 吞掉这一下,应答回来是 false 再自己退;
   * - single-flight:应答未归前的连按丢弃;页面 500ms 不应答也放行退出,⛔ 绝不把人困在 app 里。
   * 「退」= `moveAbilityToBackground`(同安卓根 Activity 的默认返回:进程留着,草稿不丢)。
   */
  onBackPress(): boolean {
    if (typeof this.nativeModule?.on_back_press_intercept === "function" && this.nativeModule.on_back_press_intercept()) {
      return true;
    }
    const ctrl = ShellWeb.ctrl;
    if (!ctrl) {
      return false; // 页面还没起来:走系统默认
    }
    if (this.backInFlight) {
      return true;
    }
    this.backInFlight = true;
    let done = false;
    const settle = (consumed: boolean): void => {
      if (done) {
        return;
      }
      done = true;
      this.backInFlight = false;
      if (!consumed) {
        const ctx = this.getUIContext().getHostContext() as common.UIAbilityContext;
        ctx.moveAbilityToBackground();
      }
    };
    ctrl.runJavaScript("window.__zhujianHandleBack?window.__zhujianHandleBack():false")
      .then((r: string): void => settle(r === "true"))
      .catch((): void => settle(false));
    setTimeout((): void => settle(false), 500);
    return true;
  }

  build() {
    Row() {
      Column() {
        if (this.primaryModuleName) {
          ZhujianXComponent({ moduleName: this.primaryModuleName });
        }
      }.width("100%")
    }.height("100%");
  }
}
