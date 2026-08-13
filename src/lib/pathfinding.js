import { DATASET, EDGES, MODES, NODE_BY_ID, NODES } from '../data/campus.js';

function heuristic(aId, bId) {
  const a = NODE_BY_ID[aId];
  const b = NODE_BY_ID[bId];
  return Math.hypot(a.x - b.x, a.y - b.y) * 0.55;
}

function adjacencyFor(mode) {
  const graph = new Map(NODES.map((node) => [node.id, []]));
  const allowed = mode.accessibleOnly ? EDGES.filter((item) => item.accessible) : EDGES;

  for (const item of allowed) {
    graph.get(item.from).push({ ...item, node: item.to });
    graph.get(item.to).push({ ...item, node: item.from });
  }

  return graph;
}

function reconstruct(cameFrom, current) {
  const path = [current];
  while (cameFrom.has(current)) {
    current = cameFrom.get(current);
    path.unshift(current);
  }
  return path;
}

function edgeBetween(from, to) {
  return EDGES.find(
    (item) => (item.from === from && item.to === to) || (item.from === to && item.to === from),
  );
}

function makeInstructions(pathIds) {
  if (pathIds.length === 1) {
    return [`已在${NODE_BY_ID[pathIds[0]].name}`];
  }

  const visibleStops = pathIds.filter((id) => NODE_BY_ID[id].public);
  const instructions = [`从${NODE_BY_ID[pathIds[0]].name}出发`];
  visibleStops.slice(1, -1).forEach((id) => instructions.push(`途经${NODE_BY_ID[id].name}`));
  instructions.push(`抵达${NODE_BY_ID[pathIds[pathIds.length - 1]].name}`);
  return instructions;
}

export function findRoute(from, to, modeId = 'pedestrian') {
  const mode = MODES[modeId];
  if (!NODE_BY_ID[from]?.public) throw new Error(`Unknown public origin: ${from}`);
  if (!NODE_BY_ID[to]?.public) throw new Error(`Unknown public destination: ${to}`);
  if (!mode) throw new Error(`Unknown mode: ${modeId}`);

  const graph = adjacencyFor(mode);
  const open = new Set([from]);
  const cameFrom = new Map();
  const gScore = new Map(NODES.map((node) => [node.id, Number.POSITIVE_INFINITY]));
  const fScore = new Map(NODES.map((node) => [node.id, Number.POSITIVE_INFINITY]));
  gScore.set(from, 0);
  fScore.set(from, heuristic(from, to));

  while (open.size) {
    const current = [...open].reduce((best, id) =>
      fScore.get(id) < fScore.get(best) ? id : best,
    );

    if (current === to) {
      const pathIds = reconstruct(cameFrom, current);
      const distanceMeters = Math.round(
        pathIds
          .slice(1)
          .reduce((total, id, index) => total + edgeBetween(pathIds[index], id).distance, 0),
      );
      const durationSeconds = Math.ceil(distanceMeters / mode.speedMetersPerSecond);

      return {
        schemaVersion: '1.0',
        dataset: DATASET.id,
        status: 'ok',
        request: { from, to, mode: modeId },
        summary: {
          distanceMeters,
          durationSeconds,
          distanceEstimated: true,
        },
        path: pathIds.map((id) => {
          const node = NODE_BY_ID[id];
          return { id: node.id, name: node.name, x: node.x, y: node.y };
        }),
        instructions: makeInstructions(pathIds),
        disclaimer: DATASET.disclaimer,
      };
    }

    open.delete(current);
    for (const neighbor of graph.get(current)) {
      const tentative = gScore.get(current) + neighbor.distance;
      if (tentative < gScore.get(neighbor.node)) {
        cameFrom.set(neighbor.node, current);
        gScore.set(neighbor.node, tentative);
        fScore.set(neighbor.node, tentative + heuristic(neighbor.node, to));
        open.add(neighbor.node);
      }
    }
  }

  return {
    schemaVersion: '1.0',
    dataset: DATASET.id,
    status: 'no_route',
    request: { from, to, mode: modeId },
    disclaimer: DATASET.disclaimer,
  };
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} 分钟`;
}
