const { slugify } = await import(`${process.cwd()}/src/slugify.mjs`);
const cases = [["Hello World", "hello-world"], ["a  --  b", "a-b"], ["--x--", "x"], ["Rock & Roll 101", "rock-roll-101"], ["", ""], ["!!!", ""], ["A_B.C", "a-b-c"], ["MiXeD CaSe", "mixed-case"]];
const bad = cases.filter(([i, o]) => slugify(i) !== o);
console.log(JSON.stringify({ checked: cases.length, failed: bad }));
process.exit(bad.length ? 1 : 0);
