// 跳转定位高亮的「留到下次点击/滚动才消」控制器。深链接 / 搜索命中 / 剪贴板「打开」是**冷
// 着陆**——你不知道目标在哪、正扫视着到达,需要一个能停留、让眼睛锁上去的标记,而不是
// .just-born 那记 0.9s 一次性涟漪(那是给「你自己刚新建、本就知道是哪张」用的花活)。
//
// 用法:命中卡渲染时 `el.classList.add("just-located")`(theme.css:持续常亮的朱砂描边+底色)
// 再 `armLocate(el)`。之后用户第一次 pointerdown / wheel / keydown(真实的点击或滚动/按键意图)
// 就淡出摘除。**刻意不监听 scroll** —— scrollIntoView 的程序化滚动(尤其 behavior:smooth)会
// 自触发 scroll,若监听它会在刚点亮的一瞬把高亮消掉,正是要避免的自消。

let target: HTMLElement | null = null;
let listening = false;

function detach(): void {
  if (!listening) return;
  window.removeEventListener("pointerdown", dismiss, true);
  window.removeEventListener("wheel", dismiss, true);
  window.removeEventListener("keydown", dismiss, true);
  listening = false;
}

function dismiss(): void {
  detach();
  const el = target;
  target = null;
  if (!el || !el.isConnected) return; // 卡已被重渲染换掉:高亮随旧节点已消,无事可做
  const done = (e: TransitionEvent): void => {
    if (e.propertyName !== "opacity") return;
    el.removeEventListener("transitionend", done);
    el.classList.remove("just-located", "locate-fading");
  };
  el.addEventListener("transitionend", done);
  el.classList.add("locate-fading"); // 触发 ::after opacity→0 过渡(见 theme.css)
}

/** 给刚点亮 .just-located 的卡挂一次性关闭。新的一枚顶掉旧的(旧卡若还在场,直接摘掉高亮,
 *  绝不同时留两枚)。 */
export function armLocate(el: HTMLElement): void {
  if (target && target !== el && target.isConnected) {
    target.classList.remove("just-located", "locate-fading");
  }
  target = el;
  if (!listening) {
    window.addEventListener("pointerdown", dismiss, true);
    window.addEventListener("wheel", dismiss, true);
    window.addEventListener("keydown", dismiss, true);
    listening = true;
  }
}
