// 错误文案人话前置(用户面 126 = 盈利准备 C8 的手机那半;ui-guidelines §4.3「前半句必须是人能
// 懂的一句话,原始错误可保留在后半句」)。桌面 src/err.ts 的手机孪生:**匹配面与四类照抄**,
// 字典与出口按本端的形(⛔ 别跨树 import 桌面那份,两端各一套字典与 DOM 习惯)。
// **纯展示映射**:⛔ 不吞错、不重试、不改任何行为 —— 调用方照旧在自己的 catch 里做它原本
// 做的事,只是把 `String(e)` 换成这里的一个函数。拿原话做判断的(如 SEAT_LIMIT_MARK)照旧
// 用 `String(e)`,⛔ 别拿本文件的输出去匹配。
//
// 认得出的几类(按 KINDS 顺序判,先中先得)换一句人话,原话照旧跟在括号里;认不出的原样透出,
// 只加「出错:」前缀 —— 后端大部分错误本来就是中文人话,要翻的只是库层漏上来的那几种形。
//
// 出口:
//   - `errText(e)`   —— 文案里**没有**上下文前缀时用(裸 `String(e)` 那种);
//   - `errDetail(e)` —— 文案已带「…失败:{error}」前缀时用,认不出就原样(免得「失败:出错:…」);
//   - `errHtml(e)`   —— `errText` 的 innerHTML 形(已转义),认得出且有下一步的后面挂一枚钮;
//   - `showErr(e)`   —— 顶部错误提示条的形,同上挂钮。
// 那枚钮今天只有「连不上」一类有(→ 设置里的「诊断」面,网络栈诊断在那儿);它开哪一面由
// main 在 `initErr` 里交进来(`openPane` 住 main,本文件引它会绕成环)。
import { t } from "./i18n";
import { errorActionBar, esc, showError } from "./ui";

// `text` 写成函数:文案门禁按字面量核键,且语言在运行期定。
type Kind = { test: RegExp; text: () => string; next: "probe" | null };

// 匹配面 = 桌面 src/err.ts 的 KINDS 逐条照抄(同一个 core 造的错,两端原话同形);注释只留
// 手机这侧多出来的事,各类的来由看桌面那份。⛔ 改一边就改两边。
const KINDS: Kind[] = [
  {
    // 拨号 / 读写 / 超时 / 被关。os error 码在手机上走 Unix 那组(101 / 104 / 110 / 111 / 113)。
    test: /连不上服务器|连接服务器超时|等服务器响应超时|连接被服务器关闭|连接错误|发起配对超时|获取设备名单超时|服务器未在预期时间内回执|\(os error (100(5[0134]|6[0145])|1100[124]|10[14]|11[013])\)|error sending request|dns error/,
    text: () => t("err.net"),
    next: "probe",
  },
  {
    test: /已吊销|本设备未注册|不被承认|不在本账户的设备名单/,
    text: () => t("err.revoked"),
    next: null,
  },
  {
    test: /constraint failed/i,
    text: () => t("err.conflict"),
    next: null,
  },
  {
    test: /不存在|已删除|已不在|Query returned no rows/,
    text: () => t("err.gone"),
    next: null,
  },
];

function kindOf(s: string): Kind | undefined {
  return KINDS.find((k) => k.test.test(s));
}

/** 文案里没有上下文前缀时用:认得出 = 人话 +(原文),认不出 = 「出错:」+ 原文。 */
export function errText(e: unknown): string {
  const s = String(e);
  const k = kindOf(s);
  return k ? k.text() + t("err.raw", { raw: s }) : t("err.unknown", { raw: s });
}

/** 文案已带「…失败:」前缀时用:认得出 = 人话 +(原文),认不出 = 原文原样。 */
export function errDetail(e: unknown): string {
  const s = String(e);
  const k = kindOf(s);
  return k ? k.text() + t("err.raw", { raw: s }) : s;
}

function hasProbe(e: unknown): boolean {
  return kindOf(String(e))?.next === "probe";
}

/** `errText` 的 innerHTML 形(已转义);认得出且有下一步的,文字后面挂一枚 `.err-next` 钮
 *  (点击走 `initErr` 装的那一只委托监听,各面的 innerHTML 不用各自接线)。 */
export function errHtml(e: unknown): string {
  const text = esc(errText(e));
  return hasProbe(e)
    ? `${text} <button type="button" class="err-next" data-err-next>${esc(t("err.probeNext"))}</button>`
    : text;
}

let openProbe: (() => void) | null = null;

/** 顶部错误提示条:`errText` 那句;「连不上」一类条上多一枚「网络诊断」。 */
export function showErr(e: unknown): void {
  if (!hasProbe(e)) {
    showError(errText(e));
    return;
  }
  const go = openProbe;
  if (!go) throw new Error("err.ts:initErr 没调过就出了「连不上」的错");
  errorActionBar(errText(e), t("err.probeNext"), go);
}

/** main 启动时调一次:交进「打开诊断面」,并装 `.err-next` 的委托监听(捕获期,免被各面自己
 *  的委托 stopPropagation 截走)。 */
export function initErr(open: () => void): void {
  openProbe = open;
  document.addEventListener(
    "click",
    (ev) => {
      if ((ev.target as Element | null)?.closest?.("[data-err-next]")) open();
    },
    true,
  );
}
