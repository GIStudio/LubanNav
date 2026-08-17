# 系统架构

## 1. 项目定位

LubanNav 是部署在 GitHub Pages 上的纯静态校园导航应用原型，服务于香港科技大学（广州）。它在没有服务端运行时的前提下提供四类能力：

1. **网页导航**：Leaflet Canvas 渲染的本地 OSM 地图，步行 / 机器人双模式 A\* 寻路，支持手动选择、自然语言、实时语音三种入口。
2. **静态 GET API**：构建期为全部公开地点组合预计算路线，输出独立 JSON 文件，AI / 机器人客户端无需执行 JavaScript 即可 HTTP GET 获取。
3. **实时语音助手**：浏览器经 WebRTC 直连阿里云百炼 `qwen3.5-omni-flash-realtime`；函数计算网关只代理一次 SDP 交换，不接触音频流。
4. **机器人 BLE 控制**：浏览器通过 Web Bluetooth 作为 GATT Client，向小车下发 JSON Lines 路线任务并接收位置遥测。

## 2. 技术栈

| 层 | 技术 | 说明 |
| --- | --- | --- |
| 前端框架 | Preact 10 + Vite 7 | `@preact/preset-vite`，`base: './'` 相对路径，兼容用户主页与项目子路径部署 |
| 地图 | Leaflet 1.9 | 全部使用 Canvas renderer，不请求在线瓦片，只渲染同源 GeoJSON |
| 测试 | Vitest | `vite.config.js` 中 `test.environment = 'node'`，测试文件与源码同目录（`*.test.js`） |
| 数据脚本 | Node.js 20+（ESM） | OSM 抓取、路网生成、静态 API 生成 |
| GIS 脚本 | Python 3.11+（uv 内联依赖） | 可通行面提取 / 配准固定 `numpy==2.3.2`、`pillow==11.3.0`；GIS 导出可选用 `ogr2ogr` |
| BLE 模拟器 | Swift Package（swift-tools 6.0，macOS 13+） | CoreBluetooth peripheral 模式，仅遥测回放 |
| 语音服务 | Node.js 20 原生 `http` | 阿里云函数计算 Web 函数，单文件 `server.mjs` |
| 部署 | GitHub Actions → GitHub Pages | `.github/workflows/deploy-pages.yml`：test → build → deploy |

## 3. 总体架构图

```text
                         ┌────────────────────────────────────────────────┐
                         │                GitHub Pages（静态）             │
                         │                                                │
 用户浏览器 ──────────────▶│  SPA（Preact + Leaflet）                      │
   │  手动选择 / ?q= 文本  │    ├─ src/lib/pathfinding.js  A* 路由内核     │
   │  实时语音             │    ├─ src/lib/destinationParser.js 本地解析   │
   │  BLE 操作             │    └─ public/api/v1/**  预计算静态 JSON API   │
   │                       └──────────────┬─────────────────────────────┘
   │                                      │ 构建期生成
   │                       ┌──────────────┴─────────────────────────────┐
   │                       │ 数据管线（本地脚本，离线可复现）              │
   │                       │ Overpass ─▶ campus-osm.geojson              │
   │                       │ campus-indoor.geojson（本地室内补丁）         │
   │                       │   └▶ generate-osm-routing.mjs               │
   │                       │        └▶ src/data/osm-routing.json         │
   │                       │             └▶ generate-static-api.mjs      │
   │                       └────────────────────────────────────────────┘
   │
   │ WebRTC（音频直连，SDP 经网关交换）
   ▼
 阿里云百炼 qwen3.5-omni-flash-realtime
   ▲
   │ 一次性 POST /voice/session（访问码 + Offer SDP → Answer SDP）
 函数计算 services/voice-gateway/server.mjs（持有永久 API Key）

   │ Web Bluetooth（HTTPS + 用户手势触发）
   ▼
 BLE 机器人小车（GATT Peripheral，JSON Lines over NUS）
   └─ 无真机时：tools/car7-ble-simulator（macOS CoreBluetooth 模拟器）
```

## 4. 目录结构

```text
LubanNav/
├── index.html                     # Vite 入口壳（应用由 src/main.jsx 挂载）
├── vite.config.js                 # Preact 插件、相对 base、es2020、sourcemap
├── package.json                   # npm scripts：dev/build/test/refresh:osm/...
├── config/
│   ├── walkable-surfaces-render.json     # 水泥色提取阈值与复核状态
│   └── eight-building-registration.json  # 八栋楼控制点与验收阈值
├── src/
│   ├── main.jsx / App.jsx         # 应用外壳与全局状态编排
│   ├── styles.css                 # 全部样式
│   ├── components/                # CampusMap / EventPanel / ChatAssistant /
│   │                              # VoiceAssistant / VoiceQuickControl /
│   │                              # SystemMenu / RobotControl
│   ├── data/
│   │   ├── campus.js              # 稳定地点目录、别名、OSM 建筑映射、模式
│   │   ├── events.js              # 内置活动模式数据
│   │   ├── osm-routing.json       # 自动生成的寻路图（Git 忽略，构建产物）
│   │   └── *.test.js              # 数据快照测试
│   └── lib/                       # 纯逻辑模块（寻路、解析、语音、BLE）
├── public/
│   ├── data/
│   │   ├── campus-osm.geojson     # OSM 同源快照（建筑/入口/道路/水域）
│   │   ├── campus-indoor.geojson  # 本地室内补丁（入口 POI/室内网络/电梯）
│   │   └── walkable-surfaces/     # 渲染图提取的可通行面候选与配准报告
│   ├── api/
│   │   ├── index.html             # 网页版 API 说明
│   │   └── v1/                    # 静态 GET API（locations/events/routes/...）
│   ├── manifest.webmanifest / favicon.svg / THIRD_PARTY_NOTICES.txt
├── scripts/                       # 数据管线脚本（详见 data-pipeline.md）
│   ├── fetch-osm-campus.mjs
│   ├── generate-osm-routing.mjs
│   ├── generate-static-api.mjs
│   ├── extract-walkable-surfaces.py
│   ├── register-walkable-surfaces.py
│   ├── export-gis-layers.py
│   ├── render-osm-reference.mjs
│   └── lib/osm-routing.mjs        # 路网算法库
├── services/voice-gateway/        # 函数计算 SDP 代理（详见 voice-gateway.md）
├── tools/car7-ble-simulator/      # macOS BLE 模拟器（详见 ble-simulator.md）
├── docs/                          # 本文档体系
└── .github/workflows/deploy-pages.yml
```

