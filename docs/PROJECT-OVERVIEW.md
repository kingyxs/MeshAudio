# MeshAudio 项目说明

本文是 MeshAudio 的完整项目说明，面向使用者、贡献者与发布审查者。它描述**当前 0.3.1 源码树实际交付了什么**，并明确哪些属于设计目标但尚未交付。更细的实现见 [技术方案](ARCHITECTURE.md)、[协议约定](../protocol/README.md) 与各 ADR；发布与合规以 [发布指南](RELEASE.md)、[许可说明](LICENSING.md) 为准。

## 1. 项目定位

MeshAudio 解决的是「一台 Windows 电脑上，如何自由安排多路手机音频的去向」：

- 手机刷视频的声音接到某个通道，通道接到耳机，耳机听到；
- 同一台手机的麦克风接到另一个通道，通道接到虚拟麦克风，电脑上的会议软件把它当作麦克风使用；
- 两者互不干扰，随时可以改线，改线不中断其他链路。

设计原则：**移动端只负责采集与推送，每一路流作为独立来源进入画布；混音与路由决策全部发生在桌面端画布上**。桌面端不捕获系统输出音频，不独占系统音频输出，也不依赖移动端才能运行。

典型场景：局域网内的多设备音频汇聚、直播/会议中的音源分配、把手机声音送进电脑应用、低成本多来源监听。系统定位是可信局域网内的本地工具，不是公网音频服务。

## 2. 核心模型：三列画布

| 列 | 含义 | 规则 |
| --- | --- | --- |
| 第一列：来源 | 一路独立音频流，标识为「设备名 + 媒体/麦克风 + 在线状态 + 实时电平」 | 一个移动节点可贡献多个来源；离线时置灰但**不删除**，连线保留 |
| 第二列：混音通道 | 用户创建的混音总线，带增益、静音与混合后电平 | 单路来源为透传，多路相加为混合；数量由用户决定 |
| 第三列：外部输出 | 系统播放设备（耳机/扬声器）、外部虚拟录音设备 | 一个通道可连接多个输出 |

连线规则：**来源 → 通道 → 输出**，均为多对多；来源不能直连输出（混音必须发生在通道层）；连线变化实时生效且不中断其他链路；单路断流只影响该来源。画布状态以 `sources / buses / outputs / routes` 模型保存，升级时保留。

交互上，按住圆形端口拖动即可连线：预览线与高亮提示合法目标，松开提交，Esc / 空白处松开 / 失焦取消；支持反向拖动、真实触控事件与 Tab/Enter 键盘操作。点击曲线可选中连线并在中点删除。卡片顶部手柄可上下移动；滚轮默认滚动页面，点击画布后画布获得蓝色焦点边框并接管内部滚动，Esc、点击外部或窗口失焦释放。

## 3. 系统组成

```
移动节点 / iPhone / 浏览器
   │  UDP MSA1 音频（默认 4175）／音频 WebSocket 兼容入口
   │  HTTP + WebSocket 控制面（默认 4173）／UDP 广播发现（4174）
   ▼
Windows 桌面端
   ├─ server.js        控制面、发现、音频入口、快照与遥测
   ├─ desktop/         引擎、AirPlay 线路、原生桥、组件安装流程
   ├─ desktop/native/  共享模式 WASAPI 混音与输出（meshaudio-native.exe）
   └─ desktop-app/     Vue 3 画布 + Tauri 2 壳（WebView2）、托盘与生命周期
                          │
                          ├─ 系统播放端点（共享模式，不独占）
                          └─ 外部虚拟录音端点（VB-CABLE）
```

