# 网页麦克风配置和验收

更新：2026-11-13。画布入口已改为“添加网页麦克风”；iOS 来源的线路二维码也打开同一套 iOS 网页麦克风页面，保留关联 AirPlay 名称提示。麦克风注册为独立来源，不把人声混入 AirPlay 媒体来源身份。

## 访问与证书

桌面控制面继续使用 loopback 的 4173。独立手机网关使用 LAN 4176 HTTP 引导和 4177 HTTPS 音频入口；只允许麦克风页面、脚本、公开 CA 证书、来源注册及带 token 的音频 WebSocket。配置、组件管理、控制 WebSocket、服务代码和私钥均不通过手机网关提供。

首次在 Windows 项目目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/configure-web-microphone.ps1
```

脚本优先使用项目 MSYS2 的 OpenSSL，否则使用 PATH 中的 OpenSSL。默认在 `%APPDATA%/com.meshAudio.desktop/web-microphone/` 创建本机 CA、带当前 IPv4 SAN 的 365 天服务器证书、私钥和可下载的 `ca.cer`。私钥目录只授权当前 Windows 账户和 SYSTEM；不会自动向 Windows 或手机的信任存储安装根证书。已有 CA 保留；IP 变化或服务器证书过期时用 `-Renew` 更新服务器证书，不必更换 CA。

重启 MeshAudio，手机和电脑连接同一局域网。扫码进入 HTTP 指引页，下载本机证书，在 iPhone“设置 → 已下载描述文件”完成安装，再在“通用 → 关于本机 → 证书信任设置”开启对 **MeshAudio Web Microphone Local CA** 的完全信任。只信任自己电脑生成的证书，勿分享 `ca.key` 或 `server.key`。返回指引页，点击“打开 HTTPS 麦克风页面”，再点击“开始推流”并授权麦克风。

本机本轮已运行证书配置脚本；iPhone 的安装及完全信任需用户在设备上完成。不能只在证书警告页点击继续就认定已经建立可信采集环境。

首次防火墙配置需要管理员执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/configure-airplay-firewall.ps1
```

脚本仅开放 Private/LocalSubnet，包含 4176、4177 与 AirPlay 接收端口；不会开放桌面控制接口。当前非管理员会话未替用户安装新规则。

## 配置

| 配置 | 默认 | 用途 |
| --- | --- | --- |
| `MESHAUDIO_AIRPLAY_GUIDE_PORT` | 4176 | HTTP 设置页；测试中可用 0 分配端口 |
| `MESHAUDIO_WEB_MIC_TLS_PORT` | 4177 | HTTPS/WSS；测试中可用 0 |
| `MESHAUDIO_LAN_BIND_HOST` | `0.0.0.0` | 手机网关、发现及音频入口地址 |
| `MESHAUDIO_WEB_MIC_CERT` | 数据目录下 `server.crt` | PEM 证书/证书链 |
| `MESHAUDIO_WEB_MIC_KEY` | 数据目录下 `server.key` | PEM 私钥 |

也可使用手机已经信任的自有 HTTPS 证书。证书必须包含实际访问主机名或 IP；不要关闭 TLS 验证。指定证书缺失或无效时，服务保留 HTTP 帮助页并记录 HTTPS 错误，不会假称麦克风可用。

## 行为和限制

- `/ios-node.html` 与 `/line/<id>` 只提供麦克风操作，不提供“网页音频”选择，不定时刷新页面。开发诊断页 `/browser-node.html` 保留本地文件/测试音模式。
- 网页只能采集麦克风，不能采集其他 App 音频，也不能打开 iOS 屏幕镜像设备选择器。
- iOS 网页需保持前台。iPhone/iPad 用户代理下页面隐藏会停止麦克风；回到前台需手动重新开始。没有原生后台录音或 ReplayKit 保活承诺。
- 删除来源会撤销对应 token、关闭活跃音频连接、释放页面麦克风，并移除来源和出线。迟到 UDP 包不会重新创建来源；用户在页面重新点击开始会明确注册并重新添加稳定 ID 的来源。其他手机的重新发现/注册同样视为重新添加。
- 删除不会更改其他来源、通道或通道到输出的连线。停止来源则保留其连线。
- 所有网页资源随桌面程序打包，手机访问不依赖开发服务器。

## 自动验收

各测试按顺序运行；AirPlay 原生端口由测试共同使用，不能并行启动这些脚本。

```powershell
npm run test:all
npm run test:source-regression
npm run test:airplay-ui
npm run test:packaged
```

`test:source-regression` 是 Windows 集成测试，需先配置本机证书；存在 VB-CABLE 时，只采集 **CABLE Output** 验证本项目测试音，绝不捕获系统全局输出。缺少 VB-CABLE 则明确记录该项跳过。测试使用隔离数据目录，不覆盖用户来源和路由。

检查：真实 TLS 握手及 IP SAN、手机入口不暴露控制 API、浏览器模拟麦克风采集、删除活跃来源后停止采集、迟到包抑制、显式重新开始、窄屏无溢出、来源动作按钮可见。结果见 `testing/airplay/source-lifecycle-report.json`。

## 必须保留的真机验收

1. iPhone 安装并信任证书后，以真实 Safari 打开 HTTPS 页面，允许录音。
2. 画布将网页麦克风 → 通道 → 系统播放/VB-CABLE，确认音质、声道和实际延迟。
3. 删除来源，确认麦克风权限指示消失；重新开始后可再次接入。
4. 切后台/锁屏，确认停止提示；返回后重新点击开始。
5. AirPlay 连接后暂停视频超过 3 秒，来源仍在线但不显示虚假电平；真正断开后离线。
6. 视频及直播分别测试声音和卡顿、两台真实 iPhone 同时连接、30 分钟稳定性与网络波动。

自动注入 PCM、模拟浏览器设备和本地 VB-CABLE 回读均不能替代这些真机结论。
