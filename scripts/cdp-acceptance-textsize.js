// 251 界面字号(安卓)验收 —— 设置面四档 seg 走 __zhujianTextSize 桥调 WebView textZoom。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-textsize.js
// 量测铁律:wry 的 zoom() 在安卓是「返回 Ok 什么都不做」的空实现(241/250 教训),所以
// 这里绝不信「调用成功」——用隐藏探针 span 的**渲染宽度比值**当唯一真相(textZoom 生效
// = 同一段文字变宽,比值 ≈ 档位比)。
// 重载/冷启动的恢复(内联脚本半截)不在本文件——见文件尾注释的驱动侧步骤。
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);

  // 探针:固定文字、nowrap、隐藏不占位;textZoom 重排是异步的,读数前等它稳定。
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-size:15px";
  probe.textContent = "界面字号量测基准文字 0123456789";
  document.body.appendChild(probe);
  const width = () => probe.getBoundingClientRect().width;
  const settle = async (prev) => {
    // 等宽度离开 prev 且连续两读相同(重排完成);2s 没动=没生效,如实返回现值。
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const a = width();
      if (a !== prev) {
        await sleep(100);
        if (width() === a) return a;
      }
    }
    return width();
  };

  const fails = [];
  const ok = (name, cond, detail) => {
    if (!cond) fails.push({ name, detail });
    return cond;
  };

  // ① 桥在(缺席=构建坏了,同 __zhujianSystemBars 的约定)
  ok("bridge", typeof window.__zhujianTextSize === "object" && typeof window.__zhujianTextSize.set === "function", typeof window.__zhujianTextSize);

  // ② 开设置面,四档钮齐
  $("settings-toggle").click();
  await sleep(300);
  const seg = $("textsize-seg");
  const btns = seg ? [...seg.querySelectorAll("[data-textsize]")] : [];
  ok("seg-4btns", btns.map((b) => b.dataset.textsize).join(",") === "90,100,115,130", btns.length);

  // ③ 先归标准档(装机保数据,起点未知),记基准宽
  const btn = (v) => seg.querySelector(`[data-textsize="${v}"]`);
  btn("100").click();
  await sleep(500);
  const base = width();
  ok("base-sane", base > 100, base); // 探针文字在 15px 下必然远宽于 100px

  // ④ 高亮=单一渲染点:100 亮、其余灭;localStorage 标准档不留键
  const onNow = () => btns.filter((b) => b.classList.contains("on")).map((b) => b.dataset.textsize);
  ok("hl-100", onNow().join(",") === "100", onNow());
  ok("ls-100-clear", localStorage.getItem("zhujian.textsize") === null, localStorage.getItem("zhujian.textsize"));

  // ⑤ 点 130:布局真变(比值≈1.3,容差 ±0.06——整数像素/字体微调),高亮跟、localStorage 落
  btn("130").click();
  const w130 = await settle(base);
  const r130 = w130 / base;
  ok("ratio-130", Math.abs(r130 - 1.3) < 0.06, r130);
  ok("hl-130", onNow().join(",") === "130", onNow());
  ok("ls-130", localStorage.getItem("zhujian.textsize") === "130", localStorage.getItem("zhujian.textsize"));

  // ⑥ 与明暗三档不打架:切暗再切回,字号纹丝不动、主题真切了
  const themeBtn = (m) => $("theme-seg").querySelector(`[data-theme-mode="${m}"]`);
  themeBtn("dark").click();
  await sleep(300);
  const themeDark = document.documentElement.dataset.theme === "dark";
  const wAfterTheme = width();
  themeBtn("auto").click();
  await sleep(300);
  ok("theme-flips", themeDark, document.documentElement.dataset.theme);
  ok("size-survives-theme", wAfterTheme === w130, { wAfterTheme, w130 });

  // ⑦ 小档也真变(反方向:比值≈0.9)
  btn("90").click();
  const w90 = await settle(w130);
  ok("ratio-90", Math.abs(w90 / base - 0.9) < 0.06, w90 / base);

  // ⑧ 回标准:宽度回基准(±1px 容差),键清掉 —— 也是本资产的清场
  btn("100").click();
  const wBack = await settle(w90);
  ok("ratio-back-1", Math.abs(wBack - base) <= 1, { wBack, base });
  ok("ls-back-clear", localStorage.getItem("zhujian.textsize") === null, localStorage.getItem("zhujian.textsize"));

  // 关设置面回时间轴
  $("settings-toggle").click();
  await sleep(200);
  const paneClosed = !document.body.classList.contains("pane-open");
  ok("pane-closed", paneClosed, paneClosed);

  probe.remove();
  return { base, r130, r90: w90 / base, fails, pass: fails.length === 0 };
})();
// 驱动侧补两步(本文件管不了跨加载),全走比值法(set(100) 当对照):
//   A. 重载恢复:eval 里设 115(点 seg)→ location.reload() → 新 eval:装同款探针量 w1,
//      __zhujianTextSize.set(100) 后量 w2,断言 w1/w2≈1.15 且 localStorage=115;完了点回标准清场。
//   B. 冷启动恢复(内联脚本 + 原生默认复位):设 115 → am force-stop + 重启 + 重建 forward
//      → 同 A 的比值断言;完了点回标准清场。
