// 「导出为 Markdown」(用户面 136)的文案分片:设置面那一节 + 导出文件里的标题、文件名与行内记号。
// ⚠ 文件名 / 目录名也住这里(随界面语言走);它们要过 core::export_md 的路径检查 ——
// ⛔ 别往里写 `/ \ : * ? " < > |`,也别以空格或点结尾。
import { defineMessages } from "./entry";

export const exporting = defineMessages({
  "export.title": { zh: "导出为 Markdown", en: "Export as Markdown" },
  "export.sub": { zh: "当前空间的全部随记与看板,连同配图和留言,写成 Markdown 放进「下载」文件夹。不含回收站与编辑历史。", en: "Every note and card in this space, with images and comments, as Markdown in your Downloads folder. Trash and edit history are left out." },
  "export.run": { zh: "导出", en: "Export" },
  "export.running": { zh: "导出中…", en: "Exporting…" },
  "export.done": { zh: "已导出到 {path}", en: "Exported to {path}" },
  "export.folder": { zh: "朱简导出 {stamp}", en: "Zhujian export {stamp}" },
  "export.notesFile": { zh: "随记.md", en: "Notes.md" },
  "export.boardFile": { zh: "看板.md", en: "Board.md" },
  "export.imgDir": { zh: "图", en: "images" },
  "export.imgName": { zh: "{stamp}-{tail}-图{n}", en: "{stamp}-{tail}-img{n}" },
  "export.imgAlt": { zh: "图{n}", en: "Image {n}" },
  "export.notesHead": { zh: "随记", en: "Notes" },
  "export.boardHead": { zh: "看板", en: "Board" },
  "export.notesMeta": { zh: "空间「{space}」· 导出于 {at} · 共 {n} 条", en: "Space \"{space}\" · exported {at} · {n} {n|note|notes}" },
  "export.boardMeta": { zh: "空间「{space}」· 导出于 {at} · 共 {n} 张卡", en: "Space \"{space}\" · exported {at} · {n} {n|card|cards}" },
  "export.sealed": { zh: "归档", en: "Archive" },
  "export.deletedCol": { zh: "{name}(已删的列)", en: "{name} (deleted column)" },
  "export.due": { zh: "截止 {date}", en: "due {date}" },
  "export.doneAt": { zh: "完成于 {date}", en: "done {date}" },
  "export.comment": { zh: "留言 {at}：", en: "Comment {at}: " },
});
