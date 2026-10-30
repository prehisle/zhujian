// 手机长文编辑器「加图 / 拍照 / × 删图」验收(backlog 152:820 留下的手机缺口,825 补)。
//
// 判据都读 DOM / 命令回包:
//   已存过的篇:「编辑 / 预览」那排有「＋ 加图 / ＋ 拍照」→ 加两张**当场挂上**(保存之前 list_item_images 就有)、
//     并在光标处各插一段「图N」(832)、正文框随内容长高不在框里滚;钮与新长出来的缩略图都在底栏上沿之上
//     (矮屏几何格:第一版把它们放在 60vh 正文框底下,360×640 上整排压在底栏后)、拍照那发的 input 带 capture →
//     预览里单独成段的「图N」**原位画成图**(字节真到了:naturalWidth > 0)、句中的「图1」仍是芯片 → × 只做标记
//     (库里还在、再点一下撤销)→ 保存后标了的那张没了、它进了回收站(可还原)、阅读页原位显示余下两张而缩略图条
//     把它们藏掉 → 再标一张、**关面**(不是保存)⇒ 那张一张不删(同桌面 unmount:删图认的是前台空间)。
//   新篇(832 起没有暂存条):一个字没写就加图 ⇒ 当场建篇挂上、正文是两段「图N」→ 返回 = 回阅读页;
//     写了两段字、光标放在中间加图 ⇒ 那一段插在两段之间(前后各空一行)→ 写字加图后**直接关面** ⇒ 字与图都落下。
//   取图在飞时按返回 = 拦一句、留在编辑器;放行后照常。
//   写字框里的「图N」(833):对得上的垫底色、每处都在那一行右侧配缩略图(837 起句中的也配;字节真到了)、影子层与写字框内框重合;
//     挨得近的几枚往左排开、互不相叠(837);图删了那段不再垫。
//   缩略图条只摆当下没画出来的(835):写字时藏窄边配了图的(= 正文里写到的,837)、预览时藏原位画成图的;
//     删图 = 预览里大图角上的 ×(与条里同一份标记),标了的那张窄边那枚也变淡(837)。
//
// 取图不经系统选择器:页内把 `HTMLInputElement.prototype.click` 换掉,遇到 file input 就塞几张页内现画
// 的 PNG 并发 change(同用户选完回来)。⚠ 诚实边界:系统相册 / 相机那半、取消那条路、降采样的手感
// 都不在本资产里 —— 那些归 `cdp-acceptance-pick-images.mjs`(它的头注第 ⑥ 条)。
//
// ⛔ **会写库**:只动自己种的(题目带「配图验收」的长文);收尾 purge(连图一起销毁,含回收站里那张)。
//    当前空间配过账户就拒跑(`--allow-synced` 放行 —— 墓碑会同步到同账户的其它设备)。
//
// 跑法(MuMu / 真机的 devtools 包;先 `node scripts/android-cdp.mjs forward`):
//   CDP_PORT=9222 node scripts/cdp-acceptance-docs-images.mjs [--shots <目录>] [--zoom 115]
//   ⭐ `--zoom` 至少跑一趟非 100 的档:MuMu 系统字号是 100%,不拨就照不出 834 那种「影子层被放大两遍」。
// 退出码 0 = 全过。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";

