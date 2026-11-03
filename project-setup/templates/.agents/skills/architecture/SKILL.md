---
name: architecture
description: Apply layered architecture and SOLID when adding application code, choosing source folders, or auditing and refactoring boundaries across UI, API, business logic, repositories, and integrations. Use from the first implementation, including requests about DAL, BLL, presentation, flat folders, or module ownership.
---

# Architecture

Make ownership and dependency direction explicit from the first implementation. Apply these
principles to the requested scope; a small feature does not need every layer or a repo-wide
restructure. Follow the project's stack, framework conventions, and existing architecture
decisions. An architecture question calls for an evidence-based answer; an audit does not
authorize edits. Existing approval and delivery rules still apply.

## Before adding or changing code

Read the applicable `AGENTS.md`, architecture, code organisation, and testing guidance. Inspect
the nearest existing feature and its callers. Reuse its sound boundaries; do not copy a known
violation into new code. Read only the relevant architecture topics.

Map the actual path through presentation, application, domain, and persistence. For a new
feature, name each file's owner and allowed dependencies before creating it. For existing code,
trace a representative read and write where present, including worker entrypoints. Record:

- where input is parsed, actor context is established, and resource access is authorized;
- who owns the rule, transaction, repository contract, and concrete adapter;
- how errors, retries, and external effects reach the caller;
- which source files, callers, exports, tests, fixtures, generated clients, configuration, and
  documentation the change must reach.

Report missing layers separately from broken boundaries. A folder called `presentation` or
`BLL` is optional; show the actual paths and responsibilities. Read
[layout examples](references/layouts.md) when deciding folder placement or reorganizing a tree.

## Responsibilities and dependencies

| Responsibility | Owns | Keep out |
| --- | --- | --- |
| UI presentation | Rendering, interaction, local view state, composing feature components | Authoritative business decisions, persistence, vendor clients |
| Feature data access | The project's hooks/loaders, caching, HTTP calls through its client adapter | Business policy, duplicated server rules |
| API presentation / transport | Request parsing, authenticated context, response and error mapping, delegation | Calculations, workflow orchestration, ORM queries |
| Application / use cases (BLL orchestration) | Load, authorize, invoke domain rules, persist, coordinate effects | Framework responses, concrete ORM or vendor dependencies |
| Domain (BLL rules) | Invariants, transitions, calculations on domain values | I/O, framework/ORM/vendor types, environment or clock reads |
| Ports | Consumer-owned repository and gateway contracts | Unused methods, implementation-specific types |
| Repository adapters (DAL) | Scoped queries, persistence, mapping storage to domain values or read DTOs | Business decisions, HTTP responses, independent commits |
| Integration adapters | Vendor calls and translation of vendor values and failures | Vendor types or raw failures leaking into the core |
| Composition and transaction infrastructure | Wiring implementations; connection, commit, rollback, cleanup | Business rules and implicit service lookup |

Runtime calls usually flow from UI through the project's feature data layer and client to
transport, then a use case and repository. Domain functions are invoked by use cases.
Source dependencies point inward: use cases depend on ports; concrete repositories implement
those ports. Preserve the project's canonical request path and framework-supported loaders;
do not impose React hooks, a separate backend, or a particular ORM on every application.

Enforce the boundaries where they exist:

- Keep persistence-library imports inside the persistence adapter boundary, and SDK imports
  inside integration adapters. Translate records and errors before returning to application code.
- Keep cross-module calls on curated public entries. Internal files import siblings directly,
  not their own public barrel. Resolve cycles through ownership or a consumer-owned port wired
  at composition; do not add re-export chains to hide deep imports.
- Declare only the repository methods a use case needs. Queries may use narrow read ports
  returning projections without loading a whole aggregate; they still enforce access scope.
- Let the use case define the transaction boundary. Bind collaborating repositories to that
  transaction; do not capture a global repository or start a nested transaction accidentally.
  Keep lifecycle handling separate from application wiring as it grows.
