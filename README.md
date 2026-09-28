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

Custom generation resolves the target tag in an isolated evidence repository fetched from the caller's `origin`; it does not mutate caller refs or assume the checkout is positioned at the target commit.

The default policy is:

```yaml
range:
  strategy: auto
  ancestry: first-parent
  first-release: all
```

Published GitHub Releases and ordinary Git tags are deliberately different inputs. `auto`, `previous-release`, and `previous-stable` select from published releases. `previous-tag` may select an unpublished tag.

Automatic selection is ancestry-aware. If eligible published releases exist but none lies on the requested target's first-parent ancestry, the action fails rather than silently treating the target as a first release. Choose `ancestry: reachable` or an explicit base when that is intentional. An unrelated explicit base is rejected.

For a first release with no eligible base, `first-release: all` includes all target-reachable history, `empty` intentionally produces no changes, and `error` requires the caller to specify a base.

## Pull-request and hybrid evidence

PR modes start from the exact released commit set. For each selected commit the action asks GitHub which PR numbers are associated with it, then hydrates each PR's merged landing identity and metadata before assigning coverage.

A PR is used only when its verified landing commit is inside the released range. Ambiguous associations stay uncovered; title similarity is never used as identity.

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
| `title` | no | tag | Release title. Independent of notes mode. |
| `notes` | no | `standard` | Release-note preset/mode listed above. |
| `notes-config` | no | empty | Explicit versioned YAML/JSON policy file. |
| `notes-file` | no | empty | Body file, required only for `notes: file`. |
| `notes-existing` | no | `auto` | `auto`, `verify`, or `preserve`. |
| `notes-preview` | no | `false` | Prepare notes/report without release mutation. |
| `prerelease` | no | `false` | Publish as a prerelease. |
| `latest` | no | `automatic` | `automatic`, `true`, or `false`. |
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

The report records the effective policy, selected range, included/excluded identities, diagnostics, and final body SHA-256/byte length for custom generation.

## Release lifecycle guarantees

Every publishing invocation verifies that the remote tag resolves to the requested commit and that the checked-out repository identity matches `GITHUB_REPOSITORY`.

For a new release, the action creates a draft with the prepared body, uploads requested assets, verifies the exact asset set and SHA-256 digests, re-verifies the remote tag, publishes the draft, verifies immutability, verifies the final body, and checks the final asset set again.

An existing draft is resumed only when prerelease state, requested title, notes policy, and assets are compatible. An existing published release is accepted only when its tag target, prerelease state, immutability, requested asset set, and requested existing-body policy all pass.

If another invocation creates, uploads, or publishes concurrently, the action rereads state and accepts the result only when it satisfies the same requested invariants.

The action never retargets a tag, deletes or replaces an existing asset, uses `--clobber`, or automatically rewrites editorial release content.

Immutable releases are a repository prerequisite; this action does not enable the repository setting.

## Bounded execution

The current implementation deliberately bounds external evidence work:

- each Git subprocess has a 30-second timeout;
- GitHub list/association reads use at most 20 pages of 100 records each;
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
git diff --check
```

CI runs the packaged checks on Ubuntu and macOS.

Live black-box acceptance lives in `releaseway/release-fixture`. It validates the exact candidate action SHA against real GitHub range/native/PR behavior and an immutable publication + rerun campaign before release readiness.

## License

MIT
