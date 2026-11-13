# 发布 0.3.1 验收候选版

目标：Windows x64。该版本改善端口拖动连线、首次使用引导和组件安装，不代表原始六阶段全部需求已完成。真实手机音频连续性和干净 Windows 安装仍是公开稳定版门禁。

## 生成与本机验证

按 PUBLIC-BUILD.md 构建最小音频依赖、对应源码、原生引擎和 NSIS 安装包。Tauri 在构建前强制准备并核验资源；缺少资源或摘要不符即停止。

```powershell
npm run test:all
npm test --prefix desktop-app
node tools/test-component-setup.js
node tools/test-bundled-airplay-setup.js
node tools/test-components.js --skip-download
node tools/test-routing-setup-ui.js
node tools/test-airplay-ui.js
node tools/test-minimal-codecs.js
npm run tauri:build --prefix desktop-app -- --bundles nsis
```

将 NSIS 产物复制到 release，再运行 `node tools/export-public-source.js`。导出工具只拷贝允许清单中的源码和文档，排除用户配置、日志、测试音频、个人交接、开发工具、构建产物、嵌套 Git 元数据和专有安装器，并检查常见密钥/本机绝对路径。检查仅覆盖列明规则，不替代人工发布审查。原工作目录不删除或重建。

release/source/MeshAudio-0.3.1 是准备上传 GitHub 的源码目录；该目录未自动初始化 Git 或上传远程。确认仓库归属和公开范围后再自行初始化、提交和推送。不要上传整个开发目录。新增公开文档必须同步加入 `tools/export-public-source.js` 的允许清单并重新导出，否则干净源码包会缺少该文件、摘要也会失配。

## 公开仓库必备文件

仓库根目录应包含：`LICENSE`（未修改的 GPLv3 全文）、`README.md`、`docs/PROJECT-OVERVIEW.md`（完整项目说明）、`docs/LICENSING.md`（`GPL-3.0-or-later` 政策）、`THIRD-PARTY-NOTICES.md`、`SOURCE-NOTICE.txt`、`LICENSES/`、`CLA.md`、`CONTRIBUTING.md`、`contributors/`（签署记录与模板）、`SECURITY.md`、`.github/PULL_REQUEST_TEMPLATE.md`（CLA 勾选项）与 `.github/workflows/ci.yml`。

发布前确认 `CLA.md` §8 与 `contributors/README.md` 已补全维护主体全称、联系渠道与管辖地，并确认 PR 的 CLA 人工核验流程可用。这些是仓库级文件，不需要打进安装包，但必须随公开源码提供。

## 同一个 Release 必须提供

- MeshAudio 0.3.1 Windows x64 安装器。
- MeshAudio-0.3.1-source.zip：项目源码、修改后的 UxPlay 快照、锁文件和构建指引。
- MeshAudio-0.3.1-third-party-sources.tar.gz：匹配二进制的完整来源包及 MPL 原始包。
- MeshAudio-Android-0.3.1-release.apk：由未签名 release 产物经 zipalign + apksigner v3 签名的公开包；发布密钥保存在源码树之外，不上传仓库或 CI。debug 包只作内部真机验收，不作为公开附件。
- SHA256SUMS.txt，以及本次验收结果与已知限制。

本轮具体结果见 ACCEPTANCE-0.3.1.md。不要将历史音频连续性失败或尚未完成的真机门禁标成通过。

自有代码 GPL-3.0-or-later；第三方各自许可保留。动态库可替换，不加阻止修改的校验；发布前的摘要检查只保护构建输入。VB-CABLE/Bonjour 不重新分发，按用户选择从原厂下载并执行官方安装器。安装程序可能要求 UAC、点击确认与重启，不能宣传为无交互驱动安装。

## 人工门禁

- 干净 Windows 10/11 x64：没有 Node、VC 开发环境、Bonjour 或 VB-CABLE 时安装；验证 WebView2 获取、组件下载、UAC 取消/重试、系统重启和卸载。
- 旧版升级后来源、通道、连线和设置保留。普通退出需使用托盘菜单；关闭窗口仅隐藏。
- 真 iPhone 播放、AAC-ELD 会话、两台设备并发、网络波动、30 分钟连续性与耳机听感。
- 手机连接后来源→通道→输出拖线立即可控，断一条来源不影响其他路径；虚拟设备不随网络断开消失。
- 新用户引导只在尚未完成时出现；设置可重新打开；不勾选的驱动不安装。

Android APK 已有独立发布签名；Windows 安装包目前没有商业代码签名证书，SmartScreen 可能提示未知发布者。两者签名体系独立，Android 密钥不用于 Windows 包。不得将开发机解包启动或隔离安装器测试写成干净 Windows 系统安装已经通过。
