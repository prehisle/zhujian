// 161(W4「设置与连接」走查,用户 2026-11-06 全取推荐)手机那组 M1 —— 设置 / 备份 / 诊断 / 返回键 / 政策 —— 的真机回归网。
// 驱动形(要真按返回键、真点屏幕、跨两次页面重载),⚠ 只在 vivo 这类真机上有意义;MuMu 上返回键 / 键盘那几格判不了。
//
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-walk161-m1.mjs          # 打印 {pass, steps};设了 ANDROID_SERIAL 就只认那一台
//
// 逐条(编号同 .zjshots/W4-walk/清单.md;用户动作一律 `adb input`(真点 / 真返回键),CDP 只读状态、摆前置、量几何):
//  A11  返回键:设置 →「诊断」→ 返回 = 回设置(滚动位还在)→「空间…」→ 返回 = 回设置 → 返回 = 回时间轴;
//       同步 →「空间…」→ 返回 = 回同步;同步面上一枚「网络自检」(.err-next)→ 诊断 → 返回 = 回同步;
//       政策全文:框里点了别的页签之后,一记返回就收面板、回到设置(app 仍在前台、整页历史条数不变)。
//  A10  诊断页每次进都现跑:进页那一刻旧结果不在了;当前空间配了同步时地址框是那台服务器。
//  Q5   网络自检最上面一句人话结论(两端逐字同的那句);「复制诊断信息」真复制得出来(真粘贴回读:版本 / 两段小节 / 结论)。
//  Q15  「网络诊断」改叫「网络自检」(错误条那枚、诊断页那一节)。
//  Q4   (当前空间没开同步时)建账户连不上:那句**留在表单里**、带「网络自检」且测的是刚填的地址;红条收了它还在;改地址就清。
//  A12  「关于」里能再看隐私政策 / 隐私权利 / 用户协议(应用内那一页);A34 上方那行跟着页签换、告知页链接不是默认蓝、
//       「这一份就是适用于你这一只的」那句在;Q11 WM-30「不同意并退出」。
//  A13  改语言重载后落在设置、语言那一行在屏上(切英文再切回自动,两次);A35 英文档的弯撇号不是全角宽。
//  A19  设置里「复制」的回执走顶上提示条、不推走下面那一节;Q9 截止提醒说明第一句是「开在屏幕上才响」、含「3 天内」。
//  A18 / WM-35  (备份还没设置时)备份码框:只读文本框、组与组之间才折、复制出来不夹零宽空格,一组都不拆在两行。
//  A19 / A31 的几何半截:验证结论长了「验证」钮不被挤到下一行(拿一行假行量 CSS)。
//  A35  同步页「没有其他设备?创建新账户」不在钮里折两行(标准字号);过滤框歇着时不给清除钮留位。
//  A36  (这个空间一篇长文都没有时)记一笔 →「长文」→ 一个字不写退出:底栏不冒「长文」格、那句提示是中性那档不是绿条。
//  Q10  (有应用内更新的渠道)「检查更新」点了有回音(已是最新 / 新版提示 / 没查成,三者之一,15 秒内)。
//  WM-29 设置页有标题、开着时顶栏「设置」点亮、底栏不亮;关了再开**从最上面开始**(903 用户拍,反过来了:此前是回到上次的位置)。
//  A35  冷启首帧底色那座桥在(`__zhujianLaunchTheme`)—— 冷启那 0.6 秒本身只能录屏看(见诚实边界)。
//
// 前置:devtools 包、app 在前台、首启告知已同意、界面语言中文(系统中文)、竖屏手机宽、没开任何面。
//   ⚠ 本资产**不写库**:建账户那一下打到一个没人听的端口(ws://127.0.0.1:9,立刻被拒);备份码仪式点「取消」收场(盘上什么都没写);
//   长文一个字没写不建;语言切回「自动」;只在页里临时插的几样东西(假行 / 粘贴框 / 假「网络自检」钮)都会拆掉。
//   ⛔ 诊断页的地址框在每次进页前都先填成 ws://127.0.0.1:9 —— 别让它去自检官方服务器。
//
// 诚实边界:
//  ① 冷启首帧(暗档先闪白)、英文弯引号在别的机器上的字体、截止提醒在后台到底响不响、写信 app 被拉起 —— 这几样页内断不了,
//     真机录屏 / 截图在 .zjshots/W4-fix/M1/ 与同号 report.md。
//  ② 备份「验证」那一串(A15 空间名 / 本地时间 / 文件名只一遍、A31 刷新后还记得、A32 空文件夹那句)要真挑 SAF 文件夹,
//     本资产不碰;同上手走。
//  ③ 「检查更新」要联网(zhujian.app);没网时那一格判的是「没查成」那句也算有回音。
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const PORT = 9222;
const PKG = "app.zhujian.notebook";
const PROBE_URL = "ws://127.0.0.1:9";
const execFileAsync = promisify(execFile);
const adb = (args) => execFileAsync("adb", args, { encoding: "utf8", maxBuffer: 1 << 24 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function imeShown() {
  const out = await adb(["shell", "dumpsys", "input_method"]).catch(() => null);
  const m = out?.stdout.match(/mInputShown=(true|false)/);
  return m ? m[1] === "true" : null;
}
async function focusedPkg() {
  const out = await adb(["shell", "dumpsys", "window"]).catch(() => null);
  const m = out?.stdout.match(/mCurrentFocus=Window\{\S+ \S+ ([^/\s}]+)/);
  return m ? m[1] : null;
}
const back = () => adb(["shell", "input", "keyevent", "4"]);
async function dropIme() {
  if (await imeShown()) {
    await back();
    await sleep(700);
  }
}

async function connect() {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`http://127.0.0.1:${PORT}/json`).catch(() => null);
    const page = r ? (await r.json()).find((t) => t.type === "page" && t.webSocketDebuggerUrl) : null;
    if (page) {
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise((res, rej) => {
        ws.addEventListener("open", res, { once: true });
        ws.addEventListener("error", () => rej(new Error("ws 连接失败")), { once: true });
      });
      let id = 0;
      const send = (method, params) =>
        new Promise((res, rej) => {
          const myId = ++id;
          const to = setTimeout(() => rej(new Error(`CDP 超时: ${method}`)), 20000);
          const onMsg = (ev) => {
            const m = JSON.parse(ev.data);
            if (m.id !== myId) return;
            ws.removeEventListener("message", onMsg);
            clearTimeout(to);
            if (m.error) return rej(new Error(`${method}: ${JSON.stringify(m.error)}`));
            res(m.result);
          };
          ws.addEventListener("message", onMsg);
          ws.send(JSON.stringify({ id: myId, method, params }));
        });
      return { send, close: () => ws.close() };
    }
    await sleep(500);
  }
  throw new Error("无 page target——先 `node scripts/android-cdp.mjs forward`,且 app 在前台");
}

