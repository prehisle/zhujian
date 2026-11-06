// **鸿蒙那一份 `@tauri-apps/plugin-opener`**(W5 A54)。`ohos/vite.config.ts` 的 opener 接缝把
// 共用前端(`android/src/**`、`shared/**`)里所有 `import … from "@tauri-apps/plugin-opener"` 改指到
// 本文件 ⇒ 「关于」三行、长文里的链接、意见反馈那一框 —— 共用前端那几处 `openUrl(...)` 一行不改。
//
// ⭐ **为什么不能用真插件**:它的 Rust 那半在这一端编译目标是 linux、去调 `xdg-open`,鸿蒙上没有这个
// 程序,`openUrl` 恒错(平台事实②,651 真机实撞 `os error 2`)。拉起浏览器 / 邮件只有 ArkTS 够得着
// ⇒ 走壳里那座桥(`shell/OpenerBridge.ets`,挂在 `ZhujianXComponent.bridges()`)。
//
// **形**同扫码(`platform.ts::scanQrContent`):页面调 `window.__zhujianOpener.open(id, url)` 发令
// (ArkWeb 的异步接口拿不到返回值),成败由壳经 `runJavaScript` 回推到 `window.__zhujianOpenerDone`。
// `id` 是本文件发的号:连点几下各自回各自的 Promise。
//
// ⛔ **只导出共用前端真在用的名字**。接缝在构建期把共用前端从这个包导入的名字与本文件的导出逐个比,
// 少一个就当场红(否则真机上运行期才报 `not a function`)。

/** 与壳 `OpenerBridge.ets` 的 `OpenOutcome` 逐字对应,改一边就改另一边。 */
type OpenOutcome = { id: number; ok: boolean; code?: number; message?: string };

declare global {
  interface Window {
    __zhujianOpener?: { open(id: number, url: string): void };
    __zhujianOpenerDone?: (out: OpenOutcome) => void;
  }
}

const inFlight = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
let nextId = 1;

/**
 * 把网址交给系统:`http(s)://` 拉起系统浏览器,`mailto:` 拉起邮件应用(壳里各走一条系统认的路)。
 * 签名照真插件(`openUrl(url, openWith?)`);`openWith` 这一端没有对位物 ⇒ 给了就响亮拒,不悄悄忽略。
 */
export function openUrl(url: string | URL, openWith?: string): Promise<void> {
  if (openWith !== undefined) {
    return Promise.reject(new Error(`这一端不支持指定打开方式(openWith=${openWith})`));
  }
  const bridge = window.__zhujianOpener;
  // ⛔ 响亮:桥缺席 = 壳没接上(`ZhujianXComponent.bridges()` 没跑到),不是「这一端打不开网址」。
  if (!bridge) return Promise.reject(new Error("壳没接上外链桥(window.__zhujianOpener 缺席)"));
  const id = nextId++;
  return new Promise<void>((resolve, reject) => {
    inFlight.set(id, { resolve, reject });
    bridge.open(id, String(url));
  });
}

window.__zhujianOpenerDone = (out) => {
  const p = inFlight.get(out.id);
  if (!p) return; // 不是本页发的号(页面重载过):没人等它
  inFlight.delete(out.id);
  if (out.ok) p.resolve();
  // 原话照转(系统给的是英文原话 + 错误码,如没有能接 mailto 的应用 = 16000019),人话前缀由 `showErr` 那层加。
  else p.reject(new Error(`openUrl failed (${out.code ?? "?"}): ${out.message ?? ""}`));
};
