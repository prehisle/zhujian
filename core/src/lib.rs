//! zhujian-core —— 朱笺共享核心(P4-a,android-plan §1)。
//!
//! 数据层(items 单实体 + topics/item_topic + item_revisions + item_image +
//! oplog/HLC/fractional index,26 条迁移)与同步客户端侧(收端引擎 / E2EE 加密层 /
//! SPAKE2 配对 / 快照引导 / WSS 传输)全在这里;桌面 tauri 壳(../src-tauri)与
//! 安卓壳双端 path 依赖共用,本 crate 零 tauri 耦合。切割线 = tauri app 壳 vs 其余全部。
//!
//! 公开面刻意窄(android-plan §1 M2):
//! - `frindex` / `oplog` / `replay` 是编排层的内部件,不公开;
//! - `sync` 只公开 `transport` 与 `supervisor`(engine/crypto/pair/boot 是内脏;
//!   supervisor 是 multispace-plan §2 的 live 会话编排,两壳共用);
//! - `spaces` 是空间「存在与身份」共享层(multispace-plan 工序 2+3,97 桌面壳上抬);
//! - 密钥材料(k_acc / device_seed)不出 crate——恢复码走
//!   `sync::transport::recovery_code`,SyncConfig 保持 crate 内;
//! - ⚠ rustls 加密提供者由 app 壳启动时安装(`install_default`),core 只钉 ring
//!   特性——不装则首次 wss:// 在 `ClientConfig::builder()` panic(84 真机踩过)。

pub mod clock;
pub mod db;
pub mod epoch;
mod frindex;
pub mod images;
pub mod move_item;
pub mod notes;
mod oplog;
mod replay;
pub mod repo;
pub mod spaces;
pub mod sync;
pub mod task;
