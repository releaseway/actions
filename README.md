# actions

Publish or verify an immutable GitHub Release from an existing Git tag, with deterministic release-note generation.

`releaseway/actions` owns the GitHub Release lifecycle and release-note preparation. The caller still owns version selection, tag creation, build commands, artifact naming, and release triggers.

## Quick start

Create and push the Git tag before invoking the action. A normal publishing job needs `contents: write` and a checkout of the caller repository.

```yaml
jobs:
  release:
    runs-on: ubuntu-24.04
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@<full-commit-sha>
        with:
          fetch-depth: 0
          fetch-tags: true

      - name: Build release assets
        run: ./scripts/build-release.sh

      - name: Publish release
        id: release
        uses: releaseway/actions@<full-commit-sha>
        with:
          tag: ${{ github.ref_name }}
          commit: ${{ github.sha }}
          assets: |
            dist/*.tar.gz
            dist/*.zip
```

`notes: standard` is the default. It collects the released commits, interprets Conventional Commits when present, keeps nonconforming commits visible under `Other Changes`, separates breaking changes, and renders a comparison link when a base release exists.

Always pin cross-repository actions to a full commit SHA.

## Early 0.x contract break

The old boolean `generate-notes` input is removed rather than deprecated.

- old `generate-notes: "true"` → `notes: github`
- old `notes-file: path` → `notes: file` plus `notes-file: path`
- omitting note inputs now means `notes: standard`, not an empty body
- use `notes: none` when an intentionally empty body is required

There is no compatibility alias for the old input.

## Release-note modes

`notes` chooses the top-level generation mode or preset.

| Mode | Default source / behavior |
| --- | --- |
| `standard` | Commit-based, grouped human-readable notes. Default. |
| `compact` | Same commit evidence with a shorter `Changes` layout. |
| `conventional` | Same commit evidence grouped by Conventional Commit type. |
| `changelog` | Automatic Added / Changed / Deprecated / Removed / Fixed / Security-style layout. |
| `detailed` | Grouped layout with available body and author detail. |
| `scoped` | Group by Conventional Commit scope, then category. |
| `pull-requests` | Verified PR coverage; labels take precedence over Conventional PR titles. Uncovered released commits fail by default. |
| `hybrid` | Verified PR records plus released commits that are not covered by a verified PR, without duplicate fallback. |
| `github` | GitHub's native Generate Release Notes API. The returned Markdown body is preserved opaquely. |
| `file` | Use the exact UTF-8 contents of `notes-file`. |
| `none` | Publish an empty release body. |

The custom presets share one evidence and classification model. Changing only the render layout does not silently change the selected Git range.


### Preset gallery

The six custom layouts below use the same evidence so the difference is presentation, not collection:

```text
feat(config)!: replace option format
feat(cli): add validation command
fix(upload): handle paths with spaces
docs: clarify setup
```

| Preset | Shape from that common fixture |
| --- | --- |
| `standard` | `Breaking Changes`, `Features`, `Fixes`, `Documentation` |
| `compact` | `Breaking Changes` plus one `Changes` section |
| `conventional` | `Breaking Changes`, then sections named by commit type such as `feat`, `fix`, `docs` |
| `changelog` | `Breaking Changes`, then changelog-style `Added`, `Fixed`, and `Other Changes` |
| `detailed` | Standard grouping plus available source body text and author attribution |
| `scoped` | Scope headings such as `config`, `cli`, `upload`, and `Unscoped`, with categories nested below |

Breaking entries are shown once in the dedicated breaking section rather than duplicated in their ordinary category.

### Input combinations

| Combination | Result |
| --- | --- |
| `notes: file` + `notes-file` | valid; file is required |
| any non-`file` mode + `notes-file` | error |
| `notes: file` + `notes-config` | error |
| `notes: none` + `notes-config` | error |
| custom preset + `notes-config` | valid; config overrides the preset |
| `notes: github` + GitHub-only config | valid |
| `range.strategy` + `range.from` in one config | error |
| `unmatched: omit` with a source other than `pull-requests` | error |


### Default classification

The standard categories recognize these Conventional Commit types:

- `security` → Security
- `feat` → Features
- `fix` → Fixes
- `perf` → Performance
- `deprecated` / `deprecate` → Deprecations
- `removed` / `remove` → Removals
- `docs` → Documentation
- `deps` / `dependencies` → Dependencies
- `build`, `ci`, `chore`, `refactor`, `style`, `test` → Maintenance
- anything else → Other Changes

