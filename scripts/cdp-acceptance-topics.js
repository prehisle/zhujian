// 190 安卓标签管理面:开面 + 点类型入口(设/清 kind)+ 读顺序(供拖排序步骤前后对比)。
// 纯 DOM 断言即端到端:render 的数据来自 loadTopics 的后端查询(listTopicsFull),徽标/
// 顺序变了 = 后端真落库(set_topic_kind / reorder_topic)。拖排序需真触摸(touch-action
// 分区),走 android-cdp.mjs swipe 单独串——本脚本读出初始顺序 + 手柄坐标供那一步用。
// evalfile 跑,pass=true 才算过;库里 <1 个标签时类型验收 skip(算过)。
// ⭐ 用户面 77 起本支还守「小药丸钮」那一族的触区(`.tk-add` / `.tk-badge` / `.tk-edit` 两枚)。
// ⛔⛔ **它们的高度读不到 `getBoundingClientRect()`** —— 触区是 `::before` 的透明 halo,不进
// 宿主的 rect(rect 恒是药丸自己那 24)。⇒ 判据只能是**从中心往外逐像素打点**量真实命中范围,
// 这也正是 §2.3 / 514 那条「必须真打点,别读 CSS 里写没写」。⛔ 别改成读 rect,那是恒红;
// 也别改成读 `getComputedStyle(el,'::before')`,那又退回「CSS 里写没写」。
(async () => {
  const out = { pass: false, steps: [], order: [], handle: null, hit: {} };
  const ok = (name, cond, detail) => {
    out.steps.push({ name, ok: !!cond, ...(detail === undefined ? {} : { detail }) });
    return !!cond;
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // 往外走,量「还命中 el」的连续纵向范围 = 真实触区高。⛔ 别从 rect 的边起步(subpixel 上
  // 边界那一点归谁不定),从中心起步往两头走。
  // ⛔⛔ **别用整像素步长**:中心是小数,整步走出来的读数**永远是整数、且最多少报 1px** ⇒
  // 一个真 44 的 halo 会报 43,判据当场变成不可执行(本轮第一版就是这么红的)。⇒ 粗走找到
  // 跨界的那一步之后再二分细到 0.02,读数才敢跟 44 这条线比。
  const edge = (x, from, dir, limit, el) => {
    let hit = from, miss = null;
    for (let d = 1; d <= limit; d += 1) {
      const y = from + dir * d;
      if (document.elementFromPoint(x, y) === el) hit = y;
      else { miss = y; break; }
    }
    if (miss === null) return hit;
    for (let i = 0; i < 12; i += 1) { // 二分到 ~0.02px
      const mid = (hit + miss) / 2;
      if (document.elementFromPoint(x, mid) === el) hit = mid; else miss = mid;
    }
    return hit;
  };
  const haloSpan = (el) => {
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2);
    const cy = r.y + r.height / 2;
    // ⛔ 先分清「被盖住」和「这个节点已经不在文档里了」—— 两者都会让下面那句不等,而
    // 报成同一句「中心未命中」会把人引向完全错的方向(639 就为此查了半轮:那句红被 634
    // 记成「第一行落在视口外」,真相是**列表在脚下整片重画**,节点游离了)。
    if (!document.contains(el)) return { detached: true };
    if (document.elementFromPoint(x, cy) !== el) return null; // 中心都不归它 = 被谁盖住了,别往下量
    const top = edge(x, cy, -1, 60, el);
    const bot = edge(x, cy, +1, 60, el);
    return { top, bot, h: bot - top, w: r.width, boxH: r.height };
  };
  // 这一列上「谁占着位」:普通行是 .tk-add / .tk-badge,进了类型编辑态的那行是两枚钮。
  const PILL = ".tk-add, .tk-badge, .tk-edit button";
  // 一枚药丸的完整判据:①触区高 ≥44 ②与上下相邻行**同一列**那一枚的触区不互叠(§2.3 那条
  // 「上下两行热区互叠 ⇒ 边界含糊」)。
  // ⛔ **别把 ② 写成「halo 不越出本行」** —— 那是过严的代餐,会把好的修法判红:90% 字号档上
  // 实测 halo 顶探出行外 **0.1px**(行 45.2 高、halo 44.3,行的上下 padding 因为底边框而不等分),
  // 而与上一行同列那枚之间**仍隔着 0.9px**、一点没叠。判据要判「有没有真叠上」,别判替身。
  const pillOk = async (el, label) => {
    const row = el.closest(".trow");
    row.scrollIntoView({ block: "center" });
    await sleep(120);
    const s = haloSpan(el);
    out.hit[label] = s;
    if (
      !ok(
        `${label} 触区高 ≥44(§2.3)`,
        s && !s.detached && s.h >= 44,
        s?.detached
          ? "⚠ 节点已游离(列表在脚下重画过,资产没重取)—— 这不是触区的读数"
          : s
            ? `${s.w.toFixed(1)}×${s.h.toFixed(1)}(药丸本身 ${s.boxH.toFixed(1)})`
            : "中心未命中",
      )
    )
      return;
    const gaps = [];
    for (const sib of [row.previousElementSibling, row.nextElementSibling]) {
      const other = sib?.classList?.contains("trow") ? sib.querySelector(PILL) : null;
      if (!other) continue;
      const os = haloSpan(other);
      if (!os) continue; // 滚出视口 / 被盖住:这一侧没量到,如实不计,别当过
      gaps.push(os.top > s.top ? os.top - s.bot : s.top - os.bot);
    }
    // ⛔ 一侧都没量到 = 这一格是空的,别让它长得跟真绿一样
    ok(`${label} 与相邻行同列那枚不互叠(边界不含糊)`, gaps.length > 0 && gaps.every((g) => g >= 0),
      gaps.length ? gaps.map((g) => g.toFixed(1)).join(",") : "两侧都没量到(空测)");
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

  // ① 开标签面(header「标签」),面接管视图 + 列表出现(幂等:已开则不再 toggle)
  if (document.getElementById("topics-pane").hidden) {
    click(document.getElementById("topics-toggle"));
  }
  const pane = await until(() => {
    const p = document.getElementById("topics-pane");
    return p && !p.hidden ? p : null;
  });
  if (!ok("标签面打开", !!pane)) return JSON.stringify(out);
  ok("面接管视图(pane-open)", document.body.classList.contains("pane-open"));
  // 等真正渲染完:.trow 出现(常态),或真空态文案(「还没有标签」)——**不能等到「读取中…」
  // 占位就返回**(冷启动 loadTopics 未完成时它先渲染,rows=0 会误 skip)。
  const box = document.getElementById("topics-list");
  await until(() => box.querySelector(".trow") || box.textContent.includes("还没有标签"), 6000);
  if (!ok("列表渲染完成", box.querySelector(".trow") || box.textContent.includes("还没有标签")))
    return JSON.stringify(out);
  // ⛔⛔ **「.trow 出现了」≠「不会再重画了」**:开面这一路会画**两遍** —— 639 真机挂
  // MutationObserver 量到:第一遍在 t=60ms(资产的 until 就是在这一拍拿到节点的),
  // t=109ms 整片重建(21 行拆、21 行建),于是手里那个节点**当场游离**,后面
  // `elementFromPoint` 拿它去比必然不等 ⇒ 报成「中心未命中」的假红,634 撞过两次。
  // ⇒ 等它**静下来**再往下走:childList 连续 300ms 没动静才算定局。
  // ⛔ 别改成 `sleep(固定毫秒)` —— 那是拿运气当判据;也别退回「出现即用」。
  const settled = await (async () => {
    let last = performance.now();
    const mo = new MutationObserver(() => (last = performance.now()));
    mo.observe(box, { childList: true, subtree: true });
    const t0 = performance.now();
    while (performance.now() - last < 300 && performance.now() - t0 < 4000) await sleep(60);
    mo.disconnect();
    return performance.now() - t0 < 4000;
  })();
  ok("列表已定局(不会再在脚下重画)", settled);

  const rows = () => [...document.querySelectorAll("#topics-list .trow")];
  out.order = rows().map((r) => r.dataset.topic);

  // 库里没有标签:类型验收无对象,skip(算过);拖排序也无从谈起。
  if (rows().length === 0) {
    ok("库无标签→类型验收 skip", true);
    out.pass = out.steps.every((s) => s.ok);
    return JSON.stringify(out);
  }

  // 手柄坐标(供拖排序步骤:swipe 从第一行手柄拖到最后一行下方)
  const firstHandle = rows()[0].querySelector(".thandle").getBoundingClientRect();
  const lastRow = rows()[rows().length - 1].getBoundingClientRect();
  out.handle = {
    fromX: Math.round(firstHandle.left + firstHandle.width / 2),
    fromY: Math.round(firstHandle.top + firstHandle.height / 2),
    toY: Math.round(lastRow.bottom + 12),
    n: rows().length,
  };

  // ② 类型设置:第一行 → 点类型入口展开 input → 填「人名」→ 存 → 徽标出现且文字对
  const row0 = rows()[0];
  const id0 = row0.dataset.topic;
  // ②a 触区:进编辑态之前先量入口那一枚(第一行本来有没有类型都行,量在的那个形)
  const entry = row0.querySelector(".tk-add") || row0.querySelector(".tk-badge");
  if (entry) await pillOk(entry, entry.classList.contains("tk-add") ? "「+ 类型」" : "类型徽记");
  click(row0.querySelector("[data-kind-edit]"));
  const input = await until(() => document.querySelector(`.trow[data-topic="${id0}"] .tk-input`));
  if (!ok("点类型展开输入框", !!input)) return JSON.stringify(out);
  // ②b 触区:编辑态那两枚(存 / 清)。⚠ 单字钮 ⇒ 横向本就不到 44,那是**知情的取舍**
  // (横向撑开会让相邻两枚 halo 互叠,理由焊在 android/index.html 那条规则头上)⇒ 这里只判纵向。
  const kbtns = [...document.querySelectorAll(`.trow[data-topic="${id0}"] .tk-edit button`)];
  ok("编辑态两枚钮在(存 / 清)", kbtns.length === 2, kbtns.map((b) => b.textContent.trim()).join("|"));
  for (const b of kbtns) await pillOk(b, `编辑态「${b.textContent.trim()}」`);
  // ⭐ 横向那半的判据是**中心距**,不是各自多宽(632 补,用户拍板走「拉开间距」那条路)。
  // 理由:原生触摸有一层吸附,手指落在两枚之间会被吸到**更近的那一枚** ⇒ 决定「点不点得对」的
  // 是两心之隔,把 halo 横向撑大一点也不改变边界在哪。
  // ⛔ 别把这一格改成 `width >= 44`:单字钮「存」「清」补不到 44(横向撑 halo 会让相邻两枚
  // 互叠、点「存」落到「清」上),那样写等于把一条永远红的线钉在这儿。
  for (let i = 1; i < kbtns.length; i += 1) {
    const a = kbtns[i - 1].getBoundingClientRect(), b = kbtns[i].getBoundingClientRect();
    const d = b.x + b.width / 2 - (a.x + a.width / 2);
    ok(`编辑态「${kbtns[i - 1].textContent.trim()}」↔「${kbtns[i].textContent.trim()}」中心距 ≥44`, d >= 44,
      `${d.toFixed(1)}px(两钮 ${a.width.toFixed(1)} / ${b.width.toFixed(1)},缝 ${(b.x - a.right).toFixed(1)})`);
  }
  input.value = "人名";
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-save]`));
  const badge = await until(() => {
    const b = document.querySelector(`.trow[data-topic="${id0}"] .tk-badge`);
    return b && b.textContent.trim() === "人名" ? b : null;
  });
  ok("设类型后徽标显「人名」(后端落库)", !!badge);
  // ②c 触区:徽记态(与「+ 类型」同一条 CSS,但宽度随用户起的类型名变 ⇒ 单量一次)
  if (badge) await pillOk(badge, "类型徽记");

  // ③ 类型清除:点徽标展开 → 清 → 回到「+ 类型」
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-edit]`));
  await until(() => document.querySelector(`.trow[data-topic="${id0}"] .tk-input`));
  click(document.querySelector(`.trow[data-topic="${id0}"] [data-kind-clear]`));
  const cleared = await until(() => {
    const add = document.querySelector(`.trow[data-topic="${id0}"] .tk-add`);
    const badgeGone = !document.querySelector(`.trow[data-topic="${id0}"] .tk-badge`);
    return add && badgeGone ? add : null;
  });
  ok("清类型后回「+ 类型」(后端清库)", !!cleared);

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
