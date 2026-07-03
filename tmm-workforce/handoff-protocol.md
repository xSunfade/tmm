# Handoff Protocol

How work moves between agents (and between agent sessions, which have no shared memory). The unit of coordination is the **handoff package** — a self-contained block of text that lets the next agent start cold. Subagents never see chat history; assume the reader knows the repo and the roadmap folders but nothing about your session.

## Task intake (what a role receives)

Every task given to a role/subagent must contain:

```
ROLE: <which role file to adopt>
TASK: <one-sentence goal>
CONTEXT:
  - Decision refs: <D-numbers / ADR numbers / audit IDs this implements>
  - Phase ref: <project-roadmap/02 item, e.g. "Phase 4.8">
  - Files/areas in scope: <paths>
  - Out of scope: <explicit exclusions — especially for engine/money paths>
CONSTRAINTS: <anything beyond operating-rules.md>
DONE MEANS: <acceptance criteria, copied or adapted from the roadmap item>
HANDOFF TO: <next role, usually a reviewer per review-gates.md>
```

If a task arrives without `DONE MEANS`, the receiving agent's first action is to derive it from the roadmap item and echo it back for confirmation.

## Handoff package (what a role produces)

Posted in the PR description (or session summary if no PR):

```
## Handoff — <role> → <next role>
WHAT CHANGED: <plain-language summary; list files with one-line reasons>
DECISIONS IMPLEMENTED: <D-numbers / audit IDs>
VERIFIED: <each acceptance criterion with evidence — test name + result,
           command output, screenshot; "not verified" is a valid, honest entry>
NOT DONE / FOLLOW-UPS: <explicitly, with suggested owner>
NEW RISKS OR RULES PROPOSED: <anything for the risk register or operating-rules>
REVIEW FOCUS: <where the reviewer should spend their skepticism —
               the riskiest 20% of the diff>
```

## Definition of done (universal)

A task is done when **all** of:

1. Acceptance criteria met with evidence (not "should work").
2. Tests: new behavior tested; regression test for any bug fixed; property/golden suites green if the engine was touched.
3. Lints/build green; no new CI failures.
4. Docs updated in the same PR when behavior, env vars, routes, schema, or policies changed (Technical Writer can be the reviewer, but the builder drafts).
5. Handoff package written.
6. Required reviewer role (per `review-gates.md`) has run its checklist and the findings are resolved or explicitly accepted by the founder.

## Session-boundary handoffs (same role, new session)

Long workstreams outlive context windows. Before ending a session mid-workstream, write a **continuation note** (in the PR, or `docs/worklog/` if no PR yet):

```
STATE: <branch, what's committed vs uncommitted>
NEXT STEP: <the exact next action>
OPEN QUESTIONS: <with your current best answer>
TRAPS: <anything surprising you learned that the next session will trip on>
```

The next session reads the continuation note, the role file, and `operating-rules.md` — in that order — before touching code.

## Escalation to the founder

Escalate (stop work, surface the question) when:
- A task conflicts with a D-decision or an ADR.
- A change requires prod access, live Stripe mode, real spend, or a destructive action.
- The pricing floor, legal text, or anything user-promising (SLA, retention, refunds) needs a value judgment.
- Two roles disagree after one review round-trip (don't loop; escalate with both positions stated fairly).

Everything else: proceed and report.
