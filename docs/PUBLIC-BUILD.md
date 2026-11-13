# 从公开源码构建 Windows 版

## 工具

- Windows x64，Node.js 22.12+，npm，Rust stable MSVC。
- 用锁文件安装依赖；Windows 检出时保留 `.gitattributes` 的 shell 脚本 LF 行尾。
- Visual Studio C++ 桌面开发工具、Windows SDK、CMake。
- AirPlay 构建使用 MSYS2 UCRT64，安装 GCC、CMake、Ninja、pkgconf、Meson、make、diffutils、tar、zstd，以及 GStreamer、gst-plugins-base/good/bad/libav、libplist、OpenSSL 开发包。
- 构建 UxPlay 时需要已安装的 x64 Bonjour；公开头文件在 third_party/bonjour/Include，导入库在本机生成，不分发 Apple 的 dnssd.dll。

## 构建顺序

```powershell
npm ci
npm ci --prefix desktop-app
npm run build:native
$env:MESHAUDIO_MSYS2 = 'C:\msys64'
node tools/build-minimal-codecs.js
powershell -ExecutionPolicy Bypass -File tools/build-uxplay.ps1 -MsysRoot $env:MESHAUDIO_MSYS2
node tools/prepare-airplay-sources.js
npm run test:all
npm test --prefix desktop-app
npm run tauri:build --prefix desktop-app -- --bundles nsis
```

`build-minimal-codecs.js` 从固定 SHA-256 的完整来源包构建仅 AAC/ALAC 解码的 FFmpeg 与 GStreamer libav 插件，避免带入视频编码器和无关依赖。`package-uxplay.js` 收集实际导入闭包；不会打包系统 DLL。源码目录包含修改后的 UxPlay 快照。构建脚本不自动更新上游代码。

构建前资源准备脚本验证 Node、原生引擎、接收器与许可证材料均存在；缺失时失败，不生成假装自包含的包。依赖许可/对应源码准备见 THIRD-PARTY-SOURCES.md。

NSIS 产物在 `desktop-app/src-tauri/target/release/bundle/nsis/`。主程序在 `target/release/meshaudio-desktop.exe`，必须与生成的 resources 目录一起使用，不能单独复制 exe 作为便携包。

## 本地开发

Android 原生节点可单独构建：JDK 17 + Android SDK 35 后运行 `tools/build-android.ps1`，或进入 android 使用固定版本的 Gradle Wrapper。首次配置可用 `tools/setup-android.ps1`；详见 android/README.md。Android 的 debug APK 与桌面 NSIS 是不同产物，不把测试驱动或测试播放器打入主应用。

```powershell
$env:MESHAUDIO_NATIVE_AUDIO = '1'
npm start
```

前端在另一个终端执行 `npm run dev --prefix desktop-app`。生产 Tauri 应用会自动启动随包服务和原生引擎，无需设置上述环境变量。

## 检查

```powershell
node tools/test-component-setup.js
node tools/test-bundled-airplay-setup.js
node tools/test-components.js --skip-download
npm run check --prefix desktop-app
npm test --prefix desktop-app
./desktop/native/build/meshaudio-mix-test.exe
```

UI 回归需要 Microsoft Edge 与 playwright-core；可执行 `npm install --prefix .build-tools/ui-check --no-save playwright-core`，再运行 `node tools/test-routing-setup-ui.js` 和 `node tools/test-airplay-ui.js`。它们使用临时数据目录，不替换用户配置。实际安装包验收须另在干净 Windows 中检查 UAC、WebView2、重启和卸载路径。
