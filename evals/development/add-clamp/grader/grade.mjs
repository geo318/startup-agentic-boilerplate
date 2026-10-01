const m = await import(`${process.cwd()}/src/math.mjs`);
const checks = [
  () => m.sum([1, 2, 3]) === 6, () => m.sum([]) === 0,
  () => m.clamp(5, 0, 3) === 3, () => m.clamp(-1, 0, 3) === 0, () => m.clamp(3, 0, 3) === 3, () => m.clamp(0, 0, 0) === 0, () => m.clamp(-5, -10, -2) === -5,
  () => { try { m.clamp(1, 3, 0); return false; } catch (e) { return e instanceof RangeError; } },
];
const failed = checks.map((c, i) => { try { return c() ? null : i; } catch { return i; } }).filter((x) => x !== null);
console.log(JSON.stringify({ checked: checks.length, failed }));
process.exit(failed.length ? 1 : 0);
