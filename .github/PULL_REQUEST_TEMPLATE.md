## 变更说明

<!-- 说明改了什么、为什么改，以及影响范围（音频链路 / UI / 安装流程 / 文档 / 构建）。 -->

## 关联 Issue

<!-- 如有关联 Issue 请填写编号；没有可写「无」。 -->

## 验证

- [ ] `npm test`、`npm run test:all` 通过
- [ ] 前端检查与测试通过（`npm test --prefix desktop-app`、`npm run check --prefix desktop-app`）
- [ ] 涉及 UI 改动时已运行对应隔离回归脚本，并说明结果
- [ ] 涉及音频链路时已说明对现有来源/通道/连线的影响，且未破坏「单路断流不影响其他链路」
- [ ] 未提交 `node_modules/`、`target/`、生成运行库、SDK、安装包、APK、个人配置、日志、测试音频、截图或未脱敏数据

## 许可与 CLA

- [ ] 我已阅读并签署仓库根目录 `CLA.md`（v1.0），签署记录位于 `contributors/signatures/<GitHub 用户名>.md`，或已在之前的 PR 中签署（请注明 PR 编号）
- [ ] 本 PR 的贡献适用 `GPL-3.0-or-later`，新增文件已按 `docs/LICENSING.md` 标注 SPDX 与版权（如适用）
- [ ] 引入或更新第三方代码/依赖时，已同步更新 `THIRD-PARTY-NOTICES.md`、依赖锁定记录与对应源码包
- [ ] 本 PR 不含第三方专有代码、密钥、真实用户数据、本机绝对路径或专有系统组件（VB-CABLE / Bonjour 安装器）

## 验收边界

<!-- 若改动涉及真机、长时间连续性、干净 Windows 安装等门禁，请如实写明「未验证」或附证据；不要把模拟/解包测试写成门禁通过。见 docs/KNOWN-LIMITATIONS.md。 -->
