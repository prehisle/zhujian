package app.zhujian.notebook

import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * SAF 桥那些闸的 JVM 单测(backup-plan §17.16)。
 *
 * ⭐ **这一笔最弱的一格就是测试**:挑目录那一步是原生 Activity,CDP 够不着(414 那条
 * 只对 `<input type=file>` 成立)⇒ 能挪进这里跑的每一条都必须挪进来,剩下的才交给
 * §17.19 那十条真机。
 *
 * ⚠ 这里跑的是**纯逻辑**(`SafPure`),不碰任何 `android.*` —— 桥面那些要 `Context`
 * 的部分(SharedPreferences / DocumentsContract)不在这只测的覆盖面里,别当它们也测过了。
 */
class SafPureTest {
    @get:Rule
    val tmp = TemporaryFolder()

    // ---- H-1:桥面两个方向都只收裸名 ------------------------------------------------

    private fun outbox(): File = tmp.newFolder("backups")

    private fun resolve(dir: File, name: String): Pair<String?, File?> {
        val holder = arrayOfNulls<File>(1)
        val err = SafPure.resolveOutboxChild(dir, name, holder)
        return Pair(err, holder[0])
    }

    @Test
    fun `正例 —— outbox 里一份真产物过闸`() {
        val dir = outbox()
        val f = File(dir, "zhujian-abcd1234-20260818T000000Z-01JT.zjbak")
        f.writeText("x")
        val (err, got) = resolve(dir, f.name)
        assertNull(err)
        assertEquals(f.canonicalFile, got!!.canonicalFile)
    }

    /**
     * ⛔ **这一条是本案最重的一刀**:规格第一版把 `putFile` 的源敞着 ⇒ JS 侧能把
     * `.backup-staging` 里的**整库明文快照**或 `.backup.json`(**明文钥**)搬进用户目录,
     * §17.3 那条唯一的安全论证被自己的桥打穿。
     */
    @Test
    fun `闸① —— 带路径的名字一律拒,而且那些目标是真实存在的文件`() {
        val root = tmp.root
        val dir = File(root, "backups").apply { mkdirs() }
        // ⭐ **目标必须真实存在**,否则这只测会被「文件不在了」那一支背书成绿 ——
        // 那时它证明的是「这个名字指不到东西」,不是「这条路被闸拦住了」。
        // ⚠ 本轮真栽过:第一版没建这些文件,把分隔符与父目录两条闸一起摘掉**照样全绿**
        // (memory `test-negative-control` 那条「测的是不是我写的那句话」)。
        File(root, "outside.zjbak").writeText("别人的东西")
        File(dir, "sub").mkdirs()
        File(dir, "sub/x.zjbak").writeText("子目录里的")

        for (bad in listOf("../outside.zjbak", "sub/x.zjbak", "..${File.separatorChar}outside.zjbak")) {
            val (err, got) = resolve(dir, bad)
            assertNotNull("该拒(目标真实存在):$bad", err)
            assertNull("拒了就不许交出文件:$bad", got)
        }
    }

    /**
     * H-1 要防的那两样东西**就在隔壁**:`.backup-staging/` 里的整库明文快照与
     * `.backup.json`(明文钥)。⚠ 如实记:这一格今天由**扩展名**那条闸拦下(它们都不是
     * `.zjbak`),⛔ 别把它读成「路径闸在这里被验过了」—— 路径闸的字据在上一只测。
     */
    @Test
    fun `闸①-b —— 明文快照与明文钥一律拒(今天由扩展名那条拦下)`() {
        val root = tmp.root
        val dir = File(root, "backups").apply { mkdirs() }
        val staging = File(root, ".backup-staging").apply { mkdirs() }
        File(staging, "leak.sqlite3").writeText("整库明文")
        File(root, ".backup.json").writeText("明文钥")

        for (bad in listOf("../.backup.json", "../.backup-staging/leak.sqlite3", "..", ".", "")) {
            val (err, got) = resolve(dir, bad)
            assertNotNull("该拒:$bad", err)
            assertNull("拒了就不许交出文件:$bad", got)
        }
    }

