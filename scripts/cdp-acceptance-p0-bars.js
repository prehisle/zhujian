// 144 P0 #3:提示条(#error)/更新条(#update)改 fixed 悬浮——出现/消失不再挤动
// 文档流(143 真机实测「整轴跳 ~37px 误点状态 pill」的根因)。静态样式锚 + 显隐前后
// 时间轴零位移断言。evalfile 跑,pass=true 才算过。
(async () => {
  const out = { pass: false, steps: [] };
  const ok = (name, cond) => {
    out.steps.push({ name, ok: !!cond });
    return !!cond;
  };
  const cs = (el) => getComputedStyle(el);
  const err = document.getElementById("error");
  const upd = document.getElementById("update");
  const cb = document.getElementById("confirmbar");

  // ① 三条 bar 全部 fixed(z 序:error 18 > confirmbar 17 > update 6)
  ok("#error fixed z18", cs(err).position === "fixed" && cs(err).zIndex === "18");
  ok("#update fixed z6", cs(upd).position === "fixed" && cs(upd).zIndex === "6");
  ok("#confirmbar fixed z17", cs(cb).position === "fixed" && cs(cb).zIndex === "17");

  // ② 显隐前后时间轴零位移(fixed = 不进文档流)
  const tl = document.getElementById("timeline");
  const top0 = tl.getBoundingClientRect().top;
  const errWasHidden = err.hidden;
  err.textContent = "CDP 布局位移探针";
  err.hidden = false;
  await new Promise((r) => setTimeout(r, 50));
  const topWithErr = tl.getBoundingClientRect().top;
  err.hidden = errWasHidden;
  err.textContent = "";
  const updWasHidden = upd.hidden;
  upd.hidden = false;
  await new Promise((r) => setTimeout(r, 50));
  const topWithUpd = tl.getBoundingClientRect().top;
  upd.hidden = updWasHidden;
  ok("#error 显隐不挤动时间轴", topWithErr === top0);
  ok("#update 显隐不挤动时间轴", topWithUpd === top0);

  // ③ 确认条按钮触区 ≥44px(临时揭开量几何,量完复原;未经 confirmBar 无定时器残留)
  const cbWasHidden = cb.hidden;
  cb.hidden = false;
  await new Promise((r) => setTimeout(r, 50));
  const yes = document.getElementById("confirmbar-yes");
  const no = document.getElementById("confirmbar-no");
  ok("确认/取消触区 ≥44px", yes.offsetHeight >= 44 && no.offsetHeight >= 44);
  ok("确认条落在下半屏(远离卡面单拍控件)", cb.getBoundingClientRect().top > innerHeight / 2);
  cb.hidden = cbWasHidden;

  out.pass = out.steps.every((s) => s.ok);
  return JSON.stringify(out);
})();
