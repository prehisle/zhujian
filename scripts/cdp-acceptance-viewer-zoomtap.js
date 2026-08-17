// 查看器「放大态单击=就地复位回全图」(403)验收:此前放大态单击是静默 no-op(用户实报
// 「点了没反应」),改为单击先复位、回到全图后再点一下才关;双击语义(2.5×/复位)不变,
// 双击的第二下由 resetTapPending 吞掉(不在已复位的图上又放大)。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-viewer-zoomtap.js
// 前置:时间轴上要有一张配图(#timeline .thumb[data-img])。没有就先种:
//   node scripts/android-cdp.mjs eval '(async()=>{const inv=window.__TAURI__.core.invoke;
//     const sp=(await inv("list_spaces")).find(s=>s.current).id;
//     const id=await inv("capture_idea",{spaceId:sp,content:"【CDP验收】查看器缩放 "+Date.now()});
//     const c=document.createElement("canvas");c.width=600;c.height=400;
//     const x=c.getContext("2d");x.fillStyle="#c33";x.fillRect(0,0,600,400);
//     x.fillStyle="#fff";x.font="48px sans-serif";x.fillText("zoomtap",180,210);
//     const b64=c.toDataURL("image/png").split(",")[1];
//     const m=await inv("add_item_image",{spaceId:sp,itemId:id,mime:"image/png",dataB64:b64});
//     return JSON.stringify({id,img:m.id})})()'
//   然后 am force-stop 重启 app(页内 invoke 写库后时间轴不自见)+ 重新 forward。
// 验完的清场同样走 UI(删条目→回收站彻底删)由驱动者做;本资产只关掉查看器、不动数据。
// 本资产是合成 click 的 JS 半截(click 逻辑不认 isTrusted,时序可控);原生半截(真 adb tap
// 过原生管线)每轮改了手势相关仍要发一遍:文件尾注有 runbook。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 6000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 60));
    }
  };
  const viewer = document.getElementById("viewer");
  const img = document.getElementById("viewer-img");
  const scaleOf = () => {
    const t = getComputedStyle(img).transform;
    if (t === "none") return 1;
    const m = t.match(/matrix\(([-\d.]+)/);
    return m ? Number(m[1]) : NaN;
  };
  // 一次「轻点」必须是 pointerdown → pointerup → click 三连:真手指必有 pointerdown,
  // 查看器靠它跑 measureBase(手势起点量基座)。只发裸 click 的话 vBase 恒零盒,
  // clampView 会把复位钳到 (innerWidth/2, innerHeight/2) —— 244 那个病根在驱动侧复活,
  // .zoomed 摘不掉,红的是资产不是产品(本资产首版实踩)。
  const tapAt = () => {
    const o = { bubbles: true, clientX: innerWidth / 2, clientY: innerHeight / 2, pointerId: 1, isPrimary: true };
    viewer.dispatchEvent(new PointerEvent("pointerdown", o));
    viewer.dispatchEvent(new PointerEvent("pointerup", o));
    viewer.dispatchEvent(new MouseEvent("click", o));
  };
  const openOnThumb = async () => {
    const th = document.querySelector("#timeline .thumb[data-img]");
    if (!th) return null;
    th.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return until(() => !viewer.hidden && img.naturalWidth > 0 && getComputedStyle(img).transform === "none");
  };

  if (!document.querySelector("#timeline .thumb[data-img]")) {
    out.error = "先种一张配图再跑(见文件头 seed 命令)";
    return JSON.stringify(out);
  }
  if (!ok("查看器初始关着", viewer.hidden)) return JSON.stringify(out);

  // ── ① 开图 → 双击放大 2.5×(既有语义不回归)──
  if (!ok("点缩略图开图(图已解码定形)", !!(await openOnThumb()))) return JSON.stringify(out);
  tapAt();
  await sleep(60);
  tapAt();
  const zoomed = await until(() => viewer.classList.contains("zoomed") && Math.abs(scaleOf() - 2.5) < 0.05, 1500);
  if (!ok("双击放大到 2.5×(.zoomed 挂上)", !!zoomed)) return JSON.stringify(out);
  ok("双击撤销了首击的待关淡出", !viewer.classList.contains("closing"));
  await sleep(350); // 出双击窗,下一击是干净的单击

  // ── ② 放大态单击 = 就地复位,绝不关(403 的正身)──
  tapAt();
  ok("单击当帧即复位(.zoomed 摘掉)", !viewer.classList.contains("zoomed"));
  await sleep(50);
  ok("复位不淡出(没在关)", !viewer.classList.contains("closing") && !viewer.hidden);
  await sleep(250);
  ok("过渡落定回 1×", Math.abs(scaleOf() - 1) < 0.05);
  await sleep(200); // 合计 500ms > CLOSE_DELAY:若误武装了关闭,这里已经黑屏
  if (!ok("复位那一击绝不关图(500ms 后仍在)", !viewer.hidden)) return JSON.stringify(out);

  // ── ③ 回到全图后再单击 = 走既有关闭(淡出真在淡)──
  tapAt();
  ok("关闭淡出当帧就起(.closing)", viewer.classList.contains("closing"));
  await sleep(150);
  const midOpacity = Number(getComputedStyle(viewer).opacity);
  ok("淡出真在淡(中途 opacity ∈ (0,1))", midOpacity > 0 && midOpacity < 1);
  ok("到点关图", !!(await until(() => viewer.hidden, 1200)));

  // ── ④ 双击复位语义不回归:放大态双击 = 复位 + 第二下被吞(不再放大、不关图)──
  if (!ok("重开图", !!(await openOnThumb()))) return JSON.stringify(out);
  tapAt();
  await sleep(60);
  tapAt(); // 放大
  await until(() => viewer.classList.contains("zoomed"), 1500);
  await sleep(350);
  tapAt(); // 第一下:复位(挂 resetTapPending)
  await sleep(60);
  tapAt(); // 第二下:双击后半,该被吞
  ok("双击复位后不再放大回去", !!(await until(() => !viewer.classList.contains("zoomed") && Math.abs(scaleOf() - 1) < 0.05, 800)));
  await sleep(450); // > CLOSE_DELAY:第二下若没被吞、被当成全图单击,这里已关图
  ok("第二下被吞:不关图", !viewer.hidden);

  // ── 收:全图单击关掉,还原初始态 ──
  await sleep(350);
  tapAt();
  ok("收尾关图", !!(await until(() => viewer.hidden, 1200)));

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
// ── 原生半截 runbook(真 adb 输入过原生管线;坐标 = CSS 坐标 × devicePixelRatio)──
// 1) CDP 取缩略图中心:eval '(()=>{const r=document.querySelector("#timeline .thumb[data-img]").getBoundingClientRect();return JSON.stringify({x:Math.round((r.x+r.width/2)*devicePixelRatio),y:Math.round((r.y+r.height/2)*devicePixelRatio),cx:Math.round(innerWidth/2*devicePixelRatio),cy:Math.round(innerHeight/2*devicePixelRatio)})})()'
// 2) adb shell input tap <x> <y>                     # 开图(等 1s)
// 3) adb shell "input tap <cx> <cy>; input tap <cx> <cy>"   # 双击放大(两拍必须同一条命令)
//    CDP 断言 .zoomed;
// 4) adb shell input tap <cx> <cy>                   # 放大态单击 → CDP 断言 !zoomed 且 !hidden
// 5) adb shell input tap <cx> <cy>                   # 全图单击 → CDP 断言 hidden
