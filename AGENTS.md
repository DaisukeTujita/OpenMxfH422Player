# Codex standard workflow

## Branching and pull requests (mandatory for every change, however small)

- Never push commits directly to `main`. Always create a working branch first, commit the change there, push that branch to GitHub, and open a Pull Request.
- Do not merge the PR yourself and do not push further commits to `main`. Wait for the repository owner to review the diff and merge it.
- This applies to every agent and every session working in this repository, not just the one that adds this rule.

## Versioning

- Whenever a change adds a feature, fixes a bug, or otherwise changes runtime behavior (including internal/perf changes like refactors that alter behavior), bump the `version` field in the root `package.json` in the same change. Follow semver: `patch` for bug fixes with no behavior/API change beyond the fix, `minor` for backward-compatible feature additions or notable internal improvements (e.g. a new decoding architecture, new diagnostics fields), `major` for breaking changes to the public API (`src/index.ts` exports).
- Do not forget this step just because the change is internal — consumers use the version number to tell whether a build actually includes a given fix.

Codex must perform this workflow autonomously for every repository change:

1. Read the diff from `main` and all related implementation first.
2. Confirm the existing design and backward compatibility, then implement the change and related tests.
3. Run every quality check (`git diff --check`, tests, typecheck, lint, binary check, library build, and example build).
4. Review the complete diff from `main` at least twice. Review 1 covers correctness, asynchronous races, state transitions, abort/generation handling, resource release, boundaries, errors, memory, and read ranges. Review 2 covers test coverage, API compatibility, types, README, example UI, diagnostics, security, performance, Actions, and PR accuracy.
5. Automatically fix every major or moderate finding on the same branch and rerun all checks. Repeat review → fix → all checks up to three times; only then document a concrete unresolved issue.
6. Push, inspect GitHub Actions for the latest head SHA, read failed job/step logs, fix and push the same PR branch, and retry up to three times.
7. Update the PR body to report actual results and limitations. Never merge into `main`.

Do not request intermediate human approval. Stop and clearly report only authentication/permission/external-service blockers or irreconcilable requirements. Never commit generated MXF, WASM, data, or libav runtime assets.

## Pull request completion rules

- If no target PR exists, create exactly one PR after the work is complete. For an existing PR, push to that same PR branch and never create a replacement PR.
- Fill every pull request template section with actual results. After pushing, verify Actions for the latest head SHA; only after Actions succeeds, perform the final PR-body update.
- Review diagnostic values for provenance from actual processing; assigning the requested value is not evidence of the result.
- Verify requested behavior is implemented, not merely represented by a type, field, or placeholder.
- Compare every README and PR-body claim with the implementation. Green Actions never replace logic review.
