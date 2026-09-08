// 一份**公共** CDP 客户端(629;backlog 测试与工装 80 的第一半)。
//
// # 为什么在这儿
// 安卓那 40 支验收资产里已经有 10 支各抄了一份 CDP 客户端(`grep -l webSocketDebuggerUrl scripts/*`),
// 80 那条账要的就是「一份客户端 + 一支跑手」。629 写 `ui-shots-android.mjs` 时不再抄第 11 份,
// 先把客户端这一半落成本文件。
// ⛔ **80 还没销**:`android-cdp.mjs` 与那 10 支抄本**一个都还没收进来**(动它们要连着 40 支资产
// 一起复跑,不是顺车能做的),`evalfile` 判 PASS/FAIL/NOT-RUN 三态那半也还欠。
// ⇒ 再写新脚本时**用本文件**,别再抄第 12 份。
//
// # 边界
// · 只做「连上一条 page target、发命令、收回应」这一层。⛔ 不判断言、不管 adb forward
//   (那条走 `node scripts/android-cdp.mjs forward` —— 找 socket 那段焊着 490 那条
//   「别拿第一条 webview_devtools socket 当答案」的判例,别在这儿抄第二份)。
// · 每条命令有超时,超时**响亮抛**,⛔ 不返回 undefined 让调用方去猜(设计铁律:绝不回退兜底)。
// · node ≥ 22:全局 `WebSocket` 与 `fetch`。

/** 问 `/json` 要一条 page target。挑不出来就响亮说,⛔ 别退回「那就用第一条吧」。 */
export async function pageTarget(port = 9222) {
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${port}/json`);
  } catch (e) {
    // ⚠ **app 切到后台时这里抛的是一行 `TypeError: fetch failed`**,跟「app 在后台」毫无字面关系
    //   (629 实撞:跑到一半用户拿起手机开了微信)。手机端 runtime 只在前台跑 ⇒ 把话补全,
    //   ⛔ 别让人对着 undici 的堆栈猜。
    throw new Error(
      `连不上 CDP :${port}(${e.message})—— ① adb forward 建了吗(node scripts/android-cdp.mjs forward)?` +
        ` ② app 还在**前台**吗(手机端 runtime 只在前台跑)? ③ 装的是 devtools 构建吗?`,
    );
  }
  if (!res.ok) throw new Error(`CDP /json 回 ${res.status} —— adb forward 建了吗?app 是 devtools 构建吗?`);
  const list = await res.json();
  const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (pages.length !== 1) {
    throw new Error(
      `期望恰 1 条 page target,实得 ${pages.length} 条:${JSON.stringify(list.map((t) => `${t.type}:${t.url}`))}`,
    );
  }
  return pages[0];
}

/** 开一条**跨多条命令活着**的会话(截图/等条件这类活要的就是它,一问一答的 CLI 不是这个形)。 */
export async function openSession(wsUrl, { timeoutMs = 15000 } = {}) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`连不上 ${wsUrl}`));
  });

  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    const p = pending.get(msg.id);
    if (!p) return; // 事件(没有 id),本层不分发
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
    else p.resolve(msg.result);
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超过 ${timeoutMs}ms 没回应`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ id, method, params }));
    });

  /** 页面内求值。⛔ 传进来的表达式一律自己包 IIFE —— `Runtime.evaluate` 的每一发都跑在同一个
   *  全局作用域里,顶层 `const` 第二次就 `Identifier has already been declared`(391 判例)。 */
  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error(`页面内抛了:${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result?.value;
  };

  return { send, evaluate, close: () => ws.close() };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 真实触摸滑动:一次 touchStart → 若干 touchMove → touchEnd,走**原生输入管线**
 * ⇒ `touch-action`、滚动识别、pointer capture 都真实生效(合成 PointerEvent 测不到那半截)。
 * ⚠ 坐标是 **CSS 视口像素**(`getBoundingClientRect()` 直接给的那个),⛔ 不是截图上量的设备像素
 * (差一个 `devicePixelRatio`,搞混了是「点了没反应」而不报错,627 栽两趟)。
 * @param {{send:Function}} session `openSession` 开出来的会话(⛔ 同一条连接上连发,别一发一开)
 */
export async function touchSwipe({ send }, x1, y1, x2, y2, steps = 12) {
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x1, y: y1 }] });
  for (let i = 1; i <= steps; i++) {
    await send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: x1 + ((x2 - x1) * i) / steps, y: y1 + ((y2 - y1) * i) / steps }],
    });
    await sleep(16);
  }
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}
