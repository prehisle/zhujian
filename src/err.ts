// 错误文案人话前置(盈利准备 C8;ui-guidelines §4.3「前半句必须是人能懂的一句话,原始错误可
// 保留在后半句」)。**纯展示映射**:⛔ 不吞错、不重试、不改任何行为 —— 调用方照旧在自己的
// catch 里做它原本做的事,只是把 `String(e)` 换成这里的一个函数。
//
// 认得出的几类(按下面 KINDS 的顺序判,先中先得)换一句人话,原话照旧跟在括号里;认不出的
// 原样透出,只加「出错:」前缀 —— 后端大部分错误本来就是中文人话(「灵感不存在」「该列还有
// 未归档条目…」),这里要翻的只是库层漏上来的那几种形(rusqlite 的英文、tungstenite 的 IO
// 错误、os error 码)和几类「换个说法用户才知道该干嘛」的。
//
// 两个出口:
//   - `errText(e)`   —— 调用方的文案里**没有**上下文前缀时用(裸 `String(e)` 那种);
//   - `errDetail(e)` —— 文案已经带了「重命名失败:{err}」这类前缀时用,认不出就原样,
//                       免得出现「重命名失败:出错:…」。
//   - `errNode(e)`   —— 同 `errText`,另在认得出、且有下一步可走的那几类后面挂一枚可点的钮
//                       (今天只有「连不上」→ 设置「关于」里的网络自检)。
import { t } from "./i18n";
import "./err.css";

// `text` 写成函数:文案门禁按字面量核键(`t(k.text)` 那种动态调用它核不了),且语言在运行期定。
type Kind = { test: RegExp; text: () => string; next: "probe" | null };

// 匹配面取自后端全部造错点的盘点(core/src/sync/transport.rs 拨号那段、lib.rs 配对 / 名册
// 那几条、notes/task/board/comments/images/move_item 的「不存在」、rusqlite 的约束错),
// ⛔ 别从一两条样本往外推。
const KINDS: Kind[] = [
  {
    // 拨号 / 读写 / 超时 / 被关(同步服务器与更新检查两条都走这里 ⇒ 文案不点名是哪台)。
    // os error 码是 Windows(100xx / 110xx)与 Unix(101 / 104 / 110 / 111 / 113)的「拒绝 /
    // 重置 / 超时 / 不可达 / 解析失败」;`error sending request` 是更新检查那条 HTTP 的形。
    // ⛔ 「连接断开,未能确认是否已生效」那类不收:命令可能已经执行了,原话本身就是人话。
    test: /连不上服务器|连接服务器超时|等服务器响应超时|连接被服务器关闭|连接错误|发起配对超时|获取设备名单超时|服务器未在预期时间内回执|\(os error (100(5[0134]|6[0145])|1100[124]|10[14]|11[013])\)|error sending request|dns error/,
    text: () => t("err.net"),
    next: "probe",
  },
  {
    // 服务器不认这台设备(transport.rs human_err 的 AUTH_FAILED / UNKNOWN_DEVICE 两形 + 局域网
    // 名册判死那句)。下一步在同步面板里,而这类错误本来就显在同步面板上 ⇒ 不挂钮。
    test: /已吊销|本设备未注册|不被承认|不在本账户的设备名单/,
    text: () => t("err.revoked"),
    next: null,
  },
  {
    // rusqlite 的约束错(UNIQUE / CHECK / FOREIGN KEY / NOT NULL … constraint failed)。
    // 触发器 RAISE 的那些是中文人话,不走这里。
    test: /constraint failed/i,
    text: () => t("err.conflict"),
    next: null,
  },
  {
    // 要动的那一条已经没了(多半是另一台设备删 / 移走了,同步刚把结果带过来)。
    test: /不存在|已删除|已不在|Query returned no rows/,
    text: () => t("err.gone"),
    next: null,
  },
];

function raw(e: unknown): string {
  return String(e);
}

function kindOf(s: string): Kind | undefined {
  return KINDS.find((k) => k.test.test(s));
}

/** 文案里没有上下文前缀时用:认得出 = 人话 +(原文),认不出 = 「出错:」+ 原文。 */
export function errText(e: unknown): string {
  const s = raw(e);
  const k = kindOf(s);
  return k ? k.text() + t("err.raw", { raw: s }) : t("err.unknown", { raw: s });
}

/** 文案已带「…失败:」前缀时用:认得出 = 人话 +(原文),认不出 = 原文原样。 */
export function errDetail(e: unknown): string {
  const s = raw(e);
  const k = kindOf(s);
  return k ? k.text() + t("err.raw", { raw: s }) : s;
}

/** `errText` 的 DOM 形:认得出且有下一步的,文字后面挂一枚可点的钮。 */
export function errNode(e: unknown): HTMLElement {
  const box = document.createElement("span");
  box.append(errText(e));
  if (kindOf(raw(e))?.next === "probe") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "err-next";
    b.textContent = t("err.probeNext");
    // 动态 import:settings → about → sync → 本文件,静态引会绕成环(settings 本就被 main
    // 静态引着,这里不会多出一个包)。
    b.addEventListener("click", () => void import("./settings").then((m) => m.openSettingsPanel("about")));
    box.append(" ", b);
  }
  return box;
}

/** 一整行错误(同步面板 / 设备名单那几处的 `.sync-err`):`errNode` 包进一个带类名的块。 */
export function errLine(cls: string, e: unknown, tag: "div" | "p" = "div"): HTMLElement {
  const d = document.createElement(tag);
  d.className = cls;
  d.append(errNode(e));
  return d;
}
