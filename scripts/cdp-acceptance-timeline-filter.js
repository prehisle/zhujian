// 时间轴筛选(灵感/看板两面,与桌面同源三维:kind→topics→text)真机验收 · 验证。
// ①-③ 按类型筛选(190/192);④-⑩ 标签多选走「或」+ 父子折叠(229,追齐桌面 219/221);
// ⑤b 单选标签时卡上同名 chip 不渲染(追齐桌面 218)。
// ⑪ 标签行摊开/收起 + 过滤框收窄(用户面 36)。
// 三步流程之中:假设已 evalfile cdp-acceptance-timeline-filter-seed.js 播种
// 且随后 reload(app 重读 timeline+list_topics_full)。点类型 pill 走 onFilterPick→
// projectTimeline 同步重投影,无需再 reload。evalfile 跑,pass=true 才算过。只读+点击,
// 不删数据(删净跑 -cleanup)。
// ⚠ ⑪ 起整只是 **async** 的(要等 CSS 过渡跑完才量得到宽度);android-cdp.mjs 的
// Runtime.evaluate 带 awaitPromise,返回形状不变。前面那些格一句没改,仍是同步的。
//
// ⚠ **原生半截(页内验不了,每轮改了过滤框就得手跑一次)**:过滤框「动笔才张开」的 JS 那半
// (focusin → 挂 `.wide`)在页内**永远验不到** —— `f.focus()` 在文档没有窗口焦点时只改
// activeElement、一个 focus 事件都不发(Chromium 推迟到文档重获焦点),而 CDP 驱动下恒是
// 这种状态。要验就原生轻点它:
//   X/Y 取 `#filter-text` 的 getBoundingClientRect 中心 → `android-cdp.mjs swipe X Y X Y`
//   → 再 eval 量 `{ cls, w, docFocus }`,期望 `wide` 在类里、w 从 78 涨到 143、docFocus=true。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra ? { extra } : {}) });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const kindPills = () => [...document.querySelectorAll("#filter-kinds .fpill")];
  const topicPills = () => [...document.querySelectorAll("#filter-topics .fpill")];
  const cardTexts = () =>
    [...document.querySelectorAll("#timeline [data-id] .content")].map((c) => c.textContent);
  const findKind = (t) => kindPills().find((p) => p.textContent.includes(t));
  const findTopic = (t) => topicPills().find((p) => p.textContent.includes(t));
  const shows = (t) => cardTexts().some((c) => c.includes(t));

  // 前置:在灵感面、类型行已出现(播种生效)。
  const mode = document.querySelector("#bottombar [data-mode].active")?.dataset.mode;
  if (!ok("在灵感面", mode === "ideas")) return JSON.stringify(out);
  // ⚠ **本资产的期望表通篇钉的是中文文案**,而界面语言默认跟系统走(i18n.ts:navigator.language)。
  // 英文机上它会红成一片「类型行没出现」,读起来像播种失败 —— 先把这一格单独分出来,
  // 是语言不对就说是语言不对(skill「跑既有资产」§3:别拿资产的红当产品的红)。
  if (kindPills().some((p) => p.textContent.includes("All kinds"))) {
    ok(
      "前置:界面语言是中文(期望表钉的是中文文案)",
      false,
      "当前是英文 ⇒ 本资产没跑。先 localStorage.setItem('zhujian.lang','zh') + reload,验完设回 auto",
    );
    return JSON.stringify(out);
  }
  if (!ok("类型行出现(全部类型 + 人名)", !!findKind("全部类型") && !!findKind("人名")))
    return JSON.stringify(out);
  ok("人名 pill 计数=2(挂人名标签的灵感数)", findKind("人名")?.textContent.includes("2"));

  // ① 选「人名」→ 列表缩到挂人名标签的灵感、项目灵感消失;标签 pill 收到人名类内
  //    (张三/李四在、无标签 pill 消失、项目标签消失)。
  click(findKind("人名"));
  ok("选人名:张三/李四在、项目消失", shows("FFV-想到张三") && shows("FFV-想到李四") && !shows("FFV-想到项目"));
  ok("选人名:标签行收到人名类(有张三/李四)", !!findTopic("FFV-张三") && !!findTopic("FFV-李四"));
  ok("选人名:无「无标签」pill", !topicPills().some((p) => p.textContent.includes("无标签")));
  ok("选人名:无项目标签 pill", !findTopic("FFV-项目甲"));
  ok("选人名:「人名」pill 高亮", findKind("人名")?.classList.contains("active"));

  // ② 类型内再钻到「张三」→ 只剩张三那条。
  click(findTopic("FFV-张三"));
  ok("钻到张三:只剩张三", shows("FFV-想到张三") && !shows("FFV-想到李四") && !shows("FFV-想到项目"));
  ok("张三 pill 高亮", findTopic("FFV-张三")?.classList.contains("active"));

  // ③ 回「全部类型」→ 恢复全量(项目灵感回来、无标签 pill 回来、标签轴归零)。
  click(findKind("全部类型"));
  ok("回全部类型:项目灵感回来", shows("FFV-想到项目") && shows("FFV-想到张三"));
  ok("回全部类型:无标签 pill 回来", topicPills().some((p) => p.textContent.includes("无标签")));
  ok("回全部类型:全部类型 pill 高亮", findKind("全部类型")?.classList.contains("active"));

  // ---- 229:标签多选走「或」+ 父子折叠(安卓追齐桌面 219/221)----
  const seed = JSON.parse(localStorage.getItem("__ffv_seed") || "null");
  if (!ok("读到播种 ids(seed.named)", !!seed?.named)) return JSON.stringify(out);
  const { home, kid1, kid2 } = seed.named;
  const byId = (id) => document.querySelector(`#filter-topics .fpill[data-topic-id="${id}"]`);
  const findAll = () => topicPills().find((p) => p.textContent.includes("所有"));
  const findNone = () => topicPills().find((p) => p.textContent.includes("无标签"));

  // ④ 多选并集:张三 + 李四 同时选中 → 两条都在、项目那条不在;两枚 pill 同时高亮。
  click(findTopic("FFV-张三"));
  click(findTopic("FFV-李四"));
  ok("多选:张三+李四两条都在", shows("FFV-想到张三") && shows("FFV-想到李四"));
  ok("多选:项目那条被排除", !shows("FFV-想到项目"));
  ok(
    "多选:两枚 pill 同时高亮",
    findTopic("FFV-张三")?.classList.contains("active") &&
      findTopic("FFV-李四")?.classList.contains("active"),
  );
  ok("多选:「所有」不高亮", !findAll()?.classList.contains("active"));
  // 再点张三 = 切出选集(只剩李四)。
  click(findTopic("FFV-张三"));
  ok("再点张三:切出选集,只剩李四", shows("FFV-想到李四") && !shows("FFV-想到张三"));

  // ⑤ 「无标签」与具体标签互斥(一个条目不可能既无标签又挂着某标签)。
  click(findNone());
  ok("选无标签:李四 pill 不再高亮", !findTopic("FFV-李四")?.classList.contains("active"));
  ok("选无标签:无标签 pill 高亮", findNone()?.classList.contains("active"));
  click(findTopic("FFV-李四"));
  ok("再选李四:无标签 pill 取消高亮", !findNone()?.classList.contains("active"));
  click(findAll());
  ok("点「所有」:清空选集、恢复全量", findAll()?.classList.contains("active") && shows("FFV-想到项目"));

  // ⑤b 追齐桌面 218:恰好单选一枚标签时,卡上那枚同名 chip 不渲染(筛出来的卡本就都带它,
  //    纯冗余);多选 OR 下每枚 chip 是「凭哪个标签入选」的有效信息,全部保留。种子里
  //    FFV-想到张三 挂两标签(张三+项目甲)、FFV-想到李四 只挂李四。
  const cardChips = (marker) => {
    const card = [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
      c.querySelector(".content")?.textContent.includes(marker));
    return card ? [...card.querySelectorAll(".chip")].map((c) => c.textContent) : null;
  };
  click(findTopic("FFV-李四"));
  ok("单选李四:只挂李四的卡 chip 整枚消失", cardChips("FFV-想到李四")?.length === 0);
  click(findAll());
  click(findTopic("FFV-张三"));
  const zc = cardChips("FFV-想到张三");
  ok("单选张三:同名 chip 藏、其余留(只剩项目甲)", !!zc && zc.length === 1 && zc[0].includes("FFV-项目甲"), zc);
  click(findTopic("FFV-李四")); // 追加李四 → 变多选
  const zc2 = cardChips("FFV-想到张三");
  ok(
    "多选:张三卡同名 chip 回来(凭哪个标签入选是信息)",
    !!zc2 && zc2.some((t) => t.includes("FFV-张三")) && zc2.some((t) => t.includes("FFV-项目甲")),
    zc2,
  );
  ok("多选:李四卡 chip 也在", cardChips("FFV-想到李四")?.some((t) => t.includes("FFV-李四")));
  click(findAll());
  ok("清回所有:chip 全量回来", cardChips("FFV-想到李四")?.some((t) => t.includes("FFV-李四")));

  // ⑥ 父子折叠:父 FFV-家 出 pill 并带箭头;两子默认收起(在 DOM 里但 .hidden)。
  const parentPill = byId(home);
  if (!ok("父标签 FFV-家 出 pill", !!parentPill)) return JSON.stringify(out);
  const caret = parentPill.querySelector(".fcaret");
  ok("父 pill 带折叠箭头", !!caret);
  ok("默认收起:箭头是 ▸", caret?.textContent === "▸");
  ok(
    "默认收起:两子 pill 存在但 .hidden",
    byId(kid1)?.classList.contains("hidden") && byId(kid2)?.classList.contains("hidden"),
  );
  ok("子 pill 挂 .child + data-parent=父 id", byId(kid1)?.classList.contains("child") && byId(kid1)?.dataset.parent === home);
  ok("子 pill 只显后缀(买菜,不是全名)", byId(kid1)?.textContent.includes("买菜") && !byId(kid1)?.textContent.includes("FFV-家/"));

  // ⑦ 点箭头展开 → 子 pill 露出、箭头翻 ▾;**且不重投影**(展开不是筛选:列表内容不变)。
  const beforeExpand = cardTexts().length;
  click(caret);
  ok("点箭头:两子 pill 露出", !byId(kid1)?.classList.contains("hidden") && !byId(kid2)?.classList.contains("hidden"));
  ok("点箭头:箭头翻 ▾", parentPill.querySelector(".fcaret")?.textContent === "▾");
  ok("点箭头:列表条数不变(展开不是筛选)", cardTexts().length === beforeExpand);
  ok("点箭头:没顺带把父标签筛上(父 pill 未高亮)", !byId(home)?.classList.contains("active"));

  // ⑧ 展开态下点子标签「买菜」→ 只剩那条;收起父标签后,选中的子 pill 仍可见(活筛不藏)。
  click(byId(kid1));
  ok("点子标签买菜:只剩那条", shows("FFV-该买菜了") && !shows("FFV-灯泡坏了") && !shows("FFV-家务总览"));
  const caret2 = byId(home)?.querySelector(".fcaret");
  click(caret2);
  ok("收起父标签:选中的买菜仍可见", !byId(kid1)?.classList.contains("hidden"));
  ok("收起父标签:没选中的修灯藏起来", byId(kid2)?.classList.contains("hidden"));

  // ⑨ 箭头命中盒按手指给足(桌面那枚 1px padding 的小箭头在触屏点不中):≥26×28,
  //    且不外溢父 pill(否则抢邻座 pill 的点击)。
  const cbox = byId(home)?.querySelector(".fcaret")?.getBoundingClientRect();
  const pbox = byId(home)?.getBoundingClientRect();
  ok("箭头命中盒 ≥26×28", cbox && cbox.width >= 26 && cbox.height >= 28, cbox && { w: +cbox.width.toFixed(1), h: +cbox.height.toFixed(1) });
  ok("箭头不外溢父 pill", cbox && pbox && cbox.right <= pbox.right + 0.5 && cbox.top >= pbox.top - 0.5 && cbox.bottom <= pbox.bottom + 0.5);

  // ⑩ 收场:清回「所有」,别把筛选留在用户脸上。
  click(findAll());
  ok("收场:回到不筛", findAll()?.classList.contains("active") && shows("FFV-想到项目"));

  // ---- ⑪ 标签行摊开 / 收起 + 过滤框收窄(用户面 36)------------------------------
  // 用户实报两件:标签行是单行横滑,窄屏上常常**一枚真标签都露不出来**(屏上只剩
  // 「所有 / 无标签」),找标签只能盲着往右滑;而「过滤当前列表」那个框吃掉了三分之一屏宽。
  // 桌面 `.topic-filter` 本来就是 `flex-wrap: wrap` 全展开的 —— 这一格是端间漂移。
  const bar = document.getElementById("filterbar");
  const trow = document.getElementById("filter-topics");
  const xbtn = document.getElementById("filter-expand");
  const ftext = document.getElementById("filter-text");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wrapOf = () => getComputedStyle(trow).flexWrap;
  const overflows = () => trow.scrollWidth > trow.clientWidth + 1;
  // ⚠ **「装不下」不能指望机器自己有多宽**:MuMu 是横屏 1138 CSS px,六枚种子标签占 1022,
  // 一枚都不溢出 ⇒ 钮按设计把自己藏了,而照着「肯定装不下」写的断言会四格全红、看着像
  // 功能没做(第一次跑正是如此)。⇒ **两个分支都造出来验**:先验本机原生宽度(装得下 ⇒ 藏),
  // 再把标签行人为收窄造出溢出。收窄也更像用户那台竖屏手机(360-440 CSS px)。
  ok("⑪a 本机原生宽度下标签行装得下(这是前提,不是功能断言)", !overflows(), { sw: trow.scrollWidth, cw: trow.clientWidth });
  ok("⑪a 装得下 ⇒ 摊开钮把自己藏起来(点了没变化的钮比没有更糟)", xbtn.hidden);

  // ⛔ 收窄之后**刻意不重渲** —— 显隐必须自己重算出来。真机上会变宽窄的是转屏与字号
  // (251 的 textZoom:`.ftext` 是 em),那两件都不触发 renderFilterBar;只在渲染里算的话
  // 钮会停在上一个答案上,竖屏下这功能整个消失(本轮实测逮到,修法 = ResizeObserver)。
  trow.style.maxWidth = "160px"; // inline style 跨 replaceChildren 存活
  await sleep(120); // 等 ResizeObserver 那一拍
  ok("⑪b 收窄后确实溢出了", overflows(), { sw: trow.scrollWidth, cw: trow.clientWidth });
  ok("⑪b 收起态:是单行横滑(nowrap)", wrapOf() === "nowrap", wrapOf());
  ok("⑪b 装不下 ⇒ 摊开钮**自己**现身(没重渲,靠 ResizeObserver)", !xbtn.hidden && getComputedStyle(xbtn).display !== "none");
  const hBefore = trow.getBoundingClientRect().height;
  const nBefore = cardTexts().length;
  const activeBefore = topicPills().filter((p) => p.classList.contains("active")).length;
  const kid2HiddenBefore = byId(kid2)?.classList.contains("hidden");

  click(xbtn);
  await sleep(60);
  ok("⑪ 点摊开:#filterbar 挂上 tags-open", bar.classList.contains("tags-open"));
  ok("⑪ 点摊开:标签行换行(wrap)", wrapOf() === "wrap", wrapOf());
  ok("⑪ 点摊开:不再溢出(全都摆出来了)", !overflows(), { sw: trow.scrollWidth, cw: trow.clientWidth });
  const hAfter = trow.getBoundingClientRect().height;
  ok("⑪ 点摊开:行真的长高了", hAfter > hBefore + 4, { before: Math.round(hBefore), after: Math.round(hAfter) });
  // ⚠ 「换行了」不等于「看得见了」——逐枚核可见 pill 的横向真落在视口内。只断言
  // flex-wrap 的话,CSS 若在别处被盖住(或容器仍被裁),这一格照样会绿。
  const outside = topicPills()
    .filter((p) => !p.classList.contains("hidden"))
    .filter((p) => {
      const r = p.getBoundingClientRect();
      return r.right > window.innerWidth + 1 || r.left < -1;
    }).length;
  ok("⑪ 摊开后每一枚可见 pill 都真在视口内", outside === 0, { outside });
  // 摊开**只翻布局**:不是筛选、也不动父子折叠(那是父 pill 上那枚箭头的事)。
  // 两件混到一枚钮上会让「摊开」有两种意思,故这三格是本段的判据核心,不是顺手写的。
  ok("⑪ 摊开不是筛选:列表条数不变", cardTexts().length === nBefore, { before: nBefore, after: cardTexts().length });
  ok("⑪ 摊开不改选集:高亮 pill 数不变", topicPills().filter((p) => p.classList.contains("active")).length === activeBefore);
  ok("⑪ 摊开不动父子折叠:收着的子 pill 仍收着", byId(kid2)?.classList.contains("hidden") === kid2HiddenBefore, {
    before: kid2HiddenBefore,
    after: byId(kid2)?.classList.contains("hidden"),
  });
  ok("⑪ 摊开态记进 localStorage(本地偏好,不进同步)", localStorage.getItem("zhujian.filter-tags-open") === "1");
  ok("⑪ 摊开态那枚钮仍在(藏了就收不回来)", !xbtn.hidden);

  click(xbtn);
  await sleep(60);
  ok("⑪ 再点收回:tags-open 摘掉、回到单行横滑", !bar.classList.contains("tags-open") && wrapOf() === "nowrap");
  ok("⑪ 收回后钮还在(仍然装不下)", !xbtn.hidden);
  ok("⑪ 收起态也记住了", localStorage.getItem("zhujian.filter-tags-open") === "0");

  // 还原人为收窄 ⇒ 又装得下了 ⇒ 钮该自己藏回去(证明显隐是**随宽度重算**的,
  // 不是「出来过一次就一直在」)。
  trow.style.maxWidth = "";
  await sleep(120); // 同样不重渲:反方向也得自己算回来
  ok("⑪c 还原宽度后钮又自己藏回去(显隐随宽度双向重算)", xbtn.hidden && !overflows());

  // 过滤框:9.5em(123.5px)→ 6em,动笔才张到 11em(一直 6em 的话打三个字就看不见自己
  // 打了什么 = 把一个患换成另一个患)。
  // ⚠ **这一格只验得了 CSS 那半**:`f.focus()` 在文档没有窗口焦点时只改 activeElement、
  // **一个 focus 事件都不发**(Chromium 把它们推迟到文档重新获得焦点;本轮实测 evts 为空、
  // 而 activeElement 已经是它了),而 CDP 驱动下恒是这种状态。JS 那半(focusin 挂 .wide)
  // 要**原生轻点**才验得到,做法见文件头「原生半截」。
  const wRest = ftext.getBoundingClientRect().width;
  ok("⑪ 过滤框歇着时窄了(≤84px;原先 123.5px)", wRest <= 84, { w: +wRest.toFixed(1) });
  ftext.classList.add("wide");
  await sleep(280); // 等 width 那条 0.18s 过渡跑完再量
  const wWide = ftext.getBoundingClientRect().width;
  ftext.classList.remove("wide");
  ok("⑪ 挂上 .wide 真的张开(CSS 半;JS 半见文件头)", wWide > wRest + 30, { rest: +wRest.toFixed(1), wide: +wWide.toFixed(1) });

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
