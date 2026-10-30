// 手机长文编辑器「加图 / 拍照 / × 删图」验收(backlog 152:820 留下的手机缺口,825 补)。
//
// 判据都读 DOM / 命令回包:
//   已存过的篇:「编辑 / 预览」那排有「＋ 加图 / ＋ 拍照」→ 加两张**当场挂上**(保存之前 list_item_images 就有)、
//     钮与新长出来的缩略图都在底栏上沿之上(矮屏几何格:第一版把它们放在 60vh 正文框底下,360×640 上整排压在底栏后)、
//     拍照那发的 input 带 capture → 预览里「图1」画成芯片(编辑器把配图映射交给了渲染器)→ × 只做标记
//     (库里还在、再点一下撤销)→ 保存后标了的那张没了、阅读页缩略图少一张、它进了回收站(可还原)→
//     再标一张、**关面**(不是保存)⇒ 那张一张不删(同桌面 unmount:删图认的是前台空间)。
//   新篇:加图进暂存条、库里还没有这一篇 → 一个字没写就返回 = 拦住并明说、留在编辑器 → 写字保存 ⇒
//     新篇带着那几张图 → 再新建一篇、加图写字后**直接关面** ⇒ 也带着图落下。
//   取图在飞时按返回 = 拦一句、留在编辑器;放行后照常。
//   ⭐ 长文的暂存图**不进「记一笔」那份 IndexedDB 草稿**:重载后「记一笔」暂存条是空的(阴性对照:把
//     docs.ts 里 composeImages 的第三参改成 true ⇒ ⑩ 红)。
//
// 取图不经系统选择器:页内把 `HTMLInputElement.prototype.click` 换掉,遇到 file input 就塞几张页内现画
// 的 PNG 并发 change(同用户选完回来)。⚠ 诚实边界:系统相册 / 相机那半、取消那条路、降采样的手感
// 都不在本资产里 —— 那些归 `cdp-acceptance-pick-images.mjs`(它的头注第 ⑥ 条)。
//
// ⛔ **会写库**:只动自己种的(题目带「配图验收」的长文);收尾 purge(连图一起销毁,含回收站里那张)。
//    当前空间配过账户就拒跑(`--allow-synced` 放行 —— 墓碑会同步到同账户的其它设备)。
//
// 跑法(MuMu / 真机的 devtools 包;先 `node scripts/android-cdp.mjs forward`):
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs-images.mjs [--shots <目录>]
// 退出码 0 = 全过。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9222);
const SHOTS = arg("--shots");
const ALLOW_SYNCED = argv.includes("--allow-synced");
const MARK = "配图验收";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const s = await openSession((await pageTarget(PORT)).webSocketDebuggerUrl, { timeoutMs: 30000 });
const ev = (js) => s.evaluate(js);
let fails = 0;
const ok = (cond, what, extra) => {
  if (!cond) fails++;
  console.log(`${cond ? "✔" : "✗"} ${what}${extra !== undefined ? "  " + JSON.stringify(extra) : ""}`);
};
async function waitFor(expr, what, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if (await ev(expr)) return true;
    } catch {
      /* 重画 / 重载途中会短暂抛 */
    }
    if (Date.now() - t0 > ms) {
      ok(false, `等「${what}」超过 ${ms}ms`, expr);
      return false;
    }
    await sleep(150);
  }
}
const inv = (cmd, args) => ev(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const clickText = (text) =>
  ev(`(() => { const b = [...document.querySelectorAll("#docs-body button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) return false; b.click(); return true; })()`);
const bar = () => ev(`(() => { const e = document.getElementById("error"); return e.hidden ? null : e.textContent; })()`);
const hideBar = () => ev(`document.getElementById("error").hidden = true`);
const back = () => ev(`window.__zhujianHandleBack()`);
const inEditor = () => ev(`!!document.querySelector("#docs-body textarea.doc-area")`);
const typeArea = (text) =>
  ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.value = ${JSON.stringify(text)}; a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const thumbCount = () => ev(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length`);
const pendingCount = () => ev(`document.querySelectorAll("#docs-body .doc-imgs .cthumb:not(.pending)").length`);
const shot = async (name) => {
  if (!SHOTS) return;
  const { data } = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
};
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar") && !!window.__TAURI__`, "页面就绪", 30000);
}
/** 换掉 file input 的 click:塞 `n` 张页内现画的 PNG、发 change。`hold` = 先不交,等 `__pickGo()`。
 *  每次被调都记下那个 input 的 capture / multiple(拍照那发该带 capture)。 */
