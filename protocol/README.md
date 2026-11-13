# MeshAudio 共享协议 v1

## 发现

移动端向 UDP 广播地址 `255.255.255.255:4174` 发送一条 JSON 请求：

```json
{
  "type": "meshaudio.discover",
  "protocol": 1,
  "deviceId": "persistent-device-id",
  "deviceName": "Android",
  "streamType": "mic",
  "sampleRate": 48000,
  "channels": 2,
  "codec": "pcm_f32le"
}
```

桌面端只接受协议版本 `1`、非空设备信息和 `mic`/`microphone`/`media` 流类型，并返回：

```json
{
  "type": "meshaudio.discover.response",
  "protocol": 1,
  "controlPort": 4173,
  "audioPort": 4175,
  "port": 4175,
  "sourceId": "稳定的 8 位十六进制哈希",
  "streamId": "device-id:microphone",
  "streamType": "microphone"
}
```

来源以 `deviceId + streamType` 派生稳定 ID。发现即注册来源；没有音频包时来源仍保留并显示为离线。桌面端不会返回或使用硬编码 IP 兜底。

## 流元数据

每一路流独立声明：`deviceId`、`deviceName`、`streamId`、`streamType`（`media` 或 `microphone`）、`sampleRate`、`channels`、`codec`、`sourceId`、`online`。桌面端保留离线节点及所有合法连线。服务端按 float32 负载计算 RMS，仅用于电平诊断。

## 音频帧

UDP `audioPort`（默认 `4175`）。固定 20 字节 little-endian 头：

```text
0..3    ASCII "MSA1"
4..7    sourceHash uint32
8..11   sequence uint32
12..19  timestampUs uint64
20..    stereo/interleaved float32 PCM little-endian

低延迟模式下，发送端应将单个 UDP 包控制在 1200 字节以内，推荐 48 kHz
时每包 120 帧（2.5 ms，含 20 字节头后约 980 字节），避免 IP 分片造成
丢包、抖动和明显延迟。序号按音频包递增，时间戳使用采集时刻的微秒值。
```

每个媒体流和麦克风流使用独立 `sourceHash`。Android 当前由持久化设备 ID 与流类型派生，多个设备不会复用固定 `cafe/caff`。

## 控制

WebSocket `/control` 支持：

- `state.get`：请求完整 `state.snapshot`。
- `state.telemetry`（服务端推送）：默认每 5 秒仅更新来源的 `id`、`rms`、`latencyMs`、`packets`、`receiving`，以及 `server.latencyRefreshMs` 和 `measuredAt`。不带配置或拓扑，不触发保存、重连或音频缓冲重置；来源上下线与路由变化仍由完整快照通知。周期可通过 `MESHAUDIO_LATENCY_REFRESH_MS` 调整，最短 1 秒。
- `config.patch`：更新画布配置，服务端重新执行路由约束。
- `source.mute`：按来源 ID 静音/恢复，保留接收统计。
- `source.gain`：按来源 ID 设置 0..4 倍增益。
- `source.stop`：停止来源并保持节点/连线记录。
- `source.start`：恢复已停止来源；节点和连线保留，等待该来源下一次音频包重新上线。`source.resume` 可作为同义兼容消息。

控制面短暂断开不关闭 UDP 音频面。浏览器 `/audio` 是诊断转发；生产 Windows 输出通过 `MSMP v1` 传输原始 PCM 与路由配置，由 native helper 按 WASAPI 时钟混音。`MESHAUDIO_ENGINE=node` 保留旧的 Node 定时器/`MAPC v1` 输出路径，供诊断回退。虚拟麦克风降级使用外部 VB-CABLE：MeshAudio 写入 `CABLE Input`，录音应用读取 `CABLE Output`；未检测到配对端点时输出保持禁用。

`latencyMs` 是 MeshAudio 内部接收/缓冲处理的测量值，不等于手机采集、AirPlay、网络、系统声卡及扬声器的完整端到端延迟；不得把它当作完整无线链路延迟宣称。
