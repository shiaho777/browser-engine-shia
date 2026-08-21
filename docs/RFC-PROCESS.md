# RFC Process

Use an RFC when a change creates or reshapes an architecture seam, generated
surface, backend adapter, public evidence workflow, or browser-service policy.
Small compatibility fixes do not need an RFC; they need WPT or equivalent
evidence.

## When An RFC Is Required

- New cross-package API or stage seam.
- New generated surface or WebIDL/CSS codegen contract.
- Native backend dependency such as shaping, raster, image, TLS, or HTTP.
- Kernel dependency-tracking behavior.
- Public benchmark/evidence schema changes.
- Security, origin, storage, or network policy.

## Lifecycle

1. Copy `docs/rfcs/0000-template.md` to `docs/rfcs/NNNN-short-title.md`.
2. Open an issue with labels `rfc`, the owning phase label, and the owning stage
   label.
3. Link the issue to the RFC file.
4. Fill in the decision, alternatives, stage boundary check, evidence plan, and
   rollback.
5. Keep status as `Draft` until maintainers agree that the problem and evidence
   plan are clear.
6. Change status to `Accepted` only when the decision is approved.
7. Implement in follow-up PRs that cite the RFC and provide the promised
   evidence.

## Status Values

- `Draft`: proposed, not approved.
- `Accepted`: approved as the path to implement.
- `Implemented`: shipped with the promised evidence.
- `Superseded`: replaced by another RFC.
- `Rejected`: intentionally not pursued.

## Review Bar

An RFC is ready for acceptance when it proves:

- the change moves the engine toward real WPT, real pages, real performance, or
  real open-source velocity
- stage boundaries remain explicit
- unsupported behavior still throws or fails honestly
- public evidence can prove the claim
- rollback is possible without corrupting generated output or benchmark truth