A `!`, `BREAKING CHANGE:`, or `BREAKING-CHANGE:` marker is tracked separately from the main category. PR mode also recognizes the configured breaking labels. A category choice never erases a breaking flag derived from covered commits.

## Configuration

Custom modes accept a versioned YAML or JSON file through `notes-config`. The file must resolve within `GITHUB_WORKSPACE` or `RUNNER_TEMP`, use `.yml`, `.yaml`, or `.json`, be at most 256 KiB, and have a maximum parsed depth of 16.

Example:

```yaml
version: 1
notes:
  source: hybrid

  range:
    strategy: previous-stable
    ancestry: reachable
    first-release: all

  classify:
    by: [labels, conventional]
    unknown: other
    breaking-labels: [breaking, breaking-change]
    categories:
      - id: features
        title: Features
        types: [feat]
        labels: [feature, enhancement]
      - id: fixes
        title: Fixes
        types: [fix]
        labels: [bug, fix]

  filter:
    exclude:
      types: []
      scopes: []
      labels: [skip-changelog]
      authors: []
      bots: false

  render:
    layout: standard
    authors: false
    comparison: true
```

Arrays replace preset arrays; they are not concatenated. Unknown keys, duplicate category IDs, invalid types, and unsupported combinations fail before publication.

The configurable axes are:

- `source`: `commits`, `pull-requests`, or `hybrid`
- `range.strategy`: `auto`, `previous-release`, `previous-stable`, or `previous-tag`
- `range.from`: exactly one explicit `tag` or `commit`; mutually exclusive with `strategy`
- `range.tag-pattern`: explicit family matching for non-SemVer tag schemes
- `range.ancestry`: `first-parent` or `reachable`
- `range.first-release`: `all`, `empty`, or `error`
- `classify.by`: `conventional` and/or `labels`
- `classify.unknown`: `other` or `error`
- `filter.exclude`: types, scopes, labels, authors, and bots
- `render.layout`: `standard`, `compact`, `conventional`, `changelog`, `detailed`, or `scoped`
- `render.authors` and `render.comparison`
- `unmatched`: `error` or `omit`, only for `source: pull-requests`

Commit-only sources cannot request label classification, label filtering, or bot filtering because those facts do not exist in commit evidence.

For `notes: github`, the configuration schema is intentionally narrower:

```yaml
version: 1
notes:
  github:
    previous-tag: v1.4.0
    configuration-file: .github/release.yml
```

`configuration-file` is a repository path understood by GitHub's native generator, not a Releaseway local template.

## Range selection

Custom generation resolves the target tag in an isolated evidence repository fetched from the caller's `origin`; it does not mutate caller refs or assume the checkout is positioned at the target commit. For private HTTPS checkouts, the checkout's HTTP authorization header is forwarded only to the isolated fetch subprocess and is not persisted in the evidence repository.

The default policy is:

```yaml
range:
  strategy: auto
  ancestry: first-parent
  first-release: all
```

Published GitHub Releases and ordinary Git tags are deliberately different inputs. `auto`, `previous-release`, and `previous-stable` select from published releases. `previous-tag` may select an unpublished tag.

Automatic selection is ancestry-aware. For `auto`, SemVer prerelease syntax, the requested `prerelease` state, and the prerelease flags of relevant published SemVer releases must agree; contradictory metadata fails instead of being silently reclassified. If eligible published releases exist but none lies on the requested target's first-parent ancestry, the action fails rather than silently treating the target as a first release. Choose `ancestry: reachable` or an explicit base when that is intentional. An unrelated explicit base is rejected.

For a first release with no eligible base, `first-release: all` includes all target-reachable history, `empty` intentionally produces no changes, and `error` requires the caller to specify a base.

Typical `auto` examples:

- stable `v1.2.0` after published `v1.1.0` → base `v1.1.0`;
- `v1.3.0-beta.2` after published `v1.3.0-beta.1` → base `v1.3.0-beta.1`;
- maintenance `v1.0.2` on the `v1.0.x` first-parent line → nearest published ancestor such as `v1.0.1`, not a newer release on another branch;
- first stable release with only earlier prereleases in its family → first-release policy applies rather than silently using the last prerelease.

