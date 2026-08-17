# LubanNav

面向香港科技大学（广州）校园的轻量导航 Web 应用原型。它提供轻量 OpenStreetMap Canvas 地图、由 OSM `highway=footway/path/pedestrian/service` 与分层室内通道共同组成的 A* 路网、建筑入口吸附、可配置的会议/活动专属导航、可自动刷新地图路线的 Qwen 实时语音助手、可被 AI/机器人客户端直接 HTTP GET 的静态 JSON 路径 API，以及浏览器通过 BLE GATT 与机器人小车进行任务和位置通信的 Web Bluetooth 控制面板。

> 当前版本是工程演示，不是学校官方导航产品。室外建筑、入口、水域和道路来自 [OpenStreetMap](https://www.openstreetmap.org/way/894157108)，地图数据采用 [ODbL 1.0](https://www.openstreetmap.org/copyright)；本地室内补丁会单独标明来源和核验状态。OSM 缺少入口时会推断建筑边界入口，导航拓扑与可通行性仍未经现场测绘，不可直接用于真实机器人运动控制。

## 在线使用

- Web 应用：<https://gistudio.github.io/LubanNav/>
- API 目录：<https://gistudio.github.io/LubanNav/api/>
- 地点列表：<https://gistudio.github.io/LubanNav/api/v1/locations.json>
- 内置活动：<https://gistudio.github.io/LubanNav/api/v1/events.json>
- 完整寻路图：<https://gistudio.github.io/LubanNav/api/v1/routing-graph.json>
- 示例路线：<https://gistudio.github.io/LubanNav/api/v1/routes/main-entrance/library.pedestrian.json>
- 跨楼层示例：<https://gistudio.github.io/LubanNav/api/v1/routes/w2-elevator/third-floor-platform.pedestrian.json>

页面支持三种导航入口：手动选择起终点、输入“从宿舍 5 到饭堂”等自然语言，以及连接实时语音后直接说“请从校门口导航到 W-4”。三种入口最终都调用同一个本地路由内核，因此页面路线、分享 URL、静态 API 地点 ID 和机器人任务使用一致的导航合约。

桌面端将“去哪里？”路线控制与 AI 文字对话合并在左侧导航工作台中，左栏独立滚动，不会带动中央 OSM/WGS84 地图。实时语音和机器人 BLE 联络的配置收纳在右上角三明治菜单中；地图正下方常驻一个大麦克风快捷控制，已配置后可一键开始或结束对话，未配置时点击会直接打开语音设置。移动端同样固定保留上方地图与麦克风，下方导航面板独立滚动。

## 项目文档

完整文档体系位于 [`docs/`](docs/README.md)，按主题拆分：

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 系统架构、技术栈、目录结构、数据流与设计决策 |
| [docs/features.md](docs/features.md) | 全部功能的详细介绍与使用方式 |
| [docs/static-api.md](docs/static-api.md) | 静态 GET API 参考：端点、JSON 字段表、离线 A\* 接入 |
| [docs/frontend-modules.md](docs/frontend-modules.md) | 前端 `src/lib` 与组件的接口参考 |
| [docs/data-pipeline.md](docs/data-pipeline.md) | 数据管线：OSM 抓取、路网生成算法、脚本与配置 |
| [docs/robot-ble-protocol.md](docs/robot-ble-protocol.md) | 机器人 BLE GATT 与 JSON Lines 消息协议 |
| [docs/car7-local-ble-test.md](docs/car7-local-ble-test.md) | Mac 模拟器 + Android 手机 BLE 验收手册 |
| [docs/ble-simulator.md](docs/ble-simulator.md) | car7 BLE 模拟器（Swift 包）说明 |
| [docs/voice-gateway.md](docs/voice-gateway.md) | 语音网关函数计算服务接口 |

## 为什么静态站点也能提供 GET API

GitHub Pages 不运行服务端代码。构建时，LubanNav 会为所有公开地点组合预计算路径，并输出独立 JSON 文件。因此普通 HTTP 客户端无需执行 JavaScript，也能直接获得路线：

```text
GET https://<user>.github.io/<repo>/api/v1/locations.json
GET https://<user>.github.io/<repo>/api/v1/events.json
GET https://<user>.github.io/<repo>/api/v1/routing-graph.json
GET https://<user>.github.io/<repo>/api/v1/robot-ble-protocol.json
GET https://<user>.github.io/<repo>/api/v1/walkable-surfaces.image.geojson
GET https://<user>.github.io/<repo>/api/v1/walkable-surfaces.wgs84.geojson
GET https://<user>.github.io/<repo>/api/v1/walkable-registration-report.json
GET https://<user>.github.io/<repo>/api/v1/routes/main-entrance/library.pedestrian.json
GET https://<user>.github.io/<repo>/api/v1/routes/dorm-5/sports-hall.robot.json
GET https://<user>.github.io/<repo>/api/v1/routes/w2-elevator/third-floor-platform.pedestrian.json
```

已知地点对可以直接读取预计算路线。需要在自己的后端运行 A* 时，只需缓存 `routing-graph.json`；它内含全部节点坐标、边、模式权限、地点入口和分模式图节点绑定，不依赖另一份 OSM 数据。完整机器可读目录位于 `api/v1/catalog.json`，网页 API 说明位于 `api/`。

响应示例：

```json
{
  "schemaVersion": "1.4",
  "dataset": "hkustgz-layered-routing-v4",
  "status": "ok",
  "request": {
    "from": "main-entrance",
    "to": "library",
    "mode": "pedestrian"
  },
  "summary": {
    "distanceMeters": 993,
    "durationSeconds": 795,
    "distanceEstimated": true,
    "roadDistanceMeters": 896,
    "connectorDistanceMeters": 46,
    "indoorDistanceMeters": 51,
    "segmentCount": 38,
    "navigationWaypointCount": 421,
    "maxNavigationSpacingMeters": 2.5
  },
  "path": [
    {
      "id": "main-entrance",
      "kind": "entrance",
      "entranceSource": "osm-entrance",
      "longitude": 113.4776815,
      "latitude": 22.8883663
    }
  ],
  "navigationWaypoints": [
    {
      "sequence": 0,
      "nodeId": "main-entrance",
      "kind": "entrance",
      "longitude": 113.4776815,
      "latitude": 22.8883663,
      "interpolated": false,
      "distanceMeters": 0
    }
  ],
  "highlights": [
    {
      "id": "food-court",
      "name": "饭堂",
      "description": "校园主要餐饮区，位于演讲厅一带。",
      "distanceMeters": 34,
      "approachIndex": 12
    }
  ],
  "segments": [
    {
      "id": "way/1192908727/1",
      "from": {"id": "osm-node/10763132989", "longitude": 113.4776815, "latitude": 22.8883663},
      "to": {"id": "osm-node/11073090128", "longitude": 113.4777049, "latitude": 22.8884435},
      "distanceMeters": 8.913,
      "highway": "service",
      "osmWayId": 1192908727,
      "segmentType": "osm-road",
      "modes": ["pedestrian", "robot"]
    }
  ],
  "geometry": {"type": "LineString", "coordinates": [[113.4776815, 22.8883663], [113.4777049, 22.8884435]]},
  "routing": {
    "engine": "layered-osm-indoor-a-star",
    "allowedHighways": ["footway", "path", "pedestrian", "service"],
    "indoorHighways": ["corridor", "elevator"],
    "indoorFeatureIds": ["local/library-level-0-main-corridor"],
    "osmWayIds": [1192908727, 1154868989]
  },
  "instructions": ["从主入口出发", "...", "沿0 层室内通道前行约 51 米", "抵达图书馆"],
  "disclaimer": "..."
}
```

网页本身也支持可复现的 GET 查询参数：

```text
/?from=main-entrance&to=library&mode=pedestrian
/?q=从宿舍5到饭堂
```

第二种链接需要浏览器执行页面 JavaScript；需要原始 JSON 时使用上面的静态 API。

`walkable-surfaces.image.geojson` 是从 3D 俯瞰渲染图提取的水泥色平面候选；`walkable-surfaces.wgs84.geojson` 使用 OSM 的 E1–E4、W1–W4 八栋楼作为控制对象完成初始 WGS84 配准。地面、屋顶与潜在立面尚未完成语义复核，所有要素均为 `routingEnabled=false`，不会进入当前 A* 路网。

`path` 是可直接绘制的有序点列，并同时提供 WGS84 `longitude` / `latitude` 和早期客户端使用的 `x` / `y`；后者只为兼容保留，不应解释为地理坐标。`segments` 是后端导航应优先使用的有序路段，逐段给出起终点经纬度、距离、`highway`、`segmentType`、可用模式、OSM way 或室内要素来源。`geometry` 是可直接读取的 GeoJSON `LineString`。

## 会议与活动专属导航

“活动专属导航”可配置主会场、签到地点、多个分会场、住宿地点和推荐食堂。每个场所可以单独记录显示名称、地图地点 ID、楼层、房间和现场说明；只有绑定了公开地图地点的场所才能触发导航。

仓库内置“八月真机展示活动”作为默认模式：主会场为三楼，不设分会场，不提供住宿。具体房间、签到点、推荐食堂和地图锚点尚未确认，因此默认显示“待绑定/待配置”，助手不会猜测地点。组织者可在页面新建或编辑活动：

1. 从下拉框选择活动，点击“配置”；“＋”可新建独立活动。
2. 为场所选择 LubanNav 公开地图地点，并补充楼层、房间或集合说明。
3. 保存后即可点击场所的“导航”，或对助手说“带我去主会场”“去签到点”。

网页自定义配置保存在当前浏览器 `localStorage`，适合现场快速配置，不会自动上传或跨设备同步。需要所有访客共享的活动应写入 `src/data/events.js` 并重新部署；部署后也可通过 `GET api/v1/events.json` 读取。分享链接用 `event=<id>` 指定活动，`event=none` 表示普通校园导航。

### 无 OSM 后端如何自行寻路

1. GET 并缓存 `api/v1/routing-graph.json`，用 `graph.nodes` 建立节点索引，用 `graph.edges` 建立无向邻接表。
2. 从 `locations[地点ID].routing.routingByMode[模式]` 读取 `routingNodeId`、完整 `routingNode` 和 `connectorDistanceMeters`。
3. 只保留 `edge.modes` 包含当前模式的边，使用 `distanceMeters` 作为 A* 或 Dijkstra 权重。
4. 将起终点的 `connectorDistanceMeters` 计入总距离；地点入口和图节点的坐标都已内嵌，无需查询 OSM node/way。

如果起点和终点都在公开地点列表中，更简单的方式是直接 GET 预计算路线 JSON；其 `segments` 已经是从入口到目的地的完整有序路径。

## 浏览器连接机器人小车

LubanNav 使用 [Web Bluetooth API](https://developer.chrome.com/docs/capabilities/bluetooth) 让网页作为 BLE Central / GATT Client 连接机器人小车。GitHub Pages 是 HTTPS 安全上下文；设备选择仍必须由操作者点击按钮触发，浏览器不会在后台静默连接设备。

推荐使用 Android Chrome，或支持 Web Bluetooth 的 macOS / Windows / ChromeOS Chromium 浏览器。小车必须提供 BLE GATT Service；传统 Bluetooth Classic RFCOMM 串口不属于 Web Bluetooth 的能力范围。

使用流程：

1. 在导航对象中选择“机器人”，确认路线避开未核验的室内段。
2. 展开“GATT 与分包设置”，填写小车固件的 Service、Command/RX 和 Telemetry/TX UUID。设备名前缀默认为 `car7`，UUID 默认值兼容 Nordic UART Service。
3. 点击“选择并连接小车”，在浏览器设备选择器中人工选择设备。
4. 点击“下发当前路线”。网页把路线编码为 UTF-8 JSON Lines，默认按 20 字节顺序写入；切换路线不会自动向小车发送。
5. 小车通过 TX Notify 回传 `position`、`ack` 或 `status`。合法 WGS84 位置会显示在地图上。
6. “STOP”会中止未完成的路线传输并优先发送 `emergency_stop`，但不能替代物理急停。

固件消息、分包重组和安全边界详见 [`docs/robot-ble-protocol.md`](docs/robot-ble-protocol.md)，机器可读合约位于 `api/v1/robot-ble-protocol.json`。

没有小车时，可在带蓝牙的 Mac 上运行 `npm run ble:simulator`，让 Android 手机连接本机广播的 `car7`，实测 GATT 连接、分包任务、位置回传、STOP 和断连停止。完整步骤见 [`docs/car7-local-ble-test.md`](docs/car7-local-ble-test.md)。模拟器只回放遥测，不发布 ROS2 `/cmd_vel`，不会驱动电机。

> 正式小车仍需用真实 UUID 和固件联调，并在小车端实现失联看门狗、指令去重、定位、避障、制动和实体急停。

### car7 能扫描但无法连接

新版面板会区分以下阶段：`device-selection`、`gatt-connect`、`primary-service`、`command-characteristic`、`telemetry-characteristic` 和 `notifications`。如果显示 `primary-service`，说明浏览器已经选中并连接 car7，但固件并不提供当前填写的 Service UUID；这不是扫描问题。

请使用 Android 上的 nRF Connect 或固件源码读取 car7 的 GATT 表，然后把实际 Service、可写 RX 和支持 Notify 的 TX UUID 填入面板。如果在 nRF Connect 中只能看到 Bluetooth Classic SPP/RFCOMM，网页 Web Bluetooth 无法访问该串口，需要修改小车为 BLE GATT 固件或使用原生 Android 桥接应用。

## AI 语音会话

文字助手会优先在浏览器本地回答常见问候、学校简介、四大枢纽、位置、随身物品、途经点介绍和天气提醒；导航目的地仍由本地解析器和 A* 路网处理。天气提问会调用免密钥的 Open-Meteo（`src/lib/weather.js`）返回实时温度、降水概率与紫外线，并针对 3 楼露天平台给出带伞 / 防晒 / 雷雨避让提醒；获取失败时明确告知无法判断实时天气并建议查看可靠天气应用。

点击“开始语音”后，浏览器生成 WebRTC Offer SDP，并交给阿里云函数计算完成访问码校验和百炼 SDP 交换；获得 Answer SDP 后，麦克风音频通过 WebRTC 直连阿里云百炼 `qwen3.5-omni-flash-realtime`。百炼浏览器端点不接受跨域 SDP 请求，因此函数计算必须代理这个建连步骤。长期百炼 API Key 与 Workspace ID 只存在于函数计算环境变量中，不进入网页、GitHub 仓库或浏览器。单次会话在前端限制为 3 分钟；访问码只保存在当前页面内存，刷新后清除。

语音模型通过 Function Calling 调用 `set_navigation_route`，只返回白名单内的 `{from, to, mode}` 地点 ID。页面验证这些参数后调用现有本地 A* 寻路并刷新地图，再把真实距离和耗时作为工具结果返回给模型进行语音确认。模型不会生成路径坐标，也不能绕过本地地点白名单和寻路内核。

### 使用语音更新路线

1. 使用 HTTPS 下的最新版 Chrome 或 Edge 打开在线页面。
2. 首次点击地图下方的麦克风会打开“实时语音”设置；输入演示访问码后，可从设置或常驻麦克风开始会话，并允许浏览器使用麦克风。
3. 说出“从校门口导航到 W-4”“带我去图书馆”或“让机器人从宿舍 5 去体育馆”。
4. 模型提取地点 ID 和模式后，页面会自动更新起终点控件、地图路线、距离、耗时和地址栏查询参数。
5. 用户没有说明起点时沿用页面当前起点；地点不明确或不在白名单中时，助手应追问而不是猜测。

模型可调用的参数保持很小：

```json
{
  "from": "main-entrance",
  "to": "w4",
  "mode": "pedestrian"
}
```

- `from`：可选；省略时沿用当前起点。
- `to`：必填；必须是 `locations.json` 中的公开地点 ID。
- `mode`：`pedestrian` 或 `robot`；机器人、轮椅或无障碍表达映射为 `robot`。

语音输入保留两层保障：浏览器收到完整 ASR 转写后会先尝试本地解析，以降低常见导航句式的延迟；Qwen Function Calling 负责处理更自然或依赖上下文的表达。无论来自哪一层，最终参数都会再次通过本地点位白名单验证。

本地开发可在不提交的 `.env.local` 中覆盖语音网关地址：

```bash
# 可选；不填写时使用项目默认的函数计算地址
VITE_VOICE_GATEWAY_URL=https://your-domain.example/voice/session
```

访问码、Workspace ID 和 API Key 都不要写入 Vite 环境变量，因为所有 `VITE_*` 值都会出现在构建后的公开 JavaScript 中。访问码由访客在页面临时输入；另外两项只配置在函数计算。

GitHub Pages 部署时，在仓库 **Settings → Secrets and variables → Actions → Variables** 中设置：

- `VOICE_GATEWAY_URL`：可选，自定义域名或 API 网关的 `/voice/session` 地址；未设置时使用项目默认函数地址。

函数计算需要允许 Pages 域名发起 `POST` 和预检 `OPTIONS`，并在服务端执行来源白名单、访问码校验、频率限制和每日配额。可直接部署 [`services/voice-gateway/server.mjs`](services/voice-gateway/server.mjs)，完整环境变量和请求合约见 [`services/voice-gateway/README.md`](services/voice-gateway/README.md)。函数不向浏览器返回任何百炼密钥。

## 本地开发

要求 Node.js 20+：

```bash
npm install
npm run dev
```

验证并构建：

```bash
npm test
npm run build
npm run preview
```

`npm run build` 会先生成 `routing-graph.json`、地点绑定和 `public/api/v1/routes/` 静态路径响应，再由 Vite 写入 `dist/`。生成文件被 Git 忽略，避免提交大量机械产物。

### 分支约定

前端组的功能分支一律使用 `fe-` 前缀（如 `fe-robot-direction-pad`），从 `main` 拉出，完成后合并回 `main`（建议 `git merge --no-ff` 保留合并记录）。真机（car7）上的校园小车仓库 `campusCar` 只提交、不推送。

从本地 3D 俯瞰图重新提取水泥色平面候选：

```bash
npm run extract:walkable -- \
  --input /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces
```

脚本使用固定版本的 NumPy/Pillow，输出栅格掩膜、叠加预览、摘要和归一化图像坐标 GeoJSON。进入导航图前仍须复核 WGS84 控制点、完成地面/屋顶/立面分类，并核验楼梯、电梯或坡道连接。

使用八栋核心教学楼将候选面配准到 WGS84：

```bash
npm run register:walkable -- \
  --image /absolute/path/to/campus-render.jpg \
  --output-dir artifacts/walkable-surfaces-registration
```

配准报告记录每栋楼的拟合残差、反投影像素残差和留一验证残差。数值通过只表示八栋楼控制点足以支持初始几何配准，不表示候选面已经具备通行资格。

## OSM 数据层

网页不会在运行时请求 OSM 在线瓦片。`public/data/campus-osm.geojson` 是一个约 76 KB 的同源快照，只保留：

- `building` 建筑；
- `entrance` / `routing:entrance` 入口点；
- `highway` 道路和步行路径；
- `natural=water` 水面；
- `waterway` 水系。

需要刷新时运行：

```bash
npm run refresh:osm
npm test
npm run build
```

刷新脚本向公共 Overpass API 请求固定校园范围，白名单保留必要标签和道路的 OSM 节点 ID，并写入来源、抓取时间、边界、署名和许可证。随后它会自动重建 `src/data/osm-routing.json`。刷新后的 GeoJSON 与路网 JSON 都是需要审查并提交的来源/派生数据，不在普通构建中联网生成。

### OSM 路网与入口吸附规则

`npm run generate:routing` 完全离线、可复现地执行以下步骤：

1. 只选择 `footway`、`path`、`pedestrian`、`service`，过滤 `access=no/private` 和明确禁止步行的道路；机器人模式另外过滤 `wheelchair=no` 与明确不可通行的松软路面。
2. 使用每条 OSM way 的原始节点 ID 将相邻坐标转成带米制距离的无向边，并保留最大的步行/机器人共同连通分量。
3. 若建筑边界已有有效 OSM `entrance=*`，优先使用该点；若没有，则计算建筑边界上距离可通行道路节点最近的点，并标记为 `inferred-building-boundary`。
4. 将入口绑定到最近道路节点，记录 `roadNodeId`、`snapDistanceMeters`、建筑/入口 OSM ID 与来源。
5. 把通过校验的室内入口、走廊和地点锚点接入同一张图，A* 根据模式在室外与室内边上统一搜索。

当前快照与室内补丁生成 341 个节点、358 条边，其中 OSM 共同连通分量有 277 个节点；29 个公开地点均有绑定。API 不仅返回 `roadNodeId`，还内嵌对应节点坐标并提供完整路网下载；单条路线将 OSM 道路、入口连接段、楼层通道与电梯段逐段返回，便于调用方离线导航并识别推断部分。

### 如何添加室内搜索空间

OSM 推荐让建筑入口节点同时连接室内外路径，室内线性导航路径使用 `highway=corridor`、`indoor=yes` 和 `level=*`；完整楼层也可以进一步使用 [Simple Indoor Tagging](https://wiki.openstreetmap.org/wiki/Simple_Indoor_Tagging) 的 `indoor=corridor/area/room` 面要素。

当前 OSM 没有港科大广州图书馆、W2/E2 和三楼室外平台的完整分层要素，也没有西翼/东翼大堂入口点，因此 `public/data/campus-indoor.geojson` 保存可独立审查的本地入口、室内路由与高层室外平台补丁。

`entrancePoi` 用于补充可搜索的本地入口锚点。西翼大堂沿用用户确认的 POI；东翼大堂入口按西翼 POI 在 W1 中的相对端部位置映射到 E1，对应坐标为 `[113.4776200, 22.8904414]`。生成器要求入口 POI 位于目标建筑内且距建筑边界不超过 5 米，并记录 `evidence`、`inferredFrom` 与 `verificationStatus`。稳定地点 ID 仍为 `west-concourse` 和 `east-concourse`，旧称“西翼大学 / 东翼大学”继续作为搜索别名。

W2/E2 使用用户标注截图中的近似位置补充两组 POI：稳定 ID `w2`、`e2` 现在分别显示为 `W2-大堂`、`E2-大堂`，新增 `w2-elevator` 与 `e2-elevator`。两部电梯声明服务 `1–5F`，生成器会把 `indoorVerticalConnector` 展开为逐层节点和 `highway=elevator` 边；两侧 `3F` 节点接入共享的 `third-floor-platform`（显示名“三楼中央”），平台再连接 `platform-restaurant`。用户已确认三楼平台位于室外，因此平台节点和水平通道以 `outdoor=true` 进入步行与机器人搜索空间；到达平台所需的 W2/E2 大堂—电梯—3F 出口链路同步开放机器人路线。平台餐厅和中部二楼通道仍只开放步行。自然语言可直接使用“W2”“E2”“W2电梯”“三楼中央”“三楼平台”“嘉宾晚宴餐厅”等名称。

共享室内网络使用三类可审查要素：

- `indoorNetworkNode`：大堂、平台、餐厅和楼层内转折点，可选绑定公开 `locationId`。
- `indoorNetworkLink`：同层通道，显式引用 `fromNodeId` / `toNodeId`。
- `indoorVerticalConnector`：电梯点，声明 `levels`、默认楼层和层高成本，生成逐层垂直边。

共享室内网络入口带有仅用于路径选择的换楼入口惩罚，避免与目的地无关的路线把建筑当作室外捷径；API 返回的实际距离仍只累计几何和电梯段距离，不把该偏好惩罚伪装成真实长度。

每条室内路径至少需要：

```json
{
  "properties": {
    "featureClass": "indoorPath",
    "locationId": "library",
    "buildingFeatureId": "way/1098450394",
    "highway": "corridor",
    "indoor": "yes",
    "level": "0",
    "modes": ["pedestrian"],
    "verificationStatus": "approximate-unverified"
  },
  "geometry": {
    "type": "LineString",
    "coordinates": [
      [113.4776064, 22.8925129],
      [113.4778300, 22.8923900],
      [113.4780569, 22.8923387]
    ]
  }
}
```

生成器会拒绝入口偏差超过 3 米、室内点落到建筑轮廓外、缺少楼层或没有步行权限的补丁。未核验室内段默认只加入 `pedestrian`；只有现场验证门宽、坡度、门禁和机器人可达性后，同时设置 `"modes": ["pedestrian", "robot"]` 与 `"robotValidated": true`，才会进入机器人搜索空间。

图书馆当前加入约 51 米的 0 层室内段。W2/E2 大堂、电梯、三楼平台、平台餐厅和中部二楼电梯路径均来自用户描述与截图近似定位，尚未经过楼层图或现场测量。三楼平台已按用户确认修正为室外空间，并连同 W2/E2 电梯访问链路开放机器人搜索；平台餐厅、中部二楼路径和图书馆室内段仍只进入步行搜索空间。路线开放不等同于无人值守控制许可，真实小车仍需现场核验门宽、电梯交互、定位、避障与急停。

## GitHub Pages 部署

仓库已经包含 `.github/workflows/deploy-pages.yml`。将默认分支推送为 `main` 后，在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。此后每次推送到 `main` 都会先测试、构建，再部署 Pages。

Vite 使用相对 `base`，因此可同时部署在用户主页和项目子路径，无需填写仓库名。

## 代码边界

```text
src/data/campus.js             稳定地点 ID、别名、OSM 建筑映射与模式
src/data/events.js             仓库内置的活动模式与会场数据
public/data/campus-osm.geojson 建筑、入口、水域和道路的 OSM 快照
public/data/campus-indoor.geojson  分层室内路径补丁与核验状态
src/data/osm-routing.json      自动生成的 OSM 寻路图与入口绑定
src/lib/pathfinding.js         室内外统一图上的 A* 路由与机器可读响应
src/lib/destinationParser.js   本地中英文意图/地点解析
src/lib/eventMode.js           活动配置校验、本地存储与活动地点解析
src/lib/voiceNavigation.js     语音导航工具定义、地点白名单与参数验证
src/lib/qwenRealtime.js        WebRTC 会话、Function Calling 与工具结果回传
src/components/CampusMap.jsx   Leaflet Canvas 地图、地点和路线叠加
src/components/EventPanel.jsx  活动选择、会场清单与本地配置界面
src/components/ChatAssistant.jsx  对话入口
src/components/VoiceAssistant.jsx 实时语音连接、转写与导航工具桥接
src/components/RobotControl.jsx     Web Bluetooth 连接、任务下发与遥测面板
services/voice-gateway/server.mjs  函数计算 SDP 代理、访问码与 CORS 防护
scripts/fetch-osm-campus.mjs      OSM / Overpass 快照刷新器
scripts/lib/osm-routing.mjs       道路转图、连通分量与入口吸附算法
scripts/generate-osm-routing.mjs  OSM 寻路图生成器
scripts/generate-static-api.mjs   GitHub Pages 静态 GET API 生成器
docs/robot-ble-protocol.md        BLE GATT、JSON Lines 分包与固件消息合约
```

地点 ID 仍是稳定 API 合约；OSM way/node ID、入口来源和吸附距离是可随数据刷新变化的派生信息。真实机器人部署还需要至少增加：厘米级或满足任务要求的定位、现场可通行性校验、动态避障、门禁/电梯接口、实时封路、速度与制动安全层，以及人工急停机制。

## “AI 对话”的准确含义

文字导航和常见问答优先使用确定性的本地意图解析、模糊地点匹配与缓存，保持轻量、可复现并支持离线使用。实时语音启用后，Qwen 只负责理解对话并通过工具调用产出受约束的 `{from, to, mode}` 提案；本地路由内核仍负责验证地点、计算路径并更新地图。模型不会直接生成或下发机器人运动轨迹。
