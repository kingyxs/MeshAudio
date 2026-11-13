# Windows Native Audio Helper

This directory contains the Windows-native output boundary for MeshAudio. It builds a standalone `meshaudio-native.exe` helper and a reusable `MeshAudioNative` static library.

## Build

Prerequisites:

- Visual Studio 2022/18 Desktop development with C++ workload.
- Windows 10/11 SDK.
- CMake 3.24 or newer.

From the repository root, run PowerShell with an absolute tool path when the tools are not on `PATH`:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\tools\build-native.ps1
```

The script discovers `VsDevCmd.bat`, the Visual Studio-bundled CMake, and the newest Windows SDK. Explicit paths are supported:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\tools\build-native.ps1 `
  -VsDevCmdPath 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat' `
  -CMakePath 'C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
```

The default output is `desktop/native/build/meshaudio-native.exe`. The script uses the Visual Studio developer environment and a native `NMake Makefiles` CMake generator, so `cl.exe`, Windows SDK headers, and libraries are resolved from that environment.

## Commands

```powershell
.\desktop\native\build\meshaudio-native.exe --capabilities
.\desktop\native\build\meshaudio-native.exe --list-devices
.\desktop\native\build\meshaudio-native.exe --probe --duration-ms 1000 --frequency 440
.\desktop\native\build\meshaudio-native.exe --probe --device '<endpoint-id>'
```

`--list-devices` writes one JSON object per line. The first object reports capabilities; subsequent objects are active WASAPI render endpoints with their stable endpoint IDs, friendly names, `data_flow: "render"`, and default-device flag. `--list-endpoints` writes one machine-readable JSON object containing both active render and capture endpoints and their `data_flow` values. `--detect-vbcable` reports whether exactly one VB-CABLE `CABLE Input` render endpoint and one `CABLE Output` capture endpoint were found, using both friendly names and cable-related endpoint IDs. A missing external driver is reported clearly and is never installed or emulated by MeshAudio.

`--engine [--device ID] [--target-ms N] [--wav PATH]` is the low-latency mixing mode used by `server.js`: the helper owns the per-source jitter queues, bus mixing, gain/mute and limiting, and renders one WASAPI engine period at a time (2.67 ms on endpoints that support `IAudioClient3`, 10 ms otherwise). `--target-ms` sets the jitter buffer depth (default 25 ms; raise it on congested Wi-Fi, where packets arrive in bursts). `--wav PATH` writes the rendered mix to a 16-bit WAV file instead of a device and paces itself in real time, which is how `tools/analyze-wav.js` verifies that clock tracking does not drop samples.

Clock tracking is done by resampling, not by dropping frames: a PI controller on queue depth moves a fractional read cursor over the sample FIFO and reads with Catmull-Rom interpolation (rate limited to +-8 %). Dropping individual samples to follow the device clock is what previously produced an audible click train.

`--probe` opens the selected endpoint, or the default console render endpoint, in shared mode and plays a deterministic 0.2-amplitude stereo sine tone. It is intended as a repeatable hardware/probe check and does not alter the system default device.

## Stdin PCM protocol

`--stdin-pcm` accepts a simple binary protocol suitable for a future Node launcher. All integers are little-endian:

1. A 16-byte stream header: ASCII `MAPC`, `uint16` version `1`, `uint16` channel count (`1..8`), `uint32` sample rate (`8000..384000`), and `uint32` reserved (`0`).
2. Zero or more blocks: `uint32` frame count (`1..1048576`) followed by `frame_count * channels` IEEE float32 samples, interleaved.
3. A final `uint32` frame count of `0` terminates the stream.

The helper converts the input to the endpoint's WASAPI mix sample rate, channel count, and supported PCM/float sample representation. It reports malformed framing, endpoint failures, buffer timeouts, and playback errors on stderr and returns exit code `2`.

Writes are demand-driven: the render loop checks `IAudioClient::GetCurrentPadding` first and only waits on the WASAPI event when the endpoint buffer is full. Waiting before every block would cap throughput at one block per device period, so blocks smaller than the shared-mode period (for example 5 ms blocks against a 10 ms period) would be consumed at half speed and the producer's queue would overflow. The stdin loop also joins the MMCSS `Pro Audio` task and runs at `THREAD_PRIORITY_TIME_CRITICAL` for the duration of playback, so the pipe read and WASAPI write path is not preempted by background work.

A 20-second `--stdin-pcm` feed must finish in approximately 20 seconds of wall time; a measured value near 40 seconds means the demand-driven write path regressed.

Example Node producer shape for an empty stream (a zero-length frame terminates playback):

```powershell
node -e "const {spawnSync}=require('node:child_process'); const h=Buffer.alloc(16); h.write('MAPC'); h.writeUInt16LE(1,4); h.writeUInt16LE(2,6); h.writeUInt32LE(48000,8); const end=Buffer.alloc(4); const r=spawnSync('.\\desktop\\native\\build\\meshaudio-native.exe',['--stdin-pcm'],{input:Buffer.concat([h,end]),stdio:['pipe','inherit','inherit']}); process.exit(r.status ?? 1);"
```

For real audio, append one or more frame-count/data blocks before the final zero frame count; Node `Buffer` methods `writeUInt32LE` and `writeFloatLE` match the protocol above.

## Scope and limitations

- This is a Windows shared-mode WASAPI render sink. It does not require or modify a system default endpoint.
- `AudioSink` consumes interleaved float32 PCM; the helper performs linear sample-rate conversion and basic channel mapping before writing to the endpoint mix format.
- `--list-devices` enumerates active render endpoints; `--list-endpoints` enumerates both render and capture endpoints. `--detect-vbcable` looks for an external `CABLE Input` render + `CABLE Output` capture pair.
- VB-CABLE is an external dependency. MeshAudio writes to `CABLE Input`; recording applications read `CABLE Output`. The helper never installs, signs, emulates, or changes Windows defaults.
- There is no MeshAudio kernel driver, exclusive-mode path, loopback capture requirement, named-pipe transport, or device installation logic in this target.
- Hardware playback and latency should be verified on the target Windows machine with an actual render endpoint. A successful build alone does not prove that an endpoint can be opened.
