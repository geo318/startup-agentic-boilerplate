import type { RiskTier } from "./run.ts";

const ORDER: RiskTier[] = ["R0", "R1", "R2", "R3"];
export const maxTier = (...t: RiskTier[]): RiskTier => t.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a));

// Path classes that are sensitive regardless of how small the diff is.
const R3_PATHS: RegExp[] = [
  /(^|\/)(auth|authn|authz|session|permission|permissions|rbac|acl|tenant|tenants|billing|payment|payments|invoice|invoices|security|crypto|secrets?)(\/|\.|-|_|$)/i,
  /(^|\/)(migrations?|schema\.prisma)(\/|$)|\.sql$/i,
  /^\.github\//, /^\.agents\//, /^\.githooks\//, /^scripts\/(checks|git|skills)\//,
  /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Dockerfile|docker-compose[^/]*)$/,
  /(^|\/)(agentic|policy|routing|models)[^/]*\.json$/,
];
export const SENSITIVE_TAGS = ["auth", "tenancy", "financial", "destructive-migration", "security"] as const;

// Deterministic floor. Unknown scope is not low risk: no declared paths and no changes → R2 minimum for
// anything but an explicit recipe. Models and Jev may raise a tier, never lower this floor.
export function riskFloor(i: { paths: string[]; tags?: string[]; recipe?: boolean }): RiskTier {
  if (i.tags?.some((t) => (SENSITIVE_TAGS as readonly string[]).includes(t))) return "R3";
  if (i.paths.some((p) => R3_PATHS.some((r) => r.test(p)))) return "R3";
  if (i.recipe && i.paths.length > 0) return "R0";
  if (i.paths.length === 0) return "R2";
  const layers = new Set(i.paths.map((p) => p.split("/").slice(0, -1).slice(0, 2).join("/"))); // directories; root files share one layer
  return layers.size > 1 ? "R2" : "R1";
}
