//! backlog 108:同一 data-dir 只许一个 zhujian-syncd 进程(`main.rs::lock_data_dir` 的排他锁)。
//!
//! **真起二进制**(`CARGO_BIN_EXE_zhujian-syncd`),不是进程内调 `serve` —— 锁是进程级的,
//! 挂在 main 上;只有两个真进程指向同一目录,才是生产里要拦的那件事。
//!
//! 一只测里分四幕,每幕各自可判:
//! ① A 起来并监听(⇒ A 已持锁:锁在 serve 之前拿);
//! ② B 指向同一目录 ⇒ 限时内退出、退出码 1、stderr 是锁那句、**从没监听过**;
//! ③ 把 banlist.txt 挪走再起 C ⇒ 报的仍是锁、不是缺封禁表 —— 钉「锁先于 load」的次序
//!   (锁挪到 load 之后,C 会先死在缺文件上);
//! ②′(仅 unix)把 data-dir 里每个文件都删掉重写一遍(= tar 往活目录解包 / 运维顺手 `rm *.lock`
//!   的形:文件全换了新 inode)再起 B′ ⇒ 照样被拦 —— 钉「锁在目录上、不在任何可被换掉的文件上」;
//! ④ SIGKILL 掉 A(不给它任何收尾机会)、还回 banlist ⇒ D 照样起得来 —— 钉「锁随进程死亡释放」。

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BIN: &str = env!("CARGO_BIN_EXE_zhujian-syncd");
/// 监听成功那一行的稳定前缀(lib.rs serve_inner 末尾那条 INFO)。
const LISTENING: &str = "zhujian-syncd 监听 ws://";
/// 锁冲突那句的稳定片段(main.rs lock_data_dir 的 WouldBlock 分支)。
const LOCKED: &str = "已被另一个 zhujian-syncd 进程占用";
const DEADLINE: Duration = Duration::from_secs(30);

fn command(dir: &Path) -> Command {
    let mut c = Command::new(BIN);
    c.args(["--listen", "127.0.0.1:0", "--data-dir"])
        .arg(dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    c
}

/// 测试 panic 也不留孤儿进程(孤儿会一直攥着锁、占着端口)。
struct Running(Child);

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// 起一个实例并等到它真在监听;没起来就 panic。
fn start_listening(dir: &Path) -> Running {
    try_start_listening(dir).unwrap_or_else(|err| panic!("实例没起来,stderr:\n{err}"))
}

/// 起一个实例并等到它真在监听;期间 stderr 由后台线程持续排空(防管道写满把它卡住)。
/// 没监听就退了 ⇒ `Err(stderr)`;超时 ⇒ panic。
fn try_start_listening(dir: &Path) -> Result<Running, String> {
    let mut child = command(dir).spawn().expect("起 zhujian-syncd 失败");
    let stderr = child.stderr.take().expect("stderr 已 piped");
    let running = Running(child);
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                // 接收端已不关心,继续排空即可
            }
        }
    });
    let start = Instant::now();
    let mut seen = Vec::new();
    loop {
        let left = DEADLINE.checked_sub(start.elapsed()).unwrap_or_default();
        match rx.recv_timeout(left) {
            Ok(line) => {
                let up = line.contains(LISTENING);
                seen.push(line);
                if up {
                    return Ok(running);
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(seen.join("\n")),
            Err(e) => panic!("实例 {DEADLINE:?} 内没监听({e:?}),stderr:\n{}", seen.join("\n")),
        }
    }
}

/// 起一个实例,期望它**自己在限时内退出**;返回退出状态与完整 stderr。
/// 超时 = 它起来了、没被拦 ⇒ 杀掉并 panic(这正是锁被摘掉时的形)。
fn run_expect_exit(dir: &Path) -> (ExitStatus, String) {
    let mut child = command(dir).spawn().expect("起 zhujian-syncd 失败");
    let mut stderr = child.stderr.take().expect("stderr 已 piped");
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });
    let start = Instant::now();
    let status = loop {
        if let Some(st) = child.try_wait().expect("try_wait") {
            break Some(st);
        }
        if start.elapsed() > DEADLINE {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(50));
    };
    let err = reader.join().expect("stderr 读线程");
    match status {
        Some(st) => (st, err),
        None => panic!("第二个实例在同一 data-dir 上起来了、{DEADLINE:?} 内没退出(锁没拦住),stderr:\n{err}"),
    }
}

