# 安卓应用

`android/` 是卫戍协议的安卓应用：一个全屏横屏的 WebView，打开所选服务器的网页，游戏素材从 APK 里读取。和浏览器相比：

- **没有地址栏和标签栏**：Firefox 等浏览器「添加到主屏幕」后仍会显示标签栏，应用始终全屏（状态栏和导航栏隐藏，从屏幕边缘滑动临时显示；和 Chrome 一样在摄像头挖孔那一侧留边），游戏时屏幕常亮。
- **自带全部素材**：图片、Spine 模型、音频和字体（服务器 `/resource-manifest.json` 列出的全部文件，约 430 MB）打包在 APK 里，第一次进游戏不用下载。
- **不需要自己开服务器**：游戏代码和数据每次从所选服务器加载，应用运行的总是服务器当前的版本，联机也走这个服务器。

需要 Android 8.0（API 26）以上，以及支持 WebGL 的 Android System WebView（Chrome 内核，系统自带并随应用商店更新）。

## 选择服务器

第一次打开时选择服务器：

| 选项 | 地址 |
|---|---|
| 晴猫的服务器（默认，第一项） | `https://stronghold.lunar.ag` |
| 卫.rinko.ai | `https://xn--rlr.rinko.ai` |
| 其他服务器… | 手动输入，例如 `https://example.com` 或局域网的 `http://192.168.1.10:3000`（允许 http） |

之后按**返回键**打开菜单：重新载入、切换服务器、退出、继续游戏。无法连接时也可以在提示里重试或切换服务器。每个服务器的账号、设置和存档各自独立（和浏览器里不同网站一样）。

## 素材怎么用

`BundledAssets.java` 拦截页面对所选服务器 `/assets/…`、`/fonts/…` 的 GET 请求，以及客户端播放音频用的无扩展名路径 `/media/…`（对应 `/assets/audio/…`，见 `shared/media.js`）。打开服务器时应用读取它的 `/resource-manifest.json`：

- 服务器列出的 SHA-256 与 APK 里的文件相同 → 从 APK 读取；
- 服务器改过或新增的文件 → 照常从网络下载（和浏览器一样走 HTTP 缓存），不需要重装应用；
- 服务器没有资源清单（例如没生成清单的 Node 服务器）或 4 秒内没取到 → 直接用 APK 里的文件。

游戏代码（`/js`、`/vendor`）、数据、页面和联机请求都不拦截。

网页通过 user agent 末尾的 `StrongholdApp/<版本>`（APK 带素材时再加 ` bundled`）识别应用（`public/js/appShell.js`）：

- 视为已安装的全屏应用：不显示「安装」和「全屏」按钮（`ui/device.js`：`standalone` 为真、`fullscreen` 为假）；
- 带素材时不弹「资源管理」的下载对话框，也不注册缓存素材的 service worker（`resources/index.js`）。

## 构建

需要 Node.js 22+、JDK 17+、Android SDK（Platform 35、Build-Tools 35）和 Gradle（仓库带 Gradle Wrapper）。SDK 位置用环境变量 `ANDROID_HOME` 或 `android/local.properties` 的 `sdk.dir` 指定。

```bash
npm run android:assets            # 素材写入 android/app/src/main/assets/game/（约 430 MB）
cd android
./gradlew assembleRelease         # → app/build/outputs/apk/release/app-release.apk
```

`tools/build-android.mjs` 按服务器的 `/resource-manifest.json` 收集文件：本地 `public/` 里大小和 SHA-256 都一致的文件直接硬链接（或复制），其余从服务器下载并校验，最后写一份 `manifest.json` 记录打包了哪些文件。选项：

- `--server=https://…`：从哪个服务器取清单和素材，默认 `https://stronghold.lunar.ag`；
- `--lite`：不打包素材，得到一个几十 KB、全部从网络加载的 APK，用来快速试应用本身。

素材目录和构建输出都在 `.gitignore` 里，不进仓库。

版本号跟随游戏：`versionName` 取 `package.json` 的 `version`，`versionCode` 为 `主×10000 + 次×100 + 修订`（0.1.3 → 103），可用环境变量 `STRONGHOLD_VERSION_CODE` 覆盖。新版本的 `versionCode` 必须比旧版本大，安卓才会当作更新安装。

## 签名

正式发布的 APK 要用同一把密钥签名，否则玩家无法覆盖安装更新（只能先卸载，会丢失应用里的本地数据）。生成一次密钥并妥善保存：

```bash
keytool -genkeypair -v -keystore stronghold-release.jks -alias stronghold -keyalg RSA -keysize 4096 -validity 36500
```

构建时用环境变量或 `~/.gradle/gradle.properties` 提供（不要写进仓库里的 `android/gradle.properties`）：

| 变量 | 内容 |
|---|---|
| `STRONGHOLD_KEYSTORE` | 密钥库文件路径 |
| `STRONGHOLD_KEYSTORE_PASSWORD` | 密钥库密码 |
| `STRONGHOLD_KEY_ALIAS` | 密钥别名（上例为 `stronghold`） |
| `STRONGHOLD_KEY_PASSWORD` | 密钥密码 |

没有提供时 release APK 用调试密钥签名：可以安装试用，但之后无法被正式签名的 APK 覆盖更新。

## 发布（GitHub Actions）

`.github/workflows/android.yml`：

- **发布 Release 时**（Releases → Draft a new release → Publish）自动构建，把 `stronghold-protocol-<版本>.apk` 上传到这个 Release；
- **手动运行**（Actions → Android → Run workflow）构建一次，APK 作为 Actions 的 artifact 下载，可以指定素材来源服务器。

在仓库的 Settings → Secrets and variables → Actions 添加签名用的 secrets（没有时用调试密钥签名，见上节）：

| Secret | 内容 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 密钥库文件的 base64（`base64 -w0 stronghold-release.jks`） |
| `ANDROID_KEYSTORE_PASSWORD` | 密钥库密码 |
| `ANDROID_KEY_ALIAS` | 密钥别名 |
| `ANDROID_KEY_PASSWORD` | 密钥密码 |

CI 里没有本地素材，全部约 9000 个文件从服务器下载。

APK 超过 Google Play 对单个 APK / 基础模块 200 MB 的限制，只用于 GitHub Releases 等渠道直接安装；上架 Play 需要改成 Play Asset Delivery。

## 代码

| 文件 | 作用 |
|---|---|
| `android/app/src/main/java/ag/lunar/stronghold/MainActivity.java` | 全屏 WebView（避开挖孔）、选择服务器、返回键菜单、连接失败提示 |
| `android/app/src/main/java/ag/lunar/stronghold/BundledAssets.java` | 用 APK 里的素材回答请求，按服务器的资源清单核对 |
| `android/app/build.gradle` | 版本号、签名 |
| `tools/build-android.mjs` | 收集素材（`npm run android:assets`） |
| `public/js/appShell.js` | 网页识别应用 |

应用不依赖 AndroidX，只用系统 API；调试版可以用电脑上 Chrome 的 `chrome://inspect` 调试页面。
