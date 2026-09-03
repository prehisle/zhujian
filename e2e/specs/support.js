import { browser, $ } from "@wdio/globals";

// Where the frontend is served (set by wdio.conf.js). Fail-fast if missing.
export const BASE = (() => {
  const b = process.env.YS_E2E_BASE;
  if (!b) throw new Error("YS_E2E_BASE 未设置——请经 e2e/wdio.conf.js 启动 e2e");
  return b;
})();

// Run a backend command through the page's real IPC bridge (withGlobalTauri).
// 97 多空间起命令面是显式 space_id;e2e 恒打主库(个人空间)——YS_DB_PATH 模式
// 下后端禁扫/禁建空间,"main" 是唯一空间。
export function invoke(cmd, args) {
  return browser.execute(
    (c, a) => window.__TAURI__.core.invoke(c, { ...a, spaceId: "main" }),
    cmd,
    args,
  );
}

// 等「图真的挂到条目上了」。⛔ **别在等到 `list_ideas`/`list_tasks` 里出现这条之后,
// 直接一句 `expect(await invoke("list_item_images", …)).toHaveLength(n)`** ——
// 那**按构造就有竞态**,不是抖动运气不好(508 全量第一趟就红在它身上,512 补的这只共享件)。
//
// **根读码就看得见**(`src/compose-controller.ts::doSave`,顺序是硬的):
// `id = await invoke(w.command, …)` **先**决议 ⇒ 条目这一刻已经进 `list_tasks`;
// `imgs.attachBatch(id, batch, w.space)` 是**之后**另一趟 IPC。而调用方的等待条件是
// 「`list_*` 里出现了这条」—— **它满足得比挂图早**,断言正落在那个窗口里,机器一忙窗口就够宽。
// 同这支 spec 家族 `compose-recovery.e2e.js` 文件头 ① 那条:**等的东西 ≠ 读的东西**。
//
// ⛔ **别把上游那条等待改成「等图挂上了再取 id」** —— 那会把「条目建成了、但图挂失败」
// 这一格一起等没,而它恰恰是 `onSaved` 的 `failed` 分支要守的东西。两条各等各的,判据不削反增:
// 上游守「条目入库」,这只守「图挂上」,哪一格没到由两句不同的话分得开。
//
// ⚠ 超时话术带**实际读数**,且把「读命令一直在抛」与「张数不对」分开报 —— 否则一条 IPC
// 层面的真故障会被印成一句看着合理的「图没挂上」。
// 判据本身(超过它就算红)。⛔ **515 刻意没动这个数** —— 见下面那段为什么。
const IMG_BUDGET_MS = 6000;
// 超预算之后**只为分诊**再等的宽限:它不参与判定(到点照样红),只回答「是慢还是真没挂上」。
const IMG_GRACE_MS = 14000;

/** 挂图失败时,把 app 自己说的话捞出来 —— 挂图**真失败**时产品是会响亮报的
 *  (`main.ts` 的 capture.savedImagesFailed / compose 的就地落点),而「只是慢」时这里是空的。
 *  ⚠ 尽力而为的**提示**不是判据:窗口已经关掉 / 换页时读不到,读不到就不说。 */
async function appErrorText() {
  try {
    return await browser.execute(() => {
      const out = [];
      for (const sel of ["#cap-err", "#compose-err", ".form-err"]) {
        for (const el of document.querySelectorAll(sel)) {
          const t = (el.textContent || "").trim();
          if (t) out.push(`${sel}「${t}」`);
        }
      }
      return out.join(" / ");
    });
  } catch {
    return "";
  }
}

/** 挂图失败的**原因**(528 起 `src/item-images.ts` 把它留在一个有上界的环里)。
 *  ⭐ 这一格是 526 缺的那半:此前只读得到屏幕上那句「N 张图未能附加」——**它答的是
 *  「失败了」,答不出「为什么」**,于是只能靠猜(526 就猜错了一次,代价是半天)。
 *  ⚠ wry 上浏览器 console 到不了 CI 日志,所以走 `window` 上那个读口,不走 console。
 *  ⚠ 读不到就不说:它是诊断不是判据(环会被后来的失败挤掉)。 */
