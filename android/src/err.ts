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
// ⭐ 诊断要测**刚才连不上的那台**(用户面 137:此前恒测默认服务器,填错地址也六格全绿):
// 创号 / 加入这类「地址是用户刚填的」路,`showErr` 第二参把那个地址带过去;其余交 `null`,
// 由 main 取当前空间已配置的服务器。
import { t } from "./i18n";
import { errorActionBar, esc, showError } from "./ui";

// `text` 写成函数:文案门禁按字面量核键,且语言在运行期定。拿到的是那条正则的匹配(要从原话里摘名字的那几类用)。
// `bare` = 人话已经把原话说全了、原话里只剩内部词(如配对码的「槽号」),不再挂「(原文:…)」。
type Kind = { test: RegExp; text: (m: RegExpExecArray) => string; next: "probe" | null; bare?: true };

/** 原话里摘出来的空间名 → 这一端屏上那个叫法(main 在 `initErr` 里交进来;core 给的是名字、「默认空间」或空间 id)。 */
let spaceLabelOf: (raw: string) => string = (raw) => raw;

// 匹配面 = 桌面 src/err.ts 的 KINDS 逐条照抄(同一个 core 造的错,两端原话同形);注释只留
// 手机这侧多出来的事,各类的来由看桌面那份。⛔ 改一边就改两边。
//
// 161 / W4 A8(WM-13 / WM-26 / WP-16):「连不上」那一族按原话拆开 —— 地址打错、服务器没开、超时、网络不通、
// 连上之后断了,各说各的(此前一律「没连上服务器,或者连接中途断了」,从没连上也说「中途断了」)。
// **按顺序判、先中先得**,顺序就是判据的一部分:
//  ① 会话里断的(`连接错误:` / `连接被服务器关闭` / 会话循环那句光秃秃的 `连接断开`)排第一 —— 连上过才会有这几句,
//     后面括号里哪怕带着「超时 / 被重置」也是「断了」;⛔ `连接断开,未能确认是否已生效` 那类**不收**(命令可能已经执行了,
//     原话本身就是人话,同桌面);
//  ② 其余都是**拨号**那一下(`连不上服务器:` / `连接服务器超时:` / 配对 / 名单那几条超时)按原因分;认不出原因的拨号失败落
//     「连不上服务器」那句(看地址、看服务器、看网络),⛔ 别把它说成「断了」。
// 原话的样子是 V1986A(安卓 12)上真造出来量的:打错域名 = `failed to lookup address information: No address associated
// with hostname`(⚠ 没联网时 DNS 不报这句、而是 10 秒拨号超时 `连接服务器超时:…`);端口上没服务 = `Connection refused
// (os error 111)`;不可达地址 = `连接服务器超时:ws://…`。os error 码两套都认:Unix(安卓 / 鸿蒙)101 / 104 / 110 / 111 / 113 / 32,
// Windows 10050 / 10051 / 10053 / 10054 / 10060 / 10061 / 10064 / 10065 与 11001 / 11002 / 11004(桌面照抄这一份)。
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
    // 拨号失败、原因认不出(如隧道那头没人时的 `Handshake not finished`),以及更新检查那条 HTTP 的形。
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

/** 服务器不认这台设备(transport.rs human_err 的 AUTH_FAILED / UNKNOWN_DEVICE 两形 + 局域网名册判死那句)。 */
const REVOKED = /已吊销|本设备未注册|不被承认|不在本账户的设备名单/;

