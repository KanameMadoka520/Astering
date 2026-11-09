# 安卓本地语音识别与待同步文字

Astering 的 Android ARM64 客户端内置 SenseVoiceSmall int8 和 Silero VAD，不依赖手机安装额外识别服务，也不会把识别请求转发给模型厂商。本地模型固定自动判断语言，优先满足中英文混合的随口笔记；界面使用英文也不会把识别强制设为英语。自动识别仍可能错听专有名词或句中切换，不能承诺复杂混合语音的完整准确率。设置中的「本机离线识别」只在支持该能力的新 APK 出现。旧 APK、普通浏览器继续使用现有在线识别。

## 选型与体积

| 方案 | 官方模型体积 | Android 集成 | 本轮选择 |
|---|---:|---|---|
| SenseVoiceSmall 原始 2024-07-17 int8 | 权重 239,233,841 B；词表 315,894 B | sherpa-onnx 官方 AAR，CPU，支持中英日韩粤语 | 内置，优先普通话日常笔记；配合 VAD 分句、数字和标点规范化 |
| whisper.cpp base q5_1 | 59,707,625 B，约 57 MiB | 官方 JNI / Android 示例；自回归解码 | 更小，但本轮不把未测过的中文准确率和手机速度当成优势 |
| whisper.cpp small q5_1 | 190,085,487 B，约 181 MiB | 同上 | 体积已接近 SenseVoice，需要另外实测手机持续解码成本 |
| Vosk small-cn-0.22 | 官网列约 42 MB | 官方 Android API，流式、占用低 | 足够小；官网公开中文测试误差较高，未选作长篇随口记录的默认引擎 |

SenseVoice 的「Small」是模型名称，**不表示 APK 只有几十 MB**。权重、词表和 VAD 合计 240,193,589 B，约 229 MiB；最终 APK 还包括 ARM64 原生运行库和客户端。只提供 ARM64 是针对近年的安卓手机，不支持旧款 32 位设备。2025-09-09 的同名导出是粤语微调派生版本，并非普通话通用升级，因此没有仅因日期更新就替换原模型。

