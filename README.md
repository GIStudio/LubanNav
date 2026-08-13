# LubanNav

面向香港科技大学（广州）校园的轻量导航 Web 应用原型。它提供只包含建筑、水域和道路的本地 OpenStreetMap Canvas 地图、由 OSM `highway=footway/path/pedestrian/service` 自动生成的 A* 路网、建筑入口吸附、AI 导航助手式对话与本地自然语言目的地解析，以及可被 AI/机器人客户端直接 HTTP GET 的静态 JSON 路径 API。

> 当前版本是工程演示，不是学校官方导航产品。建筑、入口、水域和道路来自 [OpenStreetMap](https://www.openstreetmap.org/way/894157108)，地图数据采用 [ODbL 1.0](https://www.openstreetmap.org/copyright)；OSM 缺少入口时会推断建筑边界入口，导航拓扑与可通行性仍未经现场测绘，不可直接用于真实机器人运动控制。

## 为什么静态站点也能提供 GET API

GitHub Pages 不运行服务端代码。构建时，LubanNav 会为所有公开地点组合预计算路径，并输出独立 JSON 文件。因此普通 HTTP 客户端无需执行 JavaScript，也能直接获得路线：

```text
GET https://<user>.github.io/<repo>/api/v1/locations.json
GET https://<user>.github.io/<repo>/api/v1/routes/main-entrance/library.pedestrian.json
GET https://<user>.github.io/<repo>/api/v1/routes/dorm-5/sports-hall.robot.json
```

完整机器可读目录位于 `api/v1/catalog.json`，网页 API 说明位于 `api/`。

响应示例：

```json
{
  "schemaVersion": "1.1",
  "dataset": "hkustgz-osm-routing-v2",
  "status": "ok",
  "request": {
    "from": "main-entrance",
    "to": "library",
    "mode": "pedestrian"
  },
  "summary": {
    "distanceMeters": 942,
    "durationSeconds": 754,
    "distanceEstimated": true,
    "roadDistanceMeters": 896,
    "connectorDistanceMeters": 46
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
  "routing": {
    "engine": "osm-highway-a-star",
    "allowedHighways": ["footway", "path", "pedestrian", "service"],
    "osmWayIds": [1192908727, 1154868989]
  },
  "instructions": ["从主入口入口出发", "...", "抵达图书馆入口"],
  "disclaimer": "..."
}
```

网页本身也支持可复现的 GET 查询参数：

```text
/?from=main-entrance&to=library&mode=pedestrian
/?q=从宿舍5到饭堂
```

第二种链接需要浏览器执行页面 JavaScript；需要原始 JSON 时使用上面的静态 API。

路径节点同时提供 WGS84 `longitude` / `latitude` 和早期客户端使用的 `x` / `y`。后者只为兼容保留，不应解释为地理坐标。

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

`npm run build` 会先在 `public/api/v1/routes/` 生成静态路径响应，再由 Vite 写入 `dist/`。生成文件被 Git 忽略，避免提交大量机械产物。

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
4. 将入口绑定到最近道路节点，记录 `roadNodeId`、`snapDistanceMeters`、建筑/入口 OSM ID 与来源；A* 只在生成的 OSM 图上寻路。

当前快照生成 317 个道路节点、332 条边，其中共同连通分量有 277 个节点；25 个公开地点均有绑定。OSM 校园步行数据仍不完整，API 会把入口连接段与道路段距离分别返回，便于调用方识别较大的推断连接。

## GitHub Pages 部署

仓库已经包含 `.github/workflows/deploy-pages.yml`。将默认分支推送为 `main` 后，在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。此后每次推送到 `main` 都会先测试、构建，再部署 Pages。

Vite 使用相对 `base`，因此可同时部署在用户主页和项目子路径，无需填写仓库名。

## 代码边界

```text
src/data/campus.js             稳定地点 ID、别名、OSM 建筑映射与模式
public/data/campus-osm.geojson 建筑、入口、水域和道路的 OSM 快照
src/data/osm-routing.json      自动生成的 OSM 寻路图与入口绑定
src/lib/pathfinding.js         OSM 图上的 A* 路由与机器可读响应
src/lib/destinationParser.js   本地中英文意图/地点解析
src/components/CampusMap.jsx   Leaflet Canvas 地图、地点和路线叠加
src/components/ChatAssistant.jsx  对话入口
scripts/fetch-osm-campus.mjs      OSM / Overpass 快照刷新器
scripts/lib/osm-routing.mjs       道路转图、连通分量与入口吸附算法
scripts/generate-osm-routing.mjs  OSM 寻路图生成器
scripts/generate-static-api.mjs   GitHub Pages 静态 GET API 生成器
```

地点 ID 仍是稳定 API 合约；OSM way/node ID、入口来源和吸附距离是可随数据刷新变化的派生信息。真实机器人部署还需要至少增加：厘米级或满足任务要求的定位、现场可通行性校验、动态避障、门禁/电梯接口、实时封路、速度与制动安全层，以及人工急停机制。

## “AI 对话”的准确含义

当前导航助手使用确定性的本地意图解析与模糊地点匹配，不调用外部大模型，也不上传用户文本。优势是体积极小、离线可用、结果可复现。后续若接入 LLM，应只让模型产出受约束的 `{from, to, mode}` 提案，再由本地路由内核验证地点与计算路径；不要让模型直接生成机器人运动轨迹。
