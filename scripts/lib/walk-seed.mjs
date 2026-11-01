// 走查种子(ux-walk-plan W1a):全应用体验走查专用的合成数据,桌面隔离实例与安卓测试机共用。
//
// ⛔ 别把它并进 `showcase.mjs`:那份喂官网配图与商店图,形要「好看」且长期稳定;本份要的是**边角与量**
//   (长标题 / 长标签 / 多行 / 宽图长图 / 删过的图 / 改过几版的 / 回收站里的 / 逾期今天将来),
//   会随每趟走查加形,一改那边就要整批重拍。
// 三条硬要求:①一眼看得出是演示数据(截图里 ⛔ 不许出现真人信息,153 拍到用户相册那件别再犯);
//   ②每趟走查要的触发态都种得出;③截止按「今天」现算。
// ⚠ 播种只能写「此刻」⇒ 时间轴上全是今天。要「昨天 / 上周」的分组,驱动方在播完后按返回值里的
//   `backdate`(id → 往前挪几天)自己挪(桌面:关掉实例后改库;手机:没有 run-as,做不到 —— 记成边界)。
//
// 形与 showcase 一样:返回一段 async IIFE 源码交给 CDP `Runtime.evaluate`;两端命令同名同形(都带 spaceId),
// 差别只在写随记那条:桌面 `capture_note`、手机 `capture_idea`。⛔ 写入顺序就是时间轴顺序。

const LONG_PARA =
  "这是一段故意写得很长的演示随记,用来看时间轴上的卡片怎么折叠、展开以后滚动顺不顺。" +
  "它没有任何真实内容,只是把同一类句子重复几遍:今天试了新的咖啡豆,酸度偏高,下次磨粗一点;" +
  "楼下的桂花开了,路过时闻到一阵;想起来要把旧手机里的照片导出来,但一直没动手。\n" +
  "第二段从这里开始。演示数据的第二段同样没有意义,只为了让卡片超过折叠阈值。" +
  "再写几句:周三下午的会可能要改时间;冰箱里的牛奶周五到期;阳台的晾衣杆有点松。\n\n" +
  "隔了一个空行的第三段。最后一句:演示数据到此为止。";

