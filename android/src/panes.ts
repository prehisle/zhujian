// 回收站 / 归档册 / 搜索 低频面(120)。统一纪律(codex 120 设计审 M7):
// 每次加载开头取定 {space, seq},响应回来复核 space 未变且 seq 仍是最新才画
// ——旧查询晚回不许盖新查询,切空间后的迟到响应整体弃。写操作 in-flight 禁点,
// 彻底删/清空的两拍确认在底部固定确认条(ui-audit P0 #4:原位换话术会改按钮几何,
// 第二拍可能落到毗邻单拍的「恢复」上;固定条几何恒定,onYes 复核行还在才执行)。
import {
  getCurrentSpace,
  listBoardColumns,
  listSealedTasks,
  listTrash,
  purgeAllTrash,
  purgeNote,
  purgeTask,
  restoreNote,
  restoreTask,
  searchNotes,
  unsealTask,
  type SearchStatus,
} from "./api";
import { t } from "./i18n";
import { $, confirmBar, contentHtml, esc, fmtWhen, hideConfirmBar, showBar, showError } from "./ui";
import { isTaskStage, setColumns, stageLabel } from "./columns";

type Deps = {
  refreshTimeline: () => Promise<void>;
  /** 搜索命中活跃条目 → 关面 + 回主视图定位并闪一下那张卡(在 main.ts 实现,
   *  146 起按条目 stage 先切到灵感/任务面再定位)。 */
  focusCard: (id: string) => void;
  /** 搜索命中分流(ui-audit P1 #8):回收站/归档册的命中切到对应面(main.ts openPane)。 */
  showPane: (name: "trash" | "sealed") => void;
};

let deps: Deps;

/** 收起底部确认条(重载/切空间时:旧确认不许挂在新列表上)。 */
function clearConfirm() {
  hideConfirmBar();
}

// ---- 回收站 -------------------------------------------------------------------

let trashSeq = 0;
let trashBusy = false;
let trashRows: import("./api").TrashItem[] = [];
/** 展开着操作面板的那张卡(同 `sealedOpenId`,至多一张);null = 一张都没开。
 *  51 起回收站跟上 508 的形 —— 只读视图的离场动作不常驻,点卡片才出。 */
let trashOpenId: string | null = null;

export async function loadTrash(): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++trashSeq;
  const box = $("trash-list");
  box.innerHTML = `<p class="muted empty">${t("panes.loading")}</p>`;
  try {
    // 列与行同批取:回收站每行要印「这是灵感还是哪一列的任务」,而列名来自库
    // (B-f 第 1 段)。⛔ 别指望主时间轴那轮已经登记过 —— 首轮 refresh 失败时它是空的,
    // 那会让每一行都退化成「灵感」而**不报错**。
    const [rows, cols] = await Promise.all([listTrash(space), listBoardColumns(space)]);
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    setColumns(cols);
    trashRows = rows;
    // 重载后那张卡可能已经不在(自己刚还原/彻底删了、对端动过):展开态跟着作废(同 sealed)。
    if (trashOpenId !== null && !rows.some((r) => r.id === trashOpenId)) trashOpenId = null;
    clearConfirm();
    renderTrash();
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== trashSeq) return;
    box.innerHTML = `<p class="empty warn-ink">${t("panes.trashLoadFailed", { error: esc(String(err)) })}</p>`;
  }
}

function renderTrash() {
  const box = $("trash-list");
  ($("trash-empty") as HTMLButtonElement).disabled = trashBusy || trashRows.length === 0;
  if (!trashRows.length) {
    box.innerHTML = `<p class="muted empty">${t("panes.trashEmpty")}</p>`;
    return;
  }
  box.innerHTML = trashRows
    .map((r) => {
      const kind = stageLabel(r.stage) ?? t("panes.kindIdea");
      const chips = r.topics
        .map(
          (t) =>
            `<span class="chip${t.color ? " tinted" : ""}"${t.color ? ` style="--tc:${esc(t.color)}"` : ""}>${esc(t.title)}</span>`,
        )
        .join("");
      // 51:两枚离场动作不常驻 —— 点卡片才出面板,再点收起(同 sealed / 同时间轴)。
      const panel =
        r.id === trashOpenId
          ? `<div class="panel"><div class="acts">
              <button data-trash-act="restore"${trashBusy ? " disabled" : ""}>${t("panes.restore")}</button>
              <button data-trash-act="purge" class="warn"${trashBusy ? " disabled" : ""}>${t("panes.purge")}</button>
            </div></div>`
          : "";
      return `<article class="card" data-trash="${esc(r.id)}"><div class="body">
        <p class="content">${contentHtml(r.content, false)}</p>
        <footer><span class="pill">${kind}</span><time>${t("panes.deletedAt", { when: esc(fmtWhen(r.archived_at)) })}</time>${chips}</footer>${panel}
      </div></article>`;
    })
    .join("");
}