const KINDS: Kind[] = [
  ...NET_KINDS,
  {
    test: REVOKED,
    text: () => t("err.revoked"),
    next: null,
  },
  // 161 / W4 A42(WP-03 / WP-10 / X-05):配对码出错,两条原话(输错一位时对端中止 / 码不存在或过期)说同一套人话,
  // 下一步都是「回出码的那台重新出码」;「无效或已过期」另加 Q3 那半句 —— 服务器填错时报的也是这一句。
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
  // A27(WM-21 / WD-30):码的样子不对 —— 别说「槽号」,直接说长什么样(core pair.rs 的 PairCodeError 三形)。
  // 原话里除了「槽号」只剩「读到 N 个」,人话已经说全 ⇒ 不挂原文;有不该有的字那一形把那个字点出来。
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
  // A41(互配新撞-2):被移出账户的这台不重置、直接输码重新加入同一个账户 —— core / coord 的原话是「这个账户已被空间「X」
  // 使用——空间=账户,一空间一账户」(内部说法,也不说该先重置)。⛔ 只认「已被空间」那一形:「正在(或刚刚)被「加入空间」使用」
  // 是另一件事(加入还在跑),照原话。
  {
    test: /这个账户已被空间「([^」]*)」使用/,
    text: (m) => t("err.accountInUse", { name: spaceLabelOf(m[1]) }),
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

/** 服务器拒了这台(被移出账户 / 账户被停用;core `AUTH_FAILED` 那句与名册判死那几句)。同步面拿它认「这台已不在账户里」(Q12)。 */
export function isRevoked(e: unknown): boolean {
  return REVOKED.test(String(e));
}

/** 服务器说「刚答过,别催」(名册 5 秒一枚的闸;core 把 `busy` 译成「服务器繁忙,稍后再试」)。
 *  设备名单的「刷新」拿它判:撞上它 = 名单是几秒前刚取的,不是出错(161 / W4 A14,互配新撞-4)。 */
export function isBusy(e: unknown): boolean {
  return /服务器繁忙/.test(String(e));
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

function hasProbe(e: unknown): boolean {
  return kindOf(String(e))?.k.next === "probe";
}

/** `errText` 的 innerHTML 形(已转义);认得出且有下一步的,文字后面挂一枚 `.err-next` 钮
 *  (点击走 `initErr` 装的那一只委托监听,各面的 innerHTML 不用各自接线)。
 *  `url` = 这次连的是哪台(161 / W4 Q4:建账户表单里留着的那句,自检要测**刚填的那个地址**,同 `showErr` 第二参);
 *  不给 = 测当前空间已配置的那台。 */
export function errHtml(e: unknown, url: string | null = null): string {
  // 161 / W4 A8(WP-16 后半):认得出的那几类,人话与原文分两层 —— 原文那半降一档(`.err-raw`),此前同色同层夹在一起。
  const s = String(e);
  const k = kindOf(s);
  const text = k
    ? `${esc(k.k.text(k.m))}${k.k.bare ? "" : `<span class="err-raw">${esc(rawTail(k.k, s))}</span>`}`
    : esc(t("err.unknown", { raw: s }));
  const at = url === null ? "" : ` data-err-url="${esc(url)}"`;
  return hasProbe(e)
    ? `${text} <button type="button" class="err-next" data-err-next${at}>${esc(t("err.probeNext"))}</button>`
    : text;
}

/** 打开诊断面并测 `url`;`null` = 测当前空间已配置的那台(main 定)。 */
type OpenProbe = (url: string | null) => void;
let openProbe: OpenProbe | null = null;

/** 顶部错误提示条:`errText` 那句;「连不上」一类条上多一枚「网络自检」。
 *  `url` = 这次连的是哪台(只有地址是用户刚填的那几条路给;见文件头)。 */
export function showErr(e: unknown, url: string | null = null): void {
  if (!hasProbe(e)) {
    showError(errText(e));
    return;
  }
  const go = openProbe;
  if (!go) throw new Error("err.ts:initErr 没调过就出了「连不上」的错");
  errorActionBar(errText(e), t("err.probeNext"), () => go(url));
}

/** main 启动时调一次:交进「打开诊断面」,并装 `.err-next` 的委托监听(捕获期,免被各面自己
 *  的委托 stopPropagation 截走)。钮上带了 `data-err-url` 就测那台,否则交 `null`(已配置空间的状态 / 名册那几处)。
 *  `labelOf` = 原话里摘出来的空间名 → 屏上的叫法(A41;main 按空间列表翻,认不出原样)。 */
export function initErr(open: OpenProbe, labelOf: (raw: string) => string): void {
  openProbe = open;
  spaceLabelOf = labelOf;
  document.addEventListener(
    "click",
    (ev) => {
      const b = (ev.target as Element | null)?.closest?.<HTMLElement>("[data-err-next]");
      if (b) open(b.dataset.errUrl ?? null);
    },
    true,
  );
}
