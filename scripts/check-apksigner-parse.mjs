#!/usr/bin/env node
// 非发版门禁(416 立):压 scripts/lib/apk-signer.mjs 那只抓取器。
// 跑法:node scripts/check-apksigner-parse.mjs
//
// **它为什么存在**:386 立的签名证书闸把 signer 那一行的**头**写死了,而那个头随
// build-tools 版本变。本机停在 35、CI 装 36,且 386 之后一次安卓版都没发过 ⇒ 那道闸
// 在真 CI 上**第一次跑就是 0.3.31**,当场读不到指纹、拒发(fail-closed 救了这一次:
// 线上一个字节没动)。⇒ 这里钉住的是**两种真实输出格式都读得出**。
//
// ⭐ 纪律:下面两条样本是**真的量到的原文**,不是我照着格式编的 ——
//   · 35 那条:本机 `build-tools/35.0.1/lib/apksigner.jar verify --print-certs` 打的,
//     2026-08-17,APK = android/…/app-universal-release.apk。
//   · 36 那条:GitHub Actions run **31981031103**(android-v0.3.31 首趟,那趟就是被这个
//     bug 拒掉的)日志里 gen 脚本自己 `console.error(certs)` 印出来的原文,APK = CI 现造的
//     0.3.31 release 包。⚠ 其中 DN 那行的 `CN=***` 是 **GitHub 打的码**(原文按 35 那条是
//     `CN=zhujian`),原样留着 —— 别"修"成 zhujian,那会把样本从「量到的」改成「编的」。
// 新增格式**必须先在真工具上量到**再往下面加,别照着猜写。

import { signerSha256Digests } from "./lib/apk-signer.mjs";

const KEY = "b2d0614ae8ea67643afdea2d61c06d6b1090ccb6463310c0944c22191f6552f7";
const OTHER = "0123456789abcdef".repeat(4); // 64 位、格式合法但不是那把钥

// ── 真实样本(正例:必须逐字读出那一个指纹) ──
const REAL_BT35 = `Signer #1 certificate DN: CN=zhujian
Signer #1 certificate SHA-256 digest: ${KEY}
Signer #1 certificate SHA-1 digest: c6c4d6ab664b0267cdf868274e03171001d4c467
Signer #1 certificate MD5 digest: d0f6f053f4d5c20dc904397d988b768a
`;

const REAL_BT36 = `V2 Signer: certificate DN: CN=***
V2 Signer: certificate SHA-256 digest: ${KEY}
V2 Signer: certificate SHA-1 digest: c6c4d6ab664b0267cdf868274e03171001d4c467
V2 Signer: certificate MD5 digest: d0f6f053f4d5c20dc904397d988b768a
`;

const CASES = [
  // [标题, 输入, 期望抓到的指纹数组]
  ["真实样本 · build-tools 35(本机)", REAL_BT35, [KEY]],
  ["真实样本 · build-tools 36(CI run 31981031103)", REAL_BT36, [KEY]],

  // ── 阴性对照:读不出就必须是 0 条,让调用方 fail-closed ──
  ["空输入 → 0 条", "", []],
  ["只有 SHA-1(40 位)→ 0 条,别把它当 SHA-256", "Signer #1 certificate SHA-1 digest: c6c4d6ab664b0267cdf868274e03171001d4c467\n", []],
  ["指纹被截断(63 位)→ 0 条,不许「前缀刚好对得上」", `V2 Signer: certificate SHA-256 digest: ${KEY.slice(0, 63)}\n`, []],
  ["指纹多出一截(65 位)→ 0 条,同理", `V2 Signer: certificate SHA-256 digest: ${KEY}f\n`, []],
  ["apksigner 只说了句别的 → 0 条", "DOES NOT VERIFY\nERROR: JAR signer ...\n", []],

  // ── 多 signer:必须**全部**收进来,漏掉一个 = 那个不认识的钥会被放行 ──
  [
    "两个 signer(轮换血统)→ 两条都要,不许只取第一条",
    `Signer #1 certificate SHA-256 digest: ${KEY}\nSigner #2 certificate SHA-256 digest: ${OTHER}\n`,
    [KEY, OTHER],
  ],
  [
    "两个 signer 走 36 的格式 → 同样两条都要",
    `V3 Signer: certificate SHA-256 digest: ${KEY}\nV3.1 Signer: certificate SHA-256 digest: ${OTHER}\n`,
    [KEY, OTHER],
  ],

  // ── 大写十六进制:归一化到小写,否则与常量比对会假红 ──
  ["大写十六进制 → 归一化成小写", `V2 Signer: certificate SHA-256 digest: ${KEY.toUpperCase()}\n`, [KEY]],
];

let fail = 0;
for (const [title, input, want] of CASES) {
  const got = signerSha256Digests(input);
  const ok = got.length === want.length && got.every((d, i) => d === want[i]);
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${title}`);
  if (!ok) console.log(`     期望 ${JSON.stringify(want)}\n     实得 ${JSON.stringify(got)}`);
}

// ⭐ 最后一格压的不是抓取器,是**这道闸的用法**:抓到的每一条都必须等于那把钥,
// 一条不认识就得拒 —— 这正是 386 想守的那句话,单独钉一次防止哪天被改成 `.some()`。
const mixed = signerSha256Digests(
  `Signer #1 certificate SHA-256 digest: ${KEY}\nV2 Signer: certificate SHA-256 digest: ${OTHER}\n`,
);
const allMatch = mixed.length > 0 && mixed.every((d) => d === KEY);
if (allMatch) {
  fail++;
  console.log("❌ 混入一个陌生 signer,却判成「全是那把钥」—— 判据被放松了");
} else {
  console.log("✅ 混入一个陌生 signer → 判定不通过(逐个比对,不是 some)");
}

console.log(fail === 0 ? "\n抓取器两种真实格式都读得出,阴性对照全红。" : `\n${fail} 条不符。`);
process.exit(fail === 0 ? 0 : 1);
