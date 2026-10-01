const { toRoman } = await import(`${process.cwd()}/src/roman.mjs`);
const ok = [[1, "I"], [4, "IV"], [9, "IX"], [14, "XIV"], [40, "XL"], [90, "XC"], [400, "CD"], [1994, "MCMXCIV"], [2024, "MMXXIV"], [3999, "MMMCMXCIX"], [3888, "MMMDCCCLXXXVIII"]];
const failed = [];
for (const [n, r] of ok) { try { if (toRoman(n) !== r) failed.push(n); } catch { failed.push(n); } }
for (const n of [0, -5, 4000, 1.5, NaN]) { try { toRoman(n); failed.push(String(n)); } catch (e) { if (!(e instanceof RangeError)) failed.push(String(n)); } }
console.log(JSON.stringify({ checked: ok.length + 5, failed }));
process.exit(failed.length ? 1 : 0);
