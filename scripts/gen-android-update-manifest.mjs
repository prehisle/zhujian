// 安卓发版(106):核对 android/ 三处版本号一致 + 生成安卓更新清单 android.json。
// 与桌面 latest.json 刻意分开:那份归 Tauri updater 严格消费,两端发版节奏也不绑死。
// 用法:
//   node scripts/gen-android-update-manifest.mjs ["更新说明"]
// 前置:先 `cd android && npx tauri android build --apk --target aarch64`(签名钥
// keystore.properties)。生成后按打印的 scp 命令上传 VPS(APK 上传时改名带版本号)。
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { signerSha256Digests } from "./lib/apk-signer.mjs";
import { pickBuildTools, describeBuildToolsPick } from "./lib/build-tools.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = "https://zhujian.app/updates";
const fwd = (p) => p.replace(/\\/g, "/");

// ── 1. 安卓三处版本号必须一致(与桌面 gen-update-manifest.mjs 同一纪律,漂移即拒发) ──
const pkg = JSON.parse(readFileSync(join(root, "android/package.json"), "utf8")).version;
const conf = JSON.parse(
  readFileSync(join(root, "android/src-tauri/tauri.conf.json"), "utf8"),
).version;
const cargo = readFileSync(join(root, "android/src-tauri/Cargo.toml"), "utf8").match(
  /^version\s*=\s*"([^"]+)"/m,
)?.[1];
if (!(pkg === conf && conf === cargo)) {
  console.error(
    `版本号不一致:android/package.json=${pkg} tauri.conf.json=${conf} Cargo.toml=${cargo}`,
  );
  console.error("安卓发版前三处必须同步 bump(android-plan §8)。");
  process.exit(1);
}
const version = pkg;

// ── 2. versionCode 与 tauri 同公式(android/src-tauri/src/update.rs 同锚):
//        覆盖安装的硬闸(L2)= versionCode 单调递增,版本号只许往上走。 ──
const parts = version.split(".").map(Number);
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
  console.error(`版本号「${version}」不是 x.y.z 三段数字。`);
  process.exit(1);
}
const versionCode = parts[0] * 1_000_000 + parts[1] * 1_000 + parts[2];

// ── 3. APK 产物 ──
const apkPath = join(
  root,
  "android/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk",
);
if (!existsSync(apkPath)) {
  console.error(`找不到 APK:${fwd(apkPath)}`);
  console.error("先跑 `cd android && npx tauri android build --apk --target aarch64`。");
  process.exit(1);
}
const apkName = `zhujian_${version}_aarch64.apk`;

// ── 3.5 APK 本体必须真是本版:桌面脚本靠文件名带版本防「新旧并存拿错包」,安卓产物
//        名固定 app-universal-release.apk,该防护不存在——必须拆开验 versionCode,
//        否则清单说 2001、传上去的还是旧 2000,手机端陷入「提示→装→还是旧版→再提示」
//        死循环(107 审查抓出)。aapt 在 Android SDK build-tools 里(103 已用它核验过
//        备份 flags)。 ──
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk) {
  console.error("未设 ANDROID_HOME/ANDROID_SDK_ROOT,找不到 aapt 来核验 APK 的 versionCode。");
  process.exit(1);
}
const btDir = join(sdk, "build-tools");
// ⛔ 别改回 `.sort().at(-1)`:那是**字典序**,`35.0.9` 会赢 `35.0.10`、rc 会赢正式版。
// 判据与三种挑错逐条钉在 scripts/lib/build-tools.mjs 与 check-build-tools-pick.mjs 里。
const btPick = pickBuildTools(readdirSync(btDir));
for (const line of describeBuildToolsPick(btPick)) console.error(line);
if (!btPick.name) {
  console.error(`${fwd(btDir)} 底下一个认得出版本号的 build-tools 都没有——判不了,拒发(fail-closed)。`);
  process.exit(1);
}
const bt = btPick.name;
const aapt = join(btDir, bt, process.platform === "win32" ? "aapt.exe" : "aapt");
const badging = execFileSync(aapt, ["dump", "badging", apkPath], { encoding: "utf8" });
const apkCode = badging.match(/versionCode='(\d+)'/)?.[1];
if (Number(apkCode) !== versionCode) {
  console.error(`APK 里的 versionCode=${apkCode},与本版预期 ${versionCode} 不符——是旧构建。`);
  console.error("先重新跑 `node scripts/build-android.mjs`(干净发版包)。");
  process.exit(1);
}

// ── 3.6 发版护栏(2026-07-14):APK 绝不能是带 devtools 的验收调试包(WebView 可被
//        任意调试=安全风险)。build-profile.json 由 scripts/build-android.mjs 构建时
//        写在产物旁,是构建来源的真相源:见 devtools:true 硬拒,缺标记=未走统一入口也拒
//        (这次翻车就是手动 --features devtools 构建后差点误发)。 ──
const profilePath = join(dirname(apkPath), "build-profile.json");
if (!existsSync(profilePath)) {
  console.error("产物旁没有 build-profile.json——无法确认这是不是干净发版包。");
  console.error("请用 `node scripts/build-android.mjs` 构建(它会写构建来源标记)。");
  process.exit(1);
}
const prof = JSON.parse(readFileSync(profilePath, "utf8"));
// **判据是「干不干净」这一个总闸,不是逐个 feature 点名**(305 加 probe305 时改)。
// 旧标记没有 `clean` 字段,`!== true` 就落到下面按 devtools 兜底那一句——老产物
// 不会因为换了判据而被静默放行。
if (prof.clean !== true || prof.devtools || prof.probe305) {
  const feats = prof.profile ?? (prof.devtools ? "devtools" : "未知");
  console.error(`这是带台架 feature 的验收包(${feats}),绝不能发版!`);
  console.error("请用 `node scripts/build-android.mjs`(不带任何台架开关)出干净包。");
  process.exit(1);
}
if (prof.versionCode !== versionCode) {
  console.error(
    `build-profile.json 的 versionCode=${prof.versionCode} 与本版 ${versionCode} 错配——重新构建。`,
  );
  process.exit(1);
}

