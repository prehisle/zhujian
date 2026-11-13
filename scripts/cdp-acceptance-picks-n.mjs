// 应用评审取舍题(用户逐条拍板的那四条)手机 N 组的真机回归网。
// 驱动形(要重载页面、要真点折叠钮;CDP 摆前置、读状态、量几何)。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-picks-n.mjs                    # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//   node scripts/cdp-acceptance-picks-n.mjs --shots <目录>      # 关键几拍各截一张真屏
//   PICKSN_KNIFE=css node scripts/cdp-acceptance-picks-n.mjs   # 阴性对照:页内把三处 CSS 修法改坏,对应那几格应当红
//     (R2 图标撤掉遮罩 = 一块实心方块 / R2 图标撑大 = 角标长高 / N4 折叠钮的 44 触区抹平)
//
// 逐条(编号同 .zjshots/901-fix/mob-n.md):
//  R1  空的清单项在提交那一刻摘掉:①记一笔「记下」:`- [ ] ` / 缩进的 `- [x]   ` / `- [X]` 三种空项都摘,
//      `- [x]abc`(不是待办项)、裸 `- `(普通列表)、有字的项、空行一个字不动;②只有空项 = 没写字:不建条目、出原有那句、
//      框里的字原样留着;③本来就带空项的旧随记:打开没改点「取消」= 一笔不写(正文与历史条数都不变),点「保存」= 摘掉且
//      历史多一版;④编辑成只剩空项点「保存」= 出原有那句「内容不能为空」、层不收、库里不变;⑤卡片(任务)编辑同样摘;
//      ⑥**不该发生的那半**:点方框打勾(0039 那条路)不经过这里 —— 同一条里的空项原样留着。
//  R2  截止角标的日历是遮罩画的线条图标:`::before` 没有字(不再是表情)、挂着 svg 遮罩、底色 = 角标自己的字色(明暗两档、
//      今天 / 逾期 / 未来 / 已完成四种各核)、角标高度与「同一枚去掉图标」逐像素相同、图标上下不出角标。
//  N3  搜索没结果:「没有找到「{q}」。换个词,或者少打几个字试试。」;有多个空间(判法 = 顶栏空间徽章显不显)再接
//      「这里只搜当前空间,别的空间要切过去再搜。」。英文档逐字核、两句之间恰一个空格。
//  N4  设置面长说明折叠:五节(语言 / 压缩大图 / 截止提醒 / 本机别名 / 备份)各一只「说明」,默认收着;常显的第一句 + 折叠里的
//      几句 = 改之前那一整段(一个字没丢);折叠钮可点高度 ≥ 44、真触摸点得开也收得回;英文档钮上是 Details。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文、竖屏、没开任何面。
// 会写库:只写**默认空间**(main)—— 几条随记 + 四张卡,正文带 `PICKSN` 记号,收尾 archive → purge 清掉并自证零残留。
//   ⚠ 起跑时人在别的空间就切到 main 跑,跑完**切回起跑时那个空间**、中文档、主题与起跑时相同。
// 诚实边界:
//  ① R1 是 JS 行为,页内下不了刀 ⇒ 它的阴性对照 = 在**修之前的包**上跑这支(①③④⑤ 红),见 progress-log 同号条目;
//  ② N3「只有一个空间时不接第二句」这台测试机造不出(它有两个空间,⛔ 不为验收删空间)⇒ 只核「第二句在不在」与
//     「徽章显不显」同真同假;单空间那一形靠代码同一个判据(`spacesCache.length > 1`)推出;
//  ③ R2 只核到 computed 与几何,「线条画得好不好看」靠 --shots 的图;老引擎(MuMu / Chrome 110)没量;
//  ④ N4 最大字号档、横屏只截图不断言(截图另跑,见 progress-log 同号条目)。
// @cdp-run driver
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync } from "node:fs";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const argv = process.argv.slice(2);
const SHOTS = argv.includes("--shots") ? argv[argv.indexOf("--shots") + 1] : null;
const KNIFE = process.env.PICKSN_KNIFE === "css";
const M = "PICKSN";
const KNIFE_CSS = [
  ".chip.due.today::before,.chip.due.overdue::before{-webkit-mask:none !important;mask:none !important}",
  ".chip.due.future::before{width:1.9em !important;height:1.9em !important}",
  ":is(#settings-pane,.set-page) details.notes > summary{min-height:0 !important;line-height:1.2 !important}", // 906:折叠分住在设置首页与它的二级页里
].join("\n");

