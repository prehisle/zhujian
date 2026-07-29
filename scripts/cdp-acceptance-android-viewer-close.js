// 安卓大图查看器的**关闭手感**(246 回归资产)。跑法(需 devtools 包 + 已 forward):
//   adb -s <serial> shell input tap <缩略图坐标>      # 先真机点开一张图(CSS 坐标 ×3.5)
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-android-viewer-close.js
// 本脚本只做**页内取样与合成轻点**;真机手势那半(adb input tap 的单点/连点)另跑,见文件末注。
//
// 立的是 246 二轮那条:轻点关**点下去立刻开始淡出**(`#viewer.closing`),延迟那段留给双击
// 取消、但不再是静止的白等。三条判据缺一不可:
//  ① class 加上了(closingImmediately);② CSS **真的在跑**——中途 opacity 落在 (0,1) 之间
//    (光验 class 会漏掉「选择器写错、opacity 恒 1」这种半截,229 触区那轮同款教训);
//  ③ 关完再开图整层可见(closeViewerNow 摘了 class)——不摘的话下次开图 opacity:0,
//    图在、看不见,是本轮自己埋的坑。
// 双击那半用真机连点验(合成 click 不走原生管线,且双击靠 lastTap 时间差,合成点难对齐)。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const V = () => document.getElementById("viewer");
  const out = {};
  if (V().hidden) return JSON.stringify({ error: "先用 adb input tap 点开一张图再跑" });

  // ---- 轻点关:立刻淡出 + 中途 opacity 真在动 + 到点关闭 --------------------------
  const t0 = performance.now();
  const r = document.getElementById("viewer-img").getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  V().dispatchEvent(
    new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }),
  );
  V().dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, isPrimary: true }));
  V().dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: cx, clientY: cy, detail: 1 }));
  out.closingImmediately = V().classList.contains("closing");
  await sleep(150);
  out.midOpacity = Number(getComputedStyle(V()).opacity); // 期望 (0,1):CSS 真接上了
  for (let i = 0; i < 40 && !V().hidden; i++) await sleep(10);
  out.closeMs = Math.round(performance.now() - t0);
  out.closed = V().hidden;
  out.classCleared = !V().classList.contains("closing"); // closeViewerNow 摘干净了

  // ---- 关完再开一张:整层必须可见(不留 opacity:0 的残留) -------------------------
  const thumb = document.querySelector("#timeline img");
  if (thumb) {
    thumb.click(); // 缩略图的开图 handler 是普通 click,合成够用(手势才须原生管线)
    for (let i = 0; i < 60 && V().hidden; i++) await sleep(50);
    await sleep(200);
    out.reopened = !V().hidden;
    out.reopenOpacity = Number(getComputedStyle(V()).opacity); // 期望 1
  }

  out.pass =
    out.closingImmediately === true &&
    out.midOpacity > 0 &&
    out.midOpacity < 1 &&
    out.closed === true &&
    out.closeMs >= 250 && // 延迟没被谁悄悄砍短(双击容错的下界,见 main.ts CLOSE_DELAY)
    out.closeMs < 500 &&
    out.classCleared === true &&
    (out.reopened === undefined || (out.reopened === true && out.reopenOpacity === 1));
  return JSON.stringify(out);
})();
// 真机那半(必跑,合成事件不算数):
//   adb -s <s> shell "input tap X Y; input tap X Y"   → 双击:图该放大 2.5×、层该活着、closing 该摘掉
//   adb -s <s> shell input tap X Y                    → 轻点:该关(上面已验时序)
//   adb -s <s> shell input keyevent 4                 → 返回键:该关且 closing 摘掉(closeViewerNow 同一条路)
// 坐标换算 CSS→设备 ×3.5(1260×2800 / 360×800)。每次 input tap 自身耗 ~126ms,两条 adb 调用
// 之间必超 300ms 双击窗口,故双击**必须写在同一条 shell 命令里**(244 蒸馏)。