- Derive tenant scope from authenticated, authorized context; a route parameter alone is not
  authority. Keep row-level authorization in the application policy and scope storage queries
  defensively. Preserve existing isolation and concurrency guarantees during moves.
- Workers invoke the same application operations and recheck current permissions/state. Inject
  time and generated IDs when decisions need them; pass values into pure domain functions.
  Keep network effects outside database transactions; preserve the existing outbox/idempotency
  mechanism where atomic delivery or retries require it.

## Organize by ownership from the start

- Give each business area a module. Within it, separate domain rules, use cases, and ports when
  those responsibilities exist. Give concrete repositories a dedicated persistence home.
- Group API transports by business area. Keep shared transport dependencies at their common
  owner; moving a source file does not imply changing its endpoint URL.
- Group web code by feature, then screen/subfeature and component ownership. Keep a component's
  private model and children together. A subfeature with its own data lifecycle owns its API,
  queries/hooks or loaders, and components. Promote shared code only to its lowest common owner.
- Split a growing domain by cohesive capabilities (for example, pricing, discounts, settlement),
  not just by file count or technical buckets. Keep small cohesive groups flat. Create no empty
  directories or single-use forwarding layers to complete a diagram.
- Use descriptive product terms for files, folders, and new routes. Prefer `workspace` to `w`
  when designing a workspace route. Preserve established public URLs unless a rename is in scope.
- Follow the project's test placement policy. When dedicated test folders are requested, mirror
  source ownership under `tests/` and move test-only fixtures with them. Organizing tests alone
  does not address a request to organize production sources.

## Apply SOLID to concrete seams

- **Single responsibility:** separate transport, orchestration, rules, and storage where they
  change for different reasons; keep cohesive code together.
- **Open/closed:** add a real variant or adapter at an existing seam; avoid speculative plugin
  systems, generic base repositories, or strategy registries.
- **Liskov substitution:** implementations and fakes honor the same failure, absence, ordering,
  and atomicity contracts. Check both reads and writes when replacing an adapter.
- **Interface segregation:** dependencies expose what their consumer uses, not an entire service
  container or every repository in the application.
- **Dependency inversion:** application code declares what it needs; composition supplies the
  concrete implementation. Functions and structural interfaces are sufficient.

## Refactor without changing behavior

Separate mechanical moves from policy changes so reviewers can verify each. Map old paths to
new owners, then update every import, public entry, mock/patch target, discovery pattern, alias,
package export, script, and documentation reference. Remove obsolete paths after consumers move;
retain compatibility entries only where external consumers require them.

For API moves, compare endpoint paths, methods, payloads, and error behavior. Module-qualified
schema names can change even when URLs do not: regenerate clients with the project's generator
and inspect the schema diff. Never hand-edit generated clients.

If URL renaming is requested, update links, redirects, auth callbacks, server-generated URLs,
and tests. Preserve existing bookmarks/deep links with the project's compatibility mechanism;
verify nested paths and query strings. Web route names and API endpoint names are independent.

## Verify and hand off

Run the project's applicable lint, types, affected tests, docs, and architecture checks. Use
its existing import-boundary tooling; when introducing a missing check is in scope, prefer
language-aware import analysis over text matching. Cover the forbidden edge and its legitimate
counterpart rather than asserting folder names. Do not claim a directory move enforces a layer.

Verify changed request paths at runtime as required by the project, and follow its integration
and e2e policy. Add surgical regression tests for behavior or contracts at risk, not tests that
only mirror a moved implementation. Check for stale paths and unintended schema/URL changes.

For an audit, return concrete file evidence, impact, and the smallest correction per finding.
For implementation, report the resulting layer/folder map, compatibility decisions, checks
actually run, and remaining gaps. Update the code map or architecture guidance when ownership
changes. A plan or a passing typecheck alone is not evidence the refactor works.
