import { NativeAbility } from '@ohos-rs/ability'
import Want from '@ohos.app.ability.Want'
import { AbilityConstant } from '@kit.AbilityKit';
import window from '@ohos.window';

/**
 * 朱简鸿蒙端的 UIAbility。
 *
 * ⭐ **这个类几乎什么都不做,那是对的** —— 窗口与 WebView 由 `@ohos-rs/ability` 的
 * `NativeAbility` 按 `moduleName` 加载 Rust 那只 .so、再由 tauri 的
 * `#[ability(webview, …)]` 入口接管;ArkTS 侧只负责「把它拉起来」。
 *
 * ⛔ **别照抄 demo 那份的 `registerArkTsCallbacks()`** —— 那是 demo 自己的 Rust↔ArkTS
 * 回调示例(而且 460 实测那条路上 String 参数到 ArkTS 侧是 `null`,病因没隔离)。
 * 朱简今天不需要那条桥:安卓那两条窄桥(状态栏图标明暗 / textZoom)在这一端的对位
 * 要用时再谈,不在 C3 范围内。
 */
export default class EntryAbility extends NativeAbility {
  // ⚠ 这个字符串 = Rust 那只 .so 的库名(libzhujian_ohos_lib.so 去掉 lib/.so)。
  // 与 ohos/src-tauri/Cargo.toml 的 `[lib] name` 必须一致,写错 = 装机后白屏、无提示。
  public moduleName: string = "zhujian_ohos_lib"
  public defaultPage: boolean = true;

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    await super.onCreate(want, launchParam);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const win = windowStage.getMainWindowSync();
    // 不铺满状态栏区(false = 系统给出安全区内的布局);沉浸式留给 OH-d 的 UI 轮。
    await win.setWindowLayoutFullScreen(false);
    await super.onWindowStageCreate(windowStage);
  }
}
