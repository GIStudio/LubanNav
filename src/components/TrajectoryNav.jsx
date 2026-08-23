import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  loadTrajectory,
  startTrajectory,
  stopTrajectory,
  DEFAULT_NAV_SPEED,
} from '../lib/car7Trajectory.js';

/**
 * TrajectoryNav — a control bar that loads the car's recorded RTK trajectory,
 * displays it on the campus map, and dispatches a *real* navigation run to the
 * car (via 8901 POST /api/trajectory/start -> car7_navigator).
 *
 * Props:
 *   onTrajectoryChange(update) — report {points, playing, index} up to App so
 *     CampusMap can draw the green trajectory line + replay highlight.
 */
export function TrajectoryNav({ onTrajectoryChange }) {
  const [points, setPoints] = useState([]);
  const [info, setInfo] = useState('—');
  const [navState, setNavState] = useState('idle'); // idle | running | stopped | error
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [replayTimer, setReplayTimer] = useState(null);
  const [replayIndex, setReplayIndex] = useState(0);
  const [speed, setSpeed] = useState(DEFAULT_NAV_SPEED);

  const report = useCallback((next) => {
    onTrajectoryChange?.(next);
  }, [onTrajectoryChange]);

  const load = useCallback(async () => {
    setLoading(true);
    setInfo('加载轨迹中…');
    try {
      const data = await loadTrajectory();
      const pts = data?.points ?? [];
      setPoints(pts);
      const meta = data?.meta ?? {};
      setInfo(
        `全轨 ${pts.length} 点 · ${meta.durationSeconds != null ? `${meta.durationSeconds}s` : '—'}` +
          ` · 导航: ${data?.navigator?.running ? '运行中' : '停止'}`,
      );
      report({ points: pts, playing: false, index: 0 });
    } catch (error) {
      setInfo(`轨迹加载失败: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    load();
    return () => {
      if (replayTimer) clearInterval(replayTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startPlay = () => {
    if (!points.length) return;
    if (replayTimer) clearInterval(replayTimer);
    report({ points, playing: true, index: 0 });
    setReplayIndex(0);
    setReplayTimer((current) => {
      if (current) clearInterval(current);
      return setInterval(() => {
        setReplayIndex((index) => {
          const next = (index + 1) % points.length;
          report({ points, playing: true, index: next });
          return next;
        });
      }, 120);
    });
  };

  const stopPlay = () => {
    if (replayTimer) {
      clearInterval(replayTimer);
      setReplayTimer(null);
    }
    report({ points, playing: false, index: 0 });
  };

  const navigate = async () => {
    if (!points.length) {
      setInfo('请先加载轨迹');
      return;
    }
    if (!window.confirm(`将沿这条 RTK 轨迹让小车自主行驶（速度 ${speed.toFixed(1)} m/s，需 RTK 固定解）。确认下发？`)) return;
    setBusy(true);
    setInfo('正在下发导航…');
    try {
      const data = await startTrajectory(points, { speed });
      setInfo(
        data?.ok
          ? `🚗 导航已下发：${data.trajectoryPoints} 点 @ ${speed.toFixed(1)} m/s`
          : `❌ ${data?.error || '启动失败'}`,
      );
      setNavState(data?.ok ? 'running' : 'error');
    } catch (error) {
      setInfo(`导航下发失败: ${error.message}`);
      setNavState('error');
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const data = await stopTrajectory();
      setInfo(data?.stopped ? '⏹ 导航已停止' : '导航未在运行');
      setNavState('idle');
    } catch (error) {
      setInfo(`停止失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="trajectory-nav">
      <div class="traj-nav-head">
        <span class="traj-nav-title">🚗 真实轨迹导航</span>
        <span class="traj-nav-info">{info}</span>
      </div>
      <div class="traj-nav-controls">
        <button type="button" onClick={load} disabled={loading}>
          {loading ? '加载中…' : '🔄 加载轨迹'}
        </button>
        <button type="button" onClick={startPlay} disabled={!points.length}>
          ▶ 回放
        </button>
        <button type="button" onClick={stopPlay}>
          ⏹ 停止
        </button>
        <label class="traj-nav-speed">
          速度
          <input
            type="range"
            min="0.5"
            max="5.0"
            step="0.1"
            value={speed}
            onChange={(event) => setSpeed(Number(event.currentTarget.value))}
          />
          <strong>{speed.toFixed(1)} m/s</strong>
        </label>
        <button type="button" class="primary" onClick={navigate} disabled={busy || !points.length}>
          {busy ? '下发中…' : '🚗 下发导航'}
        </button>
        <button type="button" class="danger" onClick={stop} disabled={busy}>
          ⏹ 停止导航
        </button>
      </div>
    </div>
  );
}
