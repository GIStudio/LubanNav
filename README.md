# LubanNav

面向香港科技大学（广州）校园的轻量导航 Web 应用原型。它提供只包含建筑、水域和道路的本地 OpenStreetMap Canvas 地图、浏览器端 A* 寻路、AI 导航助手式对话与本地自然语言目的地解析，以及可被 AI/机器人客户端直接 HTTP GET 的静态 JSON 路径 API。

> 当前版本是工程演示，不是学校官方导航产品。建筑、水域和道路来自 [OpenStreetMap](https://www.openstreetmap.org/way/894157108)，地图数据采用 [ODbL 1.0](https://www.openstreetmap.org/copyright)；导航拓扑、距离和部分地点坐标仍未经现场测绘，不可直接用于真实机器人运动控制。

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
  "schemaVersion": "1.0",
  "dataset": "hkustgz-osm-navigation-v1",
  "status": "ok",
  "request": {
    "from": "main-entrance",
    "to": "library",
    "mode": "pedestrian"
  },
  "summary": {
    "distanceMeters": 588,
    "durationSeconds": 471,
    "distanceEstimated": true
  },
  "path": [
    {
      "id": "main-entrance",
      "longitude": 113.4783197,
      "latitude": 22.8878039
    }
  ],
  "instructions": [],
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

网页不会在运行时请求 OSM 在线瓦片。`public/data/campus-osm.geojson` 是一个约 69 KB 的同源快照，只保留：

- `building` 建筑；
- `highway` 道路和步行路径；
- `natural=water` 水面；
- `waterway` 水系。

需要刷新时运行：

```bash
npm run refresh:osm
npm test
npm run build
```

刷新脚本向公共 Overpass API 请求固定校园范围，白名单保留必要标签，并写入来源、抓取时间、边界、署名和许可证。刷新后的 GeoJSON 是需要审查并提交的来源数据，不在普通构建中联网生成。

## GitHub Pages 部署

仓库已经包含 `.github/workflows/deploy-pages.yml`。将默认分支推送为 `main` 后，在 GitHub 仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。此后每次推送到 `main` 都会先测试、构建，再部署 Pages。

Vite 使用相对 `base`，因此可同时部署在用户主页和项目子路径，无需填写仓库名。

## 代码边界

```text
src/data/campus.js             地点、别名、路径图、演示距离
public/data/campus-osm.geojson 建筑、水域和道路的 OSM 快照
src/lib/pathfinding.js         A* 路由与机器可读响应
src/lib/destinationParser.js   本地中英文意图/地点解析
src/components/CampusMap.jsx   Leaflet Canvas 地图、地点和路线叠加
src/components/ChatAssistant.jsx  对话入口
scripts/fetch-osm-campus.mjs      OSM / Overpass 快照刷新器
scripts/generate-static-api.mjs   GitHub Pages 静态 GET API 生成器
```

OSM 当前只负责可视化底图；A* 仍使用 `src/data/campus.js` 中的受控演示拓扑。接入测绘或正式路网时，优先替换该图结构并保留地点 ID 作为稳定 API 合约。真实机器人部署还需要至少增加：厘米级或满足任务要求的定位、可通行性校验、动态避障、门禁/电梯接口、实时封路、速度与制动安全层，以及人工急停机制。

## “AI 对话”的准确含义

当前导航助手使用确定性的本地意图解析与模糊地点匹配，不调用外部大模型，也不上传用户文本。优势是体积极小、离线可用、结果可复现。后续若接入 LLM，应只让模型产出受约束的 `{from, to, mode}` 提案，再由本地路由内核验证地点与计算路径；不要让模型直接生成机器人运动轨迹。
