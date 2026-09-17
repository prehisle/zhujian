#!/usr/bin/env node
// 把当前这棵树装上**用户日常在用的那两台**(701 立)。
//
//   node scripts/dogfood.mjs --desktop            桌面:盖进 %LOCALAPPDATA%\zhujian\app.exe 再启回
//   node scripts/dogfood.mjs --android [--device serial]   安卓:干净发版包 → 自动装机
//
// # 它治的是什么
// 用户 2026-09-17 拍板:本机 PC 与自用手机常年跑最新测试构建,自己先用,发版降为**一周
// 一次、由他开口**。⇒ 「装上他那两台」从此是每轮收口的一格,而不是偶尔为之的顺手活。
// 此前桌面这一趟是四条手工命令(memory `zhujian-rebuild-release-for-user-testing`),
// 每一步都能静默错:
//   · ⛔⛔ **用户正跑着那只 exe 时,`tauri build` 静默失败且退出码 0**
//     (memory `tauri-build-locked-exe-trap`)⇒ 我会报「编好了」而他手上还是旧的,**两边都不报错**;
//   · 忘了从 `target/` 复制出去 ⇒ 下一次 `cargo clean` / 腾 G 盘空间把用户的 app 删掉;
//   · 盖上了没盖上只能靠肉眼 —— 复制失败与复制成功在屏幕上长得一样。
// ⇒ 本脚本把这三样都变成**判据**:每一步都要有一件独立于回显的证据(见下面三处 `✓`)。
//
// # 铁律
// ⛔ **带库迁移 / 动线协议·加密·服务端准入的轮次,别用它抢在评审前装机。**
//    库前滚不可逆(旧版拒启,deploy §7.4),而迁移的形在评审里被改是常事 ⇒ 装早了 =
//    用户那台的真库与别人分叉。那几类走「评审过完、落了 master 再装」。
// ⛔ **测试包绝不许传到 `zhujian.app/updates/`** —— 那是所有真实用户的更新通道。
//    本脚本只往本机磁盘与 USB 上的那台设备写,一个字节都不上服务器。
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildStamp } from "./lib/build-stamp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const want = args.includes("--desktop") ? "desktop" : args.includes("--android") ? "android" : null;
const device = args.includes("--device") ? args[args.indexOf("--device") + 1] : null;

if (!want) {
  console.error("用法: node scripts/dogfood.mjs --desktop | --android [--device <serial>]");
  process.exit(2);
}

const die = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const run = (cmd, cmdArgs, opts = {}) =>
  execFileSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", ...opts });
const sha1 = (f) => createHash("sha1").update(readFileSync(f)).digest("hex").slice(0, 12);

// ── 0. 这一趟要装的是哪棵树 ────────────────────────────────────────────────────
const stamp = buildStamp();
console.log(`\n── 要装的树 ────────────────────────────────`);
console.log(`  commit ${stamp.commit}${stamp.dirty ? "  ⚠ 工作树脏" : ""}`);
if (stamp.dirty) {
  // ⚠ 不拦,只喊。收口前想先装一只看看是正当用法,而戳上会如实写着「含未提交改动」。
  // 但**交付给用户的那一只**该是干净的:脏戳等于「这只包对应不到任何一个 commit」。
  console.log(`  ⚠ 未提交 / 未跟踪的改动会进这只包,它的身份戳会显示「含未提交改动」。`);
  console.log(`    要交付给用户的那一只,先提交再跑。`);
}

/** 构建出的前端产物里,身份戳是不是这一趟期望的那个。 */
function assertStampInBundle(distAssets, label) {
  if (!existsSync(distAssets)) die(`${label} 没有产物目录 ${distAssets} —— 构建其实没跑成?`);
  const js = readdirSync(distAssets).filter((f) => f.endsWith(".js"));
  if (js.length === 0) die(`${label} ${distAssets} 里一个 .js 都没有 —— 构建其实没跑成?`);
  const hit = js.some((f) => readFileSync(join(distAssets, f), "utf8").includes(`commit:"${stamp.commit}"`));
  if (!hit) {
    die(
      `${label} 前端产物里找不到本趟的身份戳 commit:"${stamp.commit}"。\n` +
        `  ⇒ vite 这一趟其实没重跑(产物是上一次的),或者 define 没接上。\n` +
        `  ⛔ 别往下装 —— 装上去的会是一只身份说不清的包。`,
    );
  }
  console.log(`  ✓ 前端产物里确认有 commit:"${stamp.commit}"(${label})`);
}

