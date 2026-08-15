//! 权威名册的**客户端调度机**与设备管理 flow(identity-plan §5.4 / §5.7,367 第①笔片④)。
//!
//! **纯状态机,不碰 I/O**:方法只吃 `now` 与到达的帧、只吐「该发哪一枚帧」的决定,发帧由
//! [`super::Ctx`] 做。这样 §5.14-3c/3d/3f/3g 那批边界(deadline 恰相等、第 10 拍恰一枚、
//! 应答丢了之后的重发)才验得动 —— 生产周期是 5 分钟,靠真等验不了,而「靠手速」的验收
//! 是本案明令禁止的(§4.13.4)。
//!
//! ⛔ **§5.4 那段调度伪码被推翻过两次**,这里实现的是**六/七轮的最终形**:唯一的请求所有者
//! [`RosterSched::periodic`] + 可选的、只搭车不拥有请求的 [`RosterSched::waiter`]。三/四轮
//! 的「两个请求 owner」旧形在设计审史里是标注保留的(§5.16.4),照旧形写会把六轮刚封掉的
//! 双请求路径原样重建回来。
//!
//! **五条结账路一个出口**(§5.5 五轮):成功 / `RosterNack` / `Err` / deadline / 断连全部
//! 经 [`RosterSched::settle_waiter`] 或 [`super::Ctx::settle_admin`],`take()` 只在那里面
//! 做一次。散开写就没有「恰好一次结账」这条性质了(`auth_failed` 可能伴随断连 ⇒ 一枚 Err
//! 结完账,随后的断连清场不得再报第二次)。

use std::time::Duration;

use sync_proto::{DeviceAction, RosterEntry, HEARTBEAT_SECS, ROSTER_REQ_MIN_GAP_SECS};
use tokio::sync::oneshot;
use tokio::time::Instant;

/// 名册刷新命令的回执。**只回成功与否,名单从状态面读** —— 这是 §5.7-6 的原形。
///
/// ⚠ 我曾把它改成回执自带名单(`Result<Vec<RosterEntry>, String>`),想封掉「拿到
/// `Ok(())` 之后去读状态面,而状态面还没被本轮更新」那道跨线程窗口。**那个修法是错的**
/// (实现审弹三 M2):它把一道窗口换成了**两个无法排序的数据出口** —— 回执带 revision 10
/// 的名单,而一枚 revision 11 的主动推送可能先被状态面的消费者看见,随后那枚 promise
/// 再把 10 的名单倒灌回界面,而两个出口都不带 revision,UI **无从判断谁新**。
///
/// 正解是**把顺序摆对**而不是改类型:结账恒晚于状态面写入(见
/// [`RosterSched::on_roster`] 那个 `write_status` 回调)。oneshot 的收发天然给出
/// happens-before,故「醒来之后读到的状态面必定已含本轮」是结构事实。
pub(super) type RosterReply = oneshot::Sender<Result<(), String>>;
/// 设备管理命令的回执。
pub(super) type AdminReply = oneshot::Sender<Result<(), String>>;

/// 周期拉取的间隔,单位=心跳拍数(§5.4 恒在轴:10 拍 × 30s ≈ 5 分钟)。
pub(super) const ROSTER_PULL_TICKS: u32 = 10;
/// UI 刷新自己的短 deadline(§5.4):不能让用户对着一个 5 分钟的周期 deadline 干等。
pub(super) const REFRESH_DEADLINE: Duration = Duration::from_secs(8);
/// 设备管理命令的回执 deadline(一次服务器往返)。
pub(super) const DEVICE_ADMIN_DEADLINE: Duration = Duration::from_secs(15);