Commit-based presets infer display meaning from commit messages and Git history. They do not inspect code semantics, changed paths, issue text, or runtime behavior, and they do not invent migration guidance or impact claims.

## Pull-request and hybrid evidence

PR modes start from the exact released commit set. For each selected commit the action asks GitHub which PR numbers are associated with it, then hydrates each PR's merged landing identity and metadata before assigning coverage.

A PR is used only when it is actually merged and its verified landing commit is inside the released range. Open or closed-unmerged associations are ignored for coverage. Ambiguous merged associations stay uncovered; title similarity is never used as identity.

`pull-requests` defaults to `unmatched: error`. With `unmatched: omit`, the body includes an explicit notice and the diagnostics report records the omitted commit identities. `hybrid` keeps uncovered commits as commit records instead.

PR labels can choose the primary category, while breaking/security/deprecation/removal facts from covered commits remain preserved independently.

## Existing release bodies

`notes-existing` controls what happens when the release already exists.

| Policy | Existing draft | Existing published release |
| --- | --- | --- |
| `auto` | Prepare the requested body and require an exact match before resuming. | Preserve the existing body without regeneration. |
| `verify` | Prepare the requested body and require an exact match. | Prepare the requested body and require an exact match. |
| `preserve` | Preserve the observed body and verify it does not change during the run. | Preserve the observed body and verify it does not change during the run. |

No policy automatically overwrites an existing release body.

Release title handling is separate from the body policy. New releases and existing drafts use the explicit `title` or the tag when it is omitted. For an already published release, an explicit `title` must match; when `title` is omitted, the existing published title is preserved.

For new publication, the prepared body is passed to the draft and verified again after publication. Exact comparisons preserve trailing-newline semantics.

## Preview

`notes-preview: "true"` prepares release notes and the diagnostics report without creating/updating a release or uploading/validating assets.

```yaml
- name: Preview release notes
  id: notes
  uses: releaseway/actions@<full-commit-sha>
  with:
    tag: v1.5.0
    commit: <full-40-character-sha>
    notes: compact
    notes-preview: "true"
```

`tag` and `commit` are still required, and the remote tag must already exist. Preview returns `state: preview` and an empty `release-url`.

## File notes

File mode is explicit:

```yaml
with:
  tag: v1.5.0
  commit: <full-40-character-sha>
  notes: file
  notes-file: dist/release-notes.md
```

The file must contain valid UTF-8. Its byte-level newline choice is preserved. `notes-file` with any other mode is rejected.

## Permissions

The action uses the caller's `github.token` by default.

| Evidence/provider | Available metadata | Important limitation |
| --- | --- | --- |
| commit presets | full commit message, SHA, commit author, Git ancestry | no PR labels/bot identity; semantics come from messages |
| `pull-requests` | verified PR identity, title/body, labels, author, covered commits | every released commit must be covered unless `unmatched: omit` is explicit |
| `hybrid` | verified PR metadata plus uncovered commit evidence | uncovered entries have only commit metadata |
| `github` | GitHub Generate Release Notes result | formatting/classification is GitHub-owned and opaque to Releaseway |
| `file` / `none` | caller-provided bytes / empty body | no automatic change evidence is collected |

| Operation | Minimum repository permissions |
| --- | --- |
| Custom commit-only preview | `contents: read` |
| PR/hybrid preview | `contents: read`, `pull-requests: read` |
| GitHub-native preview/generation | `contents: write` |
| Publication | `contents: write` |
| Publication using PR/hybrid notes | `contents: write`, `pull-requests: read` |

GitHub's Generate Release Notes API requires Contents write permission even though generation itself does not save a release.

If the release target adds or modifies files under `.github/workflows/` relative to the repository's default branch, GitHub's release APIs additionally require workflow-write authorization. The Actions `GITHUB_TOKEN` cannot be granted that permission. Pass `token` backed by a credential authorized for both repository contents and workflows when needed.

