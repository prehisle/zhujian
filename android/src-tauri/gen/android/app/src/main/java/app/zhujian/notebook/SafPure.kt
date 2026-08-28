package app.zhujian.notebook

import java.io.File
import java.security.SecureRandom

/**
 * SAF 桥的**纯逻辑**半(backup-plan §17)——⛔ 这里不许出现任何 `android.*` 类型。
 *
 * ⭐ 单独成文件只有一个理由:**它要能被 JVM 单测直接跑**(§17.16 那几刀)。
 * 桥面那些闸如果长在 `Activity` 里,就只能靠真机跑一遍看脸色 —— 而这一笔最弱的一格
 * 恰恰就是测试(SAF 选择器 CDP 驱不动),能挪进单测的每一条都必须挪进来。
 */
object SafPure {
    /** 尺 4:回拷到 outbox 的本地名(§17.5 那张四把尺表)。⛔ 既不来自请求名、也不来自回读名。 */
    const val FETCH_PREFIX = "verify-"
    const val ARTIFACT_SUFFIX = ".zjbak"

    /** core 的产物名前缀(`engine.rs:398` 的 `zhujian-<8>-<UTC>-<ULID>.zjbak`)。 */
    const val PRODUCT_PREFIX = "zhujian-"

    /** 反斜杠。单独成常量,免得这一行在补丁工具里被转义规则咬到(本轮真栽过一次)。 */
    private const val SEP_BACKSLASH = '\\'

    /** 产出账上限(§17.9):超了按记账时刻丢最老的 —— **丢账不丢文件**。 */
    const val LEDGER_CAP = 200

    /** 列表与「其他文件」计数的上限;数到 `LIST_CAP + 1` 就停(§17.9 那条饱和计数)。 */
    const val LIST_CAP = 200

    /**
     * 一次列目录**最多看多少行**(§17.14-3 那条常量闸在这一格上的形)。
     *
     * ⛔ **它是「工作量的上界」,与 [LIST_CAP]「展示的上界」是两件事,两个都得有**
     * (实现审弹 2 复核轮的 M):用户挑的可能是整个「下载」、网盘根目录、几十万项的 provider ——
     * 「是用户自己的目录」**不构成上界**。
     * ⚠ 到顶就停,并把「这次只看了多少」如实交给 UI ⇒ ⛔ 绝不许显示成「这就是全部」。
     */
    const val LIST_SCAN_CAP = 2000

    // ---- 流式 top-K:内存恒为 K,⛔ 不保存全体 -----------------------------------------

    /** 列表里的一行(纯数据,⛔ 不碰 JSON/Android,好让 top-K 能被直接测)。 */
    data class Row(
        val docId: String,
        val name: String,
        val bytes: Long,
        val ms: Long,
        val fromLedger: Boolean,
    )

    /**
     * 「最近 200 个」的**有界**实现。
     *
     * ⛔ **别退回「全收进 ArrayList 再排序」**(实现审弹 2 复核轮当场判的 M):那让**内存与
     * 工作量都由目录规模说了算**,而 §17.14-3 那条常量闸正是挡这个的。这里内存恒为 `k`。
     *
     * ⚠ 顺序判据与 core 的 `list_backups` 同形:**新在前**;取不到时刻(0)的排最后,
     * 再按名字兜底 —— 顺序必须**稳定**,否则每次刷新都换一个样子。
     */
    class TopK(private val k: Int) {
        // 最小堆:堆顶是「当前留着的这些里最旧的那个」,新的一进来就把它挤掉。
        // ⭐ **两处比较必须是同一套**(实现审弹 2 二复核的 L):手写一个条件式 + 另写一个堆
        // 比较器,两边迟早漂移。⇒ 只定义一个 [NEWEST_FIRST],堆用它的逆序。
        private val worstFirst = java.util.PriorityQueue<Row>(NEWEST_FIRST.reversed())

        /** 一共**够格**的候选有多少(⇒ 用来判「有没有被截断」)。 */
        var candidates = 0
            private set

        fun offer(r: Row) {
            candidates++
            if (worstFirst.size < k) {
                worstFirst.add(r)
                return
            }
            val worst = worstFirst.peek() ?: return
            // ⭐ 与堆顶比,用的就是那唯一一套顺序(⛔ 别在这儿手写条件式)。
            if (NEWEST_FIRST.compare(r, worst) < 0) {
                worstFirst.poll()
                worstFirst.add(r)
            }
        }

