// 随记 / 看板的 Markdown 写法 —— **一种格式,两个出口**(用户面 136):
// - 「复制随记」(676,inbox.ts 顶栏):当前筛出的那批、纯文字、进剪贴板 —— 只用 `ideasMarkdown(items)`;
// - 「导出为 Markdown」(设置 · 备份与恢复那页):当前空间全量、带配图与留言、落成文件夹 —— `exportMarkdown()`。
// ⛔ 别为导出另写第二套随记排法(648 那条「别造第二种导出机制」放宽成的边界就是这个):导出只在
// 同一条 bullet 下面**追加**图片与留言两块,正文那几行与复制出来的一字不差。
//
// 随记:一天一节 `## YYYY-MM-DD`(绝对日期 —— 屏上「今天 / 昨天」那种相对字拿出去就腐);一条随记
// 一个 bullet:首行 = 时刻 + 标签(`#标签`),正文从下一行起**原样**、每行缩进两格(Markdown
// 列表的续行;正文里自带的 `- [ ]` 清单于是成了子列表,语义正好)。⛔ 不压成一行 —— 随记是正文
// 不是标题,看板的「复制看板」压一行是因为那是一句话的清单;导出里的任务同样保留全文。
//
// 导出的范围与形状(用户 2026-09-26 拍「都按推荐」):当前空间;随记 + 看板全部列 + 归档(成就);
// 回收站与编辑历史不出;配图写进子目录、用相对路径链接;留言按时间正序、引用块。
// 落盘(临时目录写完再改名、路径校验、图片字节不过前端)在 core::export_md 与 lib.rs::export_markdown。
import { t } from "./i18n";
import { currentSpaceId, invokeInSpace, listSpaces, spaceLabel } from "./space";
import { PRIORITY_LABEL, type TaskItem } from "./tasktime";
import { type BoardColumn, DONE_COLUMN, columnName } from "./board-columns";
import type { ImageMeta } from "./item-images";
import type { Comment, CommentPage } from "./item-comments";

/** 排 Markdown 只需要的那几个字段(随记的 IdeaItem 是它的超集)。 */
export type MdIdea = { id: string; content: string; created_at: string; topics: { title: string }[] };

const hm = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const p2 = (n: number) => String(n).padStart(2, "0");

