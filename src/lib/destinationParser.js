import { PUBLIC_LOCATIONS } from '../data/campus.js';

function normalize(value) {
  return value
    .toLowerCase()
    .replace(/[\s，。！？,.!?()（）\-_/]/g, '')
    .replace(/号楼|大楼|大厦/g, '');
}

function searchableNames(location) {
  return [location.id, location.name, location.en, ...location.aliases]
    .map((value) => ({ raw: value, normalized: normalize(value) }))
    .filter((item) => item.normalized);
}

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cached = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = cached;
    }
  }
  return row[b.length];
}

export function matchLocation(fragment) {
  const needle = normalize(fragment);
  if (!needle) return null;

  const candidates = PUBLIC_LOCATIONS.flatMap((location) =>
    searchableNames(location).map((name) => ({ location, name })),
  );
  const exact = candidates.find(({ name }) => name.normalized === needle);
  if (exact) return exact.location;

  const contained = candidates
    .filter(({ name }) => needle.includes(name.normalized) || name.normalized.includes(needle))
    .sort((a, b) => b.name.normalized.length - a.name.normalized.length)[0];
  if (contained) return contained.location;

  const fuzzy = PUBLIC_LOCATIONS.flatMap((location) =>
    searchableNames(location).map((name) => ({
      location,
      score: levenshtein(needle, name.normalized) / Math.max(needle.length, name.normalized.length),
    })),
  ).sort((a, b) => a.score - b.score)[0];

  return fuzzy?.score <= 0.34 ? fuzzy.location : null;
}

export function parseNavigationQuery(query, currentOrigin = 'main-entrance') {
  const text = query.trim();
  const lowered = text.toLowerCase();
  const robot = /机器人|robot|轮椅|无障碍/.test(lowered);
  const mode = robot ? 'robot' : 'pedestrian';

  const fromToPatterns = [
    /(?:从|由)\s*(.+?)\s*(?:到|去|前往)\s*(.+?)(?:怎么走|如何走|导航|路线|$)/i,
    /(?:from)\s+(.+?)\s+(?:to)\s+(.+?)(?:\?|$)/i,
  ];

  for (const pattern of fromToPatterns) {
    const match = text.match(pattern);
    if (match) {
      const from = matchLocation(match[1]);
      const to = matchLocation(match[2]);
      return {
        intent: 'navigate',
        from: from?.id ?? null,
        to: to?.id ?? null,
        mode,
        understood: Boolean(from && to),
      };
    }
  }

  const destinationText = text
    .replace(/^(你好|您好|hello|hi)[，,\s]*/i, '')
    .replace(/^(请|麻烦)?\s*(带我|导航|怎么|如何)?\s*(去|到|前往|找)\s*/i, '')
    .replace(/(怎么走|如何走|在哪里|在哪|导航|路线|谢谢).*$/i, '');
  const destination = matchLocation(destinationText) ?? matchLocation(text);

  if (destination) {
    return {
      intent: 'navigate',
      from: currentOrigin,
      to: destination.id,
      mode,
      understood: true,
    };
  }

  return {
    intent: /你好|您好|hello|hi/i.test(text) ? 'greeting' : 'unknown',
    from: currentOrigin,
    to: null,
    mode,
    understood: false,
  };
}
