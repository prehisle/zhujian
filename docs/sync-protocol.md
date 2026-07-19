# 同步协议规格 — P2「WSS 同步专用服务」底稿

> **2026-07-19 席位闸修订(billing-plan 工序 2)**:注册面加两层席位闸——`register_device` 线性化点原子执行 `seat_count < min(effective_entitlement.seat_quota, 服务器硬帽 device_cap)`,双错误码 `seat_limit`(商业层,提额可解)/`account_full`(硬帽,任何 entitlement 不可越);满席普通 `pair_open` 前置拒;新增**纪元席位租约**信封 `seat_lease {account, new_device, new_pubkey, sig_by_old}` / 回执 `seat_lease {device}`(已鉴权 sponsor 为具体目标求 +1,`register_device` 精确匹配后原子消费,绝不越硬帽;每账户同时最多一枚、未消费 TTL 2h、纯内存不落盘——正常流程在同一条短连接内「求租→注册」秒级消费,重启丢租约=客户端整流程重试自然重求)。签名域 `zhujian-sync-seat-lease-v1`(与 register_device 同构,无 nonce:重放=同目标幂等重求租)。免费档默认 2 席 fail-closed(工序 1);其余帧/信箱/配对/引导/纪元不变。
>
> **2026-07-19 open-signup 修订**:准入已开放(无感创号,[open-signup-plan](open-signup-plan.md),**设计审** codex 三轮 GO;实现审收敛记录见 progress-log 155)——本文一切「白名单」准入语义作废:账户 ULID 由客户端创号那刻自生成、服务器对 fresh 账户直接 TOFU 建档、`banlist.txt` 封禁表拒名单(逐行 ULID 严格解析、SIGHUP 热重载=即时失权 kick+烧槽)、admin 面增 device→account 反查吊销(`revoke` 的 account 可选)。帧/信箱/配对/引导/纪元全部不变。下文历史行文按当时状态保留,与本注记冲突处以本注记为准。
>
> 2026-07-08 起草(P2 开工第一笔,P2-a)。上游决策:[sync-plan](sync-plan.md) §3.2(传输层形态:验订阅/路由密文帧/内存信箱)、§3.5(P1 六债留下的回放契约)、§六调整(朋友试用先行:白名单免费、手工配对码、恢复码 UX 保留、协议审查不裁)。本文是 P2 全部实现轮的**规格底稿**,也是 codex 对抗审查的靶子;推翻任何一条,改本文并在 [progress-log](progress-log.md) 记一笔。
>
> 评审状态:**第一轮(设计稿)codex GO-with-fixes,六条修正已全部落稿(见文末评审记录)**;实现完成后、朋友数据上通道前还有协议+代码第二轮(sync-plan §六不裁项)。

## 0. 范围与非目标

**P2 做(朋友期口径)**:

- 服务端:单 Rust 二进制 `zhujian-syncd`(axum/tokio,WSS)——设备鉴权(白名单)+ 账户内密文帧路由 + 内存信箱 + 配对桥 + 引导/图字节直通。服务器对一切用户内容零知识。
- 客户端(src-tauri 内;**93 P4-a 起 `sync/` 模块随共享 crate `zhujian-core` 迁仓根 `core/src/sync/`,tauri 壳只留命令面+事件桥**):sans-io 同步引擎 + tokio 传输任务 + 最小同步 UI(创建账户/配对/状态/「图N」翻案提示)。
- E2EE:账户主密钥 + 每域子钥(HKDF)+ XChaCha20-Poly1305;SPAKE2 配对;Ed25519 设备鉴权;**恢复码强制仪式**(E2EE 组成部分,非商业件)。
- 存储层配套:迁移 0024(oplog 加 `origin_seq` 传输轴,§7)。
- 验收:两台 Windows 真机亚秒互通 + 离线水位互补 + **双实例乱序回放收敛 property test**(sync-plan P2 止损探针)。

**P2 明示不做(别顺手做)**:计费/订阅(手工白名单)、扫码(手工配对码,P3)、加密备份导出与 passphrase/Argon2id(P3)、Android/FCM(P4)、图片 BLOB 出库(触发式,§3.4)、设备撤销/K_acc 轮换的产品化(手工重置流程见 §11)、oplog 压缩(须保 tombstone 摘要,sync-plan §3.5)、一设备多账户。

## 1. 角色与标识

- **账户(account_id,ULID)**:一组互相同步的设备。**open-signup 起由客户端创号那刻自生成**(历史:朋友期曾由运营者签发邀请码+白名单准入,已退役);服务器只维护封禁表=「这个 account_id 拒绝接入」。一台设备恒属**最多一个**账户。
- **设备(device_id)**:沿用既有 `sync_meta.device_id`(ULID,触发器冻结;HLC 内嵌它)。**库即身份**:库丢了 device_id 即新,旧 id 成幽灵 origin(各端日志里它的 op 仍是史实,水位恒定格,无害)。
- **设备鉴权钥(Ed25519)**:入账户时生成,私钥存 `sync_meta`,公钥进服务器 registry。签名恒带域隔离前缀(§4),不跨用途复用。
- **服务器 registry(落盘,仅元数据)**:`account_id → {device_id → ed25519_pub}` + 封禁表。这是服务器唯一持久化,不含任何用户内容(§11 有完整落盘清单)。device 全局唯一在 load 时校验(open-signup:device 反查吊销依赖它,坏 registry 拒启)。

## 2. 密钥体系

- **K_acc(账户主密钥,32B CSPRNG)**:账户创建时首台设备生成。只以两种形态离开本机:配对会话密钥下的密文(§6)、恢复码(人眼)。
- **域子钥**:`HKDF-SHA256(K_acc, info="zhujian/sync/v1/" + domain)`,domain ∈ `op`(op 帧)/`ctl`(水位/追赶控制)/`boot`(引导快照流)/`blob`(图字节流)。域隔离:一个域的密文在另一域解密必败。
- **AEAD**:XChaCha20-Poly1305,24B 随机 nonce(192-bit 随机无碰撞之虞),**AAD = CBOR 数组 `[ver, account_id, from_device, to, domain]`**(to = 指名 device_id 或广播 `"*"`,由 `deliver` 回显原值供收端重构)——密文绑定协议版本、账户、来源、去向与域;跨账户/跨设备/跨域拼接、改投他人必解密失败。域隔离不再只靠子钥不同,AAD 双保险(评审①-L1)。**AAD 的字节形态即协议**(评审 P2-d 轮 M2):CBOR preferred serialization(definite-length 数组、最短长度前缀),收端重构须**逐字节**相等——「语义等价但字节不同」的编码(indefinite-length 等)一律解密失败;实现以 crypto.rs 的 AAD 黄金向量为对拍基准。
- **恢复码 = K_acc 的 Crockford base32**(分组显示)。创建账户强制仪式:显示 → 用户抄录 → **输入回验**才放行。用途:P3 加密备份文件的钥匙来源;「所有设备丢失但有备份文件」的重建。忘了=真救不了(零知识的证明,对外文案照 sync-plan §3.2)。
- **本地存放的诚实边界**:K_acc/设备私钥**明文存本机 `sync_meta`**。本地 SQLite 本就明文存全部笔记——给密钥加壳而不给数据加壳是安全剧场;本机磁盘不在威胁模型内(§11)。passphrase/Argon2id 属 P3 备份导出,P2 不引入。

## 3. 帧与信封(服务器可见面)

- WSS 二进制消息,CBOR 编码。**信封是服务器唯一可读面**,字段最小化;`blob` 一律是域子钥下的密文,服务器不可解析。HLC、水位、op 类型、图字节全在密文内。**线上形态以 `sync-proto/` 的黄金向量为准**(P2-e 代码化):serde externally tagged、变体名 CamelCase(与内层 Msg 同纪律)、字节字段 CBOR bytes;下表小写名是描述性写法。信封层**无独立版本字段**——服务器与客户端同仓同轮部署,变体增删=双端一起升级(密文内层的版本纪律是 `PROTO_VER`,与信封无关)。
- 客户端 → 服务器:
  - `register_first {account, device, pubkey, sig}`(首台设备注册,§4;字段名 P2-e 定为 pubkey,避 Rust 关键字)
  - `auth {account, device, sig}`(对 challenge 签名)
  - `send {n, to, lane, blob}`(n=连接内单调序号,ack/nack 用;to=device_id 或 `"*"`)
  - `pair_open {}` / `pair_join {slot}` / `pair_msg {slot, blob}` / `pair_close {slot}`(配对桥,§6;pair_close=「密钥确认失败主动烧槽」的信封面,双方可发,P2-e 补)
  - `register_device {account, new_device, new_pubkey, sig_by_old}`(老设备为新设备背书注册)
  - `seat_lease {account, new_device, new_pubkey, sig_by_old}`(纪元席位租约:已鉴权 sponsor 为具体目标求一次 quota +1,billing-plan §5;工序 2 补)
  - `ping {}`