The checked-out repository must resolve to the same `owner/name` as `GITHUB_REPOSITORY`.

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `tag` | yes | — | Existing remote Git tag to publish or preview. |
| `commit` | yes | — | Full 40-character commit SHA the remote tag must resolve to. |
| `assets` | no | empty | Newline-separated file paths or glob patterns. Every supplied pattern must match at least one regular file. |
| `upload-concurrency` | no | `1` | Maximum simultaneous asset uploads, from `1` to `8`. Start with `4` when testing overlapping transfers; choose a value from measurements of your files and network. |
| `title` | no | tag | Release title. Independent of notes mode. |
| `notes` | no | `standard` | Release-note preset/mode listed above. |
| `notes-config` | no | empty | Explicit versioned YAML/JSON policy file. |
| `notes-file` | no | empty | Body file, required only for `notes: file`. |
| `notes-existing` | no | `auto` | `auto`, `verify`, or `preserve`. |
| `notes-preview` | no | `false` | Prepare notes/report without release mutation. |
| `prerelease` | no | `false` | Publish as a prerelease. |
| `latest` | no | `automatic` | `automatic`, `true`, `false`, or `current-series`. |
| `release-config` | no | `.github/releaseway.yml` | Version-series policy for `latest: current-series`. |
| `token` | no | caller `github.token` | Explicit GitHub token override. |

A prerelease cannot use `latest: "true"`.

## Outputs

| Output | Meaning |
| --- | --- |
| `state` | `created`, `resumed-draft`, `existing`, or `preview`. |
| `release-url` | Published GitHub Release URL; empty in preview mode. |
| `notes-path` | Local path to the exact prepared or preserved Markdown body. |
| `notes-report` | Local path to the versioned JSON diagnostics report. |
| `notes-state` | `prepared` in preview, `verified` when requested body equality was established, or `preserved` when an existing body was intentionally retained. |

The report records its preparation status, the effective policy, configuration path/digest plus caller checkout revision when a config is used, selected range, included/excluded identities, diagnostics, metadata-mutability flags, and final body SHA-256/byte length for custom generation. `notes-state` remains the authoritative lifecycle outcome after publication verification.

## Release lifecycle guarantees

Every publishing invocation verifies that the remote tag resolves to the requested commit and that the checked-out repository identity matches `GITHUB_REPOSITORY`.

For a new release, the action creates a draft with the prepared body, uploads requested assets, verifies the exact asset set and SHA-256 digests, re-verifies the remote tag, publishes the draft, verifies immutability, verifies the final body, and checks the final asset set again.

Uploads run in bounded batches when `upload-concurrency` exceeds `1`. Each batch waits for its slowest upload before the next batch starts. A failed batch stops publication after every started upload finishes and leaves completed files in the draft; a retry verifies their digests and uploads only missing files. A GitHub upstream failure can leave an empty asset in `starter` state. The action rejects incomplete assets; inspect and remove that incomplete draft asset before retrying. Upload, asset verification, publication and final verification durations and exit statuses appear in ordinary logs and the Actions job summary, including failed phases. Successful publication and verification produce no notice annotations; errors remain error annotations.

An existing draft is resumed only when prerelease state, requested title, notes policy, and assets are compatible. An existing published release is accepted only when its tag target, prerelease state, immutability, requested asset set, and requested existing-body policy all pass.

If another invocation creates, uploads, or publishes concurrently, the action rereads state and accepts the result only when it satisfies the same requested invariants.

The action never retargets a tag, deletes or replaces an existing asset, uses `--clobber`, or automatically rewrites editorial release content.

Immutable releases are a repository prerequisite; this action does not enable the repository setting.

## Bounded execution

The current implementation deliberately bounds external evidence work:

- each notes-engine Git subprocess has a 30-second timeout;
- each notes-engine GitHub CLI/API subprocess has a 30-second timeout;
- GitHub list/association reads use at most 20 pages of 100 records each;
- one custom release range may contain at most 10,000 commits;
- a prepared release-note body may contain at most 1 MiB of UTF-8 text;
- `notes-config` is limited to 256 KiB and parsed depth 16.

Exhausted pagination, invalid evidence, missing permissions, or ambiguous range selection are errors rather than silent truncation.

## Releases without assets

Omit `assets` when no binaries are needed. The same provenance, notes, immutability, and idempotency checks still apply.

```yaml
- name: Publish automation release
  uses: releaseway/actions@<full-commit-sha>
  with:
    tag: ${{ inputs.tag }}
    commit: ${{ steps.release.outputs.commit }}
    notes: standard
    latest: "true"
```

## Development

