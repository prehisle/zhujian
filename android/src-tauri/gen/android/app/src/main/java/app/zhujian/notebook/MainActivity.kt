package app.zhujian.notebook

import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    webView.addJavascriptInterface(SystemBars(), "__zhujianSystemBars")
    // 加密备份的 SAF 桥(backup-plan §17)。⛔ 这里只**新建一只桥并指向进程级单例**
    // (`SafState`)——`onWebViewCreate` 会在 Activity 重建时再跑一遍,而 single-flight
    // 那把锁与后台 worker 若跟着新桥实例走,旧的那趟拷贝还在跑、新桥却又放行一趟。
    webView.addJavascriptInterface(SafBridge(this), "__zhujianSaf")
    // 界面字号(251):基准取 WebView 创建时的初始 textZoom——它已含系统「字体大小」
    // 的放大,我们的百分比乘在上面、不覆盖用户的系统级选择。
    webView.addJavascriptInterface(TextSize(webView.settings.textZoom), "__zhujianTextSize")
  }

  // 明暗三档(250)的原生半截。页面里换色换不动**系统状态栏/导航栏的图标颜色**:用户手动
  // 锁「暗」而系统仍是浅色时,系统仍按浅底把时间/信号画成深色,顶在深色纸面上几乎看不见
  // (真机截图取证)。开一条极窄的 JS→原生桥,只做这一件事:按当前生效色翻两条 appearance
  // 位。WebView 只加载打包进 APK 的本地资源,桥面仅此一个布尔入口。
  inner class SystemBars {
    @android.webkit.JavascriptInterface
    fun setDark(dark: Boolean) {
      runOnUiThread {
        val c = androidx.core.view.WindowInsetsControllerCompat(window, window.decorView)
        c.isAppearanceLightStatusBars = !dark // 深色纸面 → 浅色图标
        c.isAppearanceLightNavigationBars = !dark
      }
    }
  }

  // 界面字号(251)的原生半截。wry 0.55.1 的安卓 zoom() 是空实现(返回 Ok 什么都不做),
  // 桌面 241 的 setZoom 路在这里静默失效;WebView 自带的 textZoom 才是平台正道——只放大
  // 文字、布局自然回流,不改 px 坐标系(240 捕获层 / 226 大图手势的几何计算零影响)。
  // 桥面仅此一个整数入口;档位表在 JS 侧(textsize.ts),这里只做范围理智校验,出格
  // 直接不理(不 clamp 半应用)。
  inner class TextSize(private val base: Int) {
    @android.webkit.JavascriptInterface
    fun set(percent: Int) {
      if (percent < 50 || percent > 200) return
      runOnUiThread { webView?.settings?.textZoom = base * percent / 100 }
    }
  }

  // 146:返回键层账本的 Kotlin 半截。真机取证(vivo/Android 16,keyevent 4 + CDP 探针):
  // TauriActivity 默认 handleBackNavigation=false 使 wry 那层从未注册;而且就算注册了
  // 也没用——**WebView.canGoBack() 对 pushState 同文档守门条目返回 false**(CDP
  // Page.getNavigationHistory 明明有 2 条),wry 的「有历史先 goBack」在此天生失效。
  // 故判定交给 JS 账本(main.ts 的 histDepth,单一真相源):有层 → 页内 history.back()
  // (走已验证的 popstate 关层路);无层/页面没应答 → 系统默认路退 app。
  // WebView 引用兜底从视图树现找(setWebView/onWebViewCreate 在本机取证中从未被调,
  // 决不允许因此吞掉返回键)。配套 manifest enableOnBackInvokedCallback=false
  // (targetSdk 35+ 新系统默认 predictive back,legacy 按键派发不保证进 dispatcher)。
  private fun findWebView(v: android.view.View): WebView? {
    if (v is WebView) return v
    if (v is android.view.ViewGroup) {
      for (i in 0 until v.childCount) {
        findWebView(v.getChildAt(i))?.let { return it }
      }
    }
    return null
  }

  // 391 拍照的临时文件收尾。wry 那侧把 ACTION_IMAGE_CAPTURE 的输出写成
  // getExternalFilesDir(Pictures)/JPEG_<时间戳>_*.jpg 交给相机 app,回传后**从不删**:
  // 字节此刻已经被前端读走进了 E2EE 库,留下的这份是纯中转垃圾,拍多了白占几十 MB
  // (%TEMP% 堆爆同族的账,别再让它长)。启动即清——这一刻不可能有在飞的拍照(进程若
  // 在相机期间被杀,那次的 filePathCallback 也随之没了,那张本就是废的)。只认 wry 那
  // 个命名形,不扫目录里别的东西;几十个小文件的 delete 是微秒级,不值得为它开线程。
  private fun clearCaptureLeftovers() {
    val dir = getExternalFilesDir(android.os.Environment.DIRECTORY_PICTURES) ?: return
    runCatching {
      dir.listFiles { f -> f.isFile && f.name.startsWith("JPEG_") && f.name.endsWith(".jpg") }
        ?.forEach { it.delete() }
    }
  }

  // 加密备份(§17)挑落点那条路:`ACTION_OPEN_DOCUMENT_TREE` 起的是**真原生 Activity**
  // (⛔ 414 那条 CDP 拦截只对 `<input type=file>` 成立,这条 CDP 够不着 —— 这一笔最弱的
  // 一格就在这儿,§17.16 已记档别假装它有回归网)。
  // ⚠ 注册必须在 STARTED 之前 ⇒ 放在 onCreate 里(与 wry 自己那两个 launcher 同期)。
  private var treePicker: androidx.activity.result.ActivityResultLauncher<Intent>? = null

  fun launchTreePicker() {
    val l = treePicker
    if (l == null) {
      SafBridgeResolve.fail(this, "这台设备上打不开文件夹选择器")
      return
    }
    runCatching { l.launch(openDocumentTreeIntent()) }
      .onFailure { SafBridgeResolve.fail(this, "打不开文件夹选择器:${it.message}") }
  }

  /** 桥的应答口(`evaluateJavascript` 必须在 UI 线程上;WebView 没就绪就自然丢掉——
   *  ⛔ 回调本来就不是真相源,面每次打开都会重新问一次状态)。 */
  fun evalInWebView(js: String) {
    webView?.evaluateJavascript(js, null)
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // 故障注入的旋钮:只在**编译期开了 ZJ_FAULT** 的验收包里有效,且只从启动 Intent 读一次
    // (⛔ 桥面不新增入口)。发版包里 [SafFault] 的每个 hook 第一行就短路。
    SafFault.configure(intent)
    clearCaptureLeftovers()
    // 备份中转区的启动四步(§17.10):**先读**在飞记录 → 按 kind 收尸 → 再清扫 outbox →
    // 最后落两个健康位。⛔ 顺序不许换:清扫在读之前,就把「上次那趟干到哪儿了」删没了。
    SafStore.startupSettle(this)
    stashSharedText(intent) // 冷启动:分享拉起进程,先落文件再起 WebView。
    stashDeepLink(intent) // 冷启动:深链接拉起进程,同样先落文件(前端 take_deep_link 取走)。
    super.onCreate(savedInstanceState)
    treePicker = registerForActivityResult(
      androidx.activity.result.contract.ActivityResultContracts.StartActivityForResult()
    ) { result -> SafBridgeResolve.picked(this, result.data?.data) }
    onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
      // single-flight(codex 补审 M3):JS 应答/超时未归前,重复返回丢弃(JS 侧对
      // back 在飞另有合并,这里挡的是「应答窗口内的连按」);应答与超时用 CAS 决出
      // 唯一赢家——renderer 卡死/回调永不到时,超时走默认返回,绝不把用户困在 app 里。
      private var inFlight = false

      override fun handleOnBackPressed() {
        val wv = webView ?: findWebView(window.decorView.rootView)?.also { webView = it }
        if (wv == null) {
          fallthrough()
          return
        }
        if (inFlight) return
        inFlight = true
        val done = java.util.concurrent.atomic.AtomicBoolean(false)
        // 问页内原子入口:true=页面已消费(关层/收扫码/合并);false/null/异常=无层,
        // 放行退出(fail-open 到「能退出 app」侧)。
        wv.evaluateJavascript(
          "window.__zhujianHandleBack?window.__zhujianHandleBack():false"
        ) { consumed ->
          if (done.compareAndSet(false, true)) {
            inFlight = false
            if (consumed != "true") fallthrough()
          }
        }
        wv.postDelayed({
          if (done.compareAndSet(false, true)) {
            inFlight = false
            fallthrough() // JS 无应答:超时放行默认返回
          }
        }, 500)
      }

      private fun fallthrough() {
        isEnabled = false
        onBackPressedDispatcher.onBackPressed()
        isEnabled = true
      }
    })
  }

  override fun onNewIntent(intent: Intent) {
    stashSharedText(intent) // 热启动(singleTask):先落文件,再让 tauri 插件链看 intent。
    stashDeepLink(intent) // 热启动:深链接同样先落文件。
    super.onNewIntent(intent)
    // 活动可能全程前台收到分享/深链接(不触发 visibilitychange):补一记事件戳。
    // WebView 没就绪/事件丢了都无妨——文件才是真相源,回前台或下次启动照样取走。
    webView?.evaluateJavascript("window.dispatchEvent(new Event('zhujian-share'))", null)
    webView?.evaluateJavascript("window.dispatchEvent(new Event('zhujian-deeplink'))", null)
  }

  // M4 薄桥(android-plan §7):ACTION_SEND 的 EXTRA_TEXT 原生侧暂存成文件,前端经
  // take_shared_text 一次性取走——事件桥会在「WebView 尚未监听」时把分享静默丢掉,
  // 文件不会。只暂存、不入库;上限 200 KiB(预填是给人看的,不是数据面)。
  // 目录用 dataDir:tauri 的 app_data_dir 在安卓解析为 getDataDir(PathPlugin,
  // 已核 tauri 2.11.5),两侧必须同一目录,别改成 filesDir。
  private fun stashSharedText(intent: Intent?) {
    if (intent?.action != Intent.ACTION_SEND) return
    // manifest 只收 text/plain;带参数形态(text/plain;charset=…)也认。这里是
    // 契约校验不是安全边界(显式 Intent 本就能伪造 MIME),null 从宽。
    val mime = intent.type
    if (mime != null && !mime.startsWith("text/plain")) return
    // 标准类型是 CharSequence(SpannedString 等富文本也合法),取字符串形态。
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() }
      ?: return
    val tmp = File(dataDir, "shared_text.pending.tmp")
    tmp.writeBytes(utf8Truncate(text, 200 * 1024))
    // tmp + rename 原子落位:取走端读不到半截文件;rename 失败别留垃圾。
    if (!tmp.renameTo(File(dataDir, "shared_text.pending"))) tmp.delete()
  }

  // 4c 深链接薄桥:ACTION_VIEW 的 zhujian:// URI 原生侧暂存成文件,前端 take_deep_link
  // 一次性取走(与分享同理:事件桥会在 WebView 未监听时把它丢掉,文件不会)。只暂存不
  // 入库;URI 短,给个宽松上限。目录同 dataDir(与 take_deep_link 的 app_data_dir 同址)。
  private fun stashDeepLink(intent: Intent?) {
    if (intent?.action != Intent.ACTION_VIEW) return
    val uri = intent.data ?: return
    if (uri.scheme != "zhujian") return // 契约校验(intent-filter 已按 scheme 过滤,双保险)
    val tmp = File(dataDir, "deep_link.pending.tmp")
    tmp.writeBytes(utf8Truncate(uri.toString(), 8 * 1024))
    if (!tmp.renameTo(File(dataDir, "deep_link.pending"))) tmp.delete()
  }

  // 截断只许落在 UTF-8 码点边界:回退跳过续字节(10xxxxxx),再把切剩的首字节去掉,
  // 否则 Rust 侧 read_to_string 会把整份暂存判成非法 UTF-8。
  private fun utf8Truncate(text: String, cap: Int): ByteArray {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size <= cap) return bytes
    var end = cap
    while (end > 0 && (bytes[end].toInt() and 0xC0) == 0x80) end--
    return bytes.copyOf(end)
  }
}