async function attachFailureText() {
  try {
    const lines = await browser.execute(() =>
      typeof window.__zhujianAttachFailures === "function" ? window.__zhujianAttachFailures() : [],
    );
    return lines && lines.length ? ` 挂图那边留下的原因:${lines.join(" ⏎ ")}` : "";
  } catch {
    return "";
  }
}

export async function waitItemImages(itemId, n, where) {
  let list = [];
  let lastErr = null;
  const read = async () => {
    try {
      list = await invoke("list_item_images", { itemId });
      lastErr = null;
    } catch (e) {
      lastErr = e;
      return false;
    }
    return list.length === n;
  };
  const t0 = Date.now();
  try {
    await browser.waitUntil(read, { timeout: IMG_BUDGET_MS });
  } catch {
    if (lastErr) {
      throw new Error(`${where}:读 list_item_images 一直在抛 —— ${lastErr.message || lastErr}`);
    }
    // ⛔ **别在这儿直接报「图没挂上」** —— 那句话把两件不同的事说成同一句。
    // 515 拿两把刀量过(往 `attachBlob` 里分别注入 `throw` 与 8 秒延迟,跑同一支 spec):
    // 「挂图真失败了」与「挂图只是慢」打出来的失败消息**逐字相同** ⇒ CI 上红一次,
    // 读完那句话你仍然不知道该改测试还是该修产品(backlog 测试与工装 39 就是这么来的)。
    // 故这里再等一段**只用于分诊**的宽限,把两者分开;判据(IMG_BUDGET_MS)一个字没动。
    let lateMs = null;
    try {
      await browser.waitUntil(read, { timeout: IMG_GRACE_MS });
      lateMs = Date.now() - t0;
    } catch {
      /* 宽限期内也没来 —— 那就不是「慢」 */
    }
    const said = await appErrorText();
    const why = await attachFailureText(); // ← 526 缺的那半:不止「失败了」,还有「为什么」
    const tail = (said ? ` app 自己说的话:${said}` : " app 那边没留下任何错误提示。") + why;
    if (lateMs !== null) {
      throw new Error(
        `${where}:图**最终挂上了**,用了 ${lateMs} ms(判据预算 ${IMG_BUDGET_MS} ms)` +
          `⇒ 这是**预算不够 / 机器慢**,不是产品没挂上图。${tail}`,
      );
    }
    throw new Error(
      `${where}:预算 ${IMG_BUDGET_MS} ms 之后又等了 ${IMG_GRACE_MS} ms,挂上的图仍是 ` +
        `${list.length} 张、要 ${n} 张 ⇒ **不是慢,是真没挂上**。${tail}`,
    );
  }
  return list;
}

// Navigate the live window to an app page and make it visible+focused, so its
// DOM is interactable regardless of any earlier hide() (capture hides on save).
export async function goShow(path) {
  await browser.url(`${BASE}${path}`);
  await browser.execute(async () => {
    const w = window.__TAURI__.window.getCurrentWindow();
    await w.show();
    await w.setFocus();
  });
}

