# 参与 MeshAudio 开发

感谢参与。MeshAudio 自有代码采用 **GPL-3.0-or-later**（见 [LICENSE](LICENSE) 与 [docs/LICENSING.md](docs/LICENSING.md)）。提交前请阅读 [README](README.md)、[完整项目说明](docs/PROJECT-OVERVIEW.md)、[公开源码构建](docs/PUBLIC-BUILD.md)、[已知限制](docs/KNOWN-LIMITATIONS.md)、[技术方案](docs/ARCHITECTURE.md) 及相关 ADR。

## 1. 先签署 CLA

把内容纳入仓库前，需要签署 [贡献者许可协议（CLA）](CLA.md)：

1. 阅读 `CLA.md` 与 [docs/LICENSING.md](docs/LICENSING.md)；
2. 复制 [contributors/SIGNATURE-TEMPLATE.md](contributors/SIGNATURE-TEMPLATE.md) 为 `contributors/signatures/<GitHub 用户名>.md` 并填写；
3. 在 PR 中勾选 CLA 勾选项并注明签署记录文件名。

签署一次对之后所有贡献持续有效。代表公司/组织或提交职务创作时，由授权代表按 CLA §7 签署实体记录。只提交 Issue、复现步骤、测试建议不需要 CLA。撤回与版本更新规则见 `CLA.md` §8，签署记录的管理见 [contributors/README.md](contributors/README.md)。

CLA **不是版权转让**，不改变 `GPL-3.0-or-later` 许可证，也不授予把你的贡献改成专有许可的权利。

## 2. 提交规范

- 使用 [PR 模板](.github/PULL_REQUEST_TEMPLATE.md)：说明变更内容、影响范围、复现步骤、预期/实际行为与对应测试。
- 新增源文件按 [docs/LICENSING.md](docs/LICENSING.md) 标注 `SPDX-License-Identifier: GPL-3.0-or-later` 与版权；从上游拷入的文件保留原有版权、许可与 SPDX 标识，不要改写为 MeshAudio 版权。
- 提交你有权授权的修改，确认不违反雇主或委托方约定；第三方材料必须标注来源、版权与许可，并同步更新 `THIRD-PARTY-NOTICES.md`、依赖锁定记录与对应源码包。
- 更改第三方依赖时同步更新版本、SHA-256、许可证和对应源码包；固定哈希变化必须调查，不能自动忽略签名或校验失败。
- 报告设备问题时提供经过脱敏的版本号、采样格式、错误码和日志片段；不上传个人局域网 IP、真实设备名、音频内容、证书私钥或整个 AppData 目录。安全漏洞走 [SECURITY.md](SECURITY.md) 的私有渠道。
- 不要把模拟安装器、解包启动、合成音频或短时测试写成干净 Windows 安装、真机 30 分钟连续性等门禁已通过；未验证就如实标注。

## 3. 音频与安装的硬约束

- 不捕获系统全局输出；系统播放使用共享模式，不独占、不替代系统混音器。
- 来源 → 通道 → 输出，来源不能直连输出；单路断流不得重建系统虚拟端点；遥测和 UI 不重置音频缓存。
- 组件安装必须验证来源、SHA-256 与发布者签名，等待官方安装器结果；不跳过管理员确认，不打包或镜像 VB-CABLE / Bonjour 安装器。
- 新增平台能力必须有真机证据与限制说明，并同步更新 `docs/KNOWN-LIMITATIONS.md`。

## 4. 测试

提交前至少运行：

```powershell
npm test
npm run test:all
npm test --prefix desktop-app
npm run check --prefix desktop-app
```

涉及 UI、组件安装、AirPlay、Android 或原生混音的改动，再运行 `tools/` 下对应的隔离回归脚本（见 [docs/PUBLIC-BUILD.md](docs/PUBLIC-BUILD.md) 与 `package.json` 的 scripts）。CI 在 Windows 与 Ubuntu 上分别执行桌面与 Android 检查；CI 失败请修复后再请求合并。

## 5. 不要提交

`node_modules/`、`target/`、`dist/`、生成运行库、SDK、安装包/APK、签名密钥、个人配置、日志、测试音频、截图报告、本机绝对路径、未脱敏数据，以及嵌套 Git 元数据。公开源码包由 `tools/export-public-source.js` 按允许清单生成，新增公开文档需同步加入该允许清单。

## 6. 协作

保持友善、就技术事实讨论；对未完成的门禁如实说明。维护者没有义务接受任何贡献，合并前会核验 CLA 签署记录、许可边界与验收说明。