export const WALK = {
  zh: {
    topics: [
      ["家里", "#c0563f"], ["工作", "#3f7a99"], ["读书", "#7f8b3a"], ["身体", "#a8577e"],
      ["旅行计划", "#b07d2b"], ["钱", null],
      ["一个特别特别长的标签名字用来看折行和截断会怎样", "#5b6f8a"],
    ],
    // 未归类随记;前面的写得早(时间轴上在下)。[正文, 往前挪几天]
    inbox: [
      ["演示:想把书桌换个方向,靠窗那边光线好一点", 9],
      ["演示:周末去看那个摄影展", 8],
      ["演示:买菜\n- [x] 西红柿\n- [ ] 鸡蛋\n- [ ] 葱\n- [x] 豆腐", 7],
      ["演示:全勾完的清单\n- [x] 交水费\n- [x] 交电费\n- [x] 交燃气费", 7],
      [LONG_PARA, 6],
      ["演示:一行很长的链接 https://example.com/a/very/long/path/that/keeps/going/and/going/without/any/break/to/see/how/it/wraps?query=1&more=2", 5],
      ["演示:一长串不带空格的字母数字ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 5],
      ["   演示:前面有三个空格,中间有空行\n\n\n后面也有两个空格  ", 4],
      ["演示:带 emoji 的一条 🍎🍊🍋 还有 ✅ 和 ⭐", 3],
      ["Demo: an English note with some longer words to see wrapping behaviour", 3],
      ["123", 2],
      ["演示:提醒自己下周二之前回邮件", 1],
      ["演示:灵感 —— 做一个只记三件事的晨间清单", 1],
      ["演示:路上想到的,用纸箱给猫做个窝", 0],
      ["演示:今天第二条,随手一记", 0],
      ["演示:今天第三条,看连记几条的节奏", 0],
    ],
    // 已整理随记 [正文, [标签下标…], 往前挪几天]
    filed: [
      ["演示:书架第二层整理一遍", [0], 12],
      ["演示:《某本书》读完了,记三句\n1. 第一句\n2. 第二句\n3. 第三句", [2], 11],
      ["演示:体检报告周三出,去取", [3], 10],
      ["演示:年假想去海边,先查机票", [4, 5], 9],
      ["演示:这个月的固定开销列一下\n- [ ] 房租\n- [ ] 网费\n- [x] 话费", [5, 0], 6],
      ["演示:挂了那个超长标签的一条", [6], 4],
      ["演示:三个标签的一条", [1, 2, 4], 2],
    ],
    // 改过几版的(编辑必留历史):[第一版, [后续版本…]]
    edited: [
      ["演示:周会议程 v1", ["演示:周会议程 v2\n- 进度", "演示:周会议程 v3\n- 进度\n- 风险", "演示:周会议程 v4\n- 进度\n- 风险\n- 下周计划"]],
    ],
    // 带图的随记 [正文, [图形…], 删掉第几张(1 起,null = 不删)]
    // 图形 = [宽, 高, 颜色];图上写着「第几张 + 宽×高」,截图里一眼认得出
    imaged: [
      ["演示:一张方图", [[600, 600, "#c0563f"]], null],
      ["演示:长图、宽图、方图各一张", [[400, 1400, "#3f7a99"], [1600, 400, "#7f8b3a"], [800, 600, "#b07d2b"]], null],
      ["演示:九张图", Array.from({ length: 9 }, (_, i) => [600, 600, ["#c0563f", "#3f7a99", "#7f8b3a", "#a8577e", "#b07d2b", "#5b6f8a", "#6b8e5a", "#8a5b6f", "#4f7f7f"][i]]), null],
      ["演示:三张图删掉了第二张(图2 不该被复用)", [[600, 600, "#a8577e"], [600, 600, "#5b6f8a"], [600, 600, "#6b8e5a"]], 2],
      ["演示:手机照片那种大图", [[4000, 3000, "#4f7f7f"]], null],
    ],
    // 带留言的随记 [正文, [留言…]]
    commented: [
      ["演示:要不要换个路由器", ["演示留言:先看看信号是不是墙的问题", "演示留言:旧的用了五年了", "演示留言:那就换吧"]],
    ],
    // 进回收站的随记
    trashed: ["演示:写错了的一条(已删)", "演示:重复的一条(已删)", "演示:不要了的清单\n- [ ] 一\n- [ ] 二"],
    // 转成待办的随记 [正文, 待办标题]
    promoted: [["演示:修一下门把手,有点松", "修门把手"], ["演示:给家里的绿萝换土", "绿萝换土"]],
    // 任务 [标题, 列, 截止(距今天几天 / null), 优先级, [标签下标…]]
    tasks: [
      ["演示:交季度报表", "todo", -3, 1, [1]],
      ["演示:续签租房合同", "todo", -1, 2, [0, 5]],
      ["演示:今天截止的一张", "todo", 0, 1, [1]],
      ["演示:下周的牙医预约", "todo", 7, null, [3]],
      ["演示:一张标题特别特别长的任务,用来看看看板卡片上会折成几行、操作面又会怎么摆", "todo", null, 3, [6]],
      ["演示:搬家打包\n- [x] 书\n- [ ] 衣服\n- [ ] 厨房\n- [ ] 杂物", "doing", 2, 2, [0]],
      ["演示:写周报", "doing", 1, null, [1]],
      ["演示:查一下保险条款", "doing", null, null, []],
      ["演示:等对方回复报价", "confirming", 3, null, [1, 5]],
      ["演示:等快递签收", "confirming", null, null, []],
      ["演示:已做完的一张", "done", null, null, [0]],
      ["演示:也做完了", "done", -2, 3, [2]],
    ],
    // 做完并收进成就归档的(以前做完的,先建先收)
    sealed: ["演示:去年做完的一件事", "演示:上个月做完的一件事", "演示:上周做完的一件事"],
    // W2 加:把「待办」撑满的一批(列满 / 海量;建得早,排在上面那几张的后头)
    bulkTodo: Array.from({ length: 30 }, (_, i) => "演示:批量任务 " + String(i + 1).padStart(2, "0")),
    // W2 加:一列空着的自定义列(只在桌面建 —— 列管理只有桌面有;测试机不同步,看不到它)
    customColumns: ["演示:等材料"],
    // W3 加:标签量(斜杠层级、英文、没人用的、一串编号的)。[名字, 颜色 / null]
    topicsW3: [
      ["工作/汇报", "#3f7a99"], ["工作/周会", null], ["Work", null], ["没人用的标签", "#6b8e5a"],
      ...Array.from({ length: 12 }, (_, i) => ["演示标签 " + String(i + 1).padStart(2, "0"), i % 3 ? null : "#8a5b6f"]),
    ],
    // W3 加:搜索的量。九句轮着写 90 条,第 i 条往前挪 i 天(桌面);每五条挂一个「工作」
    searchPhrases: [
      "报销了一张发票", "咖啡豆又快喝完了", "会议纪要:下周再议", "Invoice for the printer", "孩子的作业要签字",
      "发票抬头写错了要重开", "跑步五公里", "超市小票留着对账", "读书笔记:第三章",
    ],
    searchBulk: 90,
    // W3 加:关键词只在旧版本里(搜索也搜旧版本)
    editedW3: [["演示:旧版本里写着暗号「青柠」", ["演示:新版本里已经没有那个词了"]]],
    // W3 加:回收站里多几种形 —— 一张任务、一条带图带标签的、一篇长文、一条很长的
    trashedTask: ["演示:删掉的任务(在看板回收站)"],
    trashedImaged: [["演示:带两张图和一个标签的一条(已删)", [[600, 600, "#4f7f7f"], [600, 600, "#b07d2b"]], [0]]],
    trashedDoc: ["# 演示:删掉的一篇长文\n\n第一段。\n\n第二段。"],
    trashedLong: [LONG_PARA],
    // W3 加:第二个空间(只在桌面播 —— 手机一次只开一个空间,第二个空间由记录员在界面上建)
    space2: {
      name: "演示:家庭",
      topics: [["家里", "#c0563f"], ["孩子", "#a8577e"]],
      notes: [["演示(家庭):周六大扫除", [0]], ["演示(家庭):给孩子报游泳课", [1]], ["演示(家庭):买一盏新台灯", []]],
      tasks: ["演示(家庭):交物业费", "演示(家庭):约家长会时间"],
    },
  },
};

/** 第二个空间的播种脚本(W3;只在桌面用:桌面所有空间都开着,能直接写别的空间)。返回 { spaceId }。 */
export function walkSpace2Script(lang) {
  const S = WALK[lang]?.space2;
  if (!S) throw new Error(`走查种子没有 ${lang} 的 space2`);
  return `(async () => {
  const S = ${JSON.stringify(S)};
  const info = await window.__TAURI__.core.invoke("create_space", { name: S.name });
  const inv = (c, a) => window.__TAURI__.core.invoke(c, Object.assign({ spaceId: info.id }, a));
  // capture_note / create_task 只认前台空间(壳侧复核)⇒ 先把前台切过去,播完切回 main
  await inv("set_foreground_space", {});
  const tids = [];
  for (const [title, color] of S.topics) {
    const id = await inv("create_topic", { title });
    tids.push(id);
    if (color) await inv("set_topic_color", { id, color });
  }
  for (const [c, ts] of S.notes) {
    const id = await inv("capture_note", { content: c });
    for (const t of ts) await inv("file_note_to_topic", { id, topicId: tids[t], newTitle: null });
  }
  for (const title of S.tasks) await inv("create_task", { title, dueOn: null, priority: null, topicId: null });
  await window.__TAURI__.core.invoke("set_foreground_space", { spaceId: "main" });
  return { spaceId: info.id };
})()`;
}

/**
 * 页内播种脚本(async IIFE 源码,交给 CDP `Runtime.evaluate`)。
 * 返回 { counts, backdate: [[id, days]…], ids: {…} } —— backdate 交给驱动方去挪时间。
 */
export function walkSeedScript(lang, { spaceId, captureCmd }) {
  const D = WALK[lang];
  if (!D) throw new Error(`走查种子只有 ${Object.keys(WALK).join(" / ")}:${lang}`);
  if (captureCmd !== "capture_note" && captureCmd !== "capture_idea") throw new Error(`captureCmd 只认 capture_note / capture_idea:${captureCmd}`);
  return `(async () => {
  const D = ${JSON.stringify(D)};
  const inv = (c, a) => window.__TAURI__.core.invoke(c, Object.assign({ spaceId: ${JSON.stringify(spaceId)} }, a));
  const cap = (content) => inv(${JSON.stringify(captureCmd)}, { content });
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  const png = (w, h, color, label) => new Promise((ok, bad) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const g = c.getContext("2d");
    g.fillStyle = color; g.fillRect(0, 0, w, h);
    g.strokeStyle = "#fff"; g.lineWidth = Math.max(6, Math.min(w, h) / 40); g.strokeRect(0, 0, w, h);
    g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle";
    const fs = Math.min(w, h) / 3;
    g.font = "bold " + fs + "px sans-serif"; g.fillText(label, w / 2, h / 2 - fs * 0.2);
    g.font = (fs / 4) + "px sans-serif"; g.fillText(w + "×" + h, w / 2, h / 2 + fs * 0.55);
    c.toBlob((b) => {
      if (!b) return bad(new Error("toBlob 返回空"));
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => bad(r.error);
      r.readAsDataURL(b);
    }, "image/png");
  });

  const backdate = [];
  const ids = {};
  const topicIds = [];
  for (const [title, color] of D.topics) {
    const id = await inv("create_topic", { title });
    topicIds.push(id);
    if (color) await inv("set_topic_color", { id, color });
  }
  // W3:多出来的标签(编号接在上面那批后头,别的段不引用它们)
  for (const [title, color] of D.topicsW3) {
    const id = await inv("create_topic", { title });
    if (color) await inv("set_topic_color", { id, color });
  }
  // W3:搜索的量,写得最早(时间轴最底下);每五条挂「工作」(下标 1)
  for (let i = D.searchBulk - 1; i >= 0; i--) {
    const id = await cap("演示:流水 " + String(i + 1).padStart(2, "0") + " " + D.searchPhrases[i % D.searchPhrases.length]);
    if (i % 5 === 0) await inv("file_note_to_topic", { id, topicId: topicIds[1], newTitle: null });
    backdate.push([id, i + 13]);
  }

  // 已整理的写得最早(挪得最远),先写
  for (const [c, ts, days] of D.filed) {
    const id = await cap(c);
    for (const t of ts) await inv("file_note_to_topic", { id, topicId: topicIds[t], newTitle: null });
    backdate.push([id, days]);
  }
  for (const [c, days] of D.inbox.slice(0, -3)) backdate.push([await cap(c), days]);

  ids.edited = [];
  for (const [first, later] of D.edited) {
    const id = await cap(first);
    for (const c of later) await inv("edit_note", { id, content: c });
    ids.edited.push(id);
  }
  ids.imaged = [];
  for (const [c, shapes, del] of D.imaged) {
    const id = await cap(c);
    const metas = [];
    for (let i = 0; i < shapes.length; i++) {
      const [w, h, color] = shapes[i];
      metas.push(await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: await png(w, h, color, String(i + 1)) }));
    }
    if (del !== null) await inv("delete_item_image", { imageId: metas[del - 1].id });
    ids.imaged.push(id);
  }
  ids.commented = [];
  for (const [c, cs] of D.commented) {
    const id = await cap(c);
    for (const content of cs) await inv("add_item_comment", { itemId: id, content });
    ids.commented.push(id);
  }
  for (const c of D.trashed) {
    const id = await cap(c);
    await inv("archive_note", { id });
  }
  // W3:关键词只在旧版本里;回收站多几种形
  for (const [first, later] of D.editedW3) {
    const id = await cap(first);
    for (const c of later) await inv("edit_note", { id, content: c });
    ids.edited.push(id);
  }
  for (const [c, shapes, ts] of D.trashedImaged) {
    const id = await cap(c);
    for (let i = 0; i < shapes.length; i++) {
      const [w, h, color] = shapes[i];
      await inv("add_item_image", { itemId: id, mime: "image/png", dataB64: await png(w, h, color, String(i + 1)) });
    }
    for (const t of ts) await inv("file_note_to_topic", { id, topicId: topicIds[t], newTitle: null });
    await inv("archive_note", { id });
  }
  for (const c of D.trashedDoc) await inv("archive_note", { id: await inv("capture_doc", { content: c }) });
  for (const c of D.trashedLong) await inv("archive_note", { id: await cap(c) });
  for (const title of D.trashedTask) {
    await inv("archive_task", { id: await inv("create_task", { title, dueOn: null, priority: null, topicId: null }) });
  }
  ids.promoted = [];
  for (const [c, title] of D.promoted) {
    const id = await cap(c);
    ids.promoted.push(await inv("promote_note_to_task", { id, title }));
  }

  for (const title of D.sealed) {
    const id = await inv("create_task", { title, dueOn: null, priority: null, topicId: null });
    await inv("update_task_status", { id, to: "done" });
    await inv("seal_task", { id });
  }
  for (const title of D.bulkTodo) await inv("create_task", { title, dueOn: null, priority: null, topicId: null });
  if (${JSON.stringify(captureCmd)} === "capture_note") {
    for (const title of D.customColumns) await inv("create_board_column", { title });
  }
  for (const [title, col, due, prio, ts] of D.tasks) {
    // 带清单的先按首行建、再改名成整段(清单行不走 create_task)
    const id = await inv("create_task", { title: title.split("\\n")[0], dueOn: due === null ? null : day(due), priority: prio, topicId: ts.length ? topicIds[ts[0]] : null });
    for (const t of ts.slice(1)) await inv("add_task_topic", { id, topicId: topicIds[t] });
    if (col !== "todo") await inv("update_task_status", { id, to: col });
    if (title.includes("\\n")) await inv("rename_task", { id, title });
  }

  // 最后三条未归类写在最后:时间轴最上面就是「今天连记的几条」
  for (const [c] of D.inbox.slice(-3)) await cap(c);

  return {
    counts: {
      topics: topicIds.length + D.topicsW3.length,
      notes: D.filed.length + D.inbox.length + D.edited.length + D.imaged.length + D.commented.length + D.searchBulk + D.editedW3.length,
      trashed: D.trashed.length + D.trashedImaged.length + D.trashedDoc.length + D.trashedLong.length,
      trashedTasks: D.trashedTask.length,
      tasks: D.tasks.length + D.promoted.length + D.bulkTodo.length,
      sealed: D.sealed.length,
    },
    ids,
    backdate: backdate.filter(([, d]) => d > 0),
  };
})()`;
}