async function trashRun(op: (space: string) => Promise<unknown>, doneMsg?: string) {
  if (trashBusy) return;
  const space = getCurrentSpace();
  trashBusy = true;
  renderTrash();
  try {
    await op(space);
    if (space === getCurrentSpace() && doneMsg) showBar(doneMsg, true);
  } catch (err) {
    if (space === getCurrentSpace()) showError(String(err));
  } finally {
    trashBusy = false;
    clearConfirm();
    if (space === getCurrentSpace()) {
      await loadTrash();
      void deps.refreshTimeline();
    }
  }
}

function onTrashClick(e: Event) {
  const el = e.target as HTMLElement;
  if (el.id === "trash-empty") {
    if (!trashRows.length || trashBusy) return;
    confirmBar(t("panes.emptyTrashQ", { n: trashRows.length }), t("panes.emptyTrashYes"), () => {
      if (trashBusy || !trashRows.length) return; // 期间已重载成空/在写:弃
      void trashRun(
        async (space) => {
          const n = await purgeAllTrash(space);
          return n;
        },
        t("panes.trashEmptied"),
      );
    });
    return;
  }
  const act = el.closest<HTMLElement>("[data-trash-act]")?.dataset.trashAct;
  if (!act) {
    // 点卡片本身 = 开合它的操作面板(至多一张开着,同归档册 / 同时间轴)。写在途整面禁点,
    // 与那两枚按钮的 disabled 同一条闸。
    // ⭐ **开合必须连底部确认条一起收**(照 `cardpanel.ts` 的 toggle:收面与换卡都 `clearConfirm()`)
    //    —— 否则「彻底删除」问到一半把卡收起来,屏底还挂着一句问谁都不知道的确认。
    const card = el.closest<HTMLElement>("[data-trash]");
    if (!card || trashBusy) return;
    clearConfirm();
    trashOpenId = trashOpenId === card.dataset.trash ? null : card.dataset.trash!;
    renderTrash();
    return;
  }
  if (trashBusy) return;
  const id = el.closest<HTMLElement>("[data-trash]")?.dataset.trash;
  const row = trashRows.find((r) => r.id === id);
  if (!row) return;
  const task = isTaskStage(row.stage);
  if (act === "restore") {
    // 146:恢复=回主视图,按该行冻结 stage 指路(任务回任务面、灵感回灵感面)。
    void trashRun(
      (space) => (task ? restoreTask(space, row.id) : restoreNote(space, row.id)),
      task ? t("panes.restoredTask") : t("panes.restoredIdea"),
    );
    return;
  }
  if (act === "purge") {
    confirmBar(t("panes.purgeOneQ"), t("panes.purge"), () => {
      // 确认期间列表可能已被远端刷新重载:按 id 重取现行,行没了就弃(绝不误删别行)。
      const fresh = trashRows.find((r) => r.id === row.id);
      if (!fresh || trashBusy) return;
      const freshTask = isTaskStage(fresh.stage);
      void trashRun((space) => (freshTask ? purgeTask(space, fresh.id) : purgeNote(space, fresh.id)));
    });
  }
}

// ---- 归档册 -------------------------------------------------------------------

let sealedSeq = 0;
let sealedBusy = false;
let sealedRows: import("./api").TaskItem[] = [];
/** 展开着操作面板的那张卡(同一时刻至多一张,与时间轴卡片同一个手势);null = 一张都没开。
 *  归档册是只读视图,**静默才是常态** —— 508 起那枚「取消入册」不再常驻(design-rules
 *  「只读视图只留离场动作、且不常驻」),点卡片才出、再点收起。 */
let sealedOpenId: string | null = null;

export async function loadSealed(): Promise<void> {
  const space = getCurrentSpace();
  const seq = ++sealedSeq;
  const box = $("sealed-list");
  box.innerHTML = `<p class="muted empty">${t("panes.loading")}</p>`;
  try {
    const rows = await listSealedTasks(space);
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    sealedRows = rows;
    // 重载后那张卡可能已经不在(自己刚取消入册 / 对端动过):展开态跟着作废。
    // ⛔ 别留着 —— 那个 id 若还挂着,下一次渲染会把面板开在一张**别的**卡上是不可能的
    // (按 id 匹配),但它会让「其实没有卡开着」的状态无声地存活到下一轮。
    if (sealedOpenId !== null && !rows.some((r) => r.id === sealedOpenId)) sealedOpenId = null;
    renderSealed();
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== sealedSeq) return;
    sealedRows = [];
    sealedOpenId = null;
    box.innerHTML = `<p class="empty warn-ink">${t("panes.sealedLoadFailed", { error: esc(String(err)) })}</p>`;
  }
}

function renderSealed() {
  const box = $("sealed-list");
  if (!sealedRows.length) {
    box.innerHTML = `<p class="muted empty">${t("panes.sealedEmpty")}</p>`;
    return;
  }
  box.innerHTML = sealedRows
    .map((r) => {
      const panel =
        r.id === sealedOpenId
          ? `<div class="panel"><div class="acts">
              <button data-unseal="${esc(r.id)}"${sealedBusy ? " disabled" : ""}>${t("panes.unseal")}</button>
            </div></div>`
          : "";
      return `<article class="card" data-sealed="${esc(r.id)}"><div class="body">
        <p class="content">${contentHtml(r.title, false)}</p>
        <footer><time>${
          r.done_at
            ? t("panes.doneAt", { when: esc(fmtWhen(r.done_at)) })
            : t("panes.sealedAt", { when: esc(fmtWhen(r.sealed_at!)) })
        }</time></footer>${panel}
      </div></article>`;
    })
    .join("");
}