    @Test
    fun `闸② —— 扩展名不是 zjbak 一律拒`() {
        val dir = outbox()
        File(dir, "x.bin").writeText("x")
        val (err, _) = resolve(dir, "x.bin")
        assertNotNull(err)
    }

    @Test
    fun `闸③ —— 名字合法但真身在别处(symlink 指出去)也拒`() {
        val dir = outbox()
        val outside = tmp.newFolder("elsewhere")
        val secret = File(outside, "secret.zjbak").apply { writeText("别人的") }
        val link = File(dir, "innocent.zjbak").toPath()
        try {
            Files.createSymbolicLink(link, secret.toPath())
        } catch (e: Exception) {
            // Windows 上建 symlink 要开发者模式/管理员。⚠ **如实记**:这一刀在这台机器上
            // 没落下去,不是它绿了(§17.16 那条「刀没落上与刀被吸收了屏幕上同形」)。
            println("SKIP symlink 刀:这台机器建不了链接(${e.message})")
            return
        }
        val (err, got) = resolve(dir, "innocent.zjbak")
        assertNotNull("symlink 指出 outbox 必须拒", err)
        assertNull(got)
    }

    @Test
    fun `闸④ —— 不是普通文件(目录同名)也拒`() {
        val dir = outbox()
        File(dir, "adir.zjbak").mkdirs()
        val (err, got) = resolve(dir, "adir.zjbak")
        assertNotNull(err)
        assertNull(got)
    }

    // ---- 四把尺:落地名恒由壳自己造 ---------------------------------------------------

    /**
     * 尺 4。⛔ **既不来自请求名、也不来自 provider 的回读名** —— 后者可能已被改成 `.bin`,
     * 而 core 的 `verify_backup` 在真解之前有一道 `.zjbak` 扩展名闸,照回读名落地会让
     * 一份**好备份**在验之前就被拒(§17.4-6,codex 一弹 H-2 逼出来的第四把尺)。
     */
    @Test
    fun `尺4 —— 回拷名恒是 verify-ULID-zjbak 与 provider 给什么名字无关`() {
        val name = SafPure.fetchLocalName(SafPure.ulid())
        assertTrue(name.startsWith("verify-"))
        assertTrue(name.endsWith(".zjbak"))
        assertTrue(SafPure.isFetchLocalName(name))
        // provider 的回读名(被改过扩展名的那一份)⛔ 绝不许当落地名。
        assertFalse(SafPure.isFetchLocalName("zhujian-x-01JT.zjbak (1).bin"))
        assertFalse(SafPure.isFetchLocalName("zhujian-x-01JT.zjbak"))
    }

    @Test
    fun `启动清扫只认自己那两个命名形`() {
        assertTrue(SafPure.isSweepable("zhujian-abcd-20260818T000000Z-01JT.zjbak"))
        assertTrue(SafPure.isSweepable("verify-01JT.zjbak"))
        // ⛔ 用户自己放进来的东西不归我们扫(照 391 `clearCaptureLeftovers` 那条既有纪律)。
        assertFalse(SafPure.isSweepable("家庭账本.zjbak"))
        assertFalse(SafPure.isSweepable("notebook.sqlite3"))
        assertFalse(SafPure.isSweepable("verify-01JT.bin"))
    }

    // ---- 收尸:按 kind 分支 -----------------------------------------------------------

    /** 真实形状的 SAF 文档 URI。⛔ 别用 `doc:1` 那种占位符 —— `isValid` 现在要求 content 形。 */
    private val doc =
        "content://com.android.externalstorage.documents/tree/primary%3ADownload/document/primary%3ADownload%2Fx.zjbak"

    private fun running(kind: String) =
        SafPure.Transfer("01T", kind, "n.zjbak", doc, null, SafPure.STATE_RUNNING, null, true)

