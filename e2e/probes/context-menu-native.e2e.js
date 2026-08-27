import { $, browser, expect } from "@wdio/globals";
import { execFileSync } from "node:child_process";
import { invoke, goNotebook } from "../specs/support.js";

// 按需探针(默认套件扫不到,要 --spec 点名)。目标:真鼠标右键时,WebView2 那份
// 「返回 / 刷新 / 另存为 / 打印 / 检查」原生菜单还弹不弹。
//
// ⚠⚠ **执行态(504,如实记):②过了,①没验成。**
//   ②(阴性对照,列体空白处)**已成立** —— 真 OS 右键打在被测进程自己的窗口上,原生菜单
//     照常弹出(截图 `.zjshots/504-real-rclick-blank.png` 拍到了那五项)。它同时证明:
//     我们那个 `contextmenu` 处理**没有全局吞掉右键**,让位行为在真鼠标下是成立的。
//   ①(卡片上右键)**没验成**,⛔ 但**不是产品红** —— 截图里被测窗口停在「随记」视图而不是
//     看板(`goNotebook("board")` 调了两次仍如此,根因**没查**),右键因此落在空白处、
//     卡片根本不在那儿。今天它标 skip:⛔ 别把它读成「验过了」,也别读成「有缺陷」。
//   ⇒ **剩下这一格今天只有真鼠标能答**:人在卡片上右键一次,看还弹不弹「刷新/另存为」。
//
// 下次接手从这三条起(都是本轮真栽出来的,别重踩):
//   1. ⛔ **`performActions` 的右键不算数** —— 那是 CDP 在渲染器里合成的,不是 OS 输入。
//      右键必须走 PowerShell 的 `mouse_event`。
//   2. ⛔ **`window.screenX/screenY` 在这台机器上不可信** —— 实测报 screenY=2540,而虚拟屏
//      才 1440 高,按它算的绝对坐标每次都落在屏幕外。窗口原点要从 OS 的 GetWindowRect 拿。
//   3. ⛔ **`WindowFromPoint` 的 pid 不是壳的 pid** —— 它返回最深的子窗口,而 Tauri 窗口里
//      那层是 WebView2 的渲染面、属于 `msedgewebview2.exe`。**必须先 `GetAncestor(GA_ROOT)`**
//      再取 pid,否则「打中了」也会被判成「打偏了」(为这条白追了三轮坐标)。
//   4. ⚠ 还没解释的一格:`GetWindowRect` 报 1056x719,而页面 `innerWidth/Height` 报
//      1100x800 —— 客户区不可能比窗口大,两者对不上。①的偏移换算就卡在这儿。
//   5. ⚠ 本机可能同时跑着两个朱简(e2e 的 debug + 用户装的正式版)。第一版让 PowerShell
//      自己按进程名找窗口,它挑中了**用户那个旧版**、还把它抬到被测窗口之上 ⇒ 右键落在旧
//      二进制上、弹出原生菜单,看起来活像「改动没生效」。现在按 pid 锁定 + 断言 target-pid。
//
// ⛔ 另两条方法学(与上面同等重要):
//   截图只能用 CopyFromScreen —— 原生右键菜单是独立的 native 窗口,`saveScreenshot` 与
//   PrintWindow 都拍不到它。
const PS1 = "G:\\yj2026\\zhujian\\e2e\\probes\\real-right-click.ps1";
const OUT = "G:\\yj2026\\zhujian\\.zjshots";

// pid + **视口内**偏移。⛔ 别改回「页面算绝对屏幕坐标」:这台机器上 WebView2 报的
// window.screenY 是 2540(虚拟屏才 1440 高),按它点每次都落在屏幕外。窗口原点以 OS 的
// GetWindowRect 为准,页面只负责给它自己视口内的偏移。
function realRightClick(pid, dx, dy, name) {
  return execFileSync(
    "powershell",
    [
      "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS1,
      "-TargetPid", String(pid), "-Dx", String(dx), "-Dy", String(dy),
      "-Out", `${OUT}\\${name}.png`,
    ],
    { encoding: "utf8" },
  );
}

describe("探针 · 真鼠标右键与 WebView2 原生菜单(504)", () => {
  let appPid;

  before(async () => {
    await goNotebook("board");
    for (const t of await invoke("list_tasks")) await invoke("archive_task", { id: t.id });
    await invoke("purge_archived_tasks", {});
    await invoke("create_task", { title: "504-native-probe" });
    await goNotebook("board");
    await $(".tcard*=504-native-probe").waitForExist({ timeout: 10000 });
    await browser.setWindowSize(1100, 800);
    await browser.pause(400);
    // 被测进程的 pid:e2e 起的那只 app.exe。PowerShell 报的 target-pid 必须等于它。
    appPid = Number(
      execFileSync("powershell", ["-NoProfile", "-Command",
        "(Get-CimInstance Win32_Process -Filter \"Name='app.exe'\" | Sort-Object CreationDate | Select-Object -Last 1).ProcessId"],
        { encoding: "utf8" }).trim(),
    );
    console.log("[探针] 被测 app.exe pid =", appPid);
  });

  // 页面元素 → **视口内**偏移(窗口原点交给 PowerShell 从 OS 拿)。
  const offset = (sel, ox, oy) =>
    browser.execute(
      (s, dx, dy) => {
        const r = document.querySelector(s).getBoundingClientRect();
        const d = window.devicePixelRatio;
        return { x: Math.round((r.left + dx) * d), y: Math.round((r.top + dy) * d) };
      },
      sel,
      ox,
      oy,
    );

  const focus = () =>
    browser.execute(async () => {
      const w = window.__TAURI__.window.getCurrentWindow();
      await w.setFocus();
    });

  // 见文件头「执行态」:今天过不去的是工装(窗口停在随记视图),不是产品。
  it.skip("①卡片上真右键 → 我们的菜单开,原生菜单不该出现(看图)", async () => {
    const g = await offset(".tcard", 40, 18);
    await focus();
    await browser.pause(300);
    const out = realRightClick(appPid, g.x, g.y, "504-real-rclick-card");
    console.log("[探针①] 视口内偏移", JSON.stringify(g), "|", out.trim().replace(/\s+/g, " "));
    expect(out).toContain(`target-pid: ${appPid}`); // 打错靶当场红
    const ours = await browser.execute(() => !!document.querySelector(".hk-menu"));
    console.log("[探针①] 我们的菜单在不在(该是 true):", ours);
    expect(ours).toBe(true);
    await browser.execute(() => document.body.click());
    await browser.pause(300);
  });

  it("②列体空白处真右键 → 阴性对照:原生菜单该弹出来(看图)", async () => {
    const g = await browser.execute(() => {
      const r = document.querySelector('.col[data-col="doing"] .col-body').getBoundingClientRect();
      const d = window.devicePixelRatio;
      return { x: Math.round((r.left + r.width / 2) * d), y: Math.round((r.top + r.height / 2) * d) };
    });
    await focus();
    await browser.pause(300);
    const out = realRightClick(appPid, g.x, g.y, "504-real-rclick-blank");
    console.log("[探针②] 视口内偏移", JSON.stringify(g), "|", out.trim().replace(/\s+/g, " "));
    expect(out).toContain(`target-pid: ${appPid}`);
    const ours = await browser.execute(() => !!document.querySelector(".hk-menu"));
    console.log("[探针②] 我们的菜单在不在(该是 false):", ours);
    expect(ours).toBe(false);
  });
});