const armPicker = (n, hold = false) =>
  ev(`(() => {
    if (!window.__realClick) window.__realClick = HTMLInputElement.prototype.click;
    window.__pickLog = window.__pickLog || [];
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return window.__realClick.call(this);
      const input = this;
      window.__pickLog.push({ capture: input.getAttribute("capture"), multiple: input.multiple });
      const deliver = async () => {
        const dt = new DataTransfer();
        for (let i = 0; i < ${n}; i++) {
          const c = document.createElement("canvas");
          c.width = 48; c.height = 48;
          const g = c.getContext("2d");
          g.fillStyle = "hsl(" + (i * 97) % 360 + ",60%,50%)";
          g.fillRect(0, 0, 48, 48);
          const blob = await new Promise((r) => c.toBlob(r, "image/png"));
          dt.items.add(new File([blob], "pick" + i + ".png", { type: "image/png" }));
        }
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      };
      if (${hold}) window.__pickGo = deliver;
      else setTimeout(deliver, 50);
    };
    return true;
  })()`);
const disarmPicker = () => ev(`window.__realClick && (HTMLInputElement.prototype.click = window.__realClick), true`);
async function openReader(id) {
  if (!(await ev(`document.body.classList.contains("pane-open") && !document.getElementById("docs-pane").hidden`)))
    await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!!document.querySelector('#docs-body [data-doc="${id}"]')`, "列表里有那篇");
  await ev(`document.querySelector('#docs-body [data-doc="${id}"]').click()`);
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页");
}
const imgsOf = (id) => inv("list_item_images", { spaceId: sp, itemId: id });

let sp = null;
const seeded = [];
try {
  sp = await ev(`localStorage.getItem("zhujian.last-space")`);
  const spaces = await inv("list_spaces", {});
  const cur = spaces.find((x) => x.id === sp);
  if (!cur) throw new Error(`当前空间 ${sp} 不在 list_spaces 里`);
  if (cur.configured && !ALLOW_SYNCED) throw new Error(`当前空间配过账户,种子与墓碑会同步出去 —— 确认是测试账户再带 --allow-synced`);
  const docsBefore = (await inv("list_docs", { spaceId: sp })).map((d) => d.id);

  const BODY = `# ${MARK}\n\n正文里提到图1。\n`;
  const id = await inv("capture_doc", { spaceId: sp, content: BODY });
  seeded.push(id);
  await reload();

  // ① 已存过的篇:编辑器下方有两枚钮、还没有缩略图
  await openReader(id);
  await clickText("编辑");
  await waitFor(`!!document.querySelector("#docs-body .doc-imgs")`, "编辑器配图条");
  const btns = await ev(`[...document.querySelectorAll("#docs-body .doc-tools button")].map((b) => b.textContent.trim())`);
  ok(btns.includes("＋ 加图") && btns.includes("＋ 拍照"), "① 「编辑 / 预览」那排有「＋ 加图」「＋ 拍照」", btns);
  ok((await thumbCount()) === 0, "① 没有图时没有缩略图");
  // 分段钮挪进那一排后别被 `.row button`(实心主钮)刷色:没选中的「预览」与「保存」不该同一个底
  const fills = await ev(`(() => {
    const bg = (b) => getComputedStyle(b).backgroundColor;
    const all = [...document.querySelectorAll("#docs-body button")];
    return { preview: bg(all.find((b) => b.textContent.trim() === "预览")), save: bg(all.find((b) => b.textContent.trim() === "保存")) };
  })()`);
  ok(fills.preview !== fills.save, "① 没选中的「预览」不是实心主钮的底色", fills);

  // ② 加两张 = 当场挂上(保存之前库里就有)
  await armPicker(2);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "两张缩略图");
  ok((await imgsOf(id)).length === 2, "② 加图当场挂上:保存前 list_item_images 已有 2 张");
  ok(/已加 2 张图/.test((await bar()) ?? ""), "② 回执「已加 2 张图」", await bar());
  ok(await inEditor(), "② 仍在编辑器");
  // 矮屏几何:钮与刚长出来的缩略图都得在底栏上沿之上(不滚动就看得见)
  const geo = await ev(`(() => {
    const top = document.getElementById("bottombar").getBoundingClientRect().top;
    const bot = (q) => Math.max(...[...document.querySelectorAll(q)].map((e) => e.getBoundingClientRect().bottom));
    return { vh: innerHeight, bottombar: Math.round(top), buttons: Math.round(bot("#docs-body .doc-tools button")), thumbs: Math.round(bot("#docs-body .doc-imgs .thumb")) };
  })()`);
  ok(geo.buttons <= geo.bottombar && geo.thumbs <= geo.bottombar, "② 钮与新缩略图不滚动就看得见(在底栏上沿之上)", geo);
  await hideBar();

  // ③ 拍照那发带 capture、挂上第三张
  await armPicker(1);
  await clickText("＋ 拍照");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 3`, "三张缩略图");
  const log = await ev(`window.__pickLog`);
  ok(log[0].multiple === true && log[0].capture === null, "③ 加图那发是多选、不带 capture", log[0]);
  ok(log[1].capture === "environment", "③ 拍照那发带 capture=environment", log[1]);
  const metas = await imgsOf(id);
  ok(metas.length === 3, "③ 库里 3 张");
  await hideBar();

  // ④ 预览里「图1」是芯片(编辑器把配图映射交给了渲染器)
  await clickText("预览");
  await waitFor(`!document.querySelector("#docs-body .doc-preview").hidden`, "预览");
  const chip = await ev(`(() => { const b = document.querySelector("#docs-body .doc-preview .img-ref"); return b ? b.textContent : null; })()`);
  ok(chip !== null, "④ 预览里「图1」画成芯片", chip);
  await shot("doc-edit-preview");
  await clickText("编辑");

  // ⑤ × 只做标记:库里还在;再点撤销;再标
  const seq2 = metas.find((m) => m.seq === 2);
  const del2 = `#docs-body .doc-imgs .thumb[data-img="${seq2.id}"] .thumb-del`;
  await ev(`document.querySelector('${del2}').click()`);
  ok(await ev(`document.querySelector('#docs-body .doc-imgs .thumb[data-img="${seq2.id}"]').classList.contains("marked")`), "⑤ 点 × = 图2 标成待删");
  ok(await ev(`document.querySelector('${del2}').textContent === "↺"`), "⑤ × 换成 ↺");
  ok((await imgsOf(id)).length === 3, "⑤ 标了之后库里仍 3 张(保存才删)");
  await ev(`document.querySelector('${del2}').click()`);
  ok(!(await ev(`document.querySelector('#docs-body .doc-imgs .thumb[data-img="${seq2.id}"]').classList.contains("marked")`)), "⑤ 再点 ↺ = 撤销标记");
  await ev(`document.querySelector('${del2}').click()`);
  await shot("doc-edit-marked");

  // ⑥ 保存:图2 没了、阅读页缩略图 2 张、它在回收站里
  await clickText("保存");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "回到阅读页");
  const after = await imgsOf(id);
  ok(after.length === 2 && !after.some((m) => m.id === seq2.id), "⑥ 保存后图2 删了、余 2 张", after.map((m) => m.seq));
  await waitFor(`document.querySelectorAll("#docs-body .doc-page .thumbs .thumb").length === 2`, "阅读页缩略图 2 张");
  const removed = await inv("list_removed_images", { spaceId: sp, scope: "all" });
  ok(removed.some((g) => g.item_id === id && g.images.some((m) => m.id === seq2.id)), "⑥ 图2 进了回收站(可还原)");

  // ⑦ 再标一张、关面(不是保存)⇒ 一张不删
  await clickText("编辑");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "编辑器里 2 张");
  const seq1 = after.find((m) => m.seq === 1);
  await ev(`document.querySelector('#docs-body .doc-imgs .thumb[data-img="${seq1.id}"] .thumb-del').click()`);
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`); // 再点同一入口 = 收面
  await waitFor(`!document.body.classList.contains("pane-open")`, "收面");
  await sleep(600);
  ok((await imgsOf(id)).length === 2, "⑦ 标了删却关面 ⇒ 一张不删(同桌面 unmount)");

  // ⑧ 新篇:加图进暂存条、库里还没有这一篇;空文本返回 = 拦住
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await armPicker(2);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .cthumb:not(.pending)").length === 2`, "暂存两张");
  ok((await thumbCount()) === 0 && (await pendingCount()) === 2, "⑧ 新篇的图进暂存条(没有图N)");
  const docsNow = (await inv("list_docs", { spaceId: sp })).map((d) => d.id);
  ok(docsNow.length === docsBefore.length + 1, "⑧ 加图不建篇(库里仍只多种的那一篇)");
  await back();
  await sleep(300);
  ok(await inEditor(), "⑧ 一个字没写就返回 ⇒ 留在编辑器");
  const errTxt = await ev(`(() => { const e = document.querySelector("#docs-body .doc-err"); return e && !e.hidden ? e.textContent : null; })()`);
  ok(/先写点字/.test(errTxt ?? ""), "⑧ 明说「先写点字」", errTxt);
  await shot("doc-new-pending");

  // ⑨ 写字保存 ⇒ 新篇带着两张图
  await typeArea(`# ${MARK}·新篇\n\n带两张图。`);
  await clickText("保存");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "新篇阅读页");
  const fresh = (await inv("list_docs", { spaceId: sp })).find((d) => !docsBefore.includes(d.id) && d.id !== id);
  if (fresh) seeded.push(fresh.id);
  ok(fresh && (await imgsOf(fresh.id)).length === 2, "⑨ 新篇保存后带着 2 张图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-page .thumbs .thumb").length === 2`, "新篇阅读页缩略图 2 张");

  // ⑩ 暂存图没进「记一笔」的 IndexedDB 草稿:新建一篇加一张、不保存就重载 ⇒ 「记一笔」暂存条空
  await back();
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await armPicker(1);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .cthumb:not(.pending)").length === 1`, "暂存一张");
  await sleep(500); // 给持久化链一个落盘的机会(若接错了,它会写进去)
  await disarmPicker();
  await reload();
  await sleep(1500); // compImgs.restore() 是启动时异步回填
  const composeLeft = await ev(`document.querySelectorAll("#compose-thumbs .cthumb").length`);
  ok(composeLeft === 0, "⑩ 长文暂存图不进「记一笔」的暂存草稿(重载后那条是空的)", composeLeft);
  ok((await inv("list_docs", { spaceId: sp })).length === docsBefore.length + 2, "⑩ 没写字就重载 = 不建");

  // ⑪ 新篇加图写字、直接关面 ⇒ 带着图落下
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await armPicker(1);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .cthumb:not(.pending)").length === 1`, "暂存一张");
  await typeArea(`# ${MARK}·关面\n\n关面也带图。`);
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!document.body.classList.contains("pane-open")`, "收面");
  let closed = null;
  for (let i = 0; i < 20 && !closed; i++) {
    await sleep(300);
    closed = (await inv("list_docs", { spaceId: sp })).find((d) => d.content.includes(`${MARK}·关面`)) ?? null;
  }
  if (closed) seeded.push(closed.id);
  await sleep(600);
  ok(closed && (await imgsOf(closed.id)).length === 1, "⑪ 新篇关面即落、带着 1 张图");

  // ⑫ 取图在飞时按返回 = 拦一句、留在编辑器;放行后照常挂上
  await openReader(id);
  await clickText("编辑");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "编辑器里 2 张");
  await armPicker(1, true);
  await clickText("＋ 加图");
  await sleep(200);
  await back();
  await sleep(300);
  ok(await inEditor(), "⑫ 取图在飞时返回 ⇒ 留在编辑器");
  ok(/图还在加/.test((await bar()) ?? ""), "⑫ 明说「图还在加」", await bar());
  await ev(`window.__pickGo()`);
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 3`, "放行后 3 张");
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "放行后返回 = 回阅读页");
  ok((await imgsOf(id)).length === 3, "⑫ 放行后那张挂上了");
} catch (e) {
  ok(false, `中断:${e.message}`);
} finally {
  try {
    await disarmPicker();
  } catch {
    /* 页面可能在重载 */
  }
  try {
    for (const did of seeded) {
      await inv("archive_note", { spaceId: sp, id: did });
      await inv("purge_note", { spaceId: sp, id: did });
    }
    const leftDocs = (await inv("list_docs", { spaceId: sp })).filter((d) => d.content.includes(MARK));
    const leftImgs = (await inv("list_removed_images", { spaceId: sp, scope: "all" })).filter((g) => seeded.includes(g.item_id));
    ok(leftDocs.length === 0 && leftImgs.length === 0, "收尾:种的长文与回收站里的图都清了", { docs: leftDocs.length, imgs: leftImgs.length });
    await reload();
  } catch (e) {
    ok(false, `收尾失败:${e.message}(手工清:${seeded.join(",")})`);
  }
  s.close();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 处不过`);
process.exit(fails === 0 ? 0 : 1);
