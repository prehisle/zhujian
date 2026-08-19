// 163 常驻回归锚(ui-guidelines §3.6/§3.7 两条规则的行为证明;阴性对照实跑过:
// 撤乐观移位→例① 红、撤出生隐形→例② 红):
//   ① 拖放「手势即回执」——drop 派发的同一同步回合里,卡已在目标列 DOM(不等后端往返)。
//   ② 超高图 lightbox「布局未定不显示」——逐帧记录查看器 img,可见帧的宽度恒等于
//      终态整图宽,不存在「先宽后缩」的裸渲染帧(也捕迟到 resize 的二次重排)。
// zz 前缀刻意钉在字典序末尾:例② 会把真窗撑到近屏再还原,窗口几何敏感,放最后跑。
// ⚠ 例② 是全仓抖得最久的一支(backlog「测试与工装 5」):414 在 Windows 上红过一次
//   「19 > 容差 2」,单跑 / 配对 / 重跑三格全绿。它红的时候只给得出那一个数字,判不了
//   「抖动还是回归」——439 起改成**红了自带现场**:逐帧连视口(iw/ih/dpr)与 resize 事件
//   一起记,失败信息直接回答「亮相那一刻视口是不是终态、之后又变没变」。
import { browser, $, expect } from "@wdio/globals";
import { goNotebook, invoke } from "./support.js";

describe("163 · 手势即回执 + 布局未定不显示", () => {
  before(async () => {
    await goNotebook("board");
  });

  it("拖放 drop 同帧:卡已插入目标列(乐观移位,不等 IPC)", async () => {
    const T = "验证163-乐观移位";
    await invoke("create_task", { title: T });
    // 重载让新任务上板。
    await goNotebook("board");
    await $(".tcard*=" + T).waitForExist({ timeout: 5000 });
    // 同一 execute(同一同步回合)里:派发 dragstart/dragover/drop 后立即读目标列 DOM。
    // 后端响应最早也要下一个宏任务才可能落地,此刻卡在 doing 列 = 乐观移位在作用。
    const sameTick = await browser.execute((t) => {
      const card = [...document.querySelectorAll(".tcard")].find((c) => c.textContent.includes(t));
      const body = document.querySelector(".col.doing .col-body");
      const dt = new DataTransfer();
      card.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
      body.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt }));
      body.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
      const inDoing = [...body.querySelectorAll(".tcard")].some((c) => c.textContent.includes(t));
      card.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
      return inDoing;
    }, T);
    expect(sameTick).toBe(true);
    // 后端真相回来后仍应在 doing(乐观位与落库一致)。
    await browser.waitUntil(
      async () => {
        const tasks = await invoke("list_tasks");
        const found = tasks.find((x) => x.title === T);
        return found && found.status === "doing";
      },
      { timeout: 5000, timeoutMsg: "任务未落库到 doing" },
    );
  });

  it("超高图点开:可见帧宽度恒为终态整图宽(无「先宽后缩」裸渲染帧)", async () => {
    // 造一条带 400×4000 超高图的任务(canvas 在页面里现画,免依赖外部文件)。
    const T = "验证163-超高图";
    const id = await invoke("create_task", { title: T });
    await browser.execute(async (itemId) => {
      const cv = document.createElement("canvas");
      cv.width = 400;
      cv.height = 4000;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#c33";
      ctx.fillRect(0, 0, 400, 4000);
      ctx.fillStyle = "#fff";
      for (let y = 0; y < 4000; y += 200) ctx.fillRect(0, y, 400, 8);
      const dataB64 = cv.toDataURL("image/png").split(",")[1];
      await window.__TAURI__.core.invoke("add_item_image", {
        itemId,
        mime: "image/png",
        dataB64,
        spaceId: "main",
      });
    }, id);
    await goNotebook("board");
    const thumb = await $(".tcard*=" + T).$(".img-thumb-img");
    await thumb.waitForExist({ timeout: 5000 });
    // 先装逐帧记录器再点缩略图:每 rAF 记录查看器 img 的可见性与实际宽度,**并连视口一起记**。
    // 视口那三格不是装饰:这支真红时唯一要回答的问题是「亮相那一刻视口是不是终态」——超高图
    // 的终态是高度受限的整图适配,显示宽 ≈ 视口高 / 10,于是「宽度差 N px」就是「视口高差
    // 10N px」。resize 事件另记一份:落在亮相**之后**的那一记,正是「布局未定不显示」被绕过
    // 的现场(放大窗口的 setSize 落到视口上晚于 viewportSettle 放行 ⇒ 亮相后又排了一次)。
    await browser.execute(() => {
      const R = { frames: [], resizes: [], stop: false, t0: performance.now(), ac: new AbortController() };
      window.__rec163 = R;
      const imgVis = () => {
        const im = document.querySelector(".img-lightbox-img");
        return im ? getComputedStyle(im).visibility : "-";
      };
      window.addEventListener(
        "resize",
        () => {
          R.resizes.push({
            t: Math.round(performance.now() - R.t0),
            iw: window.innerWidth,
            ih: window.innerHeight,
            vis: imgVis(),
          });
        },
        { signal: R.ac.signal },
      );
      const tick = () => {
        const img = document.querySelector(".img-lightbox-img");
        const f = {
          t: Math.round(performance.now() - R.t0),
          iw: window.innerWidth,
          ih: window.innerHeight,
          dpr: window.devicePixelRatio,
        };
        if (img) {
          f.vis = getComputedStyle(img).visibility;
          f.w = img.getBoundingClientRect().width;
        }
        R.frames.push(f);
        if (!R.stop) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await thumb.click();
    // 等查看器 img 可见且宽度连续稳定(终态)。
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const img = document.querySelector(".img-lightbox-img");
          return !!img && getComputedStyle(img).visibility === "visible" && img.getBoundingClientRect().width > 0;
        }),
      { timeout: 10000, timeoutMsg: "lightbox 图片未亮相" },
    );
    await browser.pause(600); // 再收几帧,确认亮相后无二次重排
    const rec = await browser.execute(() => {
      const R = window.__rec163;
      R.stop = true;
      R.ac.abort(); // 摘掉 resize 监听,别把它留给下一支 spec
      return { frames: R.frames, resizes: R.resizes };
    });
    const visible = rec.frames.filter((f) => f.vis === "visible" && f.w > 0);
    expect(visible.length).toBeGreaterThan(0);
    const finalW = visible[visible.length - 1].w;
    // 超高图的终态=整图适配,宽度必然远小于原始 400px;任何可见帧宽度都不得偏离终态
    // (±2px 容差)。旧病(裸渲染原始尺寸/迟到 resize 重排)会留下 ≥400px 或与终态不同的帧。
    try {
      expect(finalW).toBeLessThan(300);
      for (const f of visible) {
        expect(Math.abs(f.w - finalW)).toBeLessThanOrEqual(2);
      }
    } catch (e) {
      throw new Error(e.message + "\n  " + scene(rec, visible, finalW));
    }
    // 收尾:Esc 关查看器(还原窗口在遮罩下发生)。
    await browser.keys("Escape");
    await browser.pause(400);
  });
});