- **桌面端**：Node 控制面提供 HTTP 快照与 WebSocket 增量；Rust/Tauri 壳负责单实例、随包服务启停与托盘；Vue 3 三列画布负责交互；原生引擎按 WASAPI 时钟混音输出。控制面短暂断开不会停止已经建立的 UDP 音频面。
- **Android 原生节点**：Java 实现，前台服务常驻通知，麦克风与 `AudioPlaybackCapture` 媒体音频分别启动、独立推送、分别标识；媒体会话每次重新申请系统授权；设备 ID 与流序号跨重启稳定。不做混音、不做路由决策、不传输屏幕画面。
- **AirPlay 接收**：修改版 UxPlay 以无视频独立进程运行，需要 Bonjour，iPhone 在控制中心手动选择接收端；每条线路作为普通来源进入画布，不直接播放到系统设备。二维码只展示连接说明，不能代替系统选择器。
- **网页麦克风入口**：`browser-node.html` / `browser-node.js` 提供浏览器采集入口；远程麦克风权限需要可信 HTTPS，iOS 锁屏/后台可能暂停。

## 4. 协议与数据流

共享协议 v1 见 [protocol/README.md](../protocol/README.md)：

- **发现**：移动端向 UDP 广播 `255.255.255.255:4174` 发送 `meshaudio.discover`，桌面端返回控制端口、音频端口与由 `deviceId + streamType` 派生的稳定 `sourceId`。发现即注册来源，没有音频包时仍保留并显示离线。
- **音频帧**：`MSA1` 20 字节小端头（魔数、`sourceHash`、`sequence`、`timestampUs`）+ 交织 float32 PCM；48 kHz 时推荐每包 120 帧（约 980 字节，2.5 ms），避免 IP 分片。当前为 PCM，**未实现 Opus / 省带宽编码**。
- **控制面**：WebSocket `/control` 支持 `state.get`、`config.patch`、`source.mute/gain/stop/start` 与周期遥测推送；遥测只更新电平/延迟/包计数，不写配置、不重置音频缓冲。
- **输出桥**：Windows 生产路径用 `MSMP v1` 把原始 PCM 与路由配置交给 native helper；`MESHAUDIO_ENGINE=node` 保留诊断回退。虚拟麦克风走外部 VB-CABLE（`CABLE Input` 写入 / `CABLE Output` 读取）。

延迟显示值是 MeshAudio 内部接收、抖动缓冲与渲染段的测量，**不是**手机采集到扬声器的完整端到端延迟。UDP MSA1 没有加密与身份认证，只能在可信局域网使用；防火墙、AP 隔离、访客网络会阻止发现。

## 5. 功能清单（当前实现）

**桌面端**：三列画布；来源在线/电平/离线置灰；通道增益与静音；拖拽/键盘/触控连线与删除；扇出、汇聚、非法连线拦截；连线变化不中断其他链路；系统播放（共享模式）与外部虚拟麦克风输出；局域网广播发现；二维码连接详情；实时遥测；首次使用引导与组件自动配置；设置页重新打开引导、检查并重下缺失依赖；托盘驻留、关闭窗口仅隐藏、退出需托盘菜单；升级保留来源/通道/连线/设置。

**组件安装**：Bonjour 与 VB-CABLE 从原厂下载，固定 SHA-256、验证发布者签名、串行安装并等待安装结果；支持取消/重试、待重启状态、已安装跳过、缺包修复与依赖循环拒绝；不自动启动接收线路，不下载第三方托盘包装器，不在用户机器上编译插件。管理员确认、许可点击和可能的重启仍由用户完成。

**Android 节点**：独立启停两路采集；前台服务与常驻通知；授权撤销立即停止对应流；控制面断开重连不打断音频；兼容音频 WebSocket 队列受限；稳定设备 ID 与按路预留序号。

**AirPlay**：UxPlay 随主安装包自动部署；设置中的「自动配置 AirPlay」可补齐缺失 Bonjour；接收线路仅在用户添加/启动后启用；音频经 MeshAudio 路由，无视频窗口。

## 6. 平台矩阵与硬约束

| 项目 | 状态 |
| --- | --- |
| Windows 10/11 x64 桌面端 | 交付（含 NSIS 安装包） |
| Android 10 / API 29+ 原生节点 | 交付；公开包为 `MeshAudio-Android-0.3.1-release.apk`（独立发布密钥签名），debug 包仅用于内部真机验收，两者签名不同、不能直接覆盖安装 |
| AirPlay 媒体接收（需 Bonjour） | 交付 |
| 网页麦克风 | 交付；非 iOS 原生后台采集 |
| 自有系统级虚拟音频输入设备 | **未交付**，当前依赖外部 VB-CABLE |
| iOS 原生 App / ReplayKit 广播扩展 | **未交付** |
| macOS / Linux 桌面端 | 不支持 / 未交付 |

