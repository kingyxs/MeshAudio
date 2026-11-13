# 第三方源码与分发

本项目不把更换 LICENSE 当作完整合规。二进制公开时必须同步提供：

1. `MeshAudio-0.3.1-source.zip`：干净项目源码、修改版 UxPlay 快照、上游提交/补丁、锁文件、构建脚本、许可和文档。
2. `MeshAudio-0.3.1-third-party-sources.tar.gz`：实际 AirPlay DLL 闭包对应的完整 MSYS2 来源包，以及 Rust MPL 组件的 `.crate` 原始来源包。MSYS2 `.src.tar.*` 包含上游源码归档、PKGBUILD 和分发补丁。
3. `SHA256SUMS.txt`：上面两个文件与安装包的摘要。

生成并核验的材料：

- `third_party/uxplay.lock.json` 固定 UxPlay 上游版本和提交，`uxplay-meshaudio.patch` 记录修改。源码快照保留原文件许可。
- `third_party/airplay-dependencies.lock.json` 记录实际运行依赖、文件归属、来源 URL 和 SHA-256；不是整台开发机的已装软件清单。
- `tools/build-minimal-codecs.js` 与 `.sh` 固定 FFmpeg/gst-libav 来源和音频解码配置，不启用 GPL/nonfree 编码组件。
- `tools/package-uxplay.js` 只收集 PE 实际导入闭包；`tools/prepare-airplay-sources.js` 获取精确对应的完整来源包，并拒绝未知文件或缺失版本。
- `tools/prepare-license-notices.js` 收集 npm、Windows 目标 Rust 依赖与 Node 的许可文本，并补充 MPL 来源包；Node 文本必须匹配实际随包版本。
- `tools/export-public-source.js` 导出允许清单、扫描隐私/意外文件并生成版本化源码交付物，不修改原工作目录和用户配置。

## 运行依赖与构建差异

MSYS2 原版 FFmpeg 包可能为 GPL 配置且包含大量无关库。本项目用同版本完整来源自行构建 LGPL AAC/ALAC-only 版本，实际旗标以脚本为准，不用原版包的许可/配置描述冒充自建 DLL。来源包同时保留原分发配方，方便审查差异。

GCC Runtime Library Exception 允许相应支持库的使用；不随应用分发整个编译器。LGPL 动态库保持为独立 DLL，允许用户替换兼容修改版。MPL 源文件的许可保持原样。全部第三方版权与许可证不得删除。

## 公开前

运行 `node tools/prepare-airplay-sources.js`、`node tools/prepare-license-notices.js`，再执行导出与发布校验。源码与安装包应作为同一 Release 的并列附件上传，不要只上传二进制。没有自动创建仓库或向远程推送的步骤。
