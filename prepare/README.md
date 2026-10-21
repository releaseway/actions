# Prepare release versions and tags

Use `releaseway/actions/prepare` in a step when your workflow should calculate
a version and push its release marker commit and tag. For an existing tag that
only needs publication, use the [root action](../docs/publishing.md).

The subaction shares the [selected release SHA](../README.md#choose-a-release)
with the root and distribution entry points. Replace `<actions-sha>` and
`<checkout-sha>` using the [reference guide](../docs/action-references.md).

Your workflow owns the product build and passes
the prepared outputs to the publisher. The example below shows a product with an
explicit version-series boundary; replace its tags and build command with your
project's values.

The `prepare` subaction owns version calculation, release marker commits, Git tags,
atomic pushes, and resumable plans. Keep product build/test steps in your workflow and
publication policy in `.github/releaseway.yml`:

```yaml
schema: 1
branch: main
tag-prefix: v
bump: auto

series:
  base-tag: v11.0.4
  start-version: 1.2.0
latest: current-series
```

The first release after this boundary is exactly `v1.2.0`, even if the old series has
larger versions. Subsequent tags with the same prefix after the boundary and reachable
from the source form the current series. Tags at or before the boundary are preserved
and excluded.

Use a distinct prefix for independently maintained series on overlapping history. A
collision with any historical tag fails; tags are never retargeted.

Without `series`, reachable tags supply the version baseline, with
`initial-version: 0.1.0` for an empty history.

`bump: auto` uses Conventional Commits since the previous current-series tag: breaking
changes increment major, features increment minor, and other changes increment patch.
`patch`, `minor`, and `major` select an explicit increment.

An optional `prerelease-id` such as `rc` starts `.0`, increments matching prereleases,
and promotes the core version when a later source is prepared without a prerelease
identifier.

The following workflow shows the job steps and shared serialization policy.
Use your existing build command in place of `./build-product.sh`.

```yaml
name: Prepare and publish a release

on:
  workflow_dispatch:

permissions:
  contents: write

concurrency:
  group: release-main
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-24.04

    steps:
      - uses: actions/checkout@<checkout-sha>
        with:
          fetch-depth: 0

      - id: release
        uses: releaseway/actions/prepare@<actions-sha>

      - run: ./build-product.sh "${{ steps.release.outputs.version }}"

      - uses: releaseway/actions@<actions-sha>
        with:
          tag: ${{ steps.release.outputs.tag }}
          commit: ${{ steps.release.outputs.commit }}
          prerelease: ${{ steps.release.outputs.prerelease }}
          latest: ${{ steps.release.outputs.latest }}
          assets: dist/*
```

Preparation writes a deterministic release marker commit using the source tree
unchanged, then pushes the branch and lightweight tag as one atomic transaction. The
checkout remains at the source; build output uses the returned version.

Checkout credentials need branch/tag write access and full history. Branch protection
and servers without atomic push support fail without a partial push; the action does not
bypass their policy.

Serialize preparation and publication with one branch-level concurrency group, including
prereleases. GitHub latest selection has no compare-and-swap API, so serialization is
required to prevent concurrent publication races.

`mode: plan` returns the version, tag, source, commit, prerelease, latest policy, and
`plan-path` without changing remote refs. The saved JSON is inspectable and can be
retained as a workflow artifact.

`mode: resume` with `plan-path` requires checkout of the saved source or its marker
commit and validates configuration, source and generated commit against fresh origin
state before retrying. Failed pushes leave the plan available; matching remote refs are
accepted after transport ambiguity. Changed branch state or conflicting tags fail rather
than overwriting another writer.

Calling `prepare` again at the same source or its release marker resumes the same
release; start a later release from a new source commit. A failed build can therefore
rerun preparation and resume the existing GitHub draft. There is no destructive rollback
of published refs or artifacts.

`mode: resolve` accepts an existing stable `tag` and optional `branch`, verifies its
remote binding and branch ancestry, and returns `tag`, `version`, `commit`, and
`target` without requiring a configuration file. Release workflows use this instead of
repeating shell tag validation.

`mode: tag` creates or verifies a versioned `tag` bound to an explicit full `commit` SHA
on the configured origin `branch`. It accepts custom prefixes and prereleases for
companion native artifact releases, without adding a marker commit or changing the
branch. A conflicting tag fails and a matching tag is accepted on retry. Neither resolve
nor tag mode requires a release configuration file.

`latest: current-series` selects the newest stable tag in the configured series
regardless of older series' numerical versions. Prereleases and superseded
current-series tags are not promoted.

The policy is checked before draft creation and again before publication and final
verification. `latest: true` remains an unconditional stable-release policy; `automatic`
retains GitHub's legacy selection.

### Resolve prereleases and prefixed tags

Use `mode: resolve` with `allow-prerelease: "true"` to inspect an existing
prerelease. `commit` optionally checks its expected full lowercase commit SHA.
`tag-prefix` optionally supplies the exact version prefix; otherwise bare versions,
`v` versions and unambiguous version suffixes are recognized. Prefixes ending in a
digit or dot require explicit selection when automatic parsing is ambiguous.
Missing tags and incorrect bindings fail without creating or replacing refs.
`allow-prerelease: "true"` and a nonempty `tag-prefix` are resolve-only options.

### Tag the original source commit

Set `strategy: source-tag` in `.github/releaseway.yml` to calculate versions and
create an annotated tag on the original commit without updating the branch.
Omitting `strategy` keeps the existing release-commit behavior.

The user config's
`schema` is optional: absence always means schema 1; explicit numeric `schema: 1`
is equivalent. Null, other types and unsupported versions fail.

Source-tag plans use generated schema 2; their schema field is required. Releaseway
records source, normalized policy and channel identity in the tag. A repeated
request reuses the version even without the saved plan file. A saved plan requires
checkout of its source and unchanged policy. A missing tag is created only when
fresh origin state still agrees with the plan. Conflicting tags are never replaced.

Same-source rc to stable promotion keeps the core version. Once stable exists,
automatic rc planning fails; explicitly resolving or resuming the saved existing
rc remains supported.

A branch move during tag creation fails while preserving the
accepted tag. Inspect origin and resume the same identity; do not delete it or bump
a version merely to retry. Annotated tag object IDs differ from commits: consume
`outputs.commit` or peel the tag with `^{commit}`.

[Back to Releaseway Actions](../README.md)
