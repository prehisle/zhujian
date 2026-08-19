// 安卓构建统一入口(2026-07-14)——把「发版干净包」与「验收 devtools 调试包」分成
// 两条明确路径,堵死两个坑:
//   ① 误发 devtools 包:产物旁写 build-profile.json 作构建来源标记,
//      gen-android-update-manifest.mjs 见到 devtools:true 硬拒发版。
//   ② 干净包备份被 gradle clean 清掉(2026-07-14 翻过一次):干净包统一复制到
//      构建目录外的 android/apk-out/(gitignore),下次 gradle clean 清不到。
//
// devtools feature = WebView 远程调试(Chrome DevTools 协议),只给真机 UI 验收用
// (见 scripts/android-cdp.mjs);发版包绝不能带(WebView 可被任意调试是安全风险)。
//
// 用法:
//   node scripts/build-android.mjs            # 干净发版包(默认,不带 devtools)
//   node scripts/build-android.mjs --devtools # 验收调试包(WebView 远程可调试)
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { pickBuildTools, describeBuildToolsPick } from "./lib/build-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const devtools = process.argv.includes("--devtools");
// **台架专用**(305 真机复验,验完即撤):打开 core 的 ops 供流埋点,经
// tauri-plugin-log 直达 logcat(`adb logcat | grep P305`)。与 --devtools 同属
// 「不许发版」那一档。
const probe305 = process.argv.includes("--probe305");

// ── 1. 三处版本号一致(与 gen-android-update-manifest.mjs 同锚,构建前先拦) ──
const pkg = JSON.parse(readFileSync(join(root, "android/package.json"), "utf8")).version;
const conf = JSON.parse(
  readFileSync(join(root, "android/src-tauri/tauri.conf.json"), "utf8"),
).version;
const cargo = readFileSync(join(root, "android/src-tauri/Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (!(pkg === conf && conf === cargo)) {
  console.error(`版本号不一致:package.json=${pkg} tauri.conf.json=${conf} Cargo.toml=${cargo}`);
  console.error("安卓发版前三处必须同步 bump(android-plan §8)。");
  process.exit(1);
}
const version = pkg;
const parts = version.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  console.error(`版本号「${version}」不是 x.y.z 三段数字。`);
  process.exit(1);
}
const versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2];

// ── 2. 构建 ──
console.log(
  `构建安卓${devtools ? "验收调试包(devtools)" : "发版干净包"} v${version} / versionCode ${versionCode}…`,
);
const args = ["tauri", "android", "build", "--apk", "--target", "aarch64"];
const feats = [];
if (devtools) feats.push("devtools");
// **台架专用**(305 真机复验,验完即撤):core 的 ops 供流埋点 → logcat。
// 与 devtools 同一条护栏 —— 见下面 build-profile.json 的 `clean` 判据。
if (probe305) feats.push("probe305");
if (feats.length) args.push("--features", feats.join(","));
execFileSync("npx", args, { cwd: join(root, "android"), stdio: "inherit", shell: true });

// ── 3. aapt 验产物 versionCode(与 gen 脚本同一 aapt 定位) ──
const apkDir = join(
  root,
  "android/src-tauri/gen/android/app/build/outputs/apk/universal/release",
);
const apkPath = join(apkDir, "app-universal-release.apk");
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) {
  console.error("未设 ANDROID_HOME/ANDROID_SDK_ROOT,找不到 aapt 核验 APK。");
  process.exit(1);
}
const btDir = join(sdk, "build-tools");
// ⛔ 别改回 `.sort().at(-1)`(字典序,见 scripts/lib/build-tools.mjs 头注三种挑错)。
const btPick = pickBuildTools(readdirSync(btDir));
for (const line of describeBuildToolsPick(btPick)) console.error(line);
if (!btPick.name) {
  console.error(`${btDir} 底下一个认得出版本号的 build-tools 都没有——核不了 versionCode,停。`);
  process.exit(1);
}
const bt = btPick.name;
const aapt = join(btDir, bt, process.platform === "win32" ? "aapt.exe" : "aapt");
const badging = execFileSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8" });
const apkCode = badging.match(/versionCode='(\d+)'/)?.[1];
if (Number(apkCode) !== versionCode) {
  console.error(`APK versionCode=${apkCode} 与预期 ${versionCode} 不符——构建异常。`);
  process.exit(1);
}

// ── 4. 产物旁写构建来源标记(发版护栏的真相源) ──
// **凡带任一台架 feature 的包都不许发版**,故 `clean` 是一个总闸而不是逐个 feature
// 判——发版脚本只要问「干不干净」这一个问题,以后再加台架 feature 也不会漏掉它。
const tainted = devtools || probe305;
const profile = {
  profile: tainted ? [devtools && "devtools", probe305 && "probe305"].filter(Boolean).join("+") : "release",
  clean: !tainted,
  devtools,
  probe305,
  version,
  versionCode,
};
writeFileSync(join(apkDir, "build-profile.json"), JSON.stringify(profile, null, 2) + "\n");

// ── 5. 干净包复制到构建目录外(gradle clean 清不到;发版从这里取) ──
if (!tainted) {
  const outDir = join(root, "android/apk-out");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  const outApk = join(outDir, `zhujian_${version}_aarch64.apk`);
  copyFileSync(apkPath, outApk);
  writeFileSync(join(outDir, "build-profile.json"), JSON.stringify(profile, null, 2) + "\n");
  console.log(`\n✔ 干净发版包已就位:`);
  console.log(`  产物 ${apkPath}`);
  console.log(`  副本 ${outApk}(构建目录外,gradle clean 清不到)`);
  console.log(`  下一步:node scripts/gen-android-update-manifest.mjs "更新说明"`);
} else {
  console.log(`\n✔ 验收包已就位(${profile.profile}):`);
  console.log(`  ${apkPath}`);
  console.log(`  装机后:adb install -r <apk> → node scripts/android-cdp.mjs forward`);
  console.log(`  ⚠ 此包带台架 feature,gen-android-update-manifest.mjs 会拒绝用它发版。`);
}
