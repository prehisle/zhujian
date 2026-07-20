//! 达量限速的账户计量 + 可取消 ticket 调度(billing-plan §4,工序 3;169,codex 六轮
//! 设计审 GO)。**纯同步逻辑**(调用方在 hub 的第三把锁 `Mutex<Meters>` 下驱动;等待
//! 期间的 `sleep`/`select` 在 conn.rs 临界区外)——本模块不碰 socket、不锁 registry。
//!
//! 两半合体、同锁访问:
//! * **计量**:`fastlane_used`(本 UTC 月已计 wire 字节)+ `period`(有序月份,粗
//!   checkpoint 落 sidecar,丢一窗规格允许);
//! * **调度**:超月度 grant 后(`FastlaneExhausted`)按达量速率 R 排队——**device 键
//!   FIFO ticket**,每 ticket 携独立 `disp`(Arc<AtomicU8>,waiter 自持)与 watch
//!   generation(无丢唤醒)。上界 `pending ≤ device_cap`(准入按 registry 设备集剪枝 +
//!   session generation 挡同设备重连 ABA);单帧最大等待 = `device_cap·最大帧/R`,启动
//!   校验 `≤ silence/3`(见 lib.rs)。
//!
//! 四条防御断言(codex 终局 GO 留):①`session_gen` 不回绕(到顶 fail-fast);
//! ②disposition 终态不可重写;③`clear_if_current` 只清对应 device/gen;④watch sender
//! 关闭按 shutdown 处理(在 conn.rs)。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::watch;

// ---- ticket disposition(waiter 经自持的 `Arc<AtomicU8>` 观察)----
pub const DISP_PENDING: u8 = 0;
pub const DISP_ADMITTED: u8 = 1;
pub const DISP_RELEASED: u8 = 2;
pub const DISP_CANCELLED: u8 = 3;

/// 受限原因集合(billing-plan §4;169 工序 3)。**枚举三变体齐备、状态是原因集合**,
/// 但工序 3 只有 `FastlaneExhausted` 可达;`SeatOverage`(数据面关闭)/`AdminAbuse`
/// (处置速率)的执行边随各自入口在工序 6 落(见 §9 表)。此处定义供后续工序复用、
/// 不加不可达执行分支。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RestrictionReason {
    FastlaneExhausted,
    SeatOverage,
    AdminAbuse,
}

/// 终态只能从 Pending 写一次(codex 断言②;compare_exchange 使 release 构建也响亮——
/// 非 debug_assert)。正确逻辑下每 ticket 只置一次终态、随即摘除,恒成功。
fn set_disp(disp: &AtomicU8, to: u8) {
    disp.compare_exchange(DISP_PENDING, to, Ordering::SeqCst, Ordering::SeqCst)
        .expect("disposition 终态不可重写(逻辑 bug)");
}

/// 一条在等帧的 ticket。`disp` 由 waiter 与 pending 项各持一份 `Arc`,终态置位后从
/// pending 摘除,两份随各自退出释放——无无限 tombstone。
struct Ticket {
    device: String,
    conn_id: u64,
    session_gen: u64,
    ticket_id: u64,
    /// 可放行时刻(虚拟调度点;取消重排时可前移)。
    start: Instant,
    /// 本帧服务时长 = ceil(bytes / R)。
    service: Duration,
    disp: Arc<AtomicU8>,
}

/// 每账户计量 + 调度态(在 `Meters` 的锁下)。
struct AccountMeter {
    /// 本 UTC 月(有序比较;粗 checkpoint 落 sidecar)。
    period: (i32, u8),
    /// 本期已计 wire 字节(fast+throttled 都计)。
    fastlane_used: u64,
    /// device → 当前会话代际(session ABA 守卫)。
    sessions: HashMap<String, u64>,
    /// FIFO pending ticket(device 去重后 ≤ device_cap)。
    pending: Vec<Ticket>,
    /// 已放行(admitted)服务的地平线;即使 pending 空也保留(同连接下一帧不零穿透)。
    committed_until: Instant,
    next_ticket: u64,
    /// 无丢唤醒 generation(admit/cancel/release/begin_session 皆 bump)。
    gen_tx: watch::Sender<u64>,
    generation: u64,
}