function isoDay(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
function dayTime(iso: string): string {
  return `${isoDay(iso)} ${hm.format(new Date(iso))}`;
}
/** 每行缩两格(列表续行);空行保持空,别造出只有空格的行。 */
function indent(text: string): string[] {
  return text.split("\n").map((l) => (l === "" ? "" : `  ${l}`));
}
function tagText(topics: { title: string }[]): string {
  return topics.map((tp) => `#${tp.title}`).join(" ");
}

/** 一条随记。`extra` = 挂在同一条 bullet 下面的附加行(导出时的图片 / 留言;复制时没有)。 */
function ideaMarkdown(i: MdIdea, extra: string[] = []): string {
  const tags = tagText(i.topics);
  const head = `- ${hm.format(new Date(i.created_at))}${tags ? " " + tags : ""}`;
  return [head, ...indent(i.content), ...extra].join("\n");
}

/** 一批随记(按传入顺序,即屏上的时间倒序),同一天归一节。 */
export function ideasMarkdown(items: MdIdea[], extras?: Map<string, string[]>): string {
  const days: { day: string; notes: string[] }[] = [];
  for (const i of items) {
    const day = isoDay(i.created_at);
    const md = ideaMarkdown(i, extras?.get(i.id));
    const last = days[days.length - 1];
    if (last && last.day === day) last.notes.push(md);
    else days.push({ day, notes: [md] });
  }
  return days.map((d) => [`## ${d.day}`, ...d.notes].join("\n")).join("\n\n");
}

// ---- 导出(全量 + 配图 + 留言)-----------------------------------------------

/** 一张卡:勾不勾看它在不在「完成」列(归档里的一律勾上);首行 = 标题 + 截止 / 优先级 / 完成日 /
 *  标签,正文第二行起照随记的续行规矩原样缩进。 */
function taskMarkdown(it: TaskItem, done: boolean, sealed: boolean, extra: string[]): string {
  const [first, ...rest] = it.title.split("\n");
  const meta: string[] = [];
  if (it.due_on) meta.push(t("export.due", { date: it.due_on }));
  if (it.priority !== null) meta.push(PRIORITY_LABEL[it.priority]);
  const doneAt = it.done_at ?? (sealed ? it.sealed_at : null);
  if (done && doneAt) meta.push(t("export.doneAt", { date: isoDay(doneAt) }));
  const tags = tagText(it.topics);
  if (tags) meta.push(tags);
  const head = `- [${done ? "x" : " "}] ${first}${meta.length > 0 ? " · " + meta.join(" · ") : ""}`;
  return [head, ...(rest.length > 0 ? indent(rest.join("\n")) : []), ...extra].join("\n");
}

/** 列按看板的顺序(core 已排好);只出**有卡**的任务列。已删的列还扣着卡时照出、名字后注明。
 *  ⛔ 一张卡的列在列表里找不到 = 数据不一致,整趟报错(别把它悄悄漏掉 —— 导出漏卡没人发现得了)。 */
function boardMarkdown(cols: BoardColumn[], tasks: TaskItem[], sealed: TaskItem[], extras: Map<string, string[]>): string {
  const taskCols = cols.filter((c) => c.kind === "task");
  const known = new Set(taskCols.map((c) => c.id));
  const stray = tasks.find((it) => !known.has(it.status));
  if (stray) throw new Error(`task ${stray.id} sits in unknown column ${stray.status}`);
  const sections: string[] = [];
  for (const c of taskCols) {
    const inCol = tasks.filter((it) => it.status === c.id);
    if (inCol.length === 0) continue;
    const name = c.deleted ? t("export.deletedCol", { name: columnName(c) }) : columnName(c);
    const done = c.id === DONE_COLUMN;
    sections.push([`## ${name}`, ...inCol.map((it) => taskMarkdown(it, done, false, extras.get(it.id) ?? []))].join("\n"));
  }
  if (sealed.length > 0) {
    sections.push([`## ${t("export.sealed")}`, ...sealed.map((it) => taskMarkdown(it, true, true, extras.get(it.id) ?? []))].join("\n"));
  }
  return sections.join("\n\n");
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

function stampOf(d: Date): string {
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
}

/** 一个条目的留言,全部页拉齐后按时间正序(列表接口是最近优先)。 */
async function allComments(space: string, itemId: string): Promise<Comment[]> {
  const out: Comment[] = [];
  let cursor: [string, string] | null = null;
  for (;;) {
    const page: CommentPage = await invokeInSpace<CommentPage>(space, "list_item_comments", { itemId, cursor });
    out.push(...page.rows);
    if (!page.has_more) break;
    cursor = page.next_cursor;
  }
  return out.reverse();
}

type ExportImage = { image_id: string; rel: string };

/**
 * 导出当前空间,返回写出的文件夹路径。整趟每一次调用都钉在**点下那刻**的空间上
 * (`invokeInSpace`)—— 中途切了空间也不会把两个空间的东西拼进同一份。
 */
export async function exportMarkdown(): Promise<string> {
  const space = currentSpaceId();
  const [ideas, tasks, sealed, cols, images, counts, spaces] = await Promise.all([
    invokeInSpace<MdIdea[]>(space, "list_ideas"),
    invokeInSpace<TaskItem[]>(space, "list_tasks"),
    invokeInSpace<TaskItem[]>(space, "list_sealed_tasks"),
    invokeInSpace<BoardColumn[]>(space, "list_board_columns"),
    invokeInSpace<Record<string, ImageMeta[]>>(space, "list_all_item_images"),
    invokeInSpace<Record<string, { n: number }>>(space, "item_comment_counts"),
    listSpaces(),
  ]);
  const info = spaces.find((s) => s.id === space);
  if (!info) throw new Error(`current space ${space} is not in the space list`);
  const spaceName = spaceLabel(info);

  const imgDir = t("export.imgDir");
  const files: ExportImage[] = [];
  const extras = new Map<string, string[]>();
  const all: { id: string; created_at: string }[] = [...ideas, ...tasks, ...sealed];
  for (const it of all) {
    const lines: string[] = [];
    const stamp = stampOf(new Date(it.created_at));
    for (const m of images[it.id] ?? []) {
      const ext = EXT[m.mime];
      if (!ext) throw new Error(`image ${m.id} has unexpected mime ${m.mime}`);
      const rel = `${imgDir}/${t("export.imgName", { stamp, tail: it.id.slice(-6), n: m.seq })}.${ext}`;
      files.push({ image_id: m.id, rel });
      lines.push(`  ![${t("export.imgAlt", { n: m.seq })}](${rel})`);
    }
    if ((counts[it.id]?.n ?? 0) > 0) {
      for (const c of await allComments(space, it.id)) {
        const [cFirst, ...cRest] = c.content.split("\n");
        lines.push("", `  > ${t("export.comment", { at: dayTime(c.created_at) })}${cFirst}`, ...cRest.map((l) => `  > ${l}`));
      }
    }
    // 附加块与正文之间空一行:否则图片行会被当成正文最后一段的续行(正文以清单结尾时尤甚)。
    if (lines.length > 0) extras.set(it.id, lines[0] === "" ? lines : ["", ...lines]);
  }

  const at = dayTime(new Date().toISOString());
  const notesMd = [
    `# ${t("export.notesHead")}`,
    t("export.notesMeta", { space: spaceName, at, n: ideas.length }),
    "",
    ideasMarkdown(ideas, extras),
  ].join("\n");
  const boardMd = [
    `# ${t("export.boardHead")}`,
    t("export.boardMeta", { space: spaceName, at, n: tasks.length + sealed.length }),
    "",
    boardMarkdown(cols, tasks, sealed, extras),
  ].join("\n");

  const now = new Date();
  const folder = t("export.folder", { stamp: `${isoDay(now.toISOString())} ${p2(now.getHours())}${p2(now.getMinutes())}` });
  return invokeInSpace<string>(space, "export_markdown", {
    folder,
    docs: [
      { rel: t("export.notesFile"), text: notesMd.trimEnd() + "\n" },
      { rel: t("export.boardFile"), text: boardMd.trimEnd() + "\n" },
    ],
    images: files,
  });
}
