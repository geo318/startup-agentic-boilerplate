const { titleCase } = await import(`${process.cwd()}/src/title.mjs`);
const cases = [["hello wORLD", "Hello World"], ["a  b", "A  B"], ["", ""], ["x", "X"], ["ALREADY UPPER", "Already Upper"], [" lead", " Lead"], ["trail ", "Trail "], ["1st place", "1st Place"]];
const failed = cases.filter(([i, o]) => { try { return titleCase(i) !== o; } catch { return true; } }).map((c) => c[0]);
console.log(JSON.stringify({ checked: cases.length, failed }));
process.exit(failed.length ? 1 : 0);
