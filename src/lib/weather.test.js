import { describe, expect, it, vi } from 'vitest';
import {
  CAMPUS_WEATHER_COORDINATES,
  CAMPUS_WEATHER_REGION,
  buildWeatherAdvisory,
  buildWeatherUrl,
  fetchWeather,
  normalizeWeatherPayload,
  weatherCache,
  weatherConditionLabel,
} from './weather.js';

describe('weather condition labels', () => {
  it('labels common WMO weather codes in Chinese', () => {
    expect(weatherConditionLabel(0, true)).toBe('晴');
    expect(weatherConditionLabel(3, true)).toBe('阴');
    expect(weatherConditionLabel(61, true)).toBe('小雨');
    expect(weatherConditionLabel(95, true)).toBe('雷暴');
    expect(weatherConditionLabel(0, false)).toBe('晴朗夜空');
  });
});

describe('normalizeWeatherPayload', () => {
  it('flags umbrella and sunscreen from rain probability and UV index', () => {
    const weather = normalizeWeatherPayload({
      current: {
        temperature_2m: 31,
        weather_code: 1,
        is_day: 1,
        precipitation: 0,
        relative_humidity_2m: 70,
        apparent_temperature: 35,
      },
      daily: { precipitation_probability_max: [70], uv_index_max: [8] },
    });
    expect(weather.available).toBe(true);
    expect(weather.umbrella).toBe(true);
    expect(weather.sunscreen).toBe(true);
    expect(weather.conditionLabel).toBe('大部晴朗');
    expect(weather.precipitationProbabilityMax).toBe(70);
    expect(weather.uvIndexMax).toBe(8);
  });

  it('flags active rain from the current weather code even without probability', () => {
    const weather = normalizeWeatherPayload({
      current: { temperature_2m: 26, weather_code: 63, is_day: 1, precipitation: 1.2 },
      daily: {},
    });
    expect(weather.umbrella).toBe(true);
    expect(weather.rainingNow).toBe(true);
  });
});

describe('buildWeatherAdvisory', () => {
  it('produces umbrella advice for rain on the open-air platform', () => {
    const advisory = buildWeatherAdvisory({
      available: true,
      temperatureC: 28,
      conditionLabel: '小雨',
      precipitationMm: 0.5,
      rainExpected: true,
      rainingNow: true,
      sunny: false,
      uvIndexMax: null,
      umbrella: true,
      sunscreen: false,
      cold: false,
      thunderstorm: false,
    });
    expect(advisory).toContain('建议带伞');
    expect(advisory).toContain('3 楼平台为露天场地');
  });

  it('warns against staying on the open platform during thunderstorms', () => {
    const advisory = buildWeatherAdvisory({
      available: true,
      temperatureC: 27,
      conditionLabel: '雷暴',
      precipitationMm: 3,
      rainExpected: true,
      rainingNow: true,
      sunny: false,
      uvIndexMax: null,
      umbrella: true,
      sunscreen: false,
      cold: false,
      thunderstorm: true,
    });
    expect(advisory).toContain('雷暴风险');
  });

  it('degrades gracefully when weather is unavailable', () => {
    const advisory = buildWeatherAdvisory({ available: false });
    expect(advisory).toContain('无法获取实时天气');
  });
});

describe('fetchWeather', () => {
  it('fetches from Open-Meteo, normalizes, and serves the TTL cache', async () => {
    weatherCache.entries.clear();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        current: { temperature_2m: 30, weather_code: 2, is_day: 1, precipitation: 0 },
        daily: { precipitation_probability_max: [20], uv_index_max: [5] },
      }),
    }));
    const weather = await fetchWeather({ fetchImpl, cache: weatherCache });
    expect(weather.available).toBe(true);
    expect(weather.temperatureC).toBe(30);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await fetchWeather({ fetchImpl, cache: weatherCache });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(weather);
  });

  it('returns an unavailable object instead of throwing on network failure', async () => {
    weatherCache.entries.clear();
    const weather = await fetchWeather({
      fetchImpl: async () => {
        throw new Error('offline');
      },
      cache: weatherCache,
    });
    expect(weather.available).toBe(false);
    expect(weather.error).toBe('weather-network');
  });

  it('builds a keyless Open-Meteo forecast URL for the campus center in Nansha', () => {
    const url = buildWeatherUrl(CAMPUS_WEATHER_COORDINATES);
    expect(url).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(url).toContain('latitude=22.89025');
    expect(url).toContain('longitude=113.479');
    expect(url).toContain('timezone=Asia%2FShanghai');
    expect(url).not.toContain('apikey');
  });

  it('pins the weather region to Guangzhou Nansha District', () => {
    expect(CAMPUS_WEATHER_REGION).toBe('广州南沙区');
  });
});