        fun truncated(): Boolean = candidates > k

        /** 排好序的结果(新在前)。 */
        fun sorted(): List<Row> = worstFirst.sortedWith(NEWEST_FIRST)

        companion object {
            /**
             * **唯一那套顺序**:新在前 → 名字升序 → **`docId` 升序**。
             *
             * ⛔ 最后那一格不是装饰(实现审弹 2 二复核的 L):两份**不同**文档完全可能同名
             * 又同 mtime;它们要是恰好跨在 top-K 的边界上,留谁就由 **provider 的游标顺序**
             * 说了算 —— 那时「顺序稳定」这句话按字面就不成立了(provider 换个顺序,刷新一次
             * 结果就变)。`docId` 是这条路上唯一稳定且唯一的键。
             */
            val NEWEST_FIRST: Comparator<Row> =
                compareByDescending<Row> { it.ms }.thenBy { it.name }.thenBy { it.docId }
        }
    }

    // ---- ULID(transferId 与尺 4 都用它;Crockford base32,26 字符)-------------------

    private const val CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
    private val rnd = SecureRandom()

    /**
     * 生成一枚 ULID:48 位毫秒时间 + 80 位随机。
     *
     * ⭐ 它当 `transferId` 用,那格的契约是「**永不复用**」(§17.5 二弹 H:记录只有一条、
     * 会被下一趟覆盖,身份对不上就说明这一趟的结果已经不可知)。⛔ 别改成计数器 ——
     * 计数器跨进程重启会从头来,那正是「旧轮询消费新结果」的复发面。
     */
    fun ulid(nowMs: Long = System.currentTimeMillis()): String {
        val bytes = ByteArray(10)
        rnd.nextBytes(bytes)
        val sb = StringBuilder(26)
        var t = nowMs
        val time = CharArray(10)
        for (i in 9 downTo 0) {
            time[i] = CROCKFORD[(t and 31L).toInt()]
            t = t shr 5
        }
        sb.append(time)
        // 80 位随机 → 16 个 base32 字符:每 5 位取一个。
        var acc = 0
        var bits = 0
        for (b in bytes) {
            acc = (acc shl 8) or (b.toInt() and 0xFF)
            bits += 8
            while (bits >= 5) {
                bits -= 5
                sb.append(CROCKFORD[(acc shr bits) and 31])
            }
        }
        return sb.toString()
    }

    fun fetchLocalName(id: String): String = "$FETCH_PREFIX$id$ARTIFACT_SUFFIX"

    // ---- H-1 的那道闸:桥面只收裸文件名,路径由壳自己 join ------------------------------