/// §5.4 五轮 M1 那条**我算错过的**常量约束,写成编译期断言。
///
/// 我五轮写的是 `PULL_DEADLINE >= ROSTER_REQ_MIN_GAP`,而「立即换新」发生在
/// `remaining <= REFRESH_DEADLINE` 那一刻,此时旧请求的**年龄最小值**是
/// `PULL_DEADLINE − REFRESH_DEADLINE` —— 闸要挡的是**换新那一刻旧请求的年龄**,
/// 不是「超时长度」。取 `PULL_DEADLINE = 拉取周期`(§5.4 最克制的形,不留没用途的
/// 自由度)之后,这条断言就是那个算式的可执行面。
const _: () = assert!(
    ROSTER_PULL_TICKS as u64 * HEARTBEAT_SECS
        >= REFRESH_DEADLINE.as_secs() + ROSTER_REQ_MIN_GAP_SECS,
    "PULL_DEADLINE 短于「UI 换新那一刻旧请求的最小年龄 + 服务端最短应答间隔」\
     ⇒ UI 一换新就撞服务端限频的 busy(§5.4 五轮 M1)"
);

/// 唯一的请求所有者(§5.4:凡是真正发到线上的 `RosterReq` 都必须占住它)。
struct Pending {
    n: u64,
    deadline: Instant,
}

/// 附着在那一枚请求上的、可选的 UI 等待者。**它不拥有请求** —— 超时只摘自己,
/// 共同 pending 留给 periodic(§5.4 三个超时职责分开)。
struct Waiter {
    n: u64,
    deadline: Instant,
    reply: RosterReply,
}

/// 名册调度机(§5.4)。**会话内有效,断了就不认** —— [`RosterSched::end_session`] 把
/// 全部字段清回出厂态,故「客户端不缓存、不落库」是结构事实。
pub(super) struct RosterSched {
    /// 唯一的请求所有者。
    periodic: Option<Pending>,
    /// 搭车的 UI 等待者(至多一枚,互斥域由 [`super::Ctx`] 守)。
    waiter: Option<Waiter>,
    /// 心跳拍数。**每次新建或换新请求即复位**(§5.4 六轮 M1 后半:少了它,一次快速
    /// 成功之后 `ticks` 还停在 10,下一拍就再发一枚 ⇒ 周期从 5 分钟退化成 30 秒)。
    ticks: u32,
    /// 连接内单调请求发号器(照 `Send.n` 的形)。
    next_n: u64,
    /// **本会话收到过 `Roster` 吗** —— §5.4/§5.10-2 的唯一能力信号。老服务器收到不认识的
    /// `ClientMsg` 会 `bad_request` **并断开**,故没见过名册就一个新信封都不许发。
    cap_seen: bool,
    /// 当前名册的 revision;`None` = 还没有过任何一份。
    revision: Option<u64>,
    /// 当前权威名册。**这里是真相源**,`SyncStatus.roster` 是它的投影。
    roster: Option<Vec<RosterEntry>>,
    /// 周期请求的 deadline 长度 = 拉取周期(§5.4「取最克制的形」)。由**实际心跳周期**
    /// 算出(`Interval::period() × ROSTER_PULL_TICKS`),不另抄一份常量:测试把心跳压到
    /// 毫秒级时它跟着缩,「deadline 恰等于周期」这条性质不因验收环境而变。
    pull_deadline: Duration,
}

impl RosterSched {
    pub(super) fn new(pull_deadline: Duration) -> Self {
        Self {
            periodic: None,
            waiter: None,
            ticks: 0,
            next_n: 0,
            cap_seen: false,
            revision: None,
            roster: None,
            pull_deadline,
        }
    }

    /// 服务器认得这套吗(§5.10-2 的能力闸判据)。
    pub(super) fn cap_seen(&self) -> bool {
        self.cap_seen
    }

    /// 有 UI 等待者在飞吗(§5.7-4 互斥域的一格)。
    pub(super) fn ui_busy(&self) -> bool {
        self.waiter.is_some()
    }

    /// UI 等待者的 deadline(给会话循环那条 select 臂;`None` = 不挂)。
    pub(super) fn ui_deadline(&self) -> Option<Instant> {
        self.waiter.as_ref().map(|w| w.deadline)
    }

