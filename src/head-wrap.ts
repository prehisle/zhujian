// 顶栏那组钮掉到第二行时靠左(909 E6,用户拍)。
//
// 五页页头同一形:`h1` + 靠右那一组 `.head-tools`(`margin-left:auto`,宽窗时把整组顶到右缘)+ 右内边距给窗控留死区
// (`--winctl-dead`)。界面字号放大 / 窗口变窄,那一组排不进标题那一行就整组折到第二行 —— 此前第二行照旧被
// `margin-left:auto` 顶到右边,右缘停在「视口宽 − 死区」:看板 150% 时那组从 274 排到 672,标题在 202,
// 读起来像一组飘在半空的钮。第二行本来就在窗控底下,用不着给它让位。
// ⇒ 折下去了就挂 `head-wrap`(controls.css 把 margin-left 归零 ⇒ 与标题左缘同列)。
//
// 判「折没折」量的是 `.head-tools` 的顶有没有落到标题的底下面(同看板 fitHeader 的 headerFits)。
// ⚠ 不会自激:auto 边距不参与 flex 断行(归零与否,那一组落在哪一行都一样),挂类只改水平位置、不改任何尺寸,
// 下面那两只观察器都不会因为它再派一次。看板的 fitHeader 逐档试「一行放不放得下」时读的也只是顶 / 溢出,不受它影响。
// 何时重量:页头 / 标题 / 那一组的尺寸变了(窗宽、字号档、侧栏收放、计数变长、看板换档、进出回收站换标题)。

let ro: ResizeObserver | null = null;

/** 量一次:那一组折到第二行了没有,挂 / 摘 `head-wrap`。 */
function sync(header: HTMLElement, h1: HTMLElement, tools: HTMLElement): void {
  const wrapped = tools.offsetParent !== null && tools.getBoundingClientRect().top >= h1.getBoundingClientRect().bottom;
  header.classList.toggle("head-wrap", wrapped);
}

/** 视图挂上之后调(notebook.ts navigate)。换视图时旧的观察器整只换掉;没有那一组(搜索页)就什么都不挂。 */
export function watchHeadWrap(viewRoot: HTMLElement): void {
  ro?.disconnect();
  ro = null;
  const header = viewRoot.querySelector<HTMLElement>(":scope > .view > header");
  const h1 = header?.querySelector<HTMLElement>(":scope > h1") ?? null;
  const tools = header?.querySelector<HTMLElement>(":scope > .head-tools") ?? null;
  if (!header || !h1 || !tools) return;
  ro = new ResizeObserver(() => sync(header, h1, tools));
  ro.observe(header);
  ro.observe(h1);
  ro.observe(tools);
}
