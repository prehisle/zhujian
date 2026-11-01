// @cdp-run single timeout=90000
// 157 G3(W1 走查手机那半:WM-07 / 13 / 14 / 15 / 10 / 08 / 12 / 22 / 24 / 26 / 27 / 09)的页内可断言部分。两趟:
//   第一趟(phase 空)直调命令播种(一条随记带一张图 + 一条清单带空行 + 一枚超长无色标签),回 `{needReload:true}`;
//   驱动者 `eval 'location.reload()'` 后再跑第二趟才验,末尾 purge 种子、删标签(回收站零残留)。
// 第二趟验:
//  ① 挂 / 摘超长标签时操作面不跳(面板顶前后差 ≤ 2px);卡脚的长标签胶囊一行省略、不折行。
//  ② 无色标签在卡上画空心圈(`○`)。
//  ③ 筛选行摊开态:超长标签名省略、计数仍露在 pill 里、pill 不越出行;点一枚标签后收回单行、存着的偏好不变。
//  ④ 标签 + 词叠着筛空:空态点名标签那层、名词是「随记」。
//  ⑤ 看图层:有关闭钮且点了就关;删图回执带「撤销」,点了图回来。
//  ⑥ 清单两组之间的空行在卡上占一行。
//  ⑦ 时间轴底留出 ＋ 的高(72px);`--head-h` 是小数真高(吸顶不漏缝)。
// 前置:界面语言中文。
// 原生半截(每轮真机发):编辑态按返回收键盘 → `adb shell input tap` 点图上的 × → `dumpsys input_method | grep mInputShown` 仍 false。
// 阴性对照:见 progress-log 同号条目(撤掉产品改动后哪几格红)。
(async () => {
  const PHASE_KEY = "zj.w157g3.phase";
  const out = { pass: false, steps: [] };
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra === undefined ? {} : { extra }) });
    return !!cond;
  };
  const I = window.__TAURI_INTERNALS__;
  const inv = (c, a) => I.invoke(c, { spaceId: "main", ...a });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const v = fn();
      if (v) return v;
      await sleep(50);
    }
    return null;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const LONG = "W157G3一个特别特别长的标签名字用来看折行和截断会怎样";
  const MARK = "W157G3-图卡";
  const CK = "W157G3-清单\n- [ ] milk\n\n- [ ] bread";
  const card = (m) => [...document.querySelectorAll("#timeline article.card[data-id]")].find((c) => c.textContent.includes(m));
  const panel = () => card(MARK)?.querySelector(".panel") ?? null;
  const pact = (a) => panel()?.querySelector(`[data-pact="${a}"]`) ?? null;

  if (document.documentElement.lang !== "zh") {
    ok("前置:界面语言是中文", false, { htmlLang: document.documentElement.lang });
    return JSON.stringify(out);
  }
  const phase = localStorage.getItem(PHASE_KEY);
  if (!phase) {
    const topicId = await inv("create_topic", { title: LONG });
    const id = await inv("capture_idea", { content: MARK });
    const ckId = await inv("capture_idea", { content: CK });
    const c = document.createElement("canvas");
    c.width = 600;
    c.height = 400;
    const x = c.getContext("2d");
    x.fillStyle = "#3a6";
    x.fillRect(0, 0, 600, 400);
    const b64 = c.toDataURL("image/png").split(",")[1];
    const img = await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: b64 });
    localStorage.setItem(PHASE_KEY, JSON.stringify({ topicId, id, ckId, imgId: img.id }));
    return JSON.stringify({ needReload: true });
  }
  const seed = JSON.parse(phase);
  const tagsOpenBefore = localStorage.getItem("zhujian.filter-tags-open");
  try {
    if (!ok("前置:种子卡在时间轴上", !!(await until(() => card(MARK) && card("W157G3-清单"), 8000)))) return JSON.stringify(out);
    document.getElementById("error").hidden = true;

    // ① 挂 / 摘超长标签,操作面不跳
    card(MARK).scrollIntoView({ block: "center" });
    await sleep(300);
    click(card(MARK).querySelector(".body"));
    ok("开操作面", !!(await until(() => pact("tags"))));
    click(pact("tags"));
    const pill = () => panel()?.querySelector(`[data-topic="${seed.topicId}"]`) ?? null;
    ok("进标签子面", !!(await until(pill)));
    const top0 = panel().getBoundingClientRect().top;
    click(pill());
    const chip = () => card(MARK)?.querySelector(".chip.topic") ?? null;
    ok("挂上了(卡脚出现胶囊)", !!(await until(() => chip() && panel() && !panel().querySelector("[disabled]"), 6000)));
    await sleep(400);
    const top1 = panel().getBoundingClientRect().top;
    ok("挂上后操作面没跳(≤2px)", Math.abs(top1 - top0) <= 2, { top0, top1 });
    const cr = chip().getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(chip()).lineHeight) || 20;
    ok("卡脚长标签一行省略不折行", cr.height < lh * 1.6 && chip().scrollWidth > chip().clientWidth, { h: cr.height, lh });
    ok("无色标签画空心圈", getComputedStyle(chip(), "::before").content.includes("○"));
    click(pill());
    ok("摘掉了", !!(await until(() => !chip() && panel() && !panel().querySelector("[disabled]"), 6000)));
    await sleep(400);
    const top2 = panel().getBoundingClientRect().top;
    ok("摘掉后操作面没跳(≤2px)", Math.abs(top2 - top0) <= 2, { top0, top2 });
    // 收面:返回两下
    window.__zhujianHandleBack();
    await sleep(200);
    window.__zhujianHandleBack();
    await until(() => !panel());
    // 为③④再挂上(直调 + 走一次 UI 写后的刷新:点卡开面再收,不够 ⇒ 用标签子面那条路挂)
    click(card(MARK).querySelector(".body"));
    await until(() => pact("tags"));
    click(pact("tags"));
    await until(pill);
    click(pill());
    await until(() => chip() && panel() && !panel().querySelector("[disabled]"), 6000);
    window.__zhujianHandleBack();
    await sleep(200);
    window.__zhujianHandleBack();
    await until(() => !panel());

    // ③ 筛选行摊开态
    document.scrollingElement.scrollTop = 0;
    const fbar = document.getElementById("filterbar");
    const expand = document.getElementById("filter-expand");
    if (!fbar.classList.contains("tags-open")) {
      if (!expand.hidden) click(expand);
    }
    ok("摊开了", !!(await until(() => fbar.classList.contains("tags-open"))));
    const fp = () => document.querySelector(`#filter-topics .fpill[data-topic-id="${seed.topicId}"]`);
    ok("筛选行有那枚长标签", !!(await until(fp)));
    const row = document.getElementById("filter-topics").getBoundingClientRect();
    const pr = fp().getBoundingClientRect();
    const lab = fp().querySelector(".flabel");
    const fn = fp().querySelector(".fn");
    ok("pill 不越出行", pr.right <= row.right + 0.5, { pr: pr.right, row: row.right });
    ok("名字省略", !!lab && lab.scrollWidth > lab.clientWidth);
    ok("计数露在 pill 里", !!fn && fn.getBoundingClientRect().right <= pr.right && fn.getBoundingClientRect().width > 0);
    ok("无色标签 pill 画空心圈", getComputedStyle(fp(), "::before").content.includes("○"));
    const pref = localStorage.getItem("zhujian.filter-tags-open");
    click(fp());
    ok("点了标签就收回单行", !!(await until(() => !fbar.classList.contains("tags-open"))));
    ok("存着的偏好不变", localStorage.getItem("zhujian.filter-tags-open") === pref, { pref });
    const fpr = fp().getBoundingClientRect();
    const row2 = document.getElementById("filter-topics").getBoundingClientRect();
    ok("选中那枚滚进单行视野", fpr.left >= row2.left - 1 && fpr.left < row2.right, { l: fpr.left, row: [row2.left, row2.right] });

    // ④ 标签 + 词筛空
    const ft = document.getElementById("filter-text");
    ft.value = "zzq绝无此词";
    ft.dispatchEvent(new Event("input", { bubbles: true }));
    const emp = await until(() => document.querySelector("#timeline p.empty"));
    const et = emp?.textContent ?? "";
    ok("空态点名标签那层", et.includes(`「${LONG}」下没有匹配「zzq绝无此词」的随记`), { et });
    ft.value = "";
    ft.dispatchEvent(new Event("input", { bubbles: true }));
    const allPill = [...document.querySelectorAll("#filter-topics .fpill")].find((b) => b.textContent.startsWith("所有"));
    if (allPill) click(allPill);
    await until(() => card("W157G3-清单"));

    // ⑤ 看图层
    const viewer = document.getElementById("viewer");
    const openThumb = async () => {
      const th = card(MARK)?.querySelector(".thumb[data-img]");
      if (!th) return null;
      click(th);
      return until(() => !viewer.hidden);
    };
    ok("开图", !!(await openThumb()));
    const vc = document.getElementById("viewer-close");
    ok("看图层有关闭钮", !!vc && vc.getBoundingClientRect().width >= 40);
    const bg = getComputedStyle(document.getElementById("viewer-del")).backgroundColor;
    ok("删除钮底色几乎不透", /rgba\(0, 0, 0, 0\.9\d*\)/.test(bg), { bg });
    click(vc);
    ok("点关闭钮就关", !!(await until(() => viewer.hidden, 1500)));
    await sleep(300);
    await openThumb();
    click(document.getElementById("viewer-del"));
    await until(() => !document.getElementById("confirmbar").hidden, 1500);
    click(document.getElementById("confirmbar-yes"));
    const undo = await until(() => document.querySelector("#error:not([hidden]) .bar-act"), 4000);
    ok("删图回执带撤销", !!undo && undo.textContent === "撤销", { text: document.getElementById("error").textContent });
    ok("…图从卡上消失", !!(await until(() => !card(MARK)?.querySelector(".thumb[data-img]"), 4000)));
    if (undo) click(undo);
    ok("点撤销图回来", !!(await until(() => card(MARK)?.querySelector(".thumb[data-img]"), 6000)));

    // ⑥ 清单空行
    const lines = [...card("W157G3-清单").querySelectorAll(".ckline")];
    if (ok("清单两项都在", lines.length === 2)) {
      const gap = lines[1].getBoundingClientRect().top - lines[0].getBoundingClientRect().bottom;
      const lh2 = parseFloat(getComputedStyle(card("W157G3-清单").querySelector(".content")).lineHeight) || 20;
      ok("两组之间的空行占一行", gap >= lh2 * 0.8, { gap, lh: lh2 });
    }

    // ⑦ 几何
    ok("时间轴底留 72px", getComputedStyle(document.getElementById("timeline")).paddingBottom === "72px");
    const hh = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--head-h"));
    ok("--head-h 是真高", Math.abs(hh - document.querySelector("header").getBoundingClientRect().height) < 0.01, { hh });
  } finally {
    // 清场:条目软删再 purge(回收站零残留)、删标签、偏好还原
    for (const id of [seed.id, seed.ckId]) {
      try {
        await inv("archive_note", { id });
      } catch {}
      try {
        await inv("purge_note", { id });
      } catch {}
    }
    try {
      await inv("delete_topic", { id: seed.topicId });
    } catch {}
    if (tagsOpenBefore === null) localStorage.removeItem("zhujian.filter-tags-open");
    else localStorage.setItem("zhujian.filter-tags-open", tagsOpenBefore);
    localStorage.removeItem(PHASE_KEY);
    const tl = await inv("list_timeline", {});
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes("W157G3")));
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
