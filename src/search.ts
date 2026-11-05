import { currentSpaceId, invoke } from "./space";
import { focusBoardView, focusTask } from "./board";
import { t } from "./i18n";
import { focusInboxItem } from "./inbox";
import { docPreviewText, focusDoc } from "./docs";
import type { View, ViewCtx } from "./notebook";
import { when } from "./tasktime";
import { applyTagColor } from "./tag-color";
import { INPUT_DEBOUNCE_MS } from "./timing";
import "./search.css";
import { el } from "./dom";
import { errText } from "./err";
import { renderContent } from "./item-images";
import { settlePreviewFolds } from "./fold";
import { setLocateNote } from "./locate";

// Mirror of the Rust contract (lib.rs `search_items`): an item whose current text
// OR any past version matched. Single-entity model — a hit can be an idea (未归类 /
// 已归类), a board task, or anything in the 回收站. Read-only — manage from the tabs.
type SearchHit = {
  id: string;
  content: string;
  created_at: string;
  status: "inbox" | "processed" | "doc" | "archived" | "task" | "sealed";
  topics: { title: string; color: string | null }[];
  /** true = 当前正文里没凑齐所有词、只在改过的旧版本里凑齐(W3 A4,core `repo::SearchHit`)。 */
  history_only: boolean;
  /** 只在 `status === "archived"` 时有值:还原后回到哪一类(W3 Q12,core `repo::SearchHit`)。 */
  trash_kind: "task" | "doc" | "idea" | null;
};

// ---- small DOM helper (same shape as inbox.ts / topics.ts) -----------------
// Where the item currently lives. 灵感 is one merged list now (tags are just metadata, no
// inbox/filed split), so both idea statuses read as 灵感; plus 回收站 and 任务 (the board).
const STATUS_LABEL: Record<SearchHit["status"], string> = {
  inbox: t("search.statusIdeas"),
  processed: t("search.statusIdeas"),
  doc: t("search.statusDoc"), // 长文(0042;归属由 core 判,这里只认词)
  archived: t("search.statusTrash"),
  task: t("search.statusTask"),
  sealed: t("search.statusSealed"), // 成就归档(sealed 轴)——已入册的干完的活,不在看板上
};

// 回收站命中写成「回收站 · 任务 / 随记 / 长文」(W3 159 / Q12,WD-31:此前只写「回收站」,看不出原来是什么)。
// 用词与另几枚章同一份(「任务」「随记」「长文」),⛔ 别另起一套。
const TRASH_KIND_LABEL: Record<NonNullable<SearchHit["trash_kind"]>, string> = {
  idea: t("search.statusIdeas"),
  task: t("search.statusTask"),
  doc: t("search.statusDoc"),
};
function badgeLabel(hit: SearchHit): string {
  if (hit.status !== "archived") return STATUS_LABEL[hit.status];
  // core 对回收站行恒给 trash_kind;缺 = 契约断了,响亮抛(fail-fast),不猜。
  if (hit.trash_kind === null) throw new Error(`search: archived hit ${hit.id} without trash_kind`);
  return t("search.statusTrashKind", { kind: TRASH_KIND_LABEL[hit.trash_kind] });
}

// Build the matched text as text + <mark> nodes (never innerHTML), so the
// highlight can never inject markup from user content. Case-insensitive, every
// occurrence of every whitespace-separated word (core searches word by word too);
// overlapping hits merge into one <mark>.
function highlighted(text: string, query: string): (Node | string)[] {
  const hay = text.toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hit = new Array<boolean>(text.length).fill(false);
  for (const w of words) {
    for (let at = hay.indexOf(w); at >= 0; at = hay.indexOf(w, at + 1)) {
      hit.fill(true, at, at + w.length);
    }
  }
  const out: (Node | string)[] = [];
  let from = 0;
  while (from < text.length) {
    let to = from;
    while (to < text.length && hit[to] === hit[from]) to++;
    const piece = text.slice(from, to);
    out.push(hit[from] ? el("mark", { textContent: piece }) : piece);
    from = to;
  }
  return out;
}

