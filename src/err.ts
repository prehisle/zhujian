// 错误文案人话前置(盈利准备 C8;ui-guidelines §4.3「前半句必须是人能懂的一句话,原始错误可
// 保留在后半句」)。**纯展示映射**:⛔ 不吞错、不重试、不改任何行为 —— 调用方照旧在自己的
// catch 里做它原本做的事,只是把 `String(e)` 换成这里的一个函数。
//
// 认得出的几类(按下面 KINDS 的顺序判,先中先得)换一句人话,原话照旧跟在括号里;认不出的
// 原样透出,只加「出错:」前缀 —— 后端大部分错误本来就是中文人话(「灵感不存在」「该列还有
// 未归档条目…」),这里要翻的只是库层漏上来的那几种形(rusqlite 的英文、tungstenite 的 IO
// 错误、os error 码)和几类「换个说法用户才知道该干嘛」的。
//
// 出口:
//   - `errText(e)`   —— 调用方的文案里**没有**上下文前缀时用(裸 `String(e)` 那种);
//   - `errDetail(e)` —— 文案已经带了「重命名失败:{err}」这类前缀时用,认不出就原样,
//                       免得出现「重命名失败:出错:…」。
//   - `errNode(e)`   —— `errText` 的 DOM 形:前面一枚「!」圆(CSS,`.err-msg::before`)、人话在前、原文降一档
//                       (`.err-raw`);认得出且有下一步可走的那几类后面挂一枚可点的钮(今天只有「连不上」
//                       → 设置「关于」里的网络自检)。
// 拿原话做判断的(如 sync.ts 的 SEAT_LIMIT_MARK、`isRevoked`)照旧用 `String(e)`,⛔ 别拿本文件的输出去匹配。
import { t } from "./i18n";
import "./err.css";

// `text` 写成函数:文案门禁按字面量核键(`t(k.text)` 那种动态调用它核不了),且语言在运行期定。拿到的是那条正则的匹配
// (要从原话里摘名字 / 字的那几类用)。`bare` = 人话已经把原话说全了、原话里只剩内部词(如配对码的「槽号」),不再挂「(原文:…)」。
type Kind = { test: RegExp; text: (m: RegExpExecArray) => string; next: "probe" | null; bare?: true };

/** 原话里摘出来的空间名 → 这台屏上那个叫法(notebook.ts 在拿到空间列表后交进来;core / 壳给的是名字、「默认空间」或空间 id)。 */
let spaceLabelOf: (raw: string) => string = (raw) => raw;

/** notebook.ts 每次拉完空间列表调一次(A41:「这个账户已被空间「X」使用」里的 X 换成屏上的叫法)。 */
export function setErrSpaceLabel(labelOf: (raw: string) => string): void {
  spaceLabelOf = labelOf;
}

