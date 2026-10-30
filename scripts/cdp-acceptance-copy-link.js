// @cdp-run single timeout=60000
// 用户面 152(长文那条留下的手机缺口②):**手机随记卡与长文阅读页能「复制链接」了** —— 桌面早有,手机只会开
// 不会给。链接形与桌面 `src/deeplink.ts::buildItemDeepLink` 逐字同形:空间配了同步 = `acc=<账户号>`(发到别的
// 设备也能开),没配 = `space=<空间 id>`(只本机能开);消费在 main.ts 的 pullDeepLink。
//
// 跑法:node scripts/android-cdp.mjs forward && node scripts/cdp-run.mjs copy-link
//
// # 判据
//  ① 随记卡「更多…」里有「复制链接」(data-pact="copylink")
//  ② 点一下:剪贴板命令**恰收到一发**,文本 = 这条随记的链接(下面那个形,item 是种下那条的 id);
//     回执写「已复制链接」;面板留在原地(不是业务写,不收面)
//  ③ 展开成长文 → 长文面 → 阅读页 →「更多…」里有「复制链接」,点一下同②(item 是同一个 id —— 展开不换身份)
//
// 剪贴板那一发在 IPC 层截下来读参数(capability 只给了写、读不回来),**照常放行** —— 回执只在写成功后才出,
// 所以「回执在」+「参数对」= 写进去的就是这串。
//
// # 这支守不到的那半
//  链接真点得开:要从系统那头喂进来(`adb shell am start -a android.intent.action.VIEW -d '<链接>'`),
//  资产页内做不到 —— 152 那轮手工跑过一次,读数在 progress-log 同号条目。鸿蒙没有深链接入口,只给不开。
//  任务卡与随记卡走同一张「更多…」子面(renderMore 不分 stage),这里不另验。
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
  const cardOf = (id) => document.querySelector('#timeline [data-id="' + id + '"]');
  const inPanel = (id, pact) => cardOf(id)?.querySelector('.panel [data-pact="' + pact + '"]') ?? null;
  const btnText = (root, text) => [...(root?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === text) ?? null;
  const bar = () => document.getElementById("error");

  // 截剪贴板写命令:记下参数、照常放行。`__TAURI_INTERNALS__.invoke` 不可写(505)⇒ 在它下面那层截:
  // 安卓走 `window.ipc.postMessage`(Java 桥吞掉对 postMessage 的赋值,但 window.ipc 本身可换,同 docs-4b),
  // 鸿蒙走 fetch `ipc://localhost/<cmd>`。⛔ 包装层自己绝不抛。
  const CMD = "plugin:clipboard-manager|write_text";
  const writes = [];
  const origIpc = window.ipc;
  if (origIpc) {
    const pm = origIpc.postMessage.bind(origIpc);
    try {
      window.ipc = {
        postMessage(data) {
          try {
            const m = JSON.parse(data);
            if (m.cmd === CMD) writes.push(m.payload?.text);
          } catch {}
          return pm(data);
        },
      };
    } catch {}
  }
  const origFetch = window.fetch;
  window.fetch = function (u, init) {
    try {
      if (/^(?:https?:\/\/ipc\.localhost|ipc:\/\/localhost)\//.test(String(u)) && decodeURIComponent(String(u).replace(/^.*?localhost\//, "")) === CMD)
        writes.push(JSON.parse(init.body).text);
    } catch {}
    return origFetch.call(this, u, init);
  };

  let note = null;
  try {
    const st = await inv("sync_status", {});
    const key = st.account_id ? "acc=" + encodeURIComponent(st.account_id) : "space=" + encodeURIComponent(SP);
    const linkOf = (id) => "zhujian://open?" + key + "&item=" + encodeURIComponent(id);

    const ideas = document.querySelector('#bottombar [data-mode="ideas"]');
    click(ideas);
    if (!ok("切到随记面", await until(() => ideas.classList.contains("active"), 2000))) return out;
    const text = "【CDP验收】152 复制链接 " + Date.now();
    document.getElementById("text").value = text;
    click(document.getElementById("save"));
    const card = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) => c.querySelector(".content")?.textContent.includes(text)),
    );
    if (!ok("探针随记入时间轴", !!card)) return out;
    note = card.dataset.id;

    // ---- ① / ② 随记卡 ----
    click(card.querySelector(".content"));
    const more = await until(() => inPanel(note, "more"), 2000);
    if (!ok("卡片操作面开得出来", !!more)) return out;
    click(more);
    const cl = await until(() => inPanel(note, "copylink"), 2000);
    if (!ok("① 「更多…」里有「复制链接」", !!cl && cl.textContent.trim() === "复制链接", cl?.textContent)) return out;
    writes.length = 0;
    click(cl);
    const got1 = await until(() => !bar().hidden && bar().textContent === "已复制链接", 4000);
    ok("② 回执「已复制链接」", !!got1, bar().textContent);
    ok("② 剪贴板恰收到一发,文本 = 这条的链接", writes.length === 1 && writes[0] === linkOf(note), { writes, want: linkOf(note) });
    ok("② 面板留在原地(「复制链接」还在)", !!inPanel(note, "copylink"));

    // ---- ③ 长文阅读页 ----
    click(inPanel(note, "expand"));
    if (!ok("展开成长文后卡离开随记面", await until(() => !cardOf(note), 4000))) return out;
    const docsBtn = await until(() => {
      const b = document.querySelector('#bottombar [data-pane="docs"]');
      return b && !b.hidden ? b : null;
    }, 3000);
    if (!ok("底栏「长文」钮显形", !!docsBtn)) return out;
    click(docsBtn);
    const dcard = await until(() => document.querySelector('#docs-body .doc-card[data-doc="' + note + '"]'), 4000);
    if (!ok("长文面列出这一篇", !!dcard)) return out;
    click(dcard);
    const acts = await until(() => document.querySelector("#docs-body .doc-acts"), 4000);
    if (!ok("阅读页画出动作排", !!acts)) return out;
    const dmore = btnText(acts, "更多…");
    if (!ok("阅读页有「更多…」", !!dmore)) return out;
    click(dmore);
    const dcl = await until(() => btnText(document.querySelector("#docs-body .doc-acts"), "复制链接"), 2000);
    if (!ok("③ 阅读页「更多…」里有「复制链接」", !!dcl)) return out;
    bar().hidden = true;
    writes.length = 0;
    click(dcl);
    const got2 = await until(() => !bar().hidden && bar().textContent === "已复制链接", 4000);
    ok("③ 回执「已复制链接」", !!got2, bar().textContent);
    ok("③ 剪贴板恰收到一发,文本 = 同一个 id 的链接(展开不换身份)", writes.length === 1 && writes[0] === linkOf(note), { writes, want: linkOf(note) });
  } catch (e) {
    ok("没抛异常", false, String(e));
  } finally {
    if (origIpc) try { window.ipc = origIpc; } catch {}
    window.fetch = origFetch;
    if (note) {
      try { await inv("archive_note", { id: note }); } catch {}
      try { await inv("purge_note", { id: note }); } catch (e) { ok("清场:purge 成", false, String(e)); }
    }
    const ideas = document.querySelector('#bottombar [data-mode="ideas"]');
    if (ideas) click(ideas);
  }
  out.pass = out.steps.length > 0 && out.steps.every((s) => s.ok);
  return out;
})();
