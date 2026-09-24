// 卡片单键与视图单键的**唯一登记处**(用户面 123)。
//
// 键位此前以字面量散在 inbox / board / topics 三个视图的动作表里,而设置「快捷键」页的
// 速查表要把它们摊给用户看 —— 手抄第二份就是两处各说各的。⇒ 键只在这里写一次:动作表
// 读它派发,速查表读它展示;速查表那边按 `Record<keyof …>` 逐键配文案,这里多一个键而那边
// 没配,tsc 当场红。
//
// ⚠ 卡片键与视图键共享同一个 document 的 keydown(hotkey-menu 的 onKey 与 registerViewKeys),
// 同一视图里两者不许撞 —— 看板卡的「归档」是 A、切归档视图是 G,回收站卡的「还原」是 U 而
// 不是 R(R 是看板的回收站开关),都是为此错开的;改键前先看同视图的另一张表。

/** 随记卡片(想法 tab)。 */
export const IDEA_CARD_KEYS = {
  edit: "E",
  task: "T",
  tag: "L",
  comments: "Y",
  copy: "C",
  copyLink: "K",
  move: "M",
  delete: "D",
} as const;

/** 随记回收站里的卡片。 */
export const IDEA_TRASH_KEYS = { restore: "R", copy: "C", copyLink: "K", deleteForever: "D" } as const;

/** 看板卡片。颜色的 1-7 / 0 数字键跟着 `CARD_COLORS` 的长度走,不在这张表里。 */
export const BOARD_CARD_KEYS = {
  edit: "E",
  copy: "C",
  copyLink: "K",
  tags: "L",
  due: "S",
  priority: "P",
  comments: "Y",
  color: "H",
  toTop: "T",
  toBottom: "F",
  nextCol: "]",
  prevCol: "[",
  seal: "A",
  revert: "B",
  move: "M",
  delete: "D",
} as const;

/** 看板回收站里的卡片(U 而非 R:R 是看板的视图键「回收站开关」)。 */
export const BOARD_TRASH_KEYS = { restore: "U", deleteForever: "D" } as const;

/** 归档册里的卡片(与看板卡「归档」同键 A,一进一出)。 */
export const SEALED_CARD_KEYS = { unseal: "A" } as const;

/** 视图级单键(不用选中卡片)。 */
export const IDEA_VIEW_KEYS = { compose: "N" } as const;
export const BOARD_VIEW_KEYS = { compose: "N", trash: "R", sealed: "G" } as const;
export const TOPICS_VIEW_KEYS = { create: "N", merge: "M" } as const;