/** 目录里最新那个文件的 mtime。 */
function newestMtime(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else newest = Math.max(newest, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return newest;
}

if (want === "desktop") {
  const installDir = join(process.env.LOCALAPPDATA ?? "", "zhujian");
  const installed = join(installDir, "app.exe");
  const built = join(root, "src-tauri/target/release/app.exe");
  const dist = join(root, "dist");

  if (!existsSync(installed)) {
    die(
      `找不到装机版 ${installed}。\n` +
        `  这台从没装过正式包 ⇒ 先从 https://zhujian.app/updates/ 下安装包装一次,\n` +
        `  之后本脚本才有地方盖(⛔ 别改成「直接把 target/ 那只交给用户」——\n` +
        `  那个目录 cargo clean 一下就没了,而且更新条装的是安装目录那份)。`,
    );
  }

  // ── 1. 停掉在跑的那只(它占着 exe 与全局热键)──────────────────────────────
  // ⚠ 按**路径**报出来再杀:`taskkill /IM app.exe` 那个形会连带别的同名程序,
  //   而屏幕上看不出杀掉的是谁。
  // ⚠ 两个真栽过的 PowerShell 坑,都写在这一条命令里:
  //  ① 用 `Select-Object -ExpandProperty`,别用 `ForEach-Object { $_.Path }` —— `$_` 会被
  //     途经的 shell 吃掉(Git Bash 下当场变成一条找不到的命令),而那条错长得像 PowerShell 的问题;
  //  ② **末尾那个 `exit 0` 少不得**:`Get-Process` 一个都没找到时 powershell.exe **退 1**,
  //     `-ErrorAction SilentlyContinue` 只压错误记录、**不改退出码** ⇒ execSync 会抛,
  //     而「一个都没在跑」恰恰是最正常的那条路(第一次跑本脚本就死在这儿)。
  //     powershell 本身起不来仍然响亮(execSync 抛 ENOENT),没有被这句盖掉。
  const running = execSync(
    `powershell -NoProfile -Command "@(Get-Process app -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Path) -join [Environment]::NewLine; exit 0"`,
    { encoding: "utf8" },
  )
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (running.length) {
    console.log(`\n── 先停掉在跑的 ───────────────────────────`);
    for (const p of running) console.log(`  kill ${p}`);
    execSync(`powershell -NoProfile -Command "Get-Process app -ErrorAction SilentlyContinue | Stop-Process -Force"`);
    // 文件锁的释放晚于进程消失一点点;不等的话下一步 build 会踩 locked-exe 那个静默坑。
    execSync("powershell -NoProfile -Command \"Start-Sleep -Milliseconds 800\"");
  }

  // ── 2. 构建(--no-bundle:免签名 env,dogfood 不需要安装包)──────────────────
  console.log(`\n── 构建 ───────────────────────────────────`);
  const cargoBin = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".cargo/bin");
  run("npm", ["run", "tauri", "build", "--", "--no-bundle"], {
    env: { ...process.env, PATH: `${cargoBin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` },
    shell: process.platform === "win32",
  });

  // ── 3. 三件证据 ────────────────────────────────────────────────────────────
  console.log(`\n── 核对 ───────────────────────────────────`);
  assertStampInBundle(join(dist, "assets"), "桌面");
  if (!existsSync(built)) die(`构建说成功了,但 ${built} 不在 —— 那就是没成功。`);
  // ⛔⛔ 这一格治的是 locked-exe 那个**退出码 0 的静默失败**:exe 比刚打出来的 dist 还老,
  //    就说明 cargo 根本没把新前端重新打进去,而上面的构建一声没吭。
  const exeAt = statSync(built).mtimeMs;
  const distAt = newestMtime(dist);
  if (exeAt < distAt) {
    die(
      `exe 比前端产物还老(exe ${new Date(exeAt).toISOString()} < dist ${new Date(distAt).toISOString()})。\n` +
        `  ⇒ 这一趟 cargo 没有重新打包,多半是 exe 当时还被占着(退出码 0 的静默失败)。\n` +
        `  处置:确认没有 app.exe 在跑,重跑本脚本。`,
    );
  }
  console.log(`  ✓ exe 晚于前端产物(不是上一次的残留)`);

  // ── 4. 盖进安装目录,留一只滚动备份 ────────────────────────────────────────
  // ⚠ 备份**恒定一只**(`app.exe.prev`):早先每次盖都留一个带哈希后缀的 .bak,
  //   在用户机器上攒了四只 ≈ 96 MB 没人清。旧的那几只不由本脚本删(不是我放的,别替他做主)。
  const prev = join(installDir, "app.exe.prev");
  copyFileSync(installed, prev);
  copyFileSync(built, installed);
  const a = sha1(built);
  const b = sha1(installed);
  if (a !== b) die(`盖上去的和构建出来的对不上(${a} ≠ ${b})—— 复制失败了。`);
  console.log(`  ✓ 已盖进 ${installed}(sha1 ${b};上一只留在 app.exe.prev)`);

  // ── 5. 启回来 ──────────────────────────────────────────────────────────────
  execSync(`powershell -NoProfile -Command "Start-Process '${installed}'"`);
  console.log(`\n✅ 桌面已装上并启回。`);
  // ⚠ 这里只印 commit,不印「构建时刻」:烤进包里的那个时刻是 vite 跑的那一秒,
  //   本脚本手上没有它(产物是压缩进 exe 的,读不回来)⇒ 印一个自己现取的时刻就是在编。
  //   要那一行的原文,去 app 里读 —— 那才是唯一的真相源。
  console.log(`   commit ${stamp.commit}${stamp.dirty ? "(含未提交改动)" : ""}`);
  console.log(`   用户那边核对:同步面板底部版本号下面那一行。`);
} else {
  // ── 安卓 ───────────────────────────────────────────────────────────────────
  // ⛔ 干净发版包,**不带 --devtools**:这台是用户的日常手机、装着他的真数据,
  //    devtools 包的 WebView 可被任意调试。验收要 CDP 时另走 skill `zhujian-android-verify`。
  console.log(`\n── 构建(干净发版包,不带 devtools)────────`);
  run("node", ["scripts/build-android.mjs"]);

  console.log(`\n── 核对 ───────────────────────────────────`);
  assertStampInBundle(join(root, "android/dist/assets"), "安卓");

  const outDir = join(root, "android/apk-out");
  const apks = existsSync(outDir) ? readdirSync(outDir).filter((f) => f.endsWith(".apk")) : [];
  if (apks.length === 0) die(`${outDir} 里没有 apk —— 构建其实没成?`);
  const apk = join(
    outDir,
    apks.sort((x, y) => statSync(join(outDir, y)).mtimeMs - statSync(join(outDir, x)).mtimeMs)[0],
  );
  const version = JSON.parse(readFileSync(join(root, "android/package.json"), "utf8")).version;

  console.log(`\n── 装机(USB;vivo 的拦截页由 android-install-auto 点掉)──`);
  console.log(`  ${apk}`);
  run("node", [
    "scripts/android-install-auto.mjs",
    apk,
    ...(device ? ["--device", device] : []),
    "--expect",
    version,
  ]);

  console.log(`\n✅ 安卓已装上。`);
  console.log(`   commit ${stamp.commit}${stamp.dirty ? "(含未提交改动)" : ""}`);
  console.log(`   用户那边核对:诊断面「关于」里的「构建」那一行。`);
}
