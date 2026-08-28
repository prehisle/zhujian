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
    const tail = said ? ` app 自己说的话:${said}` : " app 那边没留下任何错误提示。";
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
  // ⭐ **485:1000 → 1100,跟着 `board.css` 那个断点一起挪的**。看板 header 的「窄窗缩成
  // 字母」断点本轮从 999 抬到 1099(它多了第六枚控件「管理列」,量出来的账见 board.css 那段)
  // ⇒ 窗还停在 1000 的话,这套 e2e 从此**只跑得到字母态**,而 `viewkeys.e2e.js` 有两只用例
  // 拿 `#trash-toggle` 的**可见文字**当观测面(「回收站」在字母态下是隐掉的)。
  // ⚠ 485 实测:不挪窗那两只当场红 —— ⛔ 别把那当抖动,它是这条耦合的字据。
  // ⛔ **别改成「把断点抬了但窗不动」**:那等于悄悄放弃「全名态也在测」这半覆盖面
  // (69 当初把断点定在 999 的原话就是「e2e 驱动窗恰 1000,保持全名态」)。
  await browser.setWindowSize(1100, 700);
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
async function cornerMenuAction(cardSel, key, content, label) {
  // Step 1: reveal the menu (build .hk-menu).
  await browser.execute(
    (sel, c) => {
      const card = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(c));
      if (!card) throw new Error("card not found: " + c);
      const icon = card.querySelector(".hk-btn");
      if (!icon) throw new Error("⋯ menu button not found on card: " + c);
      icon.click();
    },
    cardSel,
    content,
  );
  // Step 2: REAL click the item. The menu is portaled to <body> (not inside the card) to
  // escape the column's overflow clip, and at most one is ever open — so scope to the menu,
  // then the EXACT-text selector (a `=text` match can't follow a descendant combinator, so
  // it must be the whole selector inside menu.$()). EXACT so "删除" never matches "彻底删除".
  const menu = await $(".hk-menu");
  await menu.waitForExist({ timeout: 5000 });
  const item = await menu.$(`span.hk-label=${label}`);
  await item.waitForExist({ timeout: 5000 });
  await item.click();
  void key;
}
export const inboxAction = (content, label) => cornerMenuAction(".note", null, content, label);
export const boardAction = (content, label) => cornerMenuAction(".tcard", null, content, label);

// Whether the card carrying `content` offers `label` in its ⋯ menu, WITHOUT acting. Opens
// the menu, reads the labels, closes it again (so it doesn't linger for the next step).
export async function cornerMenuHas(cardSel, content, label) {
  return browser.execute(
    (sel, c, l) => {
      const card = [...document.querySelectorAll(sel)].find((n) => n.textContent.includes(c));
      if (!card) throw new Error("card not found: " + c);
      card.querySelector(".hk-btn").click(); // open
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
