export const DATASET = {
  id: 'hkustgz-layered-routing-v3',
  name: 'HKUST(GZ) layered outdoor-indoor routing graph',
  version: '2026-08-13',
  coordinateSystem: 'WGS84 with legacy local coordinates',
  sourceUrl: 'https://www.openstreetmap.org/way/894157108',
  sourceDate: '2026-08-13',
  mapAttribution: '© OpenStreetMap contributors',
  mapLicense: 'ODbL-1.0',
  disclaimer:
    '室外建筑、入口与道路来自 OpenStreetMap；室内段来自明确标注来源与核验状态的本地补丁。OSM 入口缺失时使用推断建筑边界点，数据未经现场测绘，不可直接控制真实机器人。',
};

export const CAMPUS_BOUNDS = [
  [22.8855, 113.474],
  [22.895, 113.484],
];

const GEO_COORDINATES = {
  'main-entrance': [113.4783197, 22.8878039],
  administration: [113.476636, 22.8900975],
  'activity-center': [113.4776701, 22.8898246],
  'west-concourse': [113.47664, 22.89094],
  'east-concourse': [113.4782, 22.89015],
  library: [113.4780569, 22.8923387],
  'food-court': [113.4780496, 22.8917561],
  'lecture-halls': [113.4775173, 22.8914252],
  w1: [113.4762296, 22.8912547],
  w2: [113.4763811, 22.891729],
  w3: [113.4767096, 22.8922243],
  w4: [113.4770166, 22.8925521],
  e1: [113.4781055, 22.8902847],
  e2: [113.4784656, 22.8906208],
  e3: [113.4787573, 22.8911057],
  e4: [113.4789368, 22.8915546],
  'south-residences': [113.48015, 22.88834],
  'dorm-1': [113.4790276, 22.8890118],
  'dorm-2': [113.4785597, 22.8882702],
  'dorm-3': [113.4802928, 22.8883275],
  'dorm-4': [113.4799256, 22.8874005],
  'dorm-5': [113.4813012, 22.8878173],
  'dorm-6': [113.4812714, 22.8868343],
  'sports-hall': [113.4813014, 22.8887634],
  stadium: [113.4819696, 22.890055],
};

function geographicPosition(id) {
  const [longitude, latitude] = GEO_COORDINATES[id];
  return { longitude, latitude };
}

const publicNode = (id, name, en, x, y, category, aliases = []) => ({
  id,
  name,
  en,
  x,
  y,
  category,
  aliases,
  public: true,
  ...geographicPosition(id),
});