// 161 / W4 A8(WD-10 / WP-16):「连不上」那一族按原话拆开 —— 地址打错、服务器没开、超时、网络不通、连上之后断了,各说各的
// (此前一律「没连上服务器,或者连接中途断了」,从没连上也说「中途断了」)。**与手机 android/src/err.ts 的 NET_KINDS
// 同键、同值、同正则、同顺序**(两端同一个 core 造的错,原话同形;键值两端逐字同由 check-i18n-drift 的 CROSS_END_KEYS 核)。
// **按顺序判、先中先得**,顺序就是判据的一部分:
//  ① 会话里断的(`连接错误:` / `连接被服务器关闭` / 会话循环那句光秃秃的 `连接断开`)排第一 —— 连上过才会有这几句,
//     后面括号里哪怕带着「超时 / 被重置」也是「断了」;⛔ `连接断开,未能确认是否已生效` 那类**不收**(命令可能已经执行了,
//     原话本身就是人话);
//  ② 其余都是**拨号**那一下(`连不上服务器:` / `连接服务器超时:` / 配对 / 名单那几条超时)按原因分;认不出原因的拨号失败落
//     「连不上服务器」那句(看地址、看服务器、看网络),⛔ 别把它说成「断了」。
// os error 码两套都认:Unix 101 / 104 / 110 / 111 / 113 / 32,Windows 10050 / 10051 / 10053 / 10054 / 10060 / 10061 / 10064 / 10065
// 与 11001 / 11002 / 11004(走查读数:打错主机 = `不知道这样的主机。 (os error 11001)`,服务器没开 = `积极拒绝,无法连接。
// (os error 10061)`)。
const NET_KINDS: Kind[] = [
  {
    test: /连接错误|连接被服务器关闭|^连接断开$/,
    text: () => t("err.netDropped"),
    next: "probe",
  },
  {
    test: /failed to lookup address|No address associated with hostname|Name or service not known|nodename nor servname|dns error|\(os error 1100[124]\)/,
    text: () => t("err.netDns"),
    next: "probe",
  },
  {
    test: /Connection refused|\(os error (111|10061)\)/,
    text: () => t("err.netRefused"),
    next: "probe",
  },
  {
    test: /Network is unreachable|No route to host|Host is down|\(os error (101|113|1005[01]|1006[45])\)/,
    text: () => t("err.netUnreachable"),
    next: "probe",
  },
  {
    test: /连接服务器超时|等服务器响应超时|发起配对超时|获取设备名单超时|服务器未在预期时间内回执|timed out|\(os error (110|10060)\)/,
    text: () => t("err.netTimeout"),
    next: "probe",
  },
  {
    // 拨号失败、原因认不出,以及更新检查那条 HTTP 的形(`error sending request`)。
    test: /连不上服务器|error sending request/,
    text: () => t("err.net"),
    next: "probe",
  },
  {
    // 拨号那一句之外漏上来的「连接被重置 / 管道断了」:连上过才会被重置 ⇒ 算断了。
    test: /Connection reset|Broken pipe|\(os error (32|104|1005[34])\)/,
    text: () => t("err.netDropped"),
    next: "probe",
  },
  {
    // 离线时点了要连着服务器才能做的事(core `offline_wait` 的回执)。
    test: /未连接服务器\(重连中\)/,
    text: () => t("err.offlineNow"),
    next: "probe",
  },
];

/** 服务器不认这台设备(transport.rs human_err 的 AUTH_FAILED / UNKNOWN_DEVICE 两形 + 局域网名册判死那句)。
 *  下一步在同步浮层里,而这类错误本来就显在同步浮层上 ⇒ 不挂钮。 */
const REVOKED = /已吊销|本设备未注册|不被承认|不在本账户的设备名单/;

