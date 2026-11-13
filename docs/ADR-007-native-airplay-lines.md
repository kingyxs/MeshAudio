# ADR-007：MeshAudio 管理原生多线路 AirPlay 接收

日期：2026-11-13

## 决策

每条 iOS 来源由 MeshAudio 创建独立的原生 UxPlay 1.73.6 进程（`-vs 0`）和独立 PCM bridge。UxPlay 的音频管线通过 loopback TCP 把 48 kHz、S16LE、双声道 PCM 交给 MeshAudio；bridge 再进入普通来源、通道和输出图。没有切换 Windows 默认设备，也不创建视频渲染窗口。

## 原因

旧的 Qt 便携包装器拥有自己的托盘、视频渲染和系统声卡路径，无法保证画布控制。独立进程、独立端口、独立稳定来源 ID 能让停止、断流和多台手机互不影响，同时保留替换接收器的边界。

## 替代方案

- 继续使用 `leapbtw/uxplay-windows`：拒绝，托盘/视频渲染和参数覆盖不可控。
- shairport-sync：可作为未来音频后端，但当前 Windows 构建与 AirPlay 2 能力验证不足。
- VB-CABLE 采集：拒绝作为主链路，会绕过画布并改变系统设备状态。

## 风险与边界

UxPlay 为 GPL-3.0-or-later，开发包必须保留对应源码、补丁和许可证。AirPlay 发送端自带缓冲，MeshAudio 只能展示内部 bridge 统计，不能承诺端到端实时通话延迟。iOS 网页二维码不能自动打开控制中心的设备选择器；用户仍需手动选择线路。真实 iPhone、Bonjour 和防火墙需在目标电脑上手工验收。