原始资料：[SenseVoice 官方模型说明](https://huggingface.co/FunAudioLLM/SenseVoiceSmall)、[sherpa SenseVoice Android 与模型文档](https://k2-fsa.github.io/sherpa/onnx/sense-voice/pretrained.html)、[whisper.cpp 官方 Android 示例](https://github.com/ggml-org/whisper.cpp/tree/master/examples/whisper.android)、[whisper.cpp 发布模型](https://huggingface.co/ggerganov/whisper.cpp/tree/main)、[Vosk 官方模型表](https://alphacephei.com/vosk/models)。这些模型的公开测试集不同，不能把表中的误差或一次样例结果解释成跨模型公平排名。

运行库 sherpa-onnx 使用 Apache-2.0；Silero VAD 和 ONNX Runtime 使用 MIT。SenseVoice **代码与权重许可证不同**：权重遵循 [FunASR MODEL_LICENSE](https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE)，要求保留来源、作者及模型名称。本仓库在 `android/licenses` 保留许可与 NOTICE，并一并打入 APK 的 `offline-asr/licenses`，不把权重重新声明为 Astering 自有或 MIT。

## 音频与线程边界

- 复用已有原生麦克风前台服务、用户明确选择的精确 HTTPS 来源与主框架桥、当前用户/SID/epoch 栅栏、可见界面确认、权限提示和通知停止入口。切换账户立即停止旧录音；退出、强杀、移除任务不会自动重开麦克风。
- 本地模式固定单声道 16 kHz PCM16，音频帧队列最多 4 秒。Silero VAD 使用 512 样本窗口、0.6 秒停顿结束分句，连续说话最长每 20 秒切分。
- 模型加载与识别在专用线程；识别用两个 CPU 线程，VAD 用一个线程。最多两句等待或正在识别，不无限积压录音。设备跟不上时明确暂停并报错。
- **原始音频只在有界 RAM 中，不写音频文件。** 不提供断电后恢复未识别声音的承诺，也不在后台偷偷保存录音。识别是按句输出，并非模型逐字流式解码。
- 本地模式并不等于整个远端 WebView 网站支持首次离线启动。先打开已登录的笔记页后，断网期间可继续本机识别；冷启动页面仍受网站资源缓存及登录可用性限制。

## 加密文字待同步

每句识别完成后，先将文字及真实录音时间、目标笔记、固定 `client_id` 写入应用私有 `noBackupFilesDir`。AES-GCM 密钥由 Android Keystore 管理；附加认证数据同时绑定服务器来源、账户 ID 与分句 UUID，移动文件或篡改内容会校验失败。每个服务器、账户独立目录和密钥，Android 系统备份关闭，凭据与原始录音均不在此缓存中。仅解析网页 JWT 不能获得离线数据权限：本进程必须先通过所选服务器的同源刷新端点验证同一用户与 SID，再允许本地录音、读取或清理缓存。同 SID 的刷新保留验证，切号／退出撤销；网络恢复后可重试建立验证，不持久化额外登录凭据。

每账户最多 2,000 句或 8 MiB；满后暂停，**不自动淘汰尚未同步的文字**。永久失败或损坏保留原文件并提示处理，不把它误报为已保存到服务器。用户可以查看条数和本机占用、立即重试，或在停止录音后明确确认清理当前账户待同步内容。已同步笔记不因清理本机缓存而删除。

联网恢复、当前账户登录/刷新及手动重试会启动同步。普通网络失败指数退避，单轮最多 8 次；403、404、409 等明确权限/目标/冲突失败停止自动重试。每次请求只使用当前服务器、账户协调器产生的 JWT；身份切换会取消在途请求、停止旧状态回填，其他账户缓存不会被上传或展示。

导入使用 `POST /api/v2/notes/{id}/segments/import`，固定分句 UUID 和完整载荷保持重试幂等；请求成功且 `note_id/client_id` 与原件一致才删除本机密文。录音 `recording_id` 第一句由服务器在笔记锁中分配固定累计时间原点，后续按 `recording_offset_ms` 归一化，避免离线旧缓存猜测笔记末尾。`captured_at` 则始终来自录音真实 UTC 起点加相对采样偏移，与累计笔记时间轴分开。返回 `{segment, stats}` 是前端更新正式笔记的成功凭据。

## 原生桥契约

保持 `session/clearSession/refresh/recordingStatus/startRecording/stopRecording` 兼容。`startRecording` 可增加：

```json
{
  "engine": "local",
  "sample_rate": 16000,
  "timezone": "Asia/Shanghai",
  "append_to_article": false,
  "start_offset_ms": 0
}
```

`engine` 缺省为 `online`。本地录音起点由原生实际开始时间产生，`generation` 同时作为 `recording_id`；每句独立 UUID。自动入文是本次开始快照，不因用户后来改设置而改变已录内容的处理。

`offlineStatus` 返回 `available/ready/model_id/model/bytes/sample_rate/user_id/pending_count/pending_bytes/max_pending_count/max_pending_bytes/audio_persisted/sync_error`。`available` 表示 APK 内置模型，`ready` 还要求当前身份经过服务器验证；未验证时不暴露其他账户缓存的数量或内容。`listOffline` 可按 `note_id` 查看待同步的原始分句，支持 `limit`（最多 50）、`cursor` 与响应的 `entries/next_cursor/has_more/status`；游标仅是有格式校验的修改时间＋UUID，不能被当作路径使用。每次最多扫描 100 个文件，响应小于 192 KiB，当前身份和响应前复核都通过才返回文字。稳定游标避免同步删除文件造成下一页跳项；旧 `offset` 参数仅保留兼容。`syncOffline` 触发有限重试并返回状态；`clearOffline` 需 `{confirm:true}` 且停止录音后执行。旧 APK 返回 `unsupported`，网页不应显示无法使用的本地引擎。

本地事件为 `{event:"offline", user_id, status, receipt?}`；只有成功同步才有 `{segment,stats}` 的 `receipt`。录音快照额外带 `engine/local_text/local_client_id/pending_sync/inference_ms`。`local_text` 是已落盘的本机文字预览，不应伪装为服务器成功的正式 `segment`。`pending_sync` 指当前服务尚在落盘的句数，总待同步数取 `offlineStatus.pending_count`。

在线模式保留 4 秒内存缓冲，并补充有限网络重连：200 ms 起指数退避，最多 5 次。只发送尚未交给旧 WebSocket 的帧；已交给旧连接但未确认的音频不重播，避免重复入文，同时明确设置 `incomplete_audio`，保留 `interrupted_partial` 供用户检查。超过有限缓冲或最终保存超时会暂停并说明，不能宣称断线完全无损。快照包含 `retry_attempt/retry_in_seconds`，进度来自实际状态。首 wire 的 `ready` 后、首 PCM 前额外发送一次 `capture_started`，以实际开麦 UTC 校正模型连接等待；轮换继续沿用同一录音 ID 与起点，并发送真实累计采样偏移。

## 可复现构建与验证

```sh
ASTERING_ASR_CACHE=/opt/astering/tools/offline-asr \
  python3 android/scripts/prepare-offline-asr.py
cd android
ANDROID_HOME=/opt/astering/tools/android-sdk \
  /opt/astering/tools/gradle-9.4.1/bin/gradle --no-daemon \
  :app:compileDebugJavaWithJavac :app:testDebugUnitTest :app:lintDebug
```

脚本从官方 GitHub Release API 获取固定资产，核对官方 SHA-256，才提取固定文件到 Git 忽略的 `android/.offline`；缺少模型时 Gradle 明确失败，不能悄悄产出空壳 APK。原始模型仓库 revision 为 `2365baeacb507f821a0c8120fcee3d484dba7a07`，权重 SHA-256 为 `c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51`。构建时必须同时核对模型清单、实际 APK 内 assets 与签名。

AES-GCM 单元测试覆盖账户/UUID/密钥绑定、篡改拒绝、随机 IV 和容量边界。离线音频基准脚本使用同一权重和运行库处理官方真实语音、静音及连续拼接片段；具体结果见本文件后续验收记录。Linux 实测只能证明离线推理链路与输入正确，不能替代安卓真机的麦克风、后台限制、发热和耗电验收；本机没有可用真机时必须如实保留该限制。

脚本另加入「普通话 → 英语 → 普通话 → 英语」交替输入：每种使用两段官方样例，段间插入 0.7 秒静音，保持客户端相同 VAD 参数与 `auto` 语言判断。检查四段输入均得到文字、检测分段的时间戳有序且不重叠，并记录每段真实输出；不要求逐字相同。这个测试只验证整句切换语言及分句链路，不能代表同一句内夹杂人名、缩写或专业术语时的准确率；实际结果见下面的追加记录。

## 本轮离线基准记录

2026-11-09，在本机 Linux x86_64、sherpa-onnx 2.0.1 CPU 两线程下，先验证模型 SHA，再禁用脚本网络连接并处理官方归档内真实语音：

| 输入 | 音频时长 | 推理耗时 | RTF（越低越快） |
|---|---:|---:|---:|
| 普通话 | 5.592 s | 0.184 s | 0.033 |
| 英语 | 7.152 s | 0.227 s | 0.032 |
| 粤语 | 5.148 s | 0.154 s | 0.030 |

模型初始化约 1.44 s；10.016 s 纯静音没有触发分句或识别；32.96 s 拼接语音经过 VAD 得到 5 段，处理约 0.87 s。此为可复现的推理与分句冒烟测试，不能外推成手机续航或完整准确率基准。英语样例中的 gold 被识别成 code，说明结果仍须核对，界面不应暗示识别天然完全准确。

命令（依赖预装在独立目录，不修改系统 Python）：

```sh
PYTHONPATH=/opt/astering/tools/offline-asr/benchmark-libs \
OPENBLAS_NUM_THREADS=1 OMP_NUM_THREADS=2 \
python3 android/scripts/benchmark-offline-asr.py \
  --cache /opt/astering/tools/offline-asr \
  --assets android/.offline/assets/offline-asr
```

最终 Android 检查：`compileDebugJavaWithJavac`、`testDebugUnitTest`（10 项）与 `lintDebug` 于本轮全部成功，未跳过单元测试；ARM64 原生 ELF 的 LOAD 对齐为 16 KiB，动态依赖仅 Android 系统库。正式签名 APK 仍须在最终版本号冻结后执行 release 构建、签名校验、ZIP 对齐和 APK 内模型 SHA 核对。上述结果不包含安卓真机麦克风、后台续录或耗电测试。

### 追加中英交替离线实测

2026-11-09，使用上述同一离线命令、CPU 两线程与 `auto` 设置，追加的 27.588 秒交替音频识别通过：VAD 得到四段，每段均有文字，时间戳按输入顺序递增且互不重叠。分句和识别共 0.868 秒，RTF 0.0315；本次模型初始化 1.325 秒。四段实际检测范围如下，时间均相对拼接音频起点：

| 官方样例输入 | 实际分段时间 | 实际输出摘录 |
|---|---|---|
| 普通话一 | 0.742–5.128 s | 开饭时间早上9点至下午5点。 |
| 英语一 | 7.366–12.776 s | The tribal chieftain … 50 pieces of gold. |
| 普通话二 | 14.918–19.240 s | 派放时间早上9点至下午5点。 |
| 英语二 | 21.510–26.920 s | The tribal chieftain … 50 pieces of gold. |

两段普通话来自同一官方语音，识别结果开头仍然不同；因此这次通过仅证明自动语言判断、交替输入与分句时间链路运行正确，不能声称没有错字。英文单独输入本次仍把 gold 识别成 code，交替输入经 VAD 截取后则为 gold，也说明切分和上下文会影响结果。未使用私人录音或云端请求，测试时脚本禁止 Python 网络连接；完整 JSON 与 stderr 由本机构建证据保留，仓库不收集用户语音。服务器 Linux 的耗时不能外推成安卓真机持续录音性能。
