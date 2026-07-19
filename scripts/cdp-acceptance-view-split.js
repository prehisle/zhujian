// 146 主视图分面(灵感/任务)验收 —— 经 android-cdp.mjs evalfile 注入 WebView。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-view-split.js
// 断言:灵感面无任务卡 / compose 草稿跨面保留+placeholder 随面换 / 任务面记下落
// 分组并 flash / 保存在飞追加(真 input)不被成功回包清掉 / 转待办离场+回执指路 /
// 搜索命中任务跳任务面定位 / 卡片编辑草稿拒切面 / pane 开着点 mode=关面切面 /
// focus 在途被用户切面作废 / refresh 在途切面只投影当前面 / 关层在飞再开层(挂账补压)。
// 真数据全流程,**清场走 finally**(中途断言失败也不留残留);不切空间、不依赖执行顺序。
// 空间切换保 mode 见 cdp-acceptance-view-split-space.js(多空间守卫,单独跑);
// 「任务面按返回一次退 app」是硬件返回半截,归真机 adb runbook,不在此断言。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(80);
    }
  };
  const ta = document.getElementById("text");
  const cb = document.getElementById("confirmbar");
  const modeBtn = (m) => document.querySelector(`#bottombar [data-mode="${m}"]`);
  const activeMode = () =>
    [...document.querySelectorAll("#bottombar [data-mode]")].find((b) =>
      b.classList.contains("active"),
    )?.dataset.mode;
  const paneOpen = () => document.body.classList.contains("pane-open");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const findCard = (text) =>
    [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
      c.querySelector(".content")?.textContent.includes(text),
    );
  const typeInto = (el, text) => {
    el.value = text; // 直赋 + dispatch input:走真实输入通道(在飞标志靠 input 事件)
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const created = []; // finally 清场用:本脚本建的所有条目 id

  try {
    // ① 启动基线:恒落灵感面、无任务勾框、placeholder=灵感
    if (activeMode() !== "ideas") {
      click(modeBtn("ideas"));
      await until(() => activeMode() === "ideas");
    }
    ok("灵感面无任务勾框", !document.querySelector("#timeline .tick"));
    ok("灵感面 placeholder", ta.placeholder.includes("灵感"));

    // ② compose 草稿跨面保留 + placeholder 随面换
    typeInto(ta, "【CDP验收146】草稿跨面");
    click(modeBtn("tasks"));
    await until(() => activeMode() === "tasks");
    ok("切任务面 placeholder 换", ta.placeholder.includes("待办"));
    ok("草稿随面走", ta.value === "【CDP验收146】草稿跨面");
    typeInto(ta, "");

    // ③ 任务面记下 → 落分组结构并 flash(回执由结构天然消解)
    const markerT = `【CDP验收146】任务面记下 ${Date.now()}`;
    typeInto(ta, markerT);
    click(document.getElementById("save"));
    const cardT = await until(() => findCard(markerT));
    if (!ok("任务面记下入列", !!cardT)) throw new Error("abort");
    const idT = cardT.dataset.id;
    created.push(idT);
    ok("新卡落在四态分组里", !!cardT.closest(".tl-group"));
    ok("新卡 flash 回执", cardT.classList.contains("flash"));

    // ④ 灵感面记下 + 保存在飞追加(真 input 事件)不被成功回包清掉
    click(modeBtn("ideas"));
    await until(() => activeMode() === "ideas");
    const markerI = `【CDP验收146】灵感转待办 ${Date.now()}`;
    typeInto(ta, markerI);
    click(document.getElementById("save")); // save 同步取走并清框
    typeInto(ta, "【CDP验收146】在飞追加"); // 此刻写入的就是在飞新输入(liveDraft)
    const cardI = await until(() => findCard(markerI));
    if (!ok("灵感面记下入列", !!cardI)) throw new Error("abort");
    const idI = cardI.dataset.id;
    created.push(idI);
    ok("在飞追加不被成功回包清掉", ta.value === "【CDP验收146】在飞追加");
    typeInto(ta, "");

    // ⑤ 转待办:卡离开灵感面 + 回执指路「任务」
    click(cardI.querySelector(".content"));
    const promote = await until(() => cardI.querySelector('.panel [data-pact="promote"]'));
    if (!ok("灵感卡面板有「转待办」", !!promote)) throw new Error("abort");
    click(promote);
    await until(() => !cardOf(idI));
    ok("转待办后离开灵感面", !cardOf(idI));
    const err = document.getElementById("error");
    ok("离场回执指路「任务」", !err.hidden && err.textContent.includes("任务"));

    // ⑥ 搜索命中任务 → 关面 + 跳任务面 + 定位闪卡
    click(document.getElementById("search-toggle"));
    document.getElementById("search-input").value = markerI;
    click(document.getElementById("search-btn"));
    const hit = await until(() => document.querySelector(`#search-results [data-hit="${idI}"]`));
    if (!ok("搜索命中该任务", !!hit)) throw new Error("abort");
    click(hit.querySelector(".content"));
    const landed = await until(
      () => !paneOpen() && activeMode() === "tasks" && cardOf(idI)?.classList.contains("flash"),
    );
    ok("命中任务跳任务面并闪卡", !!landed);

    // ⑦ 卡片编辑草稿拒切面(compose 草稿不挡,②已验它随面走)
    const c2 = cardOf(idI);
    click(c2.querySelector(".content"));
    const editBtn = await until(() => c2.querySelector('.panel [data-pact="edit"]'));
    click(editBtn);
    await until(() => c2.querySelector("textarea.edit"));
    click(modeBtn("ideas"));
    await sleep(150);
    ok("卡片编辑草稿挡切面", activeMode() === "tasks");
    click(c2.querySelector('.panel [data-pact="cancel"]'));
    await until(() => !c2.querySelector("textarea.edit"));

    // ⑧ pane 开着点 mode:关面 + 落对应面(高亮跟 mode,无 pane-open 残留)
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    await until(() => paneOpen());
    click(modeBtn("ideas"));
    const closed = await until(() => !paneOpen() && activeMode() === "ideas");
    ok("pane 开着点灵感=关面切面", !!closed);

    // ⑨ focus 在途被用户切面作废:点搜索命中(定位目标=任务面)后立刻点「灵感」,
    //    用户导航必须赢——若旧 focus 反抢,最终会落在任务面并闪卡。
    click(document.getElementById("search-toggle"));
    document.getElementById("search-input").value = markerI;
    click(document.getElementById("search-btn"));
    const hit2 = await until(() => document.querySelector(`#search-results [data-hit="${idI}"]`));
    if (!ok("竞态步搜索命中", !!hit2)) throw new Error("abort");
    click(hit2.querySelector(".content")); // focus 启动(同步段已关面、refresh 在途)
    click(modeBtn("ideas")); // navSeq++:旧 focus 作废
    await sleep(700);
    ok("focus 在途被切面作废(用户赢)", activeMode() === "ideas" && !paneOpen());

    // ⑩ refresh 在途切面:任务面勾完成(写+refresh 在途)后立刻切灵感面,
    //    迟到响应只许投影当前面(灵感面不得出现 .tick/任务卡)。
    click(modeBtn("tasks"));
    await until(() => activeMode() === "tasks");
    const tick = cardOf(idT)?.querySelector(".tick input");
    if (!ok("任务卡有勾框", !!tick)) throw new Error("abort");
    tick.checked = true;
    tick.dispatchEvent(new Event("change", { bubbles: true })); // completeTask + refresh 在途
    click(modeBtn("ideas"));
    await sleep(900); // 等在途 refresh 落定
    ok("refresh 在途切面只投影当前面", activeMode() === "ideas" && !document.querySelector("#timeline .tick"));

    // ⑪ 关层在飞再开层(146 ▲▲M4 挂账补压):关面的 history.back 尚未收口时立刻重开,
    //    面应照开;随后 toggle 关闭应干净落地(账本与屏幕一致,无空炮/双弹)。
    const trashBtn = document.querySelector('#bottombar [data-pane="trash"]');
    click(trashBtn);
    await until(() => paneOpen());
    click(document.querySelector("header h1")); // 关面:back 在飞
    click(trashBtn); // back 收口前重开:pushLayer 挂账
    await sleep(400);
    ok("back 在飞重开层照开", paneOpen());
    click(trashBtn); // toggle 关
    await until(() => !paneOpen(), 1000);
    ok("补压后 toggle 关面干净", !paneOpen());
  } catch (e) {
    // 中途断言失败(abort)/意外异常:如实记账,不再早退——finally 清场与终审照常,
    // 最终统一序列化返回(早退 return 会先冻结返回串、finally 写入外部看不见)。
    out.runError = String(e);
  } finally {
    // ---- 清场(无论中途成败):卡片草稿先取消 → 两面找卡逐条删 → 回收站逐条彻底删
    // → **终审=全局搜索唯一前缀零命中**(覆盖灵感/任务/回收站/归档册与历史——按钮/行
    // 缺失不会静默算过,任何残留都会在搜索里现形,cleaned=false → pass=false)。
    out.cleaned = false;
    try {
      const cancelBtn = document.querySelector('#timeline .panel [data-pact="cancel"]');
      if (cancelBtn) {
        click(cancelBtn); // 开着的编辑/标签草稿会挡删除与切面:先取消
        await sleep(150);
      }
      if (cb && !cb.hidden) click(document.getElementById("confirmbar-no"));
      if (paneOpen()) {
        click(document.querySelector("header h1"));
        await until(() => !paneOpen(), 1000);
      }
      for (const id of created) {
        // 卡住在哪个面(promote 失败时可能还是灵感)就去哪个面删;两面都不在
        // = 可能已在回收站,交给下面的 purge 与终审判定。
        for (const m of ["tasks", "ideas"]) {
          if (cardOf(id)) break;
          click(modeBtn(m));
          await until(() => activeMode() === m, 1500);
          await sleep(120);
        }
        const c = cardOf(id);
        if (!c) continue;
        click(c.querySelector(".content"));
        const del = await until(() => c.querySelector('.panel [data-pact="del"]'), 1500);
        if (!del) continue;
        click(del);
        await until(() => !cb.hidden, 1500);
        click(document.getElementById("confirmbar-yes"));
        await until(() => !cardOf(id), 2000);
      }
      click(document.querySelector('#bottombar [data-pane="trash"]'));
      await until(() => paneOpen(), 1000);
      for (const id of created) {
        const row = await until(() => document.querySelector(`[data-trash="${id}"]`), 800);
        if (!row) continue;
        click(row.querySelector('[data-trash-act="purge"]'));
        await until(() => !cb.hidden, 1500);
        click(document.getElementById("confirmbar-yes"));
        await until(() => !document.querySelector(`[data-trash="${id}"]`), 2000);
      }
      click(document.querySelector('#bottombar [data-pane="trash"]'));
      await until(() => !paneOpen(), 1000);
      // 终审:唯一前缀全局搜索(连未入 created[] 的漏网新卡一并现形)。三态判定:
      // 只有明确等到「没有找到」终态才算清干净;有命中/搜索失败/超时都置假(fail-closed)。
      click(document.getElementById("search-toggle"));
      await until(() => paneOpen(), 1000);
      document.getElementById("search-input").value = "【CDP验收146】";
      click(document.getElementById("search-btn"));
      const verdict = await until(() => {
        const b = document.getElementById("search-results");
        if (b.querySelector("[data-hit]")) return "hits";
        if (b.textContent.includes("没有找到")) return "empty";
        if (b.textContent.includes("搜索失败")) return "failed";
        return null;
      }, 3000);
      out.searchVerdict = verdict ?? "timeout";
      out.leftovers = [...document.querySelectorAll("#search-results [data-hit]")].map(
        (h) => h.dataset.hit,
      );
      out.cleaned = verdict === "empty";
      click(document.getElementById("search-toggle"));
      await until(() => !paneOpen(), 1000);
      click(modeBtn("ideas"));
      await until(() => activeMode() === "ideas", 1500);
    } catch (e) {
      out.cleanupError = String(e);
      out.cleaned = false;
    }
  }

  // runError 显式入判(codex 四轮 M1):步骤间的意外异常(如 click(null))不许被
  // 「此前步骤全 true + 清场成功」掩成 pass。
  out.pass = out.steps.every((s) => s.ok) && out.cleaned === true && !out.runError;
  return JSON.stringify(out);
})();
