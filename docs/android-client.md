# Astering Android 客户端

Android 客户端基于 Vikunja 改造而来的 Astering 网站，提供系统 WebView 界面、个人笔记原生麦克风服务与可选设备本地识别。首次启动先显示原生服务器配置页，**地址输入框为空，没有预设站点或连接回退地址**。用户手动填写并确认自己的 Astering HTTPS 根地址后，应用才加载该站点；升级预设地址的旧版也会先要求填写。登录及页面首次加载仍需要网络和所选站点的账户。已经打开的笔记可使用内置模型在断网时继续识别，文字加密暂存后补传；这不表示整个网站已经支持断网冷启动。页面来自线上 SPA，因此网页界面更新不需要重新安装 APK；原生权限、服务、识别模型和桥接代码变更仍需安装新版 APK。

从 `.68` 起，客户端只内置识别运行库、小型 VAD 和许可证，**大型语音识别权重按需下载，不随 APK 全部安装**。在头像菜单 → 客户端设置 → 离线模型管理中，下载并选择 SenseVoice、X-ASR 或 Qwen3-ASR。文件通过固定版本、大小与 SHA-256 校验后才可使用；支持暂停、续传和明确确认后删除。模型文件属于设备，多个账户共用，私人文字仍按服务器和账户隔离。从旧版升级需要先下载一次所选模型，不自动消耗流量。详细来源、体积和实测边界见[本地语音识别](offline-asr.md)。

## 服务器选择与发布

