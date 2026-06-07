/**
 * Local ESLint plugin `local` — Phase 0 "constitution" rules that turn
 * architectural invariants into CI-enforced lint errors (design.md §2, §12).
 *
 * Rules:
 *   - `local/no-silent-stub` (task 1.3): unimplemented paths must
 *     `throw NotImplemented`; returning a placeholder turns CI red
 *     (Requirements 5.1, 5.2, 5.3, 12.2).
 *   - `local/no-cross-stage-import` (task 1.4): a pipeline stage must not
 *     import another stage package's internal (mutable) modules; stages
 *     communicate only through the frozen IR. Keeps enforcing for every
 *     package added in any later Phase (Requirements 3.2, 12.1, 12.7).
 */
import noSilentStub from "./no-silent-stub.js";
import noCrossStageImport from "./no-cross-stage-import.js";

const plugin = {
  meta: {
    name: "eslint-plugin-local",
    version: "0.0.0",
  },
  rules: {
    "no-silent-stub": noSilentStub,
    "no-cross-stage-import": noCrossStageImport,
  },
};

export default plugin;
