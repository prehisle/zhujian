//! 构建期把「这只二进制是从哪个 commit 出来的」焊进产物(366)。
//!
//! **为什么非有它不可**:此前「线上跑的是哪一版」只能 ssh 上去看二进制的 mtime,
//! 再拿那个日期去跟提交历史比对——那是「看着像」不是「是」。260 的洪泛三闸因此
//! 在仓里躺了十天没人发现(365 刚在官网那一格栽过同一跤,并已把话写死:
//! **判据别用「我改了」,要用「线上是什么」**)。有了它,那句话才有可执行的判据,
//! `scripts/check-deployed-drift.mjs` 就是问它的那道闸。
//!
//! **fail-fast,不留 "unknown"**:git 拿不到就拒绝构建。一只自称版本未知的二进制
//! 会让门禁的判据静默失效——那正是本项目「绝不回退兜底」要挡的东西。服务端只从
//! git 检出构建(公开仓亦然),这一条不构成任何真实场景的阻碍。

use std::process::Command;

fn main() {
    // ⚠ **只要发出任意一条 `rerun-if-changed`,cargo 就不再默认扫整个包目录**,
    // 所以这里必须把该看的都列全,漏一样就是「改了却没重新取指纹」。
    println!("cargo:rerun-if-changed=src");
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=../sync-proto/src");
    // 提交与切分支都会往 reflog 追一行。这个文件**不存在**时 cargo 的行为是「每次
    // 都重跑」,而那恰好是安全的一侧:指纹只可能偏旧 → 门禁误报「线上落后」(响亮),
    // 绝不会误报「线上已是最新」(静默)。
    println!("cargo:rerun-if-changed=../.git/logs/HEAD");

    let commit = git(&["rev-parse", "--short=12", "HEAD"]);
    // 脏判据**只看服务端自己那两个目录**:桌面前端改没改与这只二进制无关,
    // 拿全仓的 porcelain 去判会让它几乎恒脏、于是这一格恒被忽略。
    let dirty = !git(&["status", "--porcelain", "--", ".", "../sync-proto"]).is_empty();
    let built_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("系统时钟早于 1970 = 机器配置错误")
        .as_secs();

    println!("cargo:rustc-env=ZJ_BUILD_COMMIT={commit}");
    println!("cargo:rustc-env=ZJ_BUILD_DIRTY={dirty}");
    println!("cargo:rustc-env=ZJ_BUILD_EPOCH={built_at}");
}

/// 跑一条 git 并要它成功;失败一律 panic 停构建(见顶注「不留 unknown」)。
fn git(args: &[&str]) -> String {
    let out = Command::new("git").args(args).output().unwrap_or_else(|e| {
        panic!("构建期取 git 信息失败({e})——服务端只从 git 检出构建,见 build.rs 顶注")
    });
    if !out.status.success() {
        panic!(
            "git {args:?} 退出码 {:?}:{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stderr).trim()
        );
    }
    String::from_utf8(out.stdout)
        .expect("git 输出非 UTF-8")
        .trim()
        .to_owned()
}