    /**
     * ⛔ 一刀切「撤掉重试入口」会把 `fetch` 的合法重建一起撤掉(codex 五弹 H)。
     * 判据是「**锚还能不能再生**」,⛔ 不是「跨不跨重启」:
     * `put` 的锚是 outbox 里那份我们自己造的密文(**不可再生**,清扫马上要删它);
     * `fetch` 的锚是 SAF 里那份用户的文件(**随时可再取**)。
     */
    @Test
    fun `收尸 —— put 撤重试、fetch 保留 docId 与重验入口`() {
        val put = SafPure.settle(running(SafPure.KIND_PUT))!!
        assertEquals(SafPure.STATE_FAILED, put.state)
        assertFalse("put 跨重启不给重试", put.retryable)

        val fetch = SafPure.settle(running(SafPure.KIND_FETCH))!!
        assertEquals(SafPure.STATE_FAILED, fetch.state)
        assertTrue("fetch 的锚可再取,重验入口要留着", fetch.retryable)
        assertEquals(doc, fetch.docId)
    }

    /**
     * ⛔⛔ **终态也要过一遍,别只收 `running`**(实现审一弹 M-2)。
     *
     * `put` 在**同进程内**失败会写成 `failed + retryable=true` —— 那时 outbox 里那份源还在,
     * 重试成立。可**进程一旦重启**,启动第 3 步的清扫马上就把源删掉;记录若原样留着,
     * 界面就会摆出一颗**点下去必然失败**的「再试一次」。
     * ⇒ 启动这一刻,`put` 一律不可重试,与它是不是终态无关。
     */
    @Test
    fun `收尸 —— put 的终态 failed 也要撤掉重试(源马上会被清扫删掉)`() {
        val failedInProcess = running(SafPure.KIND_PUT)
            .copy(state = SafPure.STATE_FAILED, reason = "写不进去", retryable = true)
        val after = SafPure.settle(failedInProcess)!!
        assertEquals(SafPure.STATE_FAILED, after.state)
        assertFalse("跨重启之后那份源已经没了", after.retryable)
        assertEquals("原因不许被改写", "写不进去", after.reason)
    }

    @Test
    fun `收尸是幂等的 —— 第二次跑得出同一个结论`() {
        val once = SafPure.settle(running(SafPure.KIND_PUT))!!
        assertEquals(once, SafPure.settle(once))
        val fetchOnce = SafPure.settle(running(SafPure.KIND_FETCH))!!
        assertEquals(fetchOnce, SafPure.settle(fetchOnce))
        // fetch 的终态**原样不动**(它的锚是用户那份文件,随时可再取)。
        val fetchDone = running(SafPure.KIND_FETCH).copy(state = SafPure.STATE_DONE)
        assertEquals(fetchDone, SafPure.settle(fetchDone))
        assertNull(SafPure.settle(null))
    }

    // ---- 组合面:每个入口自己封住 ≠ 它们的组合封住 --------------------------------------

    /**
     * ⛔⛔ **实现审一弹 H-1 的第二半闸**。`fetchFile` 会把东西落成壳自己造的
     * `verify-<ULID>.zjbak`,而那个名字**天然过得了** outbox 那四条校验 ⇒
     * 「先 fetch 一份进来、再 put 出去」就是一条通用外泄管道。
     * ⇒ `putFile` 的源必须是 **core 的产物名**,并**显式拒掉整个 `verify-` 名字空间**。
     */
    @Test
    fun `putFile 只许搬 core 的产物,⛔ 拒掉 verify- 名字空间`() {
        assertTrue(SafPure.isProductName("zhujian-abcd1234-20260818T000000Z-01JT.zjbak"))
        // ⭐ 这一条就是那条管道的出口 —— 它必须关着。
        assertFalse("回拷进来的东西不许再被搬出去", SafPure.isProductName("verify-01JT.zjbak"))
        assertFalse(SafPure.isProductName("家庭账本.zjbak"))
        assertFalse(SafPure.isProductName("zhujian-x.bin"))
    }

    // ---- 列表:两个上界是两件事 -------------------------------------------------------

    private fun row(ms: Long, name: String) = SafPure.Row("doc-$name", name, 1, ms, false)