    /// 当前名册的副本(投状态面用)。
    pub(super) fn snapshot(&self) -> Option<Vec<RosterEntry>> {
        self.roster.clone()
    }

    /// 心跳一拍(§5.4 那台调度机的全部定形)。返回 `Some(n)` = 发一枚 `RosterReq{n}`。
    ///
    /// **一次心跳至多发一枚**:到期的旧 n 当场作废,不许「作废一枚 + 补两枚」。
    #[must_use]
    pub(super) fn on_tick(&mut self, now: Instant) -> Option<u64> {
        // 能力未确认 ⇒ 恒在轴还没开张(一个新信封都不发)。**拍数也不走** —— 否则
        // 服务器刚确认支持的那一拍就可能立刻甩出一枚,而不是从零起数。
        if !self.cap_seen {
            return None;
        }
        self.ticks += 1;
        let due = match &self.periodic {
            // 判据写死为 `now >= deadline`(§5.4 三轮裁决):`PULL_DEADLINE == 周期` 时
            // 恰在边界那一拍算过期,且这一拍只发一枚。
            Some(p) => now >= p.deadline,
            None => self.ticks >= ROSTER_PULL_TICKS,
        };
        due.then(|| self.start_request(now))
    }

    /// UI 请求刷新(§5.4「UI 请求刷新」那三格)。返回 `Some(n)` = 要发帧;`None` = 搭车,
    /// **不发帧**。两种情形都已把 waiter 挂好。
    #[must_use]
    pub(super) fn on_ui_request(&mut self, now: Instant, reply: RosterReply) -> Option<u64> {
        debug_assert!(self.waiter.is_none(), "互斥域由 Ctx 守:同时只许一枚 UI 等待者");
        let (n, send) = match &self.periodic {
            None => (self.start_request(now), true),
            // ⛔ 订阅前先看那枚周期请求还剩多少命(§5.4 四轮 M2)。`saturating_` 是因为
            // 已过期的 pending 也可能落到这里(心跳还没轮到),那种要走换新那一支。
            Some(p) if p.deadline.saturating_duration_since(now) > REFRESH_DEADLINE => {
                (p.n, false)
            }
            // 快到期:立即作废旧 n、发新请求,两者都挂新 n。
            Some(_) => (self.start_request(now), true),
        };
        self.waiter = Some(Waiter { n, deadline: now + REFRESH_DEADLINE, reply });
        send.then_some(n)
    }

    /// 收到一枚 `Roster`。**两条匹配判据各判一次**(§5.4):同一枚 `n` 既可能是 pending 的
    /// 号、也可能是 waiter 的号,写成 `if / else if` 就会只清 pending、把 UI 晾到超时
    /// (四轮 M2)。
    ///
    /// ⛔ **`write_status` 恒在结账之前被调用,这个顺序是本方法的全部意义**
    /// (实现审弹三 M2)。把状态面的写入做成**入参回调**而不是「返回个 `Applied`、
    /// 让调用方自己记得先写再结」——后者是纪律,一旦有人把两句话调个个儿就又漏出
    /// 「UI 醒来时读到的还是上一轮的名单」那道窗口,而那种错在代码评审里看不出来。
    ///
    /// 它仍是 sans-io:回调是个纯函数入参,测试传一只记录调用次序的闭包,于是
    /// 「状态面先写、oneshot 后响」本身就是可断言的(见 tests 里那只顺序测)。
    ///
    /// `write_status` 只在**这一份比当前新**时被调用(更旧的迟到帧:结账但不倒灌 ——
    /// 设计审二轮 M1 那个反例:应答带 revision 10,而一枚并发成员变更的推送带 11
    /// 先到;若按「revision 更小就早返丢弃」处理,那枚匹配我请求号的应答会被整个丢掉
    /// ⇒ UI 刷新错误地超时)。
    pub(super) fn on_roster(
        &mut self,
        request: Option<u64>,
        revision: u64,
        devices: Vec<RosterEntry>,
        write_status: impl FnOnce(Option<Vec<RosterEntry>>),
    ) {
        // 能力信号:哪怕这一份是更旧的迟到帧,它也证明了服务器认得这套。
        self.cap_seen = true;
        let fresh = self.revision.is_none_or(|cur| revision >= cur);
        if fresh {
            self.revision = Some(revision);
            self.roster = Some(devices);
        }
        // ⛔ **状态面先写、再结账**(弹三 M2)。UI 醒来后读到的必定已含本轮 —— oneshot
        // 的收发给出 happens-before,而这两句的先后就在这里写死。掉个个儿,那道
        // 「拿到 Ok 却读到上一轮名单」的跨线程窗口就又开了。
        if fresh {
            write_status(self.snapshot());
        }
        if let Some(n) = request {
            if self.periodic.as_ref().is_some_and(|p| p.n == n) {
                self.periodic = None;
            }
            if self.waiter.as_ref().is_some_and(|w| w.n == n) {
                // 更旧的迟到帧照样结账(号只管结不结账),但它没有倒灌 —— 上面那句
                // `write_status` 没被调用,状态面里仍是更新的那一份。
                self.settle_waiter(Ok(()));
            }
        }
    }

