// 展示库(官网改版第 4 格):官网配图、桌面截图基线、手机配图**共用这一份演示数据**。
//
// ⭐ 为什么抽出来:此前桌面那份住在 `ui-shots-desktop.mjs` 里,手机那张是在模拟器上临时手写的
//   另一套(露营清单 / 播客 / 茶叶……),同一页官网上电脑与手机讲的是两个人的笔记本。
//   ⇒ 两边都从这里取;要改演示内容只改这一处。
//
// 三条硬要求(原住 ui-shots-desktop.mjs,搬家不改):①一眼看得出是演示数据(万一图外送也无害,
//   74② 那条「别把自家想法往外传」);②每个视图都有得看;③截止日期按「今天」现算 ⇒
//   「逾期 / 今天 / 将来」三种形长期稳定,而不是养成一屏全逾期。
// ⚠ 两份语言**逐条同形**(四个标签、逾期 / 今天 / 将来三种截止、一张带勾选清单的任务、一条带清单的随记),
//   换的只是字 ⇒ 英文那批图照得出「英文正文换行」的形。加一条就两份一起加。
//
// 形状:
//   topics   [标题, 颜色]
//   inbox    未归类随记,按写入顺序(时间轴上后写的在上)
//   filed    [正文, 标签下标] 已整理随记,写在 inbox 之后
//   featured 最后写的那条带清单的随记 ⇒ 时间轴与「未归类」里都排在最上(手机配图的第一张卡)
//   tasks    [标题, 列, 截止(距今天几天 / null), 优先级, 标签下标];带清单的那张标题里含换行
//   story    只给商店图用的几样(官网配图不写它们):featured 的第一版(再改成 featured ⇒ 留一条历史)、
//            挂在带清单那张任务上的两句留言、三条做完归档了的任务(归档册里有得看)。只有中文:商店图只出中文。
export const SHOWCASE = {
  zh: {
    space: "生活",
    topics: [["家里", "#c0563f"], ["工作", "#3f7a99"], ["读书", "#7f8b3a"], ["身体", "#a8577e"]],
    inbox: ["给妈打电话,问体检结果", "阳台那盆绿萝该换土了", "想写一篇关于纸质笔记本的短文"],
    filed: [["周末把书架第二层整理一遍", 0], ["《长安的荔枝》读完了,想记几句", 2], ["体检报告下周三出,记得去取", 3]],
    featured: "周末露营要带的\n- [x] 帐篷\n- [x] 睡袋\n- [ ] 头灯\n- [ ] 驱蚊液",
    story: {
      // ⛔ 两版差的必须是**正文**(加了一行),不是勾选 —— 纯勾选变更不留历史(0039)
      featuredFirst: "周末露营要带的\n- [x] 帐篷\n- [x] 睡袋\n- [ ] 头灯",
      comments: ["会议在周四上午,材料周三晚上打印就来得及", "常用药记得带那盒胃药"],
      sealed: ["交这个月的物业费", "修好自行车的刹车", "换季衣物收纳"],
    },
    tasks: [
      ["把书房的旧电脑重装一遍", "todo", -2, 1, 0],
      ["交季度报表", "todo", 0, null, 1],
      ["订下个月回老家的票", "todo", 9, null, 0],
      ["读完《长安的荔枝》最后两章", "todo", null, null, 2],
      ["出差要带的东西\n- [x] 身份证\n- [x] 充电器\n- [ ] 会议材料打印\n- [ ] 常用药", "doing", 3, null, 1],
      ["把阳台的花搬到向阳的一侧", "doing", null, null, 0],
      ["等体检中心回电确认时间", "confirming", null, null, 3],
      ["换掉厨房那只坏了的灯泡", "done", null, null, 0],
      ["给同事回邮件", "done", null, null, 1],
    ],
  },
  en: {
    space: "Life",
    topics: [["Home", "#c0563f"], ["Work", "#3f7a99"], ["Reading", "#7f8b3a"], ["Health", "#a8577e"]],
    inbox: ["Call Mum, ask how the check-up went", "The pothos on the balcony needs repotting", "Write a short piece about paper notebooks"],
    filed: [["Tidy the second bookshelf this weekend", 0], ["Finished The Remains of the Day, want to jot a few lines", 2], ["Check-up results are out next Wednesday, pick them up", 3]],
    featured: "Weekend camping list\n- [x] Tent\n- [x] Sleeping bag\n- [ ] Head torch\n- [ ] Bug spray",
    tasks: [
      ["Reinstall the old computer in the study", "todo", -2, 1, 0],
      ["Send the quarterly report", "todo", 0, null, 1],
      ["Book train tickets home for next month", "todo", 9, null, 0],
      ["Finish the last two chapters of The Remains of the Day", "todo", null, null, 2],
      ["Packing for the work trip\n- [x] ID card\n- [x] Charger\n- [ ] Print the meeting notes\n- [ ] Everyday meds", "doing", 3, null, 1],
      ["Move the balcony plants to the sunny side", "doing", null, null, 0],
      ["Wait for the clinic to call back with a time", "confirming", null, null, 3],
      ["Replace the broken kitchen bulb", "done", null, null, 0],
      ["Reply to a colleague's email", "done", null, null, 1],
    ],
  },
};

