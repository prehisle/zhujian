// 146 分面 × 多空间:空间切换清屏、mode 保留 —— 经 android-cdp.mjs evalfile 注入。
//   node scripts/android-cdp.mjs evalfile scripts/cdp-acceptance-view-split-space.js
// 多空间守卫:单空间设备(space-chip 隐藏)直接 skip=true 算过、报出来。
// 会真实切一次空间再切回(触发真同步会话,故独立于主 view-split 脚本、时间预算单算)。
// 反假绿纪律(codex 实现审二/三轮 M2):切换成功以「空间面板 current 行 = 目标 id」为准;
// 冻结目标=脚本自建临时任务卡(空任务面 every([]) 空测免疫),切后断言消失;
// finally 归位取 switchTo 真值、清临时卡并搜索终审,restoredHome 与 cleaned 都纳入 pass。
(async () => {
  const out = { pass: false, skip: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms = 5000) => {
    const t0 = performance.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (performance.now() - t0 > ms) return null;
      await sleep(100);
    }
  };
  const modeBtn = (m) => document.querySelector(`#bottombar [data-mode="${m}"]`);
  const activeMode = () =>
    [...document.querySelectorAll("#bottombar [data-mode]")].find((b) =>
      b.classList.contains("active"),
    )?.dataset.mode;
  const paneOpen = () => document.body.classList.contains("pane-open");
  const chip = document.getElementById("space-chip");
  /** 开空间面板读 current 行的 space id(读完把面板留开着,由调用方决定去留)。 */
  const currentSpaceId = async () => {
    if (!paneOpen() || document.getElementById("spaces").hidden) {
      click(chip);
      await until(() => !document.getElementById("spaces").hidden, 2000);
    }
    const row = await until(() => document.querySelector("#space-list .space-row.current"), 3000);
    return row?.dataset.space ?? null;
  };
  const switchTo = async (id) => {
    if (!paneOpen() || document.getElementById("spaces").hidden) {
      click(chip); // 面板可能已收(建卡/切换复位):自己开
      await until(() => !document.getElementById("spaces").hidden, 2000);
    }
    const btn = await until(() => document.querySelector(`#space-list [data-switch="${id}"]`), 3000);
    if (!btn) return false;
    click(btn);
    // 切换成功的地面真相:重开面板后 current 行 = 目标(切换会自动关面板/清屏重拉)
    await until(() => !paneOpen(), 8000);
    await sleep(600);
    const cur = await currentSpaceId();
    click(chip); // 读完收面板(toggle)
    await until(() => !paneOpen(), 1500);
    return cur === id;
  };

  if (chip.hidden) {
    out.skip = true;
    out.pass = true;
    out.note = "单空间设备:空间概念隐藏,无从验「切空间保 mode」——跳过";
    return JSON.stringify(out);
  }

  let homeId = null;
  let restoredHome = false;
  let tempId = null; // 本脚本在起始空间自建的临时任务卡(冻结目标,空测免疫)
  try {
    // 先取得 homeId(codex 四轮 M2:建卡之后才知道 home,建卡成功+读 home 失败的窗口
    // 会让 finally 既不删卡也不终审),再建冻结目标卡。
    homeId = await currentSpaceId();
    if (!ok("读到当前空间 id", !!homeId)) throw new Error("abort");
    const otherRow = [...document.querySelectorAll("#space-list [data-switch]")].find(
      (b) => b.dataset.switch !== homeId,
    );
    if (!ok("有另一个空间可切", !!otherRow)) throw new Error("abort");
    const otherId = otherRow.dataset.switch;
    click(chip); // 收面板,回主视图建卡
    await until(() => !paneOpen(), 1500);

    // 起点:任务面(证「保留」得先离开默认值);自建一张临时任务卡当冻结目标——
    // 起始空间任务面可能本来是空的,every([])===true 会把「旧目标消失」空测算过。
    click(modeBtn("tasks"));
    await until(() => activeMode() === "tasks", 2000);
    const ta = document.getElementById("text");
    const marker = `【CDP验收146S】切空间冻结目标 ${Date.now()}`;
    ta.value = marker;
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    click(document.getElementById("save"));
    const tempCard = await until(() =>
      [...document.querySelectorAll("#timeline [data-id]")].find((c) =>
        c.querySelector(".content")?.textContent.includes(marker),
      ),
    );
    if (!ok("起始空间建出冻结目标卡", !!tempCard)) throw new Error("abort");
    tempId = tempCard.dataset.id;

    // 重开面板拿目标行(建卡期间面板已收;switchTo 里自会用 id 重查)

    ok("切到另一空间(current 行=目标)", await switchTo(otherId));
    ok("切空间后 mode 保留(任务面)", activeMode() === "tasks");
    ok(
      "旧空间的冻结目标卡已清屏",
      !document.querySelector(`#timeline [data-id="${tempId}"]`),
    );

    restoredHome = await switchTo(homeId);
    ok("切回起始空间(current 行=home)", restoredHome);
    ok("切回后 mode 仍保留", activeMode() === "tasks");
    out.switchedTo = otherId;
  } catch (e) {
    out.runError = String(e); // 不早退:finally 归位/清卡照常,统一序列化返回
  } finally {
    try {
      if (!restoredHome && homeId) restoredHome = await switchTo(homeId); // 尽力归位并记真值
      // 清掉临时卡 + 终审。终审与 tempId 解耦(codex 四轮 M2):只要已归位就必跑
      // ——建卡已提交但没等到 id 的窗口,残留会在搜索里现形(leftovers),不许跳过。
      out.cleaned = false;
      if (restoredHome) {
        if (tempId) {
          click(modeBtn("tasks"));
          await until(() => activeMode() === "tasks", 1500);
          const c = document.querySelector(`#timeline [data-id="${tempId}"]`);
          if (c) {
            click(c.querySelector(".content"));
            const del = await until(() => c.querySelector('.panel [data-pact="del"]'), 1500);
            if (del) {
              click(del);
              const cb = document.getElementById("confirmbar");
              await until(() => !cb.hidden, 1500);
              click(document.getElementById("confirmbar-yes"));
              await until(() => !document.querySelector(`#timeline [data-id="${tempId}"]`), 2000);
            }
          }
          click(document.querySelector('#bottombar [data-pane="trash"]'));
          await until(() => paneOpen(), 1000);
          const row = await until(() => document.querySelector(`[data-trash="${tempId}"]`), 1500);
          if (row) {
            click(row.querySelector('[data-trash-act="purge"]'));
            const cb = document.getElementById("confirmbar");
            await until(() => !cb.hidden, 1500);
            click(document.getElementById("confirmbar-yes"));
            await until(() => !document.querySelector(`[data-trash="${tempId}"]`), 2000);
          }
          click(document.querySelector('#bottombar [data-pane="trash"]'));
          await until(() => !paneOpen(), 1000);
        }
        // 终审:搜索标记前缀,只认「没有找到」终态(与主脚本同纪律,fail-closed)
        click(document.getElementById("search-toggle"));
        await until(() => paneOpen(), 1000);
        document.getElementById("search-input").value = "【CDP验收146S】";
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
      }
      if (paneOpen()) {
        click(document.querySelector("header h1"));
        await until(() => !paneOpen(), 1500);
      }
      click(modeBtn("ideas"));
      await until(() => activeMode() === "ideas", 1500);
    } catch (e) {
      out.cleanupError = String(e);
      out.cleaned = false;
    }
  }

  out.restoredHome = restoredHome;
  // runError 显式入判(codex 四轮 M1):意外异常不许被「步骤全 true+清场成功」掩成 pass。
  out.pass =
    out.steps.every((s) => s.ok) && restoredHome === true && out.cleaned === true && !out.runError;
  return JSON.stringify(out);
})();