The deterministic validation suite is:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run check:dist
python3 test/release.py
python3 test/release-evidence.py
git diff --check
```

CI runs the packaged checks on Ubuntu and macOS.

Live black-box acceptance lives in `releaseway/release-fixture`. It validates the exact candidate action SHA against real GitHub range/native/PR behavior and an immutable publication + rerun campaign before release readiness.

The repository release workflow requires `acceptance-runs` for a successful
`suite=all` fixture run and latest successful push CI at the tag's exact SHA. It also
checks the tagged action's typecheck, unit, dist and lifecycle behavior. See the
[candidate guide](https://github.com/releaseway/release-fixture#candidate-release-readiness)
for artifact retention, read permissions and retries.

## Version series and release preparation

The `prepare` subaction owns version calculation, release marker commits, Git tags, atomic pushes, and resumable plans. Keep product build/test steps in your workflow and publication policy in `.github/releaseway.yml`:

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

The first release after this boundary is exactly `v1.2.0`, even if the old series has larger versions. Subsequent tags with the same prefix after the boundary and reachable from the source form the current series. Tags at or before the boundary are preserved and excluded. Use a distinct prefix for independently maintained series on overlapping history. A collision with any historical tag fails; tags are never retargeted. Without `series`, reachable tags supply the version baseline, with `initial-version: 0.1.0` for an empty history.

`bump: auto` uses Conventional Commits since the previous current-series tag: breaking changes increment major, features increment minor, and other changes increment patch. `patch`, `minor`, and `major` select an explicit increment. An optional `prerelease-id` such as `rc` starts `.0`, increments matching prereleases, and promotes the core version when a later source is prepared without a prerelease identifier.

```yaml
permissions:
  contents: write
concurrency:
  group: release-main
  cancel-in-progress: false
steps:
  - uses: actions/checkout@<full-commit-sha>
    with:
      fetch-depth: 0
  - id: release
    uses: releaseway/actions/prepare@<full-commit-sha>
  - run: ./build-product.sh "${{ steps.release.outputs.version }}"
  - uses: releaseway/actions@<full-commit-sha>
    with:
      tag: ${{ steps.release.outputs.tag }}
      commit: ${{ steps.release.outputs.commit }}
      prerelease: ${{ steps.release.outputs.prerelease }}
      latest: ${{ steps.release.outputs.latest }}
      assets: dist/*
```

Preparation writes a deterministic release marker commit using the source tree unchanged, then pushes the branch and lightweight tag as one atomic transaction. The checkout remains at the source; build output uses the returned version. Checkout credentials need branch/tag write access and full history. Branch protection and servers without atomic push support fail without a partial push; the action does not bypass their policy. Serialize preparation and publication with one branch-level concurrency group, including prereleases. GitHub latest selection has no compare-and-swap API, so serialization is required to prevent concurrent publication races.

`mode: plan` returns the version, tag, source, commit, prerelease, latest policy, and `plan-path` without changing remote refs. The saved JSON is inspectable and can be retained as a workflow artifact. `mode: resume` with `plan-path` requires checkout of the saved source or its marker commit and validates configuration, source and generated commit against fresh origin state before retrying. Failed pushes leave the plan available; matching remote refs are accepted after transport ambiguity. Changed branch state or conflicting tags fail rather than overwriting another writer. Calling `prepare` again at the same source or its release marker resumes the same release; start a later release from a new source commit. A failed build can therefore rerun preparation and resume the existing GitHub draft. There is no destructive rollback of published refs or artifacts.

`mode: resolve` accepts an existing stable `tag` and optional `branch`, verifies its remote binding and branch ancestry, and returns `tag`, `version`, `commit`, and `target` without requiring a configuration file. Release workflows use this instead of repeating shell tag validation.

`mode: tag` creates or verifies a versioned `tag` bound to an explicit full `commit` SHA on the configured origin `branch`. It accepts custom prefixes and prereleases for companion native artifact releases, without adding a marker commit or changing the branch. A conflicting tag fails and a matching tag is accepted on retry. Neither resolve nor tag mode requires a release configuration file.

`latest: current-series` selects the newest stable tag in the configured series regardless of older series' numerical versions. Prereleases and superseded current-series tags are not promoted. The policy is checked before draft creation and again before publication and final verification. `latest: true` remains an unconditional stable-release policy; `automatic` retains GitHub's legacy selection.

## License

MIT
