// 客户端自动更新(88)。启动静默查 https://zhujian.app/updates/latest.json;有新版弹
// 右下角交互 banner(更新/稍后)——提示式,不点什么都不发生、下次启动再查。点「更新」
// 下载安装 NSIS 包(更新签名钥验签,与同步的设备鉴权钥无关)并 relaunch。查询失败
// (离线/端点不可达)静默吞掉,只有手动「检查更新」才把「已是最新/失败」显给用户。
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import "./update.css";

let banner: HTMLDivElement | null = null;
// 当前待处理的 Update:banner 收起时 close() 释放后端 resource。
let pending: Update | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = el("button", cls, label);
  b.addEventListener("click", onClick);
  return b;
}

function dismiss(): void {
  banner?.remove();
  banner = null;
  void pending?.close();
  pending = null;
}

// 一次性提示(无按钮、自动消失)——手动检查回话「已是最新/失败」用。和 sync 的 toast
// 分开(那个绑同步事件),避免两条提示互相顶掉。
function flash(msg: string): void {
  const t = el("div", "update-flash", msg);
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add("show"));
  window.setTimeout(() => {
    t.classList.remove("show");
    window.setTimeout(() => t.remove(), 250);
  }, 4200);
}

function showBanner(update: Update): void {
  dismiss();
  pending = update;
  banner = el("div", "update-banner");
  const msg = el("div", "update-msg", `有新版 v${update.version}`);
  const acts = el("div", "update-acts");
  acts.appendChild(btn("更新", "hbtn update-go", () => void run(update, msg, acts)));
  acts.appendChild(btn("稍后", "hbtn", dismiss));
  banner.append(msg, acts);
  document.body.appendChild(banner);
  requestAnimationFrame(() => banner?.classList.add("show"));
}

async function run(update: Update, msg: HTMLElement, acts: HTMLElement): Promise<void> {
  // 进入下载态:撤掉按钮(装到一半没有中途取消),文案走进度。
  acts.replaceChildren();
  let total = 0;
  let got = 0;
  try {
    await update.downloadAndInstall((ev: DownloadEvent) => {
      if (ev.event === "Started") {
        total = ev.data.contentLength ?? 0;
        msg.textContent = "下载中…";
      } else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        msg.textContent =
          total > 0
            ? `下载中… ${Math.floor((got / total) * 100)}%`
            : `下载中… ${Math.floor(got / 1024)} KB`;
      } else {
        msg.textContent = "安装中,即将重启…";
      }
    });
    await relaunch();
  } catch (e) {
    msg.textContent = `更新失败:${String(e)}`;
    acts.appendChild(btn("关闭", "hbtn", dismiss));
  }
}

// 启动静默查。只在生产构建跑:dev/e2e 走 vite dev server(PROD=false),不打网络也不弹,
// 免得开发/测试期被弹窗或网络往返打扰。
export async function initUpdate(): Promise<void> {
  try {
    const update = await check();
    if (update) showBanner(update);
  } catch {
    // 离线/端点不可达:静默。
  }
}

// 侧栏「检查更新」手动入口:有新版走同一 banner,否则明确回话(手动动作要有反馈)。
export async function checkForUpdateManual(): Promise<void> {
  try {
    const update = await check();
    if (update) showBanner(update);
    else flash(`已是最新 v${await getVersion()}`);
  } catch (e) {
    flash(`检查更新失败:${String(e)}`);
  }
}
