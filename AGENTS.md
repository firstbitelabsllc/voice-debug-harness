# Agents

## Method (takeoff)

method: takeoff — `firstbitelabsllc/takeoff` METHOD.md (T7 step series) · profile: none (Node package; lanes below)
rungs: A-unit = `npm test` on every push via `.githooks/pre-push`; B-package = `ci:offline` + `release:verify` + `test:consumer`, D quality / E architecture / F product via takeoff `bin/review` at landing via `.githooks/land [<commit>]`; the Chromium journey is required CI `browser (node22)`, not a local lane
gate: merge only through `.githooks/land-pr <pr>`: it runs the land series on the exact PR head if no receipt exists, posts `takeoff/land` there, requires CodeRabbit's review and approval of that head plus every required check, then squash-merges with `--match-head-commit`. A refused or unjudged guard makes no merge; never fall back to `gh pr merge`. Enable hooks with `git config core.hooksPath .githooks`.

## Code comments

Use names, types and tests to explain code. Do not add narration, section
banners, commented-out code or workaround history. Fix an owned workaround
at its cause; keep behavior changes separate from comment deletion.

Keep license headers, public API contracts, necessary tool or compiler
directives, and non-obvious constraints imposed by a current external
platform, dependency or protocol. Link the relevant issue or specification
when it explains the constraint. Correctness or safety suppressions require
a code fix and focused proof; deleting the directive alone is not a fix.
Change generated or vendored comments through their source owner.
