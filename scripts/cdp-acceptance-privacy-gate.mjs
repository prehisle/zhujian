// 首启隐私政策告知(651)的三条路,在设备上真走一遍:
//   ① 没同意过 ⇒ 闸挡在最前面(fail-closed:键不在 = 重新问)、政策网址印在页上;
//   ② 「阅读完整隐私政策」⇒ **应用内**展开烤进包里的那份(不跳浏览器,鸿蒙上没有 xdg-open),
//      三份协议互链都指向包内(没有一条 href 指回 `/` 或外网 —— 那是 policy-asset.mjs 的承诺);
//   ③ 「关闭」回到闸;④ 「不同意」⇒ **进程真的退了**(`app_exit` = `std::process::exit`,
//      `AppHandle::exit` 在鸿蒙上是空操作;「退出」失灵的样子就是「什么也没发生」),
//      且什么都没记住 ⇒ 重启后闸**再次**在场;⑤ 「同意」⇒ 闸撤、启动继续到时间轴;⑥ reload 不再问。
//
// 跑法(驱动形;多台设备同连时先 `export ANDROID_SERIAL=<serial>`):
//   node scripts/android-cdp.mjs forward
//   node scripts/cdp-acceptance-privacy-gate.mjs      # 打印 {pass, steps, initialPrivacy, restored}
//
// 为什么是驱动形:④ 要靠 adb 判进程没了、再把 app 拉起来并重建 forward(devtools socket 名里带
// pid,重启就换),页内脚本够不着这一段(skill 的分界:要调 adb 的只能是驱动形)。
// ⚠ 它**改设备态**:先清掉 `zhujian.privacy` 再走一遍,收尾按起跑时的值还回去(起跑已同意 ⇒
//   末态照旧已同意;起跑没同意过 ⇒ 把键再摘掉,下次启动照旧会问)。⛔ 不写库:闸挡在装配之前。
// ⚠ 每一下都是 `Input.dispatchTouchEvent` 真触摸(合成 click 穿得过遮挡,证明不了「手指点得到」);
//   538 那形(轻点偶尔不落上)按「点 → 看动没动 → 再点」处理,落在第几次记进 detail。
//
// 阴性对照(三把,各守一根轴;**都在 2026-09-12 MuMu 上真跑过**,x86_64 devtools 包,663 那只构建 ——
// 闸这段代码从 651 起一字未改,见 669):`ZJ_KNIFE=<刀名> node scripts/cdp-acceptance-privacy-gate.mjs`。
// 三把都是**页内注入**(594 那条分界:要验的是「点下去之后这一层怎么处置」,直接在页内改那颗钮就够,
// 零重建);⚠ 它们代演的是「代码本该做的事没做」,不是「代码改坏成什么样」——要验 Rust 那半真坏了
// (比如把 app_exit 换回 AppHandle::exit)得重建整包,651 在鸿蒙真机上就是那么栽出来的。
//  A. href-external ✅ 往包内那页塞回一条外链 ⇒ 红一格「② 页内每条 href 都指向三份之一」,其余十格照常绿。
//  B. decline-noop  ✅ 把「不同意」的监听摘掉(= 一颗点了没反应的钮)⇒ 红在「④ 进程 6s 内退出」,
//     随即响亮停(后面的格无从谈起),退出码 2。⚠ 这把跑完设备停在「键已清、闸开着」,下一趟先把键还回去。
//  C. agree-nopersist ✅ 「同意」只撤闸不落键 ⇒ 红两格:「⑤ 键落 1 / 启动继续」与「⑥ reload 后不再问」
//     (reload 之后闸又在场了,正是 fail-closed 的反面样子)。
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { openSession, pageTarget, sleep, touchSwipe } from "./lib/cdp.mjs";

const execFile = promisify(execFileCb);
const PORT = Number(process.env.CDP_PORT || 9222);
const PKG = "app.zhujian.notebook";
const KEY = "zhujian.privacy";
// 阴性对照的刀(见文件头):`ZJ_KNIFE=href-external|decline-noop|agree-nopersist`,平时空。
const KNIFE = process.env.ZJ_KNIFE || "";

const pidof = async () => (await execFile("adb", ["shell", "pidof", PKG]).catch(() => ({ stdout: "" }))).stdout.trim();

