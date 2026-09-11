import { Loadable } from "@ohos-rs/ability/src/main/ets/helper/loadable";
import { ZhujianXComponent } from "./ZhujianXComponent";

/** `EntryAbility` 用 `loadContentByName` 按这个名字装本页(`defaultPage = false` 之后依赖那页不再装)。 */
export const RouteName = "ZhujianShell";

/**
 * 照抄 `@ohos-rs/ability` 的 `MainPage`,只把 `DefaultXComponent` 换成带桥的 `ZhujianXComponent`。
 * ⛔ 其余一行别改(`onBackPress` 那条是返回键交给 Rust 的路)。
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

  onBackPress(): boolean {
    if (typeof this.nativeModule?.on_back_press_intercept === "function") {
      return this.nativeModule.on_back_press_intercept();
    }
    return false;
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
