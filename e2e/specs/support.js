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