// 改之前那几段说明的全文(N4「一个字没丢」的字据;⛔ 这里是历史原文,不随字典改)。
const OLD = {
  lang: "界面语言。「自动」跟随系统;改档后本页会重新载入。只影响这台设备,不同步到别的设备。",
  compress:
    "默认关:按原图保存,截图里的字清清楚楚。打开后,加图前会把大照片缩小并转成 JPEG,省同步流量和空间,但画质有损、原图找不回来;长截图不会被压成窄条。已存的图不受影响。只影响这台设备。",
  alias: "给这台设备起个名字(如「娟娟的手机」)。它会同步给这个空间里的其他设备,让他们看到条目是谁记的。每个空间分别起;留空 = 不起名。",
  remindHead: "只有朱简开在屏幕上时才会响:切到别的应用、锁了屏、或者被关掉,到点都不会响(回到朱简时今天还没报过,就补报一次)。每天到点用一条系统通知报逾期、今天到期与 ",
  remindTail: " 天内到期的卡片数,和看板页上那枚到期钮说的一样;只在有逾期或今天到期时才响,每天至多一条。只数当前空间。开关与时刻只属于这台设备,不同步到别的设备。",
  backup: [
    "这台设备上能做备份,但不能从备份还原。真出事时把 .zjbak 文件拿到电脑上的朱简里恢复。",
    "备份码保存在这台设备上(明文),卸载或清除数据会把它抹掉,抄下来的那份就是唯一的了;已经放进文件夹的备份文件不会跟着没。",
    "「有效」只有验过才算。文件名和扩展名证明不了任何事。",
    "点「备份」会把这台设备上的每个空间各备一份。这台设备上没有自动备份:想备份就回这里点一次。",
    "备份文件加上备份码,就能打开里面的全部内容;开过同步的空间,还能拿它读写这个账户。两样都当秘密保管。",
  ],
};

