# Version-series and publication-policy implementation

The required flow preserves previous tags, restarts version calculation after an explicit boundary, declares stable/prerelease npm channels outside package manifests, chooses the current stable series as GitHub latest, and moves Git release execution into Releaseway.

## Work units and completion evidence

1. Extend npm repository/per-package publication policy with `publish.channels.stable` and `publish.channels.prerelease`. Explicit channels permit lower versions; omitted policy keeps existing guards. Validate real configuration, packed-manifest conflicts, tag-derived versions, unchanged source manifests, and publication planning.
2. Add `releaseway/actions/prepare` with a versioned repository policy, history-based series membership, Conventional Commit or explicit increments, plan/prepare/resume/resolve modes, deterministic release commits, atomic branch/tag pushes, fresh remote validation, and saved recovery plans. Validate a bare Git origin, tag retention/collisions, atomic rejection, stale writers, deterministic retries, prerelease increments and promotion, and tampered plans.
3. Add `latest: current-series` with series membership and newest stable checks before draft creation/publication and final verification. Preserve existing explicit/automatic policies. Serialize caller workflows per release branch because the GitHub latest API has no compare-and-swap operation.
4. Replace repeated tag-validation shell code in release workflows with the resolve subaction. Move fixture dist-tag selection into publication settings; retain fixture-specific identity, product build/test, native bin setup, and acceptance evidence.
5. Review all changed policy, execution, recovery, consumer, and documentation paths. Run types/unit/bundle/lifecycle/config checks and exact-candidate GitHub CI plus live GitHub release and npm stage/direct acceptance. Publish immutable automation releases and update consumers to their verified full SHAs.

## Current behavior and boundaries

Series membership uses tags with the configured prefix after the baseline commit that are reachable from the release source. Tags at/before the baseline remain historical. Independently maintained overlapping series use different prefixes. Existing tag collisions fail rather than choosing a different start version or changing old tags.

Release preparation adds a deterministic marker commit without editing the source tree or npm manifest. Version changes are conveyed through outputs and npm's existing tag-derived packing. A retry at the same source/marker resumes that release; a new source commit starts the next. A source branch moving concurrently invalidates a pending plan. Existing GitHub draft/assets and registry-first skip semantics remain in force; published artifacts and refs are never rolled back.

Product build and test commands remain caller-owned. Release validation and atomic Git execution are provider-owned. Automation's exact-candidate acceptance gate remains mandatory; build verification and evidence collection are not bypassed by the new preparation layer.
