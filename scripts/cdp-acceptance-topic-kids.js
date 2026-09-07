// user-44 第六刀(安卓):标签管理面「`父/子` 前缀分组 + 折叠」的回归资产。
// 安卓侧没有 wdio 套件,这一面的回归全靠它。
//
// 跑法:CDP_TIMEOUT_MS=90000 node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-topic-kids.js
// ⚠ 单条 CDP 调用 10s 上限,这支有多轮等待 ⇒ 必须给 CDP_TIMEOUT_MS(同标签面另外几支)。
// ⚠ **语言前置**:③ 那格读 aria-label 的中文 ⇒ 跑前 `localStorage.setItem("zhujian.lang","zh")` + reload,
//    收尾 `removeItem`。⛔ 英文机上不设它会安静地少跑一格(skill 那条 559 判例)。
// 自带播种(1 父 + 2 子 + 1 退化 `a/b` + 1 平铺)与清场(finally 里删净),跑完库里不留东西。
//
// # 判据(⛔ 别只验「子行缩进了」—— 那半恒绿得很便宜)
//  ① **分组结构**:父行是 `#topics-list` 的直接子、其后紧跟一个 `.tkids`,两枚子行收在里头。
//     ⭐ 自证前置:种子真是「1 父 + 2 子」,且它们在同一个空间里都查得到。
//  ② **子行只显后缀、`data-topic` 仍是自己的 id**;父行显全名。⛔ 这一格是「分组只影响排版、
//     语义仍是平的」那句话的唯一屏上证据。
//  ③ **折叠箭头**:BUTTON + `data-kids` + `aria-expanded` 真随状态翻;⭐ **只长在有子的父行上**
//     (无子标签的行一枚都不许有 —— 否则那是一枚点了没反应的钮)。aria-label 说得出「几个」。
//  ④ **触区 ≥44 高 + `elementFromPoint` 五点真打**(§2.3)。⛔ 不是「读 CSS 里写没写」——
//     514 判例:宿主的 `overflow:hidden` 会把触区裁掉而屏上看不出来。
//     ⭐ 自证前置:同行的 `.tname` / `.tcolor` 必须都在,否则「没被邻居抢走」是句空话。
//  ⑤ **折叠真的把那一组藏了**:量 `getComputedStyle(.tkids).display === "none"`,⛔ 别只看
//     `hidden` 属性在不在(属性在而样式没生效 = 屏上照旧摊着)。再点一次回来。
//  ⑥ **拖排序的层**:父行的同层兄弟里**一枚子行都没有**,子行的同层兄弟**全是同组的子行**。
//     ⛔ 这条是 `key_between` 的命根子(跨层拿到的 prev/next 是「父在子后」的逆序,当场 Err),
//     而 `layerRows` 是模块私有 ⇒ 这里验的是它读的那个地面:DOM 的父容器分层。
//  ⑦ **改名输入框里是全名**(子行也是)—— 把 `父/` 抹掉是「移出这一组」这个真操作,
//     只显后缀会让它变成一次静默的移组。
//  ⑧ **收起一组时,组内开着的编辑态跟着收掉**(本刀自己造的坑,钉死):
//     那一行藏起来了而状态还开着 ⇒ `topicsInteracting()` 恒真、后台刷新被永久挡在门外,
//     而屏上一点看不出来。⭐ 另一半同样要钉:**别一刀清空** —— 组外那行的编辑态必须留着。
//  ⑨ **退化路径**:没有同名父标签的 `a/b` 照平铺、显全名、不长箭头。
//     ⚠ 分组判据本身(同名父 / 首段一层 / 首尾斜杠)由 `check-filter-parity` 三份同压,
//     这一格验的是**这一面真的用了那份规则**,不是把规则再验一遍。
//  ⑩ **合并态回到平铺**:整条列表换简行、显全名、`.tkids` 一个都没有(那时要选目标,
//     层级会挡路;同 ⑦ 一个道理 —— 合并按的是全名)。
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  **原生触摸不在这支里** —— 页内脚本发不了 `Input.dispatchTouchEvent`,⑤⑦⑧ 用的是合成
//  `el.click()`:它证的是「处理器接对了」,证不了「手指点得到」。后者由 ④ 的五点守几何,
//  再由驱动侧 `node scripts/android-cdp.mjs swipe <cx> <cy> <cx> <cy>` 手工真点一次收口。
//  **拖排序真拖不在这支里**(⑥ 只验层的地面事实,没发 pointer 事件)—— 那半在
//  `cdp-acceptance-topics-drag.js`,跨层拖的收敛行为要真手指验。
//  **落点线的缩进(`.drop-line.in-kids`)量不到**:它只在拖动过程中存在。
//
// # 阴性对照(⛔ 改判据后重跑一遍再说它有牙齿)
//  刀 A 注 `.tkid-caret{min-height:0;margin:0}` ⇒ ④ 的「触区高」当场红。
//  刀 B 注 `.tkid-caret{pointer-events:none}` ⇒ ④ 的「五点」全落 `.trow` 当场红。
//  刀 C(行为刀,要重建包)把 `rowHtml(k.topic, k.label, 0)` 的 `k.label` 换成 `k.topic.title`
//        ⇒ ② 的「子行只显后缀」当场红。
//  刀 D(行为刀,要重建包)把 onClick 里收起时那三行 `if (inGroup(...)) ... = null` 删掉
//        ⇒ ⑧ 的前半当场红(后半仍绿 —— 那正是它该有的分辨力)。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await sleep(80);
    }
    return false;
  };
  // ⚠ #topics-list 每次 render 整片重建 ⇒ 一律现查,别缓存节点。
  const list = () => document.getElementById("topics-list");
  // ⚠ 一律按 **本趟的 id** 定位,⛔ 别按文本(548 判例:关面不清 DOM,同名残余行会先命中)。
  const rowOf = (id) => list().querySelector(`.trow[data-topic="${id}"]`);
  const nameOf = (id) => rowOf(id)?.querySelector(".tname");
  const caretOf = (id) => list().querySelector(`.tkid-caret[data-kids="${id}"]`);
  const kidsBoxOf = (id) => {
    const nx = rowOf(id)?.nextElementSibling;
    // 展开面(.tbody)会插在父行与 .tkids 之间 —— 往后走到第一个 .tkids 为止。
    let el = nx;
    while (el && !el.classList.contains("tkids") && !el.classList.contains("trow")) el = el.nextElementSibling;
    return el && el.classList.contains("tkids") ? el : null;
  };
  const toggle = () => document.getElementById("topics-toggle").click();
  // ⛔ **别拿 `!topics-new.hidden` 当「面开着」**(标签面另外几支资产就是那么写的,而它会
  // 假阳):app 刚起、标签面一次都没开过时,那枚钮的 `hidden` 本来就是 false —— 于是
  // 「开着 ⇒ 先收起来」这一步反而把面**打开**,后面全跑偏。地面真相是**看得见没有**。
  const paneOpen = () => !!document.getElementById("topics-list").offsetParent;

  let dad = null, kidA = null, kidB = null, lone = null, flat = null;
  try {
    // ⛔ **播种前先把面收起来**:列表只在开面那一刻拉一次(loadTopics),面开着时播的种进不了 DOM。
    if (paneOpen()) { toggle(); await sleep(300); }
    dad = await inv("create_topic", { title: "ZJ44f父" });
    kidA = await inv("create_topic", { title: "ZJ44f父/子甲" });
    kidB = await inv("create_topic", { title: "ZJ44f父/子乙" });
    // ⑨ 退化:前缀 `ZJ44f独` 不是任何标签的标题 ⇒ 照平铺、显全名。
    lone = await inv("create_topic", { title: "ZJ44f独/立" });
    // ⑥ 需要至少两枚顶层行才谈得上「同层兄弟」。
    flat = await inv("create_topic", { title: "ZJ44f平" });

    // ⭐ 自证前置:五枚种子在库里真的都在(不然下面每一格都是空测)。
    const tree = await inv("list_topics_full");
    const seeded = [dad, kidA, kidB, lone, flat].filter((id) => tree.some((t) => t.id === id)).length;
    ok("前置:五枚种子标签库里都在", seeded === 5, { seeded });

    toggle();
    await sleep(200);
    ok("面开了、五枚种子行都在", await until(() => [dad, kidA, kidB, lone, flat].every((id) => rowOf(id))));

    // ---- ① 分组结构 ----------------------------------------------------------------
    ok("① 父行是 #topics-list 的直接子", rowOf(dad).parentElement === list(), {
      parent: rowOf(dad).parentElement.className || rowOf(dad).parentElement.id,
    });
    const box = kidsBoxOf(dad);
    ok("① 父行后面紧跟一个 .tkids 组", !!box);
    const inBox = box ? [...box.querySelectorAll(".trow[data-topic]")].map((r) => r.dataset.topic) : [];
    ok("① 两枚子行都收在那一组里、且只有它们俩", inBox.length === 2 && inBox.includes(kidA) && inBox.includes(kidB), { inBox });
    ok("① 子行的 DOM 父就是那个 .tkids", rowOf(kidA).parentElement === box && rowOf(kidB).parentElement === box);

    // ---- ② 子行只显后缀,id 仍是自己的 ------------------------------------------------
    ok("② 子行只显后缀", nameOf(kidA).textContent.trim() === "子甲" && nameOf(kidB).textContent.trim() === "子乙", {
      a: nameOf(kidA).textContent.trim(), b: nameOf(kidB).textContent.trim(),
    });
    ok("② 父行显全名", nameOf(dad).textContent.trim() === "ZJ44f父", { dad: nameOf(dad).textContent.trim() });
    ok("② 子行的 data-topic 还是它自己的 id", rowOf(kidA).dataset.topic === kidA);
    ok("② 子行照旧有色钮 / 计数 / 手柄(不是被降级的只读行)",
      !!rowOf(kidA).querySelector(".tcolor") && !!rowOf(kidA).querySelector(".tcount") && !!rowOf(kidA).querySelector(".thandle"));

    // ---- ③ 折叠箭头 -----------------------------------------------------------------
    const car = caretOf(dad);
    ok("③ 箭头是 BUTTON 且带 data-kids", car && car.tagName === "BUTTON", { tag: car && car.tagName });
    ok("③ aria-expanded 初始 true(默认展开)", car && car.getAttribute("aria-expanded") === "true");
    ok("③ aria-label 说得出「几个」", car && /2/.test(car.getAttribute("aria-label") || ""), {
      label: car && car.getAttribute("aria-label"),
    });
    const carets = [...list().querySelectorAll(".tkid-caret")].map((c) => c.dataset.kids);
    ok("③ 无子标签的行一枚箭头都没有", !carets.includes(flat) && !carets.includes(lone) && !carets.includes(kidA), { carets });

    // ---- ④ 触区 + 五点(自证前置:邻居真在) -------------------------------------------
    ok("④ 自证前置:同行 .tname / .tcolor 都在",
      !!rowOf(dad).querySelector(".tname") && !!rowOf(dad).querySelector(".tcolor"));
    rowOf(dad).scrollIntoView({ block: "center" });
    await sleep(120);
    const r = caretOf(dad).getBoundingClientRect();
    ok("④ 触区高 ≥44", r.height >= 44, { h: Math.round(r.height * 100) / 100 });
    const c4 = caretOf(dad);
    const pts = [
      [r.x + r.width / 2, r.y + r.height / 2],
      [r.x + 2, r.y + 2],
      [r.right - 2, r.y + 2],
      [r.x + 2, r.bottom - 2],
      [r.right - 2, r.bottom - 2],
    ];
    const hits = pts.map(([x, y]) => {
      const e = document.elementFromPoint(x, y);
      return e ? (e === c4 || c4.contains(e) ? "self" : e.className || e.tagName) : "null";
    });
    ok("④ 五点全落在箭头上(没被名字/色钮抢)", hits.every((h) => h === "self"), { hits });
    // ⭐ 箭头必须**紧贴名字末尾**:第一版 `.tname{flex:1}` 把它顶到名字列右端,屏上是一枚
    // 浮在空白里的小三角,认不出它说的是哪个名字。这一格钉死那个几何(判例:用户面 49)。
    // ⛔ **量的必须是「字的右缘」,不是 `.tname` 这个盒的右缘** —— 盒会跟着 flex 长,
    // 名字左对齐在里头,于是盒撑满整列时「盒右缘到箭头」照旧 ≈10px:第一版判据就是这么写的,
    // 阴性刀(`.tname{flex:1 1 0%}`)咬不动它 = 空测。用 Range 取字本身的墨迹范围。
    const inkRight = (el) => {
      const rg = document.createRange();
      rg.selectNodeContents(el);
      return rg.getBoundingClientRect().right;
    };
    const gapPx = caretOf(dad).getBoundingClientRect().left - inkRight(nameOf(dad));
    ok("④ 箭头紧贴名字末尾(缝 <16px,⛔ 别让它浮在名字列右端)", gapPx >= 0 && gapPx < 16, {
      gapPx: Math.round(gapPx * 100) / 100,
    });

    // ---- ⑥ 拖排序的层(在折叠之前量,那时两层都在屏上) --------------------------------
    const layerOf = (id) => [...rowOf(id).parentElement.children]
      .filter((e) => e.classList && e.classList.contains("trow") && e.dataset.topic)
      .map((e) => e.dataset.topic);
    const topLayer = layerOf(dad);
    ok("⑥ 父行的同层里一枚子行都没有", !topLayer.includes(kidA) && !topLayer.includes(kidB), { topLayer });
    ok("⑥ 父行的同层里有别的顶层行(否则「不含子行」是句空话)",
      topLayer.includes(flat) && topLayer.includes(lone) && topLayer.includes(dad));
    const kidLayer = layerOf(kidA);
    ok("⑥ 子行的同层恰是同组那两枚", kidLayer.length === 2 && kidLayer.includes(kidA) && kidLayer.includes(kidB), { kidLayer });

    // ---- ⑦ 改名输入框里是全名 ---------------------------------------------------------
    nameOf(kidA).click();
    ok("⑦ 子行点名字进了改名态", await until(() => !!rowOf(kidA)?.querySelector(".tn-input")));
    ok("⑦ 输入框里是全名不是后缀", rowOf(kidA).querySelector(".tn-input").value === "ZJ44f父/子甲", {
      v: rowOf(kidA).querySelector(".tn-input").value,
    });

    // ---- ⑧ 收起时:组内编辑态跟着收、组外的留着 ----------------------------------------
    caretOf(dad).click();
    ok("⑧ 收起后组内那个改名态没了(⛔ 否则 topicsInteracting 恒真、后台刷新被永久挡住)",
      await until(() => list().querySelectorAll(".tn-input").length === 0), {
        left: list().querySelectorAll(".tn-input").length,
      });
    // ---- ⑤ 折叠真的把那一组藏了 -------------------------------------------------------
    const boxC = kidsBoxOf(dad);
    ok("⑤ .tkids 的 computed display 真是 none", boxC && getComputedStyle(boxC).display === "none", {
      display: boxC && getComputedStyle(boxC).display,
    });
    ok("⑤ 收起后 aria-expanded 翻成 false", caretOf(dad).getAttribute("aria-expanded") === "false");
    ok("⑤ 收起后子行量不到高(offsetParent 为空)", rowOf(kidA).offsetParent === null);
    // 组外那行的编辑态:开在 flat 上,再收/开这一组,它必须还在。
    nameOf(flat).click();
    ok("⑧ 前置:组外那行真进了改名态", await until(() => !!rowOf(flat)?.querySelector(".tn-input")));
    caretOf(dad).click(); // 展开回来
    ok("⑤ 再点一次就展开回来", await until(() => {
      const b = kidsBoxOf(dad);
      return b && getComputedStyle(b).display !== "none" && caretOf(dad).getAttribute("aria-expanded") === "true";
    }));
    ok("⑧ 组外那行的改名态没被误伤(⛔ 别一刀清空)", !!rowOf(flat)?.querySelector(".tn-input"));
    rowOf(flat).querySelector("[data-rename-cancel]").click();
    await until(() => !rowOf(flat)?.querySelector(".tn-input"));

    // ---- ⑨ 退化路径 -------------------------------------------------------------------
    ok("⑨ 没有同名父的 `a/b` 照平铺(在顶层)", rowOf(lone).parentElement === list());
    ok("⑨ 它显的是全名", nameOf(lone).textContent.trim() === "ZJ44f独/立", { v: nameOf(lone).textContent.trim() });

    // ---- ⑩ 合并态回到平铺 --------------------------------------------------------------
    document.getElementById("topics-merge").click();
    ok("⑩ 合并态里一个 .tkids 都没有", await until(() => list().querySelectorAll(".tkids").length === 0 && !!list().querySelector(".mrow")));
    const mnames = [...list().querySelectorAll(".mrow .mname")].map((e) => e.textContent.trim());
    ok("⑩ 合并态显的是全名(合并按全名走)", mnames.includes("ZJ44f父/子甲") && mnames.includes("ZJ44f父/子乙"), {
      sample: mnames.filter((s) => s.startsWith("ZJ44f")),
    });
    ok("⑩ 合并态里一枚折叠箭头都没有", list().querySelectorAll(".tkid-caret").length === 0);
    list().querySelector("[data-merge-cancel]").click();
    ok("⑩ 退出合并态,分组回来了", await until(() => !!kidsBoxOf(dad) && !list().querySelector(".mrow")));
  } catch (e) {
    ok("跑飞了", false, { error: String(e && e.stack ? e.stack : e) });
  } finally {
    for (const [k, id] of [["dad", dad], ["kidA", kidA], ["kidB", kidB], ["lone", lone], ["flat", flat]]) {
      try { if (id) await inv("delete_topic", { id }); } catch (e) { out["clean_" + k] = String(e); }
    }
    // 清场干净当判据(skill 那条:catch 会把拒吞掉,库里悄悄攒尸体)。
    try {
      const left = (await inv("list_topics_full")).filter((t) => /^ZJ44f/.test(t.title)).length;
      ok("清场干净(种子标签 0)", left === 0, { left });
    } catch (e) { ok("清场干净", false, { error: String(e) }); }
  }
  out.pass = out.steps.every((s) => s.ok);
  out.total = out.steps.length;
  out.failed = out.steps.filter((s) => !s.ok).map((s) => s.name);
  return JSON.stringify(out);
})()
