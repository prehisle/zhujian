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
/// L-b 局域网直连的纯逻辑层(lan-direct-plan)。IO 宿主分两处:链路集与投递面在
/// transport(L-c2c),监听器准入表与握手任务在 [`lan_net`](L-c3a)。拨号器(L-c3b)
/// 之前仍有少数条目只被测试调用,`dead_code` 整模块豁免暂留。
#[allow(dead_code)]
pub(crate) mod lan;
/// L-c3a 局域网直连的 IO 面:本机接口枚举 + app 级监听器与准入表 + pre-auth 握手任务。
pub(crate) mod lan_net;
/// L-d″:op 追赶的惰性供流——计划、节流与公平调度(第①笔)、LAN 与中转两条消费腿
/// (第②/④笔)、三个生产入口的原子切换(第⑤笔)。**dormant 标记已撤**:
/// `on_hello` / `on_want` / `outbound` 与出站 Hello 的有界水位都在生产路径上。
pub(crate) mod ops_serve;
pub(crate) mod pair;
/// **台架专用**(305 真机复验,feature `probe305` 默认关;验完即撤)。
/// 消费方按 `use crate::sync::probe::p305;` 显式引(**不走 `#[macro_use]`**:那条
/// 的可见域只到本文件里排在它后面的 `mod`,engine/ops_serve 都在它前面)。
pub(crate) mod probe;
pub mod supervisor;
pub mod transport;

#[cfg(test)]
mod convergence;

/// 结构锚读源码时的「生产段」取法。
///
/// 310 起 `transport` / `engine` / `boot` / `lan` / `ops_serve` / `supervisor` 六个大
/// 文件的测试段住在 `<name>/tests/` 里,故 `include_str!` 读到的**整个文件就是生产段**,
/// 不必再切。这道闸挡的是唯一还能坏事的那种漂移:**有人把测试又内联写回主文件** ——
/// 那样结构锚会把测试代码当生产码扫,一条本该红的规则会被夹具里的字面量喂绿。
///
/// (搬家之前这里是 17 处 `&src[..src.find("mod tests {").expect(…)]`;那句
/// `expect` 在测试段搬走后必 panic,故这一格非改不可,顺手把断言方向倒过来。)
#[cfg(test)]
pub(crate) fn production_src(src: &'static str, what: &str) -> &'static str {
    assert!(
        !src.contains("\nmod tests {"),
        "{what}:主文件里又出现了内联测试模块。结构锚会把测试代码当生产码扫 —— \
         测试段该住 <name>/tests/(progress-log 310)。"
    );
    src
}
