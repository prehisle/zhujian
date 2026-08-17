// 滑动改状态的回执条(402):操作型回执 actionBar 替换 confirmBar 挪用——
// 断言「恰一枚『撤销』钮、条上无『取消』、#confirmbar 全程不出场」+ 点撤销真回退。
// 依赖真触摸(swipe 判定走原生管线),故分两相、中间夹一发 CLI swipe:
//   ① node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-swipe-undo.js
//      → 播种探针任务卡,打印 {swipe:{x1,y1,x2,y2}} 坐标
//   ② node scripts/android-cdp.mjs swipe <x1> <y1> <x2> <y2>
//   ③ 再跑一遍 evalfile(同文件,靠 window.__swipeUndoProbe 认第二相)
//      → 断言 + 撤销 + 清场(彻底删除探针条目),pass=true 才算过
// ⚠ ②③ 必须紧跟着跑:撤销窗口 6s(CONFIRM_REVERT_MS),磨蹭掉了第二相红在「回执条在场」。
// 断言与语言无关:前后态以卡上 .pill 文本自证(swipe 前记下、swipe 后必变、撤销后必回),
// 「没有取消钮」以结构自证(恰一枚 .bar-act + #confirmbar 全程 hidden)——别绑死中文词,
// 模拟器常是 en 界面。
(async () => {
  const out = { pass: false, phase: 0, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const until = async (fn, ms = 4000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await new Promise((r) => setTimeout(r, 80));
    }
  };
  const err = document.getElementById("error");
  const cb = document.getElementById("confirmbar");
  const cardOf = (id) => document.querySelector(`#timeline [data-id="${id}"]`);
  const pillOf = (id) => cardOf(id)?.querySelector(".pill")?.textContent ?? null;

  const probe = window.__swipeUndoProbe;
  if (!probe) {
    // ---- 第一相:切任务面,种一张待办卡,吐滑动坐标 ----
    out.phase = 1;
    const tasksBtn = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasksBtn);
    if (!ok("切到任务面", await until(() => tasksBtn.classList.contains("active"), 2000)))
      return JSON.stringify(out);
    const marker = `【CDP验收】滑动撤销 ${Date.now()}`;
    const ta = document.getElementById("text");
    ta.value = marker;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("探针任务入时间轴", !!card)) return JSON.stringify(out);
    const id = card.dataset.id;
    const fromLabel = pillOf(id);
    if (!ok("出生带 stage 印(待办)", !!fromLabel)) return JSON.stringify(out);
    card.scrollIntoView({ block: "center" });
    await new Promise((r) => setTimeout(r, 200));
    const r = cardOf(id).getBoundingClientRect();
    // 起点取卡宽 35% 处(躲开左侧勾框),右滑 170px(> COMMIT_MIN 84 与卡宽 35% 阈值)。
    const swipe = {
      x1: Math.round(r.left + r.width * 0.35),
      y1: Math.round(r.top + r.height / 2),
      x2: Math.round(r.left + r.width * 0.35) + 170,
      y2: Math.round(r.top + r.height / 2),
    };
    window.__swipeUndoProbe = { id, fromLabel };
    out.pass = out.steps.every((s) => s.ok);
    out.swipe = swipe;
    out.next = `node scripts/android-cdp.mjs swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} && 再跑一遍本文件`;
    return JSON.stringify(out);
  }

  // ---- 第二相:swipe 已发。断言回执条形态 → 点撤销 → 断言回退 → 清场 ----
  out.phase = 2;
  const { id, fromLabel } = probe;
  try {
    const toLabel = await until(() => {
      const p = pillOf(id);
      return p && p !== fromLabel ? p : null;
    }, 3000);
    ok("滑动已提交:stage 前进一档", !!toLabel);
    if (!ok("回执条在场(6s 窗口内)", !err.hidden)) return JSON.stringify(out);
    ok("回执是 notice + with-act 形", err.classList.contains("notice") && err.classList.contains("with-act"));
    ok("文案点名新状态", !!toLabel && err.textContent.includes(toLabel));
    const btns = err.querySelectorAll("button");
    ok("恰一枚动作钮(.bar-act,无取消钮)", btns.length === 1 && btns[0].className === "bar-act");
    ok("confirmbar 没被挪用(全程 hidden)", cb.hidden);
    // 点撤销:回退 + 收条
    click(err.querySelector(".bar-act"));
    ok("撤销后回到原状态", (await until(() => pillOf(id) === fromLabel, 3000)) !== null);
    ok("点撤销即收条", await until(() => err.hidden, 1500));
    ok("撤销不弹确认(confirmbar 仍 hidden)", cb.hidden);
  } finally {
    // 清场:删进回收站 → 回收站彻底删(照 p1-ux ④ 的形;卡节点跨刷新按 id 现查)。
    // 开面板可能撞上撤销后的整轴重画(点了游离节点不冒泡、面板不开):没开就现查再点。
    let del = null;
    for (let i = 0; i < 3 && !del; i++) {
      const c = cardOf(id);
      if (!c) break;
      click(c.querySelector(".content"));
      del = await until(() => cardOf(id)?.querySelector('.panel [data-pact="del"]'), 1500);
    }
    if (del) {
      click(del);
      await until(() => !cb.hidden, 1500);
      click(document.getElementById("confirmbar-yes"));
      await until(() => !cardOf(id));
    }
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    const row = await until(() => document.querySelector(`[data-trash="${id}"]`), 2500);
    if (row) {
      click(row.querySelector('[data-trash-act="purge"]'));
      await until(() => !cb.hidden, 1500);
      click(document.getElementById("confirmbar-yes"));
      await until(() => !document.querySelector(`[data-trash="${id}"]`));
    }
    click(document.querySelector('#bottombar [data-pane="trash"]'));
    await until(() => !document.body.classList.contains("pane-open"), 1500);
    delete window.__swipeUndoProbe;
  }
  ok("清场:探针条目零残留", !cardOf(id) && !document.querySelector(`[data-trash="${id}"]`));
  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