- 服务器 → 客户端:
  - `challenge {nonce}`(连接即发,32B 随机)
  - `authed {}` / `err {code, msg}`(连接级错误;致命类随后断开)
  - `deliver {from, to, blob}`(投递,含清信箱与实时;回显发送方原 `to`,收端重构 AAD 用)
  - `ack {n}`(send 被接受:完成在线转发 + 离线入箱;mail 恒 ack「入箱即接手」)
  - `nack {n, code}`(send 的业务性失败,按 n 关联、不断开:direct 指名离线 `not_online`、收件人不在本账户 registry `unknown_device`;P2-e 补——P2-g 拿它做「direct 对端不可达」信号)
  - `registered {device}`(register_device 成功确认,配对流程「设备已加入」信号;P2-e 补)
  - `seat_lease {device}`(席位租约已授,回显目标;失败走 `err`——`account_full`(硬帽,租约绝不越)/`device_id_taken`/鉴权类,**不会是 `seat_limit`**:求租刻意不判商业额度,租约的意义就是允许超 quota 一次;`seat_limit` 只出现在 register_device/pair_open;工序 2 补)
  - `pair_slot {slot}` / `pair_msg {slot, blob}` / `pair_peer {event}`(event ∈ joined/left/closed)
  - `peer {device, online}`(账户内在线状态,元数据,帮助对端决定何时发 hello;上线者收当前在线快照、其他人收事件)
  - `pong {}`
- **lane**:`mail`(收件设备离线则入信箱——op/ctl 控制帧)/ `direct`(仅在线,不入信箱——boot/blob 大流量;指名收件人离线回 `nack{not_online}`,广播 direct 对离线者静默跳过)。
- 帧大小上限 **1 MiB**(服务器在 WS 消息层拒超=连接错误断开);心跳 30s,静默 90s 判死。

## 4. 服务器(`zhujian-syncd`)

- **鉴权(挑战-应答)**:连接即发 `challenge{nonce}`;客户端回 `auth`,签名 payload = `"zhujian-sync-auth-v1" ‖ nonce ‖ account ‖ device`(域隔离前缀防跨用途签名复用);registry 验签。封禁账户/未注册设备 → `err` + 断开(open-signup:上线 attach 在同一把 registry 锁内复核 `!banned`+公钥,堵 reload 竞态窗)。
- **首台注册**:账户未封禁 **且** 从未初始化(不在 registry;空墓碑=AccountSealed 硬拒)时,允许 `register_first`(签名覆盖 `"zhujian-sync-register-first-v1" ‖ nonce ‖ account ‖ device ‖ pub`,nonce=本连接 challenge,自证私钥持有且防离线重放)→ 落 registry → 视同 authed。**「检查 fresh + 插入首台」必须是账户级原子操作**(单进程内存 registry 持锁完成再落盘):并发双首台恰一胜,败者收 `err`——否则同账户出现两个互相解不开密文的「首台」,永久停摆(评审①-M4)。TOFU-first(open-signup):账户 ULID 客户端自生成、同连接内立即注册,「谁先注册谁得」的窗口=毫秒级+80-bit 随机不可预知;撞已有账户只得 not_first,拿不到任何密钥。
- **后续注册**:只收已鉴权老设备的 `register_device`,签名覆盖 `"zhujian-sync-register-device-v1" ‖ account ‖ new_device ‖ new_pubkey`(已鉴权通道内,payload 不含 nonce;重放=幂等重注册同一 (device,pub),无害)。信任链:首台(TOFU,自生成 ULID)→ 后续(老设备背书,配对流程内发起,§6);封禁表是横切的拒名单(三点位:auth/register_first/register_device,背书路 Banned=显式 auth_failed 断开)。**P2-e 收紧**:同账户同钥重放=幂等 Ok;其余(异账户,或同账户异钥)一律拒——依据 §1「一台设备恒属最多一个账户」。`new_pubkey` 注册前须过 Ed25519 解压校验(垃圾 32B 入库会把该 device_id 永久烧掉,codex P2-e 轮 M3);坏参数回错不断开(多半来自配对里新设备递来的数据,别断老设备主通道)。
- **device_id 全局唯一守护**:任何注册(首台/后续)遇 device_id 已在 registry(无论哪个账户)且公钥不同 → **拒**。device_id 重复 = 有人整库拷贝复用了设备身份(§6.2/§11 的分叉源头),必须响亮失败,不许静默顶替——这把「拷库当第二台」从灾难性 HLC 撞车降级为一次响亮的配对失败。
- **两层席位闸(billing-plan §5,工序 2)**:`register_device` 判定次序=封禁 → **幂等(同账户同钥)** → device_id 全局唯一 → 硬帽(`seat_count ≥ device_cap` → `account_full`)→ 商业层(`seat_count ≥ effective_entitlement.seat_quota + 租约匹配?1:0` → `seat_limit`)→ 插入+消费租约+落盘(失败回滚含租约还原)。幂等恒在配额之前——纪元预注册「Ack 后崩、同 bundle 重试」在满席瞬间不得被配额误拒。`register_first` 席位闸空成立(首台=第 1 席,quota ≥1)。满席普通 `pair_open` **前置拒**(可显示错误「先移除一台设备再添加」;开槽后到期/降档的窗口由 register_device 权威闸兜底,客户端 opener 收错即 fail_pair 烧槽)。**纪元席位租约**:`seat_lease` 只收已鉴权 sponsor(签名 `"zhujian-sync-seat-lease-v1" ‖ account ‖ new_device ‖ new_pubkey`,本会话公钥验;账户不符断开、曲线点校验同 register_device);绑定具体目标不可挪用、每账户最多一枚(新求租烧旧开新、同目标重放=刷新 TTL)、触硬帽求租即拒、已注册同钥目标=Ok 不开租(消费后崩溃重试路);消费=同一次落盘里「删租约+插设备」原子完成;纯内存不落盘(重启丢未消费租约无害——求租与注册恒在同一条短连接内,重启必断连,客户端整流程重试自然重求)。
- **路由**:同账户 fanout。`to:"*"` = 除自己外全部设备;指名 = 单投(收件人必须在本账户 registry,否则 `nack{unknown_device}`——信箱只为已注册设备开)。mail lane 对离线设备入信箱;direct lane 只投在线。**每收件设备一条 FIFO 队列**(信箱与实时同队):连接后先清积压再接实时,天然保序;同一发送连接的帧到达序=发送序(TCP),多发送者之间交错任意(无害,§5 只依赖 per-origin 序)。**P2-e 落地语义**:同 device_id 重连=踢旧迎新(闪断重连不等静默判死);慢客户端(下行队满)=摘下线+断连+账户内广播 offline,该帧起走离线逻辑——**关断信号走每连接独立的专线,绝不排在可能满的数据队列后面**(codex P2-e 轮 H1/H2:下行一律非阻塞,「对端只发不读」在下一帧到达时被「队满即断」收场,不会把连接任务卡死在回包上)。
- **信箱**:每 (account, device) 队列,上限 **64 MiB 或 8192 帧**(先到为准),**TTL 72h**(惰性驱逐+定期清扫),溢出丢最老,**重启即失、永不写盘**。丢弃只记日志计数(无内容)。丢帧的后果由水位协议自愈(§5),不是数据丢失。
- **配对槽**:authed 设备 `pair_open` → `slot`(**9 位随机数字**[P2-e 从「短数字号」定为 9 位:空间 9 亿、TTL 内在线扫不完;槽号只是寻址,安全边界仍是 SECRET 的 SPAKE2],**TTL 10 分钟、单次使用**;每连接限一活跃槽[重开=烧旧开新]、**全局槽数上限 4096**[超限 `busy`,codex P2-e 轮 M2]);未鉴权连接只允许 `pair_join`(限一槽,失败即断开——猜槽变重连成本)。服务器盲桥 `pair_msg` 双向透传。SPAKE2 密钥确认失败 → `pair_close` 主动关槽(双方可发),**槽烧毁**(在线猜测恒只有一次);任一方断开同样烧槽并通知对端(`pair_peer{left}`)。
- **落盘**:registry 文件 + 封禁表,无用户内容。日志:连接/断开时刻、设备号、帧计数与字节量、信箱深度、丢弃事件——**永不落**:帧内容、信箱本体。
- **部署**:监听 localhost 明文 WS,TLS 由 Caddy 反代终结(zhujian.app 子域,运维见 P2-i);`/healthz` HTTP 探针。封禁表改动:SIGHUP 热重载(`systemctl reload`,open-signup 起=即时失权:banned 在线设备当场摘租约+kick+烧槽,信箱不删;未涉账户连接不断);registry 服务自管、无需手动重载。

## 5. 设备间同步协议(密文内层,服务器不可见)

内层消息(CBOR,按域子钥加密):

