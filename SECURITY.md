# 安全问题怎么报 / Reporting a security issue

## 中文

发邮件到 **3069848@qq.com**,标题里带上「安全」两个字。

- 请**先别公开**(不要开 issue、不要发帖),给我一点时间修好再说。
- 能写多少写多少:哪个版本、哪个平台(Windows / Android / 鸿蒙 / macOS / Linux)、
  怎么复现。能附上你看到的原始报错最好。
- ⚠ **别把你的备份码、恢复码、备份文件发过来** —— 那些东西等于你数据的钥匙,
  我不需要它们也能看问题。

**我能承诺什么**:这是一个人业余做的项目,所以我不承诺小时级的响应,
但我会看每一封这样的邮件,并在修好之后告诉你。**我不做赏金**,也没有 CVE 流程。

**哪些版本在修**:只修最新版 —— 电脑端与安卓端各自最新的那一个。
旧版不回补,请先升级再看问题还在不在。

**几件事先说清楚,免得当成漏洞报**:

- 同步是端到端加密的,服务器只经手密文;但**一份备份文件加上备份码,等于这个账户的
  完整读写能力**,这是设计如此,不是缺陷(要恢复出来的库还能同步,就得带上身份)。
- **Windows 安装包没有做系统签名**,首次安装会提示「未知发布者」;更新包有开发者签名、
  装前会核对。macOS 与 Linux 的尝鲜版也没签名。
- 卸载电脑端**不会**删掉数据目录和备份钥,要手动清。
- 能读到你这台机器上当前用户文件的人,也能直接读明文库 —— 本机沦陷不在防御范围内。

## English

Email **3069848@qq.com** with “security” in the subject line.

- Please **do not open a public issue** first; give me a chance to fix it.
- Include the version, the platform (Windows / Android / HarmonyOS / macOS / Linux),
  and how to reproduce it. Raw error text helps.
- ⚠ **Never send your backup code, recovery code, or backup files.** Those are the keys
  to your data, and I do not need them to look into a problem.

This is a one-person side project: no hourly response promise, no bug bounty, no CVE
process. I do read every one of these emails and will tell you when it is fixed.
**Only the latest desktop and Android versions are fixed** — older versions get no
backports, so please upgrade first and check whether the problem is still there.

Known and by design, so not bugs: sync is end-to-end encrypted and the server only ever
handles ciphertext, but a backup file plus its backup code is full read/write access to
that account; the Windows installer is not code-signed (updates are signed and verified);
uninstalling on desktop leaves the data folder and backup key behind; and anything that
can read your user's files can read the plaintext database directly — local compromise is
out of scope.
