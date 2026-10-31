// 手机长文编辑器离开那一刻的两句问话 + 续列表 +「写于」带日期(154 G6–G8,同桌面 e2e `docs-leave.e2e.js`)。
//
// 判据都读 DOM / 命令回包:
//   G8 续列表:真发回车键(CDP Input.dispatchKeyEvent,过原生输入管线)⇒「- 甲」后续出「- 」、空项再回车抹掉记号、
//      「- [x] 丙」后续成「- [ ] 」;空的新篇点【保存】⇒ 不建、屏底说一声。
//   G6 新篇一个字没写就加一张图(当场建篇)→ 把那行「图1」清掉 → 返回 ⇒ 页头里问留不留、还在编辑器;
//      返回键再按一次 = 收起问句、仍在编辑器;再返回 →「删掉这篇(进回收站)」⇒ 长文里没了、回收站里有、屏底带撤销。
//   G7 已存过的篇标删一张图 → 返回 ⇒ 问「标了删的 1 张图」;「不删」⇒ 字落库、图还在;再标 → 返回 →「删掉这 1 张」⇒ 删了;
//      再标 → 点【保存】⇒ 不问、直接删。
//   G8「写于」:今天建的篇,阅读页那行带「月日」(此前当天只写时刻)。
//
// ⚠ 诚实边界:回车走的是 CDP 发的硬键事件;各家软键盘的回车怎么到 WebView(keydown 是 Enter 还是 229)不在本资产里 ——
//    随记那条 `- [ ] ` 续行是同一条接线(android/src/checklist-input.ts),用户手上一直会续;长文这条仍请用户真手敲一次。
//
// ⛔ **会写库**:只动自己种的(题目带「离开验收」的长文 + 本趟新建的那几篇);收尾 purge。当前空间配过账户就拒跑(`--allow-synced` 放行)。
//
// 跑法(真机 / MuMu 的 devtools 包;先 `node scripts/android-cdp.mjs forward`):
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs-leave.mjs
// 退出码 0 = 全过。
// @cdp-run mjs 120000
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const PORT = Number(process.env.CDP_PORT || 9222);
const ALLOW_SYNCED = argv.includes("--allow-synced");
const MARK = "离开验收";

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
const areaText = () => ev(`document.querySelector("#docs-body textarea.doc-area").value`);
const setArea = (text) =>
  ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.focus({ preventScroll: true }); a.value = ${JSON.stringify(text)}; a.setSelectionRange(a.value.length, a.value.length); a.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
const askText = () => ev(`(() => { const a = document.querySelector("#docs-body .doc-ask span"); return a ? a.textContent : null; })()`);
async function key(k) {
  const base = k === "Enter" ? { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 } : null;
  if (base === null) {
    await s.send("Input.insertText", { text: k });
    return;
  }
  await s.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await s.send("Input.dispatchKeyEvent", { type: "char", ...base, text: "\r" });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}
async function reload() {
  await ev(`setTimeout(() => location.reload(), 0), true`);
  await sleep(800);
  await waitFor(`document.readyState === "complete" && !!document.querySelector("#bottombar") && !!window.__TAURI__`, "页面就绪", 30000);
}
const armPicker = (n) =>
  ev(`(() => {
    if (!window.__realClick) window.__realClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return window.__realClick.call(this);
      const input = this;
      setTimeout(async () => {
        const dt = new DataTransfer();
        for (let i = 0; i < ${n}; i++) {
          const c = document.createElement("canvas");
          c.width = c.height = 48;
          c.getContext("2d").fillRect(0, 0, 48, 48);
          const blob = await new Promise((r) => c.toBlob(r, "image/png"));
          dt.items.add(new File([blob], "pick" + i + ".png", { type: "image/png" }));
        }
        input.files = dt.files;
        input.dispatchEvent(new Event("change"));
      }, 50);
    };
    return true;
  })()`);
const disarmPicker = () => ev(`window.__realClick && (HTMLInputElement.prototype.click = window.__realClick), true`);
async function toList() {
  if (!(await ev(`document.body.classList.contains("pane-open") && !document.getElementById("docs-pane").hidden`)))
    await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  for (let i = 0; i < 4 && !(await ev(`!document.getElementById("docs-new").hidden`)); i++) await back();
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
}
async function openReader(id) {
  await toList();
  await waitFor(`!!document.querySelector('#docs-body [data-doc="${id}"]')`, "列表里有那篇");
  await ev(`document.querySelector('#docs-body [data-doc="${id}"]').click()`);
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "阅读页");
}
const imgsOf = (id) => inv("list_item_images", { spaceId: sp, itemId: id });
const markThumb = (seq) => ev(`document.querySelector('#docs-body .doc-imgs .thumbs .thumb[data-seq="${seq}"] .thumb-del').click(), true`);