    /// 收到一枚 `RosterNack`(§5.7-3 三轮 M2 那张表)。
    ///
    /// ⛔ **绝不许把已有的 `Some(roster)` 清成 `None`** —— 它只是「这次刷新失败」,不是
    /// 「否定上一份权威名单」。清成 `None` 会连带把第②笔的直连闸翻成 fail-open。
    pub(super) fn on_nack(&mut self, n: u64, why: String) {
        if self.periodic.as_ref().is_some_and(|p| p.n == n) {
            // 清那唯一的 pending;**不把 ticks 恢复成已到期**,下一周期重试。
            self.periodic = None;
        }
        if self.waiter.as_ref().is_some_and(|w| w.n == n) {
            self.settle_waiter(Err(why));
        }
    }

    /// UI 等待者到点(§5.4 三个超时职责分开:**只清 UI waiter**,共同 pending 留给 periodic)。
    pub(super) fn on_ui_deadline(&mut self) {
        self.settle_waiter(Err("获取设备名单超时,请重试".into()));
    }

    /// 会话收场:清 pending / waiter / ticks / cap_seen / 发号器 / 名册(§5.4「断了就不认」)。
    /// **同步、无 await** —— 它要从 `Ctx::Drop` 里调得动。
    pub(super) fn end_session(&mut self) {
        self.settle_waiter(Err("连接断开,未能取得设备名单".into()));
        *self = Self::new(self.pull_deadline);
    }

    /// 新建或换新一枚请求:占住 pending、复位拍数、出号。
    fn start_request(&mut self, now: Instant) -> u64 {
        let n = self.next_n;
        self.next_n += 1;
        self.periodic = Some(Pending { n, deadline: now + self.pull_deadline });
        self.ticks = 0;
        n
    }

    /// **UI waiter 的唯一结账出口**(§5.5 五轮:`take()` 只在这里做一次)。没有 waiter
    /// 就什么也不做 —— 「断连清场看到 `None` 不得再报第二次失败」正是靠这一句。
    fn settle_waiter(&mut self, r: Result<(), String>) {
        if let Some(w) = self.waiter.take() {
            let _ = w.reply.send(r);
        }
    }
}

/// 一笔在飞的设备管理命令(§5.7-3)。
///
/// `reply` **不套第二层 `Option`**:`Ctx.admin` 那一层就是「在不在飞」,取走即结账,
/// 一个状态一个位置。
pub(super) struct AdminFlow {
    pub(super) target: String,
    pub(super) action: DeviceAction,
    pub(super) deadline: Instant,
    pub(super) reply: AdminReply,
}

#[cfg(test)]
mod tests;
