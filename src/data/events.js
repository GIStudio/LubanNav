export const EVENT_SCHEMA_VERSION = '1.0';
export const DEFAULT_EVENT_ID = 'august-device-demo-2026';

export const DEFAULT_EVENTS = [
  {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: DEFAULT_EVENT_ID,
    name: '八月真机展示活动',
    dateLabel: '2026 年 8 月',
    description: '用于八月真机展示当天的活动导航配置。',
    mainVenue: {
      id: 'main-venue',
      name: '三楼主会场',
      locationId: null,
      floor: '3F',
      room: '',
      note: '具体房间与地图入口待活动组织者配置。',
    },
    checkIn: null,
    breakoutVenues: [],
    accommodations: [],
    diningRecommendations: [],
  },
];
