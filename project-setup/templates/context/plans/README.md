# Plans

One file per initiative too large for a build-plan entry: `<kebab-case-initiative>.md`. The build
plan links each active plan in one line. Delete or move a plan to `history/` when it completes.

## Template

```markdown
# <Initiative> — <status: proposed | active | deferred>

<Two or three sentences: the outcome, and why now.>

## Confirmed decisions

- <decision> — <reason>

## Scope

- In: <…>
- Out: <…>

## Steps

- [ ] <step small enough for one PR> — <exit evidence>

## Open questions

- <question> — <who decides>

## Verification

<What must be observed, where, before this is called done.>
```