let sp = null;
const seeded = [];
try {
  sp = await ev(`localStorage.getItem("zhujian.last-space")`);
  const spaces = await inv("list_spaces", {});
  const cur = spaces.find((x) => x.id === sp);
  if (!cur) throw new Error(`当前空间 ${sp} 不在 list_spaces 里`);
  if (cur.configured && !ALLOW_SYNCED) throw new Error(`当前空间配过账户,种子与墓碑会同步出去 —— 确认是测试账户再带 --allow-synced`);
  const docsBefore = (await inv("list_docs", { spaceId: sp })).map((d) => d.id);
  const newDocs = async () => (await inv("list_docs", { spaceId: sp })).filter((d) => !docsBefore.includes(d.id) && !seeded.includes(d.id));
  await reload();

  // ① G8 续列表 + 空篇保存说一声
  await toList();
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await setArea("- 甲");
  await key("Enter");
  ok((await areaText()) === "- 甲\n- ", "① 「- 甲」上回车 ⇒ 续出「- 」", await areaText());
  await key("Enter");
  ok((await areaText()) === "- 甲\n", "① 空项上回车 ⇒ 抹掉记号、退出列表", await areaText());
  await key("- [x] 丙");
  await key("Enter");
  ok((await areaText()) === "- 甲\n- [x] 丙\n- [ ] ", "① 勾过的方框后回车 ⇒ 续成没勾的「- [ ] 」", await areaText());
  await setArea("");
  await hideBar();
  await clickText("保存");
  await waitFor(`!document.getElementById("docs-new").hidden`, "空篇保存后回列表");
  ok(/没有建/.test((await bar()) ?? ""), "① 空的新篇保存 ⇒ 屏底说「没有建」", await bar());
  ok((await newDocs()).length === 0, "① 空篇没建");

  // ② G6 只剩图的空篇
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await armPicker(1);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 1`, "缩略图(已挂上)");
  await sleep(400); // 取图在飞的旗(picking)在挂完之后才放
  const fresh = await newDocs();
  for (const d of fresh) seeded.push(d.id);
  ok(fresh.length === 1, "② 加图当场建篇", fresh.length);
  await setArea("");
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-ask")`, "只剩图时问一句");
  ok(/只挂着 1 张图/.test((await askText()) ?? ""), "② 问「只挂着 1 张图,还留着吗」", await askText());
  ok(await inEditor(), "② 问着时仍在编辑器");
  const inHead = await ev(`!!document.querySelector("#docs-body .doc-head .doc-ask")`);
  ok(inHead, "② 问句挂在吸顶页头里");
  await back();
  ok((await askText()) === null && (await inEditor()), "② 问句开着时返回 = 收起、接着写");
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-ask")`, "再返回又问");
  await hideBar();
  await clickText("删掉这篇(进回收站)");
  await waitFor(`!document.getElementById("docs-new").hidden`, "删掉后回列表");
  const gone = fresh.length === 1 && !(await inv("list_docs", { spaceId: sp })).some((d) => d.id === fresh[0].id);
  ok(gone, "② 「删掉这篇」⇒ 长文里没了");
  ok(/已移入回收站/.test((await bar()) ?? ""), "② 屏底「已移入回收站」带撤销", await bar());

  // ③ G7 标删的图
  const BODY = `# ${MARK}\n\n见图1。`;
  const id = await inv("capture_doc", { spaceId: sp, content: BODY });
  seeded.push(id);
  for (let i = 0; i < 2; i++) await inv("add_item_image", { spaceId: sp, itemId: id, mime: "image/png", dataB64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" });
  await reload();
  const openEd = async (n) => {
    await openReader(id);
    await clickText("编辑");
    await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === ${n}`, `编辑器条画齐 ${n} 张`);
  };
  await openEd(2);
  await markThumb(1);
  await setArea(`${BODY}改`);
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-ask")`, "标了删图返回时问");
  ok(/标了删的 1 张图/.test((await askText()) ?? ""), "③ 问「标了删的 1 张图,删掉吗」", await askText());
  await clickText("不删");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "「不删」后回阅读页");
  ok((await inv("list_docs", { spaceId: sp })).find((d) => d.id === id).content === `${BODY}改`, "③ 「不删」⇒ 字落库");
  ok((await imgsOf(id)).length === 2, "③ 「不删」⇒ 图还在");
  // G8「写于」今天也带日期
  const written = await ev(`document.querySelector("#docs-body .doc-meta time").textContent`);
  const now = new Date();
  ok(written.includes(`${now.getMonth() + 1}月${now.getDate()}日`), "⑤ 今天建的篇「写于」带月日", written);

  await clickText("编辑");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "编辑器条画齐 2 张");
  await markThumb(2);
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-ask")`, "第二趟返回时问");
  await clickText("删掉这 1 张");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "删掉后回阅读页");
  ok((await imgsOf(id)).length === 1, "③ 「删掉这 1 张」⇒ 删了");

  // ④ 点【保存】不问
  await clickText("编辑");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 1`, "编辑器条画出 1 张");
  await markThumb(1);
  await clickText("保存");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "保存后回阅读页");
  ok((await imgsOf(id)).length === 0, "④ 标了删点【保存】⇒ 不问、直接删");
} catch (e) {
  ok(false, `中断:${e.message}`);
} finally {
  try {
    await disarmPicker();
  } catch {
    /* 页面可能在重载 */
  }
  try {
    for (const did of new Set(seeded)) {
      await inv("archive_note", { spaceId: sp, id: did }).catch(() => {}); // ② 那篇已在回收站
      await inv("purge_note", { spaceId: sp, id: did });
    }
    const left = (await inv("list_docs", { spaceId: sp })).filter((d) => seeded.includes(d.id));
    const leftImgs = (await inv("list_removed_images", { spaceId: sp, scope: "all" })).filter((g) => seeded.includes(g.item_id));
    ok(left.length === 0 && leftImgs.length === 0, "收尾:种的长文与回收站里的图都清了", { docs: left.length, imgs: leftImgs.length });
    await reload();
  } catch (e) {
    ok(false, `收尾失败:${e.message}(手工清:${seeded.join(",")})`);
  }
  s.close();
}
console.log(fails === 0 ? "\n全过" : `\n${fails} 处不过`);
process.exit(fails === 0 ? 0 : 1);
