// @cdp-run single timeout=60000
// 157 G1(W1 走查 WM-02 / WM-01 / WM-06)的页内可断言部分:
//  ① 返回键收卡片操作面:子面(标签)→ 回主面 → 收面 → 再按才放行退 app(`__zhujianHandleBack` 回 false)。
//     此前操作面 / 卡内标签选择器开着时按返回直接退出 app(操作面不压守门条目,无层可关就回 false)。
//  ② 确认条读秒到点:先进余温态(说「没确认,已作罢」、两钮灰、条高不变、那一点仍落在条上),
//     `BAR_RETIRE_MS` 后才收;条目没被删。
//  ③ 提示条读秒到点:同样先余温(整条淡、仍在原位接点)再收。
//
// 前置:界面语言中文;库可以是空的 —— 本资产自播一条随记,末尾 purge 掉(回收站零残留)。
// 种子走「＋ 记一笔」那条用户路(直调命令不会让时间轴重查),⛔ 不 reload。
// 原生半截(每轮真机发):开卡片操作面 → 「标签」→ `adb shell input keyevent 4` 两次 → 面收起、
//   朱简仍在前台(`dumpsys window | grep mCurrentFocus`);第三次才退到桌面。
// 阴性对照:把 main.ts 里那句 `return cardPanel.backOut();` 换回 `return false;`,①红在第一格;
//   把 ui.ts confirmBar 到点那支换回直接 hideConfirmBar,②红在「余温」那几格。
(async () => {
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
      if (fn()) return true;
      await sleep(50);
    }
    return false;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const back = () => window.__zhujianHandleBack();
  const MARK = "W157-G1-种子";
  const card = () => [...document.querySelectorAll("#timeline article.card[data-id]")].find((c) => c.textContent.includes(MARK));
  const panel = () => card()?.querySelector(".panel") ?? null;
  const pact = (a) => panel()?.querySelector(`[data-pact="${a}"]`) ?? null;
  let seedId = null;

  if (document.documentElement.lang !== "zh") {
    ok("前置:界面语言是中文", false, { htmlLang: document.documentElement.lang });
    return JSON.stringify(out);
  }
  try {
    // 走「记一笔」那条用户路播种:直调 capture_idea 不会让时间轴重查(前端只在启动 / 切空间 / 同步事件 / 自家写后才刷)
    click(document.getElementById("capture-fab"));
    const text = document.getElementById("text");
    await until(() => !document.getElementById("capture-scrim").hidden, 2000);
    text.value = MARK;
    text.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("save"));
    const seeded = await until(() => !!card(), 6000);
    seedId = card()?.dataset.id ?? null;
    if (!ok("前置:种子卡上了时间轴", seeded && seedId !== null)) return JSON.stringify(out);
    await sleep(600); // 捕获层收层那记 history.back() 归账,别让它与下面的返回键撞在一起
    const $err = document.getElementById("error");
    $err.hidden = true;

    // ① 返回键收操作面
    click(card().querySelector(".body"));
    ok("开操作面", await until(() => !!pact("tags")));
    click(pact("tags"));
    ok("进标签子面", await until(() => !!panel()?.querySelector(".tagnew")));
    ok("返回键①被吃掉(不退 app)", back() === true);
    ok("…回到两行主面", await until(() => !!pact("edit") && !panel().querySelector(".tagnew")));
    ok("返回键②被吃掉", back() === true);
    ok("…操作面收起", await until(() => !panel()));
    ok("返回键③无层可关 ⇒ 放行退 app", back() === false);

    // ② 确认条到点先余温
    click(card().querySelector(".body"));
    await until(() => !!pact("more"));
    click(pact("more"));
    await until(() => !!pact("del"));
    click(pact("del"));
    const cb = document.getElementById("confirmbar");
    const yes = document.getElementById("confirmbar-yes");
    const q = document.getElementById("confirmbar-q");
    ok("删除第一拍弹确认条", await until(() => !cb.hidden, 1500));
    const h0 = cb.getBoundingClientRect().height;
    ok("6s 内还是原样", (await sleep(5500), !cb.hidden && !cb.classList.contains("retiring")));
    ok("到点进余温态", await until(() => cb.classList.contains("retiring"), 1500));
    ok("余温:话术是「没确认,已作罢」", q.textContent === "没确认,已作罢", q.textContent);
    ok("余温:两钮都灰", yes.disabled && document.getElementById("confirmbar-no").disabled);
    ok("余温:条高没变", Math.abs(cb.getBoundingClientRect().height - h0) < 1, { h0, h1: cb.getBoundingClientRect().height });
    const r = yes.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    ok("余温:点在确认钮的位置仍落在条上(不漏到底下)", !!hit && cb.contains(hit), hit?.outerHTML?.slice(0, 80));
    click(yes); // 迟到的那一下:灰钮不执行
    ok("余温后收起", await until(() => cb.hidden, 2000));
    ok("条目没被删", (await inv("list_timeline", {})).some((x) => x.id === seedId));
    if (panel()) click(card().querySelector(".body"));

    // ③ 提示条到点先余温(「复制链接」的回执;测试机的剪贴板被写一次)
    await until(() => !panel());
    click(card().querySelector(".body"));
    await until(() => !!pact("more"));
    click(pact("more"));
    await until(() => !!pact("copylink"));
    click(pact("copylink"));
    ok("复制链接回执出现", await until(() => !$err.hidden, 2000), $err.textContent);
    ok("回执到点进余温态", await until(() => $err.classList.contains("retiring"), 7000));
    ok("余温:还在原位", !$err.hidden);
    ok("余温后收起", await until(() => $err.hidden, 2000));
    if (panel()) click(card().querySelector(".body"));
  } catch (e) {
    ok("没抛异常", false, String(e));
  } finally {
    if (seedId !== null) {
      try {
        await inv("archive_note", { id: seedId });
        await inv("purge_note", { id: seedId });
      } catch (e) {
        ok("清场", false, String(e));
      }
      ok("清场干净", !(await inv("list_timeline", {})).some((x) => x.id === seedId));
    }
  }
  out.pass = out.steps.length > 0 && out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
