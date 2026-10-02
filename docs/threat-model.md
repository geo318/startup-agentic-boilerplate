# Threat model and trust boundaries (ADR-0001)

Status: implemented protocol controls with host-execution limits. Scope: the optional managed runtime. Documentation mode (today's renderer, skills, CI templates) is advisory: it enforces only what CI actually runs.

## Decision

Models propose; the controller authorizes and executes; trusted verification records evidence; policy decides readiness; explicit CLI commands approve and accept, including through an authorized harness. No model output, repository text, tool stdout, or memory is authority.

## Trust zones

| Zone | Contents | Writable by worker/candidate code |
| --- | --- | --- |
| Controller state | policy snapshots, approvals, credentials, run logs, evidence | worker actions: no; host-executed candidate code: OS user permissions apply |
| Protected graders | acceptance tests, gate specs, eval labels, holdouts | worker actions: protected; no OS isolation from executed code |
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
| Candidate attacks its grader | model edits cannot alter frozen acceptance files; independent eval graders live outside the candidate. Host code is not sandboxed |
| Secret or source egress | local-only default; per-project egress consent; credentials stay in controller |
| Resource exhaustion by approved commands | per-gate timeouts; descendant kill on cancel |
| Crash around side effects | append-only log; resume validates state, never blindly replays billable calls |
| Harmful learned rule | quarantine → evaluation → explicit promotion → rollback |
| Candidate approves itself | verifier is the previously trusted controller; protected maintenance contracts |
| Optional Jev decision weakens policy | resolver rejects non-allowed options; security families fail closed |

## Known limits

- Project copies, scratch HOME directories, protected paths and hash chains are protocol/integrity controls, not OS isolation. Candidate checks run as the invoking user and can access its files or network. Do not run hostile code under this trust model. An isolated runner would be a separate feature.
- `local-only` blocks hosted model transports; it does not firewall network traffic from host-executed checks.
- Passing finite checks does not prove absence of defects; `ACCEPTED` is not ground truth.
- Branch protection is repository configuration, not workflow YAML; installation must report effective status (reviewed baseline: `main` unprotected).