    /**
     * ⛔ **本案最重的一条**(codex 一弹 H-1):规格第一版给 `fetchFile` 的目标钉了闸,却把
     * `putFile` 的**源**敞着 —— 那等于给了 JS 一条「把 app 私有区任意文件搬进用户目录」的路,
     * **`.backup-staging` 里那份整库明文快照**与 `.backup.json`(**明文钥**)当场可外泄,
     * §17.3 那条唯一的安全论证被自己的桥打穿。
     *
     * 四条校验缺一条都算没封:
     * 1. 不含任何路径分隔符与 `..`(是**裸名**,不是路径);
     * 2. 以 `.zjbak` 收尾;
     * 3. join 出来规范化之后**父目录恰是 outbox**;
     * 4. 是**普通文件**(⛔ 不跟 symlink)。
     *
     * 回 `null` = 过闸(结果在 [out]);回非空字符串 = 拒的理由(⛔ 原样说给用户,别糊)。
     */
    fun resolveOutboxChild(outbox: File, name: String, out: Array<File?>): String? {
        out[0] = null
        if (name.isEmpty() || name == "." || name == "..") return "文件名不合法"
        if (name.contains('/') || name.contains(SEP_BACKSLASH) || name.contains(Char(0))) {
            return "文件名不许带路径"
        }
        if (name.contains("..")) return "文件名不许带路径"
        if (!name.endsWith(ARTIFACT_SUFFIX)) return "这不是一个 .zjbak 文件"
        val f = File(outbox, name)
        // 第 4 条:⛔ 不跟 symlink —— **直接问**,不靠规范化的副作用。
        // ⭐ 这一行是本轮那把刀改出来的:第一版把它写成「规范化之后必然恰是
        // `<canonOutbox>/<name>`」,而单测当场证伪了那个前提 —— **Windows/JDK18 上
        // `canonicalFile` 根本不解开 symlink**(安卓靠 realpath 才成立)。
        // ⇒ 一条只在某些平台上成立的推论,不配当一道安全闸。
        if (java.nio.file.Files.isSymbolicLink(f.toPath())) return "文件不是普通文件"
        val canonOutbox: File
        val canon: File
        try {
            // ⚠ **两边都要规范化,而且不许拿 `absolutePath` 当基准** —— 安卓上
            // `context.dataDir` 常常是 `/data/user/0/<pkg>`,而它自己就是指向
            // `/data/data/<pkg>` 的一条链接。拿「规范化后与原路径是否相同」当 symlink 判据,
            // 在这一端会把**每一个正常文件**都判成 symlink。
            canonOutbox = outbox.canonicalFile
            canon = f.canonicalFile
        } catch (e: Exception) {
            return "备份中转目录解析失败:${e.message}"
        }
        // 第 3 条:落点。第 1 条挡的是**名字**,这一条挡的是**真身在哪**。
        if (canon.parentFile != canonOutbox) return "文件不在备份中转目录里"
        // 第 4 条:`isFile` 对「指向普通文件的 symlink」也回 true ⇒ 另问一次真身 ——
        // 一个不是 symlink 的孩子,规范化之后必然恰是 `<canonOutbox>/<name>`。
        if (canon != File(canonOutbox, name)) return "文件不是普通文件"
        if (!f.isFile) return "文件不在了"
        out[0] = f
        return null
    }

    /** 尺 4 的名字自己也要过闸:⛔ 只许 `verify-*` —— 否则「验完就删」会删掉一份真产物。 */
    fun isFetchLocalName(name: String): Boolean =
        name.startsWith(FETCH_PREFIX) && name.endsWith(ARTIFACT_SUFFIX) &&
            !name.contains('/') && !name.contains(SEP_BACKSLASH)

    /**
     * ⛔⛔ **`putFile` 只许搬 core 自己的产物**(实现审一弹 H-1 的第二半闸)。
     *
     * ⭐ **这条不是重复,它堵的是「两个入口串起来」那条路**:`fetchFile` 会把一份东西落成
     * 壳自己造的 `verify-<ULID>.zjbak`,而那个名字**天然过得了** outbox 的四条校验 ——
     * 于是「先 fetch 一份进来、再 put 出去」就成了一条通用外泄管道。
     * ⇒ `putFile` 的源**必须是 core 那条命名形**(`engine.rs:398` 的
     * `zhujian-<8>-<UTC>-<ULID>.zjbak`),⛔ 并显式拒掉整个 `verify-` 名字空间。
     */
    fun isProductName(name: String): Boolean =
        name.startsWith(PRODUCT_PREFIX) && name.endsWith(ARTIFACT_SUFFIX) &&
            !name.startsWith(FETCH_PREFIX)

    /**
     * 启动清扫认哪些名字(§17.6,照 391 `clearCaptureLeftovers` 那个形:**只认自己那个
     * 命名形,不扫目录里别的东西**)。
     */
    fun isSweepable(name: String): Boolean =
        name.endsWith(ARTIFACT_SUFFIX) &&
            (name.startsWith(PRODUCT_PREFIX) || name.startsWith(FETCH_PREFIX))

    // ---- 在飞记录的收尸(§17.10 启动那四步的第 2 步)-------------------------------------

    /** 一条在飞记录。⛔ 只有一条 —— 它是「当前这一趟」,与产出账(累积)是两样东西。 */
    data class Transfer(
        val transferId: String,
        /** `put` = 把密文搬进用户目录;`fetch` = 把用户的那份拷回来验。 */
        val kind: String,
        val outboxName: String,
        val docId: String?,
        val displayName: String?,
        val state: String,
        val reason: String?,
        /** 还能不能重试 —— ⭐ 判据是「**锚还能不能再生**」,⛔ 不是「跨不跨重启」。 */
        val retryable: Boolean,
    )