impl AccountMeter {
    fn new(period: (i32, u8), now: Instant) -> Self {
        let (gen_tx, _) = watch::channel(0);
        AccountMeter {
            period,
            fastlane_used: 0,
            sessions: HashMap::new(),
            pending: Vec::new(),
            committed_until: now,
            next_ticket: 0,
            gen_tx,
            generation: 0,
        }
    }

    fn bump(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        // 接收端全断开也无妨(send 返回 Err 忽略);waiter 在 poll 里读实况,不靠 gen 值本身。
        let _ = self.gen_tx.send(self.generation);
    }

    /// pending 尾端服务结束时刻(空则 `committed_until`)。
    fn tail_end(&self) -> Instant {
        self.pending.last().map(|t| t.start + t.service).unwrap_or(self.committed_until)
    }

    /// 删 index 处 ticket 后**重排整个 FIFO**(codex 实现审 H-1:只从 idx 重排会忽略
    /// 前驱 pending 的服务尾点,删中间项会让后继与前驱服务槽重叠、吞吐破 R)。整队从
    /// `max(now, committed_until)` 紧排,每项落在前一项服务尾——无重叠、不推到过去。
    fn remove_and_reflow(&mut self, idx: usize, now: Instant) {
        self.pending.remove(idx);
        let mut cursor = self.committed_until.max(now);
        for t in self.pending.iter_mut() {
            t.start = cursor;
            cursor += t.service;
        }
    }
}

/// 剪枝/取消时给 waiter 的处置。
pub enum PollOutcome {
    /// admitted 或 released:路由该帧。
    Proceed,
    /// 会话失效/被取消:按 kicked 收尾。
    Kicked,
    /// 本 ticket 是 FIFO 头:睡到 `start` 再 poll。
    SleepUntil(Instant),
    /// 非头:等一次 generation 变化(前面的 ticket 解决)再 poll,不定时睡。
    WaitGen,
}

/// 准入决策(数据帧,准入原子临界区内)。
pub enum AdmitDecision {
    /// 未超额:直接放行(无 ticket)。
    Immediate,
    /// 会话已被更新会话顶替/已 revoke(stale gen):帧已计 wire 字节但连接须 kicked。
    Kicked,
    /// 超额:已入队,waiter 须等待。
    Wait(WaitHandle),
}

/// waiter 自持的等待柄(conn.rs 用它 poll)。
pub struct WaitHandle {
    pub account: String,
    pub device: String,
    pub conn_id: u64,
    pub session_gen: u64,
    pub ticket_id: u64,
    pub disp: Arc<AtomicU8>,
    pub gen_rx: watch::Receiver<u64>,
    /// 首次睡到的时刻(head 时有效);poll 会给出后续时刻。
    pub start: Instant,
}

/// checkpoint sidecar 的每账户记录(只有计量态,调度态易失不落)。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeterRecord {
    pub period: (i32, u8),
    pub fastlane_used: u64,
}

/// ceil(bytes / rate) → 服务时长(rate=字节/秒;小帧不得整数除零)。
fn service_of(bytes: u64, rate: u64) -> Duration {
    debug_assert!(rate > 0, "达量速率须 >0(启动校验保证)");
    let rate = rate.max(1);
    let nanos = ((bytes as u128) * 1_000_000_000u128).div_ceil(rate as u128);
    Duration::from_nanos(u64::try_from(nanos).unwrap_or(u64::MAX))
}

/// 全账户计量 + 调度容器(hub 的第三把锁 `Mutex<Meters>`)。
pub struct Meters {
    map: HashMap<String, AccountMeter>,
    /// 自上次 checkpoint 以来新增的字节量(worker 触发判据:≥16MiB;有状态、丢一次
    /// 通知不退化)。
    dirty_bytes: u64,
    /// session generation 全局单调取号(codex 断言①:不回绕)。
    next_session_gen: u64,
}

impl Default for Meters {
    fn default() -> Self {
        Meters { map: HashMap::new(), dirty_bytes: 0, next_session_gen: 1 }
    }
}

impl Meters {
    pub fn new() -> Self {
        Self::default()
    }

    fn meter_mut(&mut self, account: &str, period: (i32, u8), now: Instant) -> &mut AccountMeter {
        self.map.entry(account.to_owned()).or_insert_with(|| AccountMeter::new(period, now))
    }

