# Build plan

Forward-looking only: current focus, milestones, open gaps, blockers, and open questions. Shipped
work moves to the [progress tracker](progress-tracker.md) in the same change that ships it.
Budget: 250 lines — longer initiatives get a file in [plans/](plans/README.md) and a one-line link.

## Current focus

<!-- FILL: the one milestone being worked on now (normally M0 on day one) and its exit criterion in one sentence. -->

## Milestones

<!-- FILL: 3–6 milestones derived from the brief, each as:

### M<n> — <name>

Goal: one sentence. Exit criterion: an observable result ("an owner can sign up, create a workspace, and see an empty dashboard in production").

- [ ] task (small enough for one PR)

M0 is always "Foundation": repository + tooling + CI green, env module, deployable hello-world per app, database connected, auth skeleton — whatever the stack needs before the first feature. M1 is the thinnest end-to-end vertical slice of the core user job, through every layer of the request path. Later milestones follow the brief's priorities. -->

## Open questions

<!-- FILL: every decision the brief left open or the user deferred at intake, as "- **Question** — why it matters / who decides". These are the first things /architect should resolve. Write "None." if there are none. -->

## Blockers

None.

## Maintenance

- Date every status change (`— YYYY-MM-DD`). Keep local / merged / deployed / verified distinct.
- Remove an item when it ships; record the evidence in the progress tracker, not here.
