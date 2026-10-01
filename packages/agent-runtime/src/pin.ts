import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

function listFiles(dir: string, prefix: string, pattern: RegExp): Array<[string, string]> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e): Array<[string, string]> => {
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) return listFiles(join(dir, e.name), rel, pattern);
    return e.isFile() && pattern.test(e.name) ? [[rel, join(dir, e.name)]] : [];
  });
}

// Hash of everything that decides runtime behaviour: src/**.ts, package.json and the shared schemas.
// Must stay identical to the copy in project-setup/templates/scripts/agentic.mjs (a test compares them).
export function treeHash(runtimeRoot: string): string {
  const files = [
    ...listFiles(join(runtimeRoot, "src"), "src", /\.ts$/),
    ...listFiles(join(runtimeRoot, "..", "..", "schemas"), "schemas", /\.json$/),
    ...(existsSync(join(runtimeRoot, "package.json")) ? ([["package.json", join(runtimeRoot, "package.json")]] as Array<[string, string]>) : []),
  ].sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash("sha256")
    .update(files.map(([rel, abs]) => `${rel}\0${createHash("sha256").update(readFileSync(abs)).digest("hex")}`).join("\n"))
    .digest("hex");
}

// Writes .agents/runtime.json in a project. Re-pinning is an explicit act by whoever runs this.
export function pinProject(project: string, runtimeRoot: string): { runtimePath: string; treeHash: string } {
  // real paths on both sides: /var vs /private/var (macOS) must not change the relative path
  const pin = { runtimePath: relative(realpathSync(project), realpathSync(runtimeRoot)) || ".", treeHash: treeHash(runtimeRoot) };
  const file = join(project, ".agents", "runtime.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}