fn assert_locked_out(what: &str, st: ExitStatus, err: &str) {
    assert_eq!(st.code(), Some(1), "{what}:退出码须为 1,实得 {st:?};stderr:\n{err}");
    assert!(err.contains(LOCKED), "{what}:stderr 须是锁冲突那句,实得:\n{err}");
    assert!(!err.contains(LISTENING), "{what}:被拦的实例不许监听过,stderr:\n{err}");
}

fn fresh_dir() -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("时钟")
        .as_nanos();
    let d = zhujian_syncd::test_temp::dir().join(format!("datadir-lock-{nanos}"));
    std::fs::create_dir_all(&d).expect("建 data-dir");
    std::fs::write(d.join("banlist.txt"), "#\n").expect("写 banlist.txt");
    d
}

#[test]
fn second_instance_on_same_data_dir_fails_fast_and_lock_dies_with_holder() {
    let dir = fresh_dir();

    // ① A 起来 = A 持锁
    let mut a = start_listening(&dir);

    // ② B 同目录 ⇒ 拒启
    let (st, err) = run_expect_exit(&dir);
    assert_locked_out("B(同目录第二实例)", st, &err);

    // ②′ 文件全换新 inode(tar 解包 / rm 锁文件那形)⇒ 仍拦得住
    #[cfg(unix)]
    {
        for entry in std::fs::read_dir(&dir).expect("列 data-dir") {
            let p = entry.expect("目录项").path();
            let bytes = std::fs::read(&p).expect("读");
            std::fs::remove_file(&p).expect("删");
            std::fs::write(&p, bytes).expect("重写");
        }
        let (st, err) = run_expect_exit(&dir);
        assert_locked_out("B′(文件全换 inode 之后)", st, &err);
    }

    // ③ 缺封禁表也照样先撞锁 ⇒ 锁先于 load
    let banlist = dir.join("banlist.txt");
    let parked = dir.join("banlist.parked");
    std::fs::rename(&banlist, &parked).expect("挪走 banlist.txt");
    let (st, err) = run_expect_exit(&dir);
    assert_locked_out("C(缺 banlist 的第三实例)", st, &err);
    std::fs::rename(&parked, &banlist).expect("还回 banlist.txt");

    // ④ A 被 SIGKILL(unix)/ TerminateProcess(Windows)⇒ 锁随之释放,D 起得来
    a.0.kill().expect("杀 A");
    a.0.wait().expect("收 A");
    let d = start_after_holder_died(&dir);
    drop(d);
}

/// unix:进程被收尸之前内核已关掉它的全部 fd ⇒ `wait()` 返回时锁必已放,**一次就得起来**。
#[cfg(unix)]
fn start_after_holder_died(dir: &Path) -> Running {
    start_listening(dir)
}

/// Windows:进程终止后 `LockFileEx` 锁何时放由系统定(微软文档原话「取决于可用的系统资源」)
/// ⇒ 只对「锁冲突」那一种失败在限时内重起;别的失败照样当场红。
#[cfg(not(unix))]
fn start_after_holder_died(dir: &Path) -> Running {
    let start = Instant::now();
    loop {
        match try_start_listening(dir) {
            Ok(r) => return r,
            Err(err) if err.contains(LOCKED) && start.elapsed() < DEADLINE => {
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(err) => panic!("持锁者死后 D 仍没起来,stderr:\n{err}"),
        }
    }
}