- op 域:`ops {origin, ops: [{op_id, hlc, entity, entity_id, kind, payload, origin_seq}, …]}`——**单帧单 origin、按 origin_seq 升序**,≤500 条或 256 KiB。词汇表(0020 CHECK,**0028 扩**):`item|topic × create/set_field/tombstone` ∪ `link × link_add/link_remove` ∪ `image × image_add/image_tombstone` ∪ **`space × set_field`**(空间名跨端同步 141:无 create 的单例 LWW 寄存器,entity_id 恒 `'profile'`,详见 space-name-sync-plan;走既有 op 通道故 PROTO_VER 不升,旧端按 §5.3 版本偏斜挂起自愈)。
- ctl 域:`hello {watermarks: {origin → seq}}`(连接后向在线各端广播,也可入箱)/ `want {origin, from_seq}`(补洞请求;**P2-c 实现为广播**——谁有谁答、没人有则静默等下一轮 hello 兜底,多应答者的重复帧由 op_id 幂等吸收[同 §5.2 已知噪音])。
- boot 域 / blob 域:见 §6 / 本节末。
- **线上格式纪律(P2-d 定,评审 P2-d 轮 M1/L1)**:内层消息 CBOR 用 serde externally tagged(变体名作单键 map),变体名/字段名即协议,黄金向量测试焊死。旧端解到**未知顶层变体**只能整帧 `Codec` 拒收(帧里谁的 op 都取不出,挂不上 origin)——水位不推进、hello/want 反复重取,响亮卡住直到升级,不是静默丢失;故 op/ctl 语义的将来扩展**优先走 `RemoteOp.kind`/payload**(0020 词汇表拒之 → 挂起该 origin,§5.3 版本偏斜自愈生效),确需新增顶层变体 = 协议破坏,必须升 `PROTO_VER`;P2-g 传输层必须把 `Codec` 转成用户可见的「对端版本较新,请升级」。**payload 数字纪律**:业务整数(`origin_seq/from_seq/seq/bytes/priority` 等)必须是 CBOR integer 且在 `i64` 范围内,禁 float/NaN——float 到达时读端 `as_i64()` 读不出 → Err 挂起,fail-fast 不静默取整(有测)。

### 5.1 origin_seq:op 的第三根轴(0024)

- 每设备给**自己发射**的 op 编连续号 1..n。三轴并存不互代:**op_id=身份、HLC=合并排序轴、origin_seq=传输与水位轴**。per-origin 内 seq 序 == HLC 序(clock.rs 本机严格单调保证,不变量入测)。
- **为什么必须有它**:HLC 不稠密,收端无法从 HLC 判断「中间还有没有没到的 op」。信箱 TTL/溢出丢帧后,没有 gap 检测的水位会**静默越过缺口**——那条 op 从此全网只有源设备有、且永不再传,是无声的数据丢失,直接违背「数据永不丢」。连续号让缺口可检、可等、可补。

### 5.2 水位与追赶

- **水位向量 = {origin → 本机日志中该 origin 的连续最大 seq}**。因收端严格连续应用(§5.3),本机日志每个 origin 恒为 1..max 无洞 → **水位=`MAX(origin_seq)`,派生不存**(项目铁律)。
- 追赶:连接后向在线各端发 `hello`(带全量水位向量);收到对方 hello,对每个 origin「我高你低」(含对方完全没听说过的 origin)→ 回 `ops` 升序分块。**任何持有者都能补任何 origin**(日志存的是「本机见过的全部 op」,不只自己的)。
- hello/want/ops 全走 mail lane → **追赶不要求双方同时在线**:A 的 hello 躺进 B 的信箱,B 上线后按它回 ops 进 A 的信箱,A 再上线收割。TTL 72h 内成立;超时则需再来一轮 hello(总会发生在下次连接)。
- 实时:本地写命令提交后,传输任务读 `origin=self AND origin_seq > last_pushed` → 加密 `send{to:"*", lane:mail}`;收到 `ack` 才推进 `last_pushed`(存 sync_meta;语义=「服务器已接手(在线转发+入箱)」,**不是**对端已收——对端兜底恒靠水位)。重连从 last_pushed+1 重推,重复帧由 op_id 幂等吸收。
- 多端同答一份 hello(3+ 设备账户)会产生重复 ops 帧——**已知噪音**,由 `AlreadySeen` 幂等吸收,朋友期设备数下不值得引入应答协商。

### 5.3 收端引擎(sans-io)

- **入池前硬校验(解密后第一步,评审①-H2;P2-c 实现补强项一并列此)**:`ops` 帧内**全部 op 的 `hlc` 设备后缀 == 帧 `origin`**、`origin_seq` 严格升序、**HLC 严格升序**(§5.1 不变量帧内即验——放进来会在记账撞 hlc UNIQUE 沦为永久挂起,分叉被误装成依赖问题)、op_id/HLC 形态合法(`Hlc::parse` 拒非规范)且 **op_id 帧内唯一**;AAD 由信封 `from`/`to` 重构——服务器改标签=解密失败。帧 `origin` 允许 ≠ 发送者(任何持有者代补是设计,§5.2),**但 op 与 origin 的绑定不可破**:少了这一校验,一帧标错 origin 就能把水位推过不存在的号,此后真 op 到达被当已见丢弃——不可自愈的静默丢失。任一不合 → **整帧拒收**(不进 pending,记协议错误)。
- **分叉检测(P2-c 实现后的完备形)**:①「重复/已见」的判定标准是**完整 op 六字段比对**(hlc/entity/entity_id/kind/payload/origin_seq),不是只比 op_id——同 op_id 异内容若被当重传吞掉,两端水位都齐、hello/want 永不再修,是静默分叉;②收到与本地日志**同 (origin, origin_seq)、同 hlc 或同 op_id 但完整 op 不符**的 = 该 origin 已分叉(现实来源:用户拿旧备份整库回滚,复活的旧身份重用了已花掉的序号);③ **本机 origin 的回声逐条完整对账**(克隆库双方各自花掉同一批序号,只查「seq > 水位」漏掉已花段);④ **跨帧双序矛盾**:入池 op 的 hlc 必须严格落在池中前驱/后继的 hlc 开区间(无前驱时下界=已应用日志的 MAX(hlc))——帧内校验挡不住跨帧交错,放行会写出 seq 序≠hlc 序的坏日志、再代补给第三端被对方帧内校验永久拒帧。以上任一 → **冻结该 origin 的同步 + UI 报错**,不静默取舍(恢复走 §11 手工流程)。已知遗留(codex 认可非阻断):跨帧同 op_id 先占 pending 未来 seq 的极端序会沦为挂起而非冻结——响亮且水位不越过,P2-g 可加 pending op_id 索引提前冻结。
- pending 池按 origin 分队;**仅当队头 seq == watermark(origin)+1 才出队**,依序喂 `replay::apply_remote_op`(每 op 一事务,内部自带记账/observe/豁免,P1 已建成)。seq ≤ watermark 的到达帧直接丢(已在日志,完整比对后)。**池按 origin 设上限**(10 000 条;字节维度待 P2-d 编码层):**在 drain 之后查**——连续可应用的大帧(hello 一次补几百条)drain 完池自然空、永不误杀,drain 后仍滞留的才是「洞/挂起后面的堆积」(P2-c property test 种子 1 实抓:drain 前查会反复误杀补给帧成活锁);超限丢弃该 origin 全部 pending——水位不动,**丢弃当场发 `want{watermark+1}`**(pending 没了别的重取信号在长连接下可能永不发生),只费流量不丢数据;版本偏斜或对端异常不再能撑爆内存(评审①-M5)。
- Outcome 处置:`Applied / AlreadySeen / LwwStale / SuppressedByTombstone / ParentGone` → 推进该 origin 连续位;`RenumberedLocalImages` → 推进 + **转成用户可见提示**(72 的提示义务,§8)。
- `Err`(行缺失且无 tombstone / create 撞已有行 / 未知 field / 未知 kind[0020 CHECK 拒]) → **该 origin 队头挂起**(不记账不推水位),其它 origin 照常;每有 op 成功落地就对全部挂起头再试一轮,直到不动点。
- **挂起 op 只存内存,崩溃即丢也无害**:水位没有越过它,重连后任何持有者按 hello 重喂——「不记账 + 水位不过缺口 = 自愈」,这是整个引擎的正确性支点。
- **喂入序与 P1 契约的对缝**:replay.rs 写的调用方契约是「按 HLC 升序喂入」;本引擎实际提供的是**弱化形**——per-origin 按 seq(=HLC)升序、跨 origin 任意交错,以 Err-挂起-重试兜住跨 origin 因果。论证:op 的因果依赖(编辑依赖 create、link 依赖两端行)恒指向**更低 HLC** 的 op(observe 机制:能引用必先见过);每条队内按 HLC 升序放行;若队头被挂起,它依赖的更低 HLC op 要么已应用、要么是(或先于)另一条队的队头——依赖链沿 HLC 严格递减,必然终结于无依赖的 op → **无环、必有进展,不会互锁**。LWW/tombstone-sticky/OR-set 判定全部按日志全集重算,与到达序无关。P2-c 落地时把 replay.rs 模块注释的契约行改写成此弱化形(codex 一轮已核:LWW/OR-set/sticky 在「乱序但最终全到」下终局与全局 HLC 升序一致)。
- 跨 origin「tombstone 先于 create 到达」**不挂起**:现实现 `apply_entity_tombstone` 删 0 行也算 Applied(幂等),之后 create 被 sticky 压制——两种到达序终局一致(codex 一轮实核过,Applied 路径活性更好,引擎无需特判)。
- **版本偏斜自愈**:新版本对端发来未知 field/kind → 该 origin 挂起 + UI 提示「对端版本较新,请升级」;本端升级后重喂自然继续,零丢失。同账户设备**不要求**锁版本,但旧端会停在挂起态直到升级——诚实且安全。
- 引擎为 sans-io 纯逻辑:输入=解密后的内层消息 + 本地日志句柄,输出=待发内层消息;不持 socket。收敛 property test 直接驱动两个引擎实例 + 内存服务器模型(§9)。

