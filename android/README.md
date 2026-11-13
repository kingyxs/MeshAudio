# MeshAudio Android 节点 0.3.1

Android 10 / API 29 起可安装。仅采集用户主动启动并授权的麦克风、允许捕获的应用媒体音频；两路独立发送，不在手机上混音或决定桌面路由，不传输屏幕画面。

## 构建与安装

使用 JDK 17、Android SDK Platform 35、Build Tools 35.0.0、Gradle 8.10.2。SDK/Gradle 不进入源码或 APK。Windows 在工程根目录运行：

```powershell
./tools/setup-android.ps1
./tools/build-android.ps1 -Install
```

已有 SDK 可设置 ANDROID_HOME。脚本依次执行单元测试、Lint、打包，并将 APK 和 SHA-256 写入 release/android。多设备用 `-Device <adb-serial>`。不会因为签名不匹配而卸载旧应用或清除数据。

也可直接在本目录运行：

```text
gradlew.bat --no-daemon :app:testDebugUnitTest :app:lintDebug :app:assembleDebug
```

Windows 脚本会优先使用本地 .build-tools/gradle，其他系统使用 gradlew。Wrapper 固定版本与分发 SHA-256；gradle/verification-metadata.xml 校验依赖。Maven Central 不可达时可显式设置 MESHAUDIO_MAVEN_MIRROR 为信任的 Maven 兼容仓库；默认使用 Google / Maven Central。

公开 Release 提供 **`MeshAudio-Android-0.3.1-release.apk`**：由 `assembleRelease` 产出的未签名包经 `zipalign` 与 `apksigner` v3 签名（minSdk 29 只需 v3），使用独立于源码树的发布密钥。签名证书与摘要可在 `SHA256SUMS.txt`、`.apk.sha256` 与 `apksigner verify --print-certs` 核对。密钥与密码只保存在本机被 `.gitignore` 排除的私有目录，**不进入源码、CI 日志或 Release 附件**；维护者须离线备份，丢失后无法再以同一签名发布升级包。

同时保留 `MeshAudio-Android-0.3.1-debug.apk` 作为内部真机验收用包。两者签名不同，**不能直接覆盖安装**：从 debug 版升级到 release 版需要先卸载旧包（会清除应用数据并重新授权），或继续沿用 debug 包做开发测试。release 版未在真机重跑 USB/Wi-Fi 两组 15 项验收，真机证据对应的是同源码的 debug 包；安装后请自行确认双流、授权与前台服务行为。

`tools/build-android.ps1 -Configuration Release` 只生成 `-release-unsigned.apk`，不会覆盖已签名的发布包；签名步骤由维护者在私有环境执行，脚本不会输出或写入密钥密码。

## 使用

1. 电脑和手机连入同一可信局域网，启动 MeshAudio 桌面端。手机电脑地址留空时广播发现，也可手动填写电脑 IPv4 地址。默认发现 UDP 4174、音频 UDP 4175。
2. 点击启动麦克风，授权录音与通知。后台运行会显示前台服务常驻通知，可从应用或通知停止。不会自动从开机或系统杀进程后恢复录音。
3. 点击启动媒体音频，每次确认新的系统媒体投影授权；取消不会影响麦克风。只建立 AudioPlaybackCapture，不创建 VirtualDisplay、不抓取或传送视频。
4. 桌面画布中将来源连接到通道，再连接系统播放或虚拟输入。手机不自动创建路由。
5. 可分别停止两路。停止媒体即释放授权，再次启动会重新请求。系统撤销/锁屏结束媒体授权时明确显示重新启动提示。

部分媒体应用、DRM、通话或系统政策禁止捕获。静音 PCM 不一定是网络故障。不同 Android 版本（尤其 Android 15+）的锁屏/投影终止规则不同；厂商后台清理也可能终止服务，不承诺所有系统锁屏永久发送。

## 传输与时钟

- 默认 UDP：按共享协议注册稳定 deviceId + streamType，48 kHz，120 帧/包，统一双声道 float32 PCM，980 字节，避免 IP 分片。麦克风原始采集为单声道 PCM16，再复制左右声道，不做混音。
- 可选 WebSocket 兼容模式：填写可访问的桌面音频网关地址及端口；注册令牌后复用已有 /browser-audio PCM 入口。旧桌面会将该传输标为 browser，实际仍为 Android 原生 AudioRecord。它不是浏览器采集，也不提供带宽压缩。
- WebSocket 背压约 120 ms 即丢弃积压并重连，避免无限排队。AudioRecord 提供采集节奏，没有定时器生成音频；重连停止/重启采集以丢弃旧缓冲。
- 独立 /control 连接只同步来源停止状态与接收确认。短暂断开不结束音频，并独立重连。不允许远程在首次授权前偷偷开启麦克风或媒体会话。
- 发送序号按来源提前持久化预留；停止/重启、进程重启不倒退到 0，避免原生桌面把新包当作迟到包。
- 当前固定 PCM，未实现 Opus 或省带宽策略。音频及控制明文，仅用于可信局域网；界面未展示虚假的端到端延迟。

## 验证

单元测试覆盖字节序、uint32 序号、单声道复制、双声道顺序、数值幅度、最大包长和非法输入；Lint 检查权限与 API 级别。

`tools/test-android-device.js` 在已授权手机上覆盖升级、授权/取消、原生双流、实际虚拟输入、单路启停、控制断开、音频断线与息屏。它使用独立桌面数据目录，不修改用户画布。测试应用 test-player 只播放可捕获的测试音；device-driver 仅用于 UI 测试，不包含在主 APK 中。不要通过跳过系统授权来测试媒体捕获。

```powershell
./tools/build-android.ps1
$env:ANDROID_SERIAL='<adb-serial>'
node tools/test-android-device.js
```

USB 测试使用 adb reverse 与显式 WebSocket 兼容连接，不能替代同局域网无线 UDP 验收。测试会临时启用 USB 常亮、配置本应用测试地址、安装测试工具，结束后恢复设置并停止采集；既有来源设备 ID 保留。真实手机音质、30 分钟连续性、其他系统版本及拒绝捕获的应用需要另外验证。机器可读结果保存在 docs/testing/android/（不进入公开源码）。

无线实测可设置 `MESHAUDIO_ANDROID_TRANSPORT=udp`。脚本使用独立局域网 UDP 端口与丢包代理：音频确实经手机 Wi-Fi 到达电脑；代理仅用于定向丢弃某一路并确认其他路持续。USB 与无线报告分别保存，不用 USB 通过代替无线通过。

## 结构与许可

app 为交付应用；test-player 与 device-driver 为测试专用。自有代码 GPL-3.0-or-later；OkHttp/Okio/Kotlin 与 Gradle Wrapper 的 Apache-2.0 许可独立保留。SDK 工具不重新分发。