    /// attach 顶替成功的线性化点:给 device 发新会话代际、取消旧代际本 device 的 pending。
    /// 返回新 `session_gen`。调用方(hub)在 `registry→meters` 内、state 锁释放后调。
    pub fn begin_session(
        &mut self,
        account: &str,
        device: &str,
        period: (i32, u8),
        now: Instant,
    ) -> u64 {
        // codex 断言①:session_gen 不回绕。
        assert!(self.next_session_gen < u64::MAX, "session_gen 取号到顶(不可能达到,fail-fast)");
        let gen = self.next_session_gen;
        self.next_session_gen += 1;
        let m = self.meter_mut(account, period, now);
        m.sessions.insert(device.to_owned(), gen);
        // 取消旧代际本 device 的 pending(新会话尚未入队,这些恒是旧的)。
        let mut i = 0;
        while i < m.pending.len() {
            if m.pending[i].device == device && m.pending[i].session_gen != gen {
                set_disp(&m.pending[i].disp, DISP_CANCELLED);
                m.remove_and_reflow(i, now);
            } else {
                i += 1;
            }
        }
        m.bump();
        gen
    }

    /// detach/revoke:仅当 `sessions[device] == session_gen` 才清该会话(codex 断言③:
    /// 旧连接退出不清新会话)。清其残留 pending。
    pub fn clear_if_current(&mut self, account: &str, device: &str, session_gen: u64, now: Instant) {
        let Some(m) = self.map.get_mut(account) else { return };
        if m.sessions.get(device) != Some(&session_gen) {
            return;
        }
        m.sessions.remove(device);
        let mut i = 0;
        let mut removed = false;
        while i < m.pending.len() {
            if m.pending[i].device == device && m.pending[i].session_gen == session_gen {
                set_disp(&m.pending[i].disp, DISP_CANCELLED);
                m.remove_and_reflow(i, now);
                removed = true;
            } else {
                i += 1;
            }
        }
        if removed {
            m.bump();
        }
    }

    /// 数据帧准入(准入原子临界区内,计数口径见 §4)。`wall_month`=UTC 墙钟月(计量
    /// 轴),`now`=单调钟(调度轴);`grant_quota`/`device_set`/`device_cap`/`rate` 由调用方
    /// 读 registry/Config 后传入。返回决策;无论决策如何,wire 字节已计入 `fastlane_used`。
    #[allow(clippy::too_many_arguments)]
    pub fn admission(
        &mut self,
        account: &str,
        device: &str,
        session_gen: u64,
        conn_id: u64,
        bytes: u64,
        wall_month: (i32, u8),
        now: Instant,
        grant_quota: u64,
        device_set: &HashSet<String>,
        device_cap: usize,
        rate: u64,
    ) -> AdmitDecision {
        let m = self.meter_mut(account, wall_month, now);
        // 有序月份滚期(codex E:非 !=)。
        if wall_month > m.period {
            m.period = wall_month;
            m.fastlane_used = 0;
        } else if wall_month < m.period {
            crate::logln(format!(
                "WARN meter 墙钟回拨:账户 {account} wall={wall_month:?} < period={:?},保留 period 不重置",
                m.period
            ));
        }
        // 计数恒在最前(帧已达入站边界)。
        let used_before = m.fastlane_used;
        m.fastlane_used = m.fastlane_used.saturating_add(bytes);
        self.dirty_bytes = self.dirty_bytes.saturating_add(bytes);

        let m = self.map.get_mut(account).expect("刚插入");
        // 超量首越告警(RestrictionReason::FastlaneExhausted;越线那一帧记一次,不刷屏)。
        if used_before <= grant_quota && m.fastlane_used > grant_quota {
            crate::logln(format!(
                "WARN account={account} 首次越本月 fastlane 额度({} > {} B)——进入 {:?} 达量限速",
                m.fastlane_used,
                grant_quota,
                RestrictionReason::FastlaneExhausted
            ));
        }
        // 会话代际核验(codex 实现审 M:提到快路径**前**——under-quota 的 stale 帧
        // 也须 Kicked,不得当 Immediate 放行)。stale=帧已计、连接须 kicked。
        if m.sessions.get(device) != Some(&session_gen) {
            m.bump(); // 让可能存在的旧 waiter 也重查
            return AdmitDecision::Kicked;
        }
        if m.fastlane_used <= grant_quota {
            return AdmitDecision::Immediate; // 未超额:快路径
        }

        // —— FastlaneExhausted:入队前剪枝,保 pending ≤ device_cap ——
        // ① 剪掉已不在 registry 的历史 device 的 pending(codex C:上界不靠及时消 kick)。
        let mut i = 0;
        while i < m.pending.len() {
            if !device_set.contains(&m.pending[i].device) {
                set_disp(&m.pending[i].disp, DISP_CANCELLED);
                m.remove_and_reflow(i, now);
            } else {
                i += 1;
            }
        }
        // ② 同 device 旧 pending 淘汰(防御:正常应已被 begin_session 清)。
        let mut i = 0;
        while i < m.pending.len() {
            if m.pending[i].device == device {
                set_disp(&m.pending[i].disp, DISP_CANCELLED);
                m.remove_and_reflow(i, now);
            } else {
                i += 1;
            }
        }
        // ③ 入队。
        let service = service_of(bytes, rate);
        let start = now.max(m.tail_end());
        let ticket_id = m.next_ticket;
        m.next_ticket += 1;
        let disp = Arc::new(AtomicU8::new(DISP_PENDING));
        m.pending.push(Ticket {
            device: device.to_owned(),
            conn_id,
            session_gen,
            ticket_id,
            start,
            service,
            disp: disp.clone(),
        });
        // 剪枝 + 会话核验后 pending 恒 ≤ device_cap;破=逻辑 bug,响亮 assert(非
        // debug_assert,release 也在——codex 实现审 M)。
        assert!(
            m.pending.len() <= device_cap,
            "pending {} > device_cap {}(剪枝+会话核验后不变量被破=逻辑 bug)",
            m.pending.len(),
            device_cap
        );
        let gen_rx = m.gen_tx.subscribe();
        m.bump();
        AdmitDecision::Wait(WaitHandle {
            account: account.to_owned(),
            device: device.to_owned(),
            conn_id,
            session_gen,
            ticket_id,
            disp,
            gen_rx,
            start,
        })
    }