### 5.4 图字节旁路(blob 域)

- `image_add` op 应用后**行不建**(72 契约);引擎把缺字节的 image 入拉取队列(**队列不落存储**:重连时从日志派生「有 add、无 tombstone、宿主活着、行未建」):`blob_want {image}` 广播(mail lane,谁有谁答)→ `blob_have {image}` → 向首个应答者发起拉流:`blob_pull {image, transfer}`(direct lane;transfer=拉方取号的 ULID,同图先后两次拉流的残帧靠它区分)→ `blob_chunk {transfer, image, idx, last, data}`(256 KiB/块,回显 transfer;错源/错 transfer 静默丢,错序或**攒块超过 add 声明的 bytes 立即作废**)→ 行已不在(应答后被删的窗口)回 `blob_deny {image, transfer}`,拉方回队列另寻来源。
- **op 通道上的 `image_add` 必带合法 `sha256`(64 位小写 hex),缺失/形态不对拒收挂起**——0020~0024 间的无 hash 旧 op 只该经引导快照(含全量日志、水位齐)整体到达、永不走 op 通道,强制校验把违背该前提的路径变响亮;**声明的 `bytes` 以 `MAX_IMAGE_BYTES = 32 MiB` 封顶**(本地 attach / add 准入 / 字节到达三处同一条红线;没有它,异常对端可声明天文数字让收端「合法」攒块到无界内存)。字节全到 → 验长度+hash → **建行走 72 契约**:查该 image 与宿主的 tombstone(死图丢字节)、行 seq 取建行时刻 `effective_seqs` 重算值(reconcile 的分配段,唯一分配点;不取 payload.seq)、豁免事务内插行(`replay::apply_image_bytes`)。
- 拉流失败/对端下线(传输层通知)→ 退回队列;重试时机=下一次重连或收到 hello(对端可达信号)。图在此期间 UI 显示占位(实现轮定样式)。

## 6. 配对与引导

### 6.1 配对(新设备入账户)

1. 老端(authed)`pair_open` → 得 `slot`;UI 显示配对码 **`slot-SECRET`**(SECRET=8 位 Crockford base32,≈40 bit,一次性);
2. 新端(未入账户)连服务器发 `pair_join{slot}`;
3. 双方以 SECRET 为口令跑 **SPAKE2**(identities=固定常量+slot),`pair_msg` 盲桥透传 → 会话密钥;**双向密钥确认**(HMAC over transcript)不过 = 立即关槽(服务器 MITM 只有这一次在线猜测,2⁻⁴⁰);
4. 会话密钥 AEAD 下:老→新 `{account_id, K_acc, server_url}`;新→老 `{device_id, ed25519_pub}`;
5. 老端发 `register_device` 背书注册(§4);
6. 新端断开重连走正常 auth → 引导(§6.2)。