    /**
     * ⛔⛔ **「最近 200 个」必须真的是最近的,而且内存不许由目录规模说了算**
     * (实现审弹 2 M-3 + 它复核轮那条 M,**同一格连打两轮**)。
     *
     * 一弹前:按 provider 游标顺序取前 200 ⇒ 那句「只显示最近的」**无依据**;
     * 我改成「全收进 ArrayList 再排序」⇒ 排序对了,可**内存与工作量当场变成 O(目录规模)**。
     * ⇒ 现在是流式 top-K:**内存恒为 k**,顺序仍是「新在前、名字兜底求稳定」。
     */
    @Test
    fun `列表 top-K —— 留下的恒是最近的 k 个,内存不随候选数长`() {
        val top = SafPure.TopK(3)
        // 故意乱序喂,并且「最新的那个」放在最后 —— 按游标顺序取前 3 会漏掉它。
        for (r in listOf(row(10, "a"), row(50, "b"), row(20, "c"), row(40, "d"), row(90, "z"))) {
            top.offer(r)
        }
        assertEquals(listOf("z", "b", "d"), top.sorted().map { it.name })
        assertTrue("候选比 k 多 ⇒ 要如实说截断了", top.truncated())
        assertEquals(5, top.candidates)
    }

    @Test
    fun `列表 top-K —— 同一时刻按名字定序(顺序必须稳定,否则每次刷新换个样)`() {
        val top = SafPure.TopK(2)
        for (r in listOf(row(7, "b"), row(7, "a"), row(7, "c"))) top.offer(r)
        assertEquals(listOf("a", "b"), top.sorted().map { it.name })
    }

    /**
     * ⛔ **同名 + 同 mtime 的两份不同文档跨在 k 的边界上**(实现审弹 2 三复核的 L)。
     *
     * 那时留谁,若只按 `ms`/`name` 比就由 **provider 的游标顺序**说了算 —— 「顺序稳定」
     * 这句话按字面就不成立(provider 换个顺序,刷新一次结果就变)。`docId` 是这条路上
     * **唯一稳定且唯一**的键。⭐ 判据里那句「再以不同喂入顺序重复一次,结果必须相同」
     * 才是它真正要证的东西。
     */
    @Test
    fun `列表 top-K —— 同名同时刻时按 docId 定序,与喂入顺序无关`() {
        val a = SafPure.Row("doc-A", "same.zjbak", 1, 100, false)
        val b = SafPure.Row("doc-B", "same.zjbak", 1, 100, false)
        val one = SafPure.TopK(1).apply { offer(a); offer(b) }
        val two = SafPure.TopK(1).apply { offer(b); offer(a) }
        assertEquals(listOf("doc-A"), one.sorted().map { it.docId })
        assertEquals("换个喂入顺序必须得出同一个结果", one.sorted(), two.sorted())
    }

    @Test
    fun `列表 top-K —— 候选没到 k 就不算截断`() {
        val top = SafPure.TopK(200)
        top.offer(row(1, "only.zjbak"))
        assertFalse(top.truncated())
        assertEquals(listOf("only.zjbak"), top.sorted().map { it.name })
    }

    /** 值域校验:键都在 ≠ 值合法(实现审一弹 M-3)。 */
    @Test
    fun `在飞记录的值域不合法就该被当成损坏`() {
        val ok = running(SafPure.KIND_PUT)
        assertTrue(SafPure.isValid(ok))
        assertFalse(SafPure.isValid(ok.copy(kind = "potato")))
        assertFalse(SafPure.isValid(ok.copy(state = "halfway")))
        assertFalse(SafPure.isValid(ok.copy(transferId = "")))
        assertFalse(SafPure.isValid(ok.copy(outboxName = "")))
        // `docId` 有值就必须是 content URI —— ⛔ 一条被改成 `file://…` 的记录不许进到
        // `openOutputStream` 跟前(二弹 M 的纵深;承重的仍是「拿当前 tree 重建」那一步)。
        assertFalse(SafPure.isValid(ok.copy(docId = "file:///data/user/0/app.zhujian.notebook/.backup.json")))
        assertTrue(SafPure.isValid(ok.copy(docId = null)))
    }

    // ---- 重试:同一个 docId 覆盖写 ----------------------------------------------------