/** 例② 红时把「现场」压成几行接在断言消息后面:视口何时变、亮相那一刻的视口与宽度、resize
 *  事件有没有落在亮相**之后**。⛔ 别只报一个数字——414 那次拿到的就只有「19 > 2」,于是只能
 *  靠单跑 / 配对 / 重跑三格去判「抖动还是回归」,而判据本来就摆在帧里,只是没被印出来。 */
function scene(rec, visible, finalW) {
  const vp = [];
  let last = "";
  for (const f of rec.frames) {
    const k = f.iw + "x" + f.ih;
    if (k !== last) {
      vp.push("t=" + f.t + ":" + k);
      last = k;
    }
  }
  const first = visible[0];
  const worst = visible.reduce((a, b) => (Math.abs(b.w - finalW) > Math.abs(a.w - finalW) ? b : a), visible[0]);
  const off = visible.filter((f) => Math.abs(f.w - finalW) > 2).length;
  const rz = rec.resizes.map((r) => "t=" + r.t + " " + r.iw + "x" + r.ih + " img=" + r.vis).join(" | ") || "无";
  return [
    "现场:dpr=" + (rec.frames[0] ? rec.frames[0].dpr : "?") + " 帧 " + rec.frames.length + "(可见 " + visible.length + ")",
    "视口:" + vp.join(" → "),
    "亮相:t=" + first.t + " 视口 " + first.iw + "x" + first.ih + " 宽 " + first.w + ";终态宽 " + finalW,
    "resize 事件:" + rz,
    "偏离帧 " + off + "/" + visible.length + ",最大 " + Math.round(Math.abs(worst.w - finalW)) + "px @t=" + worst.t,
  ].join("\n  ");
}
