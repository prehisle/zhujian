// 构建身份戳的**读取与成文**(两端共用)。注入侧在 `scripts/lib/build-stamp.mjs`,
// 「为什么非有它不可 / 为什么不住 build.rs / 脏判据为什么是整棵树」那三段都写在那份顶注里,
// ⛔ 别在这儿复述。这里只管:怎么读到它、怎么写成人看得懂的一行。
//
// 桌面显在设置「关于」那一类的版本行下(`src/about.ts`),
// 手机显在「关于」里(`android/src/main.ts::loadAbout`,鸿蒙共用那棵树)。

declare global {
  /**
   * 构建那一刻的身份,由 vite `define` 注入。
   * ⛔ 读它的地方不许写 `typeof __ZJ_BUILD__ === "undefined"` 之类的兜底分支 —— 拿不到它
   * 只可能是构建配错了(哪个 vite.config 漏了 `define`),那必须当场看得见,而不是静静地
   * 显成一个空白。
   */
  const __ZJ_BUILD__: BuildStamp;
}

export type BuildStamp = {
  /** `git rev-parse --short=12 HEAD`,12 位十六进制。 */
  commit: string;
  /** 构建那一刻工作树有没有未提交 / 未跟踪的改动(排除面见注入侧)。 */
  dirty: boolean;
  /** 构建时刻,`Date.now()` 的毫秒数。 */
  at: number;
};

export function buildStamp(): BuildStamp {
  return __ZJ_BUILD__;
}

/**
 * 构建时刻成文:本地时区的 `YYYY-MM-DD HH:mm`。
 *
 * ⚠ **刻意不用 `toLocaleString`** —— 它随界面语言换格式(中文那版会写成「2026/9/17 15:04」),
 * 而这一格的唯一用途是「用户念给我听、我拿去对树」,格式必须恒定、不随语言漂。
 */
export function formatBuiltAt(at: number): string {
  const d = new Date(at);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
