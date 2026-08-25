//! zhujian-core —— 朱简共享核心(P4-a,android-plan §1)。
//!
//! 数据层(items 单实体 + topics/item_topic + item_revisions + item_image +
//! oplog/HLC/fractional index,30 条迁移)与同步客户端侧(收端引擎 / E2EE 加密层 /
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

/// 加密备份(backup-plan 笔①-a,402 格式层 / 412 收口)。**公开面只有
/// `BackupCoordinator` 那一组**(见模块头注):备份钥不出 crate,引擎与 staging 也不出——
/// 所有备份 / 清扫入口必须经 coordinator(⛔ 这一条是冲着笔①-b 的自动备份去的:
/// 它不会走桌面命令层,门开在壳里就等于没门)。
pub mod backup;
/// 看板列(`board_column`,board-columns-plan B 系列,迁移 0036 起)。公开面 = read model
/// (`list_columns` / `BoardColumnRow`)+ **480/B-c 第 3 段起的四条写命令**
/// (`create_column` / `rename_column` / `reorder_column` / `delete_column` —— **全仓唯一会
/// 往外发 `board_column` op 的路**);seed 描述源、两道审计、「什么是任务态」那三个判据、
/// 以及「哪几列永不可删」(`undeletable_reason`,plan §2.3a)都是 crate 内件。
/// ⛔ 两壳的 UI 接线归 **B-f**,且它**不拥有任何数据安全判定**(plan §8.1-2)——
/// 「这一列能不能删」读 `BoardColumnRow::deletable`,别在壳里另算一份。
pub mod board;
pub mod clock;
pub mod comments;
pub mod db;
/// 同步实体登记表与结构锚(见模块头注):十一个横切面「加实体要改几处」的单一清单。
/// 纯锚,无生产消费者,故 `cfg(test)` —— 与 `transport_sources()` 同性质。
#[cfg(test)]
mod entity_registry;
pub mod epoch;
mod frindex;
pub mod identity;
pub mod images;
pub mod move_item;
pub mod notes;
mod oplog;
mod replay;
pub mod repo;
pub mod spaces;
pub mod sync;
pub mod task;
/// 结构锚的源码解析工具箱(Repo / 剔注释 / 函数体与常量体切片 / SQL 表名抓取;
/// 见模块头注)。纯测试侧共享件,故 `cfg(test)` —— 与 `test_temp` 同性质。
#[cfg(test)]
mod test_src;
#[cfg(test)]
mod test_temp;
#[cfg(test)]
mod test_temp_cleanup;
pub mod thumbs;
