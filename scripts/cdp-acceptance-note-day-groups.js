// @cdp-run single timeout=90000
// 用户面 86(656):**手机随记按天分组** —— 同一天的卡归到一个日期节头下(`.tl-group` +
// `.tl-sec`),节头文字走 `dayLabel`(今天 / 昨天 / 前天 / M月D日),卡上的时间戳退成只报时刻。
//
// 跑法:node scripts/android-cdp.mjs forward && node scripts/cdp-run.mjs note-day-groups
//
// # 为什么要这支
// 改之前随记面是 `shown.map(renderCard)` **一条平铺列表**,而任务面早就分组了、桌面
// `src/inbox.ts` 也早就分组了 —— 移动端是这个项目的主力端,随记正是天天往里扔东西
// 的那一面。⇒ 这支守的是「别再把它改回平铺」,以及「别把只报时刻那一档漏到别的面上去」。
//
// # 判据
//  ① `#timeline` 的**直接子元素**全是 `section.tl-group`,一张散卡都没有(结构判据:
//     平铺时直接子元素是 `article.card`,这一格当场红)
//  ② 每组的**第一个**子元素是 `.tl-sec` 节头(⛔ 别只判「组里有节头」——节头排在卡后面
//     同样满足那句话,而屏上就是错的)
//  ③ 这一趟播的两条今天的随记落在**同一组**,且那组节头是「今天」
//  ④ ⭐ **组数与分法逐条等于后端算出来的那一份** —— 期望从 `list_timeline` 的 `created_at`
//     独立算(⛔ **不许从被测的 DOM 上算**:第一版就是那么写的,阴性刀当场照出来 —— 把代码
//     改回平铺之后组数是 0,而「组数为 0」被那版读成「库里没有非今天的随记」⇒ 报 **NOT-RUN
//     而不是红**,产品坏掉与前置不满足长得一模一样。这正是「代餐判据两头骗」那一族)
//  ④b 前置真不满足时(库里所有随记都在同一天)才 NOT-RUN,而且那个判断**只看后端**
//  ⑤ 随记卡的 `<time>` 只报时刻(`HH:MM`)—— 日期已经是节头,再写一遍是同一句话说两遍
//  ⑥ ⭐ **对照:任务面那条非今天的卡仍带完整日期** —— 证明「只报时刻」是随记面这一档,
//     没有泄漏成 `renderCard` 的新默认(回收站 / 搜索是平铺的,那儿必须留完整日期)
//  ⑦ ⭐ **组内卡序与后端 `list_timeline` 的随记序逐条相同** —— 分组是顺着扫出来的,
//     ⛔ 不许偷偷重排(那会引进一个本来不存在的排序真相源)
//
// # 这支守不到的那半(⛔ 别读成「全验过了」)
//  「昨天 / 前天」两档的字面本支验不到(要造出昨天的条目得改设备时钟,那不适合当常驻资产)——
//  ⑤ 只保证节头会出现且非今天那一档取的是绝对日期。dayLabel 的相对档由 656 当轮手工改钟验过
//  一趟(读数在 progress-log 同号条目),⛔ 别把「资产全绿」读成那两档也有网。
(async () => {
  const out = { steps: [] };
  const I = window.__TAURI_INTERNALS__;
  const SP = "main";
  const inv = (c, a) => I.invoke(c, { spaceId: SP, ...a });
  const ok = (name, cond, extra) => {
    out.steps.push({ name, ok: !!cond, ...(extra !== undefined ? { extra } : {}) });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() - t0 > ms) return null;
      await sleep(80);
    }
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const HM = /^\d{2}:\d{2}$/;
  /** 某张卡所属的组节头(⚠ #timeline 每刷一轮整片重建 ⇒ 一律现查,别缓存节点,316)。 */
  const secOf = (id) =>
    document.querySelector('#timeline [data-id="' + id + '"]')?.closest(".tl-group")?.querySelector(".tl-sec")
      ?.textContent ?? null;

  const seeded = [];
  try {
    // ---- 前置:切到随记面 ----
    const ideas = document.querySelector('#bottombar [data-mode="ideas"]');
    click(ideas);
    if (!ok("前置 · 切到随记面", await until(() => ideas.classList.contains("active"), 3000))) return out;

    // ---- 播种:今天两条(走 UI 那条路 ⇒ 时间轴当场就有,不必重启)----
    for (const n of ["甲", "乙"]) {
      const marker = "【CDP验收】86 分组" + n + " " + Date.now();
      document.getElementById("text").value = marker;
      click(document.getElementById("save"));
      const card = await until(() =>
        [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
          c.querySelector(".content")?.textContent.includes(marker),
        ),
      );
      if (!ok("播种 · 第「" + n + "」条进时间轴", !!card)) return out;
      seeded.push(card.dataset.id);
      await sleep(120); // 两条错开时刻,免得 ⑦ 的同秒序不稳
    }

    // ---- 期望:从后端独立算一份「该分成几组、每组是哪几条」 ----
    // ⛔⛔ 这一份**绝不许从 DOM 上算** —— 那样期望与被测同源,产品坏掉时期望跟着一起塌
    //    (阴性刀实证:第一版从 DOM 数组,改回平铺后报 NOT-RUN 而不是红)。
    const IDEA_STAGES = new Set(["inbox", "filed"]);
    const dayOf = (iso) => { const d = new Date(iso); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
    const notes = (await inv("list_timeline")).filter((x) => IDEA_STAGES.has(x.stage));
    const wantDays = [];
    for (const n of notes) { const k = dayOf(n.created_at); if (wantDays[wantDays.length - 1] !== k) wantDays.push(k); }
    if (wantDays.length < 2) {
      out.error = "前置不满足:后端算出来随记只跨 " + wantDays.length + " 天 ⇒ 分组这件事无从判(NOT-RUN,⛔ 别读成绿)";
      out.wantDays = wantDays;
      return out;
    }

    // ---- ① 直接子元素全是组,一张散卡都没有 ----
    const tl = document.getElementById("timeline");
    const kids = [...tl.children];
    const strays = kids.filter((e) => !(e.tagName === "SECTION" && e.classList.contains("tl-group")));
    ok("① #timeline 直接子元素全是 section.tl-group", kids.length > 0 && strays.length === 0, {
      kids: kids.length,
      strays: strays.map((e) => e.tagName + "." + e.className),
    });

    // ---- ② 每组第一个子元素是节头 ----
    const groups = [...tl.querySelectorAll(":scope > .tl-group")];
    const badHead = groups.filter((g) => !g.firstElementChild?.classList.contains("tl-sec"));
    ok("② 每组的第一个子元素是 .tl-sec 节头", groups.length > 0 && badHead.length === 0, {
      groups: groups.length,
      badHead: badHead.length,
    });

    // ---- ③ 今天播的两条同组,节头 = 今天 ----
    const s0 = secOf(seeded[0]), s1 = secOf(seeded[1]);
    ok("③ 两条今天的随记同组且节头是「今天」", s0 === "今天" && s1 === "今天", { 甲: s0, 乙: s1 });

    // ---- ④ 组数与分法逐条等于后端那一份 ----
    const secs = groups.map((g) => g.querySelector(".tl-sec")?.textContent ?? null);
    const gotDays = groups.map((g) =>
      [...g.querySelectorAll("[data-id]")].map((c) => {
        const it = notes.find((n) => n.id === c.dataset.id);
        return it ? dayOf(it.created_at) : "?";
      }),
    );
    const gotKeys = gotDays.map((ds) => (ds.length && ds.every((d) => d === ds[0]) ? ds[0] : "混=" + ds.join("|")));
    ok("④ 组数与分法逐条 == 后端算出来的那一份", JSON.stringify(gotKeys) === JSON.stringify(wantDays), {
      want: wantDays,
      got: gotKeys,
      secs,
    });
    ok("④c 至少有一个非「今天」的节头", secs.some((s) => s && s !== "今天"), { secs });

    // ---- ⑤ 随记卡的时间戳只报时刻 ----
    const stamps = [...tl.querySelectorAll(".tl-group [data-id] footer time")].map((e) => e.textContent);
    const notHM = stamps.filter((s) => !HM.test(s));
    ok("⑤ 随记卡的 <time> 恒 HH:MM", stamps.length > 0 && notHM.length === 0, { stamps: stamps.slice(0, 6), notHM });

    // ---- ⑦ 组内卡序与后端随记序逐条相同 ----
    const domIds = [...tl.querySelectorAll(".tl-group [data-id]")].map((e) => e.dataset.id);
    const back = (await inv("list_timeline")).filter((x) => domIds.includes(x.id)).map((x) => x.id);
    ok("⑦ 卡序与后端 list_timeline 逐条相同", JSON.stringify(domIds) === JSON.stringify(back), {
      dom: domIds.length,
      back: back.length,
      同: JSON.stringify(domIds) === JSON.stringify(back),
    });

    // ---- ⑥ 对照:任务面那条非今天的卡仍带完整日期 ----
    const tasks = document.querySelector('#bottombar [data-mode="tasks"]');
    click(tasks);
    if (await until(() => tasks.classList.contains("active"), 3000)) {
      const tStamps = [...document.querySelectorAll("#timeline [data-id] footer time")].map((e) => e.textContent);
      const dated = tStamps.filter((s) => !HM.test(s));
      if (tStamps.length === 0) {
        out.steps.push({ name: "⑥ 对照 · 任务面无卡可比", ok: false, extra: "NOT-RUN:任务面空" });
      } else {
        ok("⑥ 对照 · 任务面的卡仍带完整日期(只报时刻没泄漏)", dated.length > 0, { tStamps: tStamps.slice(0, 6) });
      }
      click(ideas);
      await until(() => ideas.classList.contains("active"), 3000);
    }
  } catch (e) {
    out.error = String(e && e.stack ? e.stack : e);
  } finally {
    // ---- 清场:播的两条销毁掉,回到基线 ----
    // ⚠ 随记走 archive_note → purge_note(⛔ 不是 delete_note:归档之后它必被存储层拒,
    //    而 catch 会把那个拒吞掉 ⇒ 回收站里攒尸体)。
    for (const id of seeded) {
      try {
        await inv("archive_note", { id });
        await inv("purge_note", { id });
      } catch (e) {
        out.steps.push({ name: "清场 · " + id, ok: false, extra: String(e) });
      }
    }
    const left = (await inv("list_timeline")).filter((x) => seeded.includes(x.id)).length;
    out.steps.push({ name: "清场 · 播的种零残留", ok: left === 0, extra: { left } });
  }
  out.pass = out.steps.every((s) => s.ok);
  return out;
})();
