# RFC 0000: Title

Status: Draft

Owner:

Labels:
`rfc`, `phase:9-open-source`

## Decision

State the decision in one paragraph. Be concrete about the stage seam,
generated surface, backend choice, or public workflow being changed.

## Problem

What current limitation prevents the engine from moving toward real WPT, real
pages, real performance, or real open-source velocity?

## Goals

- 

## Non-Goals

- 

## Proposed Mechanism

Describe the mechanism, ownership boundary, and API shape. Prefer diagrams,
types, or command examples over broad prose.

## Stage Boundary Check

- Upstream stages read:
- Downstream stages written:
- IR boundary used:
- New generated surface:
- Manual invalidation API added: no
- Silent stub path added: no

## Evidence Plan

List the exact proof required before implementation can merge.

```bash
npm run typecheck
npm run lint
npm run test
npm run wpt:subsets -- --trace
npm run evidence
```

Add targeted WPT, reftest, benchmark, dashboard, or smoke evidence as needed.

## Alternatives Considered

1. 

## Risks

- 

## Rollback

How can this be reverted without corrupting stage boundaries, generated output,
or public evidence?

## Open Questions

- 
