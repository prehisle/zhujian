// 多语言(358 第②笔,i18n-plan):界面语言 zh / en。桌面 src/i18n.ts 的安卓孪生——
// 机制形逐条一致(zh/en 并排字典分片、生效语言在**模块求值时**就定好、壳里保留中文
// 原文防首帧闪、占位符缺失当场 throw),只去掉跨窗那一段:手机端只有一个 WebView,
// 改档 = 存 + 本窗 reload,没有第二个窗要通知,故不需要 Tauri 事件(本模块因此零 import
// 依赖,check-filter-parity 把筛选函数体切出来单跑时也带得动)。
//
// 纯设备本地:localStorage 记忆、**不进同步**(与明暗 250 / 字号 251 / 桌面语言同一条
// 规矩)——语言是这块屏幕的属性,不是账户的属性。缺省 = 跟系统(navigator.language 以
// zh 开头 → 中文,其余 → 英文)。
import { messages, type MsgKey } from "./locales";

export type Lang = "zh" | "en";
export type LangChoice = Lang | "auto";

const KEY = "zhujian.lang";

function readChoice(): LangChoice {
  const raw = localStorage.getItem(KEY);
  return raw === "zh" || raw === "en" ? raw : "auto";
}

function resolve(choice: LangChoice): Lang {
  if (choice !== "auto") return choice;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 本次加载生命期内不变:改档一律走 reload,不存在「半屏旧语言半屏新语言」。 */
const lang: Lang = resolve(readChoice());

export function currentLang(): Lang {
  return lang;
}

export function currentLangChoice(): LangChoice {
  return readChoice();
}

/**
 * 复数选择器 `{n|单数|复数}`(363,与桌面同一条语法):只负责**选词**,数字仍由 `{n}`
 * 自己打印 —— 故「数词与名词隔着别的词」与主谓一致同一条语法都盖得住。中文没有复数,
 * zh 侧一律不写这种形(门禁两个方向都核)。
 */
const PLURAL = /\{([A-Za-z0-9_]+)\|([^|{}]*)\|([^|{}]*)\}/g;

/** 取文案。键写错是编译红(MsgKey);占位符缺失当场 throw(绝不回退兜底)。 */
export function t(key: MsgKey, params?: Record<string, string | number>): string {
  const entry = messages[key];
  if (!entry) throw new Error(`i18n:未知键「${key}」(字典分片漏收进 locales/index?)`);
  let text = entry[lang];
  const args = params ?? {};
  // 先选词再填数:选词分支里含的是词不是占位符,填数在后不会把它们当坑填。
  text = text.replace(PLURAL, (_m, name: string, one: string, many: string) => {
    if (!(name in args)) throw new Error(`i18n:「${key}」的复数选择器 {${name}|…} 没收到 ${name}`);
    return Number(args[name]) === 1 ? one : many;
  });
  for (const [name, value] of Object.entries(args)) {
    const ph = `{${name}}`;
    // 「只用来选词、不打印数字」的参数这里会响亮地炸 —— 而门禁钉死了选择器的名字必须
    // 同时被打印(否则那种错只在英文档下才炸,而 e2e/CDP 全跑中文、兜不住),故不留豁免。
    if (!text.includes(ph)) throw new Error(`i18n:「${key}」的 ${lang} 文案缺占位符 {${name}}`);
    text = text.split(ph).join(String(value));
  }
  return text;
}

/** 启动时调一次:<html lang> 落生效值(壳里写的是 zh-CN 原文那一份)。 */
export function initLang(): void {
  document.documentElement.lang = lang;
}

/** 设置面改档:记住 → 生效语言真变了才 reload(auto↔同解析语言时零动作)。 */
export function setLangChoice(next: LangChoice): void {
  if (next === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  if (resolve(next) !== lang) location.reload();
}

/**
 * 覆写壳层静态文案(i18n-plan §1):markup 里保留中文原文防首帧闪(163 契约),
 * 启动时按 data-i18n 族属性统一覆写;原文与 zh 字典的逐字相等由 check-i18n-drift 核。
 */
export function applyStaticI18n(root: ParentNode = document): void {
  const keyOf = (el: Element, attr: string): MsgKey => {
    const key = el.getAttribute(attr);
    if (!key || !(key in messages)) throw new Error(`i18n:${attr}=「${key}」不在字典里`);
    return key as MsgKey;
  };
  for (const el of root.querySelectorAll("[data-i18n]")) {
    // textContent 覆写会吞掉子元素:data-i18n 只许挂在纯文本元素上(门禁也静态核)。
    if (el.childElementCount > 0) throw new Error(`i18n:data-i18n 元素 <${el.tagName}> 带子元素`);
    el.textContent = t(keyOf(el, "data-i18n"));
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(keyOf(el, "data-i18n-title")));
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(keyOf(el, "data-i18n-aria-label")));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.setAttribute("placeholder", t(keyOf(el, "data-i18n-placeholder")));
}
