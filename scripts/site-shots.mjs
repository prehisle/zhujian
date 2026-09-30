// 官网配图一条命令重拍(官网改版第 4 格)。产物直接落 `site/shots/`(中文)与 `site/shots/en/`(英文),
// 名字、尺寸与首页 `<img width height>` 对得上才算数 —— 对不上就响亮拒、一张都不写。
//
//   node scripts/site-shots.mjs            # 桌面 + 手机,六张
//   node scripts/site-shots.mjs desktop    # 桌面四张(zh/en × 看板/随记)
//   node scripts/site-shots.mjs phone      # 手机两张(zh/en 随记)
//
// 内容全是展示库(`lib/showcase.mjs`)那一份,电脑与手机讲的是同一本笔记本。
//
// ## 桌面那半
// 转手给 `ui-shots-desktop.mjs`(它自起隔离 app、隔离库,整趟不抢前台),每种语言一趟:
// `--seed-lang <语言> --scale 1.5 --only <语言>-light-board,<语言>-light-inbox`。
// ⭐ 1.5 倍是量出来的(780):首页裁图要把图再放大 1.75–2 倍,1 倍图必糊;1260×700 的窗 × 1.5 = 1890×1050。
//   ⚠ 前提是这台显示缩放 100%(`Page.captureScreenshot` 的 clip.scale 乘的是 CSS 像素),
//   换一台 150% 的机器出来是别的尺寸 ⇒ 下面的尺寸闸会拒,别去改闸,改 `--scale`。
//
// ## 手机那半(要 MuMu + x86_64 devtools 包;平时是关着的,开法在 skill zhujian-android-verify)
// 在设备上**临时建一个空间**(「生活」/「Life」)写展示库的随记,只截 WebView(天然没有系统状态栏与
// 手势条,不用裁白边),截完删掉那个空间、语言与上次所在空间还原 —— ⛔ 一个字都不往 main 里写。
// ⛔ 设备上的 main 可能是谁的真数据(vivo 那台就是用户日常那本);这里只在自己建的空间里写,
//   收尾回读 `list_spaces` 与进场时逐个相同才算清场完。
// ⚠ 视口覆盖只许**不超出真屏**(780 实撞:撑得比真屏高 ⇒ 固定在底部的底栏被画成了第二个顶栏)。
//   MuMu 竖屏 1440×2560:取 CSS 375×750 @ dpr 1280/375 ⇒ 1280×2560(1:2,比 9:16 更像手机),
//   再缩成 630×1260。
//
// 转码:PNG → WebP 走 Pillow(`python -c`,本机与 site-font 的 fonttools 同一个 python)。
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openSession, pageTarget, sleep } from "./lib/cdp.mjs";
import { SHOWCASE, seedScript } from "./lib/showcase.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const SHOTS = join(root, "site/shots");
const WORK = join(tmpdir(), "zj-site-shots");
const LANGS = ["zh", "en"];
const outDir = (lang) => (lang === "zh" ? SHOTS : join(SHOTS, "en"));

// 首页 `<img>` 上写死的尺寸就是验收判据:图与属性对不上,浏览器按属性留位、图被拉伸。
const DESKTOP = { w: 1890, h: 1050, scale: 1.5, views: ["board", "inbox"] };
const PHONE = { cssW: 375, cssH: 750, w: 630, h: 1260 };

const which = process.argv.slice(2).filter((a) => !a.startsWith("-"));
for (const w of which) if (!["desktop", "phone"].includes(w)) throw new Error(`只认 desktop / phone:${w}`);
const parts = which.length ? which : ["desktop", "phone"];

