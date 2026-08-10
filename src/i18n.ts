// 多语言(358,i18n-plan):界面语言 zh / en。语言偏好**纯设备本地、不进同步**
// (localStorage 记忆,与明暗 250 / 字号 241 / 热键 232 同一条规矩):存的不是
// zh / en 就算「自动」、跟系统(navigator.language 以 zh 开头 → 中文,其余 → 英文)。
//
// 生效语言在**模块求值时**就解析好——顶层 `const ROWS = [{ name: t(…) }]` 这类
// import 期求值天然拿到正确语言,不存在「initLang 之前调 t」的时序坑。
// 改档 = 存 + Tauri 事件广播 + 各窗 reload(语言是低频全局属性,活重渲不值;
// 跨窗事件形照 theme-mode——localStorage 的 storage 事件跨 WebView 不保证送到)。
import { emit, listen } from "@tauri-apps/api/event";
import { messages, type MsgKey } from "./locales";

export type Lang = "zh" | "en";
export type LangChoice = Lang | "auto";

const KEY = "zhujian.lang";
const EVENT = "lang-changed";

function readChoice(): LangChoice {
  const raw = localStorage.getItem(KEY);
  return raw === "zh" || raw === "en" ? raw : "auto";
}

function resolve(choice: LangChoice): Lang {
  if (choice !== "auto") return choice;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 本窗生命期内不变:改档一律走 reload,不存在「半窗旧语言半窗新语言」。 */
const lang: Lang = resolve(readChoice());

export function currentLang(): Lang {
  return lang;
}

export function currentLangChoice(): LangChoice {
  return readChoice();
}

/**
 * 复数选择器 `{n|单数|复数}`(363):只负责**选词**,数字仍由 `{n}` 自己打印 ——
 * 故「数词与名词隔着别的词」(`In {n} {n|day|days}`)与主谓一致(`{count|has|have}`)
 * 同一条语法都盖得住。中文没有复数,zh 侧一律不写这种形(门禁两个方向都核)。
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

/** 两个窗口各自在启动时调一次:<html lang> 落生效值 + 听别窗改档。 */
export function initLang(): void {
  document.documentElement.lang = lang;
  void listen<LangChoice>(EVENT, (e) => {
    // 自己发的那份回声也会到:resolve 相同则本窗已是目标语言(或正在 reload),不动。
    if (resolve(e.payload) !== lang) location.reload();
  });
}

/** 设置面板改档:记住 → 广播 → 生效语言变了才 reload(auto↔显式但解析同语言时零动作)。 */
export async function setLangChoice(next: LangChoice): Promise<void> {
  if (next === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
  await emit(EVENT, next); // 先送达再 reload,别让导航掐断 IPC
  if (resolve(next) !== lang) location.reload();
}

/**
 * 覆写壳层静态文案(i18n-plan §1):markup 里保留中文原文防首帧闪(163 契约),
 * 启动时按 data-i18n 族属性统一覆写;原文与 zh 字典逐字相等由门禁核,不靠人记。
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