// ── 3.7 签的必须是那把 release key(386 可优化项第⑥条补的第四道闸)。前三道管的是
//        「版本对不对 / 包干不干净」,签名证书本身从来没核过。签错 key 的后果不是报错而是
//        **用户覆盖装报「应用未安装」**:安卓按签名证书认同一个应用,换了证书就是另一个应用,
//        存量用户必须先卸载(= 本地数据全没)才装得上。⇒ 这一道 fail-closed,读不出也拒发。
//        判据锚在**用户机上那份**:下面这个指纹 2026-08-15 由三个独立来源量到、逐字相同 ——
//        ①线上 updates/zhujian_0.3.30_aarch64.apk(存量用户装的就是它)②本机 keystore
//        (keytool -list,alias=zhujian)③本机产物 APK。改这个常量 = 换签名钥 = 所有存量
//        用户装不上,绝不是「更新一下期望值」那种动作。 ──
const EXPECTED_SIGNER_SHA256 = "b2d0614ae8ea67643afdea2d61c06d6b1090ccb6463310c0944c22191f6552f7";
// apksigner 的 .bat/.sh 包装在 Node 里不能直接 execFile(Windows 下 spawn .bat 是 EINVAL),
// 直接跑它的 jar:两平台同一条路径,CI 的 JDK 17 与本机 JAVA_HOME 都能起。
const apksignerJar = join(btDir, bt, "lib", "apksigner.jar");
if (!existsSync(apksignerJar)) {
  console.error(`找不到 apksigner:${fwd(apksignerJar)} —— 无法核验签名证书,拒发。`);
  console.error(`装上 build-tools(sdkmanager "build-tools;${bt}")后重跑。`);
  process.exit(1);
}
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java") : "java";
let certs;
try {
  // verify 本身会校验 APK 的签名完整性(v1/v2/v3),没签名/被改过的包在这一步就非零退出。
  certs = execFileSync(java, ["-jar", apksignerJar, "verify", "--print-certs", apkPath], {
    encoding: "utf8",
  });
} catch (e) {
  console.error("apksigner 核验签名失败(包没签名 / 被改过 / java 起不来),拒发:");
  console.error(String(e.stdout ?? "") + String(e.stderr ?? e.message));
  process.exit(1);
}
// 取**全部** signer 的指纹:多签(如证书轮换血统)时每一个都必须是那把钥,一个不认识就拒。
// ⚠ 抓取器住 scripts/lib/apk-signer.mjs,**别把 signer 那一行的头写死**(416 实栽:
// build-tools 35 印 `Signer #1 certificate …`、36 印 `V2 Signer: certificate …`,
// 同一把钥同一个指纹,只是前缀变了 ⇒ 这道闸在真 CI 上首次触发就读不到、拒发)。
const digests = signerSha256Digests(certs);
if (digests.length === 0) {
  console.error("apksigner 输出里读不到任何签名证书指纹——判不了,拒发(fail-closed)。");
  console.error("(若是 build-tools 换版换了输出格式,改 scripts/lib/apk-signer.mjs 并补一条真实样本)");
  console.error(certs);
  process.exit(1);
}
const wrong = digests.filter((d) => d !== EXPECTED_SIGNER_SHA256);
if (wrong.length > 0) {
  console.error(`APK 的签名证书不是那把 release key:${wrong.join(", ")}`);
  console.error(`期望:${EXPECTED_SIGNER_SHA256}`);
  console.error("⛔ 发出去存量用户会报「应用未安装」(安卓按证书认应用,必须卸载重装才行)。");
  console.error("检查 keystore.properties / CI 的 ANDROID_KEYSTORE_B64 是不是换了钥。");
  process.exit(1);
}

// ── 4. 清单(字段与 update.rs::AndroidUpdate 逐键对应,versionCode 是比较轴) ──
const notes = process.argv[2] ?? `朱简安卓版 v${version}`;
const manifest = {
  version,
  versionCode,
  notes,
  pub_date: new Date().toISOString(),
  url: `${BASE_URL}/${apkName}`,
};
const outPath = join(dirname(apkPath), "android.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

console.log(`✔ 生成 ${fwd(outPath)}`);
console.log(`  版本 ${version} · versionCode ${versionCode} · APK ${apkName}`);
console.log("");
// 583:同桌面那支,改印共用上传器(理由见 gen-update-manifest.mjs 同处 / deploy §7.3a)。
console.log("上传到 VPS(空间闸前置 + 临时名换名;APK 在 staging 里就改好名):");
console.log("  mkdir -p upload-manual && rm -f upload-manual/*");
console.log(`  cp "${fwd(apkPath)}" upload-manual/${apkName}`);
console.log(`  cp "${fwd(outPath)}" upload-manual/android.json`);
console.log(
  "  ZJ_UPLOAD_HOST=69.63.208.74 ZJ_UPLOAD_DIR=/var/www/zhujian-app/updates \\\n" +
    "    bash scripts/release-upload.sh upload-manual android.json 'zhujian_*_aarch64.apk'",
);
console.log(`  curl -s --noproxy "*" ${BASE_URL}/android.json   # 核验`);