function pngSize(file) {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error(`不是 PNG:${file}`);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/** PNG → WebP(可选缩到 w×h)。质量 82:1890 宽的看板图约 80–90 KB,与改版前那批同量级。 */
function toWebp(src, dst, size) {
  const py = [
    "import sys",
    "from PIL import Image",
    "im = Image.open(sys.argv[1]).convert('RGB')",
    "w, h = int(sys.argv[3]), int(sys.argv[4])",
    "im = im if im.size == (w, h) else im.resize((w, h), Image.LANCZOS)",
    "im.save(sys.argv[2], 'WEBP', quality=82, method=6)",
  ].join("\n");
  execFileSync("python", ["-c", py, src, dst, String(size[0]), String(size[1])], { stdio: "inherit" });
}

const written = [];
function commit(lang, name, pngFile, size) {
  const dir = outDir(lang);
  mkdirSync(dir, { recursive: true });
  const dst = join(dir, `${name}.webp`);
  toWebp(pngFile, dst, size);
  written.push(`${dst.slice(root.length + 1).replaceAll("\\", "/")}  ${(statSync(dst).size / 1024).toFixed(0)} KB`);
}

// ---- 桌面 --------------------------------------------------------------------
function desktop() {
  const staged = [];
  for (const lang of LANGS) {
    const dir = join(WORK, "desktop", lang);
    rmSync(dir, { force: true, recursive: true });
    const only = DESKTOP.views.map((v) => `${lang}-light-${v}`).join(",");
    const r = spawnSync(
      process.execPath,
      [join(here, "ui-shots-desktop.mjs"), dir, "--seed-lang", lang, "--scale", String(DESKTOP.scale), "--only", only],
      { stdio: "inherit" },
    );
    if (r.status !== 0) throw new Error(`ui-shots-desktop(${lang})退出码 ${r.status} —— 上面是它自己的话`);
    for (const v of DESKTOP.views) {
      const f = join(dir, `${lang}-light-${v}.png`);
      const [w, h] = pngSize(f);
      if (w !== DESKTOP.w || h !== DESKTOP.h) {
        throw new Error(
          `${f} 是 ${w}×${h},首页写的是 ${DESKTOP.w}×${DESKTOP.h} —— 这台显示缩放不是 100%?改 --scale,⛔ 别改闸`,
        );
      }
      staged.push([lang, `desktop-${v}`, f]);
    }
  }
  // 四张都截成了才动 site/shots(半截失败不留半新半旧的一套)
  for (const [lang, name, f] of staged) commit(lang, name, f, [DESKTOP.w, DESKTOP.h]);
}

// ---- 手机 --------------------------------------------------------------------
const PKG = "app.zhujian.notebook";
const adb = (args) => execFileSync("adb", args, { encoding: "utf8" });

async function phone() {
  const devs = adb(["devices"]).split(/\r?\n/).slice(1).filter((l) => /\tdevice$/.test(l));
  if (devs.length !== 1 && !process.env.ANDROID_SERIAL) {
    throw new Error(`要恰好一台安卓设备(或设 ANDROID_SERIAL),现有 ${devs.length} 台:${devs.join(" / ")}`);
  }
  const wm = adb(["shell", "wm", "size"]);
  const [, pw, ph] = wm.match(/(\d+)x(\d+)/) ?? [];
  if (!pw || Number(ph) < Number(pw)) throw new Error(`这台屏不是竖着的:${wm.trim()} —— 截手机图要竖屏`);
  // 高度撑满真屏、宽度不超:两个方向都落在真屏之内(780 那条坑只许「不超出」)
  const dpr = Math.min(Number(pw) / PHONE.cssW, Number(ph) / PHONE.cssH);
  adb(["shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"]);
  await sleep(2500);
  const fwd = spawnSync(process.execPath, [join(here, "android-cdp.mjs"), "forward"], { stdio: "inherit" });
  if (fwd.status !== 0) throw new Error("建 CDP forward 失败 —— 装的是 devtools 包吗?(上面是它自己的话)");

  const s = await openSession((await pageTarget()).webSocketDebuggerUrl, { timeoutMs: 30000 });
  const inv = (cmd, args) => s.evaluate(`window.__TAURI__.core.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? {})})`);
  const waitFor = async (expr, what, ms = 20000) => {
    const t0 = Date.now();
    for (;;) {
      try {
        if (await s.evaluate(expr)) return;
      } catch {
        /* reload 途中会短暂抛,忍到超时 */
      }
      if (Date.now() - t0 > ms) throw new Error(`等「${what}」超过 ${ms}ms;判据 ${expr}`);
      await sleep(150);
    }
  };
  const spaceIds = async () => (await inv("list_spaces")).map((x) => x.id ?? x.spaceId).sort();

  const before = {
    spaces: await spaceIds(),
    fg: await inv("foreground_space"),
    ls: await s.evaluate(`({ lang: localStorage.getItem("zhujian.lang"), last: localStorage.getItem("zhujian.last-space") })`),
  };
  console.log(`手机进场:空间 ${before.spaces.join(",")} · 前台 ${before.fg} · 语言档 ${before.ls.lang ?? "(跟系统)"}`);

  const staged = [];
  let temp = null;
  try {
    for (const lang of LANGS) {
      temp = await inv("create_space", { name: SHOWCASE[lang].space });
      await inv("activate_space", { spaceId: temp });
      const seeded = await s.evaluate(seedScript(lang, { spaceId: temp, captureCmd: "capture_idea" }));
      console.log(`  ${lang}:临时空间 ${temp} · 随记 ${seeded.notes} · 任务 ${seeded.tasks} · 标签 ${seeded.topics}`);
      await s.evaluate(`(() => {
        localStorage.setItem("zhujian.lang", ${JSON.stringify(lang)});
        localStorage.setItem("zhujian.last-space", ${JSON.stringify(temp)});
        setTimeout(() => location.reload(), 0);
        return true;
      })()`);
      await sleep(800);
      await waitFor(`document.readyState === "complete" && document.documentElement.lang.startsWith(${JSON.stringify(lang)})`, "重载后语言换过来");
      // 停在「随记」这一面、没有面开着;已经在就别再点(再点会去聚焦捕获框、弹键盘)
      await s.evaluate(`(() => {
        const q = (x) => document.querySelector(x);
        const open = document.body.classList.contains("pane-open");
        if (open || q('#bottombar [data-mode].active')?.dataset.mode !== "ideas") q('#bottombar [data-mode="ideas"]').click();
        if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
        return true;
      })()`);
      // ⛔ 判据认**正文**:第一张卡是展示库最后写的那条(清单那条的首行),别只认「有卡」
      const head = SHOWCASE[lang].featured.split("\n")[0];
      await waitFor(
        `(() => { const t = document.querySelector("#timeline")?.innerText ?? ""; return t.includes(${JSON.stringify(head)}) && t.includes(${JSON.stringify(SHOWCASE[lang].inbox[0])}); })()`,
        `${lang} 时间轴上出现展示库的随记`,
      );
      await s.send("Emulation.setDeviceMetricsOverride", {
        width: PHONE.cssW,
        height: PHONE.cssH,
        deviceScaleFactor: dpr,
        mobile: true,
      });
      await waitFor(`window.innerWidth === ${PHONE.cssW}`, "视口覆盖生效");
      await sleep(600);
      await waitFor(`document.fonts.status === "loaded"`, "字体加载完成");
      const shot = await s.send("Page.captureScreenshot", { format: "png" });
      await s.send("Emulation.clearDeviceMetricsOverride");
      const f = join(WORK, "phone", `${lang}.png`);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, Buffer.from(shot.data, "base64"));
      const [w, h] = pngSize(f);
      if (Math.abs(w / h - PHONE.cssW / PHONE.cssH) > 0.01) throw new Error(`${f} 是 ${w}×${h},比例不是 ${PHONE.cssW}:${PHONE.cssH}`);
      staged.push([lang, "phone-inbox", f]);

      await inv("activate_space", { spaceId: before.fg });
      await inv("reset_space", { spaceId: temp });
      temp = null;
    }
  } finally {
    // 清场:哪一步抛了都走这里。⛔ 清场自己失败要响亮说出留下了什么,不吞。
    await s.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    if (temp) {
      await inv("activate_space", { spaceId: before.fg });
      await inv("reset_space", { spaceId: temp });
    }
    await s.evaluate(`(() => {
      const put = (k, v) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v));
      put("zhujian.lang", ${JSON.stringify(before.ls.lang)});
      put("zhujian.last-space", ${JSON.stringify(before.ls.last)});
      setTimeout(() => location.reload(), 0);
      return true;
    })()`);
    await sleep(1500);
    const after = await spaceIds();
    const fgAfter = await inv("foreground_space");
    s.close();
    if (after.join(",") !== before.spaces.join(",") || fgAfter !== before.fg) {
      throw new Error(`⚠ 清场没还原:空间 ${before.spaces} → ${after},前台 ${before.fg} → ${fgAfter}`);
    }
    console.log(`手机清场:空间 ${after.join(",")} · 前台 ${fgAfter}(与进场相同)`);
  }
  for (const [lang, name, f] of staged) commit(lang, name, f, [PHONE.w, PHONE.h]);
}

if (parts.includes("desktop")) desktop();
if (parts.includes("phone")) await phone();
console.log(`\n写入 ${written.length} 张:\n  ${written.join("\n  ")}`);
