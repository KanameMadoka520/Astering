# Astering Android 客户端

Android 客户端基于 Vikunja 改造而来的 Astering 网站，提供系统 WebView 界面、个人笔记原生麦克风服务与可选设备本地识别。应用只打开 `https://task.tcymc.space`；登录及页面首次加载仍需要网络和本站账户。已经打开的笔记可使用内置模型在断网时继续识别，文字加密暂存后补传；这不表示整个网站已经支持断网冷启动。页面来自线上 SPA，因此网页界面更新不需要重新安装 APK；原生权限、服务、识别模型和桥接代码变更仍需安装新版 APK。

最新客户端内置约 229 MiB 的 SenseVoiceSmall int8 权重、词表及 VAD，支持近年的 ARM64 安卓手机。实际 APK 还包括原生运行库。模型不会在打开页面时重新下载；详细来源、许可、校验值、体积、加密文字与实测边界见[本地语音识别](offline-asr.md)。

## 使用与隐私

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

本版专注本站页面、已有本站账号登录及实时笔记，不替代系统浏览器的全部能力。尚未实现原生下载管理、Blob／PDF 导出保存和外站 OAuth 浏览器回跳；需要这些功能时在系统浏览器中登录本站操作。文件选择上传已有系统选择器支持，与下载能力分开。

## 安全边界

原生桥使用 AndroidX WebKit `WebViewCompat.addWebMessageListener`，仅允许精确 HTTPS 来源 `https://task.tcymc.space`，并再次检查主 frame 和当前页面来源。没有 `addJavascriptInterface`、通配来源、任意服务器设置或任意原生执行入口。旧版 System WebView 不支持该 API 时不降级暴露不安全桥。

外站链接交给系统浏览器；文件访问、混合内容和明文 HTTP 被禁用。系统文件选择器只向网页交回具有读取授权的 `content://` 文档，原生端不提供任意路径读取。SSL 错误始终拒绝，HTTP 刷新和 WebSocket 不跟随重定向。

原生访问令牌及会话代次只放进程内存，不写 SharedPreferences、日志或 APK 资源。WebView 沿用网站已有登录状态和 HttpOnly 刷新 Cookie；这不是新增离线凭据仓库。应用禁用自身备份与设备迁移，避免携带 WebView 登录数据到其他设备。

刷新使用真实 `POST /api/v2/user/token/refresh`，通过精确刷新 URL 取得路径受限的 `vikunja_refresh_token`。网页和录音服务共用原生串行协调器，两个 v1／v2 `Set-Cookie` 分别完成写入后才返回新访问令牌。响应应用同时核对账户、SID、认证代次与原 Cookie；退出后的迟到结果不能恢复旧会话或覆盖新登录。同一会话刷新不结束录音，旧 `iat`／`exp` 的访问令牌也不能降低已接受令牌。

通知停止动作绑定本次录音 UUID 与笔记 ID。旧通知既不能停止后来开始的录音，也不能给另一个账号打开旧笔记。录音启动还绑定用户、SID 和代次，覆盖授权弹窗、启动服务及创建麦克风之间的异步窗口。

## 网页桥协议

桥对象为 `window.AsteringNative`。页面通过 `postMessage(JSON.stringify(command))` 发送请求，通过 `onmessage` 接收 JSON；只在可信主 frame 上使用。

请求含唯一 `id` 和下列 `action`：

| action | 内容与作用 |
| --- | --- |
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

产物默认在 `android/app/build/outputs/apk/release/app-release.apk`。保留相同 application ID `space.tcymc.astering` 和正式签名证书才能覆盖升级；卸载会清除本机 WebView 登录状态，但不会删除服务器笔记。安装时由用户明确允许相应来源安装 APK；应用自身不申请安装其他应用权限。

## 验证记录与限制

当前验证结果由本次发布记录和维护者日志补充，不能以本文步骤代替实际执行。纯 Java 回归覆盖来源白名单、Cookie 目的地、会话代次、同 SID 刷新不降级、退出／重登和通知代次；它们不能证明某台手机的音频硬件、通知可见性或厂商后台策略。

正式验收还应在设备上检查：首次授权与拒绝、授权未完成时取消／离开、重复启动、后台选项开关、熄屏与唤醒、通知停止／打开、切账号、网络断开、跨 420 秒续接及最终服务器回执。模拟器检查应使用隔离账户和本地假语音提供商，不用真实付费模型，也不把生产登录或录音用作默认测试夹具。未执行的项目须明确留待设备验收。

官方依据：[安全 WebView 原生桥](https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges)、[WebMessageListener](https://developer.android.com/reference/androidx/webkit/WebViewCompat#addWebMessageListener(android.webkit.WebView,java.lang.String,java.util.Set,androidx.webkit.WebViewCompat.WebMessageListener))、[麦克风前台服务](https://developer.android.com/develop/background-work/services/fgs/service-types#microphone)、[AGP 9.2 工具链兼容](https://developer.android.com/build/releases/agp-9-2-0-release-notes)、[AndroidX WebKit 版本](https://developer.android.com/jetpack/androidx/releases/webkit)。
