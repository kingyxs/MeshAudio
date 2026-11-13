# 许可说明（GPL-3.0-or-later）

本文说明 MeshAudio 自有代码适用的许可证、第三方组件的边界，以及公开发布二进制时必须履行的义务。它是项目政策说明，**不构成法律意见**；正式对外发行前建议由法务复核。若本文与 [LICENSE](../LICENSE) 文本冲突，以许可证文本为准。

## 1. 自有代码

**MeshAudio 自有代码采用 GNU General Public License version 3 或（由使用者选择）任何更新版本**，SPDX 标识：

```
GPL-3.0-or-later
```

- 许可证全文：[LICENSE](../LICENSE)（未修改的 GPLv3 官方文本）。不要改写许可证正文；「或更新版本」的授权通过项目声明、README 与 `package.json` 的 `license` 字段体现。
- 「or later」的含义：使用者可以按 GPLv3 条款使用，也可以按自由软件基金会后续发布的 GPL 版本条款使用；项目不强制锁定 v3。历史已授予的 MIT 许可不因本版变更而撤销，见 [LICENSES/README.md](../LICENSES/README.md)。
- 版权：`Copyright (C) 2026 MeshAudio Contributors`。贡献者保留自己代码的版权，见 [CLA.md](../CLA.md)；本项目不要求版权转让（copyright assignment）。
- 在 GPL 条件下允许使用、研究、修改、再分发乃至商用；分发派生作品时必须同样以 GPL-3.0-or-later 提供源代码、保留版权与许可声明，并不得附加限制下游行使权利的条款。

适用范围：仓库中由本项目编写的文件，例如 `server.js`、`app.js`、`index.html`、`styles.css`、`browser-node.*`、`desktop/`（自有部分）、`desktop-app/src/`、`desktop-app/src-tauri/src/`、`android/app/src/`、`tools/`、`protocol/`、`docs/`、`.github/workflows/`。现有文件即使未逐一带 SPDX 头，也按本节声明适用 GPL-3.0-or-later；**不要**批量给第三方文件加本项目许可头。

新增源文件的推荐写法（按语言选择注释语法）：

```js
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Your Name
```

```rust
// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Your Name
```

```powershell
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 Your Name
```

从上游拷入的文件必须保留原有版权、许可与 SPDX 标识，并同步更新 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) 与依赖锁定记录。

## 2. 第三方组件

第三方代码**保留各自版权与许可**，不因本项目而重新授权：

| 类别 | 许可示例 | 说明 |
| --- | --- | --- |
| Vue 3 / Pinia / QR Code Generator / Lucide 等 npm 依赖 | MIT、ISC | 完整许可文本收集在安装包 `licenses/npm/` |
| Tauri、serde 等 Rust 依赖 | MIT / Apache-2.0 / MPL 等 | 精确清单见 `licenses/inventory.json`；MPL 组件的 `.crate` 原始包进入对应源码包 |
| Node.js 运行时 | MIT + 内嵌第三方通知 | 按实际随包版本收录 `LICENSES/Node.js-LICENSE.txt` |
| 修改版 UxPlay 1.73.6 | GPL-3.0-or-later | 上游固定提交与本项目补丁见 `third_party/uxplay.lock.json`、`uxplay-meshaudio.patch`；源码快照保留原许可 |
| GStreamer / 插件 / 精简 FFmpeg | LGPL-2.1-or-later 及各自条款 | 自建 AAC/ALAC-only 解码构建，不启用 GPL/nonfree 编码组件；动态库保持独立 DLL，允许用户替换为 ABI 兼容的修改版 |
| GLib、libplist、OpenSSL、GCC 运行库等 | 各自许可 / GCC Runtime Library Exception | 不随应用分发整个编译器 |
| OkHttp / Okio / Kotlin stdlib / Gradle Wrapper（Android） | Apache-2.0 | APK 内附许可文本与通知；SDK 与专有工具不分发 |

完整清单见 [THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md)。设计参考（ComfyUI 文档、Sunshine 架构思路）仅作思路来源，未包含其代码或美术资源；QR Code 是 DENSO WAVE 商标。

**专有可选组件不随本项目分发**：VB-CABLE（VB-Audio，Donationware）与 Apple Bonjour 仅在用户选择后由应用从原厂下载并执行官方安装器，其许可、签名、管理员提示与重启要求按原厂条款执行。本项目不打包、不镜像、不声称它们是开源软件。