    /**
     * 在飞记录里那几个**可空**字段的解码(517)。
     *
     * ⛔⛔ **Android 的 `JSONObject.optString(key, fallback)` 对 JSON `null` 回的不是 fallback,
     * 是字符串 `"null"`** —— `opt()` 拿到的是 `JSONObject.NULL` 这个哨兵对象(非 Java null),
     * 于是 `JSON.toString()` 走 `String.valueOf(it)` = `"null"`,fallback 那条分支根本到不了。
     * 原先那个 `optString(k, "").ifEmpty { null }` 因此**从来没把 null 读回来过**:
     * `docId` 读成 `"null"` ⇒ [isValid] 当场判假(既不是 null、也不以 `content:` 开头)
     * ⇒ `parseRecord` 抛 ⇒ 整条记录读不出来(不是"某一格脏了")。
     *
     * ⇒ 调用方必须把 **`o.isNull(key)`** 一起传进来,那一格才是「这是不是 JSON null」的
     * 权威答案(两套实现语义一致)。
     *
     * ⚠⚠ **这只函数抽出来只有一个理由:让那一刀落得下去**(同 [claim]/[release] 的形)——
     * 单测类路径上的 `org.json` 是**参考实现**,它的 `optString` 对 JSON null **回 fallback**,
     * 与 Android 相反 ⇒ **拿 `parseRecord` 写行为测在这套类路径上是假绿**(517 实测:
     * 未修的代码上那只测照样全绿)。真正能被证伪的判据只有 `optional(true, "null") == null`。
     *
     * @param isNull 调用方问 `JSONObject.isNull(key)` 的答案 —— 键缺席或值是 JSON null 都为真。
     * @param raw    `optString(key, "")` 的读数;⚠ [isNull] 为真时它在 Android 上是 `"null"`。
     */
    fun optional(isNull: Boolean, raw: String): String? =
        if (isNull) null else raw.ifEmpty { null }

    /**
     * 值域校验(实现审一弹 M-3)。⛔ **「键都在」不等于「值合法」** —— 一条 `kind:"potato"`
     * 或空 `transferId` 的记录字段齐全却语义已坏,放它过去,收尸与轮询都会拿它当正常记录。
     */
    fun isValid(t: Transfer): Boolean =
        t.transferId.isNotEmpty() &&
            (t.kind == KIND_PUT || t.kind == KIND_FETCH) &&
            (t.state == STATE_RUNNING || t.state == STATE_DONE || t.state == STATE_FAILED) &&
            t.outboxName.isNotEmpty() &&
            // ⭐ `docId` 有值就必须是 content URI(二弹 M 的纵深):承重的是「拿当前 tree 重建」
            // 那一步,这条只是让一条被改坏的记录**更早**出局。⛔ 别把顺序反过来理解。
            (t.docId == null || t.docId.startsWith("content:"))

    const val KIND_PUT = "put"
    const val KIND_FETCH = "fetch"
    const val STATE_RUNNING = "running"
    const val STATE_DONE = "done"
    const val STATE_FAILED = "failed"

