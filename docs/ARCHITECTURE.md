# MeshAudio 技术方案（Windows 桌面端）

桌面端只支持 Windows 10/11。macOS 已从产品范围移除。桌面端接收 Android/iOS 的独立音频流，按 `source -> bus -> output` 路由混音，输出到系统播放设备或系统级虚拟录音设备；桌面端不捕获系统全局输出，也不替代 Windows 系统混音器。

## 分层

- **控制与 UI**：Node.js 服务承载 HTTP/WebSocket 控制面，Vue 3 三列画布通过 Tauri 2/WebView2 交付。Rust 壳管理随包服务的启动、退出、单实例和托盘。
- **音频引擎**：设备无关的混音、序号检查、丢包推进和抖动缓冲位于 `desktop/audio-engine.js`。服务端按 10 ms 调度渲染 block。
- **输出适配器**：`desktop/native-bridge.js` 以原生桥协议启动 `meshaudio-native.exe`；当前原生路径以独立来源队列混音，由 `WasapiRenderSink` 写入共享模式系统播放端点。JS 引擎与浏览器 `/audio` 保留诊断/降级边界。系统播放不被独占。
- **外部虚拟麦克风**：优先支持用户安装的 VB-CABLE 外部链路。MeshAudio 通过 WASAPI shared mode 写入 `CABLE Input` render 端点，录音应用从 `CABLE Output` capture 端点读取；native helper 负责检测配对，服务端仅在检测成功后启用 `out-virtual`。MeshAudio 不安装或伪造驱动。
- **自有虚拟设备**：仍保留为未来 WDK/SysVAD 项目边界，不属于当前交付。
- **移动入口**：本源码树实际提供 UxPlay AirPlay 媒体接收与网页麦克风。每条 AirPlay 线路是独立的无视频进程，通过本机 PCM 桥进入普通来源图，不直接播放到系统设备。没有交付 Android/iOS 原生 App 或 ReplayKit 扩展；这些仍是原始需求中的后续工作，不能按已完成描述。网页麦克风在 iOS 后台/锁屏可能停止。
- **共享协议**：协议版本、流元数据和音频帧格式独立于实现，当前实现为 UDP/音频 WebSocket 输入、WebSocket/HTTP 控制面及广播发现；AirPlay 的 mDNS 由 UxPlay/Bonjour 提供。

## 数据流

移动节点分别为媒体和麦克风建立 `sourceId`，发送带序号、时间戳和格式标识的音频帧。桌面端按来源维护抖动缓冲；同一总线的来源相加并应用来源/总线增益和静音；总线结果可扇出到系统播放和虚拟录音设备。控制面断开只影响画布状态同步，不停止已经建立的音频接收。

## 可替换边界

协议层可替换 UDP/Opus/WebRTC；音频输出可替换 WASAPI、ASIO 或外部虚拟设备；UI 与音频引擎通过稳定的 `source/bus/output/route` 状态模型通信。所有适配器必须报告能力和错误，不得把平台限制伪装成成功。
