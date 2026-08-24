import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import {
  startTrajectory,
  stopTrajectory,
  DEFAULT_NAV_SPEED,
} from '../lib/car7Trajectory.js';

/**
 * TrajectoryNav — 演示/联调控制条。
 *
 * 需求:
 *  - 鲁班 nav 直接下发命令让小车沿轨迹走 (8901 POST /api/trajectory/start -> car7_navigator)。
 *  - 不向用户展示 replay 界面(无回放控件)；
 *  - 但内部可以"模拟回放": 加载昨晚保存的演示轨迹后, 自动让地图上的高亮点沿轨迹移动。
 *
 * 轨迹数据来自项目内置 public/data/trajectories/*.json (昨晚从车机拷贝的 E1三楼→中央平台段)。
 *
 * Props:
 *   onTrajectoryChange(update) — 上报 {points, playing, index} 给 App -> CampusMap 画绿线+移动高亮点。
 */
export function TrajectoryNav({ onTrajectoryChange, replayTrigger }) {
  const [demoList, setDemoList] = useState([]);
  const [selected, setSelected] = useState('');
  const [points, setPoints] = useState([]);
  const [info, setInfo] = useState('—');
  const [busy, setBusy] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_NAV_SPEED);
  const timerRef = useRef(null);
  const pointsRef = useRef([]);
  pointsRef.current = points;

  const report = useCallback((pts, playing, idx) => {
    onTrajectoryChange?.({ points: pts, playing, index: idx });
  }, [onTrajectoryChange]);

  // 内部"模拟回放": 沿轨迹推进高亮点, 无任何回放控件
  const startAutoSim = useCallback((pts) => {
    if (timerRef.current) clearInterval(timerRef.current);
    const arr = pts?.length ? pts : pointsRef.current;
    if (!arr.length) return;
    let i = 0;
    report(arr, true, 0);
    timerRef.current = setInterval(() => {
      i = (i + 1) % arr.length;
      report(arr, true, i);
    }, 160);
  }, [report]);

  const stopAutoSim = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadTrajectory = useCallback(async (file) => {
    setInfo('加载轨迹…');
    try {
      const r = await fetch(`/data/trajectories/${encodeURIComponent(file)}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const pts = data.points || [];
      setPoints(pts);
      setInfo(`已加载「${data.meta?.count ?? pts.length} 点」 · 速度 ${speed.toFixed(1)} m/s`);
      startAutoSim(pts); // 加载即模拟回放(内部)
    } catch (error) {
      setInfo(`轨迹加载失败: ${error.message}`);
    }
  }, [speed, startAutoSim]);

  // 挂载: 读内置演示轨迹列表, 默认选第一个并自动播放(模拟)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch('/data/trajectories/index.json', { cache: 'no-store' });
        if (!r.ok) throw new Error('no demo list');
        const list = await r.json();
        if (cancelled) return;
        setDemoList(list);
        const first = list[0]?.file;
        if (first) {
          setSelected(first);
          await loadTrajectory(first);
        }
      } catch {
        if (!cancelled) setInfo('未找到演示轨迹');
      }
    })();
    return () => {
      cancelled = true;
      stopAutoSim();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部触发"开始轨迹回放"(演示流程: 打招呼→放包提示后调用): 模拟 + 可选真车下发
  useEffect(() => {
    if (!replayTrigger?.points?.length) return;
    const pts = replayTrigger.points;
    setPoints(pts);
    if (replayTrigger.nav) {
      setInfo('正在下发导航…');
      startTrajectory(pts, { speed })
        .then((data) => setInfo(data?.ok
          ? `🚗 导航已下发：${data.trajectoryPoints} 点 @ ${speed.toFixed(1)} m/s`
          : `❌ ${data?.error || '启动失败'}`))
        .catch((error) => setInfo(`导航下发失败: ${error.message}`));
    } else {
      setInfo(`演示回放：${pts.length} 点`);
    }
    startAutoSim(pts); // 模拟回放(小车 marker 沿轨迹动)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [replayTrigger?.tick]);

  const navigate = async () => {
    if (!points.length) {
      setInfo('请先加载轨迹');
      return;
    }
    if (!window.confirm(`让小车沿这条轨迹自主行驶（速度 ${speed.toFixed(1)} m/s，需 RTK 固定解，将暂停模拟）。确认下发？`)) return;
    stopAutoSim();
    setBusy(true);
    setInfo('正在下发导航…');
    try {
      const data = await startTrajectory(points, { speed });
      setInfo(
        data?.ok
          ? `🚗 导航已下发：${data.trajectoryPoints} 点 @ ${speed.toFixed(1)} m/s`
          : `❌ ${data?.error || '启动失败'}`,
      );
    } catch (error) {
      setInfo(`导航下发失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    try {
      const data = await stopTrajectory();
      setInfo(data?.stopped ? '⏹ 导航已停止' : '导航未在运行');
      startAutoSim(); // 停后回模拟
    } catch (error) {
      setInfo(`停止失败: ${error.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="trajectory-nav">
      <div class="traj-nav-head">
        <span class="traj-nav-title">🚗 轨迹导航</span>
        <span class="traj-nav-info">{info}</span>
      </div>
      <div class="traj-nav-controls">
        <label class="traj-nav-traj">
          轨迹
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.currentTarget.value);
              loadTrajectory(event.currentTarget.value);
            }}
          >
            {demoList.map((item) => <option key={item.file} value={item.file}>{item.name} · {item.points}点</option>)}
          </select>
        </label>
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