// Navigate to the single notebook window and switch to a view. Since 57 the
// landing view follows localStorage (last-view restore) — never assume we start
// on inbox; always click the target view's sidebar button. DOM ids inside each
// view are preserved, so a spec's selectors are unchanged — only the navigation
// prologue differs from the old per-window goShow.
export async function goNotebook(view) {
  await goShow("/notebook.html");
  // The notebook is a real ≥760px window (a 172px sidebar + content). The e2e
  // harness drives the tiny 560px capture window, so size it up to a
  // representative width or narrow views (e.g. the board header) overflow.
  // ⭐ **B 轮:1100 → 1260,跟着 `board.css` 那三个断点一起挪的**(同 485 立的规矩:窗与断点
  // 是一对;485 那次是 1000 → 1100,原话在 git 历史里)。顶栏塌缩本轮改成按**顶栏自己的宽**判、
  // 分三档,断点 1009 / 929 / 839(顶栏内容宽)。窗 1260 ⇒ 顶栏内容宽 **890**
  // (= 窗宽 − 172 侧栏 − 30 左内边距 − 138 窗控死区 − 30 右呼吸),落在「摘键帽 + 摘复制看板、
  // 名字还在」那一档 ⇒ `viewkeys.e2e.js` 拿 `#trash-toggle` 的**可见文字**当观测面的那四句
  // (`toContain("回收站")`)照旧有得看。
  // ⚠ 窗还停在 1100 的话顶栏内容宽只有 730 ⇒ 整套 e2e 从此只跑得到字母态,那四句当场红。
  // ⛔ **别为了覆盖「全形」那一档把窗开到 1380** —— Linux CI 的 xvfb 默认屏只有 1280 宽,
  // 那样 Linux 那半会以「窗被钳住」的形安静地跑在另一档上。全形与「只摘键帽」两档 e2e 覆盖
  // 不到,是知情的边界(理由与读数在 board.css 同一段)。
  await browser.setWindowSize(1260, 700);
  // ⭐ **先等壳启动完再点**(455)。侧栏那四枚按钮是 **notebook.html 里的静态 HTML**,
  // `browser.url()` 一回来就存在 ⇒ 「按钮存在」这条判据**证明不了壳已经起来了**。notebook 的
  // 启动序是 `src/notebook.ts` 末尾那条**异步 IIFE**(`await initCurrentSpace()` →
  // `await initSync()` → `navigate(上次视图)`);`e2e/probes/boot-race.e2e.js` 量过:
  // **`url()` 回来那一刻壳几乎从来没起来**(本机 7-8/8 趟,还差 12-38ms),而这之后的
  // show/focus + setWindowSize + waitForExist 那几条往返要 56-102ms ⇒ 平时点得比它晚,靠的是
  // 这 **40-70ms 的余量**、不是靠构造。余量被负载吃掉(全量累积那趟 / 更慢的机器)时点就落在
  // 启动序前面 ⇒ **同一个视图被挂两次**(我点一次、启动序末尾再挂一次):第二次挂把第一棵 DOM
  // 整个换掉 ⇒ 紧跟着取到的元素句柄变陈旧,第一次挂发出的异步刷新落在死 mount 上。
  // 判据换成**正面字据**:`#view` 里已经挂上任意一个视图 = 启动序那句 navigate 已经跑过
  // (`.v-* .view` 只由 `navigate` 产出)。阴性对照(把启动序人为拖慢 800ms):这一句之前
  // **8/8 被重挂**,加上之后 **0/8**。
  // ⛔ **别把它读成 backlog「测试与工装 19」的根** —— 那个 `.v-topics 5000ms` 的根**没查到**,
  // 而两条最像的推断已被那只探针当场证伪(①监听还没挂上 ②启动序把视图换走了),逐条在探针文件头。
  await $("#view > .view").waitForExist({ timeout: 15000 });
  const trigger = `.sidebar nav button[data-view="${view}"]`;
  await $(trigger).waitForExist({ timeout: 5000 });
  await browser.execute((sel) => document.querySelector(sel).click(), trigger);
  await $(`.v-${view}`).waitForExist({ timeout: 5000 });
}

