/**
 * Realtime weather for the campus via the open, keyless Open-Meteo API.
 *
 * Why Open-Meteo: it is free and open access, requires no API key, and sends
 * permissive CORS headers, so the static GitHub Pages build can call it
 * directly from the browser. Weather is inherently dynamic, so it is fetched
 * at request time (with a short TTL cache) instead of being baked into the
 * precomputed static API.
 *
 * The 3F platform ("三楼中央") is an open-air deck, so the advisory pays
 * special attention to rain (umbrella + slip risk) and strong sun / UV.
 */

export const CAMPUS_WEATHER_COORDINATES = {
  // Center of CAMPUS_BOUNDS [[22.8855, 113.474], [22.895, 113.484]].
  latitude: 22.89025,
  longitude: 113.479,
};

export const WEATHER_CACHE_TTL_MS = 10 * 60 * 1000;

export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';

export const RAIN_WEATHER_CODES = new Set([
  51, 53, 55, 56, 57, // drizzle
  61, 63, 65, 66, 67, // rain
  80, 81, 82, // showers
  95, 96, 99, // thunderstorm
]);

const CONDITION_LABELS = {
  0: '晴',
  1: '大部晴朗',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷暴',
  96: '雷暴伴冰雹',
  99: '强雷暴伴冰雹',
};

export function weatherConditionLabel(code, isDay) {
  if (code === 0 || code === 1) {
    return isDay === false ? '晴朗夜空' : CONDITION_LABELS[code] ?? '晴';
  }
  return CONDITION_LABELS[code] ?? '天气未知';
}

export function buildWeatherUrl(coordinates = CAMPUS_WEATHER_COORDINATES) {
  const params = new URLSearchParams({
    latitude: String(coordinates.latitude),
    longitude: String(coordinates.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code',
    daily: 'precipitation_probability_max,uv_index_max',
    timezone: 'auto',
    forecast_days: '1',
    wind_speed_unit: 'kmh',
  });
  return `${OPEN_METEO_ENDPOINT}?${params.toString()}`;
}

function classifyWeather({ temperatureC, conditionCode, isDay, precipitationMm, precipitationProbabilityMax, uvIndexMax }) {
  const rainingNow =
    RAIN_WEATHER_CODES.has(conditionCode) || (precipitationMm ?? 0) > 0;
  const rainExpected = (precipitationProbabilityMax ?? 0) >= 50;
  const umbrella = rainingNow || rainExpected;
  const sunny =
    [0, 1, 2].includes(conditionCode) && isDay !== false;
  const sunscreen =
    (uvIndexMax ?? 0) >= 6 || (sunny && (temperatureC ?? 0) >= 30);
  const cold = (temperatureC ?? 99) <= 8;
  const thunderstorm = [95, 96, 99].includes(conditionCode);
  return { rainingNow, rainExpected, umbrella, sunny, sunscreen, cold, thunderstorm };
}

/**
 * Normalize an Open-Meteo forecast response into a compact advisory.
 * `payload` is the parsed JSON body; kept as a separate pure function so the
 * browser fetch path and tests share the same logic.
 */
export function normalizeWeatherPayload(payload) {
  const current = payload?.current ?? {};
  const daily = payload?.daily ?? {};
  const temperatureC = current.temperature_2m;
  const conditionCode = current.weather_code;
  const isDay = current.is_day === 1;
  const precipitationMm = current.precipitation;
  const precipitationProbabilityMax = daily.precipitation_probability_max?.[0] ?? null;
  const uvIndexMax = daily.uv_index_max?.[0] ?? null;
  const classification = classifyWeather({
    temperatureC,
    conditionCode,
    isDay,
    precipitationMm,
    precipitationProbabilityMax,
    uvIndexMax,
  });
  return {
    available: true,
    source: 'open-meteo',
    fetchedAt: new Date().toISOString(),
    temperatureC,
    apparentTemperatureC: current.apparent_temperature ?? null,
    humidityPercent: current.relative_humidity_2m ?? null,
    conditionCode,
    conditionLabel: weatherConditionLabel(conditionCode, isDay),
    isDay,
    precipitationMm,
    precipitationProbabilityMax,
    uvIndexMax,
    ...classification,
  };
}

export function buildWeatherAdvisory(weather) {
  if (!weather?.available) {
    return '当前无法获取实时天气，请以可靠的天气应用为准；3 楼平台为露天场地，降雨时带伞防滑，晴热时防晒补水。';
  }
  const parts = [`当前 ${weather.temperatureC}°C，${weather.conditionLabel}`];
  if (weather.precipitationMm > 0) {
    parts.push(`正在降水（${weather.precipitationMm.toFixed(1)} mm）`);
  }
  if (weather.rainExpected) {
    parts.push(`今日降水概率 ${weather.precipitationProbabilityMax}%`);
  }
  if (weather.sunny && weather.uvIndexMax != null) {
    parts.push(`紫外线指数 ${weather.uvIndexMax}`);
  }
  if (weather.cold) parts.push('天气较冷，注意添衣');
  const reminders = [];
  if (weather.umbrella) reminders.push('建议带伞');
  if (weather.sunscreen) reminders.push('注意防晒补水');
  if (weather.thunderstorm) reminders.push('有雷暴风险，请避免在空旷平台停留');
  if (weather.rainingNow || weather.rainExpected) reminders.push('平台湿滑，注意脚下');
  const sentence = parts.join('，');
  return reminders.length
    ? `${sentence}。3 楼平台为露天场地：${reminders.join('；')}。`
    : `${sentence}。`;
}

/**
 * Fetch current + today weather from Open-Meteo with a short timeout and a
 * TTL cache. Resolves to the normalized weather object, or to
 * `{ available: false, source: 'unavailable', error }` on any failure so
 * callers can degrade gracefully (the assistant must never invent weather).
 */
export async function fetchWeather({
  coordinates = CAMPUS_WEATHER_COORDINATES,
  fetchImpl = fetch,
  timeoutMs = 4000,
  cache = weatherCache,
} = {}) {
  const cached = cache.get(coordinates);
  if (cached) return cached;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(buildWeatherUrl(coordinates), {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);
    const payload = await response.json();
    const weather = normalizeWeatherPayload(payload);
    cache.set(coordinates, weather);
    return weather;
  } catch (error) {
    const unavailable = {
      available: false,
      source: 'unavailable',
      error: error?.name === 'AbortError' ? 'weather-timeout' : 'weather-network',
    };
    cache.set(coordinates, unavailable);
    return unavailable;
  }
}

class WeatherCache {
  constructor({ ttlMs = WEATHER_CACHE_TTL_MS } = {}) {
    this.ttlMs = ttlMs;
    this.entries = new Map();
  }

  get(key) {
    const entry = this.entries.get(JSON.stringify(key));
    if (!entry) return null;
    if (Date.now() - entry.at > this.ttlMs) {
      this.entries.delete(JSON.stringify(key));
      return null;
    }
    return entry.value;
  }

  set(key, value) {
    this.entries.set(JSON.stringify(key), { at: Date.now(), value });
  }
}

export const weatherCache = new WeatherCache();