不可突破的边界：不捕获 Windows 全局输出；系统播放使用共享模式、不替代系统混音器；移动端不做混音与路由决策；不承诺 iOS 媒体流「一次授权永久自动」；不绕过 Android 14 的每次授权确认；不把 VB-CABLE 或 Bonjour 打包进本项目的二进制/源码。

## 7. 目录结构与关键入口

| 路径 | 说明 |
| --- | --- |
| `server.js` | 控制面、发现、音频入口、快照、遥测与配置持久化 |
| `desktop/audio-engine.js` | 设备无关的混音、序号检查、丢包推进与抖动缓冲 |
| `desktop/native-bridge.js`、`desktop/native/` | 原生桥协议与 WASAPI 共享模式输出（C++） |
| `desktop/airplay/` | AirPlay 线路管理、组件安装流程、资源准备 |
| `desktop-app/src/` | Vue 3 画布、状态、设置、首次引导与单元测试 |
| `desktop-app/src-tauri/` | Tauri 2 壳、随包服务生命周期、图标与 capabilities |
| `android/app/` | Android 交付应用；`test-player/`、`device-driver/` 仅测试用 |
| `browser-node.html` / `.js` | 网页麦克风入口 |
| `protocol/README.md` | 共享协议 v1 规范 |
| `third_party/` | UxPlay 源码快照与补丁、Bonjour 开放头文件、依赖锁定清单 |
| `tools/` | 构建、隔离回归、许可证/对应源码准备、公开源码导出 |
| `docs/` | 安装、构建、架构 ADR、验收记录、发布与限制 |
| `.github/workflows/ci.yml` | Windows 与 Android 的 CI |