## 3. 分发二进制时的义务

每个公开分发的二进制（Windows NSIS 安装包、Android APK、任何随包运行库）都必须与**同版本、可复现的完整对应源码**一起提供：

1. `MeshAudio-<版本>-source.zip`：项目源码、修改版 UxPlay 快照、锁文件、构建脚本、许可与文档（由 `tools/export-public-source.js` 按允许清单导出）。
2. `MeshAudio-<版本>-third-party-sources.tar.gz`：实际随包 DLL 闭包对应的完整 MSYS2 来源包（上游归档、PKGBUILD、分发补丁）、精简解码器构建脚本、MPL Rust 原始包、UxPlay 修改源码与依赖索引。
3. `SHA256SUMS.txt`：上述文件、安装包与（如发布）APK 的摘要。
4. [SOURCE-NOTICE.txt](../SOURCE-NOTICE.txt)：来源与许可声明，指出对应源码包的名称与位置。

要求：

- 四类材料必须在**同一个 Release** 并列提供，且版本号一致；不得只发布安装包，不得用其他版本的源码顶替。
- 源码归档需在二进制分发的整个期间保持可获取；`tools/` 中的构建脚本与 [PUBLIC-BUILD.md](PUBLIC-BUILD.md) 应足以从源码重建功能等价的二进制。
- 不得加入阻止用户运行修改版的技术措施：不加针对第三方 DLL 的防篡改校验、不加锁定签名、不阻止替换 LGPL 动态库。构建前的摘要检查只保护构建输入，不限制用户。
- 依赖版本、来源 URL 与 SHA-256 记录见 `third_party/airplay-dependencies.lock.json`、`third_party/uxplay.lock.json`、`android/gradle/verification-metadata.xml` 与生成的 `dependencies.json`。
- 发布流程与门禁见 [RELEASE.md](RELEASE.md)、[THIRD-PARTY-SOURCES.md](THIRD-PARTY-SOURCES.md)。

## 4. 入站贡献

提交 PR 前需签署 [CLA.md](../CLA.md)。CLA 只确认你有权提交该贡献，并授予项目在 **GPL-3.0-or-later** 条款下使用、修改与分发的非独占许可； outbound 许可证仍为 GPL-3.0-or-later，**不授予**单方面把项目改成专有许可或商业双授权的权利。贡献者保留版权与专利以外的其他权利；协议包含与贡献范围相称的专利授权与防御性终止条款。详见 [CONTRIBUTING.md](../CONTRIBUTING.md) 与 [contributors/README.md](../contributors/README.md)。

## 5. 常见问题

- **可以商用吗？** 可以，但分发（包括作为产品一部分交付给客户）时必须遵守 GPL-3.0-or-later：提供对应源码、保留声明、不附加额外限制。
- **内部使用 / 自建服务要开源吗？** 仅在向第三方分发时触发 GPL 的源码提供义务；自用不触发。
- **能改成 MIT / Apache / 专有许可吗？** 不能单方面改。项目整体改许可需要全体相关版权人同意；本项目的 CLA 未预先授予这种权利。
- **不想签 CLA 怎么办？** 可以不提交代码，通过 Issue、文档建议或测试反馈参与；见 [CONTRIBUTING.md](../CONTRIBUTING.md)。
- **第三方源码包为什么这么大？** 它包含实际二进制依赖的**完整**上游来源包与构建配方，是 GPL/LGPL/MPL 对应源码义务的要求，不是开发机软件清单。
- **安装包为何被 SmartScreen 拦截？** 当前没有商业代码签名证书，与许可证无关；下载前请核对同一 Release 的 `SHA256SUMS.txt`。

## 6. 发布前检查清单

- [ ] 根目录 `LICENSE` 为未修改的 GPLv3 全文，README、`package.json` 与本文均标注 `GPL-3.0-or-later`。
- [ ] `THIRD-PARTY-NOTICES.md`、`SOURCE-NOTICE.txt`、`LICENSES/` 与随包 `licenses/` 齐全，第三方版权未被改写。
- [ ] 同版本的项目源码包、第三方对应源码包、安装包与 `SHA256SUMS.txt` 由最终构建生成并校验通过。
- [ ] 源码包中不含本机配置、日志、测试音频、签名密钥、专有安装器或嵌套 Git 元数据。
- [ ] `CLA.md` 与 `contributors/` 签署机制已随仓库公开，PR 模板包含 CLA 勾选项。
