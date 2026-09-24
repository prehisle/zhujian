// 设置「快捷键」页下半的只读速查表(用户面 123):卡片单键、视图键、编辑时的键,此前界面里
// 只有卡片 ⋯ 菜单那一处看得到(还得先知道要去悬停)。
//
// ⭐ 键位不在这里写:单键全部读 keymap.ts(视图派发读的也是那一份)。每张表是
// `Record<keyof 那张键表, 文案>`,键表多一个动作而这里没配文案 = tsc 红。
// 回收站 / 归档里的卡片刻意不摊:那几枚键只在那两处视图里有效、且各视图不同(还原是 R / U),
// 摊在一张表上反而读不明白 —— 表尾一句「选中后按 / 看它自己的键」指过去。
// 编辑时那几枚(Enter / Shift+Enter / Ctrl+L / Tab / Ctrl+V / 双击)不是动作表里的动作,
// 各自住在监听里(checklist-input / item-images / 两个视图的编辑态),这里是唯一一处列举;
// 改那些监听时回来对一眼。
import { t } from "./i18n";
import { CARD_COLORS } from "./card-color";
import {
  BOARD_CARD_KEYS,
  BOARD_VIEW_KEYS,
  IDEA_CARD_KEYS,
  IDEA_VIEW_KEYS,
  TOPICS_VIEW_KEYS,
} from "./keymap";

type Row = [keys: string, label: string];

function rowsOf<K extends string>(keys: Record<K, string>, labels: Record<K, string>): Row[] {
  return (Object.keys(keys) as K[]).map((k) => [keys[k], labels[k]]);
}

export function buildKeySheet(isMac: boolean): HTMLElement {
  const mod = isMac ? "Cmd+" : "Ctrl+";

  const ideaCard = rowsOf(IDEA_CARD_KEYS, {
    edit: t("inbox.actEdit"),
    task: t("settings.keysToTask"),
    tag: t("inbox.actTag"),
    comments: t("inbox.actComments"),
    copy: t("inbox.actCopy"),
    copyLink: t("inbox.actCopyLink"),
    move: t("settings.keysMoveSpace"),
    delete: t("inbox.actDelete"),
  });

  const boardCard = rowsOf(BOARD_CARD_KEYS, {
    edit: t("board.edit"),
    copy: t("board.copy"),
    copyLink: t("board.copyLink"),
    tags: t("board.tags"),
    due: t("board.due"),
    priority: t("board.priority"),
    comments: t("board.comments"),
    color: t("board.color"),
    toTop: t("board.moveToTop"),
    toBottom: t("board.moveToBottom"),
    nextCol: t("settings.keysNextCol"),
    prevCol: t("settings.keysPrevCol"),
    seal: t("settings.keysSeal"),
    revert: t("settings.keysRevert"),
    move: t("settings.keysMoveSpace"),
    delete: t("board.delete"),
  });
  boardCard.push([`1–${CARD_COLORS.length} / 0`, t("settings.keysColorDigits")]);

  const views: Row[] = [
    ...rowsOf(IDEA_VIEW_KEYS, { compose: t("settings.keysIdeaCompose") }),
    ...rowsOf(BOARD_VIEW_KEYS, {
      compose: t("settings.keysBoardCompose"),
      trash: t("settings.keysBoardTrash"),
      sealed: t("settings.keysBoardSealed"),
    }),
    ...rowsOf(TOPICS_VIEW_KEYS, {
      create: t("settings.keysTopicCreate"),
      merge: t("settings.keysTopicMerge"),
    }),
  ];

  const pick: Row[] = [
    ["↑ / ↓", t("settings.keysArrows")],
    ["/", t("settings.keysSlash")],
    [t("settings.keysDblclickKey"), t("inbox.actEdit")],
  ];

  const editing: Row[] = [
    ["Enter", t("settings.keysEnter")],
    ["Shift+Enter", t("settings.keysShiftEnter")],
    ["Esc", t("settings.keysEsc")],
    [`${mod}L`, t("settings.keysChecklist")],
    ["Tab / Shift+Tab", t("settings.keysIndent")],
    [`${mod}V`, t("settings.keysPaste")],
  ];

  const box = document.createElement("div");
  box.className = "keysheet";
  const title = document.createElement("h2");
  title.className = "settings-title settings-sect";
  title.textContent = t("settings.keysTitle");
  const intro = document.createElement("p");
  intro.className = "settings-sub";
  intro.textContent = t("settings.keysIntro");
  box.append(title, intro);
  for (const [head, rows] of [
    [t("settings.keysGroupPick"), pick],
    [t("settings.keysGroupIdea"), ideaCard],
    [t("settings.keysGroupBoard"), boardCard],
    [t("settings.keysGroupView"), views],
    [t("settings.keysGroupEdit"), editing],
  ] as const) {
    const h = document.createElement("h3");
    h.className = "keysheet-head";
    h.textContent = head;
    const dl = document.createElement("dl");
    dl.className = "keysheet-list";
    for (const [keys, label] of rows) {
      const dt = document.createElement("dt");
      const kbd = document.createElement("kbd");
      kbd.textContent = keys;
      dt.append(kbd);
      const dd = document.createElement("dd");
      dd.textContent = label;
      dl.append(dt, dd);
    }
    box.append(h, dl);
  }
  const foot = document.createElement("p");
  foot.className = "settings-foot";
  foot.textContent = t("settings.keysFoot");
  box.append(foot);
  return box;
}
