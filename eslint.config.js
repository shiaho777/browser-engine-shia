// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import local from "./tools/eslint-rules/index.js";

/**
 * Flat ESLint config. This is the lint surface that Phase 0's "constitution"
 * rules hook into:
 *   - task 1.3: a rule forbidding silent stubs (unimplemented paths must
 *     `throw NotImplemented`, never return a placeholder).
 *   - task 1.4: a rule forbidding cross-stage imports of internal mutable types
 *     (stages communicate only through frozen IR).
 * Those custom rules live under the local plugin in `tools/eslint-rules`; we
 * keep the strict, type-aware baseline so the boundary exists from day one.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/*.config.js",
      "tools/**",
      "**/scripts/**",
      "**/wpt-fixtures/**",
      // Machine-local working directories (never committed).
      "artifacts/**",
      ".codebuddy/**",
      ".zcode/**",
      // Plain-JS runtime glue outside the typed source tree (bin launchers,
      // Electron main process, preload bridge).
      "**/bin/**",
      "packages/app/electron/**",
      "packages/app/preload/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      local,
    },
    rules: {
      // Constitution: unimplemented paths throw NotImplemented, never return a
      // placeholder (design.md §2 bug#4, §12; Requirements 5.1, 5.2, 12.2).
      "local/no-silent-stub": "error",
      // Constitution: pipeline stages communicate only through the frozen IR;
      // a stage must never import another stage's internal mutable types
      // across the stage boundary (design.md §2 bug#2, §3.C, §6; Requirements
      // 3.2, 12.1, 12.7). Stays enforced for every package added in later
      // Phases.
      "local/no-cross-stage-import": "error",
      // Stage boundaries are single-direction; surface accidental cycles early.
      "no-restricted-imports": "off",
      "@typescript-eslint/explicit-module-boundary-types": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
