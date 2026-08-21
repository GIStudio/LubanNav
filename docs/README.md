# LubanNav 项目文档

本目录是 LubanNav 的完整文档入口。项目本身是面向香港科技大学（广州）校园的轻量导航 Web 应用原型：OSM 本地地图 + 分层室内外 A\* 路网 + 静态 GET 路径 API + Qwen 实时语音助手 + Web Bluetooth 机器人控制。

> 工程演示性质。数据未经现场测绘，路线不可直接用于真实机器人无人值守控制。各文档中涉及安全边界的部分请以原文为准。

## 文档索引

| 文档 | 内容 | 适合读者 |
| --- | --- | --- |
| [architecture.md](architecture.md) | 系统架构、技术栈、目录结构、数据流、设计决策、构建与部署 | 所有开发者 |
| [features.md](features.md) | 全部功能的详细介绍：导航入口、地图、活动模式、AI 对话、实时语音、机器人 BLE、可通行面研究 | 使用者、产品经理、评审者 |
| [static-api.md](static-api.md) | 静态 GET API 完整参考：端点目录、JSON Schema 字段表、离线 A\* 接入指南 | AI / 机器人 / 后端客户端开发者 |
| [frontend-modules.md](frontend-modules.md) | 前端模块接口参考：`src/lib` 每个库的导出函数、`src/components` 组件的 props 与事件 | 前端开发者 |
| [data-pipeline.md](data-pipeline.md) | 数据管线与脚本：OSM 抓取、路网生成算法、静态 API 生成、可通行面提取与配准、GIS 导出、配置文件 | 数据维护者 |
| [robot-ble-protocol.md](robot-ble-protocol.md) | 机器人协议 v1：GATT 合约、JSON Lines 分包、消息格式、安全边界 | 固件开发者 |
| [robot-wifi-link.md](robot-wifi-link.md) | 机器人 WiFi 链路：WebSocket 直连车机、RTK 遥测回传、网页直连调查、部署手册 | 前端/车机开发者、测试者 |
| [car7-local-ble-test.md](car7-local-ble-test.md) | 用 Mac 模拟 car7、Android 手机验收 BLE 闭环的操作手册 | 测试者 |
| [ble-simulator.md](ble-simulator.md) | car7 macOS BLE 模拟器：Swift 包结构、Car7Protocol API、运行行为与命令行选项 | 模拟器维护者 |
| [voice-gateway.md](voice-gateway.md) | 语音网关函数计算服务：HTTP 接口、环境变量、错误码、与前端 WebRTC 会话的关系 | 服务运维者 |
| [qwen-models.md](qwen-models.md) | Qwen/百炼模型接入总览：实时语音链路与韧性机制、qwen3-tts-flash 音频合成、multimodal-dialog 套件对比、授权排查 | 服务运维者、前端开发者 |

## 快速定位

- **想调用路线**：先看 [static-api.md](static-api.md)。地点对路线直接 GET 预计算 JSON；自建后端寻路则下载 `routing-graph.json`。
- **想接入机器人**：协议见 [robot-ble-protocol.md](robot-ble-protocol.md)；真机走 WiFi 直连（[robot-wifi-link.md](robot-wifi-link.md)，`ws://10.7.181.161:8900`），无真机时用 [ble-simulator.md](ble-simulator.md) 联调，BLE 验收流程见 [car7-local-ble-test.md](car7-local-ble-test.md)。
- **想改前端**：从 [architecture.md](architecture.md) 的目录结构入手，接口细节查 [frontend-modules.md](frontend-modules.md)。
- **想刷新或扩展地图数据**：按 [data-pipeline.md](data-pipeline.md) 依次执行 OSM 刷新、路网重建、静态 API 重建。
- **想部署语音服务**：按 [voice-gateway.md](voice-gateway.md) 配置函数计算环境变量。

## 稳定合约与派生信息

- **稳定 API 合约**：地点 ID（`locations.json` 中的 `id`）、静态 API 路径模板、BLE 协议名与版本、`schemaVersion` 字段语义。
- **可随数据刷新变化的派生信息**：OSM way/node ID、入口来源与吸附距离、预计算路线的具体坐标。

仓库根目录的 [README.md](../README.md) 提供项目概述与在线链接，本目录文档提供更深入的接口与实现细节。
