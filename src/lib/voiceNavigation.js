import { MODES, NODE_BY_ID, PUBLIC_LOCATIONS } from '../data/campus.js';
import { matchLocation } from './destinationParser.js';

export const NAVIGATION_TOOL_NAME = 'set_navigation_route';

const LOCATION_IDS = PUBLIC_LOCATIONS.map((location) => location.id);

export const NAVIGATION_TOOL = Object.freeze({
  type: 'function',
  function: {
    name: NAVIGATION_TOOL_NAME,
    description:
      '当用户要求去某个校内地点、查询从一个地点到另一个地点的路线，或要求机器人前往某处时调用。该工具会让 LubanNav 页面使用本地寻路图更新路线。',
    parameters: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          enum: LOCATION_IDS,
          description: '起点的 LubanNav 地点 ID；用户没有明确起点时可以省略。',
        },
        to: {
          type: 'string',
          enum: LOCATION_IDS,
          description: '目的地的 LubanNav 地点 ID。',
        },
        mode: {
          type: 'string',
          enum: Object.keys(MODES),
          description: 'pedestrian 表示步行，robot 表示机器人或无障碍路线。',
        },
      },
      required: ['to'],
    },
  },
});

export function campusLocationCatalog() {
  return PUBLIC_LOCATIONS.map((location) => `${location.id}=${location.name}`).join('；');
}

function resolveLocation(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const exact = NODE_BY_ID[value.trim()];
  if (exact?.public) return exact;
  return matchLocation(value);
}

export function resolveNavigationCommand(
  input,
  currentOrigin = 'main-entrance',
  currentMode = 'pedestrian',
) {
  const command = input && typeof input === 'object' ? input : {};
  const from = resolveLocation(command.from) || resolveLocation(currentOrigin);
  const to = resolveLocation(command.to);
  const mode = MODES[command.mode] ? command.mode : (MODES[currentMode] ? currentMode : 'pedestrian');

  if (!from) {
    return {
      intent: 'navigate',
      understood: false,
      from: null,
      to: to?.id ?? null,
      mode,
      error: 'unknown_origin',
    };
  }

  if (!to) {
    return {
      intent: 'navigate',
      understood: false,
      from: from.id,
      to: null,
      mode,
      error: 'unknown_destination',
    };
  }

  return {
    intent: 'navigate',
    understood: true,
    from: from.id,
    to: to.id,
    mode,
    error: null,
  };
}