const KINDS: Kind[] = [
  ...NET_KINDS,
  {
    test: REVOKED,
    text: () => t("err.revoked"),
    next: null,
  },
  // 161 / W4 A42(WP-03 / WP-10 / X-05):配对码出错(这台是**输码**的那台),两条原话(输错一位时对端中止 / 码不存在或过期)
  // 说同一套人话,下一步都是「回出码的那台重新出码」;「无效或已过期」另加 Q3 那半句 —— 服务器填错时报的也是这一句。(同手机)
  {
    test: /配对被对端中止/,
    text: () => t("err.pairAborted"),
    next: null,
  },
  {
    test: /配对码无效或已过期/,
    text: () => t("err.pairBadCode"),
    next: null,
  },
  // A27(WD-30 / WM-21):码的样子不对 —— 别说「槽号」,直接说长什么样(core pair.rs 的 PairCodeError 三形)。
  // 原话里除了「槽号」只剩「读到 N 个」,人话已经说全 ⇒ 不挂原文;有不该有的字那一形把那个字点出来。(同手机)
  {
    test: /配对码含无效字符「(.+?)」/,
    text: (m) => t("err.pairCodeChar", { c: m[1] }),
    next: null,
    bare: true,
  },
  {
    test: /配对码开头应是|配对码长度不对/,
    text: () => t("err.pairCodeShape"),
    next: null,
    bare: true,
  },
  // A41(互配新撞-2):被移出账户的那一本不重置、直接输码重新加入同一个账户 —— 原话「这个账户已被空间「X」使用——空间=账户,
  // 一空间一账户」(内部说法,也不说该先重置)。桌面壳 `account_free_desktop` / `account_taken_by_other` 两句同这一形(后一句
  // 多半截「要同步这个空间就直接创建新账户…」,也是内部说法,一并换)。⛔ 只认「已被空间」那一形:「正在(或刚刚)被「加入空间」
  // 使用」是另一件事(加入还在跑),照原话。(同手机)
  {
    test: /这个账户已被空间「([^」]*)」使用/,
    text: (m) => t("err.accountInUse", { name: spaceLabelOf(m[1]) }),
    next: null,
  },
  // A42 / A41 出码那台(这台是**出码**的那台;core 发 `sync-pair` failed 的 detail):对方输错 / 对方没加入就走了 / 码过期,
  // 各说各的,下一步都是「点『重新出码』让对方输新码」。⚠ 「对方离开」**不是**「码不对」:被移出后没重置就来加入的那台,在它那边
  // 被账户闸拦下后关槽走人,这台收到的就是这一句 —— 原因看对方屏上怎么说(手机那句 err.accountInUse 写得清)。原话是内部说法
  // (「对端」),人话说全了 ⇒ 不挂原文。
  {
    test: /配对码校验不过/,
    text: () => t("err.pairMismatch"),
    next: null,
    bare: true,
  },
  {
    test: /对方离开/,
    text: () => t("err.pairPeerLeft"),
    next: null,
    bare: true,
  },
  {
    test: /配对超时\(/,
    text: () => t("err.pairExpired"),
    next: null,
    bare: true,
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

function kindOf(s: string): { k: Kind; m: RegExpExecArray } | undefined {
  for (const k of KINDS) {
    const m = k.test.exec(s);
    if (m) return { k, m };
  }
  return undefined;
}

/** 人话后面挂的「(原文:…)」;`bare` 那几类不挂。 */
function rawTail(k: Kind, s: string): string {
  return k.bare ? "" : t("err.raw", { raw: s });
}

/** 服务器拒了这台(被移出账户 / 账户被停用;core `AUTH_FAILED` 那句与名册判死那几句)。sync-gone.ts 拿它认「这台已不在账户里」(Q12)。 */
export function isRevoked(e: unknown): boolean {
  return REVOKED.test(String(e));
}

/** 文案里没有上下文前缀时用:认得出 = 人话 +(原文),认不出 = 「出错:」+ 原文。 */
export function errText(e: unknown): string {
  const s = String(e);
  const k = kindOf(s);
  return k ? k.k.text(k.m) + rawTail(k.k, s) : t("err.unknown", { raw: s });
}

/** 文案已带「…失败:」前缀时用:认得出 = 人话 +(原文),认不出 = 原文原样。 */
export function errDetail(e: unknown): string {
  const s = String(e);
  const k = kindOf(s);
  return k ? k.k.text(k.m) + rawTail(k.k, s) : s;
}

/** `errText` 的 DOM 形(161 / W4 A8,WP-16 后半 / 清单 C 那条规矩「错误条一律带图标,『出错:』只给认不出的」):
 *  前面一枚「!」圆(`.err-msg::before`,不进文字)、人话在前、原文降一档(`.err-raw`,此前同色同层夹在一起);
 *  认得出且有下一步的,后面挂一枚可点的钮。
 *  `url` = 这次连的是哪台 —— 自检要测**刚才连不上的那台**(用户面 137:此前恒填默认服务器);
 *  只有地址是用户刚填的那几条路(创号 / 加入 / 改服务器)给,其余由自检那格取当前空间已配置的。 */
export function errNode(e: unknown, url: string | null = null): HTMLElement {
  const s = String(e);
  const k = kindOf(s);
  const box = document.createElement("span");
  box.className = "err-msg";
  if (k) {
    box.append(k.k.text(k.m));
    const tail = rawTail(k.k, s);
    if (tail) {
      const r = document.createElement("span");
      r.className = "err-raw";
      r.textContent = tail;
      box.append(r);
    }
  } else {
    box.append(t("err.unknown", { raw: s }));
  }
  if (k?.k.next === "probe") {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "err-next";
    b.textContent = t("err.probeNext");
    // 动态 import:settings → about → sync → 本文件,静态引会绕成环(settings 本就被 main
    // 静态引着,这里不会多出一个包)。
    b.addEventListener("click", () => void import("./settings").then((m) => m.openSettingsPanel("about", url)));
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