    /// waiter 醒来后在锁内 poll(disp 已在锁外先读、非 Pending 直接归类,这里只处理 Pending)。
    pub fn poll(&mut self, h: &WaitHandle, now: Instant, grant_quota: u64) -> PollOutcome {
        let Some(m) = self.map.get_mut(&h.account) else {
            return PollOutcome::Kicked;
        };
        // 会话失效。
        if m.sessions.get(&h.device) != Some(&h.session_gen) {
            // ticket 若还在,连带清掉。
            if let Some(idx) = m
                .pending
                .iter()
                .position(|t| t.ticket_id == h.ticket_id && t.conn_id == h.conn_id)
            {
                set_disp(&m.pending[idx].disp, DISP_CANCELLED);
                m.remove_and_reflow(idx, now);
                m.bump();
            }
            return PollOutcome::Kicked;
        }
        let Some(idx) = m
            .pending
            .iter()
            .position(|t| t.ticket_id == h.ticket_id && t.conn_id == h.conn_id)
        else {
            // 不在 pending 了:disp 早已置终态,按其值归类(锁外已读过,这里兜底)。
            return match h.disp.load(Ordering::SeqCst) {
                DISP_CANCELLED => PollOutcome::Kicked,
                _ => PollOutcome::Proceed, // Admitted/Released
            };
        };
        // 账户已不再超额:自释放(不留幽灵 ticket)。
        if m.fastlane_used <= grant_quota {
            set_disp(&m.pending[idx].disp, DISP_RELEASED);
            m.remove_and_reflow(idx, now);
            m.bump();
            return PollOutcome::Proceed;
        }
        // 仍超额:仅 FIFO 头且到点可 admit。
        if idx == 0 && now >= m.pending[0].start {
            let t = &m.pending[0];
            let end = t.start + t.service;
            set_disp(&t.disp, DISP_ADMITTED);
            m.committed_until = m.committed_until.max(end);
            m.pending.remove(0);
            m.bump();
            return PollOutcome::Proceed;
        }
        if idx == 0 {
            PollOutcome::SleepUntil(m.pending[0].start)
        } else {
            PollOutcome::WaitGen
        }
    }

