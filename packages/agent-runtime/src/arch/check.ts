import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

// Architecture boundary check, backed by the TypeScript compiler (parser + module resolution incl. tsconfig `paths`),
// not text matching. Principles from the plan: an empty or misconfigured scan FAILS; a known-violation positive control
// runs before every real scan; constructs it cannot analyse are REPORTED, never silently treated as safe.
export type Layer = { name: string; include: string[]; mayImport: string[]; forbidPackages?: string[] };
export type ArchConfig = {
  schemaVersion: 1;
  tsconfig?: string;
  layers: Layer[];
  minFiles?: number;
  ignoreTypeOnly?: boolean;
  allowUnclassified?: boolean;
  cover?: string[]; // every source file matching these globs must belong to a layer, so a new file cannot silently go unchecked
  allowDynamic?: string[]; // file globs where non-literal dynamic imports are accepted (a deliberate, reviewed exception)
};
export type Finding = {
  kind: "violation" | "unanalyzed" | "unclassified" | "empty-scan" | "config";
  file: string;
  line: number;
  message: string;
};
export type Report = { scanned: number; findings: Finding[]; ok: boolean };

export class ArchUnavailable extends Error {}

type TS = typeof import("ts-compiler-api");
let tsCache: TS | undefined;
async function loadTs(): Promise<TS> {
  if (tsCache) return tsCache;
  try {
    const m = await import("ts-compiler-api");
    tsCache = (m as { default?: TS }).default ?? (m as unknown as TS);
    return tsCache;
  } catch {
    throw new ArchUnavailable(
      "the TypeScript compiler API is not installed for the runtime (npm i -D ts-compiler-api@npm:typescript@6): architecture analysis is unavailable, which is NOT a pass",
    );
  }
}

