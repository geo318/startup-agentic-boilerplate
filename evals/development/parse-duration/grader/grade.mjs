const { parseDuration } = await import(`${process.cwd()}/src/duration.mjs`);
const ok = [["1h30m", 5400], ["45s", 45], ["2m10s", 130], ["10s2m", 130], ["1h", 3600], ["0s", 0], ["1h1m1s", 3661], ["90m", 5400]];
const bad = ["", "5d", "1h1h", "h", "1.5h", "1h 30m", "abc", "-5s", "1h30", "30m1h1m"];
const failed = [];
for (const [i, o] of ok) { try { if (parseDuration(i) !== o) failed.push(i); } catch { failed.push(i); } }
for (const i of bad) { try { parseDuration(i); failed.push(i); } catch (e) { if (!(e instanceof TypeError)) failed.push(i); } }
console.log(JSON.stringify({ checked: ok.length + bad.length, failed }));
process.exit(failed.length ? 1 : 0);
