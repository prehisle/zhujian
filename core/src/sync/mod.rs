//! P2 同步(sync-protocol 规格的客户端侧)。P2-c 落 sans-io 收端引擎与收敛
//! property test,P2-d 落加密层(crypto),P2-f 落配对(pair)与引导(boot),
//! P2-g 落传输层(transport:WSS 连接 + 鉴权 + 域封解帧 + 引导/配对编排,
//! sans-io 组件的唯一 IO 宿主,§8 布局)。
//!
//! 对 crate 外只公开 transport 与 supervisor(P4-a 窄公开面,android-plan §1 M2):
//! engine / crypto / pair / boot 是传输任务的内脏;supervisor(multispace-plan §2,
//! 工序 4)是 live 会话编排,app 壳(桌面/安卓)跟这两个打交道。

pub(crate) mod boot;
pub(crate) mod crypto;
pub(crate) mod engine;
pub(crate) mod pair;
pub mod supervisor;
pub mod transport;

#[cfg(test)]
mod convergence;
