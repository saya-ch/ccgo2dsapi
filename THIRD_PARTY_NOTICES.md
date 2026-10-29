# 第三方组件声明

本项目自身代码以 [MIT](LICENSE) 授权。

## 运行时依赖

**无。** 上游协议层（`vendor/wire.mjs`、`translate.mjs`、`responses.mjs`、
`server.mjs`）由本项目自行实现，不安装任何 Command Code 相关的 npm 包，
没有 `npm install` 阶段，也没有运行时补丁。

因此本仓库不包含、也不下载任何第三方 Command Code 实现代码。

## 协议来源

`vendor/wire.mjs` 的字段布局与常量（请求头名、`messages` wire 结构、
流式事件名、错误分类）来自对**官方 CLI 发布产物**的静态分析：

| 项 | 内容 |
|---|---|
| 分析对象 | `command-code@1.87.1` 的 `dist/cli.mjs`（2026-10-22 复核；此前基于 1.50.0） |
| 获取方式 | `npm i -g command-code` 后读取本机已安装文件 |
| 分析性质 | 只读静态分析，不反编译、不修改、不再分发 |
| 记录 | [docs/COMMAND-CODE-PROTOCOL.md](docs/COMMAND-CODE-PROTOCOL.md) |

该 CLI 以 `UNLICENSED` 发布。本项目不再分发其任何代码，仅在文档中记录观察到的
协议行为（端点路径、请求头名、事件名等事实性信息），用于实现互操作。
若你所在司法辖区对「为互操作而分析」有不同要求，请自行评估。

## 早期版本曾使用的组件

v0.3.x 及更早版本依赖并在 `node_modules` 内补丁修改了下列组件。相关代码已在
自研实现完成后移除，此处保留署名以尊重原作者的贡献。

### commandcode-api-proxy

| 项 | 内容 |
|---|---|
| 名称 | `commandcode-api-proxy` |
| 版本 | 0.4.1 |
| 作者 | thaolaptrinh |
| 许可证 | MIT |
| 仓库 | https://github.com/thaolaptrinh/commandcode-api-proxy |
| 版权声明 | Copyright (c) 2026 thaolaptrinh |

它提供了一个 OpenAI/Anthropic → Command Code 上游的协议转换实现，是本项目
自研早期的重要参考。本项目当时**不是**它的 fork，而是通过 npm 依赖引入并在安装后
打运行时补丁；现在这部分已完全由 `vendor/` 下的自研代码取代。

当前仓库中不再包含该项目的任何代码。

## 图像资产

`assets/brand/` 下的图片由本项目生成，不含第三方素材。

## 许可证兼容性

本项目以 MIT 分发。由于已无运行时第三方依赖，不存在许可证组合问题；
上述 MIT 组件的署名义务（保留版权声明）在本文件中满足。
