# 第三方组件声明

本项目自身代码以 [MIT](LICENSE) 授权。作为运行时依赖，它会安装并使用下列第三方开源组件。
这些组件不随本仓库分发，而是在 `npm install` 时由 npm 从官方源下载。

## commandcode-api-proxy

协议转换层的核心实现，也是本项目唯一的运行时依赖。

| 项 | 内容 |
|---|---|
| 名称 | `commandcode-api-proxy` |
| 版本 | 0.4.1（以 `package.json` 中声明的范围为准） |
| 作者 | thaolaptrinh |
| 许可证 | MIT |
| 仓库 | https://github.com/thaolaptrinh/commandcode-api-proxy |
| 版权声明 | Copyright (c) 2026 thaolaptrinh |

该项目提供 OpenAI 与 Anthropic 格式到 Command Code 上游私有格式的双向翻译、
流式事件转换、工具调用配对等核心能力。本项目不复制、不内联它的源码，
而是通过 npm 依赖引入，并由 `install.ps1` 在安装后应用运行时补丁。

### 与本项目的关系

本项目**不是**该仓库的 fork，两者是依赖关系。分工如下：

| 层 | 归属 | 内容 |
|---|---|---|
| 协议翻译、流式转换、上游通信 | `commandcode-api-proxy` | 核心实现 |
| 启动器、额度面板、配置管理 | 本项目 | `launch.ps1` 等 |
| 官方 API 对齐、思考模式默认值 | 本项目 | `tools/patch-*.mjs` |
| 一致性验证、测速 | 本项目 | `tools/verify-parity.mjs`、`tools/measure-speed.mjs` |

### 补丁说明

`tools/patch-reasoning.mjs` 与 `tools/patch-parity.mjs` 会在 `node_modules` 内就地修改
该包的 `dist/` 文件。被修改的文件仍属 thaolaptrinh 所有、仍以 MIT 授权，
本项目的补丁脚本仅是自动化改写工具。

由于修改发生在本地安装目录，`npm install` 会覆盖补丁，因此安装脚本每次都会重新应用。
原始文件在应用补丁前会被备份为 `*.orig` / `*.parity-orig`，可用 `--restore` 还原。

### MIT 许可义务

MIT 许可证要求保留版权声明与许可声明。该义务在以下环节已满足：

- npm 安装时会把上游的 `LICENSE` 文件一并放入 `node_modules/commandcode-api-proxy/`
- 本文件与 README 均明确标注作者、版本、仓库地址与许可证类型
- 本项目未修改或移除上游的任何版权声明

如需查看完整许可文本，见安装后的 `node_modules/commandcode-api-proxy/LICENSE`。

## 未使用的组件

调研阶段参考过同领域的其它公开实现（如 `MAXeaglet/commandcode-proxy`），
但仅用于理解上游协议行为与做行为对照，**没有任何代码进入本仓库或运行时**。
本项目协议的最终实现完全由上述 npm 依赖承担。

## 商标与素材

`assets/brand/` 下的头图由项目作者使用生成模型创作，用于本项目展示。
图中出现的鲸鱼形象为原创角色设计，Command Code 相关视觉元素仅作指代用途，
不代表与 Command Code 或 DeepSeek 存在任何关联、赞助或背书关系。

本项目不包含、不复用任何第三方的商标图形或受版权保护的美术素材。

## 报告问题

若认为本项目存在署名缺失或违反许可证义务的内容，请提交 issue，
说明具体文件与依据，我们会尽快核实并修正。