**P2-f 实现细化(`sync/pair.rs`,sans-io;与字面的偏差均在此回填)**:盲桥字节是 `PairWire` 五变体(Pake/Confirm/Grant/Enroll/Done,CBOR externally tagged 黄金向量焊死);消息序 = Pake{A} → Pake{B}+Confirm{macJ}(**joiner 先自证**,opener 验过才回 Confirm{macO} 并同批交出 Grant)→ Enroll → register_device/Registered → **Done**(新增线报:joiner 由此得知注册完成,可断开重连走 auth;不加它 joiner 无信号);密钥确认 = HMAC(HKDF(SPAKE2 密钥, 方向 info), 固定标签)——spake2 密钥本身即 H(transcript),故绑定完整 transcript,方向 info 防反射;材料 AEAD 用 HKDF 会话子钥,AAD=CBOR [`"zhujian-pair-v1"`, slot, 方向 grant|enroll];材料入口校验 ULID 形态/32B 定长/**pubkey 过曲线点解压**(§4 服务器同款);配对码 slot 段**恰 9 位照抄**、SECRET 解析容错后规范化(双端口令字节一致);任何失败 = 状态机死 + 调用方发 `pair_close` 烧槽。新依赖 spake2/ed25519-dalek + **hmac(规格外增补:密钥确认)**。

### 6.2 引导(bootstrap:fresh-to-account 设备拿全量)

- **为什么不能靠 op 回放**:0020 之前的存量数据没有 create op(sync-plan §3.5「legacy 全量引导走状态通道、不复用 create 路径」)。
- **形态:快照直通 + 表级导入合并**(不是换库——换库会撞 `device_id` 冻结触发器,且丢新端配对前本地已捕获的数据):
  1. 新端注册后首次 auth 成功,校验自己 **fresh-to-account**,判据两条缺一不可(评审①-H1):**(a)** 本地日志无任何他人 origin 的 op、无既往引导记录;**(b)** 本地现存全部实体都有本机 op 背书(每个 item/topic 有 create、每条 link 有 link_add、每张图有 image_add)——0020 之前的 legacy 无背书行**只允许存在于账户首台**(它是快照源,legacy 随快照走、不靠 op);加入方带着无背书数据 = **拒引导 + UI 指引**(「这台设备有早于同步纪元的历史数据,只能作为账户首台,或清空后加入」)。少了 (b),无背书行永远不进水位视野——全网只此一份、还自以为同步了,是水位协议照不见的静默不收敛。校验通过 → 向老端发 boot 请求(direct);曾同步过的设备**拒走引导**(它走水位追赶;丢库重装=新 device_id=天然新设备,照常配对+引导;**整库拷贝复用旧 device_id 由服务器拒注册兜底**,§4);
  2. 老端 `VACUUM INTO` 临时副本(WAL 下取一致性快照,在 db 锁内做)→ boot 域直通流式(`boot_offer{transfer, bytes, sha256}` + `boot_chunk` 256 KiB/块,不入信箱不驻留);
  3. 新端收全验 hash → `ATTACH` 只读(ATTACH 不能在事务内,先挂再开事务)→ **置回放豁免标志的单事务**内表级导入:`items / topics / item_topic / item_image / item_image_counter`(counter 按 `MAX(last_seq)` 合并)/ `oplog`(原样含 op_id/hlc/origin_seq)/ `item_revisions`(**不带自增 id 重编入**;历史是用户资产,带上,与「不参与同步」不矛盾——引导是克隆不是同步)。`sync_meta` **不导入**(身份各自的);
  4. 导入后同事务/紧随:0023 同款 counter 治理校验(**72 契约**)、`integrity_check`、per-origin seq 连续性断言;`clock.observe(导入日志的 max HLC)`(此后本机新 op 的 HLC 恒高于既有,编辑因果成立);
  5. 新端配对前的本地数据天然带自己的 create op → 引导是**并集**,导入后照常从 last_pushed 广播自己的 op(两边同名标签会并存为两个 topic——用户用既有「合并标签」收敛,不代合并);
  6. 引导期间到达的实时 op 帧在 pending 池等着(水位尚 0,队头 seq 对不上就等);导入一次性把水位抬到快照日志的 per-origin max → pending 自然续上,**快照切片与实时流无缝**。
- 导入必须在**回放豁免**下做:快照里的行可能处于「LWW 终态允许违反单机耦合不变量」的状态(0022 语义),非豁免 INSERT 会被耦合触发器拒。
- 同账户**并发引导两台新端**:各自独立拉快照,互不写对方,收敛靠之后的水位互补——允许,不加锁。

**P2-f 实现细化(`sync/boot.rs` + 迁移 0025;与字面的偏差均在此回填)**:
- boot 域内层消息 `BootMsg`(Req/Offer{transfer,bytes,sha256}/Chunk{transfer,idx,last,data},CBOR 黄金向量)是与 `Msg` 独立的消息空间(seal/open 泛型化装它,域子钥+AAD domain 隔死);快照声明大小 sanity 红线 8 GiB;**transfer 收端钉 ULID 形态**(要拼本地路径,穿越字节进不来)+ 落地文件 create_new(重复 transfer 拒,绝不截断;评审 P2-f 轮 H2)。
- **迁移 0025**:`trg_item_no_insert_sealed`/`trg_item_born_stage_required` 两只 INSERT 守护补回放豁免——0022「按回放契约永不触发」只对逐 op 回放成立,表级导入 INSERT 的是终态行(sealed 非空 / born_stage NULL 遗产 / born_stage≠stage 转办行);UPDATE 守护 `trg_item_born_stage_frozen` 不动。
- 判据 (a) 的「既往引导记录」落实为 `sync_meta.bootstrapped_at`(**与导入同一事务写入**,半途即无痕);fresh 判据在导入事务内**重验**(评审 P2-f 轮 M1;P2-g 接线契约:fresh 校验到 commit 持同一把 write_locks,重验只是契约被破坏时的最后防线)。
- 导入前 sanity:快照 `user_version` == 本机(版本偏斜给人话「两端升级到同版本再引导」)、快照 device_id 存在且 ≠ 本机;导入后校验(任一不过整体回滚):**op 形态与双序**(全量日志 op_id ULID / hlc 可解析 / per-origin seq 序==HLC 序——快照绕过了 §5.3 入池硬校验,此处补同一口径,评审 P2-f 轮 H1)+ **tombstone 复活三查**(item/topic/image 有墓碑仍有行=拒;终态逐字段==LWW 胜者的全量语义重算刻意不做,记账 P2-h 二轮)+ 0023 同款 counter 校验 + per-origin 连续 + foreign_key_check;`clock.observe(MAX hlc)` 也在导入事务内。
- **引导完成后必须重建 `Engine` 并重走 on_connected**:引擎 pending 池出队条件是严格 `seq == watermark+1`,导入抬高水位后池内旧队头永不出队会堵死该 origin;引擎状态本就可丢,重建 + 重发 hello 即步骤 6「pending 自然续上」的兑现形,水位不过缺口零丢失。

## 7. 存储层配套:迁移 0024(oplog 加 origin_seq)

- oplog 带 append-only 触发器,backfill 需 UPDATE → **整表重建**(0021/0022 同手法):
  - 新列 `origin_seq INTEGER NOT NULL CHECK(origin_seq >= 1)`;
  - 生成列 `origin TEXT GENERATED ALWAYS AS (substr(hlc, 24)) VIRTUAL`(HLC 编码第 24 字符起=device_id;不落存储、不会与 hlc 漂移);
  - `CREATE UNIQUE INDEX idx_oplog_origin_seq ON oplog(origin, origin_seq)`;
  - 既有行 backfill:`ROW_NUMBER() OVER (PARTITION BY substr(hlc,24) ORDER BY hlc)`——**假设声明:0024 落地时全部真实库的 oplog 只含本机 op**(P2 未开闸,replay 只在测试里跑过 fresh DB;该假设由迁移前探针核验);
  - `trg_oplog_immutable` / `trg_oplog_no_delete` 原样重建。
- 发射侧(oplog.rs::append):取号 `COALESCE((SELECT MAX(origin_seq) FROM oplog WHERE origin = self), 0) + 1`。**安全前提不是 append-only 本身,而是「进程内单写者 + 同一事务」**(评审①-M3):全部写路径过 `write_locks` 全局互斥、取号与数据写同事务提交——并发双读同一 MAX 的窗口不存在;「图N」的 MAX+1 另有删除留洞问题,此处日志无删除故无洞,但并发前提必须明说。`UNIQUE(origin, origin_seq)` 是**响亮兜底**:前提被破坏(如未来多进程开同库)时撞唯一索引失败,不静默分叉。`append_remote` 带远端 origin_seq 原样入库(连续性由引擎的连续应用保证)。
- 同轮改发射:`image_add` payload 增带 `sha256`(§5.4)。
- 不变量(全部入 cargo 测试):per-origin seq 连续 1..max 无洞;per-origin seq 序==hlc 序;三轴并存不互代。

## 8. 客户端接线(src-tauri;93 P4-a 起下述 `sync/` 模块在 `core/src/sync/`[共享 crate `zhujian-core`],lib.rs 命令面与事件桥仍在 src-tauri)

- 新模块:`sync/engine.rs`(sans-io 核心:水位/pending 池/挂起重试/批喂 apply_remote_op/出站游标)、`sync/crypto.rs`(子钥派生/封帧解帧/恢复码编解)、`sync/transport.rs`(tokio 任务:连接、指数退避重连 1s→60s 带抖动、心跳)、`sync/pair.rs`、`sync/boot.rs`。
- 锁序:引擎应用远端 op 走既有 `write_locks`(恒先库后钟),与 UI 命令互斥;**追赶分批**(每批 ≤100 op 释放一次锁)不饿死 UI。
- lib.rs 新命令(实现轮定细面;open-signup 155 起创号无码):`sync_status` / `sync_create_account(space_id, server_url)`(账户 ULID core 内自生成;space_id 由前端 `space.ts` 包装层注入)/ `sync_pair_start` / `sync_pair_join(code)` / `sync_set_server(url)` 等;`sync_meta` 新增键:`account_id / k_acc / device_key / server_url / last_pushed`(全部设备本地,永不同步)。
- UI 最小面:侧栏同步状态点(离线/连接/追赶中)、同步设置面板(创建账户[恢复码强制仪式]/添加设备[133 前叫「发起配对」,显示配对码]/用配对码加入/服务器地址[133 起收「高级」子页]/状态)、`RenumberedLocalImages` → 非模态提示条、远端 op 落地后 emit 事件 → 当前视图 refresh(视图 refresh 已幂等)。样式与文案走实现轮截图验收,不在本规格。
- 新依赖:客户端——P2-d 已引 `ciborium/chacha20poly1305/hkdf/serde_bytes`(serde_bytes 是规格外增补:`BlobChunk.data` 按 CBOR bytes 编码,免 serde 默认逐元素数组膨胀;**rand 不必**——24B nonce 用 `chacha20poly1305::aead::OsRng`;`sha2` 75 已有),P2-f 已引 `spake2/ed25519-dalek` + `hmac`(规格外增补:§6.1 密钥确认),P2-g 再引 `tokio-tungstenite(rustls)` + `sync-proto`(path;届时把 pair.rs 本地的 `is_ulid` 合并过去);服务端(P2-e 已建)依赖 `axum(ws)/tokio/ciborium/ed25519-dalek(验签)/getrandom/serde_json(registry 落盘)/time(日志)`。
- **仓库布局(P2-e 已落地)**:**不建 cargo workspace**(workspace 会把 target 挪到仓根,破坏 e2e 的 `src-tauri/target/*/app.exe` 锚)。`server/`(bin `zhujian-syncd`,lib+bin 形态供集成测直接 serve 随机端口)与 `sync-proto/`(信封类型/规格常量/签名 payload 构造,双端 path 依赖)为独立 crate,各自 target/(已进 .gitignore)、各自 Cargo.lock(均提交)。**93 P4-a 再加 `core/`(`zhujian-core` 共享核心:10 后端模块+迁移+211 测试,桌面/安卓壳双端 path 依赖;同纪律,lock 关键协议/密码学版本跨 crate 走 `scripts/check-lock-drift.mjs` 门禁,android-plan §1 M5)。**

**P2-g 实现细化(`sync/transport.rs`;与字面的偏差均在此回填,progress-log 80)**:
- **分域映射即协议**:`msg_domain`——`Ops`→op、`Hello/Want`→ctl、`Blob*`→blob、`BootMsg`→boot;发送端封帧与收端校验共用此单一真相源。收端不知帧属哪个域(信封无域字段),**逐域试解**(Op→Ctl→Blob 作 `Msg`、Boot 作 `BootMsg`):AEAD 子钥不同错域必 `Decrypt`;`Codec`=认证过但读不懂=对端版本较新(一次性 toast + status.skew,P2-d 轮 M1 义务);解开但**变体不属于该域**=协议错误拒收(评审 P2-g 轮 M1),不算 skew。
- **本地写通知源** = rusqlite `update_hook` 监听 oplog INSERT(写与通知同源于同一连接,零命令改造);出站游标 `last_pushed` 由 **Ack 驱动落 sync_meta**(ack=服务器已接手,非对端已收),连接建立时 `Engine::set_outbound_cursor` 复位到已 ack 位——「已发未 ack」重连即重推,重复由 op_id 幂等吸收。
- **引导编排**:引导中(bootstrapped_at 缺席)op/ctl/blob 帧**整帧丢弃**(半路应用会把库变「非 fresh」永久堵死导入;引导完成后 hello 互补重取,零丢失);Req 发给首个在线同伴,30s 无 Offer/块间超时轮转下一台(自己也在引导时不应答 Req,并发引导靠超时轮转无死锁);import 一次持锁(fresh→commit),成功后重建 Engine + on_connected(§6.2/P2-f 契约的兑现处)。
- **上限三连**:ops 帧 256 KiB 字节切帧(engine::ops_frames,与 ≤500 条先到为准);pending 池每 origin 加 **64 MiB 字节上限**(条数上限拦不住大 payload,评审 P2-g 轮 M3;超限丢弃+当场 want、水位不动);**正文/标题 200 KB 红线**(`repo::MAX_CONTENT_BYTES`,九个编排入口 fail-fast——单 op 编码 >1 MiB 过不了服务器帧上限,发送端会反复断连卡死出站,评审 P2-g 轮 M4)。
- 命令面:`sync_status/sync_create_account(space_id, server_url)`(open-signup 155 起无 invite,账户 ULID core 自生成)`/sync_pair_start/sync_pair_join(server_url,code)/sync_set_server/sync_recovery_code`;创号设备写配置时**直接落 bootstrapped_at**(纪元源永不引导;语义重载记 P2-h 遗留)。恢复码强制仪式=展示+警示+**回输核对**(评审 P2-g 轮 M2;Crockford 容错规范化后比对,不符拒绝完成)。

## 9. 测试与验收

- **收敛 property test(P2 止损探针)**:两~三个引擎实例(各配真 SQLite)+ 内存服务器模型(信箱语义:FIFO/TTL/容量丢最老/重启清空)——随机命令流 × 随机在线离线分区 × 乱序投递 × 信箱溢出 × 服务器重启,终局全员在线互补后:`items/topics/item_topic/item_image(含字节)/item_image_counter` 逐行相等、per-origin 水位相等。确定性种子,反例种子固化为回归测试。**反复出反例 → 合并规则回炉,别带病开闸**(sync-plan P2 止损行)。
- 服务端 tokio 集成测:鉴权拒(封禁/未注册/坏签名——open-signup 起准入开放)、首台 TOFU、路由 fanout、信箱溢出丢最老+TTL、direct 不入箱、配对桥单猜烧槽、帧上限。
- crypto 单元测:封解往返、AAD 拼接拒(跨账户/跨设备/跨域)、恢复码编解往返。
- 真机验收清单:两台 Windows 真实库副本——亚秒互通(前台对拍)、拔线离线写→重连互补、引导全程(第二台从零到全量、图完整)、「图N」并发撞号翻案提示可见、服务器重启后自愈。**已于 2026-07-09/10 五项全过**(progress-log 82:服务器在远端 Windows、本机真实库副本 + 远端临时库;首跑当场抓出「纪元源遗留 link_remove 无 observed」的引导审计误拒,修复经 codex 一轮四弹 GO——遗留 op 读法=「覆盖一切更低 HLC 的同关联 add」,与 boot 审计同口径,见 replay.rs 模块注释与评审记录「真机验收轮」)。
- codex:本规格第一轮(现在)+ 实现后协议+代码第二轮(朋友数据上通道前,sync-plan §六不裁项)。

## 10. 工序表

| 笔 | 内容 | 验收 |
|---|---|---|
| P2-a | 本规格 + codex 对抗审查一轮 | ✅ 2026-07-08 GO(六条修正落稿;progress-log 74) |
| P2-b | 迁移 0024(origin_seq + image_add 带 hash) | ✅ 2026-07-08(progress-log 75):cargo 136 全绿、真实库 v24 零丢失、backfill 前提「只含本机 op」当场核验成立 |
| P2-c | sans-io 引擎 + 双实例收敛 property test | ✅ 2026-07-08(progress-log 76):`sync/engine.rs` + 三实例收敛 property test 20 种子全绿(首跑即抓真 bug)、replay.rs 契约行已改弱化形、codex 四轮对抗 NO-GO→GO(九条修正全落,§5.3/§5.4 实现细化已回填);cargo 153 |
| P2-d | 加密层(crypto.rs) | ✅ 2026-07-08(progress-log 77):`sync/crypto.rs`(HKDF 域子钥/XChaCha20-Poly1305 封解帧/AAD/恢复码)+ Msg/RemoteOp CBOR 线上格式;标准向量(RFC 5869/XChaCha draft)+ AAD·Msg 黄金向量 + 拼接拒 + 恢复码 16 测全绿,codex 一轮 GO-with-fixes 三条全落;cargo 169 |
| P2-e | 服务端 crate(zhujian-syncd) | ✅ 2026-07-09(progress-log 78):`sync-proto/`(信封层,黄金向量全变体)+ `server/`(registry 原子 TOFU/路由信箱/配对桥/kick 专线);新测试 41(sync-proto 7 + server 34[tokio 集成 27])两遍全绿,codex 一轮 GO-with-fixes 六弹全落→复核 GO;src-tauri 零改动纯回归(cargo 169 + e2e 19 spec/72 例两遍绿) |
| P2-f | 配对(SPAKE2)+ 引导(导入合并) | ✅ 2026-07-09(progress-log 79):`sync/pair.rs` + `sync/boot.rs` + 迁移 0025(两只 INSERT 守护补豁免);双实例「配对→引导→重建引擎→互通」端到端收敛 + 注毒快照四连拒 + counter 治理校验,cargo 190 全绿;codex 一轮 GO-with-fixes 五弹全落→复核 GO;真实库 v25 零丢失 |
| P2-g | 客户端接线 + UI 最小面 | ✅ 2026-07-09(progress-log 80):`sync/transport.rs`(WSS/鉴权/分域封解帧[msg_domain 单一真相源+收端变体-域校验]/引导编排/配对编排/ack 驱动 last_pushed/update_hook 通知源)+ lib.rs 六命令 + 侧栏同步入口/设置面板/恢复码强制仪式回验;engine 补 256KiB 字节切帧 + pending 字节上限 64MiB;正文 200KB 红线九入口;双库端到端 tokio 集成测(真服务器:建账户→配对→引导→双向实时互通)全绿;cargo 200、e2e 20 spec/74 例两遍绿、cargo audit 三 lock 门禁过;codex 一轮 GO-with-fixes 四弹全落→复核 GO |
| P2-h | 两真机验收 + codex 第二轮 | **已还,两道闸门均过**:codex 第二轮(2026-07-09,progress-log 81:全链路整体对抗审查 GO-with-fixes 二轮→终局 GO,H1 密钥崩溃窗/H2 引导语义审计/M1 图拉流超时/L1 时钟偏斜提示 全落)+ 真机验收(2026-07-09/10,progress-log 82:§9 五项全过;首跑抓出纪元源遗留 link_remove 审计误拒,修复经 codex 一轮四弹 GO,cargo 209) |
| P2-i | 运维:VPS/zhujian.app/TLS/Caddy/部署脚本 + docs/deploy.md | ✅ 2026-07-10(progress-log 83):`sync.zhujian.app` 生产上线——DMIT VPS(Debian 12)+ Caddy 自动 TLS 反代 `127.0.0.1:8787` + systemd 常驻(专用用户/MemoryMax/沙箱);二进制=Windows 交叉编译 musl 静态(服务器不编译);healthz 200 + WS 101+Challenge 帧全验;白名单签发流程落地、首个正式账户已签;运维手册 **[deploy.md](deploy.md)** |

## 11. 威胁模型与诚实清单

- **服务器 = honest-but-curious + 可被黑/被传票**:内容零知识(密文过内存);可见面 = 账户/设备号、上线时刻、帧计数与大小(流量分析可推「谁何时活跃」——对外披露措辞照 sync-plan §3.2,不绝对化)。
- **服务器恶意**:不能读/改内容(AEAD+AAD);能拒绝服务、丢帧、重放(丢帧由水位自愈可检,重放由 op_id/AlreadySeen 幂等吸收);配对时能做一次在线猜码(2⁻⁴⁰,失败烧槽)。**防不了**:运营者分发恶意客户端——开源可审计是长期答案,协议不解决。
- **设备被盗 = 账户失守**(K_acc 与明文库同在盘上):本机磁盘安全不在威胁模型内。补救=手工重置:运营者删 registry 账户 → 幸存设备重建新账户(新 K_acc)重配对;朋友期文档化流程,不做产品化撤销。
- **信箱语义的诚实面**:TTL 72h/容量丢最老/重启即失都**不是数据丢失**(它只是加速器,真相在设备日志,水位互补自愈);真正的丢失窗口只有一个——**某设备独有的 op 在它硬盘死亡前没同步出去**,这是「数据只存在你自己的设备上」的物理边界,文案不得夸大成云备份(sync-plan §二)。
- **两设备账户长期不同时在线且信箱超时**:同步停摆到重叠在线为止——物理限制,诚实接受。
- **旧备份整库回滚 = 复活旧设备身份**,重用已花掉的 origin_seq/HLC,与网络里既有 op 分叉。协议不静默修复:收端检出同号不同 op → 冻结该 origin + 报错(§5.3),恢复走手工流程(以某端为准重建账户)。备份文档必须写明「回滚同步库后不要直接联网,先找运营者」;「拷库当第二台」则由服务器拒重复 device_id 注册当场拦下(§4)。
- HLC 依赖墙钟参与排序:对端系统时间大幅超前会让其 op 恒赢 LWW——已知特性;引擎观测到对端 HLC 超前本机墙钟 >24h 时 UI 提示检查系统时间(SHOULD,实现轮定)。
- 服务器落盘全清单:registry(账户/设备/公钥)、封禁表(open-signup 起替代白名单)、运行日志(连接与计量,无内容)。**永不落**:任何帧内容、信箱本体、密钥。

## 评审记录

### 第一轮(2026-07-08,设计稿对抗审查,codex)——GO-with-fixes,六条全落

- **H1 fresh-to-account 判据不够**:只查「无他人 origin op」放行不了带 legacy 无背书数据的加入方——其行无 create op 可广播,水位协议照不见,静默不收敛。→ §6.2 判据加 (b)「本地全部实体有本机 op 背书」,legacy 只许在账户首台;拒引导 + UI 指引。
- **H2 帧内 origin 绑定缺硬校验**:帧标 origin=A 而 op 的 HLC 后缀是 B(bug 或坏客户端),会把 A 的水位推过不存在的号,真 A:1 到达被当已见丢弃——不可自愈。→ §5.3 入池前硬校验(op hlc 后缀==帧 origin、seq 严格升序、AAD 由信封重构),违者整帧拒收;并加分叉检测(同号不同 op_id → 冻结该 origin 报错,对应备份回滚复活旧身份的现实场景)。
- **M3 MAX+1 安全理由写错**:append-only 不等于并发安全,真正前提是进程内单写者 + 取号与数据同事务;UNIQUE 是响亮兜底。→ §7 改写。
- **M4 register_first TOFU 竞态**:并发双首台若非原子检查+插入,可能各持不同 K_acc 永久停摆。→ §4 钉死账户级原子操作,败者收 err。
- **M5 版本偏斜可撑爆 pending**:挂起 origin 的后续 op 无限堆内存。→ §5.3 pending 池按 origin 设上限,超限丢 pending 保水位,hello/want 重取。
- **L1 AAD 再硬化**:域隔离别只靠子钥。→ §2 AAD 加 to 与 domain,`deliver` 回显原 to。
- **negative assurance(codex 核过站得住的)**:信箱丢帧/TTL/重启不构成数据丢失(水位自愈);`substr(hlc,24)` 偏移对(Rust `s[23..]` ↔ SQLite 1-based);「tombstone 先于 create 到达」现实现是幂等 Applied、终局收敛且活性更好;LWW/OR-set/sticky 在乱序全到下与全局 HLC 升序终局一致;72 图旁路契约、65 delete-wins-sticky、70 行缺失 Err/引导不复用 create、「派生不存」均未被违反;SPAKE2+40bit 一次性码+烧槽朋友期够用,服务器改序/丢帧只能 DoS 不能静默 MITM。

### P2-d 轮(2026-07-08,加密层实现审查,codex)——GO-with-fixes,三条全落

- **M1 未知顶层 Msg 变体的版本偏斜衔接**:`OpenError::Codec` 整帧拒收挂不上 origin,§5.3 的挂起自愈只覆盖 `RemoteOp.kind`/field 级偏斜。推演结论:水位不推进、hello/want 反复重取,**响亮卡住非静默丢失**。→ §5 落线上格式纪律(扩展优先走 kind/payload、新顶层变体必须升 PROTO_VER、P2-g 必须把 Codec 转用户可见提示)。
- **M2 AAD 的 CBOR 字节级规范**:CBOR 有多种合法编码形态,别端实现用 indefinite-length/非最短前缀会合法帧互拒。→ §2 钉死 preferred serialization + crypto.rs AAD 黄金向量为对拍基准(字符串长度前缀自带,无「acct/from 边界移动」注入歧义——codex 核过)。
- **L1 payload 数字形态**:跨端把 `42` 编成 float `42.0` 会被读端拒收挂起(fail-fast 非静默,但会卡互通)。→ §5 payload 数字纪律 + 整数往返/float 拒读测试。
- **negative assurance(核过站得住)**:HKDF salt=None 在 32B 随机 K_acc 下可接受,info 前缀+封闭 Domain 枚举无拼接碰撞;24B 随机 nonce 多设备共享域子钥无计数器协调可接受;TooShort/Decrypt/Codec 三分类不构成 padding oracle(AEAD 先验 tag);恢复码 256bit→52 字符编解严格互逆、别名映射不产生歧义、mask 位宽够;BlobChunk.data 独用 serde_bytes 正确;依赖(chacha20poly1305 0.10.1/hkdf 0.12.4/ciborium 0.2.2/serde_bytes 0.11.19)无已知弃用坑,**接 P2-g 前跑一次 `cargo audit` 作发布门禁**(待办)。

### P2-e 轮(2026-07-09,服务端实现审查,codex)——GO-with-fixes 六弹全落 → 复核 GO

- **H1 下行 `send().await` 可被不读 socket 的对端卡死连接任务**(mpsc 满时回 Pong 挂起;静默判死只包 stream.next 兜不住)→ 下行一律 `try_send` + 读循环每帧前查 `capacity()==0`(满=对端不读)断开 + 收尾 `timeout(10s, writer)` 超时 abort。
- **H2 慢客户端只摘在线表、旧连接不死**(还是 Authed 可上行,writer 继续吐旧队,同队 FIFO 破坏,offline 不广播)→ **关断走专线**:每连接 cap=1 kick 通道,读循环 `select!{biased}`;顶替与慢摘都 kick + 慢摘广播 offline。原则:**控制信号绝不排在可能满的数据队列后面**。
- **M1 attach 搬箱先 remove、失败丢余帧** → 改「出队成功才算」,失败 `push_front` 回箱(TrySendError 带回消息所有权),余帧原位等下次上线。
- **M2 配对槽 6 位可猜 + 无数量上限** → 槽号 9 位随机 + 全局槽上限 4096(超限 busy)+ 每连接限一槽(已有)+ join 失败即断(已有)。
- **M3 register_device 只查长度,垃圾 32B 入库永久烧掉 device_id** → 注册前 `VerifyingKey::from_bytes` 解压校验;测试用「程序化找不可解压 32B」(0xFF;32 碰巧是合法点——曲线点合法性别靠拍脑袋样本)。
- **M4 测试补漏** → hub 单元测(慢摘/回箱/槽上限)+ registry 落盘失败回滚测 + register_device 跨账户拒集成测 + 黄金向量补到全变体。
- **L1(接受不改,记录)**:register_first 对有效自签账户返回 not_first/device_id_taken 可与 auth_failed 区分=轻探测面;not_first 是 UX 必需指引,账户/设备是 128-bit ULID 不可枚举,接受(open-signup 后语义不变:探测只能确认「某具体 ULID 已被用」,枚举不可行)。
- **复核留意点(L,记录)**:attach 搬箱 try_send 失败(Closed)仍会登记 online——随后该连接读循环退出 detach 即清;生产默认容量下 Full 不可达。非阻断。
- **negative assurance(核过站得住)**:register_first 的「检查+插入+落盘」同临界区,并发双首台恰一胜;三类签名 payload 的定长形态守卫齐(拼接无歧义);register_device 无 nonce 在已鉴权通道内重放=幂等无害;device_id 全局唯一守护覆盖两条注册路;`capacity()==0` 判据不误伤正常客户端(信箱 ≤ max_frames < cap,搬箱后仍有 headroom;千级在线设备账户才会碰边界,朋友期非风险)。

### P2-f 轮(2026-07-09,配对+引导实现审查,codex)——GO-with-fixes 五弹全落 → 复核 GO

- **H1 boot 导入绕过 op 帧硬校验**:快照绕过 §5.3 的 `validate_frame`,坏快照可导入「origin_seq 连续但 HLC 倒挂」的日志,抬水位后代补给第三端被对方帧内校验永久拒帧(坏历史带病传播)→ 导入事务内对合并后全量日志补同一口径(op_id ULID / hlc 可解析 / per-origin seq 序==HLC 序;origin==hlc 后缀由生成列恒真不必另验)+ 注毒快照测试四连拒。
- **H2 BootReceiver 用远端 transfer 拼路径**:恶意已认证 peer 可传 `../`、`\` 穿越写出预期目录,且 `File::create` 会截断既有文件 → transfer 钉 ULID 形态(穿越字节进不来)+ `create_new`(同名即拒)+ 穿越/重复测试。
- **M1 fresh 检查与导入事务间 TOCTOU** → 导入事务内重验 fresh;P2-g 接线契约钉死「fresh 校验到 commit 持同一把 write_locks」,重验是契约被破坏时的最后防线不是并发方案。
- **M2 快照终态未验证与 oplog 语义一致**(损坏/坏实现同版本客户端可灌「约束合法但语义不收敛」的状态)→ 窄形落地:tombstone 复活三查(item/topic/image 有墓碑仍有行=拒);**全量 LWW/OR-set 语义重算刻意不做**(等于回放重建整库,健康 VACUUM 快照不会违反),记账 P2-h codex 二轮定夺是否加码。codex 原建议中的「image 行应有 add 背书」**被反驳并被接受**:快照源是账户首台时合法携带 0020 前 legacy 无背书图(引导是 legacy 的状态通道,评审①-H1 (b) 的快照侧例外),强制背书会误拒合法快照。
- **L1 配对码 slot 段任意长数字宽进**(显示端 9 位)→ 解析收紧恰 9 位;`pair_code` 加 slot < 1e9 断言。
- **negative assurance(核过站得住)**:SPAKE2 用法(identities=固定常量+slot、password=规范化 SECRET)与密钥确认顺序(joiner 先自证、opener 验过才交 Grant)无可利用破口;确认值不泄露可离线爆破材料(PAKE 对被动观察者安全);会话 AEAD 的 AAD 绑 slot+方向足以防跨会话/跨方向拼接;盲桥服务器恒只有一次在线猜测;配对码 Crockford 容错不引入口令字节歧义(解析规范化)。

### P2-g 轮(2026-07-09,客户端接线+UI 实现审查,codex)——GO-with-fixes 四弹全落 → 复核抓一漏口 → 终局 GO

- **M1 收端缺「变体↔域」校验**:坏的已配对对端可把 Hello 封进 op 域照样被吃下,「域映射即协议」形同虚设 → `msg_domain` 单一真相源 + `open_deliver` 解开后校验,不符 `WrongDomain` 协议错误拒收(不算 skew)。
- **M2 恢复码仪式无回验**:只点「我已抄写」不满足 §2 强制仪式 → ceremony 页加回输框,Crockford 容错规范化比对,不符拒绝完成;仪式页禁 Esc/点外关闭。
- **M3 pending 池无字节上限**:条数上限(10000/origin)拦不住大 payload op → 加 64 MiB/origin 字节上限,同一套「drain 后查、丢弃+want、水位不动」处置。
- **M4 单 op 编码 >1 MiB 反复断连卡死出站**:发射前守不住只能断连 → 正文/标题 200 KB 红线(`ensure_content_fits`)接全部九个编排入口 fail-fast;复核轮补抓 `file_to_topic(new_title)` 漏口。
- 核过项:逐域试解无 oracle/降级面、skew 判定时机(认证后才算)、引导期丢帧论证、import 持锁与重建引擎契约、ack 游标模型(含「A 崩溃未推」的重推与物理丢失窗口界定)、锁序无违例、配对 Err 路由不误伤。
- **L 级遗留(P2-h)**:bootstrapped_at 语义重载(「纪元源」与「导入过快照」共用一个标记);挂起/FrameRejected 只进 status.error、在线点仍绿(持续错误要更明显的 badge);pending op_id 索引提前冻结(P2-c 轮遗留)仍未做。

### P2-h 轮(2026-07-09,全链路整体对抗审查——朋友真实数据上通道前的最后闸门,codex)——GO-with-fixes 二轮 → 终局 GO

第一轮起始并非逐笔实现审查,而是把 P2-b…P2-g 整个同步栈当一个系统攻击(跨模块缝隙/规格-实现漂移/端到端攻击场景/数据丢失窗口/E2EE 完备性/测试盲区)。抓到 4 条(H1/H2/M1/L1),修完复核抓 H2 两处口径洞,再修 → 终局 GO。

- **H1 设备密钥先注册后本地才落盘 = 崩溃烧掉 device_id**:配对 joiner 生成 seed/pubkey、经 opener `RegisterDevice` 让服务器持久化 pubkey,但本机私钥要到 `Done/Granted` 后才 `save_config`;此间崩溃 = 服务器有 pubkey、本机无私钥,重试用同库固定 device_id 生成新 pubkey 被 `device_id_taken` 拒,带本地数据的设备卡死。`create_account` 同类窗口(k_acc 也丢)。→ **服务端** `register_first` 对「账户唯一设备恰是本次 (device,pubkey)」幂等放行(不破恰一胜:并发两台异钥不同时命中;同设备异钥仍拒);**客户端**引入 `pending_device_seed/pending_k_acc/pending_account_id` 键(`load_config` 只认 5 正式键、pending 不可见),注册前先落 pending、崩溃重试复用同一份(pubkey 不变 → 服务器幂等吸收)、`save_config` 改为「写正式键 + 清 pending」同事务。测试:registry 单测 + `tofu_first_then_idempotent_retry_and_second_device_rejected` + transport 集成测 `create_account_retry_reuses_pending_and_server_absorbs`(造「服务器已注册、本地只剩 pending」现场→复用→幂等 Authed→落配置→清 pending)。【**112 更新(2026-07-13,multispace-plan §4 v5 拍板)**:pending 键机制整体拆除——材料改 attempt 内存生成、Done 才随 save_config 落库;崩溃=身份已烧,人话指引处置(**124 修订分两类:配对中断=清空间重配;创号孤儿=不清库,运营者吊销+新码后原库原样重试**,见 phone-space-plan §2.1);且配对闸前移为 `Grant → gate → Enroll` 真停点(`PairOutput::GrantPending`/`approve`),gate 拒=老端从不注册。本段保留为 P2 时代史实。】
- **H2 引导快照只做墓碑窄校验,可注入「有日志背书但终态≠日志语义」的静默分叉**:结构校验(op_id/hlc/双序/tombstone 复活/counter/per-origin/FK/integrity)挡不住「oplog 说 content=A、`items.content`=B」;恶意/坏实现 peer 借此静默分叉、还能续传坏终态给第三端。→ `boot.rs::audit_op_backed_semantics`:对有 op 背书的实体按日志重算 LWW/OR-set/图N 与终态比对,不符整体回滚。**方向调整(codex 二轮接受)**:codex 原建议「回放快照 oplog 进 scratch 库比终态」,实现中发现会**误拒合法快照**——0021 前整数 position set_field op 是历史不改写,现行 `apply_item_set_field` 拒整数 position,账户纪元源(含过渡期 op)做引导源时 scratch 重放会 Err 打断真实引导;改为**直接 SQL 字段级 LWW 比对**(item content/stage/created_at/due_on/priority/archived_at/sealed_at/born_stage + topic title/updated_at + OR-set link + 图N effective seq),**唯独跳过 position**(唯一格式漂移 + 非用户内容,分叉不损数据)。复核二修:① OR-set `alive` 排除父实体已 tombstone 的 link_add(对齐 `apply_link` 的 ParentGone,否则「父已删、link_add 仍在史」的合法快照误拒);② topic `updated_at` 纳入审计(它是同步字段,出生初值 = created_at)。测试:既有全形态导入验证放行 + `import_rejects_semantically_divergent_snapshot`(content/OR-set/图N/topic.updated_at 四连拒)+ `import_accepts_link_with_tombstoned_parent`(item/topic 两条父墓碑合法快照放行)。
- **M1 图拉流缺 idle/overall timeout,坏 peer 可永久劫持缺图状态**:恶意已配对 peer 对缺图应 `BlobHave`、收端进 `pulling`、对方保持在线却不发块;连接不重连(pong 续命)时该图本会话再不向别的设备请求、无提示。→ `Engine::on_tick`(传输层心跳 30s 驱动):`Pull.stale_ticks` 收块清零,连续 `PULL_STALE_TICKS=2`(≈60s)无进展作废拉流、回 `missing_blobs` 重发 want;`blob_shunned`(session 级、`on_connected` 清)避开刚超时来源,让别的设备应答。测试 `stale_pull_expires_reshuns_and_rerequests`。
- **L1 §11 的 HLC 超前墙钟 >24h 提示未实现**:对端系统时间错到未来,LWW 长期偏向它、用户无提示。→ `Event::ClockSkew{ahead_hours}`(engine on_ops 跨 origin 帧、validate 后取帧内最大 wall_ms,超本机墙钟 24h 每会话报一次,不拒帧;墙钟取 `clock::wall_now_ms()` 原始系统时间、非可能被偏斜 observe 抬高的 `Clock.last_wall_ms`)→ transport `SyncStatus.clock_skew` + 一次性 toast(区别于版本偏斜 `skew`)+ 前端提示行。测试 `clock_skew_warns_once_per_session`。
- **挂账项定夺**:1(H2 加码)= 已加(op-backed 直接 LWW/OR-set/图N);2(bootstrapped_at 语义重载)= 接受现状(正确性不依赖);3(持续错误 badge)= 接受暂缓(面板已显 frozen/skew/clock_skew/error,badge 是可观测性抛光非正确性);4(pending 同 op_id 未来 seq 极端序)= 接受现状(响亮挂起非静默丢失);5(HLC>24h 提示)= 已还(L1)。
- **negative assurance(核过站得住)**:H1 密钥生命周期/正式-临时配置隔离/服务端幂等边界闭合崩溃窗;H2 LWW 初值/NULL 比较/父墓碑 OR-set/图N 挂点站得住、legacy 无背书例外一致、position 取舍成立;M1 不推进水位只恢复 want、崩溃/重连自愈;L1 纯观测事件不影响收敛。除已修外无剩余规格-实现漂移或端到端静默丢失面。
- **仍待(真机物理活,非本轮)**:两台 Windows 真机验收清单(§9:亚秒互通/拔线互补/引导全程含图/「图N」并发撞号提示可见/服务器重启自愈)——单机双实例抢热键+单实例锁做不了,须两真机或改 YS_DB_PATH+禁热键形态。P2-h 的「codex 协议+代码第二轮」闸门已过,真机验收独立于代码正确性。

### 真机验收轮(2026-07-09/10,§9 五项物理验收 + 引导审计遗留形态修复,codex)——GO-with-fixes ×2 → 终局 GO

- **现场**:验收首跑,纪元源真实库副本做引导源,收端审计误拒:「标签关联终态与自身日志的 OR-set 结果不符(表 15 vs 日志存活 17),整体回滚」。根因=真实库有 2 条 64→70 窗口期(0022 引入 observed 之前)发射的 `link_remove` 无 `observed` key,严格 OR-set 读法覆盖不了任何 add。与 P2-h 轮 H2 的 position 格式漂移同类,当时漏了 link 域。
- **修复四弹(boot.rs + replay.rs)**:① boot 审计存活集加遗留分支——`json_type(payload,'$.observed') IS NULL`(只认「缺 key」,显式 JSON null 是伪造不吃宽语义)的 remove 按「覆盖一切更低 HLC 的同关联 add」计死(单机史实总序=HLC 序;post-70 发射恒带 observed 至少 `[]`;攻击面无新增——带全量 observed 的 remove 本就能合法杀同批 add);② `apply_link` 帧入口拒缺 observed(遗留形态只随引导快照导入、不走帧,堵「借帧通道灌遗留宽语义 remove」);③ `apply_link` 重算 SQL 补同一遗留分支(口径不一致 → `observed:[]` 合法 remove 触发重算即复活史实已删关联、未来引导永久不符);④ 两处存活集 `NOT IN` → `NOT EXISTS + je.value = a.op_id`(伪造 `observed:[null]` 经 NOT IN 三值逻辑毒化「全部 add 判死」可删行过审;NOT EXISTS 下 NULL 永不相等)。
- **测试**:cargo 209(boot +3 / replay +1 / 形状测试补缺 observed 拒收);修后审计 SQL 对拍真实库副本 15==15。