APK **只发布到 [GitHub Release](https://github.com/KanameMadoka520/Astering/releases)**，业务网站不托管安装包，也不提供 APK 下载代理。不能为了下载方便恢复旧的站点 `/downloads/` 安装包。旧版 `.64`、`.65` 的预设站点 APK 已撤回，服务端及源码产物继续保留。

服务器设置接受 HTTPS 根地址；不要填写登录页、API 路径、用户名密码、查询参数或片段。地址规范化后显示将要连接的服务器，再由用户确认。应用不会扫描局域网、自动发现站点或在填写之前连接维护者的服务器。外链仍交系统浏览器。

更换服务器是明确的原生操作：撤销旧会话、停止旧录音与同步，清理旧 WebView 登录状态和网页存储后重新加载。待同步文字以服务器和账户共同隔离；另一服务器恰好使用相同的用户 ID 或 SID，也不能读取或上传原服务器的文字。更换站点不会删除服务器上的笔记。

旧版只按账户保存的待同步文字不自动归属新服务器，也不直接丢弃。只有用户手动选择原服务器、服务器验证当前账户身份，并在独立恢复提示中确认后，才能迁移旧版待同步文字；未确认时原件保留，不上传到任意新地址。原域名仅用于核验旧格式迁移目的地，不作为服务器默认值。

## 客户端入口与页面空间

正常页面不额外显示原生服务器地址和设置栏，完整高度交给网页。横竖屏、窗口尺寸与键盘配置变化保留现有 WebView，仅重新排布；不承诺进程被系统回收后恢复未保存输入。登录后打开头像的账户菜单 →「客户端设置」，即可查看当前服务器与客户端版本、更换服务器、检查更新及处理旧版待同步文字；手机阿罗娜页面使用现有导航抽屉中的账户菜单。网页先通过原生能力握手确认支持，普通浏览器和旧客户端不会显示点了无反应的入口。

连接旧版网站、尚未登录或页面无法正常加载时，可在系统桌面**长按 Astering 图标 →「客户端设置」**；页面加载失败时也提供原生设置按钮。打开设置本身不会刷新网页、切换服务器或丢弃输入草稿。更换服务器、安装更新和旧文字恢复仍需各自明确确认。

页面安全区域只避让一次：Android 11（API 30）及以上由原生根布局统一处理系统栏、刘海和键盘；传给 WebView 的对应 Insets 必须清零，不能一边添加原生 padding、一边原样向网页转发。这样网页的 `safe-area-inset-*` 和 Visual Viewport 不会再次扣除同一块空间。必须转发已清零的 Insets，而非只返回 `CONSUMED`，否则 WebView 可能保留之前的安全区域。旋转或窗口尺寸变化只重新分发 Insets，不重建网页或移动未保存的草稿。依据：[Chromium WebView 的 Insets 处理规则](https://chromium.googlesource.com/chromium/src/+/HEAD/android_webview/docs/insets.md)。

Android 8–10 保留系统 Decor 原有的 `fitsSystemWindows` 与 `adjustResize` 行为，根布局仅处理向下传来的剩余 Insets，不额外开启旧版全屏标志。系统内容祖先已处理的安全区域会被消费或减去，不再由根布局重复加入。依据：[AOSP 内容布局](https://android.googlesource.com/platform/frameworks/base/+/android-10.0.0_r47/core/res/res/layout/screen_simple_overlay_action_mode.xml)、[View 的 Insets 消费](https://android.googlesource.com/platform/frameworks/base/+/android-10.0.0_r47/core/java/android/view/View.java)及 [DecorView 的内容边距与 Insets 扣除](https://android.googlesource.com/platform/frameworks/base/+/android-10.0.0_r47/core/java/com/android/internal/policy/DecorView.java)。设备验收应覆盖手势／三键导航、刘海左右变化、键盘打开再关闭和连续进入子页面；不能仅以桌面 Chromium 的手机尺寸代替原生 WebView 验收。

手机全页表单仅让弹窗正文的直接主卡片占满视口，卡片内容区域伸展，标题与第一项内容保持相邻；不能用 `justify-content: space-between` 将短表单分散到整屏，也不能让嵌套卡片都各占一屏。设置子页、笔记、看板打开任务及项目表单后的返回需验证实际边界、顶部间距与文档横向滚动。浏览器回归入口为 `tests/e2e/misc/android-shell-layout.spec.ts`，通过隔离 HTTPS 来源和原生桥验证网页布局，仍不替代 Android 系统 Insets 与软键盘的设备验证。

桌面快捷方式通过无界面、无独立任务归属的转发 Activity 打开现有 MainActivity，只传固定动作，不接受任意网址或其他参数。这样避免 Android 静态快捷方式的默认清任务行为销毁现有网页。依据：[Android 快捷方式的 Activity 启动规则](https://developer.android.com/develop/ui/compose/system/shortcuts/managing-shortcuts#start-one-activity-from-another)。

## 客户端更新

从「客户端设置」选择「检查更新」，首次打开及回到前台时还会做有间隔的自动检查（每 12 小时至多一次；手动检查不受这个间隔限制）。检查独立访问 Astering 官方 GitHub Release，不发送所选站点的 Cookie、访问令牌或服务器配置。仅考虑正式、非草稿发布中的确切 Android APK；没有安卓包的服务端发布不会提示升级，已安装版本及更低版本也不会触发。

发现新版后显示版本与真实包体积。点击「下载更新」直接从 GitHub 取包，显示百分比、已接收字节与平均速度；可以取消，失败可重新检查重试，不会触碰服务器数据。下载期间保持应用打开；本版不提供被系统杀进程后自动续传的承诺。完整下载后检查 GitHub 提供的 SHA-256、包大小、应用 ID、递增版本以及与当前安装一致的签名，再通过仅开放更新缓存目录的 FileProvider 交给系统安装器。不会静默安装、不接受网站下发的更新 URL，也不把网页导出下载与 APK 更新混为一谈。

发布安卓新版时，递增 `versionCode`，并保持其与正式标签 `v主版本-aster.序号` 的末尾序号相同；`versionName` 为去掉 `v` 的标签。将签名 APK 命名为 `astering-标签-android.apk` 上传到本仓库正式 Release，核对 GitHub 资产的 `digest`、字节数和本机 SHA256。客户端只接受这一命名、确切仓库下载地址与有效 SHA256；不把名称近似的文件当成更新。单独 Android 发布使用 `--latest=false`，避免把服务端的更新提示指向只有 APK 的发布。自动检查有上限地读取最多三页、每页 100 条正式发布元数据，不遍历无限历史或持续轮询。

Android 首次安装更新需要用户在系统中允许 Astering「安装未知应用」；设置回来后重新点击「检查更新」→「安装新版」继续。安装会重启应用，请先保存草稿并结束录音。未完成文件在取消或失败后删除，更新缓存只保留短期安装所需文件；完整包在页面重建后可按最新 Release 元数据重新验证并复用。网络失败使用 5 分钟自动检查退避，不会直接跳过 12 小时。

协议依据：[GitHub Release API](https://docs.github.com/en/rest/releases/releases)、[Android 安装来源权限](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls())、[FileProvider 的临时读取授权](https://developer.android.com/reference/androidx/core/content/FileProvider)。

## 使用与隐私

阿罗娜短语音沿用网页 `getUserMedia` 与 WebView 的音频许可。APK 同时声明 `RECORD_AUDIO` 和 Chromium 音频设备选择所需的普通权限 `MODIFY_AUDIO_SETTINGS`，后者不新增授权弹窗；系统麦克风权限仍由用户决定。网页许可只接受所选可信来源的音频采集，并绑定原 WebView、页面和账户会话；切换或取消后的迟到许可不得开麦。设备不存在或无法启动与权限拒绝分别提示，不能将所有初始化失败都误报为浏览器权限。依据：[Chromium 音频设备权限检查](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)。

在个人笔记中选择实时听写并点击开始，应用会再次显示原生确认，再申请麦克风权限。Android 13 及以上还需通知权限，确保用户能通过常驻通知停止。打开应用、恢复页面、读取状态或收到通知本身都不会开麦。

- 默认离开应用即停止采集，并等待服务器保存最终文字。只有本次开始前明确选择允许后台录音，切换应用或熄屏后才继续。
- 录音期间显示系统麦克风指示和常驻通知。通知包含“停止”和“打开笔记”，不展示转录正文。通知打开已有页面使用正常 SPA 路由，保留网站既有草稿退出保护。
- 在线模式将 PCM16 单声道音频以约 100ms 一帧发送本站 `/api/v2/notes/live`；本地模式在设备上经 VAD 分句和模型推理，不上传音频。两者均不写录音文件、下载目录、数据库或日志。服务商凭据继续由服务器管理，APK 不包含模型密钥。
- 音频仅短暂放在最多约 4 秒的内存队列中。网络拥塞超出边界时停止并显示错误，不无限积压、不静默丢弃一段声音，也不自动重放未知结果。
- 约每 420 秒按服务器 `ready.rotate_seconds` 提前结束旧连接；收到最终 `done` 后才续接。续接期间保留同一个麦克风，将新声音暂存于上述有限队列，新的连接按不超过约两倍实时速度追赶。续接等待超过缓冲容量同样明确暂停。
- 最终分句以服务器提交后的 `segment` 回执为准。页面重新附着后读取持久转录，不把原生端内存状态当成完整笔记历史；网络中断前尚未确认的声音不能声称已经保存。
- 退出、切换账户／认证会话、明确停止、移除应用任务或系统结束进程都会撤销对应录音。服务为 `START_NOT_STICKY`，没有开机接收器、定时开麦或自动恢复录音。
- “保持屏幕常亮”只作用于可见页面。后台录音持有有限时长并随续接更新的 CPU 唤醒锁，结束时释放；这不能保证所有厂商省电策略都允许长时间运行。

强制停止、系统资源回收、电话或其他音频占用、麦克风隐私开关和厂商电池限制仍可能结束录音。已保存文字保留在服务器；应用不会事后重建未采集或未提交的声音。

本版专注所选站点页面、已有站点账号登录及实时笔记，不替代系统浏览器的全部能力。尚未实现原生下载管理、Blob／PDF 导出保存和外站 OAuth 浏览器回跳；需要这些功能时在系统浏览器中登录本站操作。文件选择上传已有系统选择器支持，与下载能力分开。

## 安全边界

原生桥使用 AndroidX WebKit `WebViewCompat.addWebMessageListener`，仅允许用户已确认的精确 HTTPS 来源，并再次检查主 frame 和当前页面来源；前端还要求 API 是当前页面同源的标准 `/api/v2`，不能将另一 API 目的地的令牌交给原生端。没有 `addJavascriptInterface`、通配来源或任意原生执行入口。旧版 System WebView 不支持该 API 时不降级暴露不安全桥。

外站链接交给系统浏览器；文件访问、混合内容和明文 HTTP 被禁用。系统文件选择器只向网页交回具有读取授权的 `content://` 文档，原生端不提供任意路径读取。SSL 错误始终拒绝，HTTP 刷新和 WebSocket 不跟随重定向。

原生访问令牌及会话代次只放进程内存，不写 SharedPreferences、日志或 APK 资源。WebView 沿用网站已有登录状态和 HttpOnly 刷新 Cookie；这不是新增离线凭据仓库。应用禁用自身备份与设备迁移，避免携带 WebView 登录数据到其他设备。

刷新使用真实 `POST /api/v2/user/token/refresh`，通过精确刷新 URL 取得路径受限的 `vikunja_refresh_token`。网页和录音服务共用原生串行协调器，两个 v1／v2 `Set-Cookie` 分别完成写入后才返回新访问令牌。响应应用同时核对账户、SID、认证代次与原 Cookie；退出后的迟到结果不能恢复旧会话或覆盖新登录。同一会话刷新不结束录音，旧 `iat`／`exp` 的访问令牌也不能降低已接受令牌。

通知停止动作绑定本次录音 UUID 与笔记 ID。旧通知既不能停止后来开始的录音，也不能给另一个账号打开旧笔记。录音启动还绑定用户、SID 和代次，覆盖授权弹窗、启动服务及创建麦克风之间的异步窗口。

## 网页桥协议

桥对象为 `window.AsteringNative`。页面通过 `postMessage(JSON.stringify(command))` 发送请求，通过 `onmessage` 接收 JSON；只在可信主 frame 上使用。

请求含唯一 `id` 和下列 `action`：

| action | 内容与作用 |
| --- | --- |
| `clientInfo` | 不接收凭据；返回 `{version_name, version_code, capabilities:{clientSettings:true}}`，仅用于入口能力检测 |
| `openClientSettings` | 不接收业务参数或凭据；仅在可信主 frame、前台可见时打开原生设置，不执行菜单内操作 |
| `session` | `token`；同步当前已登录人类会话，不申请权限 |
| `clearSession` | 立即撤销内存认证与对应录音，不等待刷新网络请求 |
| `refresh` | `token`；返回 `{token}`，与正在进行的同会话刷新串行协调 |
| `startRecording` | `token, note_id, connection_id, sample_rate, language, allow_background, keep_awake`；可见 Activity 内显式确认后启动 |
| `stopRecording` | `note_id, sid`；核对所属笔记和会话，取消迟到授权或结束当前录音 |
| `recordingStatus` | 只读取当前会话内存快照，不开麦、不自动续录 |

响应为 `{id, ok:true, result}` 或 `{id, ok:false, error}`。错误使用固定类别，不透传私人响应体或密钥：`authentication`、`session_changed`、`permission`、`notification_permission`、`foreground_required`、`already_recording`、`cancelled`、`invalid_request`、`unsupported`、`network`、`rate_limited`、`server` 等。

异步事件包括：

- `{event:'token', token}`：同一认证会话的新访问令牌，网页仍核对当前身份后采用。
- `{event:'recording', snapshot}`：`user_id, sid, note_id, generation, sequence, state, allow_background` 及当前进度；`sequence` 为进程内单调递增序号，忽略重复或旧状态。`elapsed` 和 `buffered_seconds` 单位为秒，`sent_bytes` 是已交给 WebSocket 发送队列的 PCM 字节数，`bytes_per_second` 是对应采样速率，不代表服务器已提交文字。
- `{event:'openNote', note_id, user_id, sid}`：仅匹配当前通知所属身份时让网页正常导航，不在原生端绕过草稿保护或业务权限。

`state` 沿用网页 `idle / permission / connecting / recording / reconnecting / stopping / paused`；错误使用 `paused` 加固定 `error` 类别。分句事件另带服务器原生 `segment` 和 `stats` 回执，普通快照只保留必要的最新状态。服务错误还包括 `backpressure`、`connection_timeout`、`finalize_timeout`、`microphone`、`protocol`、`response_limit` 与服务器已有的笔记／连接错误；不得把这些状态显示成保存成功。

## 本机编译与签名

项目目录为 [`android/`](../android/)，使用 Java，最低 Android 8.0（API 26），目标及编译 API 36，本机识别使用 ARM64 原生库。固定工具链为 AGP 9.2.1、Gradle 9.4.1、JDK 21（Java 源码目标 17）；依赖 AndroidX WebKit 1.18.0、兼容 API 36 的 OkHttp 5.4.0。离线文字通过笔记的幂等导入 API 同步，不把 GitHub Actions 接入构建。

```sh
python3 android/scripts/prepare-offline-asr.py
cd android
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Gradle Wrapper 固定官方发行包 SHA-256。SDK 至少安装 `platforms;android-36` 和 `build-tools;36.0.0`。编译依赖仍需首次联网下载，不能把一次成功缓存误报为完全离线构建。

Release 通过四个私有环境变量配置外部签名文件：`ASTERING_ANDROID_KEYSTORE`、`ASTERING_ANDROID_STORE_PASSWORD`、`ASTERING_ANDROID_KEY_ALIAS`、`ASTERING_ANDROID_KEY_PASSWORD`。不把密钥文件、密码、签名配置或构建缓存提交到 Git。缺少任一项时 Release 签名验证失败，不用调试证书代替正式签名。

```sh
# 由维护者在当前进程安全载入上述签名环境，不把密码放命令行或日志。
./gradlew :app:testDebugUnitTest :app:lintRelease :app:assembleRelease
```

产物默认在 `android/app/build/outputs/apk/release/app-release.apk`。保留相同 application ID `space.tcymc.astering` 和正式签名证书才能覆盖升级；卸载会清除本机 WebView 登录状态，但不会删除服务器笔记。安装时由用户明确允许相应来源安装 APK；应用仅为用户明确确认的、同应用同签名升级申请系统安装权限，不提供安装其他应用的入口。

## 验证记录与限制

当前验证结果由本次发布记录和维护者日志补充，不能以本文步骤代替实际执行。纯 Java 回归覆盖来源白名单、Cookie 目的地、会话代次、同 SID 刷新不降级、退出／重登和通知代次；它们不能证明某台手机的音频硬件、通知可见性或厂商后台策略。

正式验收还应在设备上检查：首次授权与拒绝、授权未完成时取消／离开、重复启动、后台选项开关、熄屏与唤醒、通知停止／打开、切账号、网络断开、跨 420 秒续接及最终服务器回执。模拟器检查应使用隔离账户和本地假语音提供商，不用真实付费模型，也不把生产登录或录音用作默认测试夹具。未执行的项目须明确留待设备验收。

官方依据：[安全 WebView 原生桥](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)、[WebMessageListener](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener))、[麦克风前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)、[AGP 9.2 工具链兼容](https://developer.android.com/build/releases/agp-9-2-0-release-notes)、[AndroidX WebKit 版本](https://developer.android.com/jetpack/androidx/releases/webkit)。