function onSealedClick(e: Event) {
  const el = e.target as HTMLElement;
  const id = el.closest<HTMLElement>("[data-unseal]")?.dataset.unseal;
  if (!id) {
    // 点卡片本身 = 开合它的操作面板(至多一张开着,同时间轴那套)。写在途时整面禁点,
    // 与那枚按钮的 disabled 同一条闸。
    const card = el.closest<HTMLElement>("[data-sealed]");
    if (!card || sealedBusy) return;
    sealedOpenId = sealedOpenId === card.dataset.sealed ? null : card.dataset.sealed!;
    renderSealed();
    return;
  }
  if (sealedBusy) return;
  const space = getCurrentSpace();
  sealedBusy = true;
  renderSealed(); // 立即画出禁用态(同 trashRun 的形):连点不许并发提交同一条
  void (async () => {
    try {
      await unsealTask(space, id);
      if (space === getCurrentSpace()) showBar(t("panes.unsealed"), true);
    } catch (err) {
      if (space === getCurrentSpace()) showError(String(err));
    } finally {
      sealedBusy = false;
      if (space === getCurrentSpace()) {
        await loadSealed();
        void deps.refreshTimeline();
      }
    }
  })();
}

// ---- 搜索 --------------------------------------------------------------------

const SEARCH_STATUS_LABEL: Record<SearchStatus, string> = {
  inbox: t("panes.hitInbox"),
  processed: t("panes.hitProcessed"),
  task: t("panes.hitTask"),
  archived: t("panes.hitArchived"),
  sealed: t("panes.hitSealed"),
};

let searchSeq = 0;

async function runSearch() {
  // 序号先行(实现审 L7):空查询也要作废在途的旧查询——否则「清空再点搜」后,
  // 旧查询的迟到结果会把空态盖回旧列表。
  const space = getCurrentSpace();
  const seq = ++searchSeq;
  const q = ($("search-input") as HTMLInputElement).value.trim();
  const box = $("search-results");
  if (!q) {
    box.innerHTML = `<p class="muted empty">${t("panes.searchPrompt")}</p>`;
    return;
  }
  box.innerHTML = `<p class="muted empty">${t("panes.searching")}</p>`;
  try {
    const hits = await searchNotes(space, q);
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    box.innerHTML = hits.length
      ? hits
          .map(
            (h) => `<article class="card" data-hit="${esc(h.id)}" data-hit-status="${esc(h.status)}"><div class="body">
              <p class="content">${contentHtml(h.content, false)}</p>
              <footer><span class="pill">${SEARCH_STATUS_LABEL[h.status] ?? esc(h.status)}</span>
                <time>${esc(fmtWhen(h.created_at))}</time>
                ${h.topics.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</footer>
            </div></article>`,
          )
          .join("")
      : `<p class="muted empty">${t("panes.searchNoHit", { q: esc(q) })}</p>`;
  } catch (err) {
    if (space !== getCurrentSpace() || seq !== searchSeq) return;
    box.innerHTML = `<p class="empty warn-ink">${t("panes.searchFailed", { error: esc(String(err)) })}</p>`;
  }
}

/** 搜到了要到得了(ui-audit P1 #8):活跃条目回时间轴定位闪卡(focusCard 自带
 *  「已不在时间轴」响亮提示),回收站/归档册命中切对应面现读。 */
function onSearchClick(e: Event) {
  const card = (e.target as HTMLElement).closest<HTMLElement>("[data-hit]");
  if (!card) return;
  const status = card.dataset.hitStatus as SearchStatus;
  if (status === "archived") deps.showPane("trash");
  else if (status === "sealed") deps.showPane("sealed");
  else deps.focusCard(card.dataset.hit!);
}

export function focusSearch() {
  ($("search-input") as HTMLInputElement).focus();
}

/** 切空间后清空各面的陈旧内容(面会随 pane 关闭,重开时现读)。 */
export function resetPanesForSpaceChange() {
  trashSeq++;
  sealedSeq++;
  searchSeq++;
  trashRows = [];
  trashOpenId = null;
  sealedRows = [];
  sealedOpenId = null;
  clearConfirm();
  $("trash-list").innerHTML = "";
  $("sealed-list").innerHTML = "";
  $("search-results").innerHTML = "";
  ($("search-input") as HTMLInputElement).value = "";
}

export function initPanes(d: Deps) {
  deps = d;
  $("trash-pane").addEventListener("click", onTrashClick);
  $("sealed-pane").addEventListener("click", onSealedClick);
  $("search-results").addEventListener("click", onSearchClick);
  $("search-btn").addEventListener("click", () => void runSearch());
  $("search-input").addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).isComposing) return; // IME 组合期的 Enter 是上屏,不是搜索
    if ((e as KeyboardEvent).key === "Enter") void runSearch();
  });
}
