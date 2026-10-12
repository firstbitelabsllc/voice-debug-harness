# Agents

## Method (takeoff)

method: takeoff — `firstbitelabsllc/takeoff` METHOD.md (T7 step series) · profile: none (Node package; lanes below)
rungs: A-unit = `npm test` on every push via `.githooks/pre-push`; B-package = `ci:offline` + `release:verify` + `test:consumer`, D quality / E architecture / F product via takeoff `bin/review` at landing via `.githooks/land [<commit>]`; the Chromium journey is required CI `browser (node22)`, not a local lane
gate: merge only through `.githooks/land-pr <pr>`: it runs the land series on the exact PR head if no receipt exists, posts `takeoff/land` there, requires CodeRabbit's review and approval of that head plus every required check, then squash-merges with `--match-head-commit`. A refused or unjudged guard makes no merge; never fall back to `gh pr merge`. Enable hooks with `git config core.hooksPath .githooks`.