// Reset to a known-empty 想法 list so specs are order-independent. The list merges
// 未归类 + 已归类, so clear BOTH stages. Route by STAGE (which list an idea appears
// in), not by topics.length: a filed idea can lose all its tags — topics.e2e.js's
// delete_topic cascades the tag links but keeps the idea filed — and the old
// topics.length proxy would then mis-route that orphan to delete_note, tripping
// trg_item_no_delete_live_organized (a live filed item is not hard-deletable).
export async function clearInbox() {
  // inbox-stage ideas (unorganized) are hard-deletable.
  for (const n of await invoke("list_inbox")) {
    await invoke("delete_note", { id: n.id });
  }
  // filed-stage ideas are live + organized → soft-delete then purge.
  for (const n of await invoke("list_processed")) {
    await invoke("archive_note", { id: n.id });
    await invoke("purge_note", { id: n.id });
  }
}

// Seed a note that is processed but task-free: capture it, then file it into a
// new topic (no task), which moves it inbox→processed while leaving it without any
// task_note. Returns the note id.
export async function seedProcessedTaskless(content) {
  const noteId = await invoke("capture_note", { content });
  await invoke("file_note_to_topic", { id: noteId, newTitle: `归档-${content}` });
  return noteId;
}

// ㉜/㉟ ⋯ menu: card actions no longer live in an always-visible button row — they are
// behind the card's top-right ⋯ corner menu, wired by the shared hotkey controller
// (src/hotkey-menu.ts → .hk-btn / .hk-menu / .hk-label). inboxAction drives a 灵感 `.note`
// card; boardAction drives a 任务看板 `.tcard`. Open the menu, then click the menu item
// whose label === `label`. The action then opens its inline form / runs its op exactly as
// before, so each spec's follow-up selectors (.edit-area / .field / .confirm / chips /
// .confirm-q) are unchanged.
//
// Two steps on purpose — DON'T fold them into one execute(): leaveCard()'s removal hangs on
// a CSS transitionend that WebView2 only fires when there is a paint between the menu build
// and the style change. icon.click()+item.click() in one synchronous turn strands the card
// mid-fade (.note.removing, never removed). Real users always click across frames (mouse, or
// the single-key shortcut via real event dispatch), so we mirror that with a real WebDriver
// click on the item in a separate command.
// ⚠ **两步之间那个竞态是真的红过一趟**(backlog 测试与工装 68;run `33705210710`,
// `inbox-filter` 第二例报 `element (".hk-menu") still not existing after 5000ms`,而**红点不在断言上**)。
// 两种形,机理不同、⛔ 别混成一句:
//   (A) **这一记点击根本没建出菜单** —— 点之前卡片已被一次时间轴 refresh 换掉(点在**游离节点**
//       上一声不响什么也不发生,同 dev-and-testing 安卓 CDP 那条纪律),或那张卡 `suspended()`;
//   (B) **菜单建出来了又被收掉** —— refresh 走 `leaveCard()` / 重渲会调 `hk.reset()`
//       (`src/inbox.ts:429` / `:1225` → `openMenuCloser?.()`),portal 到 <body> 的那份当场 remove。
// ⭐ **(A) 在同一个任务内就答得出**:`openMenu()` 全程同步(`src/hotkey-menu.ts:227`:建 DOM +
//   定位 + 挂监听,没有 await / rAF)⇒ 点完**立刻**读一次 `.hk-menu`,答的是「这记点击到底有没有
//   生效」,不是「再等一会儿也许会有」。⇒ 两种形重试都有意义,而红的时候能说清是哪一种。
// ⛔ **别靠加超时**(memory `flaky-test-three-shapes`:加时间压不下去的随机红 = 判据本身读错了东西;
//   这里读错的正是「点出去了 = 收到了」)。
// ⚠ 重试之前先把**残留的别人那份菜单**收掉:那颗 ⋯ 是 **per-card** 开关(`menuEl` 在 `register()`
//   的闭包里),我方点击若落空而屏上恰好还开着上一步留下的菜单,读回来就是**假的 "opened"**,
//   第二步会点在**另一张卡**的菜单上(旧形同样有这个口,只是没人读得出来)。
async function cornerMenuAction(cardSel, key, content, label) {
  const seen = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Step 1: reveal the menu (build .hk-menu) —— 并在**同一个任务内**读回它建没建出来。
    const state = await browser.execute(
      (sel, c) => {
        // 残留的菜单先收(onDocClick 挂在 document 捕获阶段);收不掉就别在别人的菜单上点。
        if (document.querySelector(".hk-menu")) document.body.click();
        if (document.querySelector(".hk-menu")) return "stale-menu";
        const card = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(c));
        if (!card) return "no-card";
        const icon = card.querySelector(".hk-btn");
        if (!icon) return "no-icon";
        icon.click();
        return document.querySelector(".hk-menu") ? "opened" : "clicked-no-menu"; // ← (A) 的判据
      },
      cardSel,
      content,
    );
    seen.push(`${attempt}:${state}`);
    if (state !== "opened") continue;
    // Step 2: REAL click the item. The menu is portaled to <body> (not inside the card) to
    // escape the column's overflow clip, and at most one is ever open — so scope to the menu,
    // then the EXACT-text selector (a `=text` match can't follow a descendant combinator, so
    // it must be the whole selector inside menu.$()). EXACT so "删除" never matches "彻底删除".
    // ⚠ 走到这一句时菜单**已经在那儿了**(上面刚读到)⇒ 这两句等不到就是 (B),
    //   不是「超时给得不够」⇒ 故缩到 2s 并拿异常当字据重试,别再干等 5s。
    try {
      const menu = await $(".hk-menu");
      await menu.waitForExist({ timeout: 2000 });
      const item = await menu.$(`span.hk-label=${label}`);
      await item.waitForExist({ timeout: 2000 });
      await item.click();
      void key;
      return;
    } catch (e) {
      seen[seen.length - 1] += `→菜单没了/点不到(${String(e.message).split("\n")[0].slice(0, 80)})`;
    }
  }
  throw new Error(
    `⋯ 菜单动作没做成:卡片「${content}」→「${label}」,试了 ${seen.length} 次都没落地。\n` +
      `  逐次实得:${seen.join(" / ")}\n` +
      `  读法:clicked-no-menu = (A) 点在游离/挂起的卡上;→菜单没了 = (B) refresh 的 hk.reset() 收掉了它;` +
      `no-card = 那张卡当时不在树上;stale-menu = 上一步留下的菜单收不掉。见 backlog 测试与工装 68。`,
  );
}
export const inboxAction = (content, label) => cornerMenuAction(".note", null, content, label);
export const boardAction = (content, label) => cornerMenuAction(".tcard", null, content, label);

