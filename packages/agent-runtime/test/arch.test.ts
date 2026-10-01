import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { type ArchConfig, checkArchitecture } from "../src/arch/check.ts";

const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "arch-"));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  return dir;
};
const TSCONFIG = JSON.stringify({
  compilerOptions: { baseUrl: ".", paths: { "@domain/*": ["domain/*"], "@infra/*": ["infra/*"] } },
});
const cfg = (over: Partial<ArchConfig> = {}): ArchConfig => ({
  schemaVersion: 1,
  layers: [
    { name: "domain", include: ["domain/**"], mayImport: [], forbidPackages: ["react", "pg"] },
    { name: "infra", include: ["infra/**"], mayImport: ["domain"] },
  ],
  ...over,
});
const kinds = (r: { findings: Array<{ kind: string }> }) => r.findings.map((f) => f.kind);
const msgs = (r: { findings: Array<{ message: string }> }) => r.findings.map((f) => f.message).join(" | ");

test("a clean project passes and counts what it scanned", async () => {
  const dir = mkdir({
    "domain/a.ts": "export const a = 1;",
    "infra/b.ts": 'import { a } from "../domain/a";\nexport const b = a;',
  });
  const r = await checkArchitecture(dir, cfg());
  assert.equal(r.ok, true);
  assert.equal(r.scanned, 2);
});
function mkdir(f: Record<string, string>) {
  return mk({ "tsconfig.json": TSCONFIG, ...f });
}

test("positive control: a known layering violation is caught (relative import)", async () => {
  const r = await checkArchitecture(
    mkdir({
      "domain/a.ts": 'import { b } from "../infra/b";\nexport const a = b;',
      "infra/b.ts": "export const b = 1;",
    }),
    cfg(),
  );
  assert.deepEqual(kinds(r), ["violation"]);
  assert.match(msgs(r), /"domain" must not import layer "infra"/);
  assert.equal(r.findings[0]!.line, 1);
});

test("tsconfig path aliases are resolved: a violation through @infra/* is still caught", async () => {
  const r = await checkArchitecture(
    mkdir({ "domain/a.ts": 'import { b } from "@infra/b";\nexport const a = b;', "infra/b.ts": "export const b = 1;" }),
    cfg(),
  );
  assert.deepEqual(kinds(r), ["violation"]);
  assert.match(msgs(r), /infra\/b\.ts/);
});

test("every static and literal-dynamic import form is analysed: import, export-from, export *, import=require, require, import()", async () => {
  const forms = [
    'import { b } from "../infra/b";',
    'export { b } from "../infra/b";',
    'export * from "../infra/b";',
    'import b = require("../infra/b");',
    'const x = require("../infra/b");',
    'const y = import("../infra/b");',
    "const z = import(`../infra/b`);",
  ];
  const r = await checkArchitecture(
    mkdir({ "domain/a.ts": `${forms.join("\n")}\nexport {};`, "infra/b.ts": "export const b = 1;" }),
    cfg(),
  );
  assert.equal(r.findings.filter((f) => f.kind === "violation").length, forms.length, msgs(r));
});

test("type-only imports still count as a dependency unless the config says otherwise", async () => {
  const files = {
    "domain/a.ts": 'import type { B } from "../infra/b";\nexport type A = B;',
    "infra/b.ts": "export type B = number;",
  };
  assert.deepEqual(kinds(await checkArchitecture(mkdir(files), cfg())), ["violation"]);
  assert.equal((await checkArchitecture(mkdir(files), cfg({ ignoreTypeOnly: true }))).ok, true);
});

test("non-literal dynamic imports are REPORTED as unanalysed, never assumed safe; a reviewed exception is explicit", async () => {
  const files = {
    "domain/a.ts":
      'const name = "../infra/b";\nconst m = await import(name);\nconst r = require(`../infra/${name}`);\nconst g = import.meta.glob("../infra/*.ts");\nexport { m, r, g };',
    "infra/b.ts": "export const b = 1;",
  };
  const r = await checkArchitecture(mkdir(files), cfg());
  assert.deepEqual(kinds(r), ["unanalyzed", "unanalyzed", "unanalyzed"]);
  assert.equal(r.ok, false);
  const allowed = await checkArchitecture(mkdir(files), cfg({ allowDynamic: ["domain/a.ts"] }));
  assert.equal(allowed.ok, true);
});

