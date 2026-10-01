const FACTOR = { h: 3600, m: 60, s: 1 };

export function parseDuration(text) {
  if (typeof text !== "string" || !/^(\d+[hms])+$/.test(text)) throw new TypeError(`invalid duration: ${text}`);
  const seen = new Set();
  let total = 0;
  for (const [, n, unit] of text.matchAll(/(\d+)([hms])/g)) {
    if (seen.has(unit)) throw new TypeError(`repeated unit: ${unit}`);
    seen.add(unit);
    total += Number(n) * FACTOR[unit];
  }
  return total;
}