export const NODES = [
  publicNode('main-entrance', '主入口', 'Main Entrance', 345, 700, 'entrance', [
    '大门',
    '校门',
    '正门',
    'main gate',
  ]),
  publicNode('administration', '行政大楼', 'Administration', 325, 565, 'service', [
    '行政楼',
    'admin',
  ]),
  publicNode('activity-center', '活动中心', 'Activity Center', 495, 565, 'service', [
    '学生活动中心',
    'activity',
  ]),
  publicNode('west-concourse', '西翼大学', 'West Concourse', 275, 410, 'academic', [
    '西翼',
    'west wing',
  ]),
  publicNode('east-concourse', '东翼大学', 'East Concourse', 455, 410, 'academic', [
    '东翼',
    'east wing',
  ]),
  publicNode('library', '图书馆', 'Library', 365, 135, 'service', ['图书', 'library']),
  publicNode('food-court', '饭堂', 'Food Court', 365, 220, 'service', [
    '食堂',
    '餐厅',
    'food court',
    'canteen',
  ]),
  publicNode('lecture-halls', '演讲厅 A/B/C', 'Lecture Halls A/B/C', 365, 305, 'academic', [
    '演讲厅',
    '礼堂',
    'lecture hall',
  ]),
  publicNode('w1', 'W-1', 'W-1', 185, 435, 'academic', ['w1', '西一']),
  publicNode('w2', 'W-2', 'W-2', 160, 350, 'academic', ['w2', '西二']),
  publicNode('w3', 'W-3', 'W-3', 160, 270, 'academic', ['w3', '西三']),
  publicNode('w4', 'W-4', 'W-4', 195, 175, 'academic', ['w4', '西四']),
  publicNode('e1', 'E-1', 'E-1', 545, 435, 'academic', ['e1', '东一']),
  publicNode('e2', 'E-2', 'E-2', 575, 350, 'academic', ['e2', '东二']),
  publicNode('e3', 'E-3', 'E-3', 575, 270, 'academic', ['e3', '东三']),
  publicNode('e4', 'E-4', 'E-4', 540, 175, 'academic', ['e4', '东四']),
  publicNode('south-residences', '南区住宅', 'South Residences', 805, 500, 'residence', [
    '南区宿舍',
    '宿舍区',
    'south residence',
  ]),
  publicNode('dorm-1', '宿舍 1', 'Dormitory 1', 690, 545, 'residence', [
    '宿舍1a',
    '宿舍1b',
    '1a',
    '1b',
    'dorm 1',
  ]),
  publicNode('dorm-2', '宿舍 2', 'Dormitory 2', 720, 670, 'residence', [
    '宿舍2a',
    '宿舍2b',
    '2a',
    '2b',
    'dorm 2',
  ]),
  publicNode('dorm-3', '宿舍 3', 'Dormitory 3', 820, 555, 'residence', ['dorm 3']),
  publicNode('dorm-4', '宿舍 4', 'Dormitory 4', 865, 670, 'residence', [
    '宿舍4a',
    '宿舍4b',
    '4a',
    '4b',
    'dorm 4',
  ]),
  publicNode('dorm-5', '宿舍 5', 'Dormitory 5', 955, 545, 'residence', [
    '宿舍5a',
    '宿舍5b',
    '宿舍5c',
    '5a',
    '5b',
    '5c',
    'dorm 5',
  ]),
  publicNode('dorm-6', '宿舍 6', 'Dormitory 6', 1010, 670, 'residence', [
    '宿舍6a',
    '宿舍6b',
    '宿舍6c',
    '6a',
    '6b',
    '6c',
    'dorm 6',
  ]),
  publicNode('sports-hall', '体育馆', 'Sports Hall', 860, 370, 'sports', [
    '运动馆',
    'sports hall',
    'gym',
  ]),
  publicNode('stadium', '体育场', 'Stadium', 900, 155, 'sports', [
    '操场',
    '田径场',
    'stadium',
  ]),
];

export const PUBLIC_LOCATIONS = NODES.filter((node) => node.public);
export const NODE_BY_ID = Object.fromEntries(NODES.map((node) => [node.id, node]));

export const LOCATION_OSM_FEATURES = {
  administration: ['way/1154868988'],
  'activity-center': ['way/1098450388'],
  library: ['way/1098450394'],
  'lecture-halls': ['relation/14632285'],
  w1: ['way/1096048403'],
  w2: ['way/1096048404'],
  w3: ['way/1098450398'],
  w4: ['way/1098450397'],
  e1: ['way/1098450389'],
  e2: ['way/1096049211'],
  e3: ['way/1096049213'],
  e4: ['way/1096049212'],
  'south-residences': [
    'way/1098450403',
    'way/1526136018',
    'way/1098450437',
    'way/1098450438',
    'way/1526136017',
    'way/1098450439',
    'way/1098450440',
    'way/1098450434',
    'way/1098450435',
    'way/1098450436',
    'way/1098450441',
    'way/1098450442',
    'way/1098450443',
  ],
  'dorm-1': ['way/1098450403', 'way/1526136018'],
  'dorm-2': ['way/1098450437', 'way/1098450438'],
  'dorm-3': ['way/1526136017'],
  'dorm-4': ['way/1098450439', 'way/1098450440'],
  'dorm-5': ['way/1098450434', 'way/1098450435', 'way/1098450436'],
  'dorm-6': ['way/1098450441', 'way/1098450442', 'way/1098450443'],
  'sports-hall': ['way/1098450410'],
};

export const MODES = {
  pedestrian: {
    id: 'pedestrian',
    label: '步行',
    speedMetersPerSecond: 1.25,
    accessibleOnly: false,
  },
  robot: {
    id: 'robot',
    label: '机器人',
    speedMetersPerSecond: 0.8,
    accessibleOnly: true,
  },
};
