// 编辑历史面板(桌面随记编辑态;longform-plan §4,1b)。
//
// 目录只取元数据(时间 + 字数),点开一版才取那一版的全文 —— ⛔ 别退回「一次取全部正文」
// (旧的 list_note_history:200 版 × 200 KiB 过 IPC 再全建 DOM)。同一时刻至多展开一版,
// 全文缓存就是那一份。只读:⛔ 没有「恢复到这一版」(longform-plan §4 末)。
import { el } from "./dom";
import { errText } from "./err";
import { t } from "./i18n";
import { invoke } from "./space";
import { when } from "./tasktime";
import { toastError } from "./toast";

type RevisionMeta = { revision_id: number; archived_at: string; chars: number };
type RevisionCatalog = { entries: RevisionMeta[]; total: number; has_more: boolean };
type VersionText = { revision_id: number | null; archived_at: string | null; content: string };
type VersionPair = { a: VersionText; b: VersionText };

/** 往 `host` 里挂「历史 N 版」开关与面板;没有历史就什么也不挂。目录读失败照抛,由调用方决定
 *  怎么降级(编辑态里历史是附带的,读不到不该挡编辑)。 */
export async function mountHistory(host: HTMLElement, itemId: string): Promise<void> {
  const first = await invoke<RevisionCatalog>("list_revisions", { id: itemId, before: null });
  if (first.total === 0) return;

  const list = el("div", { className: "hist-list" });
  const more = el("button", { className: "hist-more", textContent: t("inbox.historyMore") });
  const panel = el("div", { className: "hist-panel", hidden: true }, [list, more]);
  // 在途请求的代次:点了别的版本 / 收起之后,旧回包 ⛔ 不许把文字塞回来。
  let seq = 0;
  let open: HTMLElement | null = null; // 展开着的那一行(.hist-item)

  const collapse = (): void => {
    open?.querySelector(".hist-text")?.remove();
    open?.classList.remove("open");
    open = null;
  };

  const addPage = (page: RevisionCatalog): void => {
    for (const r of page.entries) {
      const row = el("div", { className: "hist-item" });
      const head = el("button", { className: "hist-entry" }, [
        el("time", { className: "hist-time", textContent: t("inbox.editedAt", { time: when(r.archived_at) }) }),
        el("span", { className: "hist-chars", textContent: t("inbox.histChars", { n: r.chars }) }),
      ]);
      head.onclick = async () => {
        const mine = ++seq;
        const wasOpen = open === row;
        collapse();
        if (wasOpen) return;
        open = row;
        row.classList.add("open");
        const text = el("p", { className: "hist-text" });
        row.append(text);
        try {
          const pair = await invoke<VersionPair>("revision_texts", { id: itemId, a: { rev: r.revision_id }, b: "current" });
          if (mine === seq) text.textContent = pair.a.content;
        } catch (e) {
          if (mine === seq) text.textContent = errText(e);
        }
      };
      row.append(head);
      list.append(row);
    }
    more.hidden = !page.has_more;
    more.onclick = async () => {
      const before = page.entries[page.entries.length - 1].revision_id;
      more.disabled = true;
      try {
        addPage(await invoke<RevisionCatalog>("list_revisions", { id: itemId, before }));
      } catch (e) {
        // 在途时编辑态已收起(面板脱离文档)就不报 —— 否则旧请求的错会弹到新界面上(codex 1b 一弹 L)
        if (more.isConnected) toastError(errText(e));
      } finally {
        more.disabled = false;
      }
    };
  };
  addPage(first);

  const toggle = el("button", {
    className: "hist-toggle",
    textContent: t("inbox.historyToggle", { n: first.total }),
    onclick: () => {
      panel.hidden = !panel.hidden;
    },
  });
  host.replaceChildren(toggle, panel);
}
