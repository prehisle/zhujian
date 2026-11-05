// 卡片单键与视图单键的**唯一登记处**(用户面 123)。
//
// 键位此前以字面量散在 inbox / board / topics 三个视图的动作表里,而设置「快捷键」页的
// 速查表要把它们摊给用户看 —— 手抄第二份就是两处各说各的。⇒ 键只在这里写一次:动作表
// 读它派发,速查表读它展示;速查表那边按 `Record<keyof …>` 逐键配文案,这里多一个键而那边
// 没配,tsc 当场红。
//
// ⚠ 卡片键与视图键共享同一个 document 的 keydown(hotkey-menu 的 onKey 与 registerViewKeys),
// 同一视图里两者原则上不撞 —— 看板卡的「归档」是 A、切归档视图是 G,是为此错开的;改键前先看同视图的
// 另一张表。**唯一一处刻意撞的**:看板回收站卡的「还原」与看板视图键「回收站开关」同为 R(W3 159 / Q12,
// WD-36:两个回收站都认 R 还原)。撞了不两义靠的是**卡片键先接**:悬停 / 选中一张卡时卡片键 preventDefault,
// `registerViewKeys` 见到已被接住的键就让位;指针不在卡上时 R 照旧是开关。

/** 随记卡片(想法 tab)。 */
export const IDEA_CARD_KEYS = {
  edit: "E",
  history: "H",
  task: "T",
  tag: "L",
  comments: "Y",
  copy: "C",
  copyLink: "K",
  move: "M",
  expand: "W",
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
  /** 历史(158 G4-A8;只在改过的卡上出)。随记 / 长文的历史是 H,可看板的 H 早给了颜色 ⇒ V(Version)。 */
  history: "V",
  toTop: "T",
  toBottom: "F",
  nextCol: "]",
  prevCol: "[",
  seal: "A",
  revert: "B",
  move: "M",
  delete: "D",
} as const;

/** 看板回收站里的卡片。还原与随记回收站同为 R(159 起;此前是 U)—— 与视图键 R 的让位见文件头。 */
export const BOARD_TRASH_KEYS = { restore: "R", deleteForever: "D" } as const;

/** 归档册里的卡片(与看板卡「归档」同键 A,一进一出)。 */
export const SEALED_CARD_KEYS = { unseal: "A", history: "V" } as const;

/** 长文(列表卡与阅读页共用一张表;列表卡上没有历史 / 留言两项)。「收回随记」与随记卡的
 *  「展开成长文」同键 W,一进一出(同看板卡「归档」与归档册「取出」同键 A)。 */
export const DOC_CARD_KEYS = {
  open: "O",
  edit: "E",
  history: "H",
  tag: "L",
  comments: "Y",
  collapse: "W",
  copy: "C",
  copyLink: "K",
  move: "M",
  delete: "D",
} as const;

/** 视图级单键(不用选中卡片)。 */
export const IDEA_VIEW_KEYS = { compose: "N" } as const;
export const BOARD_VIEW_KEYS = { compose: "N", trash: "R", sealed: "G" } as const;
export const TOPICS_VIEW_KEYS = { create: "N", merge: "M" } as const;
export const DOC_VIEW_KEYS = { compose: "N" } as const;