// Whether the card carrying `content` offers `label` in its ⋯ menu, WITHOUT acting. Opens
// the menu, reads the labels, closes it again (so it doesn't linger for the next step).
export async function cornerMenuHas(cardSel, content, label) {
  return browser.execute(
    (sel, c, l) => {
      // 残留的菜单先收干净 —— 否则下面那句「读全局的 .hk-menu」读的可能是**别人那份**。
      if (document.querySelector(".hk-menu")) document.body.click();
      const card = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(c));
      if (!card) throw new Error("card not found: " + c);
      card.querySelector(".hk-btn").click(); // open
      // ⚠ 同 `cornerMenuAction` 那条(测试与工装 68):这一记点击可能落在**游离节点**上而
      //    一声不响什么也不发生 —— 而这支的返回值是个布尔,那时它会安静地答 `false`
      //    =「菜单里没有这一项」,与真的没有**同形**。⇒ `openMenu()` 是同步的,当场读回来,
      //    没建出菜单就**响亮地红**,别拿一个读不出的局面冒充一个读数。
      if (!document.querySelector(".hk-menu")) {
        throw new Error("⋯ 菜单没打开(卡片可能已被 refresh 换掉,点在了游离节点上):" + c);
      }
      // The menu is portaled to <body>, not under the card — read it globally (one open at a time).
      const has = [...document.querySelectorAll(".hk-menu .hk-label")].some((s) => s.textContent === l);
      document.body.click(); // close (onDocClick)
      return has;
    },
    cardSel,
    content,
    label,
  );
}
export const boardMenuHas = (content, label) => cornerMenuHas(".tcard", content, label);