const out = { pass: false, steps: [] };

const main = async () => {
  const step = (name, ok, detail = "") => {
    out.steps.push({ name, ok: ok === "skip" ? "SKIPPED" : !!ok, detail: String(detail) });
    return !!ok;
  };
  let cdp = await connect();
  const evalJs = async (expression) => {
    const r = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页内异常: ${JSON.stringify(r.exceptionDetails).slice(0, 400)}`);
    return r.result.value;
  };
  const until = async (expr, ms = 4000) => {
    const t0 = Date.now();
    for (;;) {
      if (await evalJs(expr).catch(() => false)) return true;
      if (Date.now() - t0 > ms) return false;
      await sleep(150);
    }
  };
  /** 把 sel 滚进屏中间、等它停稳(连读两拍 top 相同,skill 那条「坐标是陈的」),返回设备像素中心。
   *  ⚠ 顶栏 / 底栏那几枚是吸顶 / 固定的,`scrollIntoView` 会白白滚动页面(把「重开设置回到原处」那格量歪)⇒ 它们不滚。 */
  const FIXED = /^#(settings-toggle|sync-toggle|search-toggle|topics-toggle|capture-fab)$|^#bottombar /;
  const centerDev = async (sel) => {
    if (!FIXED.test(sel)) await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(e)e.scrollIntoView({block:"center"});return 1})()`);
    let last = null;
    for (let i = 0; i < 20; i++) {
      await sleep(120);
      const r = JSON.parse(
        await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return "null";
          const r=e.getBoundingClientRect();if(!r.width)return "null";
          return JSON.stringify([r.top,Math.round((r.x+r.width/2)*devicePixelRatio),Math.round((r.y+r.height/2)*devicePixelRatio)])})()`),
      );
      if (!r) return null;
      if (last && last[0] === r[0]) return [r[1], r[2]];
      last = r;
    }
    return last ? [last[1], last[2]] : null;
  };
  const tapSel = async (sel) => {
    const c = await centerDev(sel);
    if (!c) throw new Error(`找不到(或没画出来)${sel}`);
    await adb(["shell", "input", "tap", String(c[0]), String(c[1])]);
  };
  const shown = (id) => `(!document.getElementById(${JSON.stringify(id)}).hidden)`;
  const paneIs = (id) => `(${shown(id)}&&document.body.classList.contains("pane-open"))`;
  const barText = () => evalJs(`(()=>{const e=document.getElementById("error");return e.hidden?"":e.textContent})()`);
  const clearBar = () => evalJs(`(()=>{const e=document.getElementById("error");e.hidden=true;e.textContent="";e.classList.remove("retiring");return 1})()`);
  /** 上一格判红了(阴性刀下常见)就把界面拨回这一段的起点,让后面几段照判,别一格红、后面全断。 */
  const ensurePane = async (id, toggle) => {
    if (!(await evalJs(`document.getElementById("policy-view").hidden`))) await evalJs(`(()=>{document.getElementById("policy-close").click();return 1})()`);
    if (await evalJs(paneIs(id))) return;
    await closePanes();
    await tapSel(toggle);
    await until(paneIs(id), 3000);
  };
  /** 906:设置的重节各住进了自己的二级页(#set-compress / #set-remind / #set-alias / #set-backup / #set-about)——
   *  要验那一节里的东西,先从设置首页真点它那一行进去。已经在那一页就不动。 */
  const toSetPage = async (id) => {
    if (await evalJs(paneIs(id))) return;
    await ensurePane("settings-pane", "#settings-toggle");
    await tapSel(`#settings-pane [data-set-page="${id}"]`);
    await until(paneIs(id), 3000);
    await sleep(400);
  };
  const closePanes = async () => {
    if (await evalJs(`document.body.classList.contains("pane-open")`)) {
      await tapSel(`#bottombar [data-mode="ideas"]`);
      await until(`!document.body.classList.contains("pane-open")`, 3000);
    }
  };
  const reconnect = async () => {
    cdp.close();
    await sleep(2500);
    await execFileAsync("node", ["scripts/android-cdp.mjs", "forward"]);
    cdp = await connect();
    await sleep(1500);
    await injectKnife(); // 重载把页里注入的刀冲掉了,再下一次
  };
  // 阴性对照的样式刀(`W161_KNIFE=css`):把这一轮几处 CSS 修法页内改回坏的样子,对应那几格应当红(重载后再注入)。
  // 行为那几刀落不进页内(打包后的逻辑改不了),要重建整包,见 .zjshots/W4-fix/M1/report.md。
  const KNIFE_CSS = [
    ".bkup-item-state{flex:1 1 auto !important}", // A19 验证钮被挤下行
    ".ftext::-webkit-search-cancel-button{display:block !important}", // A35 过滤框歇着时照旧给 × 留位
    ".row.wrap{flex-wrap:nowrap !important}.row.wrap>.grow{flex:1 !important}", // A35 钮里折字
    ".bkup-code{word-break:break-all !important}", // A18 一组拆两行
    ".kv .v{word-break:break-all !important}", // A35 长词中间断
    ":root:lang(en){--font-sans:system-ui !important}", // A35 弯撇号全角
    ".head-acts .ghost.on{font-weight:400 !important}", // WM-29 顶栏点亮
    ".error.neutral{background:var(--ok) !important}", // A36 中性条变回绿
  ].join("\n");
  const injectKnife = async () => {
    if (process.env.W161_KNIFE !== "css") return;
    await evalJs(`(()=>{let k=document.getElementById("w161-knife");if(!k){k=document.createElement("style");k.id="w161-knife";document.head.appendChild(k)}k.textContent=${JSON.stringify(KNIFE_CSS)};return 1})()`);
  };
  await injectKnife();

  // ── 前置 ────────────────────────────────────────────────────────────────────
  if (!step("前置-app 在前台", (await focusedPkg()) === PKG, await focusedPkg())) return out;
  if (!step("前置-界面语言中文", (await evalJs(`document.documentElement.lang`)) === "zh")) return out;
  if (!step("前置-首启告知已同意", (await evalJs(`document.documentElement.dataset.privacy`)) === "ok")) return out;
  if (!step("前置-竖屏手机宽", !(await evalJs(`document.body.classList.contains("widescreen")`)))) return out;
  await dropIme();
  await clearBar();
  await closePanes();
  const configured = await evalJs(`(async()=>{const I=window.__TAURI__.core.invoke;const s=(await I("list_spaces")).find(x=>x.current).id;
    const st=await I("sync_status",{spaceId:s});return st.configured?(st.server_url||"?"):""})()`);

  // ── WM-29 / A19 / Q9:设置页 ───────────────────────────────────────────────
  await tapSel("#settings-toggle");
  step("WM-29 设置开了", await until(paneIs("settings-pane"), 3000));
  await sleep(400); // 906:备份那一节住进了二级页,首页不再有「从读取中…长出来」那一段
  step(
    "WM-29 页头有标题「设置」",
    await evalJs(`(()=>{const h=document.querySelector("#settings-pane > h2");return h&&h.textContent==="设置"&&h.getBoundingClientRect().height>0})()`),
  );
  step("WM-29 顶栏「设置」点亮(.on + 加粗)", await evalJs(`document.getElementById("settings-toggle").classList.contains("on")&&getComputedStyle(document.getElementById("settings-toggle")).fontWeight>=600`));
  step("WM-29 底栏一格都不亮", await evalJs(`![...document.querySelectorAll("#bottombar button")].some(b=>b.classList.contains("active"))`));
  if (await evalJs(`(()=>{const r=document.querySelector('#settings-pane [data-set-page="set-remind"]');return !!r&&!r.hidden})()`)) {
    await toSetPage("set-remind"); // 906:截止提醒那一节在它的二级页里(进页才画那两句)
    const sub = await evalJs(`document.getElementById("remind-sub").textContent`);
    step("Q9 截止提醒说明第一句是「开在屏幕上才响」", sub.startsWith("只有朱简开在屏幕上时才会响"), sub.slice(0, 40));
    // 应用评审取舍题 N4 起:常显的只有第一句,带天数的那几句住进节下的「说明」折叠(#remind-more;收着也读得到 textContent)。
    const more = await evalJs(`document.getElementById("remind-more").textContent`);
    step("Q9 说明里的范围含「3 天内」(与任务面到期钮同一个数;在「说明」折叠里)", /逾期、今天到期与 3 天内到期/.test(more), more);
  } else step("Q9 截止提醒说明", "skip", "这一端没有通知那一节");
  // A19:「复制」回执不推走下面那一节。906:意见反馈成了首页最后一节(「关于」住进了二级页)⇒ 「下面那一节的上沿」换成
  // 「这一页的总高」—— 回执要是又插回本节里,页面就长高;阈值照旧 < 1。
  await ensurePane("settings-pane", "#settings-toggle");
  const aboutTop0 = await (async () => {
    await centerDev("#feedback-copy");
    return evalJs(`document.scrollingElement.scrollHeight`);
  })();
  await clearBar();
  await tapSel("#feedback-copy");
  const fb = await until(`!document.getElementById("error").hidden&&/邮箱地址已复制/.test(document.getElementById("error").textContent)`, 3000);
  step("A19 「复制」回执走顶上提示条(绿)", fb && (await evalJs(`document.getElementById("error").classList.contains("notice")`)), await barText());
  const aboutTop1 = await evalJs(`document.scrollingElement.scrollHeight`);
  step("A19 回执没把下面的东西往下推(页面没长高)", Math.abs(aboutTop1 - aboutTop0) < 1, `${aboutTop0} → ${aboutTop1}`);
  step("A19 本节里没有那行常驻灰字", await evalJs(`!document.getElementById("feedback-msg")`));
  await clearBar();
  // WM-29 后半(903 用户拍反过来):关了再开从最上面开始(y0 > 0 是自证前置);细判在 cdp-acceptance-picks-q.mjs 的 Q2
  const y0 = await evalJs(`(()=>{const se=document.scrollingElement;se.scrollTop=Math.round(se.scrollHeight*0.45);return se.scrollTop})()`);
  await sleep(300);
  await tapSel("#settings-toggle");
  await until(`!document.body.classList.contains("pane-open")`, 3000);
  await tapSel("#settings-toggle");
  await until(paneIs("settings-pane"), 3000);
  await sleep(500);
  const y1 = await evalJs(`document.scrollingElement.scrollTop`);
  step("WM-29 重开设置从最上面开始", y0 > 100 && y1 < 2, `${y0} → ${y1}`);

  // ── A11 / A10 / Q5:设置 → 诊断 → 返回 ──────────────────────────────────────
  await evalJs(`(()=>{document.getElementById("url").value=${JSON.stringify(PROBE_URL)};
    document.getElementById("probe").innerHTML='<span id="w161-old">OLD-RESULT</span>';return 1})()`);
  await centerDev("#settings-diag-btn");
  const yDiag = await evalJs(`document.scrollingElement.scrollTop`);
  await tapSel("#settings-diag-btn");
  step("A11 设置 →「诊断」开了", await until(paneIs("diag"), 3000));
  step("A10 进页那一刻旧结果不在了", await evalJs(`!document.getElementById("w161-old")`));
  step("A11 诊断开着时顶栏亮的还是「设置」(它的上一层)", await evalJs(`document.getElementById("settings-toggle").classList.contains("on")`));
  if (configured) {
    step("A10 地址框是当前空间配的那台服务器", (await evalJs(`document.getElementById("url").value`)) === configured, configured);
    // 再把框改成没人听的端口自测(别去连用户那台)
    await evalJs(`(()=>{document.getElementById("url").value=${JSON.stringify(PROBE_URL)};return 1})()`);
    await tapSel("#run");
  } else step("A10 地址框没账户时留着上回填的", (await evalJs(`document.getElementById("url").value`)) === PROBE_URL);
  const verdictOk = await until(`!!document.querySelector("#probe .probe-verdict")`, 15000);
  const verdict = await evalJs(`document.querySelector("#probe .probe-verdict")?.textContent ?? ""`);
  step(
    "Q5 自检最上面一句人话结论(连不上那句,逐字)",
    verdictOk && verdict === `连不上 ${PROBE_URL}:看看地址对不对、服务器开没开、网络通不通。`,
    verdict,
  );
  step("Q5 结论排在术语那几行上面", await evalJs(`document.querySelector("#probe").firstElementChild?.classList.contains("probe-verdict")&&!!document.querySelector("#probe .step")`));
  step("Q15 诊断页那一节叫「网络自检」", await evalJs(`[...document.querySelectorAll("#diag h2")].some(h=>h.textContent==="网络自检")`));
  step(
    "Q5 复制前那句说清带走什么",
    await evalJs(`(()=>{const p=document.getElementById("diag-copy").closest(".row").nextElementSibling;return !!p&&/设备的编号/.test(p.textContent)&&/不含你记的内容和密钥/.test(p.textContent)})()`),
  );
  await clearBar();
  await tapSel("#diag-copy");
  step("Q5 「复制诊断信息」有回执", await until(`/诊断信息已复制/.test(document.getElementById("error").textContent)&&!document.getElementById("error").hidden`, 4000), await barText());
  // 真粘贴回读(skill:判复制成没成别信回执)
  await evalJs(`(()=>{const t=document.createElement("textarea");t.id="w161-paste";t.style.cssText="position:fixed;left:20px;top:200px;width:300px;height:120px;z-index:99";document.body.appendChild(t);return 1})()`);
  await tapSel("#w161-paste");
  await sleep(500);
  await adb(["shell", "input", "keyevent", "279"]);
  await sleep(600);
  const pasted = await evalJs(`document.getElementById("w161-paste").value`);
  step(
    "Q5 粘贴回读:版本 / [本机库] / [网络自检] / 结论 / device_id 都在",
    /^朱简 v\d/.test(pasted) && pasted.includes("[网络自检]") && pasted.includes(verdict) && /device_id: \S+/.test(pasted) && pasted.includes(PROBE_URL),
    pasted.slice(0, 160).replaceAll("\n", " ⏎ "),
  );
  await evalJs(`(()=>{document.getElementById("w161-paste").remove();return 1})()`);
  await dropIme();
  await clearBar();
  await back();
  step("A11 诊断上按返回 = 回设置", await until(paneIs("settings-pane"), 3000));
  await ensurePane("settings-pane", "#settings-toggle");
  step("A11 回来时还在点进去的那个位置", Math.abs((await evalJs(`document.scrollingElement.scrollTop`)) - yDiag) < 30, `${yDiag} → ${await evalJs(`document.scrollingElement.scrollTop`)}`);
  await tapSel("#settings-spaces-btn");
  step("A11 设置 →「空间…」开了", await until(paneIs("spaces"), 3000));
  await back();
  step("A11 空间上按返回 = 回设置", await until(paneIs("settings-pane"), 3000));
  await ensurePane("settings-pane", "#settings-toggle");

  // ── A12 / A34 / A11:政策全文 ───────────────────────────────────────────────
  await toSetPage("set-about"); // 906:「关于」是设置的二级页
  step(
    "A12 「关于」里有三份(隐私政策 / 隐私权利 / 用户协议)",
    (await evalJs(`[...document.querySelectorAll("#set-about [data-policy]")].map(b=>b.textContent).join("/")`)) === "隐私政策/隐私权利/用户协议",
  );
  const hist0 = await evalJs(`history.length`);
  await tapSel(`#set-about [data-policy="terms.html"]`);
  step("A12 点「用户协议」开的是应用内那一页", await until(shown("policy-view"), 3000));
  step("A34 上方那行是用户协议的地址", await until(`/\\/terms\\.html$/.test(document.getElementById("policy-canonical").textContent)`, 3000), await evalJs(`document.getElementById("policy-canonical").textContent`));
  step("A34 「这一份就是适用于你这一只的」那句在", await evalJs(`[...document.querySelectorAll("#policy-view .fine")].some(p=>/适用于你手上这一只朱简/.test(p.textContent))`));
  // 框从不导航(main.ts::showPolicyPage:取回来写进框里)⇒ 框里是哪一份读 data-page,框的地址读不出
  const loaded = await until(`(()=>{const f=document.getElementById("policy-frame");const d=f.contentDocument;return f.dataset.page==="terms.html"&&!!d&&!!d.querySelector('a[href="privacy.html"]')})()`, 6000);
  if (loaded) {
    // 框里真点「隐私政策」那个页签
    const c = JSON.parse(
      await evalJs(`(()=>{const f=document.getElementById("policy-frame");const a=f.contentDocument.querySelector('a[href="privacy.html"]');
        const fr=f.getBoundingClientRect(),r=a.getBoundingClientRect();
        return JSON.stringify([Math.round((fr.left+r.left+r.width/2)*devicePixelRatio),Math.round((fr.top+r.top+r.height/2)*devicePixelRatio)])})()`),
    );
    await adb(["shell", "input", "tap", String(c[0]), String(c[1])]);
    step("A34 框里切到「隐私政策」,上方那行跟着换", await until(`/\\/privacy\\.html$/.test(document.getElementById("policy-canonical").textContent)`, 5000), await evalJs(`document.getElementById("policy-canonical").textContent`));
    step("A11 框里切页签不留历史(整页历史条数不变)", (await evalJs(`history.length`)) === hist0, `${hist0} → ${await evalJs(`history.length`)}`);
  } else step("A34 框里的页签", false, "政策页没载出来");
  await back();
  await sleep(600);
  // 906:回到的是开它的那一页 =「关于」(设置的二级页)
  step("A11 政策页上一记返回就收面板、回到设置(「关于」那一页)", (await evalJs(`document.getElementById("policy-view").hidden`)) && (await evalJs(paneIs("set-about"))));
  await toSetPage("set-about");
  step("A11 …而且 app 还在前台", (await focusedPkg()) === PKG, await focusedPkg());
  step("A34 告知页链接不是浏览器默认蓝", (await evalJs(`getComputedStyle(document.getElementById("privacy-link")).color`)) !== "rgb(0, 0, 238)", await evalJs(`getComputedStyle(document.getElementById("privacy-link")).color`));
  step("WM-30 「不同意并退出」", (await evalJs(`document.getElementById("privacy-decline").textContent`)) === "不同意并退出");

  // ── Q11 WM-32 / Q10:关于 ──────────────────────────────────────────────────
  await toSetPage("set-about");
  await tapSel("#about-feedback-link");
  await sleep(900);
  // 906:意见反馈在设置首页的最末 ⇒ 点了 = 回首页并滚到那一节;那一节贴着页底、滚不到「离顶 160 以内」时,判「页面已滚到底、那一节整个在屏内」。
  step(
    "WM-32 「意见反馈」是链接,点了滚到那一节",
    await evalJs(`(()=>{if(document.getElementById("settings-pane").hidden)return false;const t=document.getElementById("feedback-title").getBoundingClientRect().top;const se=document.scrollingElement;
      const atEnd=se.scrollTop>=se.scrollHeight-innerHeight-2;const b=document.getElementById("feedback-copy").getBoundingClientRect().bottom;return t>=0&&(t<160||(atEnd&&b<=innerHeight))})()`),
    await evalJs(`document.getElementById("feedback-title").getBoundingClientRect().top`),
  );
  step("WM-32 邮箱那一框看得出能点(安卓)", await evalJs(`document.getElementById("feedback-mail").classList.contains("mail-link")`));
  if (await evalJs(`!!document.getElementById("update-check")`)) {
    await clearBar();
    await toSetPage("set-about");
    await tapSel("#update-check");
    const said = await until(`(()=>{const e=document.getElementById("error");return (!e.hidden&&/已是最新 v|没查成/.test(e.textContent))||!document.getElementById("update").hidden})()`, 15000);
    step("Q10 「检查更新」有回音(已是最新 / 新版提示 / 没查成)", said, (await barText()) || (await evalJs(`document.getElementById("update-msg").textContent`)));
    await clearBar();
  } else step("Q10 「检查更新」", "skip", "这条渠道没有应用内更新(那一行被摘了)");

  // ── A18 / WM-35:备份码框(还没设置备份时)─────────────────────────────────
  await toSetPage("set-backup"); // 906:备份是设置的二级页
  await until(`(()=>{const b=document.getElementById("backup-body");return b.childElementCount>0&&!/读取中/.test(b.innerText)})()`, 8000);
  const setupBtn = await evalJs(`(()=>{const b=[...document.querySelectorAll("#backup-body button")].find(x=>x.textContent==="设置备份");if(!b)return false;b.id="w161-setup";return true})()`);
  if (setupBtn) {
    await tapSel("#w161-setup");
    const has = await until(`!!document.querySelector("#backup-body textarea.bkup-code")`, 4000);
    await dropIme();
    if (has) {
      const k = JSON.parse(
        await evalJs(`(()=>{const t=document.querySelector("#backup-body textarea.bkup-code");const cs=getComputedStyle(t);
          // 一组拆没拆:同宽同字的镜像 div 里逐组量行数
          const m=document.createElement("div");m.className="bkup-code";m.style.cssText="position:absolute;left:-9999px;top:0;width:"+t.getBoundingClientRect().width+"px";
          const groups=t.value.split("-\\u200b");m.innerHTML=groups.map((g,i)=>'<span data-g>'+g+(i<groups.length-1?"-":"")+"</span>").join("\\u200b");
          document.body.appendChild(m);const split=[...m.querySelectorAll("[data-g]")].filter(s=>s.getClientRects().length>1).length;
          const lines=new Set([...m.querySelectorAll("[data-g]")].map(s=>Math.round(s.getBoundingClientRect().top))).size;m.remove();
          t.select();const dt=new DataTransfer();t.dispatchEvent(new ClipboardEvent("copy",{clipboardData:dt,bubbles:true,cancelable:true}));
          const copied=dt.getData("text/plain");t.setSelectionRange(0,0);
          return JSON.stringify({ro:t.readOnly,wb:cs.wordBreak,ow:cs.overflowWrap,fits:t.scrollHeight<=t.clientHeight+1,split,lines,zw:t.value.includes("\\u200b"),copied,clean:!/\\u200b/.test(copied)&&/^[0-9A-Z]{4}(-[0-9A-Z]{4})+$/.test(copied)})})()`),
      );
      step("WM-35 备份码是只读文本框(长按「全选」只选框里)", k.ro);
      step("A18 码框不按字折(word-break / overflow-wrap 都是 normal)", k.wb === "normal" && k.ow === "normal", `${k.wb}/${k.ow}`);
      step("A18 一组都不拆在两行(镜像量)", k.split === 0 && k.lines >= 2, `拆开的组 ${k.split},行数 ${k.lines}`);
      step("A18 框高正好装下(不藏行)", k.fits);
      step("WM-35 复制出来就是那串码(不夹零宽空格)", k.zw && k.clean, k.copied);
    } else step("A18 备份码框", false, "点了「设置备份」没出码");
    const cancel = await evalJs(`(()=>{const b=[...document.querySelectorAll("#backup-body button")].find(x=>x.textContent==="取消");if(!b)return false;b.id="w161-cancel";return true})()`);
    if (cancel) await tapSel("#w161-cancel");
    step("A18 收场:取消后回到「还没设置」", await until(`[...document.querySelectorAll("#backup-body button")].some(x=>x.textContent==="设置备份")`, 4000));
  } else step("A18 / WM-35 备份码框", "skip", "这台已经设置过备份(或这一端没有备份)");

  // ── A19 / A31 几何半截:验证结论长了,钮不下行(假行量 CSS)────────────────────
  const row = JSON.parse(
    await evalJs(`(()=>{const w=document.createElement("div");w.className="bkup-item";w.id="w161-row";
      w.innerHTML='<div class="bkup-item-main"><span class="bkup-item-name">默认空间 · 2026-11-06 05:02</span><div class="bkup-item-sub"><span class="bkup-item-meta">200 KB</span><span class="bkup-item-state">现在打得开:一个名字起得很长很长的空间 · 1.2 MB</span></div></div><button class="ghost">验证</button><span class="bkup-item-file" hidden>zhujian-main-20261105T210253Z-01M6PRB3XXXXXXXXXXXXXXXXXX.zjbak</span>'; // 906:行的结构同 backup.ts::listRow(文件名平时收着)
      document.getElementById("backup-body").appendChild(w);const s=w.querySelector(".bkup-item-state").getBoundingClientRect(),b=w.querySelector("button").getBoundingClientRect(),m=w.querySelector(".bkup-item-meta").getBoundingClientRect();
      const r={sameRow:b.top<s.bottom&&b.bottom>s.top&&Math.abs(m.top-s.top)<20,right:b.right>s.right};w.remove();return JSON.stringify(r)})()`),
  );
  step("A19 验证结论长了,「验证」钮仍在同一行的右边", row.sameRow && row.right, JSON.stringify(row));

  // ── A13 + A35 英文:改语言重载后回到语言那一行 ────────────────────────────────
  await ensurePane("settings-pane", "#settings-toggle"); // 906:上一段停在「备份」那一页,语言那一排在设置首页
  await tapSel(`#lang-seg [data-lang="en"]`);
  await reconnect();
  const enOk = await until(`document.documentElement.lang==="en"`, 12000);
  step("A13 切英文:重载了", enOk);
  step("A13 重载完落在设置", await until(paneIs("settings-pane"), 8000));
  await ensurePane("settings-pane", "#settings-toggle");
  step("A13 语言那一行在屏上", await evalJs(`(()=>{const r=document.getElementById("lang-seg").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`));
  const q = JSON.parse(
    await evalJs(`(()=>{const s=document.createElement("span");s.style.cssText="position:absolute;left:-9999px;font-family:var(--font-sans);font-size:20px;white-space:pre";
      document.body.appendChild(s);const w=t=>{s.textContent=t;return s.getBoundingClientRect().width};const r={q:w("\\u2019"),dq:w("\\u201c"),n:w("n")};s.remove();return JSON.stringify(r)})()`),
  );
  step("A35 英文档的弯撇号 / 弯引号不再是全角宽(20px 字号下 < 10px)", q.q < 10 && q.dq < 12, JSON.stringify(q));
  await tapSel(`#lang-seg [data-lang="auto"]`);
  await reconnect();
  step("A13 切回自动:重载了、回到中文", await until(`document.documentElement.lang==="zh"`, 12000));
  step("A13 …又落在设置的语言那一行", (await until(paneIs("settings-pane"), 8000)) && (await evalJs(`(()=>{const r=document.getElementById("lang-seg").getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()`)));
  await ensurePane("settings-pane", "#settings-toggle");
  step("A13 那一笔用完就清(不会每次重启都跳回设置)", await evalJs(`sessionStorage.getItem("zhujian.reopen-at")===null`));
  await back();
  await until(`!document.body.classList.contains("pane-open")`, 3000);

  // ── A11 同步那一层 + Q4 + A35 同步页那排钮 ─────────────────────────────────────
  await tapSel("#sync-toggle");
  step("A11 同步开了、顶栏「同步」点亮", (await until(paneIs("sync"), 3000)) && (await evalJs(`document.getElementById("sync-toggle").classList.contains("on")`)));
  if (await evalJs(`!document.getElementById("sync-spaces-btn").hidden`)) {
    await tapSel("#sync-spaces-btn");
    await until(paneIs("spaces"), 3000);
    await back();
    step("A11 同步 →「空间…」→ 返回 = 回同步", await until(paneIs("sync"), 3000));
    await ensurePane("sync", "#sync-toggle");
  } else step("A11 同步 →「空间…」", "skip", "同步页那枚「空间…」此刻不在");
  // 同步面上的一枚「网络自检」(红条 / 状态行里那枚同一个委托)→ 诊断 → 返回 = 回同步
  await evalJs(`(()=>{const b=document.createElement("button");b.type="button";b.className="err-next";b.id="w161-errnext";
    b.setAttribute("data-err-next","");b.setAttribute("data-err-url",${JSON.stringify(PROBE_URL)});b.textContent="网络自检";
    document.getElementById("sync-title").after(b);return 1})()`);
  await tapSel("#w161-errnext");
  step("A11 同步面「网络自检」→ 诊断", await until(paneIs("diag"), 3000));
  step("Q4 测的是那枚钮带着的地址", (await evalJs(`document.getElementById("url").value`)) === PROBE_URL);
  await back();
  step("A11 诊断上按返回 = 回同步(面板还在)", await until(paneIs("sync"), 3000));
  await ensurePane("sync", "#sync-toggle");
  await evalJs(`(()=>{document.getElementById("w161-errnext")?.remove();return 1})()`);
  if (!configured) {
    // A35:标准字号下这排两枚都不在钮里折字
    const wrapRow = JSON.parse(
      await evalJs(`(()=>{const lines=(b)=>{if(b.hidden)return null;const r=document.createRange();r.selectNodeContents(b);return new Set([...r.getClientRects()].map(x=>Math.round(x.top))).size};
        const a=document.getElementById("sync-alt-pair"),c=document.getElementById("sync-alt-create");return JSON.stringify({a:lines(a),c:lines(c)})})()`),
    );
    // 非默认空间里「手动输入配对码」那枚本来就不在(只有建账户一条路,sync.ts::renderSync)⇒ 只量在屏上的那几枚
    step("A35 同步页那排钮(在屏上的)不在钮里折两行", [wrapRow.a, wrapRow.c].every((n) => n === null || n === 1) && wrapRow.c === 1, JSON.stringify(wrapRow));
    // Q4
    if (await evalJs(`document.getElementById("sync-create").hidden`)) await tapSel("#sync-alt-create");
    await until(shown("sync-create"), 2000);
    const server0 = await evalJs(`document.getElementById("sync-server").value`);
    await evalJs(`(()=>{document.getElementById("sync-server").value=${JSON.stringify(PROBE_URL)};return 1})()`);
    await clearBar();
    await tapSel("#sync-create-btn");
    const formErr = await until(shown("sync-form-err"), 8000);
    const fe = await evalJs(`document.getElementById("sync-form-err").textContent`);
    // 161 / W4 A8(M2):「连不上」按原话分开说了 —— 打到没人听的端口是「连不上服务器:服务器可能没开,或者地址、端口不对」。
    step("Q4 连不上那句留在表单里", formErr && /^连不上服务器:服务器可能没开/.test(fe), fe);
    step(
      "Q4 …带「网络自检」,测的是刚填的那个地址",
      await evalJs(`document.querySelector("#sync-form-err .err-next")?.getAttribute("data-err-url")===${JSON.stringify(PROBE_URL)}&&document.querySelector("#sync-form-err .err-next").textContent==="网络自检"`),
    );
    step("Q15 顶上红条那枚也叫「网络自检」", await evalJs(`[...document.querySelectorAll("#error .bar-act")].some(b=>b.textContent==="网络自检")`));
    await until(`document.getElementById("error").hidden`, 9000);
    step("Q4 红条收了,表单里那句还在", (await evalJs(`document.getElementById("error").hidden`)) && (await evalJs(shown("sync-form-err"))));
    await evalJs(`(()=>{const s=document.getElementById("sync-server");s.value=${JSON.stringify(server0)};s.dispatchEvent(new Event("input",{bubbles:true}));return 1})()`);
    step("Q4 改了地址就清", await evalJs(`document.getElementById("sync-form-err").hidden`));
    await tapSel("#sync-alt-create"); // 收表单
  } else {
    step("A35 同步页那排钮", "skip", "当前空间已开同步,那一排不在");
    step("Q4 表单里留那句", "skip", "当前空间已开同步,没有建账户那张表");
  }
  await closePanes();

  // ── A35 杂项几何 ───────────────────────────────────────────────────────────
  // 特大字号(130,经桥临时调、不写盘)下,把占位那三个字当值放进框里:放得下(scrollWidth 不超)= 没给清除钮留位。
  // ⚠ 伪元素的 getComputedStyle 在这一端读不到它(恒报 block),只能量;刀(把那块清除钮放回来)下这一格 86 > 76。
  const ftw = JSON.parse(
    await evalJs(`(async()=>{const ft=document.getElementById("filter-text");if(!ft.offsetWidth)return "null";const ts=window.__zhujianTextSize;
      if(!ts)return JSON.stringify({skip:true});ts.set(130);await new Promise(r=>setTimeout(r,700));const v0=ft.value;ft.value=ft.placeholder;
      const r={sw:ft.scrollWidth,cw:ft.clientWidth,ph:ft.placeholder};ft.value=v0;ts.set(Number(localStorage.getItem("zhujian.textsize"))||100);
      await new Promise(r=>setTimeout(r,400));return JSON.stringify(r)})()`),
  );
  if (!ftw || ftw.skip) step("A35 过滤框歇着时不给清除钮留位", "skip", ftw ? "这一端没有字号桥" : "过滤框不在屏上(时间轴没卡?)");
  else step("A35 特大字号下「过滤…」整个放得下(歇着时不给清除钮留位)", ftw.sw <= ftw.cw, JSON.stringify(ftw));
  step("A35 关于 / 诊断那几格长词不在中间断(overflow-wrap:anywhere,不是 break-all)", await evalJs(`(()=>{const k=document.createElement("span");k.className="v";document.getElementById("about").appendChild(k);const cs=getComputedStyle(k);const r=cs.wordBreak!=="break-all"&&cs.overflowWrap==="anywhere";k.remove();return r})()`));
  step("A35 冷启首帧底色那座桥在", await evalJs(`typeof window.__zhujianLaunchTheme?.remember==="function"`));

  // ── A36:零篇长文时「长文」→ 一个字不写退出 ─────────────────────────────────
  const docs = await evalJs(`(async()=>{const I=window.__TAURI__.core.invoke;const s=(await I("list_spaces")).find(x=>x.current).id;return (await I("list_timeline",{spaceId:s})).filter(i=>i.kind==="doc").length})()`);
  if (docs === 0) {
    await tapSel("#capture-fab");
    await until(`document.getElementById("compose-card").classList.contains("open")`, 3000);
    await sleep(400);
    await tapSel("#compose-doc");
    const inDocs = await until(paneIs("docs-pane"), 3000);
    step("A36 进了长文面", inDocs);
    step("A36 零篇时底栏不冒「长文」格(编辑时)", await evalJs(`document.querySelector('#bottombar [data-pane="docs"]').hidden`));
    await clearBar();
    await dropIme();
    await back();
    const said = await until(`/没有建/.test(document.getElementById("error").textContent)&&!document.getElementById("error").hidden`, 4000);
    // 判到视觉本体(条的底色),别只判 class:中性那档 = 墨底(--ink),绿条 = --ok
    const barBg = await evalJs(`(()=>{const e=document.getElementById("error");const p=document.createElement("i");p.style.cssText="color:var(--ok);display:none";document.body.appendChild(p);const ok=getComputedStyle(p).color;p.style.color="var(--ink)";const ink=getComputedStyle(p).color;p.remove();return JSON.stringify({bg:getComputedStyle(e).backgroundColor,ok,ink})})()`);
    const bb = JSON.parse(barBg);
    step("A36 「一个字没写,这篇没有建」是中性那档(墨底)、不是绿条", said && bb.bg === bb.ink && bb.bg !== bb.ok, `${await barText()} ${barBg}`);
    step("A36 退出后底栏也没有「长文」格", await evalJs(`document.querySelector('#bottombar [data-pane="docs"]').hidden`));
    await clearBar();
    await closePanes();
  } else step("A36 零篇长文", "skip", `这个空间有 ${docs} 篇长文`);

  // ── 收尾:守门账目是平的 ⇒ 无层态一记返回就退到桌面 ─────────────────────
  await dropIme();
  await clearBar();
  await evalJs(`(()=>{document.getElementById("w161-knife")?.remove();return 1})()`); // 刀不留在页里(拉回前台不重载,留着就污染下一趟)
  step("收尾-前置-无面", await evalJs(`!document.body.classList.contains("pane-open")`));
  cdp.close();
  await back();
  await sleep(1200);
  const fgEnd = await focusedPkg();
  step("收尾-一记返回即退(子页 / 政策页没留空炮)", fgEnd !== PKG, fgEnd);
  await adb(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
  await sleep(2500);

  out.pass = out.steps.every((s) => s.ok === true || s.ok === "SKIPPED");
  return out;
};

main()
  .then((o) => {
    console.log(JSON.stringify(o, null, 1));
    process.exit(o.pass ? 0 : 1);
  })
  .catch((e) => {
    console.log(JSON.stringify({ ...out, pass: false, error: String(e?.stack ?? e) }, null, 1));
    process.exit(1);
  });
