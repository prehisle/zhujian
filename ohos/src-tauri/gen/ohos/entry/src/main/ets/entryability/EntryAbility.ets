import { NativeAbility } from '@ohos-rs/ability'
import Want from '@ohos.app.ability.Want'
import { AbilityConstant, Configuration, ConfigurationConstant } from '@kit.AbilityKit';
import window from '@ohos.window';
import { RouteName as ShellRoute } from '../shell/ZhujianPage';

/**
 * 朱简鸿蒙端的 UIAbility。
 *
 * ⭐ **这个类几乎什么都不做,那是对的** —— 窗口与 WebView 由 `@ohos-rs/ability` 的
 * `NativeAbility` 按 `moduleName` 加载 Rust 那只 .so、再由 tauri 的
 * `#[ability(webview, …)]` 入口接管;ArkTS 侧只负责「把它拉起来」。
 *
 * ⛔ **别照抄 demo 那份的 `registerArkTsCallbacks()`** —— 那是 demo 自己的 Rust↔ArkTS
 * 回调示例(而且 460 实测那条路上 String 参数到 ArkTS 侧是 `null`,病因没隔离)。
 *
 * ⚠ **系统栏那两格只有这个类碰得到**:`@ohos-rs/ability` 交给 Rust 的 `ArkHelper` 只有
 * `exit` / `createWebview` / `requestPermission` / `getWindowAvoidArea` 四个方法,**没有
 * 系统栏**(type.ets 的 `ArkHelper`)⇒ Rust 侧够不着 `setWindowSystemBarProperties`。
 * 下面那格今天仍按**系统**明暗档拧 —— 判据与余账见 `applySystemBarContentColor()` 的头注。
 *
 * ⭐ **页面 → ArkTS 那条路 658 起有了**:`defaultPage = false`,窗口装的是我们自己的
 * `shell/ZhujianPage`(照抄依赖那页 + 给 WebView 挂 `registerJavaScriptProxy`),第一座桥是扫码
 * (`shell/ScanBridge.ets`)。再要给页面开一条原生能力就往 `ZhujianXComponent.bridges()` 里加,
 * ⛔ 别再开第二种通路。
 */
export default class EntryAbility extends NativeAbility {
  // ⚠ 这个字符串 = Rust 那只 .so 的库名(libzhujian_ohos_lib.so 去掉 lib/.so)。
  // 与 ohos/src-tauri/Cargo.toml 的 `[lib] name` 必须一致,写错 = 装机后白屏、无提示。
  public moduleName: string = "zhujian_ohos_lib"
  // ⛔ false:依赖自带的 MainPage 不装,`onWindowStageCreate` 末尾装我们自己那页(见类头注)。
  public defaultPage: boolean = false;

  // 主窗口。`onConfigurationUpdate` 那条路上没有 windowStage,只能在这里留一手。
  private mainWindow: window.Window | null = null;

  async onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): Promise<void> {
    await super.onCreate(want, launchParam);
  }

  async onWindowStageCreate(windowStage: window.WindowStage): Promise<void> {
    const win = windowStage.getMainWindowSync();
    this.mainWindow = win;
    // 铺满整屏(含状态栏与手势条那两条)。⛔ 别改回 `false`:那样系统按**窗口底色**去画
    // 状态栏与手势条,而窗口底色是白的 ⇒ 上下两条白边(用户面 93,用户拍图报的)。
    // ⭐ **铺满之后让位不用我们操心**:真机实测 ArkWeb 的 `env(safe-area-inset-top)` 给的
    // 就是**状态栏真高**(这台 Mate 60 Pro = 123 物理 px,与 hidumper 报的一致)——
    // ⛔ 别照安卓那条经验推:Chromium 把 safe-area 映到**挖孔**、状态栏恒 0,所以安卓那端
    // 才要 `MainActivity.topInset()` 那座桥(`android/index.html` 里那段脚本);
    // 鸿蒙这端桥不在、那段整个跳过,靠的就是 `env()` 自己,逐像素对齐(用户面 93 实测)。
    await win.setWindowLayoutFullScreen(true);
    await this.applySystemBarContentColor();
    await super.onWindowStageCreate(windowStage);
    // 依赖在 `defaultPage` 下就是这一句(`loadContentByName`),只是页换成带桥的那份。
    await windowStage.loadContentByName(ShellRoute);
  }

  /**
   * 系统栏图标(时钟 / 信号 / 电量 / 手势条)的明暗。
   *
   * ⚠ **铺满之前不需要这一格**:那时状态栏坐在**窗口底色(白)**上,深色图标怎么都看得见。
   * 铺满之后它坐在朱简自己的顶栏上 ⇒ 暗色档下深图标压在深底上,时钟基本看不见(93 实测)。
   *
   * ⛔ **它跟的是「系统」明暗档,不是朱简自己那三档**(外观 = 自动 / 亮 / 暗)。
   * 朱简的档住在 WebView 的 localStorage 里(`android/src/theme.ts`)。657 时页面 → ArkTS
   * 那条路不存在,只能这么拧;**658 起路有了**(见类头注),但这一格还没接上桥 ——
   * 默认档「自动」= 跟随系统,这一格**逐格正确**;只有用户把朱简手动拧到与系统**相反**
   * 的那一档时,图标色仍旧不对(backlog 用户面 94)。⛔ 别拿「加个轮询读文件」去补它,
   * 要补就走 `ZhujianXComponent.bridges()` 那条路。
   *
   * ⚠ `COLOR_MODE_NOT_SET` 按亮色处理 —— 那不是静默默认值,是平台把「没表态」画成亮色。
   */
  private async applySystemBarContentColor(): Promise<void> {
    const win = this.mainWindow;
    if (!win) {
      return;
    }
    const dark = this.context.config.colorMode === ConfigurationConstant.ColorMode.COLOR_MODE_DARK;
    await win.setWindowSystemBarProperties({
      statusBarContentColor: dark ? '#FFFFFF' : '#000000',
      navigationBarContentColor: dark ? '#FFFFFF' : '#000000',
    });
  }

  onConfigurationUpdate(newConfig: Configuration): void {
    super.onConfigurationUpdate(newConfig);
    // 系统在「日夜自动切」时走这条路 ⇒ 图标色当场跟上,别等下次冷启。
    this.applySystemBarContentColor();
  }
}
