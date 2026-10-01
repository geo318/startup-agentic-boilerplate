# Threat model and trust boundaries (ADR-0001)

Status: accepted for M0. Scope: the optional managed runtime planned in the v2 plan. Documentation mode (today's renderer, skills, CI templates) is advisory: it enforces only what CI actually runs.

## Decision

Models propose; the controller authorizes and executes; trusted verification records evidence; policy decides readiness; explicit CLI commands approve and accept, including through an authorized harness. No model output, repository text, tool stdout, or memory is authority.

## Trust zones

| Zone | Contents | Writable by worker/candidate code |
| --- | --- | --- |
| Controller state | policy snapshots, approvals, credentials, run logs, evidence | no |
| Protected graders | acceptance tests, gate specs, eval labels, holdouts | no |
| Candidate workspace | separate copy of the project | yes |
| Untrusted input | repo text, comments, logs, model output, memories | n/a (evidence only) |

## Threats and required controls (each needs an adversarial test before M1 exit)

| Threat | Control |
| --- | --- |
| Forged green output | controller captures gate results; model-written JSON/console summaries ignored |
| Test removal/skip, config weakening | protected paths; scope check against the frozen contract |
| Zero discovery counted as pass | applicable gate with 0 discovered files/tests is `incomplete` |
| Edits after verification | evidence bound to candidate digest; any change invalidates it |
| Prompt injection in code/logs | text is data; permissions come only from policy, never from prompts |
| Path traversal / symlink / hardlink escape | resolve and reject before write; transactional apply |
| Candidate attacks its grader | grader runs outside the candidate's writable tree; tamper tests |
| Secret or source egress | local-only default; per-project egress consent; credentials stay in controller |
| Resource exhaustion by approved commands | per-gate timeouts; descendant kill on cancel |
| Crash around side effects | append-only log; resume validates state, never blindly replays billable calls |
| Harmful learned rule | quarantine → evaluation → explicit promotion → rollback |
| Candidate approves itself | verifier is the previously trusted controller; protected maintenance contracts |
| Optional Jev decision weakens policy | resolver rejects non-allowed options; security families fail closed |

## Known limits

- A Git worktree is not an isolation boundary; unsupported platforms export packets and import patches, and must not claim managed execution.
- Passing finite checks does not prove absence of defects; `ACCEPTED` is not ground truth.
- Branch protection is repository configuration, not workflow YAML; installation must report effective status (reviewed baseline: `main` unprotected).