/**
 * 页面内播种脚本(一段 async IIFE 的源码,交给 CDP `Runtime.evaluate`)。桌面与手机两端的命令名、
 * 入参形同名同形(都带 spaceId),差别只在写随记那条:桌面 `capture_note`、手机 `capture_idea`。
 * ⛔ 写入顺序就是时间轴顺序,别为了「好读」重排。
 */
export function seedScript(lang, { spaceId, captureCmd, story = false }) {
  const D = SHOWCASE[lang];
  if (!D) throw new Error(`展示库只有 zh / en:${lang}`);
  if (story && !D.story) throw new Error(`展示库的 story 只有中文那份:${lang}`);
  return `(async () => {
  const D = ${JSON.stringify(D)};
  const inv = (c, a) => window.__TAURI__.core.invoke(c, Object.assign({ spaceId: ${JSON.stringify(spaceId)} }, a));
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };

  const topicIds = [];
  for (const [title, color] of D.topics) {
    const id = await inv("create_topic", { title });
    topicIds.push(id);
    await inv("set_topic_color", { id, color });
  }

  // 随记:三条未归类 + 三条已整理(整理过的挂标签,列表里两段都有得看)+ 最后那条带清单的
  for (const c of D.inbox) await inv(${JSON.stringify(captureCmd)}, { content: c });
  for (const [c, t] of D.filed) {
    const id = await inv(${JSON.stringify(captureCmd)}, { content: c });
    await inv("file_note_to_topic", { id, topicId: topicIds[t], newTitle: null });
  }
  const story = ${JSON.stringify(story)};
  const featuredId = await inv(${JSON.stringify(captureCmd)}, { content: story ? D.story.featuredFirst : D.featured });
  if (story) await inv("edit_note", { id: featuredId, content: D.featured });

  // 商店那几条归档的先建先收:它们是「以前做完的」,不该排在看板上那几张前面
  if (story) {
    for (const title of D.story.sealed) {
      const id = await inv("create_task", { title, dueOn: null, priority: null, topicId: null });
      await inv("update_task_status", { id, to: "done" });
      await inv("seal_task", { id });
    }
  }

  // 任务:四列都有;三条截止各占一种形(逾期 / 今天 / 将来);一条带勾选清单
  const taskIds = [];
  for (const [title, col, due, prio, t] of D.tasks) {
    // 带清单的那张先按首行建、再改名成整段(清单行不走 create_task)
    const id = await inv("create_task", { title: title.split("\\n")[0], dueOn: due === null ? null : day(due), priority: prio, topicId: topicIds[t] });
    if (col !== "todo") await inv("update_task_status", { id, to: col });
    if (title.includes("\\n")) await inv("rename_task", { id, title });
    taskIds.push(id);
  }
  // 留言挂在带清单的那张任务上
  const listTask = taskIds[D.tasks.findIndex(([title]) => title.includes("\\n"))];
  if (story) for (const content of D.story.comments) await inv("add_item_comment", { itemId: listTask, content });

  return {
    featuredId,
    listTask,
    topics: topicIds.length,
    notes: D.inbox.length + D.filed.length + 1,
    tasks: D.tasks.length,
  };
})()`;
}