## 5. 核心数据流

### 5.1 构建期

1. `npm run refresh:osm`（可选）：向 Overpass 拉取固定校园范围，写入 `public/data/campus-osm.geojson`，随后自动执行路网重建。
2. `npm run generate:routing`：读取 OSM 快照 + 室内补丁，离线生成 `src/data/osm-routing.json`（节点、边、地点绑定、统计）。
3. `npm run generate:api`：调用与网页完全相同的 `findRoute()`，为 29 个公开地点的全部有序组合 × 2 种模式（1682 个文件）预计算路线，连同 `locations.json`、`events.json`、`routing-graph.json`、`robot-ble-protocol.json`、可通行面文件写入 `public/api/v1/`。
4. `vite build` 打包 SPA，GitHub Actions 将 `dist/` 发布到 Pages。

网页与静态 API 共用同一个路由内核（`src/lib/pathfinding.js`），因此页面路线、分享 URL、静态 JSON 三者结果一致。

### 5.2 运行期（浏览器）

- 地图层：`CampusMap` 拉取 `data/campus-osm.geojson` 与 `data/campus-indoor.geojson`，分层渲染水域、道路、建筑、室内要素；不请求任何在线瓦片。
- 路线：`App` 中的 `findRoute(from, to, mode)` 是 `useMemo` 派生值，任何入口（下拉框、文本解析、语音工具调用、活动面板、URL 参数）最终都只修改 `from/to/mode` 三个状态。
- 地址栏：`from`、`to`、`mode`、`event` 通过 `history.replaceState` 同步，形成可复现链接；`?q=` 只在首次加载时消费。

## 6. 关键设计决策

| 决策 | 理由 |
| --- | --- |
| 静态站点 + 构建期预计算路线 | GitHub Pages 无服务端运行时；路线是有限地点对的闭集，可全量枚举 |
| 地点 ID 作为稳定合约 | OSM way/node ID 随数据刷新变化，地点 ID 不变，是 URL、API、语音工具、BLE 任务的共同锚点 |
| 语音模型只做 Function Calling | 模型只产出白名单内的 `{from, to, mode}`，路径计算、地点校验全部在本地，模型无法生成坐标或绕过白名单 |
| 访问码 + 函数计算代理 SDP | 百炼 API Key 永不进入浏览器 / 仓库；百炼端点不接受跨域 SDP，需要服务端代理一次建连 |
| BLE 任务必须人工点击下发 | 路线变化不自动推送小车；STOP 只是辅助入口，不替代物理急停 |
| 室内补丁默认只开放步行 | 机器人进入室内段必须显式 `robotValidated=true`，且生成器校验门宽/坡度等人工结论之后才写入 |
| 入口换楼惩罚（`routingPenaltyMeters`） | 只影响路径选择，避免把建筑当室外捷径；API 返回的真实距离不累计该惩罚 |

## 7. 构建、测试与部署

```bash
npm install        # Node.js 20+
npm run dev        # 本地开发（Vite dev server）
npm test           # Vitest（数据快照 + 全部 lib 单元测试）
npm run build      # generate:routing → generate:api → vite build → dist/
npm run preview    # 预览构建产物
```

GitHub Actions（`deploy-pages.yml`）：推送 `main` 后依次执行 `npm ci`、`npm test`、`npm run build`（注入可选 `VITE_VOICE_GATEWAY_URL`），再上传 `dist/` 部署 Pages。仓库需在 **Settings → Pages** 选择 **GitHub Actions** 作为来源。

生成的 `src/data/osm-routing.json` 与 `public/api/v1/routes/` 被 `.gitignore` 忽略；`campus-osm.geojson`、`campus-indoor.geojson` 与已配准的可通行面文件是需要提交审查的来源 / 派生数据。

## 8. 测试组织

每个 `src/lib` 模块都有同名 `*.test.js`（Vitest，node 环境）：

- `pathfinding.test.js`：路线状态、汇总字段、跨楼层电梯路线、`no_route` 行为。
- `osmRouting.test.js` / `osmCampus.test.js` / `walkableSurfaces.test.js`：数据快照结构、绑定完整性、配准报告字段。
- `destinationParser.test.js` / `eventMode.test.js` / `assistantKnowledge.test.js`：解析与知识库行为。
- `voiceNavigation.test.js` / `qwenRealtime.test.js`：工具参数校验、SDP 交换错误分支、会话事件（mock WebRTC）。
- `robotProtocol.test.js` / `webBluetoothRobot.test.js`：帧编码、分包、遥测解码、连接状态机（mock Web Bluetooth）。

Swift 侧协议测试：`npm run ble:simulator:test`（`tools/car7-ble-simulator/Tests/Car7ProtocolTests`）。