配置保存在 `%APPDATA%\com.meshAudio.desktop\`，包含来源、通道、连线、组件状态与引导完成记录。

## 8. 安装、构建与测试

**使用者**：运行 Windows x64 安装包；无需预装 Node 或编译工具；缺少 WebView2 时安装器联网获取。完整步骤见 [Windows 安装与首次使用](WINDOWS-INSTALLATION.md)，排错涉及防火墙、UAC、重启与卸载。

**构建**：Windows x64 + Node.js 22.12+ + Rust MSVC + Visual Studio C++/Windows SDK + CMake；AirPlay 另需 MSYS2 UCRT64、GStreamer 开发包与 Bonjour 开放头文件；Android 另需 JDK 17 + Android SDK 35。完整顺序见 [PUBLIC-BUILD.md](PUBLIC-BUILD.md) 与 [RELEASE.md](RELEASE.md)。发布附件必须由最终构建生成并重新核验摘要，不能只替换版本号。

**测试**：`npm test`、`npm run test:all`、前端 `npm test --prefix desktop-app`、组件隔离与 UI 回归脚本、`tools/` 下的协议/WebSocket/解码器/打包资源检查，以及 `.github/workflows/ci.yml` 的 Windows + Android CI。UI 回归需要 Microsoft Edge 与 playwright-core，使用临时数据目录，不替换用户配置。

## 9. 版本与验收状态

| 版本 | 定位 |
| --- | --- |
| 0.3.0 | 验收候选版：端口拖动连线、首次使用引导、可选组件安装、公开源码整理与 NSIS 包解包启动验证 |
| 0.3.1 | 验收候选版：AirPlay/UxPlay 自动配置、画布滚轮焦点、连线选择与删除控件，并重新导出公开源码 |
| Android 0.3.1 | 原生节点打包与真机（USB reverse / Wi-Fi UDP）验证；真机证据绑定 debug 包，公开附件为另行签名、未在真机重跑的 release 包 |

已通过的本机检查：前端 19 项单元测试、拖线与引导 13 项检查、原页面回归、组件生命周期与自动配置隔离测试、服务/传输/双线路回归、随包 AAC-LC/ALAC 解码、NSIS 42 个运行文件摘要核验、解包后实际 WebView2 应用启动验证、Android 两组真机 15 项检查。逐版明细见 [ACCEPTANCE-0.3.0.md](ACCEPTANCE-0.3.0.md)、[ACCEPTANCE-0.3.1.md](ACCEPTANCE-0.3.1.md)、[ACCEPTANCE-ANDROID-0.3.1.md](ACCEPTANCE-ANDROID-0.3.1.md)。

**仍未通过 / 未完成**：干净 Windows 系统上的完整安装、WebView2 首次获取、真实 UAC 取消重试、驱动重启与卸载；真实 iPhone 的 AAC-ELD 会话、耳机听感、两台设备并发、网络抖动与 30 分钟连续性；历史长测的音频波形跳变问题；Windows 商业代码签名证书；签名版 Android release 包的真机复验（现有真机证据绑定同源码的 debug 包，签名不同且不能直接覆盖安装）。解包启动、模拟安装器、合成音频与短时真机测试都不能代替这些门禁。完整清单见 [KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md)，发布时不得删除或改写为「已通过」。

## 10. 后续路线（非承诺）

1. 修复音频连续性：自适应抖动缓冲、缺口 PLC、时钟长期偏差补偿，并用真机长测闭环。
2. Android 真机回归扩展：在签名 release 包上复跑双流、息屏、网络切换、授权撤销，并覆盖更多厂商与系统版本；发布密钥离线备份与轮换流程。
3. 传输与编码：Opus / 省带宽模式、mDNS 发现、接收/渲染线程下沉以消除 Node 事件循环抖动。
4. 平台能力：iOS 原生后台麦克风与 ReplayKit 广播扩展、MeshAudio 自有 WDK/SysVAD 虚拟设备（需驱动签名与安装流程）。
5. 发布工程：代码签名证书、干净 Windows 门禁、升级迁移、日志轮转与诊断包。

## 11. 许可、合规与贡献治理

自有代码：**GPL-3.0-or-later**（SPDX `GPL-3.0-or-later`，许可证全文见 [LICENSE](../LICENSE)）。允许在遵守 GPL 条件下使用、修改与商用；「or later」表示你可以选择 GPLv3 或任何后续版本。第三方组件保留各自许可与版权，详见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)、[LICENSES/README.md](../LICENSES/README.md) 与 [THIRD-PARTY-SOURCES.md](THIRD-PARTY-SOURCES.md)；完整政策见 [LICENSING.md](LICENSING.md)。

公开分发二进制时，必须在同一个 Release 并列提供**同版本**的项目源码包、完整第三方对应源码包与 `SHA256SUMS.txt`；不得只发布安装包，不得用其他版本的源码顶替。动态链接的 LGPL 库保持可替换；VB-CABLE 与 Bonjour 不从本项目再分发。

贡献前请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md) 并签署 [CLA.md](../CLA.md)（签署记录见 [contributors/README.md](../contributors/README.md)）。安全报告走 [SECURITY.md](../SECURITY.md) 的私有渠道。

## 12. 常见问题

- **没有声音**：确认通道增益非零、未静音、来源在线且存在通道→输出连线；系统播放未独占，虚拟输出需检测到 VB-CABLE 配对端点。
- **发现不到设备**：确认手机与电脑同网段、防火墙允许 UDP 4174/4175、不是访客网络或 AP 隔离；应用内可手动填写电脑 IPv4。
- **iPhone 无法自动接入**：AirPlay 必须用户在控制中心手动选择接收端；二维码只展示说明，不能代替系统选择器。
- **提示未知发布者**：安装包当前没有商业代码签名，SmartScreen 可能拦截，需确认来源与 `SHA256SUMS.txt` 后再运行。
- **升级后设置丢失**：配置保存在 `%APPDATA%\com.meshAudio.desktop\`；普通退出请用托盘菜单，关闭窗口仅隐藏。