test("package rules: forbidden packages (incl. scoped and node: builtins) are caught; allowed ones are not", async () => {
  const r = await checkArchitecture(
    mkdir({
      "domain/a.ts":
        'import React from "react";\nimport pg from "pg/lib/client";\nimport { readFileSync } from "node:fs";\nimport zod from "zod";\nexport { React, pg, readFileSync, zod };',
      "infra/b.ts": "export const b = 1;",
    }),
    cfg({
      layers: [
        { name: "domain", include: ["domain/**"], mayImport: [], forbidPackages: ["react", "pg", "node:fs"] },
        { name: "infra", include: ["infra/**"], mayImport: ["domain"] },
      ],
    }),
  );
  assert.equal(r.findings.filter((f) => f.kind === "violation").length, 3, msgs(r));
  assert.ok(!msgs(r).includes("zod"));
});

test("empty and misconfigured scans FAIL: no matching files, a dead layer glob, too few files", async () => {
  const none = await checkArchitecture(mkdir({ "other/x.ts": "export {};" }), cfg());
  assert.ok(kinds(none).includes("empty-scan"));
  assert.equal(none.ok, false);
  const typo = await checkArchitecture(
    mkdir({ "domain/a.ts": "export {};", "infra/b.ts": "export {};" }),
    cfg({
      layers: [
        { name: "domain", include: ["domian/**"], mayImport: [] },
        { name: "infra", include: ["infra/**"], mayImport: [] },
      ],
    }),
  );
  assert.match(msgs(typo), /layer "domain" matched no source files/);
  const few = await checkArchitecture(
    mkdir({ "domain/a.ts": "export {};", "infra/b.ts": "export {};" }),
    cfg({ minFiles: 5 }),
  );
  assert.match(msgs(few), /only 2 source file/);
});

test("config mistakes fail: a file in two layers, mayImport naming an unknown layer, a missing tsconfig", async () => {
  const dir = mkdir({ "domain/a.ts": "export {};" });
  const two = await checkArchitecture(
    dir,
    cfg({
      layers: [
        { name: "domain", include: ["domain/**"], mayImport: [] },
        { name: "also", include: ["domain/a.ts"], mayImport: [] },
      ],
    }),
  );
  assert.match(msgs(two), /two layers/);
  const unk = await checkArchitecture(
    dir,
    cfg({ layers: [{ name: "domain", include: ["domain/**"], mayImport: ["ghost"] }] }),
  );
  assert.match(msgs(unk), /unknown layer "ghost"/);
  const tsc = await checkArchitecture(dir, cfg({ tsconfig: "nope.json" }));
  assert.match(msgs(tsc), /tsconfig does not exist/);
});

test("imports of files outside every layer, unresolved relative imports, and uncovered new files are findings", async () => {
  const files = {
    "domain/a.ts": 'import { s } from "../shared/s";\nimport { m } from "./missing";\nexport { s, m };',
    "shared/s.ts": "export const s = 1;",
    "infra/b.ts": "export {};",
  };
  const r = await checkArchitecture(mkdir(files), cfg());
  assert.deepEqual(kinds(r).sort(), ["unanalyzed", "unclassified"]);
  assert.equal((await checkArchitecture(mkdir(files), cfg({ allowUnclassified: true }))).findings.length, 1);
  const cover = await checkArchitecture(
    mkdir({ "domain/a.ts": "export {};", "infra/b.ts": "export {};", "domain2/new.ts": "export {};" }),
    cfg({ cover: ["**/*.ts"] }),
  );
  assert.ok(cover.findings.some((f) => f.file === "domain2/new.ts" && /belongs to no layer/.test(f.message)));
});

test("dogfood: this runtime's own layering holds (and the scan is not empty)", async () => {
  const root = join(import.meta.dirname, "..");
  const config = JSON.parse(
    (await import("node:fs")).readFileSync(join(root, ".agents/architecture.json"), "utf8"),
  ) as ArchConfig;
  const r = await checkArchitecture(root, config);
  assert.equal(r.ok, true, msgs(r));
  assert.ok(r.scanned >= 30);
});
