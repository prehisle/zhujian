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

android {
    compileSdk = 36
    namespace = "app.zhujian.notebook"
    defaultConfig {
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
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")