const argv = process.argv.slice(2);
const arg = (k) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : null);
const PORT = Number(process.env.CDP_PORT || 9222);
const SHOTS = arg("--shots");
const ALLOW_SYNCED = argv.includes("--allow-synced");
const ZOOM = arg("--zoom"); // 界面字号临时拨到这一档(走桥,不写盘;收尾拨回存着的那档)
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
const areaText = () => ev(`document.querySelector("#docs-body textarea.doc-area").value`);
const caretTo = (k) => ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.setSelectionRange(${k}, ${k}); return true; })()`);
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
const stripVis = () => ev(`[...document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb")].filter((b) => getComputedStyle(b).display !== "none").map((b) => Number(b.dataset.seq))`);
/** 预览里「图N」那张大图角上的 ×(835:缩略图条把原位画了的藏掉,删图挪到这儿) */
const figDel = (n) => `[...document.querySelectorAll("#docs-body .doc-preview .md-fig-box")].find((b) => b.querySelector(".md-fig").getAttribute("aria-label") === "图${n}").querySelector(".thumb-del")`;

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
  if (ZOOM !== null) await ev(`window.__zhujianTextSize.set(${Number(ZOOM)}), true`); // 收尾那次重载按存着的档拨回

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

  // ② 加两张 = 当场挂上(保存之前库里就有),光标处(末尾)各插一段「图N」
  await caretTo(BODY.length);
  await armPicker(2);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "两张缩略图");
  ok((await imgsOf(id)).length === 2, "② 加图当场挂上:保存前 list_item_images 已有 2 张");
  ok((await areaText()) === `${BODY}\n图1\n\n图2\n\n`, "② 光标处插了两段「图1」「图2」(各自成段)", await areaText());
  const fit = await ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); return { sh: a.scrollHeight, ch: a.clientHeight, ov: getComputedStyle(a).overflowY }; })()`);
  ok(fit.sh <= fit.ch + 1 && fit.ov === "hidden", "② 正文框随内容长高、框里不滚", fit);
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

  // ④ 预览:单独成段的三段「图N」原位画成图(字节真到了),句中的「图1」仍是芯片
  ok((await areaText()).endsWith("图1\n\n图2\n\n图3\n\n"), "③ 拍的那张也插了「图3」", await areaText());
  // ③b 写字框里的标注(833):四处「图N」都垫了底色、各配一枚缩略图(837 起句中那处也配)、字节真到了;
  //     垫底色的那一格与写字框里那几个字落在同一处(影子层与写字框同宽同排版)
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-pins .ref-thumb img")].filter((i) => i.complete && i.naturalWidth > 0).length === 4`, "写字框里四枚缩略图");
  const hl = await ev(`(() => {
    const a = document.querySelector("#docs-body textarea.doc-area"), h = document.querySelector("#docs-body .doc-hl");
    const ra = a.getBoundingClientRect(), rh = h.getBoundingClientRect();
    return { marks: [...h.querySelectorAll(".ref")].map((m) => m.firstChild.textContent), thumbs: document.querySelectorAll("#docs-body .doc-pins .ref-thumb").length,
      dx: Math.round(rh.left - ra.left - a.clientLeft), w: [Math.round(rh.width), a.clientWidth], hh: [Math.round(rh.height), a.clientHeight],
      gutter: getComputedStyle(a).paddingRight, copied: getComputedStyle(h).paddingRight };
  })()`);
  ok(hl.marks.join() === "图1,图1,图2,图3" && hl.thumbs === 4, "③b 四处「图N」垫了底色、各配一枚缩略图(句中的也配)", hl);
  ok(hl.dx === 0 && hl.w[0] === hl.w[1] && hl.hh[0] === hl.hh[1] && hl.gutter === hl.copied, "③b 影子层与写字框内框重合、窄边一致", hl);
  // ③c 每处底色落在那几个字所在的那一行(834:系统字号 / 界面字号不是 100% 时,影子层抄来的放大后字号被 textZoom
  //     再放大一遍,底色整片往下错、越往后错得越多)。这几段都短、不折行 ⇒ 第几行 = 前面有几个换行。
  const rows = await ev(`(() => {
    const a = document.querySelector("#docs-body textarea.doc-area"), h = document.querySelector("#docs-body .doc-hl");
    const ca = getComputedStyle(a), ch = getComputedStyle(h), lh = parseFloat(ca.lineHeight), top = h.getBoundingClientRect().top + parseFloat(ca.paddingTop);
    const v = a.value, want = [];
    for (const m of v.matchAll(/图\\d+/g)) want.push(v.slice(0, m.index).split("\\n").length - 1);
    const got = [...h.querySelectorAll(".ref")].map((m) => { const r = m.getClientRects()[0]; return Math.floor((r.top + r.height / 2 - top) / lh); });
    return { want, got, font: [ca.fontSize, ch.fontSize], lh: [ca.lineHeight, ch.lineHeight] };
  })()`);
  ok(rows.want.join() === rows.got.join() && rows.font[0] === rows.font[1] && rows.lh[0] === rows.lh[1], `③c 底色落在那几个字那一行、字号行高与写字框一致(字号 ${ZOOM ?? "不动"})`, rows);
  await shot("doc-edit-hl");
  // ③e 窄边缩略图点得开(836):看得见的那枚在写字框上面一层、与影子层里的隐形占位同位,点它中心命中的就是它;点了开看图
  // ⚠ 真机上前面那步让写字框拿了焦点、键盘起着 ⇒ 下面几枚可能在键盘后面(elementFromPoint 出视口给 null):逐枚先滚进视口、等两拍读数稳了再测
  const pin = await ev(`(async () => {
    const still = async (e) => { for (let y = null; ; ) { await new Promise((r) => requestAnimationFrame(r)); const t = e.getBoundingClientRect().top; if (t === y) return; y = t; } };
    const spots = [...document.querySelectorAll("#docs-body .doc-hl .ref-thumb")], pins = [...document.querySelectorAll("#docs-body .doc-pins .ref-thumb")];
    const r = (e) => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.width, b.height].map((x) => Math.round(x * 10) / 10); };
    const hit = [];
    for (const p of pins) { p.scrollIntoView({ block: "center" }); await still(p); hit.push(hitOf(p)); }
    function hitOf(p) { const b = p.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return p.contains(e) || (e ? e.tagName + "." + e.className + "#" + e.id : null); }
    return { same: pins.length === spots.length && pins.every((p, i) => r(p).join() === r(spots[i]).join()), hit, at: pins.map(r) };
  })()`);
  ok(pin.same && pin.hit.length === 4 && pin.hit.every((h) => h === true), "③e 窄边四枚缩略图与占位同位、点中心命中的就是它", pin);
  await ev(`(async () => { const p = document.querySelector("#docs-body .doc-pins .ref-thumb"); p.scrollIntoView({ block: "center" }); await new Promise((r) => setTimeout(r, 400)); const b = p.getBoundingClientRect(); document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2).click(); return 1; })()`);
  await waitFor(`!document.getElementById("viewer").hidden`, "点窄边缩略图开看图");
  await ev(`document.getElementById("viewer").click(), 1`);
  await waitFor(`document.getElementById("viewer").hidden`, "看图关上");
  // ③d 写字时条里只摆正文里还没写到的(835;837 起句中写到的也算写到):三张都写到了 ⇒ 条里一张不摆;
  //     把「图3」那段删了 ⇒ 图3 回到条里;把单独那段「图1」删了、句中那处留着 ⇒ 图1 仍不进条(它在句中那行的窄边上)
  const setArea = (v) => ev(`(() => { const a = document.querySelector("#docs-body textarea.doc-area"); a.value = ${JSON.stringify(v)}; a.dispatchEvent(new Event("input")); return 1; })()`);
  ok((await stripVis()).length === 0, "③d 三张都写进了正文 ⇒ 条里一张不摆", await stripVis());
  const full = await areaText();
  await setArea(full.replace("图3\n\n", ""));
  ok((await stripVis()).join() === "3", "③d 「图3」那段删了 ⇒ 图3 回到条里", await stripVis());
  await setArea(full.replace("\n图1\n", "\n"));
  const solo = await ev(`[...document.querySelectorAll("#docs-body .doc-pins .ref-thumb")].map((p) => p.dataset.seq).join()`);
  ok((await stripVis()).length === 0 && solo === "1,2,3", "③d 只剩句中的「图1」⇒ 图1 在那一行窄边上、不进条", { strip: await stripVis(), solo });
  // ③f 挨得近的几处往左排开、互不相叠(837):同一行两处、紧挨着的下一行一处
  await setArea("图1 图2\n图3\n");
  const cols = await ev(`(() => {
    const r = [...document.querySelectorAll("#docs-body .doc-pins .ref-thumb")].map((p) => p.getBoundingClientRect());
    const cross = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    return { n: r.length, overlap: r.some((a, i) => r.some((b, j) => j > i && cross(a, b))), lefts: r.map((x) => Math.round(x.left)) };
  })()`);
  ok(cols.n === 3 && !cols.overlap && new Set(cols.lefts).size === 3, "③f 挨得近的三枚排成三列、互不相叠", cols);
  await setArea(full);
  ok((await stripVis()).length === 0, "③d 放回来又藏", await stripVis());
  await clickText("预览");
  await waitFor(`!document.querySelector("#docs-body .doc-preview").hidden`, "预览");
  const chip = await ev(`(() => { const b = document.querySelector("#docs-body .doc-preview .img-ref"); return b ? b.textContent : null; })()`);
  ok(chip !== null, "④ 句中的「图1」仍是芯片", chip);
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-preview .md-fig img")].filter((i) => i.complete && i.naturalWidth > 0).length === 3`, "预览里三张图原位显示");
  ok((await ev(`document.querySelectorAll("#docs-body .doc-preview .md-fig img").length`)) === 3, "④ 三段「图N」原位画成图");
  ok((await stripVis()).length === 0 && (await ev(`document.querySelectorAll("#docs-body .doc-preview .md-fig-box .thumb-del").length`)) === 3,
    "④ 条里不重复摆、三张大图角上各一枚 ×", await stripVis());
  await shot("doc-edit-preview");

  // ⑤ 大图角上的 × 只做标记:库里还在;条里那张(藏着)同一份标记;再点撤销;再标
  const seq2 = metas.find((m) => m.seq === 2);
  const thumbMarked2 = `document.querySelector('#docs-body .doc-imgs .thumb[data-img="${seq2.id}"]').classList.contains("marked")`;
  await ev(`${figDel(2)}.click()`);
  ok(await ev(`${figDel(2)}.parentElement.classList.contains("marked")`), "⑤ 点 × = 图2 标成待删");
  ok(await ev(`${figDel(2)}.textContent === "↺"`), "⑤ × 换成 ↺");
  ok(await ev(thumbMarked2), "⑤ 条里那张同一份标记");
  ok(await ev(`document.querySelector('#docs-body .doc-pins .ref-thumb[data-img="${seq2.id}"]').classList.contains("marked")`), "⑤ 写字框窄边那枚也变淡(837)");
  ok((await imgsOf(id)).length === 3, "⑤ 标了之后库里仍 3 张(保存才删)");
  await ev(`${figDel(2)}.click()`);
  ok(!(await ev(`${figDel(2)}.parentElement.classList.contains("marked")`)) && !(await ev(thumbMarked2)), "⑤ 再点 ↺ = 撤销标记");
  await ev(`${figDel(2)}.click()`);
  await shot("doc-edit-marked");

  // ⑥ 保存:图2 没了、阅读页缩略图 2 张、它在回收站里
  await clickText("保存");
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "回到阅读页");
  const after = await imgsOf(id);
  ok(after.length === 2 && !after.some((m) => m.id === seq2.id), "⑥ 保存后图2 删了、余 2 张", after.map((m) => m.seq));
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-page .md-fig img")].filter((i) => i.complete && i.naturalWidth > 0).length === 2`, "阅读页原位显示 2 张");
  const strip = await ev(`(() => { const t = [...document.querySelectorAll("#docs-body .doc-page .thumbs .thumb")]; return { n: t.length, shown: t.filter((b) => getComputedStyle(b).display !== "none").length }; })()`);
  ok(strip.n === 2 && strip.shown === 0, "⑥ 阅读页缩略图条把原位显示了的两张藏掉", strip);
  ok((await ev(`document.querySelector("#docs-body .doc-page .md").textContent.includes("图2")`)), "⑥ 删掉的图2 那段按原文留着");
  const removed = await inv("list_removed_images", { spaceId: sp, scope: "all" });
  ok(removed.some((g) => g.item_id === id && g.images.some((m) => m.id === seq2.id)), "⑥ 图2 进了回收站(可还原)");

  // ⑦ 再标一张、关面(不是保存)⇒ 一张不删
  await clickText("编辑");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "编辑器里 2 张");
  const broken = await ev(`[...document.querySelectorAll("#docs-body .doc-hl .ref")].map((m) => m.firstChild.textContent).join()`);
  ok(broken === "图1,图1,图3", "⑦ 图2 删掉之后它那段不再垫底色(引用断了一眼看得出)", broken);
  await clickText("预览");
  await waitFor(`document.querySelectorAll("#docs-body .doc-preview .md-fig-box").length === 2`, "预览里两张大图");
  await ev(`${figDel(1)}.click()`);
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`); // 再点同一入口 = 收面
  await waitFor(`!document.body.classList.contains("pane-open")`, "收面");
  await sleep(600);
  ok((await imgsOf(id)).length === 2, "⑦ 标了删却关面 ⇒ 一张不删(同桌面 unmount)");

  // ⑧ 新篇:一个字没写就加图 ⇒ 当场建篇挂上,正文是两段「图N」;返回 = 回阅读页、原位显示
  const newDocs = async () => (await inv("list_docs", { spaceId: sp })).filter((d) => !docsBefore.includes(d.id) && !seeded.includes(d.id));
  await ev(`document.querySelector('#bottombar [data-pane="docs"]').click()`);
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await armPicker(2);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 2`, "两张缩略图(已挂上)");
  const fresh = await newDocs();
  for (const d of fresh) seeded.push(d.id);
  ok(fresh.length === 1 && (await imgsOf(fresh[0].id)).length === 2, "⑧ 一个字没写就加图 ⇒ 当场建篇、挂上 2 张", fresh.length);
  ok((await areaText()) === "图1\n\n图2\n\n", "⑧ 正文是两段「图N」", await areaText());
  await shot("doc-new-images");
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "新篇阅读页");
  await waitFor(`[...document.querySelectorAll("#docs-body .doc-page .md-fig img")].filter((i) => i.complete && i.naturalWidth > 0).length === 2`, "新篇阅读页原位显示 2 张");
  ok(fresh.length === 1 && (await inv("list_docs", { spaceId: sp })).find((d) => d.id === fresh[0].id).content === "图1\n\n图2\n\n", "⑧ 返回 = 那一版带着两段引用落下");

  // ⑨ 新篇写了两段字,光标放在中间加图 ⇒ 那一段插在两段之间(前后各空一行)
  await back();
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  const TWO = `# ${MARK}·中间\n第二行`;
  await typeArea(TWO);
  await caretTo(TWO.indexOf("\n第二行"));
  await armPicker(1);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 1`, "一张缩略图");
  ok((await areaText()) === `# ${MARK}·中间\n\n图1\n\n第二行`, "⑨ 插在光标处、前后各空一行", await areaText());
  for (const d of await newDocs()) seeded.push(d.id);
  await back();
  await waitFor(`!!document.querySelector("#docs-body .doc-acts")`, "回阅读页");
  await back();
  await waitFor(`!document.getElementById("docs-new").hidden`, "列表页");

  // ⑪ 新篇写字加图、直接关面 ⇒ 字与图都落下
  await ev(`document.getElementById("docs-new").click()`);
  await waitFor(`!!document.querySelector("#docs-body textarea.doc-area")`, "新篇编辑器");
  await typeArea(`# ${MARK}·关面\n\n关面也带图。`);
  await caretTo(0);
  await armPicker(1);
  await clickText("＋ 加图");
  await waitFor(`document.querySelectorAll("#docs-body .doc-imgs .thumbs .thumb").length === 1`, "一张缩略图");
  for (const d of await newDocs()) seeded.push(d.id);
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
  ok(closed && closed.content === `图1\n\n# ${MARK}·关面\n\n关面也带图。`, "⑪ 关面落下的那一版带着引用", closed?.content);

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
    for (const did of new Set(seeded)) {
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
