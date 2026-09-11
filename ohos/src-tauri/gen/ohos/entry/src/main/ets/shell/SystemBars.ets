import window from '@ohos.window';
import hilog from '@ohos.hilog';
import { BusinessError } from '@kit.BasicServicesKit';

const DOMAIN = 0x0301;
const TAG = 'ZHUJIAN';

/**
 * 系统栏图标(时钟 / 信号 / 电量 / 手势条)的明暗 —— 铺满(657)之后它坐在朱简自己的顶栏上,
 * 暗档下深图标压深底几乎看不见(657 量到 1.17:1)。
 *
 * **谁说了算(659 起)**:页面。`android/src/theme.ts` 算出的「生效色」(自动 = 跟系统、亮、暗)
 * 经 `window.__zhujianSystemBars.setDark()` 送到这里,与安卓 `MainActivity.kt` 那座桥同名同形,
 * 前端一行没改。`EntryAbility` 只在页面还没开口之前按**系统**明暗档先拧一次(冷启首帧);
 * 页面第一次 `setDark` 之后(`pageOwned`)它就不再插手 —— 否则日夜自动切时它会把用户手动
 * 锁定的那一档盖回去。
 */
export class SystemBars {
  /** 页面接管了没。⚠ 只从 false 翻到 true,没有翻回去的路(页面活着就一直是它管)。 */
  static pageOwned: boolean = false;

  static apply(win: window.Window, dark: boolean): Promise<void> {
    return win.setWindowSystemBarProperties({
      statusBarContentColor: dark ? '#FFFFFF' : '#000000',
      navigationBarContentColor: dark ? '#FFFFFF' : '#000000',
    });
  }
}

/** 挂成页面里的 `window.__zhujianSystemBars`(`ZhujianXComponent.bridges()`)。 */
export class SystemBarsBridge {
  private win: window.Window;

  constructor(win: window.Window) {
    this.win = win;
  }

  /** ⚠ 名字与 `android/src/theme.ts` 的 `__zhujianSystemBars.setDark` 绑死(那是两端共用的前端)。 */
  setDark(dark: boolean): void {
    SystemBars.pageOwned = true;
    SystemBars.apply(this.win, dark)
      .then(() => hilog.info(DOMAIN, TAG, 'systembars: page set dark=%{public}s', String(dark)))
      .catch((e: BusinessError) => {
        hilog.error(DOMAIN, TAG, 'systembars: set failed code=%{public}d msg=%{public}s', e.code, e.message);
      });
  }
}