const BUILTINS = new Set(builtinModules);
const packageName = (spec: string): string => {
  if (spec.startsWith("node:")) return spec;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec);
  return BUILTINS.has(name) ? `node:${name}` : name;
};
const globToRegex = (g: string) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\//g, "(?:.*/)?")
      .replace(/\*\*/g, ".*")
      .replace(/\*/g, "[^/]*")}$`,
  );

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", ".turbo"]);
function sourceFiles(base: string, exts: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !e.name.endsWith(".d.ts")) {
        out.push(relative(base, join(dir, e.name)).split(sep).join("/"));
      }
    }
  };
  walk(base);
  return out;
}

export async function checkArchitecture(
  root: string,
  cfg: ArchConfig,
  opts: { skipSelfTest?: boolean } = {},
): Promise<Report> {
  const ts = await loadTs();
  if (!opts.skipSelfTest) await selfTest(ts);
  const findings: Finding[] = [];
  const base = realpathSync(root);
  const rel = (f: string) => relative(base, realpathSync(f)).split(sep).join("/");

  // ---- compiler options (paths/baseUrl/moduleResolution) ----
  let options: import("ts-compiler-api").CompilerOptions = {
    allowJs: true,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    module: ts.ModuleKind.ESNext,
    allowImportingTsExtensions: true,
  };
  const tsconfigPath = cfg.tsconfig ? resolve(base, cfg.tsconfig) : ts.findConfigFile(base, ts.sys.fileExists);
  if (tsconfigPath && existsSync(tsconfigPath)) {
    const read = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (read.error)
      findings.push({ kind: "config", file: rel(tsconfigPath), line: 0, message: "tsconfig is not readable" });
    else options = { ...options, ...ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(tsconfigPath)).options };
  } else if (cfg.tsconfig) {
    findings.push({ kind: "config", file: cfg.tsconfig, line: 0, message: "configured tsconfig does not exist" });
  }

  // ---- discovery: files per layer. A layer that matches nothing means a misconfigured glob, not a clean layer ----
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  const fileLayer = new Map<string, string>();
  const all = sourceFiles(base, exts);
  for (const layer of cfg.layers) {
    const res = layer.include.map(globToRegex);
    const matched = all.filter((f) => res.some((r) => r.test(f))).map((f) => join(base, f));
    if (matched.length === 0)
      findings.push({
        kind: "empty-scan",
        file: layer.name,
        line: 0,
        message: `layer "${layer.name}" matched no source files (misconfigured glob?): ${layer.include.join(", ")}`,
      });
    for (const f of matched) {
      const r = rel(f);
      const prev = fileLayer.get(r);
      if (prev && prev !== layer.name)
        findings.push({
          kind: "config",
          file: r,
          line: 0,
          message: `file is in two layers: ${prev} and ${layer.name}`,
        });
      else fileLayer.set(r, layer.name);
    }
  }
  for (const g of cfg.cover ?? []) {
    const re = globToRegex(g);
    for (const f of all)
      if (re.test(f) && !fileLayer.has(f))
        findings.push({
          kind: "unclassified",
          file: f,
          line: 0,
          message: `matches cover "${g}" but belongs to no layer (add it to one)`,
        });
  }
  const minFiles = cfg.minFiles ?? 1;
  if (fileLayer.size < minFiles)
    findings.push({
      kind: "empty-scan",
      file: "",
      line: 0,
      message: `only ${fileLayer.size} source file(s) scanned, expected at least ${minFiles}`,
    });
  const layers = new Map(cfg.layers.map((l) => [l.name, l]));
  for (const l of cfg.layers)
    for (const m of l.mayImport)
      if (!layers.has(m))
        findings.push({ kind: "config", file: l.name, line: 0, message: `mayImport names unknown layer "${m}"` });
  const dynamicOk = (cfg.allowDynamic ?? []).map(globToRegex);

  // ---- analysis ----
  for (const [file, layerName] of fileLayer) {
    const layer = layers.get(layerName);
    if (!layer) continue;
    const abs = join(base, file);
    const sf = ts.createSourceFile(abs, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true);
    const lineOf = (n: import("ts-compiler-api").Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

    const consider = (spec: string, node: import("ts-compiler-api").Node, typeOnly: boolean) => {
      if (typeOnly && cfg.ignoreTypeOnly) return;
      const line = lineOf(node);
      const resolved = ts.resolveModuleName(spec, abs, options, ts.sys);
      const hit = resolved.resolvedModule;
      if (hit && !hit.isExternalLibraryImport) {
        const target = rel(hit.resolvedFileName);
        if (target.startsWith("..") || target.includes("node_modules/")) return; // outside the project: not ours
        const to = fileLayer.get(target);
        if (!to) {
          if (!cfg.allowUnclassified)
            findings.push({
              kind: "unclassified",
              file,
              line,
              message: `imports ${target}, which belongs to no layer (classify it or set allowUnclassified)`,
            });
          return;
        }
        if (to !== layerName && !layer.mayImport.includes(to))
          findings.push({
            kind: "violation",
            file,
            line,
            message: `layer "${layerName}" must not import layer "${to}" (${spec} → ${target})`,
          });
        return;
      }
      if (!hit && spec.startsWith(".")) {
        findings.push({
          kind: "unanalyzed",
          file,
          line,
          message: `relative import "${spec}" did not resolve: cannot verify the boundary`,
        });
        return;
      }
      const pkg = packageName(spec);
      if (layer.forbidPackages?.some((p) => pkg === p || pkg === `node:${p}`))
        findings.push({
          kind: "violation",
          file,
          line,
          message: `layer "${layerName}" must not depend on package "${pkg}"`,
        });
    };
    const dynamic = (node: import("ts-compiler-api").Node, what: string) => {
      if (dynamicOk.some((r) => r.test(file))) return;
      findings.push({
        kind: "unanalyzed",
        file,
        line: lineOf(node),
        message: `${what} is not a string literal: cannot be analysed, so it is not assumed safe`,
      });
    };

    const visit = (n: import("ts-compiler-api").Node): void => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier))
        consider(n.moduleSpecifier.text, n, !!n.importClause?.isTypeOnly);
      else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier))
        consider(n.moduleSpecifier.text, n, !!n.isTypeOnly);
      else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference)) {
        const e = n.moduleReference.expression;
        if (ts.isStringLiteral(e)) consider(e.text, n, false);
        else dynamic(n, "import = require(...)");
      } else if (ts.isCallExpression(n)) {
        const callee = n.expression;
        const arg = n.arguments[0];
        if (callee.kind === ts.SyntaxKind.ImportKeyword) {
          if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) consider(arg.text, n, false);
          else dynamic(n, "import(...)");
        } else if (ts.isIdentifier(callee) && callee.text === "require") {
          if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) consider(arg.text, n, false);
          else dynamic(n, "require(...)");
        } else if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "glob" &&
          ts.isMetaProperty(callee.expression)
        ) {
          dynamic(n, "import.meta.glob(...)");
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return { scanned: fileLayer.size, findings, ok: findings.length === 0 };
}

// Positive control: a project with known violations must produce exactly those findings. If it does not, the
// checker itself is broken and nothing it reports (or fails to report) can be trusted.
let selfTested = false;
export async function selfTest(ts: TS): Promise<void> {
  if (selfTested) return;
  const dir = mkdtempSync(join(tmpdir(), "arch-self-"));
  const w = (p: string, c: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  };
  w("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@hi/*": ["hi/*"] } } }));
  w(
    "lo/a.ts",
    'import { b } from "../hi/b";\nimport "forbidden-pkg";\nconst n = "x";\nimport(n);\nexport const a = b;\n',
  );
  w("hi/b.ts", "export const b = 1;\n");
  w("lo/c.ts", 'import { b } from "@hi/b";\nexport const c = b;\n');
  const cfg: ArchConfig = {
    schemaVersion: 1,
    layers: [
      { name: "lo", include: ["lo/**"], mayImport: [], forbidPackages: ["forbidden-pkg"] },
      { name: "hi", include: ["hi/**"], mayImport: ["lo"] },
    ],
  };
  selfTested = true; // set first: the check below calls back into checkArchitecture with the guard on
  const r = await checkArchitecture(dir, cfg, { skipSelfTest: true });
  const kinds = r.findings.map((f) => `${f.kind}:${f.file}`).sort();
  const expected = ["unanalyzed:lo/a.ts", "violation:lo/a.ts", "violation:lo/a.ts", "violation:lo/c.ts"].sort();
  if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
    selfTested = false;
    throw new Error(`architecture checker self-test failed (positive control): got ${JSON.stringify(kinds)}`);
  }
  void ts;
}

export function formatReport(r: Report): string {
  if (r.ok) return `architecture: OK (${r.scanned} files scanned)`;
  const lines = r.findings.map((f) => `${f.file}${f.line ? `:${f.line}` : ""}  [${f.kind}] ${f.message}`);
  return `${lines.join("\n")}\narchitecture: ${r.findings.length} finding(s) in ${r.scanned} files scanned`;
}