const SKELETON = `
  <header data-tauri-drag-region>
    <h1>${t("search.title")}</h1>
  </header>
  <div class="searchbar">
    <div class="field">
      <span class="mag" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="5.5"/><path d="M14.6 14.6 20 20"/></svg></span>
      <input id="q" type="text" placeholder="${t("search.inputPlaceholder")}" autocomplete="off" spellcheck="false" />
      <button id="clear" class="clear" title="${t("search.clear")}" aria-label="${t("search.clear")}" hidden>✕</button>
    </div>
  </div>
  <main id="list"></main>
`;

// The last query typed here. Module scope so it survives a view switch: navigate()
// unmounts+remounts on every switch, and a fresh <input> would otherwise come back
// empty. (Same rationale as topics.ts `expanded`, board.ts `topicFilter`, inbox.ts
// `active`.) Only one search view is mounted at a time.
let lastQuery = "";
// 上次离开时结果列表滚到哪儿(W3 159 / A17,WD-28):从结果点进时间轴、再点侧栏「搜索」回来,词和结果一直在,
// 滚动位置却回到了顶。只认同一空间 + 同一个词(换了空间 / 词,那是另一份结果)。
let lastScroll: { space: string; q: string; top: number } | null = null;

export function mount(root: HTMLElement, ctx: ViewCtx): View {
  const view = el("div", { className: "v-search view" });
  view.innerHTML = SKELETON;
  root.replaceChildren(view);

  const list = view.querySelector("#list") as HTMLElement;
  const input = view.querySelector("#q") as HTMLInputElement;
  const clearBtn = view.querySelector("#clear") as HTMLButtonElement;
  const mountSpace = currentSpaceId();
  // ✕ 只给鼠标(W3 159 / Q12,WD-29):此前 Tab 先落在它上面,接着一下回车就把词清了。键盘清词走 Esc。
  clearBtn.tabIndex = -1;
  // 首发结果画完时滚回上次的位置(只一次);之后改词 / 回窗重跑,位置归用户自己。
  let restoreTop: { q: string; top: number } | null =
    lastScroll !== null && lastScroll.space === mountSpace && lastScroll.q === lastQuery ? lastScroll : null;

  function renderCenter(big: string, detail: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: big }),
        el("div", { textContent: detail }),
      ]),
    );
  }

  function renderError(message: string): void {
    list.replaceChildren(
      el("div", { className: "center" }, [
        el("div", { className: "big", textContent: t("search.failed") }),
        el("div", { className: "err-box", textContent: message }),
      ]),
    );
  }

  // 搜到了要到得了(ui-audit P1 #8):按 status 分流到条目现在住的地方——任务→看板
  // 高亮(focusTask 通道)、灵感→灵感视图定位、归档→看板归档册、回收站→
  // 按 trash_kind 分家(灵感回收站 / 看板回收站,一条 archived_at 轴两端列表)。
  // (此前回收站那支要 await 一次读命令,故有一枚 jumpSeq 防连点乱序;159 起整支同步了,它随之退役。)
  function jump(hit: SearchHit): void {
    // A4(WD-02):只在旧版本里命中的,落点卡上写一句「搜到的是改过之前的版本,去「历史」里看」—— 此前点进去
    // 只有粉框,卡上的字里根本没有那个词。回收站里的卡菜单里没有「历史」,改说还原后再看。
    setLocateNote(
      hit.id,
      hit.history_only ? (hit.status === "archived" ? t("search.landedOldTrash") : t("search.landedOld")) : null,
    );
    if (hit.status === "task") {
      focusTask(hit.id);
      ctx.navigate("board");
    } else if (hit.status === "inbox" || hit.status === "processed") {
      focusInboxItem(hit.id, "ideas");
      ctx.navigate("inbox");
    } else if (hit.status === "doc") {
      focusDoc(hit.id);
      ctx.navigate("docs");
    } else if (hit.status === "sealed") {
      focusTask(hit.id);
      focusBoardView("sealed");
      ctx.navigate("board");
    } else if (hit.status === "archived") {
      // 159 起命中自己带 `trash_kind`(core 判的「还原后回到哪一类」,同 badgeLabel 那枚章):任务 → 看板回收站,
      // 随记 / 长文 → 随记回收站(长文删了进的是随记那边)。此前要现读一次 list_archived 再判。
      if (hit.trash_kind === "task") {
        focusTask(hit.id);
        focusBoardView("trash");
        ctx.navigate("board");
      } else if (hit.trash_kind === "idea" || hit.trash_kind === "doc") {
        focusInboxItem(hit.id, "archived");
        ctx.navigate("inbox");
      } else {
        throw new Error(`search: archived hit ${hit.id} without trash_kind`);
      }
    } else {
      // 认不得的去向 = core 的分类词汇多了一种而这里没接(0042 之前「长文」就会落进上面那支
      // 被当成回收站)。⛔ 别再写成兜底的 else。
      const never: never = hit.status;
      throw new Error(`search: unknown status ${String(never)}`);
    }
  }

  // One result card: the matched thought (highlighted) + a meta row of provenance.
  // W3 159 / A16(WD-21 / WD-30):正文照「只读预览」画 —— 清单行画成方框(与随记同一份认行,
  // 不给点)、长文摘掉行首记号(别露「#」)、长的先一律夹在八行(落 DOM 后 settlePreviewFolds 量了再定)。
  // `isDoc` 由 run() 判:活长文看 status,回收站里的长文看 `trash_kind`(core 判的归属,前端不另判)。
  function card(hit: SearchHit, query: string, isDoc: boolean): HTMLElement {
    const meta = el("div", { className: "hit-meta" }, [
      el("span", {
        className: `badge ${hit.status}`,
        textContent: badgeLabel(hit),
      }),
      // A4(WD-02):只在改过的旧版本里命中 —— 卡上画的是现在的正文,里面没有那个词、不标红,得说一声。
      ...(hit.history_only ? [el("span", { className: "badge old-hit", textContent: t("search.oldVersionHit") })] : []),
      ...hit.topics.map((tp) => {
        // 624(用户面 74 / C):有色标签在这里也画那颗点 —— 卡片(`.tag.tinted`)与筛选条
        // (`.tf-dot`)本来就画,而搜索恰恰是最需要「一眼认出是哪个标签」的地方。着色走
        // 共享助手 `applyTagColor`(chip 族着色的那一处),⛔ 别在这里另抄一份。
        // ⚠ 625 更正:它**不是**全应用唯一写 `--tag-color` 的地方 —— `filter-bar.ts` 与
        // `topics.ts` 还有三处直接 `setProperty`,且那两处的 CSS 是 `background:` 而不是
        // `color-mix()`,值域没人管(backlog「标签颜色值域」)。⛔ 别照这句注释推断「在
        // 助手里加一道校验就全堵上了」。⛔ 颜色只信这枚 chip 自己带的那份(命令直接给的),别拿标题去
        // `list_topics` 回连:同名标签下那是任取一枚 = 静默给错色(全文在 `repo::SearchTopic`)。
        const chip = el("span", { className: "chip", textContent: tp.title });
        applyTagColor(chip, tp.color);
        return chip;
      }),
    ]);
    meta.append(el("time", { className: "hit-time", textContent: when(hit.created_at) }));

    const text = el("p", { className: "hit-text clamped" });
    text.append(
      renderContent(isDoc ? docPreviewText(hit.content) : hit.content, [], undefined, (s) => highlighted(s, query)),
    );
    const node = el("article", { className: "hit", tabIndex: 0 }, [text, meta]);
    node.addEventListener("click", () => jump(hit));
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        jump(hit);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        // ↑ ↓ 在结果之间走;第一条上再按 ↑ 回搜索框(Q12,WD-29 的另一半)。
        e.preventDefault();
        const hits = [...list.querySelectorAll<HTMLElement>(".hit")];
        const i = hits.indexOf(node);
        const next = e.key === "ArrowDown" ? hits[i + 1] : hits[i - 1];
        if (next) next.focus();
        else if (e.key === "ArrowUp") input.focus();
      }
    });
    return node;
  }

  // The query whose results are currently shown — guards against an out-of-order
  // response (a slow earlier search resolving after a newer one) and lets a focus
  // refresh re-run the live query.
  let shown = "";

  async function run(query: string): Promise<void> {
    const q = query.trim();
    shown = q;
    lastQuery = q; // remember across view switches
    if (!q) {
      renderCenter(t("search.idleTitle"), t("search.idleHint"));
      return;
    }
    try {
      const hits = await invoke<SearchHit[]>("search_notes", { query: q });
      if (shown !== q) return; // a newer query already superseded this one
      const top = restoreTop;
      restoreTop = null; // 只还首发那一次
      if (hits.length === 0) {
        renderCenter(t("search.noMatch"), t("search.noMatchDetail", { q }));
        return;
      }
      list.replaceChildren(
        el("p", { className: "count", textContent: t("search.matchCount", { n: hits.length }) }),
        ...hits.map((h) => card(h, q, h.status === "doc" || h.trash_kind === "doc")),
      );
      settlePreviewFolds(list, ".hit-text", { fold: t("board.fold"), unfold: t("board.unfold") });
      if (top !== null && top.q === q) list.scrollTop = top.top; // ⚠ 在折叠定局之后:还的是夹后几何里的位置
    } catch (err) {
      if (shown !== q) return;
      renderError(errText(err));
    }
  }

  // Debounce keystrokes so we don't fire a query per character.
  let timer: number | undefined;
  function onInput(): void {
    clearBtn.hidden = input.value.length === 0;
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void run(input.value), INPUT_DEBOUNCE_MS);
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // IME 组合期的 Enter 是上屏,不是立即搜索(ui-audit P0 #1)
    if (e.key === "ArrowDown") {
      // ↓ 进第一条结果(Q12,WD-29:此前 ↓ 不动、Tab 先落 ✕)。没有结果时什么也不做。
      const first = list.querySelector<HTMLElement>(".hit");
      if (first) {
        e.preventDefault();
        first.focus();
      }
      return;
    }
    if (e.key === "Enter") {
      window.clearTimeout(timer);
      void run(input.value);
    } else if (e.key === "Escape") {
      // Esc clears a non-empty box; on an empty box it does nothing (this is one
      // view in the notebook — leave via the sidebar, don't close the window).
      if (input.value) {
        input.value = "";
        onInput();
        void run("");
      }
    }
  });

  clearBtn.addEventListener("click", () => {
    input.value = "";
    clearBtn.hidden = true;
    void run("");
    input.focus();
  });

  // Restore the query from a prior visit (module-scope lastQuery). If empty, show the
  // idle hint; if not, replay it so the results are back exactly as left.
  if (lastQuery) {
    input.value = lastQuery;
    clearBtn.hidden = false;
    void run(lastQuery);
  } else {
    renderCenter(t("search.idleTitle"), t("search.idleHint"));
  }
  input.focus();

  return {
    unmount() {
      lastScroll = shown ? { space: mountSpace, q: shown, top: list.scrollTop } : null;
      root.replaceChildren();
    },
    onFocus() {
      // Re-focus ready to type and re-run the live query in case the underlying
      // notes changed (filed, edited, archived) since last shown.
      input.focus();
      if (shown) void run(shown);
    },
  };
}
