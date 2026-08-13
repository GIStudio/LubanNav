import { describe, expect, it } from 'vitest';
import { matchLocation, parseNavigationQuery } from './destinationParser.js';

describe('destination parser', () => {
  it('parses a Chinese origin and destination', () => {
    expect(parseNavigationQuery('从宿舍 5 到饭堂')).toMatchObject({
      from: 'dorm-5',
      to: 'food-court',
      mode: 'pedestrian',
      understood: true,
    });
  });

  it('parses robot mode and aliases', () => {
    expect(parseNavigationQuery('机器人从大门到体育馆')).toMatchObject({
      from: 'main-entrance',
      to: 'sports-hall',
      mode: 'robot',
      understood: true,
    });
  });

  it('uses the current origin for destination-only prompts', () => {
    expect(parseNavigationQuery('带我去图书馆', 'activity-center')).toMatchObject({
      from: 'activity-center',
      to: 'library',
      understood: true,
    });
  });

  it('supports a small typo through fuzzy matching', () => {
    expect(matchLocation('图书管')?.id).toBe('library');
  });

  it('recognizes the renamed east and west lobbies plus legacy aliases', () => {
    expect(matchLocation('西翼大堂')?.id).toBe('west-concourse');
    expect(matchLocation('东翼入口')?.id).toBe('east-concourse');
    expect(matchLocation('西翼大学')?.id).toBe('west-concourse');
  });

  it('does not invent an unknown destination', () => {
    expect(parseNavigationQuery('带我去火星')).toMatchObject({ understood: false, to: null });
  });
});
