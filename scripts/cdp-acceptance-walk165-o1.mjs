// 165(W5「横切」走查,用户 2026-11-06 全取推荐)鸿蒙壳那组 O1 —— A54「关于」里官网 / 源码 / 更新日志三行 —— 的回归网。
// 驱动形:用户动作一律 `hdc shell uitest uiInput`(真点 / 真划);CDP 只读状态、量坐标,外加**包住**壳里那座桥
// (`window.__zhujianOpener`:记下地址、当场回「成了 / 没成」,不真开浏览器 —— 同 `cdp-acceptance-docs-4b.mjs` 截 opener 那一手)。
//
//   hdc fport tcp:9271 localabstract:webview_devtools_remote_<pid>     # skill zhujian-ohos-verify
//   node scripts/cdp-acceptance-walk165-o1.mjs [--port 9271] [--target 127.0.0.1:5555] [--real]
//
// 逐段(编号对 .zjshots/W5-walk/清单.md):
//  S0  壳那半(ArkTS 挂的 `__zhujianOpener.open`)不在 = 包不对 ⇒ NOT-RUN;页面那半(`ohos/src/opener.ts` 挂的
//      `__zhujianOpenerDone`)不在 = opener 接缝没接上 ⇒ FAIL(阴性刀:拿掉 `ohos/vite.config.ts` 里的 `opener()`,
//      S0 / S2 / S3 一起红,S3 读到的正是真插件那句 `No such file or directory (os error 2)` —— 平台事实②)。
//  S1  A54:设置 →「关于」里三行是可点的链接(`a.about-link`,有下划线、手形),地址 = 官网 / 源码仓 / 官网/changelog.html。
//  S2  A54:真点三行,每点一下桥恰收到一发、地址就是那一行的;页面不导航、顶上不报错。
//  S3  不静默:桥回「没成」(造 16000019 = 没有能接的应用)⇒ 顶上错误条带原话出来(⛔ 不许点了没反应)。
//  S4  (`--real` 才跑)不包桥真点「更新日志」⇒ 前台换成系统浏览器(`aa dump -l`);跑完从图标拉回本 app。
//
// 前置:devtools 包(`build-ohos.mjs --devtools`)、app 在前台、首启告知已同意、界面语言中文、没开任何面。
// 本资产只开设置面、往下划;⛔ 不写库。收尾把桥还回去、收起设置面(返回键)。
//
// 诚实边界:
//  ① 意见反馈那一框(`mailto:`)也走这座桥,但模拟器上没有邮件应用 —— 只量到「16000019 → 顶上报错」那一半(S3 造的就是这一形);
//     真机上拉不拉得起写信,待鸿蒙真机复核。
//  ② 浏览器那头打不打得开网页取决于网络,本资产只认「前台换成了浏览器」。
import { execFileSync } from "node:child_process";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const PORT = Number(arg("--port", 9271));
const TARGET = arg("--target", "127.0.0.1:5555");
const REAL = argv.includes("--real");
const PKG = "app.zhujian.notebook";
// hdc 路径与 `ohos-drive.mjs` / `cdp-run.mjs` 同一个环境变量、同一个默认值。
const hdc = (cmd) =>
  execFileSync(process.env.OHOS_HDC ?? "G:\\ohos-sdk\\toolchains\\hdc.exe", ["-t", TARGET, "shell", cmd], {
    encoding: "utf8",
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  });
const tap = (x, y) => hdc(`uitest uiInput click ${x} ${y}`);

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl);
const ev = (expr) => s.evaluate(expr);
const steps = [];
const step = (name, ok, got) => {
  steps.push({ name, ok: !!ok, got });
  console.error(`${ok ? "✔" : "✗"} ${name}${got === undefined ? "" : "  " + JSON.stringify(got)}`);
};
/** 元素中心的物理像素(uitest 的坐标系 = 截图那一套)。 */
const center = (sel) =>
  ev(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect();
    return { x: Math.round((r.left + r.width / 2) * devicePixelRatio), y: Math.round((r.top + r.height / 2) * devicePixelRatio), top: r.top, bottom: r.bottom, vh: innerHeight }; })()`);
const errBar = () => ev(`(() => { const e = document.getElementById("error"); return e && e.offsetWidth ? e.innerText : null; })()`);

async function main() {
  // S0 —— 桥在不在
  // 壳那半(ArkTS 挂的 `__zhujianOpener`)不在 = 装的包不对 ⇒ NOT-RUN;页面那半(`opener.ts` 挂的 `__zhujianOpenerDone`)
  // 不在 = opener 接缝没接上(共用前端调的是真插件、去调 xdg-open)⇒ 那是产品坏了,判 FAIL 并接着跑(S2 会跟着红)。
  const shellHalf = await ev(`typeof window.__zhujianOpener?.open`);
  if (shellHalf !== "function") return { error: `壳里的外链桥不在(${shellHalf})—— 装的不是 W5 O1 之后的包?` };
  // ⚠ 别的资产(docs-4b)包过这只桥、又没重载页面 ⇒ 这里拿到的是假的,S4 会「点了没开浏览器」地假红。
  if (!(await ev(`String(window.__zhujianOpener.open).includes("[native code]")`))) {
    return { error: "window.__zhujianOpener 被别的资产包着(不是壳挂的那只)—— 先重载页面或重开 app 再跑" };
  }
  const pageHalf = await ev(`typeof window.__zhujianOpenerDone`);
  step("S0 壳把外链桥挂上了、页面那半(opener 接缝)也接上了", pageHalf === "function", { shellHalf, pageHalf });

  // 开设置(真点顶栏「设置」)→ 往下划到「关于」
  const st = await center("#settings-toggle");
  if (!st) return { error: "找不到顶栏「设置」" };
  tap(st.x, st.y);
  await sleep(1500);
  // 906:「关于」是设置的二级页 ⇒ 真点首页「关于」那一行进去(行在首页靠下,先摆进屏内)
  await ev(`(() => { document.querySelector('#settings-pane [data-set-page="set-about"]').scrollIntoView({ block: "center" }); return 1; })()`);
  await sleep(600);
  const ar = await center('#settings-pane [data-set-page="set-about"]');
  if (!ar) return { error: "找不到设置首页「关于」那一行" };
  tap(ar.x, ar.y);
  await sleep(1200);
  // 划动坐标按屏算(869:写死的 1440 是 MatePad 模拟器的屏中,Mate 60 Pro 宽 1260 ⇒ 划在屏外、一下没划,S2–S4 假红)。
  const scr = await ev(`({ w: Math.round(innerWidth * devicePixelRatio), h: Math.round(innerHeight * devicePixelRatio) })`);
  const sx = Math.round(scr.w / 2);
  for (let i = 0; i < 6; i++) {
    const c = await center("#about a.about-link:last-of-type");
    if (c && c.bottom < c.vh - 40 && c.top > 80) break;
    hdc(`uitest uiInput swipe ${sx} ${Math.round(scr.h * 0.6)} ${sx} ${Math.round(scr.h * 0.22)} 1200`);
    await sleep(1200);
  }

  // S1 —— 三行是链接
  const rows = await ev(`[...document.querySelectorAll("#about a.about-link")].map((a) => { const cs = getComputedStyle(a); return { text: a.textContent, href: a.getAttribute("href"), td: cs.textDecorationLine, cur: cs.cursor }; })`);
  const hrefs = rows.map((r) => r.href);
  step(
    "S1 A54「关于」里官网 / 源码 / 更新日志 / 用户指南四行是可点的链接",
    rows.length === 4 &&
      /^https:\/\/zhujian\.(cool|app)$/.test(hrefs[0]) &&
      hrefs[1] === "https://github.com/prehisle/zhujian" &&
      hrefs[2] === `${hrefs[0]}/changelog.html` &&
      hrefs[3] === `${hrefs[0]}/docs/` && // 应用评审二轮 M11:第四行「用户指南」(本改动只在安卓真机验过,鸿蒙这一格待复跑)
      rows.every((r) => r.td.includes("underline") && r.cur === "pointer"),
    rows,
  );

  // 包桥:记地址、按 window.__zjO1Reply 回话(缺省「成了」)
  await ev(`(() => { window.__zjO1Real = window.__zhujianOpener; window.__zjO1Got = []; window.__zjO1Reply = null;
    window.__zhujianOpener = { open(id, url) { window.__zjO1Got.push(url); const r = window.__zjO1Reply;
      setTimeout(() => window.__zhujianOpenerDone(r ? { id, ok: false, code: r.code, message: r.message } : { id, ok: true }), 0); } };
    return window.__zhujianOpener !== window.__zjO1Real; })()`);
  try {
    // S2 —— 真点三行
    const href0 = await ev("location.href");
    const got = [];
    for (let i = 0; i < 4; i++) {
      const c = await center(`#about a.about-link:nth-of-type(${i + 1})`);
      if (!c) return { error: `找不到「关于」第 ${i + 1} 行链接` };
      const n0 = await ev("window.__zjO1Got.length");
      tap(c.x, c.y);
      await sleep(900);
      got.push(await ev(`window.__zjO1Got.slice(${n0})`));
    }
    step(
      "S2 A54 真点四行:每点一下桥恰收到一发、就是那一行的地址",
      got.every((g, i) => g.length === 1 && g[0] === hrefs[i]),
      got,
    );
    step("S2 点完页面没导航、顶上没报错", (await ev("location.href")) === href0 && (await errBar()) === null);

    // S3 —— 桥回「没成」⇒ 顶上报错(不静默)
    await ev(`window.__zjO1Reply = { code: 16000019, message: "No matching ability is found." }, true`);
    const c = await center("#about a.about-link:nth-of-type(3)");
    tap(c.x, c.y);
    await sleep(700);
    const bar = await errBar();
    step("S3 打不开时顶上错误条带原话(不许点了没反应)", typeof bar === "string" && bar.includes("16000019"), bar);
  } finally {
    await ev(`(() => { window.__zhujianOpener = window.__zjO1Real; delete window.__zjO1Real; delete window.__zjO1Got; delete window.__zjO1Reply; return true; })()`);
  }

  // S4 —— 真开浏览器(可选)
  if (REAL) {
    await sleep(7500); // 等 S3 那条错误条自己收
    const c = await center("#about a.about-link:nth-of-type(3)");
    tap(c.x, c.y);
    await sleep(3500);
    // 按任务块认(⛔ 别全文搜 FOREGROUND —— 别的 app 那一块里也有这个词,同 cdp-run.mjs 的 ohosAppState)。
    const fg =
      hdc("aa dump -l")
        .split(/^\s*Mission ID #/m)
        .slice(1)
        .filter((b) => /app state #FOREGROUND/.test(b))
        .map((b) => /bundle name \[([^\]]+)\]/.exec(b)?.[1])[0] ?? null;
    step("S4 真点「更新日志」⇒ 前台换成系统浏览器", fg !== null && fg !== PKG && /browser/.test(fg), fg);
    hdc(`aa start -a EntryAbility -b ${PKG}`);
    await sleep(2000);
  }

  hdc("uitest uiInput keyEvent Back"); // 收起设置面
  return { pass: steps.every((x) => x.ok), steps };
}

const out = await main();
console.log(JSON.stringify(out));
process.exit(out.pass ? 0 : 1);