    /**
     * ⛔ 有 `docId` 就往同一个覆盖写,**不再 `createDocument`** —— 否则用户目录里会攒下
     * `…(1).zjbak`、`…(2).zjbak` 一串半截货,而 v1 又不给删除入口。
     */
    /** 当前 tree 认得出旧 docId 的那种情形(壳侧真身是 `docInCurrentTree`)。 */
    private val sameTree: (String) -> String? = { it }

    @Test
    fun `重试 —— 同名且可重试才复用 docId`() {
        val failed = running(SafPure.KIND_PUT).copy(state = SafPure.STATE_FAILED)
        assertEquals(doc, SafPure.putTargetDocId(failed, "n.zjbak", sameTree))
        // 收尸过的(跨重启)⇒ 不复用,重新点「立即备份」跑一趟**新的** core 备份。
        assertNull(SafPure.putTargetDocId(failed.copy(retryable = false), "n.zjbak", sameTree))
        // 换了一份产物 ⇒ 那个 docId 与它无关。
        assertNull(SafPure.putTargetDocId(failed, "other.zjbak", sameTree))
        // fetch 的记录不喂给 put。
        assertNull(SafPure.putTargetDocId(failed.copy(kind = SafPure.KIND_FETCH), "n.zjbak", sameTree))
        assertNull(SafPure.putTargetDocId(null, "n.zjbak", sameTree))
    }

    /**
     * ⛔⛔ **换过文件夹之后不许复用旧 `docId`**(实现审二弹 M)。
     *
     * 那条正常序列会**静默骗人**:在 A 里 put 失败留下 A 的 `docId` → 用户换成 B
     *(旧授权**不会**被撤销)→ 重试覆盖写的是 **A 的旧文档**,而界面照说成功、B 里什么都没有。
     */
    @Test
    fun `重试 —— 换了文件夹之后旧 docId 一律不复用`() {
        val failed = running(SafPure.KIND_PUT).copy(state = SafPure.STATE_FAILED)
        val otherTree: (String) -> String? = { null } // 当前 tree 重建不出来
        assertNull(
            "换了 tree 还复用 = 备份说成功却落进旧文件夹",
            SafPure.putTargetDocId(failed, "n.zjbak", otherTree),
        )
        // ⭐ 复用的恒是**重建后**那个值,不是记录里那个字符串。
        assertEquals(
            "rebuilt",
            SafPure.putTargetDocId(failed, "n.zjbak") { "rebuilt" },
        )
    }

    // ---- single-flight:put 与 fetch 共用同一把 ---------------------------------------

    /**
     * ⛔ **UI 置灰不是闸**(codex 一弹 H-3):`BackupCoordinator` 在 `run_backup()` 返回那一刻
     * 就把准入还回去了,而拷贝还在跑;双击 / 事件重入 / 面被重建都能再进来一趟。
     */
    @Test
    fun `single-flight —— 第二趟拿不到锁 而且两种 kind 共用一把`() {
        val lock = AtomicReference<String?>(null)
        assertTrue(SafPure.claim(lock, "A"))
        assertFalse("第二趟(哪怕是另一种 kind)必须被挡住", SafPure.claim(lock, "B"))
        // ⛔ 迟到的收尾只让得掉自己那一趟。
        SafPure.release(lock, "B")
        assertFalse("别人的 release 不许把 A 解锁", SafPure.claim(lock, "C"))
        SafPure.release(lock, "A")
        assertTrue(SafPure.claim(lock, "C"))
    }

    // ---- 可空字段的解码:Android 的 optString 对 JSON null 回的是字符串 "null" ----------

