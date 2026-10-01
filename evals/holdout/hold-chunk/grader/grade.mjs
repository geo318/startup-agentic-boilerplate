const m = await import(`${process.cwd()}/src/lists.mjs`);
const checks = [
  () => m.last([1, 2, 3]) === 3, () => JSON.stringify(m.chunk([1, 2, 3, 4, 5], 2)) === "[[1,2],[3,4],[5]]", () => JSON.stringify(m.chunk([], 3)) === "[]",
  () => JSON.stringify(m.chunk([1, 2, 3], 5)) === "[[1,2,3]]", () => JSON.stringify(m.chunk([1, 2, 3], 1)) === "[[1],[2],[3]]",
  ...[0, -1, 1.5, NaN].map((s) => () => { try { m.chunk([1], s); return false; } catch (e) { return e instanceof RangeError; } }),
];
const failed = checks.map((c, i) => { try { return c() ? null : i; } catch { return i; } }).filter((x) => x !== null);
console.log(JSON.stringify({ checked: checks.length, failed }));
process.exit(failed.length ? 1 : 0);
