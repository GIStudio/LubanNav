import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  startTrajectory,
  stopTrajectory,
  DEFAULT_NAV_SPEED,
} from '../lib/car7Trajectory.js';

/**
 * TrajectoryNav — 右上角面包屑下的"轨迹重演"入口（顶栏按钮 + 下拉面板）。
 *
 * 展示模式: 不用校园 findRoute, 直接接入我们做的 RTK 轨迹重演——
 *   - 启动小车沿 RTK 轨迹真实行走(8901 POST /api/trajectory/start -> car7_navigator);
 *   - 前端"走过的轨迹段"由实时 RTK 位置驱动(CampusMap 只绘制点+已走过的路线)。
 * 这里只负责: 选轨迹 / 调速度 / 启动真车重演 / 停止。进度绘制交给 App(实时 RTK)。
 *
 * Props:
 *   onTrajectoryChange({points}) — 上报轨迹点给 App -> CampusMap(仅供 progress 用)。
 *   replayTrigger({points, nav, tick}) — 演示流程(打招呼→放包)触发重演。
 */
export function TrajectoryNav({ onTrajectoryChange, replayTrigger }) {
  const [open, setOpen] = useState(false);
  const [demoList, setDemoList] = useState([]);
  const [selected, setSelected] = useState('');
  const [points, setPoints] = useState([]);
  const [info, setInfo] = useState('—');
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_NAV_SPEED);

  const report = useCallback((pts) => {
    onTrajectoryChange?.({ points: pts });
  }, [onTrajectoryChange]);

  const loadTrajectory = useCallback(async (file) => {
    setInfo('加载轨迹…');
    try {
      const r = await fetch(`/data/trajectories/${encodeURIComponent(file)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const pts = data.points || [];
      setPoints(pts);
      report(pts);
      setInfo(`已加载「${data.meta?.count ?? pts.length} 点」 · 速度 ${speed.toFixed(1)} m/s`);
    } catch (error) {
      setInfo(`轨迹加载失败: ${error.message}`);
    }
  }, [speed, report]);

  // 挂载: 读内置演示轨迹列表, 默认选第一个并上报(进度绘制交给实时RTK)
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/data/trajectories/index.json', { cache: 'no-store' });
        if (!r.ok) throw new Error('no demo list');
        const list = await r.json();
        setDemoList(list);
        if (list[0]?.file) { setSelected(list[0].file); await loadTrajectory(list[0].file); }
      } catch {
        setInfo('未找到演示轨迹');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 演示流程触发: 启动小车沿轨迹重演(真车), 并上报轨迹给前端
  useEffect(() => {
    if (!replayTrigger?.points?.length) return;
    const pts = replayTrigger.points;
    setPoints(pts);
    report(pts);
    if (replayTrigger.nav) {
      setInfo('正在启动小车…');
      startTrajectory(pts, { speed })
        .then((data) => setInfo(data?.ok ? `🚗 轨迹重演已启动：${data.trajectoryPoints} 点 @ ${speed.toFixed(1)} m/s` : `❌ ${data?.error || '启动失败'}`))
        .catch((error) => setInfo(`启动失败: ${error.message}`));
    } else {
      setInfo(`轨迹重演：${pts.length} 点`);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayTrigger?.tick]);

  const navigate = async () => {
    if (!points.length) { setInfo('请先加载轨迹'); return; }
    if (!window.confirm(`启动小车沿这条 RTK 轨迹重演（速度 ${speed.toFixed(1)} m/s，需 RTK 固定解）。确认？`)) return;
    setBusy(true);
    setInfo('正在启动小车…');
    try {
      const data = await startTrajectory(points, { speed });
      setInfo(data?.ok ? `🚗 轨迹重演已启动：${data.trajectoryPoints} 点 @ ${speed.toFixed(1)} m/s` : `❌ ${data?.error || '启动失败'}`);
    } catch (error) {
      setInfo(`启动失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const data = await stopTrajectory();
      setInfo(data?.stopped ? '⏹ 轨迹重演已停止' : '小车未在重演');
    } catch (error) {
      setInfo(`停止失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stateLabel = busy ? '启动中…' : (/已启动/.test(info) ? '重演中' : '待命');

  return (
    <div class="trajcrumb">
      <button type="button" class="trajcrumb-trigger" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <i class={`trajcrumb-dot ${points.length ? 'on' : ''}`} />
        <span class="trajcrumb-label">轨迹导航</span>
        <span class="trajcrumb-state">{stateLabel}</span>
      </button>
      {open && (
        <div class="trajcrumb-panel" role="dialog" aria-label="轨迹导航">
          <div class="traj-nav-info">{info}</div>
          <div class="trajcrumb-row">
            <label class="traj-nav-traj">
              轨迹
              <select
                value={selected}
                onChange={(event) => { setSelected(event.currentTarget.value); loadTrajectory(event.currentTarget.value); }}
              >
                {demoList.map((item) => <option key={item.file} value={item.file}>{item.name} · {item.points}点</option>)}
              </select>
            </label>
            <label class="traj-nav-speed">
              速度
              <input type="range" min="0.5" max="5.0" step="0.1" value={speed}
                onChange={(event) => setSpeed(Number(event.currentTarget.value))} />
              <strong>{speed.toFixed(1)} m/s</strong>
            </label>
          </div>
          <div class="trajcrumb-row">
            <button type="button" class="primary" onClick={navigate} disabled={busy || !points.length}>
              {busy ? '启动中…' : '🚗 轨迹重演'}
            </button>
            <button type="button" class="danger" onClick={stop} disabled={busy}>⏹ 停止</button>
          </div>
        </div>
      )}
    </div>
  );
}
