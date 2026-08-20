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
  await browser.setWindowSize(1000, 700);
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
export async function openCompose() {
  await $("#add-task").waitForClickable({ timeout: 8000 });
  if (await $("#compose-input").isDisplayed()) return; // 已经开着(草稿回填 / 上一条测试留的)
  await $("#add-task").click();
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