    /// admin 抬 grant 后:若账户已不再超额,清空全部 pending 为 Released、`committed_until`
    /// 归零(codex D:升级解限**不能**逐个 admit——那会把 horizon 推到旧队尾累积等待)。
    /// 仍超额则队列不动。调用方(hub)在 set_entitlement 后、同 `registry→meters` 内调。
    pub fn release_if_unthrottled(&mut self, account: &str, now: Instant, grant_quota: u64) {
        let Some(m) = self.map.get_mut(account) else { return };
        if m.fastlane_used > grant_quota || m.pending.is_empty() {
            return;
        }
        for t in m.pending.drain(..) {
            set_disp(&t.disp, DISP_RELEASED);
        }
        m.committed_until = now;
        m.bump();
    }

    // ---- checkpoint(计量态)----

    /// 快照(account, {period, fastlane_used})+ 快照时刻的 dirty 量。**不清 dirty**
    /// (codex E:落盘成功后才 `checkpoint_ack` 扣减,失败则 dirty 原样保留供重试;
    /// 快照与 ack 之间的新增量因「减去快照量」自然留存,不丢)。锁内调、落盘在锁外。
    pub fn checkpoint_snapshot(&self) -> (Vec<(String, MeterRecord)>, u64) {
        let records = self
            .map
            .iter()
            .map(|(a, m)| {
                (a.clone(), MeterRecord { period: m.period, fastlane_used: m.fastlane_used })
            })
            .collect();
        (records, self.dirty_bytes)
    }

    /// 落盘成功后扣减快照时刻的 dirty 量(饱和;快照后新增的部分留待下轮)。
    pub fn checkpoint_ack(&mut self, saved_dirty: u64) {
        self.dirty_bytes = self.dirty_bytes.saturating_sub(saved_dirty);
    }

    /// 自上次 checkpoint 以来的脏字节量(worker 判 ≥16MiB 触发)。
    pub fn dirty_bytes(&self) -> u64 {
        self.dirty_bytes
    }

    /// 从 sidecar 记录恢复(启动;`now` 给新建 meter 的 committed_until 基点)。
    /// 有序月份在 admission 时按墙钟再滚,这里原样载入。
    pub fn load_records(&mut self, records: Vec<(String, MeterRecord)>, now: Instant) {
        for (acct, rec) in records {
            let m = self.map.entry(acct).or_insert_with(|| AccountMeter::new(rec.period, now));
            m.period = rec.period;
            m.fastlane_used = rec.fastlane_used;
        }
    }
}

// ---- meters sidecar 落盘(独立文件,不进 registry.json;粗 checkpoint 只承载
// fastlane_used+period,丢一窗规格允许;grant 强持久化在 registry)----

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct MeterDisk {
    period: String,
    fastlane_used: u64,
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct SidecarDisk {
    #[serde(default)]
    meters: std::collections::BTreeMap<String, MeterDisk>,
}

/// 原子写 sidecar(tmp + rename;单写者 worker 唯一调用点,无并发覆盖)。
pub fn save_sidecar(path: &std::path::Path, records: &[(String, MeterRecord)]) -> std::io::Result<()> {
    let disk = SidecarDisk {
        meters: records
            .iter()
            .map(|(a, r)| {
                (a.clone(), MeterDisk { period: format!("{:04}-{:02}", r.period.0, r.period.1), fastlane_used: r.fastlane_used })
            })
            .collect(),
    };
    let json = serde_json::to_string_pretty(&disk).expect("BTreeMap 序列化无失败路径");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)
}

