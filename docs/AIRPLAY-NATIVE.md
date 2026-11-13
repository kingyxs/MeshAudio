# MeshAudio 原生 AirPlay 线路

当前 Windows 路径由 MeshAudio 管理原生 UxPlay 进程，不再调用 `uxplay-windows` Qt 托盘包装器，也不切换 Windows 默认播放设备，不采集 VB-CABLE。UxPlay 以 `-vs 0` 启动，视频管线关闭；其 GStreamer 音频管线输出到本线路独占的 `127.0.0.1` PCM 端口，再由 `desktop/airplay-bridge.js` 转成 MSA1，进入普通来源、通道和输出图。

## 构建

需要 Windows Bonjour 服务、MSYS2 UCRT64、GStreamer、libplist、OpenSSL 和 Apple 公共 `dns_sd.h`。仓库 `third_party/UxPlay` 固定在提交 `fd88c0c465df492e03461980bedf115a40bc835a`；构建脚本用系统 `dnssd.dll` 生成导入库，不复制该系统 DLL。

```powershell
node tools/build-minimal-codecs.js
powershell -ExecutionPolicy Bypass -File tools/build-uxplay.ps1
node tools/prepare-airplay-sources.js
```

构建输出在 `desktop/airplay/`，包含 UxPlay、所需 GStreamer 运行库、依赖清单、SHA-256 和 `sources/` 源码包/补丁。UxPlay 为 GPL-3.0-or-later；发布包必须同时保留源码、许可证和依赖许可证。

## 使用

1. 画布点击“添加 iOS 源”。只有确认添加线路后，插件才会启动。
2. 每条线路创建独立 AirPlay 名称、MAC、AirPlay TCP/UDP 端口、PCM 端口和 MeshAudio 来源。
3. 启动线路后扫描二维码，打开关联线路的 iOS 网页麦克风页面。它发送独立麦克风来源；接收 AirPlay 媒体仍需在控制中心选择同名接收端。网页不能自动打开“屏幕镜像”设备选择器。麦克风 HTTPS/证书步骤见 [网页麦克风](WEB-MICROPHONE.md)。
4. 在来源节点点击“连接详情”，可查看来源 IP、线路状态、桥接缓存、补静音次数、接收日志、二维码及来源到通道/输出的实际路径。

最多保留 8 条线路。服务重启时线路配置保留，但接收器默认停止；不会在用户未操作时占用端口或发布 AirPlay 服务。每条线路停止或断流只影响自身，来源、连线和其他线路保留。

## 验证

```powershell
npm run test:airplay-lines
npm run test:airplay
```

目标电脑首次使用需要管理员在 PowerShell 执行 `tools/configure-airplay-firewall.ps1`。脚本只创建 Private 配置文件、LocalSubnet 来源的 UxPlay 与 AirPlay 端口规则；它不会开放 MeshAudio 控制 API，也不会修改默认声卡。若无法提权，可手工允许 `desktop/airplay/uxplay.exe` 的 Private 入站流量和 7200-7279 TCP/UDP 端口。

自动测试覆盖双线路端口/来源隔离、重复启动、独立 PCM、增益/静音、停止一路保留另一路、旧 API 禁用和清理。仍需真机验证：Bonjour/mDNS、防火墙、两台 iPhone 同时投送、无视频窗口/任务栏项、DRM/通话限制和实际端到端延迟。

## 已知限制

- AirPlay 发送端自身有协议播放缓冲，MeshAudio 不能把完整端到端延迟压到实时通话级别。
- iOS 通话/FaceTime、部分 DRM 内容不保证可接收。
- 不同线路使用不同名称和 MAC；每个 MeshAudio 接收线路支持一台 iOS 发送端。
- 手机网关不会绕过 iOS 的人工设备选择步骤，也不会开放桌面控制 API。
- 当前自动化测试注入 bridge PCM，未伪装成真实 iPhone 协议验收；真实手机连接、两台手机并发和防火墙规则仍需手工测试。

## 2026-11-13 修复补充

- 新来源缺少 gain 时默认 1；保留显式的 0，避免无声或将零音量显示成满音量。
- 原生 SETUP 成功后输出 `MESHAUDIO_SESSION` 结构化日志，连接销毁时输出断开事件。管理器按会话 ID 保留状态及真实 IP，不再把 RTSP 探测或 PCM 连接当成手机已连接，也不因暂停音频 3 秒而把连接判为离线。
- 音频停止时电平与过时延迟清零/置空；连接和正在收音分开显示。
- 取消 `-vs 0` 路径原来的 1 FPS 宣告，使用原生默认帧率，视频管线仍关闭。这是针对手机视频卡顿的参数修复；真实 iPhone 视频与直播表现仍需复测。
- 来源卡片提供二次确认删除，清理线路、进程、来源及来源出线；其他线路保持运行。
