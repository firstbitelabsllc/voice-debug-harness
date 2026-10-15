# Agents

## Method (takeoff)

method: takeoff — `firstbitelabsllc/takeoff` METHOD.md (T7 step series) · profile: none (Node package; lanes below)
rungs: A-unit = `npm test` on every push via `.githooks/pre-push`; B-package = `ci:offline` + `release:verify` + `test:consumer`, D quality / E architecture / F product via takeoff `bin/review` at landing via `.githooks/land [<commit>]`; the Chromium journey is required CI `browser (node22)`, not a local lane
gate: export `TAKEOFF_HOME` to the approved installed Takeoff (normally `~/Development/skillbox-sources/takeoff`) and call `"$TAKEOFF_HOME/bin/land-pr" <pr> --method squash --require-lane A-unit`. The installed command reads the pinned base `.githooks/land-pr-lanes`, runs missing native proof, and requires completed CodeRabbit review plus native approval at the exact head before a head-matched squash merge. A refused or unjudged guard makes no merge. Do not replace the installed entrypoint with a checkout-owned wrapper or fall back to `gh pr merge`. Enable hooks with `git config core.hooksPath .githooks`.