/// 读 sidecar(启动)。缺文件=空(首启);**损坏=高优告警 + 从零**(不静默当首启——
/// codex E:计量态可丢一窗,但损坏要响亮;grant 在 registry 不受影响)。坏行(period
/// 形态)整份从零。
pub fn load_sidecar(path: &std::path::Path) -> Vec<(String, MeterRecord)> {
    let json = match std::fs::read_to_string(path) {
        Ok(j) => j,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            crate::logln(format!("ERROR 读 meters sidecar {} 失败:{e}——从零计量(fastlane_used 归零,grant 不受影响)", path.display()));
            return Vec::new();
        }
    };
    let disk: SidecarDisk = match serde_json::from_str(&json) {
        Ok(d) => d,
        Err(e) => {
            crate::logln(format!("ERROR meters sidecar {} 损坏:{e}——从零计量(非首启,响亮告警;grant 在 registry 不受影响)", path.display()));
            return Vec::new();
        }
    };
    let mut out = Vec::new();
    for (acct, m) in disk.meters {
        let Some((y, mo)) = m.period.split_once('-') else {
            crate::logln(format!("ERROR meters sidecar 里 {acct} 的 period 形态坏:{:?}——整份从零", m.period));
            return Vec::new();
        };
        let (Ok(year), Ok(month)) = (y.parse::<i32>(), mo.parse::<u8>()) else {
            crate::logln(format!("ERROR meters sidecar 里 {acct} 的 period 非法:{:?}——整份从零", m.period));
            return Vec::new();
        };
        if !(1..=12).contains(&month) {
            crate::logln(format!("ERROR meters sidecar 里 {acct} 的 period 月份越界:{:?}——整份从零", m.period));
            return Vec::new();
        }
        out.push((acct, MeterRecord { period: (year, month), fastlane_used: m.fastlane_used }));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAP: usize = 8;
    const RATE: u64 = 1024 * 1024; // 1 MiB/s
    const MONTH: (i32, u8) = (2026, 7);

    fn dset(devs: &[&str]) -> HashSet<String> {
        devs.iter().map(|s| s.to_string()).collect()
    }

    fn disp_of(h: &WaitHandle) -> u8 {
        h.disp.load(Ordering::SeqCst)
    }

    /// 未超额=Immediate;越额后入队=Wait;fastlane_used 精确累计。
    #[test]
    fn counts_and_throttles_over_quota() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g = m.begin_session("A", "D1", MONTH, t0);
        // quota=1000:头一帧 600 未超 → Immediate。
        assert!(matches!(
            m.admission("A", "D1", g, 1, 600, MONTH, t0, 1000, &dset(&["D1"]), CAP, RATE),
            AdmitDecision::Immediate
        ));
        // 第二帧 600:累计 1200 > 1000 → Wait。
        let d = m.admission("A", "D1", g, 1, 600, MONTH, t0, 1000, &dset(&["D1"]), CAP, RATE);
        assert!(matches!(d, AdmitDecision::Wait(_)));
    }

    /// 会话 ABA:旧 gen 帧被 kicked、不 enqueue、不淘汰新 ticket。
    #[test]
    fn stale_session_kicked_not_enqueued() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g_old = m.begin_session("A", "D1", MONTH, t0);
        // 越额入队(旧会话)。
        let _ = m.admission("A", "D1", g_old, 1, 2000, MONTH, t0, 1000, &dset(&["D1"]), CAP, RATE);
        // 新会话顶替(begin_session 取消旧 pending)。
        let g_new = m.begin_session("A", "D1", MONTH, t0);
        assert_ne!(g_old, g_new);
        // 旧会话再来一帧:stale → Kicked,不入队。
        let d = m.admission("A", "D1", g_old, 1, 2000, MONTH, t0, 1000, &dset(&["D1"]), CAP, RATE);
        assert!(matches!(d, AdmitDecision::Kicked));
    }

    /// 剪枝:已不在 registry 的 device 的 pending 在下次准入时被清,pending ≤ device_cap。
    #[test]
    fn prunes_revoked_device_tickets() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        // 两个 device 各入一队(cap=1 场景)。
        let g1 = m.begin_session("A", "D1", MONTH, t0);
        let _ = m.admission("A", "D1", g1, 1, 2000, MONTH, t0, 1000, &dset(&["D1"]), 8, RATE);
        let g2 = m.begin_session("A", "D2", MONTH, t0);
        let _ = m.admission("A", "D2", g2, 2, 2000, MONTH, t0, 1000, &dset(&["D1", "D2"]), 8, RATE);
        // D1 被 revoke(设备集只剩 D2、新增 D9);D9 入队前剪掉 D1 的 pending。
        let g9 = m.begin_session("A", "D9", MONTH, t0);
        let d = m.admission("A", "D9", g9, 9, 2000, MONTH, t0, 1000, &dset(&["D2", "D9"]), 8, RATE);
        assert!(matches!(d, AdmitDecision::Wait(_)));
        // D1 的 ticket 已被剪(设备集不含):其 disp=Cancelled。
        // (借内部:pending 里应只剩 D2、D9。)
        let am = m.map.get("A").unwrap();
        assert_eq!(am.pending.len(), 2);
        assert!(am.pending.iter().all(|t| t.device != "D1"));
    }

    /// H-1 回归:删中间 ticket 后重排整个 FIFO,幸存者服务槽不重叠(不越 R)。
    #[test]
    fn cancel_middle_ticket_no_overlap() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        // 三 device 各入一队(cap 大、grant=0 全超额);service=RATE/RATE=1s 每帧。
        let g1 = m.begin_session("A", "D1", MONTH, t0);
        let _ = m.admission("A", "D1", g1, 1, RATE, MONTH, t0, 0, &dset(&["D1", "D2", "D3"]), CAP, RATE);
        let g2 = m.begin_session("A", "D2", MONTH, t0);
        let _ = m.admission("A", "D2", g2, 2, RATE, MONTH, t0, 0, &dset(&["D1", "D2", "D3"]), CAP, RATE);
        let g3 = m.begin_session("A", "D3", MONTH, t0);
        let _ = m.admission("A", "D3", g3, 3, RATE, MONTH, t0, 0, &dset(&["D1", "D2", "D3"]), CAP, RATE);
        // FIFO start:D1=t0, D2=t0+1s, D3=t0+2s。删中间 D2。
        m.clear_if_current("A", "D2", g2, t0);
        let am = m.map.get("A").unwrap();
        assert_eq!(am.pending.len(), 2);
        // 幸存 D1、D3 重排回 t0、t0+1s——不重叠(D3.start == D1.start + D1.service)。
        let sec = Duration::from_secs(1);
        assert_eq!(am.pending[0].device, "D1");
        assert_eq!(am.pending[0].start, t0);
        assert_eq!(am.pending[1].device, "D3");
        assert_eq!(am.pending[1].start, t0 + sec, "删中间项后 D3 不得与 D1 服务槽重叠");
    }

    /// under-quota 的 stale 会话帧也须 Kicked(codex 实现审 M:会话核验在快路径前)。
    #[test]
    fn stale_session_kicked_even_under_quota() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g_old = m.begin_session("A", "D1", MONTH, t0);
        let g_new = m.begin_session("A", "D1", MONTH, t0);
        assert_ne!(g_old, g_new);
        // grant=MAX(远未超额)+ 旧会话 → 仍 Kicked(不当 Immediate)。
        assert!(matches!(
            m.admission("A", "D1", g_old, 1, 100, MONTH, t0, u64::MAX, &dset(&["D1"]), CAP, RATE),
            AdmitDecision::Kicked
        ));
    }

    /// 升级解限:release 清空 pending、committed 归零,不逐个 admit 累积 horizon。
    #[test]
    fn release_clears_pending_not_advance_horizon() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g = m.begin_session("A", "D1", MONTH, t0);
        let h = match m.admission("A", "D1", g, 1, 2000, MONTH, t0, 1000, &dset(&["D1"]), CAP, RATE) {
            AdmitDecision::Wait(h) => h,
            _ => panic!("应入队"),
        };
        // grant 抬到覆盖 used(2000):release。
        m.release_if_unthrottled("A", t0, 4000);
        assert_eq!(disp_of(&h), DISP_RELEASED);
        let am = m.map.get("A").unwrap();
        assert!(am.pending.is_empty());
        assert_eq!(am.committed_until, t0); // horizon 归零,不推到旧队尾
    }

    /// poll:首帧 committed=now ⇒ start=now 立即可 admit(首帧 burst 直放);推进
    /// committed_until 后,第二帧 start 落在未来 → SleepUntil → 到点 admit → Proceed。
    #[test]
    fn poll_admits_head_and_advances_committed() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let sec = Duration::from_secs(1);
        let g = m.begin_session("A", "D1", MONTH, t0);
        // 首帧 1MiB(service=1s),start=t0:head 且 now>=start → 立即 admit。
        let h1 = match m.admission("A", "D1", g, 1, RATE, MONTH, t0, 0, &dset(&["D1"]), CAP, RATE) {
            AdmitDecision::Wait(h) => h,
            _ => panic!("应入队"),
        };
        assert!(matches!(m.poll(&h1, t0, 0), PollOutcome::Proceed));
        assert_eq!(m.map.get("A").unwrap().committed_until, t0 + sec);
        // 第二帧:start = max(t0, committed=t0+1s) = t0+1s。到点前 SleepUntil。
        let h2 = match m.admission("A", "D1", g, 1, RATE, MONTH, t0, 0, &dset(&["D1"]), CAP, RATE) {
            AdmitDecision::Wait(h) => h,
            _ => panic!("应入队"),
        };
        assert!(matches!(m.poll(&h2, t0, 0), PollOutcome::SleepUntil(_)));
        // 到点(t0+1s):admit → Proceed;committed 前推到 t0+2s。
        assert!(matches!(m.poll(&h2, t0 + sec, 0), PollOutcome::Proceed));
        assert_eq!(disp_of(&h2), DISP_ADMITTED);
        assert_eq!(m.map.get("A").unwrap().committed_until, t0 + 2 * sec);
    }

    /// checkpoint 快照 + dirty 清零 + load 往返。
    #[test]
    fn checkpoint_snapshot_and_load() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g = m.begin_session("A", "D1", MONTH, t0);
        let _ = m.admission("A", "D1", g, 1, 500, MONTH, t0, u64::MAX, &dset(&["D1"]), CAP, RATE);
        assert_eq!(m.dirty_bytes(), 500);
        let (snap, dirty_at) = m.checkpoint_snapshot();
        assert_eq!(dirty_at, 500);
        assert_eq!(m.dirty_bytes(), 500, "snapshot 不清 dirty");
        // 模拟落盘成功:ack 后扣减。
        m.checkpoint_ack(dirty_at);
        assert_eq!(m.dirty_bytes(), 0);
        assert_eq!(snap.len(), 1);
        assert_eq!(snap[0].1, MeterRecord { period: MONTH, fastlane_used: 500 });
        // load 到新实例。
        let mut m2 = Meters::new();
        m2.load_records(snap, t0);
        let (snap2, _) = m2.checkpoint_snapshot();
        assert_eq!(snap2[0].1, MeterRecord { period: MONTH, fastlane_used: 500 });
    }

    /// sidecar 往返 + 损坏=从零(不 panic)。
    #[test]
    fn sidecar_roundtrip_and_corrupt_resets() {
        let dir = std::env::temp_dir().join(format!("zhujian-meters-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("meters.json");
        let recs = vec![
            ("A".to_string(), MeterRecord { period: (2026, 7), fastlane_used: 123 }),
            ("B".to_string(), MeterRecord { period: (2026, 12), fastlane_used: 456 }),
        ];
        save_sidecar(&path, &recs).unwrap();
        let mut back = load_sidecar(&path);
        back.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(back, recs);
        // 损坏=从零(空 Vec),不 panic。
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load_sidecar(&path).is_empty());
        // 坏 period 月份=从零。
        std::fs::write(&path, r#"{"meters":{"A":{"period":"2026-13","fastlane_used":1}}}"#).unwrap();
        assert!(load_sidecar(&path).is_empty());
        // 缺文件=空。
        std::fs::remove_file(&path).unwrap();
        assert!(load_sidecar(&path).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 月界有序滚期:向前跨月归零 used;墙钟回拨保留 period 不重置。
    #[test]
    fn ordered_month_rollover() {
        let mut m = Meters::new();
        let t0 = Instant::now();
        let g = m.begin_session("A", "D1", (2026, 7), t0);
        let _ = m.admission("A", "D1", g, 1, 900, (2026, 7), t0, u64::MAX, &dset(&["D1"]), CAP, RATE);
        // 8 月:归零后再计 100。
        let _ = m.admission("A", "D1", g, 1, 100, (2026, 8), t0, u64::MAX, &dset(&["D1"]), CAP, RATE);
        assert_eq!(m.map.get("A").unwrap().fastlane_used, 100);
        assert_eq!(m.map.get("A").unwrap().period, (2026, 8));
        // 墙钟回拨到 7 月:不重置,累加到 8 月计数上。
        let _ = m.admission("A", "D1", g, 1, 50, (2026, 7), t0, u64::MAX, &dset(&["D1"]), CAP, RATE);
        assert_eq!(m.map.get("A").unwrap().fastlane_used, 150);
        assert_eq!(m.map.get("A").unwrap().period, (2026, 8));
    }
}