    /**
     * ⭐ **这一刀是这条账里唯一能被证伪的那把**(517)。
     *
     * Android 的 `optString(k, fallback)` 对 JSON `null` 回的是**字符串 `"null"`**(不是
     * fallback)⇒ 老写法 `optString(k,"").ifEmpty{null}` 把 `docId` 读成 `"null"`,
     * [SafPure.isValid] 当场判假 ⇒ `parseRecord` 抛 ⇒ **整条记录读不出来**。
     *
     * ⚠⚠ **别改写成「拿 `parseRecord` 喂一段 JSON」的形** —— 单测类路径上的 `org.json` 是
     * **参考实现**,它的 `optString` 对 JSON null **回 fallback**(517 当场实测:
     * `optString("docId","")` = `[]`,而未修的 `parseRecord` 照样答 `docId = null`)
     * ⇒ 那种写法在**未修的代码上就是绿的** = 假绿。承重的判据只有下面第一句。
     */
    @Test
    fun `可空字段 —— JSON null 恒解成 null(哪怕读数是字符串 "null")`() {
        // ⭐ 承重的那一句:Android 上 isNull=true 时 raw 恰恰就是 "null"。
        assertNull("这一句红 = isNull 那一格被忽略了", SafPure.optional(true, "null"))
        assertNull(SafPure.optional(true, ""))
        // 键缺席与值为 JSON null 在 isNull 上同答案,处置也同。
        assertNull(SafPure.optional(true, "content:whatever"))
        // ⛔ 反面同样要钉住:**真有值的时候一个字都不许丢**。
        assertEquals("content:x/y", SafPure.optional(false, "content:x/y"))
        // ⛔ 「null」当成真实显示名时不许被吞掉 —— 这正是「把 "null" 当哨兵」那种错修法的靶子。
        assertEquals("null", SafPure.optional(false, "null"))
        assertNull("空串照旧当没有", SafPure.optional(false, ""))
    }

    /**
     * 接线锚(517):上面那把刀只管得了 [SafPure.optional] 自己,**管不到「`parseRecord`
     * 有没有真去问 `isNull`」** —— 而那正是这次的病灶所在,且行为测在这套类路径上假绿。
     *
     * ⇒ 这里守的是**接线事实**(memory `text-anchor-cannot-guard-a-type` 那条正例):
     * `parseRecord` 体内不许再出现 `optString`。⛔ 锚里只留稳定标识符(函数名 / 方法名),
     * 不含任何会被改名的可见文案(515 的教训)。
     */
    @Test
    fun `接线锚 —— parseRecord 里不许直接用 optString`() {
        val src = safKtSource()
        val from = src.indexOf("fun parseRecord(")
        assertTrue("锚落不上:Saf.kt 里找不到 parseRecord", from >= 0)
        // 到下一个同缩进的成员为止 = parseRecord 的函数体。
        val rest = src.substring(from)
        val end = rest.indexOf("\n    fun ", 1).let { if (it < 0) rest.length else it }
        val body = rest.substring(0, end)
        assertFalse(
            "parseRecord 又直接读 optString 了 —— Android 那只对 JSON null 回字符串 \"null\"," +
                "docId 会被 isValid 判假、整条记录读不出来。走 optionalField / SafPure.optional。",
            body.contains("optString"),
        )
        assertTrue("三个可空字段都该走同一只 helper", body.contains("optionalField(o, \"docId\")"))
        assertTrue(body.contains("optionalField(o, \"displayName\")"))
        assertTrue(body.contains("optionalField(o, \"reason\")"))
    }

    /** ⛔ 找不到就**响亮红**,不许当成「这条没什么可查的」悄悄绿过去。 */
    private fun safKtSource(): String {
        val rel = "src/main/java/app/zhujian/notebook/Saf.kt"
        val tried = listOf(File(rel), File("app/$rel"), File("../app/$rel"))
        for (f in tried) if (f.isFile) return f.readText()
        throw AssertionError("读不到 Saf.kt,锚无从落下(试过:${tried.map { it.absolutePath }})")
    }

    // ---- transferId:永不复用 ---------------------------------------------------------

    @Test
    fun `transferId 是 26 位 Crockford ULID 且不重样`() {
        val ids = (1..500).map { SafPure.ulid() }.toSet()
        assertEquals("永不复用", 500, ids.size)
        for (id in ids) {
            assertEquals(26, id.length)
            assertTrue(id.all { it in "0123456789ABCDEFGHJKMNPQRSTVWXYZ" })
        }
        // 时间在前 ⇒ 同一毫秒之后生成的排在后面(只作弱断言:身份靠随机位,顺序不承重)。
        assertTrue(SafPure.ulid(1L) < SafPure.ulid(2L).take(10) + "ZZZZZZZZZZZZZZZZ")
    }
}