const steps = [];
const step = (name, ok, detail) => {
  steps.push({ name, ok: !!ok, detail });
  console.error(`${ok ? "PASS" : "FAIL"}  ${name}  ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return !!ok;
};

// 页内助手:每段各自 IIFE(391:同一全局作用域,顶层 const 第二次就 SyntaxError)。
const rectOf = (sel) => `(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)return null;
  const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}})()`;
const gateState = `(()=>{const g=document.getElementById("privacy-gate");const pv=document.getElementById("policy-view");
  const c=document.elementFromPoint(innerWidth/2, innerHeight/2);
  return {key:localStorage.getItem(${JSON.stringify(KEY)}), dataPrivacy:document.documentElement.dataset.privacy??null,
    gateDisplay:getComputedStyle(g).display, gateZ:getComputedStyle(g).zIndex,
    policyHidden:pv.hidden, policyDisplay:getComputedStyle(pv).display, policyZ:getComputedStyle(pv).zIndex,
    centerInGate:!!(c&&g.contains(c)), canonical:document.getElementById("policy-canonical").textContent,
    startupGateHidden:document.getElementById("gate").hidden, cards:document.querySelectorAll("#timeline [data-id]").length}})()`;

async function connect() {
  const t = await pageTarget(PORT);
  return openSession(t.webSocketDebuggerUrl, { timeoutMs: 15000 });
}

/** 真触摸 sel 的中心;`moved()` 说动了才算落上,最多三次,返回落在第几次(0 = 三次都没动)。 */
async function tap(s, sel, moved) {
  for (let i = 1; i <= 3; i++) {
    const r = await s.evaluate(rectOf(sel));
    if (!r) throw new Error(`找不到 ${sel}`);
    await touchSwipe(s, r.x, r.y, r.x, r.y, 2);
    for (let k = 0; k < 20; k++) {
      await sleep(100);
      if (await s.evaluate(moved)) return i;
    }
  }
  return 0;
}

/** 等 app 进程起来、WebView 可调试、页面就绪;重建 forward(socket 名带 pid)。 */
async function relaunch() {
  await execFile("adb", ["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
  let pid = "";
  for (let i = 0; i < 40 && !pid; i++) {
    await sleep(250);
    pid = await pidof();
  }
  if (!pid) throw new Error("重启后 8s 内进程没起来");
  let s = null;
  for (let i = 0; i < 20 && !s; i++) {
    await sleep(500);
    try {
      await execFile("node", ["scripts/android-cdp.mjs", "forward"]);
      s = await connect();
    } catch {
      s = null;
    }
  }
  if (!s) throw new Error("重启后 10s 内连不上 WebView 的调试口");
  for (let i = 0; i < 40; i++) {
    if (await s.evaluate(`document.readyState==="complete" && !!document.getElementById("privacy-gate")`)) break;
    await sleep(250);
  }
  return { s, pid };
}

async function main() {
  let s = await connect();
  const initialPrivacy = await s.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`);
  let restored = null;
  try {
    // ① 清键 → reload ⇒ 闸在场并盖住页面中心;政策网址印在页上
    await s.evaluate(`(()=>{localStorage.removeItem(${JSON.stringify(KEY)});location.reload();return 1})()`);
    await sleep(1500);
    s.close();
    s = await connect();
    let st = null;
    for (let i = 0; i < 40; i++) {
      st = await s.evaluate(gateState).catch(() => null);
      if (st && st.canonical) break;
      await sleep(250);
    }
    step("① 键不在 ⇒ 闸在场、盖住页面中心", st && st.key === null && st.dataPrivacy === null && st.gateDisplay !== "none" && st.centerInGate, st);
    step("① 政策网址印在闸上", st && /^https:\/\/\S+\/privacy\.html$/.test(st.canonical), st?.canonical);

    // ② 「阅读完整隐私政策」⇒ 应用内展开,压在闸之上;iframe 载的是包内那份,互链全在包内
    const linkHit = await tap(s, "#privacy-link", `!document.getElementById("policy-view").hidden`);
    st = await s.evaluate(gateState);
    step("② 真触摸链接 ⇒ 政策全文在应用内展开、压在闸之上", linkHit > 0 && !st.policyHidden && st.policyDisplay === "flex" && Number(st.policyZ) > Number(st.gateZ), { hitOn: linkHit, policyDisplay: st.policyDisplay, policyZ: st.policyZ, gateZ: st.gateZ });
    let doc = null;
    for (let i = 0; i < 40; i++) {
      doc = await s.evaluate(`(()=>{const f=document.getElementById("policy-frame");const d=f.contentDocument;
        if(!d||d.readyState!=="complete"||!d.body||d.body.innerText.length<200)return null;
        const hrefs=[...d.querySelectorAll("a[href]")].map(a=>a.getAttribute("href"));
        return {src:f.getAttribute("src"),loc:d.location.pathname,title:d.title,textLen:d.body.innerText.length,
          hrefs:[...new Set(hrefs)],bad:hrefs.filter(h=>!/^(privacy|privacy-rights|terms)\\.html$/.test(h))}})()`);
      if (doc) break;
      await sleep(250);
    }
    step("② iframe 载入包内 privacy.html,正文非空", doc && doc.src === "privacy.html" && /privacy\.html$/.test(doc.loc) && doc.textLen > 200, doc && { loc: doc.loc, title: doc.title, textLen: doc.textLen });
    if (KNIFE === "href-external" && doc) {
      // 刀:往包内那页塞回一条外链(policy-asset.mjs 本该摘掉的那种)
      await s.evaluate(`(()=>{const d=document.getElementById("policy-frame").contentDocument;d.querySelector("a[href]").setAttribute("href","https://zhujian.app/");return 1})()`);
      doc = await s.evaluate(`(()=>{const d=document.getElementById("policy-frame").contentDocument;const hrefs=[...d.querySelectorAll("a[href]")].map(a=>a.getAttribute("href"));
        return {src:"privacy.html",loc:d.location.pathname,title:d.title,textLen:d.body.innerText.length,hrefs:[...new Set(hrefs)],bad:hrefs.filter(h=>!/^(privacy|privacy-rights|terms).html$/.test(h))}})()`);
    }
    step("② 页内每条 href 都指向三份之一(没有 / 与外链)", doc && doc.bad.length === 0 && doc.hrefs.length >= 2, doc && { hrefs: doc.hrefs, bad: doc.bad });

    // ③ 互链:真触摸 iframe 里指向 privacy-rights.html 的那条 ⇒ iframe 导航到它(仍在包内)
    const linkPos = await s.evaluate(`(()=>{const f=document.getElementById("policy-frame");const d=f.contentDocument;
      const a=[...d.querySelectorAll('a[href="privacy-rights.html"]')][0];if(!a)return null;
      a.scrollIntoView({block:"center"});const fr=f.getBoundingClientRect();const r=a.getBoundingClientRect();
      return {x:fr.left+r.left+r.width/2,y:fr.top+r.top+r.height/2,visible:r.top>=0&&r.bottom<=fr.height}})()`);
    let nav = null;
    if (linkPos) {
      await touchSwipe(s, linkPos.x, linkPos.y, linkPos.x, linkPos.y, 2);
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        nav = await s.evaluate(`(()=>{const d=document.getElementById("policy-frame").contentDocument;
          return d&&d.readyState==="complete"&&/privacy-rights\\.html$/.test(d.location.pathname)?{loc:d.location.pathname,textLen:d.body.innerText.length}:null})()`);
        if (nav) break;
      }
    }
    step("③ 真触摸互链 ⇒ iframe 走到包内 privacy-rights.html", nav && nav.textLen > 200, { linkPos, nav });

    // ③ 「关闭」⇒ 全文收起,闸仍在
    const closeHit = await tap(s, "#policy-close", `document.getElementById("policy-view").hidden`);
    st = await s.evaluate(gateState);
    step("③ 真触摸关闭 ⇒ 全文收起、闸仍在场", closeHit > 0 && st.policyHidden && st.gateDisplay !== "none" && st.centerInGate, { hitOn: closeHit, gateDisplay: st.gateDisplay });

    // ④ 「不同意」⇒ 进程退出;键没写 ⇒ 重启后闸再次在场
    if (KNIFE === "decline-noop") {
      // 刀:把「不同意」的监听摘掉 ⇒ 它成了一颗点了没反应的钮(651 在鸿蒙上 AppHandle::exit 的样子)
      await s.evaluate(`(()=>{const b=document.getElementById("privacy-decline");b.replaceWith(b.cloneNode(true));return 1})()`);
    }
    const pidBefore = await pidof();
    const r = await s.evaluate(rectOf("#privacy-decline"));
    // 这一下的**预期结果就是连接死掉**:进程在 touchEnd 落地那一刻退出,回应未必来得及回来
    // ⇒ 不等回应、不把连接断当失败(判据在下面的 pidof,不在 CDP 的回应里)。
    await Promise.race([touchSwipe(s, r.x, r.y, r.x, r.y, 2).catch(() => {}), sleep(3000)]);
    let gone = false;
    for (let i = 0; i < 30 && !gone; i++) {
      await sleep(200);
      gone = (await pidof()) === "";
    }
    try { s.close(); } catch {}
    step("④ 真触摸「不同意」⇒ 进程 6s 内退出", pidBefore && gone, { pidBefore, gone });
    if (!gone) throw new Error("进程没退,后面的格无从谈起");
    const re = await relaunch();
    s = re.s;
    st = await s.evaluate(gateState);
    step("④ 重启后闸再次在场(不同意什么都没记住,fail-closed)", re.pid !== pidBefore && st.key === null && st.gateDisplay !== "none" && st.centerInGate, { pidAfter: re.pid, key: st.key, gateDisplay: st.gateDisplay });

    // ⑤ 「同意」⇒ 闸撤、键落 "1"、启动继续到时间轴(启动闸 #gate 收起)
    if (KNIFE === "agree-nopersist") {
      // 刀:「同意」只撤闸不落键 ⇒ 下次启动又问一遍
      await s.evaluate(`(()=>{const b=document.getElementById("privacy-agree");const c=b.cloneNode(true);b.replaceWith(c);c.addEventListener("click",()=>{document.documentElement.dataset.privacy="ok"});return 1})()`);
    }
    const agreeHit = await tap(s, "#privacy-agree", `document.documentElement.dataset.privacy==="ok"`);
    for (let i = 0; i < 60; i++) {
      st = await s.evaluate(gateState);
      if (st.startupGateHidden) break;
      await sleep(250);
    }
    step("⑤ 真触摸「同意」⇒ 闸撤、键落 1、启动继续(启动闸收起)", agreeHit > 0 && st.key === "1" && st.dataPrivacy === "ok" && st.gateDisplay === "none" && !st.centerInGate && st.startupGateHidden, { hitOn: agreeHit, key: st.key, gateDisplay: st.gateDisplay, startupGateHidden: st.startupGateHidden, cards: st.cards });

    // ⑥ reload ⇒ 不再问(首帧内联脚本按键放行)
    await s.evaluate(`(()=>{location.reload();return 1})()`);
    await sleep(1500);
    s.close();
    s = await connect();
    for (let i = 0; i < 60; i++) {
      st = await s.evaluate(gateState).catch(() => null);
      if (st && st.startupGateHidden) break;
      await sleep(250);
    }
    step("⑥ reload 后不再问(闸从首帧就撤、启动照常)", st && st.key === "1" && st.dataPrivacy === "ok" && st.gateDisplay === "none" && st.startupGateHidden, st && { gateDisplay: st.gateDisplay, startupGateHidden: st.startupGateHidden });
  } finally {
    // 还回起跑时的值:起跑已同意 ⇒ 末态就是已同意;起跑没同意过 ⇒ 把键摘掉,下次启动照旧会问。
    try {
      if (initialPrivacy === "1") {
        restored = (await s.evaluate(`localStorage.getItem(${JSON.stringify(KEY)})`)) === "1" ? "unchanged" : "changed!";
      } else {
        await s.evaluate(`(()=>{localStorage.removeItem(${JSON.stringify(KEY)});return 1})()`);
        restored = "key-removed";
      }
    } catch (e) {
      restored = `restore-failed: ${e.message}`;
    }
    try { s.close(); } catch {}
  }
  // 格数写死当自证:少跑一格(中途抛了)不许算过。
  const pass = steps.length === 11 && steps.every((x) => x.ok) && (restored === "unchanged" || restored === "key-removed");
  console.log(JSON.stringify({ pass, steps, initialPrivacy, restored }, null, 1));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.log(JSON.stringify({ pass: false, error: e.message, steps }, null, 1));
  process.exit(2);
});