const out = { pass: false, knife: KNIFE, steps: [] };
const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: typeof detail === "string" ? detail : JSON.stringify(detail) });
    console.error(`${ok === "skip" ? "SKIP" : ok ? "ok  " : "RED "} ${name}`);
    return !!ok;
  };
  let s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
  /** 页面重载后那条连接可能换了:失败一次就重连再来。 */
  const evalJs = async (expression) => {
    for (let i = 0; ; i++) {
      try {
        return await s.evaluate(expression);
      } catch (e) {
        if (i >= 2 || /页面内抛了/.test(String(e?.message))) throw e;
        await sleep(800);
        try {
          s.close();
        } catch {
          /* 旧连接已断 */
        }
        s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
      }
    }
  };
  const J = (v) => JSON.stringify(v);
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      const v = await evalJs(expr).catch(() => false);
      if (v) return v;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  const inv = (cmd, args = {}) => evalJs(`window.__TAURI_INTERNALS__.invoke(${J(cmd)}, Object.assign({spaceId: "main"}, ${J(args)}))`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring","with-act","notice","neutral");return 1})()`);
  const bar = () => evalJs(`(()=>{const e=document.getElementById("error");return {hidden:e.hidden,text:e.textContent}})()`);
  const click = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return false;e.click();return true})()`);
  const dropIme = async () => {
    if (await evalJs(`document.documentElement.classList.contains("kb-up")`)) {
      await adb(["shell", "input", "keyevent", "111"]); // ESCAPE:只收键盘,不走返回键那条「退一层」
      await until(`!document.documentElement.classList.contains("kb-up")`, 3000);
    }
  };
  const closePanes = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await click(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
  };
  const mode = async (m) => {
    await closePanes();
    if (!(await evalJs(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`))) {
      await click(`#bottombar [data-mode="${m}"]`);
      await until(`document.querySelector('#bottombar [data-mode="${m}"]').classList.contains("active")`, 3000);
    }
  };
  const dpr = await evalJs(`devicePixelRatio`);
  /** 滚完连读两拍 top,相同了才取坐标(696:量到中途那一帧就是陈坐标)。 */
  const settle = async (sel) => {
    let t0 = null;
    for (let i = 0; i < 20; i++) {
      const t = await evalJs(`(()=>{const e=document.querySelector(${J(sel)});return e?e.getBoundingClientRect().top:null})()`);
      if (t === t0) return;
      t0 = t;
      await sleep(150);
    }
  };
  const tapEl = async (sel) => {
    await settle(sel);
    const r = await evalJs(`(()=>{const e=document.querySelector(${J(sel)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.left+Math.min(r.width/2,40),y:r.top+r.height/2}})()`);
    if (!r) return false;
    await adb(["shell", "input", "tap", String(Math.round(r.x * dpr)), String(Math.round(r.y * dpr))]);
    return true;
  };
  const snap = async (name) => {
    if (!SHOTS) return;
    await sleep(350);
    const { stdout } = await execFileAsync("adb", ["exec-out", "screencap", "-p"], { encoding: "buffer", maxBuffer: 1 << 26 });
    writeFileSync(`${SHOTS}/${name}.png`, stdout);
  };
  /** 重载并等时间轴画出来;`set` = 重载前写进 localStorage 的几项。重载后把刀补回去(页内注入的样式一载就没)。 */
  const reload = async (set = {}) => {
    await evalJs(`(()=>{const o=${J(set)};for(const k in o)localStorage.setItem(k,o[k]);location.reload();return 1})()`).catch(() => 1);
    await sleep(1500);
    await until(`document.readyState==="complete"&&!!document.getElementById("gate")&&document.getElementById("gate").hidden`, 15000);
    await sleep(1200);
    if (KNIFE) await evalJs(`(()=>{const st=document.createElement("style");st.id="picksn-knife";st.textContent=${J(KNIFE_CSS)};document.head.append(st);return 1})()`);
  };
  const toSpace = async (id) => {
    await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(id)}}).then(()=>1)`);
    await reload({ "zhujian.last-space": id });
  };
  const row = async (id) => (await inv("list_timeline")).find((x) => x.id === id);
  const revs = async (id) => (await inv("list_revisions", { id, before: null })).total;
  /** 开某张卡的操作面板并进编辑层(「编辑」可能在第一排,也可能在「更多」里)。 */
  const openEdit = async (id) => {
    const card = `#timeline [data-id="${id}"]`;
    await evalJs(`(()=>{const c=document.querySelector(${J(card)});c.scrollIntoView({block:"center"});return 1})()`);
    await settle(card);
    if (!(await evalJs(`!!document.querySelector(${J(`${card} .panel`)})`))) await click(`${card} .body`);
    await until(`!!document.querySelector(${J(`${card} .panel [data-pact]`)})`, 3000);
    if (!(await evalJs(`!!document.querySelector(${J(`${card} .panel [data-pact="edit"]`)})`))) {
      await click(`${card} .panel [data-pact="more"]`);
      await until(`!!document.querySelector(${J(`${card} .panel [data-pact="edit"]`)})`, 3000);
    }
    await click(`${card} .panel [data-pact="edit"]`);
    return until(`!document.getElementById("edit-scrim").hidden`, 3000);
  };
  const setEdit = (text) => evalJs(`(()=>{const t=document.getElementById("edit-text");t.value=${J(text)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
  const editClosed = () => until(`document.getElementById("edit-scrim").hidden`, 4000);
  const closePanel = async (id) => {
    const card = `#timeline [data-id="${id}"]`;
    if (await evalJs(`!!document.querySelector(${J(`${card} .panel`)})`)) await click(`${card} .body`);
    await sleep(250);
  };

  const made = { notes: [], tasks: [] };
  const spaces = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
  const startSpace = spaces.find((x) => x.current)?.id;
  const startTheme = await evalJs(`document.documentElement.dataset.theme`);
  try {
    if (!step("前置:界面语言是中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return;
    if (startSpace !== "main") await toSpace("main");
    else if (KNIFE) await reload();
    await clearBar();

    // ── R1 ① 记一笔:空项摘掉,别的一个字不动 ────────────────────────────────────
    await mode("ideas");
    await evalJs(`(()=>{window.scrollTo(0,0);return 1})()`);
    const compose = async (text) => {
      if (!(await evalJs(`document.getElementById("compose-card").classList.contains("open")`))) await click("#capture-fab");
      await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
      await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(text)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await click("#save");
    };
    const typed = [`${M}-清单`, "- [ ] 牛奶", "- [ ] ", "  - [x]   ", "- [X]", "- [x]abc", "- ", "", "- [x] 鸡蛋", "尾巴"].join("\n");
    const want = [`${M}-清单`, "- [ ] 牛奶", "- [x]abc", "- ", "", "- [x] 鸡蛋", "尾巴"].join("\n");
    await snapCompose();
    async function snapCompose() {
      if (!SHOTS) return;
      await click("#capture-fab");
      await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
      await evalJs(`(()=>{const t=document.getElementById("text");t.value=${J(typed)};t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await snap("R1-compose-typed");
    }
    await compose(typed);
    const idA = await until(`window.__TAURI_INTERNALS__.invoke("list_timeline",{spaceId:"main"}).then(l=>(l.find(x=>x.content.startsWith(${J(`${M}-清单`)}))||{}).id||false)`, 5000);
    if (idA) made.notes.push(idA);
    const a = idA ? await row(idA) : null;
    step("R1 ① 记下:三种空项都摘了,其余一个字不动", !!a && a.content === want, a && a.content);
    await until(`!!document.querySelector('#timeline [data-id="${idA}"]')`, 4000);
    const boxes = await evalJs(`(()=>{const c=document.querySelector('#timeline [data-id="${idA}"]');return c?[...c.querySelectorAll(".ckline .cktext")].map(x=>x.textContent):null})()`);
    step("R1 ① 卡上没有空着的方框", !!boxes && boxes.length === 2 && boxes.every((x) => x.trim() !== ""), boxes);
    await snap("R1-compose-saved");
    await clearBar();

    // ── R1 ② 只有空项 = 没写字 ─────────────────────────────────────────────────
    const n0 = (await inv("list_timeline")).length;
    await compose("- [ ] \n  - [x] ");
    await sleep(900);
    const b = await bar();
    const left = await evalJs(`document.getElementById("text").value`);
    step("R1 ② 只有空项:出原有那句「还没写字,写点什么再记下」", !b.hidden && b.text.includes("还没写字,写点什么再记下"), b);
    step("R1 ② 没建条目、框里的字原样留着", (await inv("list_timeline")).length === n0 && left === "- [ ] \n  - [x] ", { left });
    await evalJs(`(()=>{const t=document.getElementById("text");t.value="";t.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    await clearBar();
    await dropIme();
    await evalJs(`(()=>{const sc=document.getElementById("capture-scrim");if(sc&&!sc.hidden)sc.click();return 1})()`);
    await sleep(300);
    if (await evalJs(`document.getElementById("compose-card").classList.contains("open")`)) {
      await adb(["shell", "input", "keyevent", "4"]);
      await until(`!document.getElementById("compose-card").classList.contains("open")`, 3000);
    }

    // ── R1 ③④⑥ 旧随记(后端直接种,带空项)──────────────────────────────────────
    const oldText = `${M}-旧\n- [ ] \n- [ ] 留`;
    const idOld = await inv("capture_idea", { content: oldText });
    made.notes.push(idOld);
    const tickText = `${M}-勾\n- [ ] \n- [ ] 甲`;
    const idTick = await inv("capture_idea", { content: tickText });
    made.notes.push(idTick);
    // R2 的四张卡一并种(同一趟重载)
    const day = (d) => evalJs(`(()=>{const x=new Date();x.setDate(x.getDate()+(${d}));return x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0")})()`);
    const mk = async (title, d) => {
      const id = await inv("create_task", { title, dueOn: await day(d), priority: null, topicId: null });
      made.tasks.push(id);
      return id;
    };
    const tasks = { today: await mk(`${M}-卡今天`, 0), overdue: await mk(`${M}-卡逾期`, -3), future: await mk(`${M}-卡未来`, 10), done: await mk(`${M}-卡完成`, -1) };
    await inv("complete_task", { id: tasks.done });
    await reload();
    await mode("ideas");
    step("R1 前置:种下的旧随记带着空项(后端照收,空项只在前端提交时摘)", (await row(idOld))?.content === oldText);

    const rev0 = await revs(idOld);
    step("R1 ③ 开编辑层", !!(await openEdit(idOld)));
    await click("#edit-cancel");
    await editClosed();
    await sleep(500);
    step("R1 ③ 打开没改点「取消」= 一笔不写", (await row(idOld))?.content === oldText && (await revs(idOld)) === rev0, { rev0, now: await revs(idOld) });
    await openEdit(idOld);
    await snap("R1-edit-old-with-empty");
    await click("#edit-save");
    await editClosed();
    await until(`window.__TAURI_INTERNALS__.invoke("list_timeline",{spaceId:"main"}).then(l=>(l.find(x=>x.id===${J(idOld)})||{}).content!==${J(oldText)})`, 4000);
    const o2 = await row(idOld);
    step("R1 ③ 点「保存」= 空项摘掉", o2?.content === `${M}-旧\n- [ ] 留`, o2?.content);
    step("R1 ③ 这是一次正常编辑:历史多一版", (await revs(idOld)) === rev0 + 1, { rev0, now: await revs(idOld) });
    await clearBar();

    await sleep(400);
    await openEdit(idOld);
    await setEdit("- [ ] \n- [x] ");
    await click("#edit-save");
    await sleep(900);
    const e4 = await bar();
    step("R1 ④ 改成只剩空项点「保存」:出原有那句「内容不能为空」、层不收", !e4.hidden && e4.text.includes("内容不能为空") && !(await evalJs(`document.getElementById("edit-scrim").hidden`)), e4);
    step("R1 ④ 库里不变", (await row(idOld))?.content === `${M}-旧\n- [ ] 留` && (await revs(idOld)) === rev0 + 1);
    await clearBar();
    await click("#edit-cancel");
    if (await until(`!document.getElementById("confirmbar").hidden`, 2000)) await click("#confirmbar-yes");
    await editClosed();
    await closePanel(idOld);

    // ⑥ 打勾那条路不经过这里
    await evalJs(`(()=>{const c=document.querySelector('#timeline [data-id="${idTick}"]');c.scrollIntoView({block:"center"});return 1})()`);
    await settle(`#timeline [data-id="${idTick}"]`);
    await click(`#timeline [data-id="${idTick}"] .ckbox[data-ck="2"]`);
    await until(`window.__TAURI_INTERNALS__.invoke("list_timeline",{spaceId:"main"}).then(l=>(l.find(x=>x.id===${J(idTick)})||{}).content!==${J(tickText)})`, 4000);
    step("R1 ⑥ 点方框打勾:只翻那一格,同一条里的空项原样留着(那条路不摘)", (await row(idTick))?.content === `${M}-勾\n- [ ] \n- [x] 甲`, (await row(idTick))?.content);
    await sleep(600);

    // ── R2 截止角标的图标 + R1 ⑤ 卡片编辑 ───────────────────────────────────────
    await mode("tasks");
    await sleep(500);
    const chipSel = (id) => `#timeline [data-id="${id}"] .chip.due`;
    const seen = await evalJs(`(()=>${J(Object.values(tasks))}.map(id=>!!document.querySelector('#timeline [data-id="'+id+'"] .chip.due')))()`);
    if (step("R2 前置:四张种子卡都在这块看板上、各带截止角标", seen.every(Boolean), seen)) {
      const probe = (id) =>
        evalJs(`(()=>{const c=document.querySelector(${J(chipSel(id))});c.scrollIntoView({block:"center",inline:"center"});
          const b=getComputedStyle(c,"::before"),cs=getComputedStyle(c);
          const twin=c.cloneNode(true);twin.classList.remove("due");twin.style.cssText="";c.after(twin);
          // 孪生要沿用这枚角标的字重 / 边框(.today / .overdue 的规则挂在 .due 上),只差那枚图标
          for(const p of ["fontWeight","border","background","color"])twin.style[p]=cs[p];
          const h=c.getBoundingClientRect().height,h2=twin.getBoundingClientRect().height;twin.remove();
          return {cls:c.className,content:b.content,mask:(b.webkitMaskImage||b.maskImage||"").slice(0,24),bg:b.backgroundColor,color:cs.color,w:parseFloat(b.width),bh:parseFloat(b.height),
            fs:parseFloat(cs.fontSize),h,h2,text:c.textContent,cardDone:!!c.closest(".card.done")}})()`);
      const judge = (tag, p, wantCls) => {
        step(`R2 ${tag}:是那一种角标`, wantCls(p), p.cls);
        step(`R2 ${tag}:图标没有字(不再是表情)、角标文字里也没有`, p.content === '""' && !p.text.includes("📅"), p);
        step(`R2 ${tag}:挂着 svg 遮罩(没有它就是一块实心方块)`, p.mask.startsWith('url("data:image/svg'), p.mask);
        step(`R2 ${tag}:图标颜色 = 角标的字色`, p.bg === p.color, { bg: p.bg, color: p.color });
        step(`R2 ${tag}:图标约 0.95em 见方`, Math.abs(p.w - 0.95 * p.fs) < 0.6 && Math.abs(p.bh - 0.95 * p.fs) < 0.6, { w: p.w, h: p.bh, fs: p.fs });
        step(`R2 ${tag}:角标高度与「去掉图标的同一枚」相同(图标没把它撑高)`, Math.abs(p.h - p.h2) <= 0.5, { h: p.h, twin: p.h2 });
      };
      const light = {};
      for (const [k, id] of Object.entries(tasks)) light[k] = await probe(id);
      judge("今天", light.today, (p) => /\btoday\b/.test(p.cls));
      judge("逾期", light.overdue, (p) => /\boverdue\b/.test(p.cls));
      judge("未来", light.future, (p) => /\bfuture\b/.test(p.cls));
      judge("已完成", light.done, (p) => p.cardDone);
      step("R2 四种角标的字色不全相同(否则「颜色跟着字」这一格是空测)", new Set(Object.values(light).map((p) => p.color)).size >= 3, Object.values(light).map((p) => p.color));
      await evalJs(`(()=>{document.querySelector(${J(chipSel(tasks.overdue))}).scrollIntoView({block:"center",inline:"center"});return 1})()`);
      await snap(`R2-chips-${startTheme}`);
      // 另一档主题(只在页内翻 <html data-theme>,不写盘;收尾翻回)
      const otherTheme = startTheme === "dark" ? "light" : "dark";
      await evalJs(`(()=>{document.documentElement.dataset.theme=${J(otherTheme)};return 1})()`);
      await sleep(300);
      for (const [k, id] of Object.entries(tasks)) {
        const p = await probe(id);
        step(`R2 ${otherTheme} 档 ${k}:图标颜色 = 字色、遮罩在`, p.bg === p.color && p.mask.startsWith('url("data:image/svg') && p.color !== undefined, { bg: p.bg, color: p.color });
      }
      await evalJs(`(()=>{document.querySelector(${J(chipSel(tasks.overdue))}).scrollIntoView({block:"center",inline:"center"});return 1})()`);
      await snap(`R2-chips-${otherTheme}`);
      await evalJs(`(()=>{document.documentElement.dataset.theme=${J(startTheme)};return 1})()`);

      // R1 ⑤ 卡片编辑
      const t0 = (await inv("list_tasks")).find((x) => x.id === tasks.future);
      step("R1 ⑤ 开卡片的编辑层", !!(await openEdit(tasks.future)));
      await setEdit(`${M}-卡未来\n- [ ] \n- [ ] 子项`);
      await click("#edit-save");
      await editClosed();
      await until(`window.__TAURI_INTERNALS__.invoke("list_tasks",{spaceId:"main"}).then(l=>(l.find(x=>x.id===${J(tasks.future)})||{}).title!==${J(t0?.title)})`, 4000);
      const t1 = (await inv("list_tasks")).find((x) => x.id === tasks.future);
      step("R1 ⑤ 卡片编辑保存:空项摘掉", (t1?.title ?? t1?.content) === `${M}-卡未来\n- [ ] 子项`, t1 && (t1.title ?? t1.content));
      await clearBar();
      await closePanel(tasks.future);
    }

    // ── N3 搜索没结果 ──────────────────────────────────────────────────────────
    const search = async (q) => {
      await closePanes();
      await click("#search-toggle");
      await until(`!document.getElementById("search-pane").hidden`, 3000);
      await evalJs(`(()=>{const i=document.getElementById("search-input");i.value=${J(q)};i.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
      await until(`(()=>{const p=document.querySelector("#search-results .empty");return !!p&&p.textContent.includes(${J(q)})})()`, 6000);
      return evalJs(`(()=>{const p=document.querySelector("#search-results .empty");return {text:p?p.textContent:null,other:!!document.querySelector("#search-results .search-other-spaces"),chipShown:!document.getElementById("space-chip").hidden}})()`);
    };
    const Q = "zzqq无此词picksn";
    const multi = (await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`)).length > 1;
    const n3 = await search(Q);
    const zh1 = `没有找到「${Q}」。换个词,或者少打几个字试试。`;
    const zh2 = "这里只搜当前空间,别的空间要切过去再搜。";
    step("N3 没结果那句逐字(中文)", n3.text === (multi ? zh1 + zh2 : zh1), n3);
    step("N3 第二句在不在 = 顶栏空间徽章显不显 = 是不是有多个空间", n3.other === n3.chipShown && n3.other === multi, { ...n3, multi });
    await dropIme();
    await snap("N3-search-empty-zh");
    await closePanes();

    // ── N4 设置面的折叠 ────────────────────────────────────────────────────────
    const openSettings = async () => {
      await closePanes();
      await click("#settings-toggle");
      await until(`!document.getElementById("settings-pane").hidden`, 3000);
      await sleep(500);
    };
    // 906:设置的重节各住进了自己的二级页(.set-page)⇒ 五只折叠不在同一页上:语言那只在首页,压缩大图 / 截止提醒 / 本机别名 / 备份
    // 各在它那一页。文档序没变(首页在前、二级页按原来的节序排)⇒ 下标照旧 0–4;要量几何 / 真点的那只,先从首页那一行进它那一页。
    const SET = ":is(#settings-pane,.set-page)";
    await openSettings();
    const pages = await evalJs(`(()=>[...document.querySelectorAll(${J(`${SET} details.notes`)})].filter(d=>!d.hidden).map((d,i)=>{d.dataset.n4=String(i);return d.closest("section").id}))()`);
    const sumSel = (i) => `details.notes[data-n4="${i}"] > summary`;
    const goFold = async (i) => {
      if (await evalJs(`document.getElementById(${J(pages[i])}).hidden`)) {
        await openSettings();
        if (pages[i] !== "settings-pane") {
          await click(`#settings-pane [data-set-page="${pages[i]}"]`);
          await until(`!document.getElementById(${J(pages[i])}).hidden`, 3000);
          await sleep(400);
        }
      }
      await evalJs(`(()=>{document.querySelector(${J(sumSel(i))}).scrollIntoView({block:"center"});return 1})()`);
      await settle(sumSel(i));
    };
    const folds = [];
    const spans = [];
    for (let i = 0; i < pages.length; i++) {
      await goFold(i);
      folds.push(
        await evalJs(`(()=>{const d=document.querySelector(${J(sumSel(i))}).parentElement;return {open:d.open,sum:d.querySelector("summary").textContent,shown:d.getClientRects().length>0,
          body:[...d.querySelectorAll("p")].map(p=>p.textContent),bodyH:d.getBoundingClientRect().height-d.querySelector("summary").getBoundingClientRect().height}})()`),
      );
      // 触区:逐点探(0.5 步长)
      spans.push(
        await evalJs(`(()=>{const e=document.querySelector(${J(sumSel(i))});const r=e.getBoundingClientRect();const x=r.left+20;let lo=null,hi=null;
          for(let y=r.top-30;y<=r.bottom+30;y+=0.5){if(document.elementFromPoint(x,y)===e){if(lo===null)lo=y;hi=y}}return lo===null?0:hi-lo+0.5})()`),
      );
    }
    step("N4 五节各一只折叠,钮上都是「说明」", folds.length === 5 && folds.every((f) => f.sum === "说明" && f.shown), folds.map((f) => f.sum));
    // ⚠ 收着的 details 里,段落自己的 rect 仍有高度(新引擎用 content-visibility 藏)⇒ 量的是「整只折叠比那枚钮高出多少」
    step("N4 默认都收着(整只折叠只有那枚钮那么高)", folds.every((f) => !f.open && Math.abs(f.bodyH) < 1), folds.map((f) => [f.open, f.bodyH]));
    const txt = (sel) => evalJs(`(()=>{const e=document.querySelector(${J(sel)});return e?e.textContent:null})()`);
    const langSub = await txt(`#settings-pane [data-i18n="settings.langSub"]`);
    const compSub = await txt(`#set-compress [data-i18n="settings.compressSub"]`);
    const aliasSub = await txt(`#set-alias [data-i18n="shell.aliasSub"]`);
    const remSub = await txt("#remind-sub"); // 进过「截止提醒」那一页之后才有字(上面那一圈进过了)
    const remMore = await txt("#remind-more");
    step("N4 语言:常显那句 + 折叠里的 = 原来那一整段", langSub + folds[0].body.join("") === OLD.lang, [langSub, folds[0].body]);
    step("N4 压缩大图:同上", compSub + folds[1].body.join("") === OLD.compress, [compSub, folds[1].body]);
    const rem = `${remSub}${remMore}`;
    step("N4 截止提醒:同上(中间那个天数由常数注入)", rem.startsWith(OLD.remindHead) && rem.endsWith(OLD.remindTail) && /^\d+$/.test(rem.slice(OLD.remindHead.length, rem.length - OLD.remindTail.length)), rem);
    step("N4 本机别名:同上", aliasSub + folds[3].body.join("") === OLD.alias, [aliasSub, folds[3].body]);
    const restore = await txt(`#set-backup [data-i18n="backup.footRestore"]`);
    step("N4 备份:第一段常显、另四段在折叠里,五段一字不差", restore === OLD.backup[0] && J(folds[4].body) === J(OLD.backup.slice(1)), [restore, folds[4].body]);
    step("N4 常显的第一句都以句号收尾(自己读得通)", [langSub, compSub, aliasSub, remSub, restore].every((x) => /。$/.test(x)), [langSub, compSub, aliasSub, remSub]);
    step("N4 五枚折叠钮可点高度都 ≥ 44", spans.length === 5 && spans.every((x) => x >= 43.5), spans);

    // 真触摸点开 / 收回
    const s2 = sumSel(1); // 压缩大图那只(折叠里的字最多)
    await goFold(1);
    await snap("N4-settings-folded");
    let opened = false;
    for (let i = 0; i < 3 && !opened; i++) {
      await tapEl(s2);
      opened = !!(await until(`document.querySelector(${J(s2)}).parentElement.open`, 1500));
    }
    const vis = await evalJs(`(()=>{const d=document.querySelector(${J(s2)}).parentElement;const p=d.querySelector("p");return {h:d.getBoundingClientRect().height-d.querySelector("summary").getBoundingClientRect().height,text:p.textContent}})()`);
    step("N4 真触摸点「说明」= 展开,里面那几句读得到", opened && vis.h > 20 && vis.text === OLD.compress.slice(compSub.length), vis);
    await snap("N4-settings-open");
    let shut = false;
    for (let i = 0; i < 3 && !shut; i++) {
      await tapEl(s2);
      shut = !!(await until(`!document.querySelector(${J(s2)}).parentElement.open`, 1500));
    }
    step("N4 再点一下 = 收回", shut);
    await closePanes();

    // ── 英文档:N3 逐字 + N4 钮上的词 ────────────────────────────────────────────
    await reload({ "zhujian.lang": "en" });
    if (step("英文档已生效", (await evalJs(`document.documentElement.lang`)) === "en")) {
      const e3 = await search(Q);
      const en1 = `Nothing found for “${Q}”. Try another word, or a shorter one.`;
      const en2 = "Only the current space is searched; switch spaces to search the others.";
      step("N3 没结果那句逐字(英文;两句之间恰一个空格)", e3.text === (multi ? `${en1} ${en2}` : en1), e3);
      await dropIme();
      await snap("N3-search-empty-en");
      await openSettings();
      const en = await evalJs(`(()=>[...document.querySelectorAll(":is(#settings-pane,.set-page) details.notes")].filter(d=>!d.hidden).map(d=>d.querySelector("summary").textContent))()`);
      step("N4 英文档折叠钮上是 Details", en.length === 5 && en.every((x) => x === "Details"), en);
      const cjk = await evalJs(`(()=>[...document.querySelectorAll(":is(#settings-pane,.set-page) details.notes p, :is(#settings-pane,.set-page) .fine")].map(p=>p.textContent).filter(x=>/[\\u4e00-\\u9fff]/.test(x)))()`);
      step("N4 英文档的说明里没有中文", cjk.length === 0, cjk);
      await evalJs(`(()=>{document.querySelector("#lang-seg").scrollIntoView({block:"start"});return 1})()`);
      await snap("N4-settings-en");
      await closePanes();
    }
  } catch (e) {
    step("没抛异常", false, String(e?.stack ?? e));
  } finally {
    // 收尾:回中文、清种子(随记 archive_note → purge_note,卡 archive_task → purge_task)、回起跑时那个空间
    try {
      await evalJs(`(()=>{document.documentElement.dataset.theme=${J(startTheme)};localStorage.setItem("zhujian.lang","zh");localStorage.removeItem("zhujian.compose-draft");return 1})()`);
      const sp = await evalJs(`window.__TAURI_INTERNALS__.invoke("list_spaces")`);
      if (sp.find((x) => x.current)?.id !== "main") await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:"main"}).then(()=>1)`);
      const has = (x) => String(x.content ?? x.title ?? "").includes(M);
      const noteIds = new Set([...made.notes, ...(await inv("list_timeline")).filter((x) => has(x) && !made.tasks.includes(x.id)).map((x) => x.id)]);
      const taskIds = new Set([...made.tasks, ...(await inv("list_tasks")).filter(has).map((x) => x.id)]);
      for (const id of taskIds) noteIds.delete(id);
      for (const id of noteIds) for (const c of ["archive_note", "purge_note"]) await inv(c, { id }).catch(() => null);
      for (const id of taskIds) for (const c of ["archive_task", "purge_task"]) await inv(c, { id }).catch(() => null);
      const left = {
        timeline: (await inv("list_timeline")).filter(has).length,
        tasks: (await inv("list_tasks")).filter(has).length,
        trash: (await inv("list_trash")).filter(has).length,
      };
      step("清场:时间轴 / 看板 / 回收站都没有种子", left.timeline + left.tasks + left.trash === 0, left);
      if (startSpace && startSpace !== "main") {
        await evalJs(`window.__TAURI_INTERNALS__.invoke("activate_space",{spaceId:${J(startSpace)}}).then(()=>1)`);
        await evalJs(`(()=>{localStorage.setItem("zhujian.last-space",${J(startSpace)});return 1})()`);
      }
      await evalJs(`(()=>{location.reload();return 1})()`).catch(() => 1);
      await sleep(2500);
      step("收尾:中文档、回到起跑时那个空间", await until(`document.documentElement.lang==="zh"&&document.getElementById("gate").hidden`, 10000));
    } catch (e) {
      step("收尾没抛异常", false, String(e?.stack ?? e));
    }
    try {
      s.close();
    } catch {
      /* 连接已断 */
    }
  }
};

main()
  .catch((e) => {
    out.steps.push({ name: "驱动没崩", ok: false, detail: String(e?.stack ?? e) });
  })
  .finally(() => {
    out.pass = out.steps.length > 0 && out.steps.every((x) => x.ok === true || x.ok === "SKIPPED");
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.pass ? 0 : 1);
  });
