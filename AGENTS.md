# Agents

## Method (takeoff)

method: takeoff — `firstbitelabsllc/takeoff` METHOD.md (T7 step series) · profile: none (Node package; lanes below)
rungs: A-unit = `npm test` on every push via `.githooks/pre-push`; B-package = `ci:offline` + `release:verify` + `test:consumer`, D quality / E architecture / F product via takeoff `bin/review` at landing via `.githooks/land [<commit>]`; the Chromium journey is required CI `browser (node22)`, not a local lane
gate: confirm CodeRabbit's native approval names the current PR head, then merge only through `.githooks/land-pr <pr>`. The wrapper selects the installed Takeoff at `$HOME/Development/skillbox-sources/takeoff` unless `TAKEOFF_HOME` names another approved installation. It runs the land series on the exact head when no receipt exists, checks the mandatory lanes from the base revision's `.githooks/land-pr-lanes`, posts `takeoff/land`, and reads CodeRabbit's review and every required check before merging with `--squash --match-head-commit`. A refused or unjudged guard makes no merge; never fall back to `gh pr merge`. Enable hooks with `git config core.hooksPath .githooks`.
