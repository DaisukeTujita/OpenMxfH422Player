# Codex standard workflow

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