// Run a backend command and capture success/failure (for asserting fail-fast
// paths). Resolves to {ok:true} or {ok:false, err} instead of throwing.
export function tryInvoke(cmd, args) {
  return browser.execute(
    async (c, a) => {
      try {
        await window.__TAURI__.core.invoke(c, { ...a, spaceId: "main" });
        return { ok: true };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    },
    cmd,
    args,
  );
}

// 把看板 compose **开到开着**,而不是「点一下 `#add-task`」——那个按钮是**开关**
// (`board.ts`: `setComposeOpen(compose.hidden)`),compose 又会因为草稿回填自己先开着
// (文字那趟同步、暂存图那趟**异步**),于是「点开」在开着的时候正好把它**关上**,现场是
// `element ("#compose-input") still not displayed after 5000ms`。**396 §二**钉死的那只
// 1/16 抖动就是它(阳性对照:板子桶里种一张暂存图 → `board.e2e.js` 8 failing;删掉 →
// 15 passing 零重试)。
// ⚠ **别退回裸 click**:`wdio.conf.js` 那道清草稿的 `before` 只堵住「上次会话留下的」那条路,
// 另一条是「同一份 spec 里上游把 compose 留开了」——396 真见过一次。414 把这只 helper 从
// board.e2e.js 提到这里,就是为了让另外两处(compose-recovery / compose-images)也走同一条路。
//
// ⭐ **456:「看一眼」与「点下去」必须是同一刻**(backlog 测试与工装 6 那笔重开的账)。
// 414 那版是「先 `isDisplayed()` 读一次、再 `click()`」——**两次 WebDriver 往返**,中间有个窗口。
// 而把 compose 开出来的不止我一个:`board.ts` 的 `restoreImagesOnce(…)` 回调
// (`if (… && compose.hidden) setComposeOpen(true)`)是 **IndexedDB 异步**回来才跑的。它若正好落在
// 「读完」与「点下去」之间,我这一点就把**已经开着的** compose 关上 ⇒ 后面 5 秒当然等不到,
// 现场 `element ("#compose-input") still not displayed after 5000ms`(455 在 Linux CI 上真红过一次)。
// **它防住了「已经开着」,没防住「正要开」。** 收进一次 `browser.execute`(页内单线程,一个同步回合)
// 之后那个窗口没有了 —— `e2e/probes/compose-open-race.e2e.js` 拿人为放大的窗口做过一红两绿的对照。
//
// ⛔ **另外三条候选各自为什么没选**(456 摆开之后选的,别再挑回来):
//   ②保留真点击 + 「点完没显出来就再点一次」——要先等一个超时才知道"没显出来",而"等多久"
//     正是这条账明令禁止换上去的判据;
//   ③从根上让回填同步 —— **办不到**:暂存图存在 IndexedDB(`compose-draft.ts` 头注:图走 IDB
//     是因为 localStorage 会被大图撑爆),而 IDB 没有同步 API;
//   ④改用 `N` 那枚单键(`board.ts` 里它是**幂等开**、不是开关)—— `hotkey-menu.ts:336` 那句
//     「焦点在 INPUT/TEXTAREA 里就不抢键」会把它吞掉,而 `board.e2e.js` 那支正好是**筛着**
//     调用的(焦点在 `#board-filter` 里)⇒ 那一下会往过滤框里打个 "N"。
// ⚠ **`cornerMenuAction` 头注那条「别折进一次 execute」在这里不适用,理由要说准**:那条的因是
// **两次点击**之间需要一帧绘制(菜单建好 → 样式变 → `transitionend`);这里只有**一次**点击、
// 不牵扯任何过渡。同理 `goNotebook` 里那次侧栏导航本来就是页内合成 click,两端跑了很多轮。
// 换掉的那一点真实性由前面那句 `waitForClickable` 兜着(它仍是驱动的可点判定:存在、可见、没被盖住)。
export async function openCompose() {
  await $("#add-task").waitForClickable({ timeout: 8000 });
  await browser.execute(() => {
    const compose = document.querySelector("#compose");
    const btn = document.querySelector("#add-task");
    if (!compose || !btn) throw new Error("看板 compose 不在(#compose / #add-task 缺一)");
    // 已经开着(草稿回填 / 上一条测试留的)就别点——`#add-task` 是开关,点了就是关上。
    if (compose.hidden) btn.click();
  });
  await $("#compose-input").waitForDisplayed({ timeout: 5000 });
}

// 元素上「用户看得见的那行字」。**别用 `getText()` / `toHaveText()` 读它** —— 396 分诊:
// WebKitGTK 的 WebDriver 对已渲染元素会读回**空串**(实测同一元素 `innerText` 正确、
// `getBoundingClientRect` 114×22、`visibility:visible`、`opacity:1`,驱动仍给 ""),而
// Windows 的 msedgedriver 读得到 ⇒ 同一句断言在两端结论不同,是**驱动差异不是产品缺陷**。
// 这里两条一起断:①元素确实显示(isDisplayed 走的是驱动的可见性判定,不受上面那条影响)
// ②DOM 上的文字。比单看 getText **更强**而不是更弱。
// ⚠ 先 `await` 把链式元素落成真元素再交给 execute:`$(sel)` 返回的是 thenable,直接当参数
// 传进去会被当普通对象序列化,页内拿到的 `n` 是 undefined(现场:`undefined is not an object`)。
export async function shownText(el) {
  const node = await el;
  if (!(await node.isDisplayed())) throw new Error("元素存在但不可见");
  return browser.execute((n) => n.textContent.trim(), node);
}

// 点**标签轴**上文字含 `label` 的那枚 pill(共享件,别再各 spec 抄一份选择器)。
//
// ⛔ **必须限定在标签轴那一行**:`.tf-pill` 在一条筛选行里**不唯一** —— 类型轴
// (`#kind-filter`)与时间轴(`#time-filter`,461 起)发的也是 `.tf-pill`,而时间轴的
// 重置档**复用同一个词「所有」**、且在 DOM 里排在标签轴**之前**(`board.ts` / `inbox.ts`
// 的 `.filter-row`:kind → time → main>topic)⇒ 裸 `querySelectorAll(".tf-pill")` 再
// `.find()` 取的是**文档序第一枚**,点「所有」会被时间轴截胡。
//
// **475 补的判例**:那笔时间轴没跟着改 spec,公开仓 CI 上 `board.e2e.js` 1 例 +
// `inbox-filter.e2e.js` 4 例全部 `waitUntil 8s` 超时;更阴的是 `board-multitag` 与
// `board-tag-collapse` 的 `after` 钩子 —— 它们**静默**没复位(点在了时间轴上),把标签选态
// 泄漏给后面的 spec,而那两只自己是绿的。⭐ 第五根轴进来时**改这一处就够了**。
//
// ⚠ 找不到就**抛**,不做 `if (p) p.click()` 那种宽容:复位钩子悄悄不复位,正是上面那半。
async function pickTopicPill(bar, label) {
  await browser.execute(
    (sel, l) => {
      const p = [...document.querySelectorAll(`${sel} .tf-pill`)].find((x) =>
        x.textContent.includes(l),
      );
      if (!p) throw new Error(`标签轴(${sel})上没有这枚 pill:${l}`);
      p.click();
    },
    bar,
    label,
  );
}
export const boardPickTopicPill = (label) => pickTopicPill("#topic-filter", label);
export const inboxPickTopicPill = (label) => pickTopicPill("#idea-topic-filter", label);

// ⭐ **列宽下限(A)之后,窄窗再也压不出「窄卡」那几个患了** —— 最窄的卡宽 = 下限 200 −
// 列体内边距 8 = **192px**,而咬人的档位在卡宽 161(窗 950)与 128(窗 820)。那几条
// `min-width: 0` 的防线(tasktime.css 的 topic-slot / chip、board.css 的 topic-choices、
// 524 那对)因此**再没有行为网守着**,删掉它们今天所有测试照样绿 —— 那正是 memory
// `doc-claims-a-test-exists-verify-it` 说的那种空账。
// ⇒ 三只窄卡用例(task-time 两只 + board-tag-picker 一只)**就地把下限临时摘掉**再量:
// 摘掉之后的几何与加 A 之前逐字相同(`flex:1 1 0` + `min-width:0` + `.cols` 不滚)。
// ⛔ 别把它读成「测了一个用户碰不到的状态」:被测的那几条 CSS 防线**在生产代码里活着**,
// 这几只答的是「它们还有没有用」。
// ⛔ 也别把它当成「下限可以随便改」的口子 —— 下限自己的网是 `board.e2e.js` 那只
//「列有下限、装不下就横滚」,两边各守一半。
// ⚠ 注入生效与否**不用另写断言**:每只各自的前置断言(卡宽 < 180 / < 140)就是它的正面字据
//   —— 没摘掉的话卡宽是 192,当场红。
// ⚠ 走 `browser.url()` 重新导航(含 goNotebook)会把它冲掉 ⇒ 设窗之后、量之前注入。
export async function dropColFloor() {
  await browser.execute(() => {
    const s = document.createElement("style");
    s.id = "e2e-no-col-floor";
    s.textContent = ".v-board .col{min-width:0}.v-board .cols{overflow-x:visible;overflow-y:visible}";
    document.head.append(s);
  });
}


// **打字面文本一律走这里,⛔ 别再用 `browser.keys("字串")`。**
//
// 为什么(571 在 Linux 桌面上量出来的,backlog 用户面 64 那条连红五趟的根):wdio 9.28 的
// `browser.keys(字串)` 把序列拼成 **先把每个字符全部 keyDown、pause(10)、再全部 keyUp**
// (`node_modules/webdriverio/build/index.js` 那支 `async function keys(value)`)—— 相邻重复的
// 字符于是成了「同一枚键按着不放再按一次」,W3C 把它定义成 **repeat**,而两个引擎处置不同:
//   · Windows/msedgedriver:照样插字 ⇒ 看不见这个坑
//   · Linux/WebKitWebDriver:**一个字都不插** ⇒ 相邻重复整个塌成一个
// 实测读数(`e2e/probes/webkit-keys-dup.e2e.js`,裸 textarea + 产品输入框同结论):
//   `thre`→`thre` ✅ · `aba`→`aba` ✅ · `three`→`thre` · `aa`→`a` · **`book`→`bok`** · `aaa`→`a`
// ⭐ `book`→`bok` 那格是承重的:丢的**不是「最后一记」**(563/566 两轮的立论都错在这儿,
// 566 补的那记 End 催不出来正是因为那个字符压根没生成),是**重复的那一记**。
// ⛔ 别再往「加等待 / 补一记键」的方向修。
//
// 这里发的是每个字符各自 down+up(= 真键盘的模型),**一条动作链一次往返**,不比原来慢;
// 中日文亦可(实测 `E2E-一二` ✅)。⚠ 只管**字面文本**;组合键(`["Control","l"]`)照旧走
// `browser.keys`——那一形里没有相邻重复,不受影响。⚠ `setValue` 走的是另一条端点
// (Element Send Keys),实测不吞(`three`/`aaa`/`book` 全对),不必改。
export async function typeText(text) {
  const chain = browser.action("key");
  for (const ch of text) chain.down(ch).up(ch);
  await chain.perform();
}
