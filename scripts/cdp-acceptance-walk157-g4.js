// @cdp-run phase timeout=120000
// 157 G4(W1 走查用户拍的十三条规矩)手机那半的页内可断言部分。两趟:
//   第一趟(phase 空)直调命令播种,回 `{needReload:true}`;驱动者 `eval 'location.reload()'` 后跑第二趟才验,
//   末尾 purge 种子、删标签(回收站零残留)。
// 第二趟验:
//  P13 随记面长卡也折(八行)、短卡不长钮;
//  P12 缩略图按比例定宽(宽图 160、长图 36);
//  P10 筛着一枚标签时卡上那枚胶囊照常显示;P11 清掉筛选回到原阅读位置;
//  P8  已在随记面再点「随记」= 回顶;
//  P4  留言「销毁」收在 ⋯ 后面;
//  P1  编辑层:返回 = 保存;「取消」改过了先问一句,确认才丢;
//  P2  删随记一点即删(不弹确认条)+ 撤销;
//  P3  转待办回执带「撤销」与「去看看」,去看看落到任务面、新待办在「待办」那一节最上。
// 前置:界面语言中文;随记面、没开任何面板。
// 原生半截(每轮真机发):编辑层改一个字后 `adb shell input keyevent 4` → 层收起、库里是新字。
(async () => {
  const PHASE_KEY = "zj.w157g4.phase";
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
  const $ = (id) => document.getElementById(id);
  const card = (m) => [...document.querySelectorAll("#timeline article.card[data-id]")].find((c) => c.textContent.includes(m));
  const pact = (m, a) => card(m)?.querySelector(`.panel [data-pact="${a}"]`) ?? null;
  const TAG = "W157G4-标签";
  const LONG = "W157G4-长\n" + Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 行`).join("\n");
  const png = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const x = c.getContext("2d");
    x.fillStyle = "#58a";
    x.fillRect(0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  };

  if (document.documentElement.lang !== "zh") {
    ok("前置:界面语言是中文", false, { htmlLang: document.documentElement.lang });
    return JSON.stringify(out);
  }
  const phase = localStorage.getItem(PHASE_KEY);
  if (!phase) {
    const ids = {};
    ids.topic = await inv("create_topic", { title: TAG });
    ids.long = await inv("capture_idea", { content: LONG });
    ids.img = await inv("capture_idea", { content: "W157G4-图" });
    await inv("add_item_image", { itemId: ids.img, mime: "image/png", dataB64: png(1600, 400) });
    await inv("add_item_image", { itemId: ids.img, mime: "image/png", dataB64: png(400, 1400) });
    ids.tagged = await inv("capture_idea", { content: "W157G4-挂标签" });
    await inv("file_note_to_topic", { id: ids.tagged, topicId: ids.topic, newTitle: null });
    ids.cm = await inv("capture_idea", { content: "W157G4-留言" });
    await inv("add_item_comment", { itemId: ids.cm, content: "W157G4 一句留言" });
    ids.edit = await inv("capture_idea", { content: "W157G4-编辑" });
    ids.del = await inv("capture_idea", { content: "W157G4-删" });
    ids.promo = await inv("capture_idea", { content: "W157G4-转" });
    localStorage.setItem(PHASE_KEY, JSON.stringify(ids));
    return JSON.stringify({ needReload: true });
  }
  const ids = JSON.parse(phase);
  const live = async () => await inv("list_timeline", {});
  try {
    if (!ok("前置:种子在时间轴上", !!(await until(() => card("W157G4-转") && card("W157G4-长"), 8000)))) return JSON.stringify(out);
    $("error").hidden = true;

    // P13
    const lc = card("W157G4-长");
    const lp = lc.querySelector(".content");
    ok("P13 长随记夹着", lp.classList.contains("clamped") && lp.scrollHeight > lp.clientHeight);
    ok("P13 长随记有展开钮", !!lc.querySelector(".fold-toggle"));
    ok("P13 短随记没钮", !card("W157G4-删").querySelector(".fold-toggle"));

    // P12
    card("W157G4-图").scrollIntoView({ block: "center" });
    const thumbs = await until(() => {
      const t = [...card("W157G4-图").querySelectorAll(".thumb[data-img]")];
      return t.length === 2 && t.every((x) => x.querySelector("img")?.complete && x.style.width) ? t : null;
    }, 8000);
    const ws = thumbs ? thumbs.map((t) => Math.round(t.getBoundingClientRect().width)) : [];
    ok("P12 宽图 160、长图 36(按比例,夹在两头)", ws[0] === 160 && ws[1] === 36, { ws });

    // P11 + P10
    document.scrollingElement.scrollTop = 0;
    await sleep(100);
    lc.scrollIntoView({ block: "start" });
    await sleep(200);
    const y0 = window.scrollY;
    const pill = document.querySelector(`#filter-topics .fpill[data-topic-id="${ids.topic}"]`);
    if (ok("P10 前置:筛选行有那枚标签", !!pill)) {
      click(pill);
      await until(() => !card("W157G4-长"));
      ok("P10 筛着它时卡上那枚胶囊照常显示", [...card("W157G4-挂标签").querySelectorAll(".chip.topic")].some((c) => c.textContent === TAG));
      const all = [...document.querySelectorAll("#filter-topics .fpill")].find((b) => b.textContent.startsWith("所有"));
      click(all);
      await until(() => card("W157G4-长"));
      await sleep(100);
      ok("P11 清掉筛选回原阅读位置", Math.abs(window.scrollY - y0) < 2, { y0, y1: window.scrollY });
    }

    // P8
    ok("P8 前置:不在顶上", window.scrollY > 50);
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
    ok("P8 再点「随记」= 回顶", !!(await until(() => window.scrollY === 0, 3000)), { y: window.scrollY });
    ok("P8 没拉起记一笔", $("capture-scrim").hidden);

    // P4
    const badge = card("W157G4-留言").querySelector(".cm-badge, [data-cm]");
    if (ok("P4 前置:留言徽章在", !!badge)) {
      click(badge);
      const del = await until(() => $("cm-list").querySelector(".cm-del"), 4000);
      ok("P4 「销毁」平时藏着", !!del && getComputedStyle(del).display === "none");
      click($("cm-list").querySelector(".cm-opt"));
      ok("P4 点 ⋯ 才露出「销毁」", !!del && getComputedStyle(del).display !== "none" && del.textContent === "销毁");
      window.__zhujianHandleBack();
      await until(() => document.querySelector(".cmsheet")?.getBoundingClientRect().top >= innerHeight - 1 || !document.body.classList.contains("cm-open"), 3000);
      await sleep(400);
    }

    // P1
    const openEdit = async () => {
      card("W157G4-编辑").scrollIntoView({ block: "center" });
      click(card("W157G4-编辑").querySelector(".body"));
      await until(() => pact("W157G4-编辑", "edit"));
      click(pact("W157G4-编辑", "edit"));
      return until(() => !$("edit-scrim").hidden, 3000);
    };
    const type = (v) => {
      const ta = $("edit-text");
      ta.value = v;
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    };
    ok("P1 开编辑层", !!(await openEdit()));
    type("W157G4-编辑 改一");
    window.__zhujianHandleBack();
    ok("P1 返回 = 保存:层收起", !!(await until(() => $("edit-scrim").hidden, 4000)));
    ok("P1 返回 = 保存:库里是新字", !!(await (async () => (await live()).some((x) => x.id === ids.edit && x.content === "W157G4-编辑 改一"))()));
    await until(() => card("W157G4-编辑 改一"), 3000);
    if (card("W157G4-编辑")?.querySelector(".panel")) click(card("W157G4-编辑").querySelector(".body"));
    await sleep(300);
    ok("P1 再开编辑层", !!(await openEdit()));
    type("W157G4-编辑 改二");
    click($("edit-cancel"));
    ok("P1 改过了点取消先问一句", !!(await until(() => !$("confirmbar").hidden && $("confirmbar-q").textContent === "丢掉这次的修改?", 2000)));
    ok("P1 …层还开着", !$("edit-scrim").hidden);
    click($("confirmbar-yes"));
    ok("P1 确认后才丢:层收起", !!(await until(() => $("edit-scrim").hidden, 3000)));
    ok("P1 确认后才丢:库里仍是改一", (await live()).some((x) => x.id === ids.edit && x.content === "W157G4-编辑 改一"));
    if (card("W157G4-编辑")?.querySelector(".panel")) click(card("W157G4-编辑").querySelector(".body"));
    await sleep(300);

    // P2
    $("error").hidden = true;
    click(card("W157G4-删").querySelector(".body"));
    await until(() => pact("W157G4-删", "more"));
    click(pact("W157G4-删", "more"));
    await until(() => pact("W157G4-删", "del"));
    click(pact("W157G4-删", "del"));
    ok("P2 不弹确认条", $("confirmbar").hidden);
    ok("P2 一点即删", !!(await until(() => !card("W157G4-删"), 4000)));
    const undo = await until(() => document.querySelector("#error:not([hidden]) .bar-act"), 3000);
    ok("P2 回执带撤销", !!undo && undo.textContent === "撤销");
    if (undo) click(undo);
    ok("P2 撤销后回来", !!(await until(() => card("W157G4-删"), 5000)));

    // P3
    $("error").hidden = true;
    click(card("W157G4-转").querySelector(".body"));
    await until(() => pact("W157G4-转", "promote"));
    click(pact("W157G4-转", "promote"));
    const acts = await until(() => {
      const b = [...document.querySelectorAll("#error:not([hidden]) .bar-act")];
      return b.length === 2 ? b : null;
    }, 4000);
    ok("P3 回执带「撤销」「去看看」", !!acts && acts[0].textContent === "撤销" && acts[1].textContent === "去看看", {
      text: $("error").textContent,
    });
    if (acts) click(acts[1]);
    ok("P3 去看看 = 切到任务面", !!(await until(() => document.querySelector('#bottombar [data-mode="tasks"]')?.classList.contains("on") || document.body.dataset.view === "tasks", 4000)));
    const promoCard = await until(() => card("W157G4-转"), 4000);
    const sec = promoCard?.closest(".tl-group");
    const first = sec?.querySelector("article.card[data-id]");
    ok("P3 新待办在那一节最上", !!first && first.dataset.id === ids.promo, { firstId: first?.dataset.id });
    click(document.querySelector('#bottombar [data-mode="ideas"]'));
    await sleep(300);
  } catch (e) {
    ok("没抛异常", false, String(e));
  } finally {
    for (const k of ["long", "img", "tagged", "cm", "edit", "del"]) {
      try {
        await inv("archive_note", { id: ids[k] });
      } catch {}
      try {
        await inv("purge_note", { id: ids[k] });
      } catch {}
    }
    for (const c of ["archive_note", "purge_note", "archive_task", "purge_task"]) {
      try {
        await inv(c, { id: ids.promo });
      } catch {}
    }
    try {
      await inv("delete_topic", { id: ids.topic });
    } catch {}
    localStorage.removeItem(PHASE_KEY);
    const tl = await live();
    ok("清场:种子不在时间轴", !tl.some((i) => String(i.content).includes("W157G4")));
  }
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
