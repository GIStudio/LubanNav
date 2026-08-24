/**
 * 轨迹回放数据源（可替换接口）。
 *
 * 8/25 演示流程: 打招呼 → 用户说「带我/带我去三楼平台」→ 放包提示 → 开始轨迹回放
 * （前端模拟 + 真车下发导航）。「回放的数据」从这一个模块取 —— 将来要换新的
 * replay，只需改 `DEFAULT_REPLAY_ID` / `DEMO_REPLAYS`，前端演示流程与 TrajectoryNav
 * 无需改动。
 *
 * 数据本体在 public/data/trajectories/*.json（昨晚从车机拷贝的 E1 三楼→中央平台段）。
 */

// 内置演示轨迹列表（file 对应 public/data/trajectories/<file>）
export const DEMO_REPLAYS = [
  { id: 'traj-2026-08-23-12-28-23', name: '昨晚①(E1→平台,65点)', file: 'traj-2026-08-23-12-28-23.json' },
  { id: 'traj-2026-08-23-12-39-08', name: '昨晚②(93点)', file: 'traj-2026-08-23-12-39-08.json' },
  { id: 'traj-2026-08-23-12-53-08', name: '昨晚③(101点)', file: 'traj-2026-08-23-12-53-08.json' },
];

// 当前演示用哪条：换新的 replay 改这里即可（或指向新的 json 文件）
export const DEFAULT_REPLAY_ID = 'traj-2026-08-23-12-28-23';

export function currentReplay() {
  return DEMO_REPLAYS.find((item) => item.id === DEFAULT_REPLAY_ID) || DEMO_REPLAYS[0];
}

/** 加载指定/默认演示轨迹的点序列 [{lat, lon, t, ...}]。 */
export async function loadReplayPoints(file = currentReplay().file) {
  try {
    const response = await fetch(`/data/trajectories/${encodeURIComponent(file)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return data.points || [];
  } catch {
    // 兜底: 若内置资源不可用, 尝试从车机 8901 拉当前记录
    const { loadTrajectory } = await import('./car7Trajectory.js');
    const live = await loadTrajectory();
    return live.points || [];
  }
}

/**
 * 识别「带我去三楼平台」类意图。
 * 优先用现有解析器(能识别"三楼平台/三楼中央" -> third-floor-platform), 再关键词兜底。
 */
export function detectThirdFloorIntent(text) {
  if (!text) return false;
  const raw = String(text);
  // 目标词(三楼平台) 与 动作词(带/去/到) 都出现即认为"带我去三楼平台"类意图, 不限中间字符数
  const hasTarget = /(三楼平台|三楼中央|3楼平台|3楼露天平台|3层平台|3f平台|三层平台|露天平台|平台中央|三楼露天)/i.test(raw);
  const hasAction = /(去|到|前往|带我|带我去|带我到|请你|麻烦|帮我|带)/i.test(raw);
  return hasTarget && hasAction;
}
