// apksigner `verify --print-certs` 输出里那些签名证书指纹的抓取器。
//
// **为什么单独住一个文件**:416 实栽 —— 386 立的「签的必须是那把 release key」那道闸,
// 原本把 signer 那一行的**头**写死成 `Signer #\d+ certificate SHA-256 digest:`。
// 而那个头**随 build-tools 版本变**:
//   · build-tools 35.0.0 / 35.0.1(本机)→ `Signer #1 certificate SHA-256 digest: <hex>`
//   · build-tools 36.0.0(CI 里 workflow 显式装的那个)→ `V2 Signer: certificate SHA-256 digest: <hex>`
// 同一个 APK、同一把钥、同一个指纹,**只有前缀不一样**。386 那轮只在本机(35)验过,
// 而 386 之后到 0.3.31 之前没发过一次安卓版 ⇒ 这道闸在真 CI 上**第一次跑就是 0.3.31**,
// 当场「读不到任何签名证书指纹」拒发。⭐ fail-closed 救了这一次:线上一个字节没动。
//
// ⇒ 修法是**只锚稳定的那半句**,前缀一概不认。认不出的新格式会被一起收进来、逐个与
// 期望指纹比对,而不是被漏掉、退化成「一个 signer 都没有」。抓漏的方向是拒发(安全),
// 抓多的方向是「多出来那个也必须是那把钥」(更严,不是更松)。
//
// ⚠ 这个函数被 scripts/gen-android-update-manifest.mjs 与 scripts/check-apksigner-parse.mjs
// **共用同一份**——后者压的就是「两种真实输出格式都读得出」,别把逻辑再抄一遍(抄一遍
// 就成了自指的空测,292 判例)。

/**
 * 从 apksigner `verify --print-certs` 的输出里抓出**全部** signer 的 SHA-256 指纹。
 * @param {string} text apksigner 的 stdout 原文
 * @returns {string[]} 小写十六进制指纹,顺序即出现顺序;读不到返回空数组(调用方须 fail-closed)
 */
export function signerSha256Digests(text) {
  // `(?![0-9a-f])` 是**故意**的:长度不对的十六进制串(被截断 / 多出一截)不许被当成
  // 「前 64 位刚好对得上」而悄悄放行 —— 读不出就该退回 0 条,让调用方 fail-closed。
  return [...String(text).matchAll(/certificate SHA-256 digest:\s*([0-9a-f]{64})(?![0-9a-f])/gi)].map(
    (m) => m[1].toLowerCase(),
  );
}