    /**
     * 收尸:进程被杀会让记录**永远停在 `running`**。
     *
     * ⛔ **必须按 `kind` 分支**(codex 五弹 H:一刀切「撤掉重试入口」会把 `fetch` 的合法重建
     * 一起撤掉):
     * - `put` 的锚是 **outbox 里那份我们自己造的密文**,**不可再生**(要 core 重跑一趟才有),
     *   而第 3 步的清扫马上就要删掉它 ⇒ **跨重启不给重试**;
     * - `fetch` 的锚是 **SAF 里那份用户的文件**,**随时可再取** ⇒ 回拷被删掉无所谓,
     *   保留 `docId` 与重验入口。
     *
     * ⛔ **终态也要过一遍,⛔ 别只收 `running`**(实现审一弹 M-2):
     * `put` 在同进程内失败会写成 `failed + retryable=true`(那时源文件还在,重试成立);
     * 可**进程一旦重启,第 3 步的清扫马上就把那个源删掉** —— 记录若原样留着,界面会摆出一颗
     * 点下去必然失败的「再试一次」。⇒ **启动这一刻,`put` 一律不可重试**,与它是不是终态无关。
     * ⚠ `fetch` 相反:它的锚是用户那份文件,终态照旧保留 `docId` 与重验入口。
     *
     * ⭐ 它仍然是幂等的(第二次跑得出同一个结论),这一点没变。
     */
    fun settle(t: Transfer?): Transfer? {
        if (t == null) return null
        if (t.kind == KIND_PUT) {
            // 锚(outbox 里那份密文)这一刻要么已被清扫删掉、要么马上就会被删 ⇒ 一律撤重试。
            val reason = if (t.state == STATE_RUNNING) "上次那趟没跑完" else t.reason
            val state = if (t.state == STATE_RUNNING) STATE_FAILED else t.state
            return if (state == t.state && reason == t.reason && !t.retryable) t
            else t.copy(state = state, reason = reason, retryable = false)
        }
        if (t.state != STATE_RUNNING) return t
        return t.copy(state = STATE_FAILED, reason = "上次验证没做完", retryable = true)
    }

    /**
     * single-flight 的两半(§17.10 的 H-3)。⛔ **`put` 与 `fetch` 共用同一把** ——
     * 不是各一把:两者都在动 outbox,幕⑤ 的回拷若与幕③ 的搬运同时跑,会撞进同一个目录,
     * 并且让「无论成败都删掉回拷」删到别人的东西。
     *
     * ⭐ 抽成两个纯函数只为**让那一刀落得下去**:UI 置灰不是闸(双击 / 事件重入 / 面被重建
     * 都能再进来一趟),真正的闸是这一次 CAS —— 而闸最容易坏成「永远放行」,
     * 那种坏法在屏幕上和正常一模一样。
     */
    fun claim(lock: java.util.concurrent.atomic.AtomicReference<String?>, id: String): Boolean =
        lock.compareAndSet(null, id)

    /** 让出:⛔ 只让得掉**自己**那一趟(拿 CAS 而不是 `set(null)` —— 后者会让一个迟到的
     *  收尾把别人正在跑的那趟解锁)。 */
    fun release(lock: java.util.concurrent.atomic.AtomicReference<String?>, id: String) {
        lock.compareAndSet(id, null)
    }

    /**
     * 同一进程内的重试判定(§17.10):**重试的锚是两样东西** —— 记录里的 `docId`
     * **和** outbox 里那份源文件,少一样就不叫重试。
     *
     * ⇒ 有 `docId` 就**往同一个 `docId` 覆盖写**(⛔ 不再 `createDocument`,否则用户目录里会
     * 攒下 `…(1).zjbak`、`…(2).zjbak` 一串半截货,而 v1 又不给删除入口);没有就新建一份。
     */
    /**
     * ⛔⛔ **第三条锚:那个 `docId` 还属于**当前**这棵 tree 吗**(实现审二弹 M)。
     *
     * 这条正常用户序列成立且**会静默骗人**:①在文件夹 A 里 put,文档建成了、写入失败 ⇒
     * 记录留着 A 的 `docId`;②用户**换成文件夹 B**(`setTree` 只覆盖当前那棵,**不撤销** A 的
     * 持久授权);③重试同一份产物 —— preflight 查的是 B,而覆盖写落在 **A 的旧文档**上
     * ⇒ 界面说成功,而 B 里根本没有备份。⭐ 这属于「备份成功但没落进你正看着的目录」那一族。
     *
     * ⇒ [inCurrentTree] 由壳传进来(它要 `Context`,这里是纯逻辑):把旧 `docId` 拿当前 tree
     * **重建一遍**,重建不出来就**不复用** —— 在 B 里新建一份是安全的那一侧。
     * ⚠ 它顺带堵掉第二件事:一条字段值域合法、`docId` 却被改坏的记录,否则能把任意 URI
     * 喂给 `openOutputStream`。
     */
    fun putTargetDocId(
        last: Transfer?,
        outboxName: String,
        inCurrentTree: (String) -> String?,
    ): String? {
        if (last == null || last.kind != KIND_PUT || !last.retryable) return null
        if (last.outboxName != outboxName) return null
        val raw = last.docId ?: return null
        return inCurrentTree(raw)
    }
}
