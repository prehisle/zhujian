import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// release 签名(L2:签名钥长期保存、versionCode 单调,否则朋友只能卸载重装)。
// keystore.properties 与 jks 都在 git 外:properties 在 gen/android/(模板 .gitignore
// 已忽略),jks 在 C:\Users\sToa\.tauri\(与桌面 updater 私钥同处,一并机器外备份)。
val keystoreProperties = Properties().apply {
    val propFile = rootProject.file("keystore.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// 故障注入的**编译期**开关(backup-plan §17.20 十一:⑬⑮ 点名要「debug 形」的可控注入,
// 1/2/3/6/12 也要一个能停得住的拷贝窗口)。⛔ 判据是**这个文件在不在**,刻意不用环境变量
// —— gradle daemon 会复用旧进程的环境,`System.getenv` 那条会静默给出上一次的答案。
// ⛔ 这个标记文件**刻意不进 .gitignore** —— 它留在工作区时 `git status` 会一直显着它,
// 那就是「别把注入形当成发版形」的提醒。发版构建里(没有该文件)ZJ_FAULT 恒 false,
// 于是 SafFault 的每个 hook 第一行就短路、release 又开着 R8 ⇒ 那些分支是死码。
val zjFault = file("zjfault.enabled").exists()

android {
    compileSdk = 36
    namespace = "app.zhujian.notebook"
    defaultConfig {
        buildConfigField("boolean", "ZJ_FAULT", zjFault.toString())
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.zhujian.notebook"
        // 30(Android 11):core 的 create_space 归位在 Android 用 libc::renameat2
        // (__INTRODUCED_IN(30));minSdk<30 时 .so 动态导入该符号会在旧设备加载即失败。
        // 见 core/src/spaces.rs::publish_no_clobber(codex 二审 019f5b02 高危项)。
        minSdk = 30
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        create("release") {
            keyAlias = keystoreProperties["keyAlias"] as String
            keyPassword = keystoreProperties["keyPassword"] as String
            storeFile = file(keystoreProperties["storeFile"] as String)
            storePassword = keystoreProperties["storePassword"] as String
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // 加密备份的落点(backup-plan §17):SAF tree 的「还写得进去吗」用它问一句
    // (⛔ 不做会在用户目录里留垃圾的"假写探针")。列目录走 DocumentsContract 的
    // 游标,不用它——一次查询比逐个 DocumentFile 便宜一个量级。
    implementation("androidx.documentfile:documentfile:1.0.1")
    // 107 扫码配对(审查抓出的机制性坑):官方 barcode-scanner 插件只带 GMS 版 ML Kit
    // (play-services-mlkit-*,unbundled——识别模型由 Google Play services 托管下发),
    // 国行 vivo 无 GMS,scan() 永不回话(插件 issue #2238 的根因)。补一件 bundled 引擎:
    // 统一架构下 API 类仍来自 play-services 件(本件的 POM 自己就依赖它 18.3.1),
    // 本件 = 离线厚引擎 + dynamite ModuleDescriptor——引擎在场 ML Kit 就地用、不找 GMS;
    // APK 增重 ~6MB(核验:包里有 lib/arm64-v8a/libbarhopper_v3.so = 引擎在场)。
    // ⚠️ 别 exclude play-services 件(API 类在那,剔了 R8 缺类必炸);
    // 也别用 dependencySubstitution/useTarget 替换(换了模块沿用旧产物名去要 aar,恒失败)。
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    testImplementation("junit:junit:4.13.2")
    // ⚠ 单测里 `org.json` 若只有 android.jar 那份**存根**,每一个调用都抛 "Stub!" ——
    // 把真实现放在测试类路径上,`SafStore` 那几只解析/收尸的测才跑得起来
    // (§17.16:能挪进 JVM 单测的每一条都必须挪进来,这一笔最弱的一格就是测试)。
    testImplementation("org.json:json:20231013")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")