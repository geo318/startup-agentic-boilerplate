const { daysBetween } = await import(`${process.cwd()}/src/calendar.mjs`);
const cases = [["2026-03-01", "2026-03-01", 0], ["2026-03-28", "2026-03-30", 2], ["2026-10-24", "2026-10-26", 2], ["2026-03-07", "2026-03-09", 2], ["2028-02-28", "2028-03-01", 2], ["2027-02-28", "2027-03-01", 1], ["1999-12-31", "2000-03-01", 61], ["2026-03-11", "2026-03-01", -10], ["2024-01-01", "2025-01-01", 366], ["2100-02-28", "2100-03-01", 1]];
const failed = cases.filter(([a, b, o]) => { try { return daysBetween(a, b) !== o; } catch { return true; } }).map((c) => c.slice(0, 2).join("→"));
console.log(JSON.stringify({ checked: cases.length, failed }));
process.exit(failed.length ? 1 : 0);
