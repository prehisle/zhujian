// 客户端自动更新(88)。启动静默查 https://zhujian.app/updates/latest.json;有新版弹
// 右下角交互 banner(更新/稍后)——提示式,不点什么都不发生、下次启动再查。点「更新」
// 下载安装 NSIS 包(更新签名钥验签,与同步的设备鉴权钥无关)并 relaunch。查询失败
// (离线/端点不可达)静默吞掉,只有手动「检查更新」才把「已是最新/失败」显给用户。
import { check, type Update, type DownloadEvent } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "./i18n";
import "./update.css";

let banner: HTMLDivElement | null = null;
// 当前待处理的 Update:banner 收起时 close() 释放后端 resource。
let pending: Update | null = null;

// 回窗查更新的节流:频繁切窗口不该每次都打 latest.json。
const FOCUS_CHECK_THROTTLE_MS = 10 * 60 * 1000;
let lastCheckedAt = 0;

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
  const box = el("div", "update-flash", msg);
  document.body.appendChild(box);
  requestAnimationFrame(() => box.classList.add("show"));
  window.setTimeout(() => {
    box.classList.remove("show");
    window.setTimeout(() => box.remove(), 250);
  }, 4200);
}

// 更新说明值不值得显(296):空的不显;**只是把版本号又说一遍的也不显**——历史发版的
// notes 恒是 CI 写死的「朱简 vX.Y.Z」/「朱简安卓版 vX.Y.Z」,显出来就是紧挨着
// 「有新版 v0.2.25」再重复一次。判据 = 剥掉版本串与产品名后还剩不剩字,不去猜格式;
// 剥不干净(未来换了措辞)就照显 —— 宁可多显一行,不可把真说明吞掉。
export function meaningfulNotes(body: string | undefined, version: string): string {
  const s = (body ?? "").trim();
  if (!s) return "";
  const residue = s
    .replaceAll("朱简", "")
    .replaceAll("安卓版", "")
    .replaceAll(version, "")
    .replace(/[\sv·、,，。:：\-—]/g, "");
  return residue === "" ? "" : s;
}

function showBanner(update: Update): void {
  dismiss();
  pending = update;
  banner = el("div", "update-banner");
  const msg = el("div", "update-msg", t("update.newVersion", { v: update.version }));
  const acts = el("div", "update-acts");
  acts.appendChild(btn(t("update.go"), "hbtn update-go", () => void run(update, msg, acts)));
  acts.appendChild(btn(t("update.later"), "hbtn", dismiss));
  const notes = meaningfulNotes(update.body, update.version);
  banner.append(msg);
  if (notes) banner.append(el("div", "update-notes", notes));
  banner.append(acts);
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
        msg.textContent = t("update.downloading");
      } else if (ev.event === "Progress") {
        got += ev.data.chunkLength;
        msg.textContent =
          total > 0
            ? t("update.downloadingPct", { pct: Math.floor((got / total) * 100) })
            : t("update.downloadingKb", { kb: Math.floor(got / 1024) });
      } else {
        msg.textContent = t("update.installing");
      }
    });
    await relaunch();
  } catch (e) {
    msg.textContent = t("update.failed", { err: String(e) });
    acts.appendChild(btn(t("update.close"), "hbtn", dismiss));
  }
}

// 启动静默查。只在生产构建跑:dev/e2e 走 vite dev server(PROD=false),不打网络也不弹,
// 免得开发/测试期被弹窗或网络往返打扰。
export async function initUpdate(): Promise<void> {
  lastCheckedAt = Date.now();
  try {
    const update = await check();
    if (update) showBanner(update);
  } catch {
    // 离线/端点不可达:静默。
  }
}

// 回窗时查一次(否则只有冷启动才提示,长开着不重启的窗口永远发现不了新版)。
// 节流:短时间内反复切窗口只查一次,不空转 latest.json。
export async function checkForUpdateOnFocus(): Promise<void> {
  if (Date.now() - lastCheckedAt < FOCUS_CHECK_THROTTLE_MS) return;
  await initUpdate();
}

// 侧栏「检查更新」手动入口:有新版走同一 banner,否则明确回话(手动动作要有反馈)。
export async function checkForUpdateManual(): Promise<void> {
  try {
    const update = await check();
    if (update) showBanner(update);
    else flash(t("update.upToDate", { v: await getVersion() }));
  } catch (e) {
    flash(t("update.checkFailed", { err: String(e) }));
  }
}
