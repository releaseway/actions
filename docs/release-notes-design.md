# Release notes: selected design and implementation plan

Decision date: 2026-09-28 (Asia/Seoul).
Repository: `releaseway/actions`.
Reviewed code baseline: `49c543357d96884d0e5a683c45d45ebd50a8b612`.
Status: selected design, NOT implemented or released.

The user delegated the remaining design decisions to the assistant after explicitly authorizing removal of the old input without a compatibility period. This document is the canonical execution design. Selection here does not authorize implementation, commits, a version bump, publication, or changes to other repositories. The companion [discussion record](release-notes-design-review.md) retains the verified old baseline and decision provenance, not competing active proposals.

## 1. Product decisions

Provide a useful automatic default, several genuinely different presets, and independent declarative overrides. Do not require PRs or Conventional Commits to get a nonempty change list. Do not generate editorial claims from sparse metadata.

The default is `notes: standard`: local Git commit evidence, Conventional Commits classification with a visible fallback, grouped human-readable Markdown, explicit breaking-change notices, and a comparison link. The default does not query PRs, infer PR ownership from commit subjects, or require PR-read permission. This replaces the earlier hybrid-default proposal deliberately: source completeness and predictable operation are more valuable in the default path than automatic PR enrichment.

PR-centric teams can select `pull-requests` or `hybrid`, or override `source` while keeping another layout. GitHub-native generation remains an explicit alternative. Those choices must not silently activate based on whether a token happens to have more permissions.

`standard` is the Releaseway default, not the name of an industry-standard release-note algorithm. Conventional Commits supplies message semantics; Keep a Changelog supplies a different, human-curated organizational convention. Neither defines the whole generator. [S1][S2]

No owner decision remains blocked. Algorithm correctness, provider behavior, runtime packaging, and the acceptance matrix are implementation gates, not claims that the unimplemented feature has already passed.

## 2. Public inputs and content selection

Keep the existing tag, commit, assets, title, prerelease, latest, and token responsibilities. The selected notes inputs are:

| Input | Default | Contract |
| --- | --- | --- |
| `notes` | `standard` | One preset/provider/content mode from the catalog below. Omitted or trimmed-empty values use `standard`. Other values are case-sensitive. |
| `notes-config` | empty | Explicit path to a versioned YAML or JSON configuration. No automatic file discovery. |
| `notes-file` | empty | Required only for `notes: file`; the complete caller-supplied release body. |
| `notes-existing` | `auto` | Body policy for an already existing release: `auto`, `verify`, or `preserve`. See section 8. |
| `notes-preview` | `false` | Prepare notes and a diagnostics report without creating/updating a release, publishing, or uploading assets. |

Remove the public `generate-notes` declaration, environment forwarding, parser, aliases, compatibility-only tests, and supported examples. Do not retain deprecation declarations, old boolean meanings, or dual-input conflict branches. `notes: true` and `notes: false` are invalid, not aliases. Removal of this public input does not remove GitHub's native generation API.

A file is an explicit content mode rather than an implicit override of a default:

```yaml
with:
  notes: file
  notes-file: dist/release-notes.md
```

`notes: file` without a file is an error. A file with any other mode, including `none` or an omitted selector, is an error. `notes: none` means an empty requested body, not merely disabling generation. A generated preset plus a file does not concatenate content. These rules allow a real metadata default of `standard` without omission detection or precedence tricks.

`notes-existing` is a lifecycle choice, not something a formatting preset or repository configuration changes. Preview always prepares the requested result even when an existing release would normally be preserved, and reports that distinction.

A concise breaking-change guide explains how to rewrite workflows; there is no compatibility runtime. No release number is selected in this document.

## 3. Preset catalog

The initial catalog is selected for materially different uses, not as a permanent maximum:

| `notes` | Source/classification default | Presentation and purpose |
| --- | --- | --- |
| `standard` | commits / conventional | Familiar sections with plain descriptions and scope prefixes. General-purpose default. |
| `compact` | commits / conventional | Breaking notices plus a short change list; no verbose attribution or body expansion. Does not silently discard changes. |
| `conventional` | commits / conventional | Group by Conventional Commit type, retaining type/scope semantics. Custom types remain visible. |
| `changelog` | commits / conventional | Added, Changed, Deprecated, Removed, Fixed, Security vocabulary, plus an honest Other Changes fallback. Changelog-style output, not a claim of human curation. |
| `detailed` | commits / conventional | Standard sections plus supplied body/breaking descriptions, full references and optional attribution. Never invents migration prose. |
| `scoped` | commits / conventional | Group by explicit scope, then change category; unscoped changes remain visible. Does not infer component ownership from file paths. |
| `pull-requests` | pull-requests / labels then conventional | One verified released PR per entry, standard layout. Uncovered released commits are an error by default, not silently omitted. |
| `hybrid` | hybrid / labels then conventional | Verified PR entries plus uncovered commit entries; standard layout. |
| `github` | GitHub native | Opaque GitHub-generated body using its own configuration contract. |
| `file` | supplied file | Caller-authored body. |
| `none` | no collection | Empty requested body. |

The eight Releaseway-generated presets use one shared evidence model and renderer pipeline. `source` and `render.layout` are independently overridable. For example, `notes: compact` can use `source: hybrid` without needing another preset. There is no redundant `grouped` alias for `standard`, no `custom` sentinel, and no combination-name explosion.

All custom layouts preserve the same selected record set unless a user explicitly configures a filter. Breaking entries are promoted to a top-level notice once; other groups do not duplicate them. Scope information is retained when a breaking entry is promoted out of a scoped group. Empty groups are omitted. Compactness never means dropping a breaking marker or cutting a list without disclosure.

The source choice is not hidden in rendering: the gallery and diagnostics name both the preset and effective source. Changing to the explicitly PR-based presets can change entry units, and that difference is documented.

## 4. Configuration and inheritance

`notes-config` is opt-in and reads the caller-selected local file from the caller checkout, not the action installation directory. The example path `.github/releaseway.yml` is a convention only; it is not discovered. A checkout at a different commit can therefore intentionally supply policy for a release target. Record the configuration origin, checkout revision when available, and content digest; do not claim this file necessarily belongs to the release target.

Relative paths resolve against `GITHUB_WORKSPACE`; explicit absolute input paths are accepted within `GITHUB_WORKSPACE` or `RUNNER_TEMP`. Resolve real paths and reject nonregular files or escapes from those roots. No recursive includes, remote configuration, environment expansion, executable expressions, or shell hooks. Callers producing a configuration elsewhere must place it in a declared root before invocation.

Configuration has `version: 1` and a `notes` mapping. It cannot select a second preset. Resolution is selected preset defaults followed by configuration field overrides. Objects merge by field; arrays replace; a concrete `false` overrides `true`; an empty list clears a list. `null`, unknown keys, duplicate YAML keys, invalid types, and unsupported provider combinations are errors. YAML is data-only with bounded size/depth and aliases disabled. JSON is accepted with the same schema.

A representative selected configuration:

```yaml
version: 1
notes:
  source: hybrid
  range:
    strategy: auto
    tag-pattern: "v*"
    ancestry: first-parent
    first-release: all
  classify:
    by: [labels, conventional]
    unknown: other
  filter:
    exclude:
      labels: [skip-changelog]
      types: []
      scopes: []
  render:
    layout: compact
    authors: false
    comparison: true
```

For custom generation, the supported axes are:

| Axis | Selected choices |
| --- | --- |
| `source` | `commits`, `pull-requests`, `hybrid` |
| `range` | `strategy` or explicit `from`, tag-family filter, ancestry, first-release policy |
| `classify.by` | Ordered unique list of `conventional` and/or `labels`; empty means unclassified. User-defined category matches are evaluated in that order. |
| `classify.unknown` | `other` (default), `error` |
| `classify.categories` | Ordered records with unique `id`, `title`, `types`, and `labels`; supplying the list replaces the preset list. An unmatched fallback always exists unless strict error is selected. |
| `classify.breaking-labels` | Exact label strings adding breaking status. They cannot erase a conventional breaking flag. |
| `filter.exclude` | Exact type, scope, label and author identifiers; bot exclusion only with authoritative PR account metadata. No exclusion by default. |
| `render.layout` | `standard`, `compact`, `conventional`, `changelog`, `detailed`, `scoped` |
| `render.authors` | Boolean; default false except detailed. No email addresses are rendered. |
| `render.comparison` | Boolean; default true. |

A category's `types` or `labels` list uses exact normalized type or exact label identifiers, not executable regex. First matching category for the first applicable classifier supplies the primary category. Conflicting primary matches produce a diagnostic describing the selected rule. Breaking/security/removal/deprecation facts are tracked independently; section placement does not erase those facts. The implementation must publish the complete schema and built-in category table with executable examples, rather than treating this table as a permissive arbitrary-object schema.

PR-only selection additionally supports `unmatched: error | omit`, default `error`. `omit` explicitly acknowledges a partial PR-only view and discloses omitted commit counts in the body and report. Hybrid does not use this option because it retains uncovered commits. Label/PR-author/bot settings with commit-only collection are configuration errors, not a reason to fetch PRs silently. Source-independent author display in commit mode uses the Git author display name as literal text, not an inferred GitHub handle.

Configuration for `github` accepts only a `notes.github` mapping with optional `previous-tag` and `configuration-file` (server-side repository path). Custom `source`, `range`, `classify`, `filter`, and `render` keys are rejected there. `file` and `none` reject a nonempty `notes-config`, because they have no generation policy to configure. Lifecycle knobs remain action inputs and work in every mode.

Initial scope deliberately excludes arbitrary template execution, path ownership inference, path filtering, first-time-contributor history, automatic revert cancellation, and an LLM summarizer. Existing layouts plus custom categories supply meaningful customization; fully bespoke prose is supported through file mode. These exclusions avoid false completeness/curation claims, not an architectural ban on later extensions.

## 5. Range and history contract

### 5.1 Defaults and available policies

The custom default is `range.strategy: auto`. Its base is an eligible previously published release, not simply the highest version, most recently published object, `releases/latest`, or the most recent tag whether published or not. This avoids losing changes when an intermediate tag was never released.

Other selectable strategies are `previous-release` (any published channel), `previous-stable` (published stable only), and `previous-tag` (matching remote tags, whether published or not). An explicit base uses exactly one of:

```yaml
version: 1
notes:
  range:
    from:
      tag: v1.4.2
```

```yaml
version: 1
notes:
  range:
    from:
      commit: "0123456789abcdef0123456789abcdef01234567"
```

Explicit `from` replaces automatic strategy defaults; a config that itself supplies both `from` and `strategy` is invalid. Branch names are not accepted as bases. Resolve tags through the remote and pin full commit SHAs. A base must be an ancestor of the target or the target itself; unrelated/divergent bases are rejected. An intentional equal-SHA base produces an empty range.

### 5.2 Family, channel, ancestry, ordering

Infer a tag family only when a target has a unique strict SemVer suffix: its exact leading prefix identifies the family. Thus plain, `v`-prefixed, and component-prefixed versions are not mixed automatically. Do not coerce an arbitrary tag into SemVer. Non-SemVer automatic selection requires an explicit `tag-pattern`; callers can always use an explicit base instead. `tag-pattern` uses a documented bounded glob grammar and must match the target. An explicit pattern replaces automatic family inference, making cross-prefix use intentional.

`auto` for a stable target skips prereleases and selects a prior stable release. For a SemVer prerelease target, first consider earlier published prereleases of the same major/minor/patch and first prerelease identifier; if none qualify, use a prior stable release. A first beta and a first RC can therefore be cumulative from stable, while later beta/RC releases can be incremental. `previous-release` is available for callers wanting cross-channel increments. Release prerelease flags and parsed version information are both recorded; contradictory classification in an automatic channel decision fails with an actionable request for explicit policy/base rather than silently guessing.

When versions are comparable, automatic candidates must have lower precedence than the target. Always exclude the current tag and drafts. Default `ancestry: first-parent` selects candidates whose commits lie on the target's first-parent chain, ordered by nearest chain distance. This prevents a second-parent branch's release from automatically becoming the target branch's baseline. The first-parent restriction selects the base only; it does not exclude side-branch commits from the change set. Git distinguishes first-parent traversal from ordinary reachability. [S9]

For same-commit candidates, choose the highest eligible SemVer precedence and then bytewise tag-name order for equivalent aliases. Non-SemVer aliases on one commit use bytewise tag-name order. Diagnostics disclose the chosen alias. Selection must not depend on wall-clock release-list order.

Selectable `ancestry: reachable` considers all ancestor candidates and chooses a unique maximal candidate commit under ancestry. Incomparable maximal candidates are ambiguous and require an explicit base, rather than an arbitrary date tie-break. Same-commit alias rules still apply.

### 5.3 First release and complete history

`first-release: all` is the default: include all target-reachable history, including root commits. Alternatives are `empty` (intentional empty initial notes with a visible explanation) and `error` (require an explicit base). Apply first-release policy only after successful, complete candidate discovery. A first stable release with only earlier prereleases in its family is intentionally a first release of that stable baseline: default to all history rather than silently using the last prerelease or failing merely because prereleases exist. If otherwise eligible prior releases exist but are excluded solely because they lie off the selected first-parent line, or reachable candidate selection is ambiguous, report that condition instead of disguising it as an initial release. Channel-ineligible releases do not by themselves make first-release selection ambiguous.

A private-repository permission error, missing remote tag object, failed page, or shallow history is never equivalent to no previous release. A fresh repository with no releases is not a reason to select an unpublished tag under the default strategy.

Custom change evidence is the set of commits reachable from target and not reachable from base; for first-release all it is the target-reachable set. Use local Git object evidence, including full commit messages. Fetch needed history/tags into an isolated temporary Git object store from the already verified origin; do not checkout another revision, force-update caller tags/branches, alter the index, or require the caller to have anticipated a particular fetch depth. Reverify remote tag binding before publication.

Fetch cost and history size are bounded and diagnosed. Preserve complete evidence or fail; do not quietly publish the first page. The target, base, selected tag family/channel, candidate reasons, and history completeness enter the report. Automatic base discovery can change when people add/delete old releases; only an explicit base pins that choice across future runs.

## 6. Evidence, collection, and classification

### 6.1 Commit default

Collect the complete range before presentation filtering. One nonmerge commit is one default record. Omit ordinary merge-summary entries as transport noise only after collecting their ancestor work; a merge commit with a recognized Conventional Commit header or any explicit breaking marker remains a visible record. Record every omission and reason. This is a message-based release-note generator, not a claim that it has semantically summarized every code change or independently detected all merge-resolution edits.

Do not discard `docs`, `chore`, dependency updates, bots, unknown messages, or custom types by default. Standard groups supporting changes separately instead. Nonconforming messages become Other Changes. A user selecting strict classification can require conforming evidence. Do not remove revert/original pairs based on titles; show the available records and references.

For deterministic ordering, topologically order the selected commits with parents before descendants and full-SHA byte ordering for ready-node ties. Carry that ordinal into grouping; PR records use the earliest covered ordinal. Rendering does not use the current date, unstable API order, or locale-dependent sorting.

### 6.2 PR and hybrid modes

Start from the same Git commit range, not PR merge dates. Build identities from repository plus PR number or full commit SHA. Paginate commit-to-PR associations and any needed PR detail/commit endpoints. Require merged state, correct repository context, and evidence of landing in the released history; an association is not enough. GitHub can return open as well as merged PRs for certain commit associations. [S6]

Coverage is conservative and explicit:

- For merge/squash landings, require a verified landing commit in the released range and use exact Git/PR identities, not title matching. For an ordinary merge, compute the newly introduced side history relative to its first parent and intersect with the release range.
- For rebase landings, accept only exact released commit identities and verified landing evidence. Pre-rebase SHAs or similar messages are not substitutes for proof. Partial or overlapping coverage must remain diagnosed rather than being promoted to a complete PR unit.
- A cherry-picked change whose original PR did not land on this released history remains a commit unless exact released-branch PR evidence establishes coverage. Do not misattribute an original upstream PR as the released backport PR.
- When one complete, nonconflicting PR unit cannot be established, retain its released commits in hybrid. PR-only default fails on such uncovered evidence; explicit `unmatched: omit` discloses the omission.

Build coverage before exclusion. Excluding a PR excludes its proven covered commits from hybrid fallback. Filters operate on normalized release entries: type/scope filters on a PR entry use that entry's primary type/scope, not a hidden per-commit partial removal inside the PR. Label/author filters use the proven PR metadata; uncovered commit entries use their own available fields. These are note-entry filters, not a claim to remove selected code changes from a PR. Classify safety-relevant flags on released evidence before coalescing into a PR entry, so a PR's display title cannot erase a breaking marker in its included commits. Metadata from unreleased PR commits cannot add facts to this release.

API failures remain failures even in hybrid; uncertainty in identity coverage is different from inability to finish collection. No 403/404/rate-limit fallback to a different source. The exact supported merge/rebase cases require provider-shaped fixtures and controlled integration checks before the PR presets are advertised as available.

### 6.3 Meaning and display

Conventional parsing follows version 1.0.0, including scopes, case-insensitive nonbreaking tokens, `!`, bodies, multiline footers, uppercase `BREAKING CHANGE`, and the `BREAKING-CHANGE` alias. `feat` and `fix` are standardized meanings; mappings for other types are Releaseway conventions and customizable. [S1]

Primary category, type, scope, breaking flag/text, security, deprecation, removal, attribution, and source references are separate fields with provenance. `feat!` does not mean removal. A generic `fix` does not prove a security change. Explicit `security`, `deprecated`, and `removed` type/label rules can supply those categories; unknown evidence remains visible rather than being guessed.

The standard section order is Breaking Changes, Security, Features, Fixes, Performance, Deprecations, Removals, Documentation, Dependencies, Maintenance, Other Changes. Built-in mappings include `feat`, `fix`, `perf`, `docs`, `deps`, and maintenance types `build`, `ci`, `chore`, `refactor`, `style`, `test`; custom types fall back unless configured. Plain `revert` is not silently canceled or classified as a fix.

For label-first modes, explicit matching labels select the category before conventional metadata. Category precedence never clears independently captured breaking status. User filters can explicitly exclude a breaking record; the report and visible diagnostics must identify that fact. No built-in preset excludes breaking records as a side effect of formatting.

Changelog layout maps known category meaning to its six established headings. Documentation, tests, ambiguous custom changes, and other unmapped evidence go to Other Changes rather than pretending every entry is an Added or Changed product feature. Breaking notices remain independently prominent. Keep a Changelog describes a curated log; this output is described as changelog-style automatic notes only. [S2]

Do not infer highlights, migration steps, security severity, performance figures, or user impact from titles. Detailed mode can show supplied explanations as attributed source text, never as assistant-authored conclusions.

## 7. Native provider, rendering, and prepared output

For `github`, call Generate Release Notes first, then publish its returned body with the explicitly selected title. Its generated `name` is not used. Its Markdown is opaque: no heading parsing, custom grouping, automatic footer injection, or provenance marker. If `previous-tag` is supplied, verify the tag exists and belongs to the intended repository; arbitrary commit bases and local uncommitted GitHub configuration files are unsupported. Without these settings, GitHub chooses its native range and configuration behavior. Its dedicated endpoint exposes `previous_tag_name` and `configuration_file_path`; they are not fields on the current Create Release call. [S5]

A prepared body is sent once with native generation disabled in the subsequent Create Release request. Do not both supply a generated body and ask GitHub to generate again. Native generation returns content without saving a release, but its documented fine-grained permission is Contents write; a native preview is mutation-free for release state, not necessarily read-permission-only. [S5]

Custom output is UTF-8 Markdown with LF endings and exactly one final LF when nonempty. A file or native body is preserved as its decoded valid UTF-8 text without automatic whitespace trimming, BOM removal, Unicode normalization, or newline rewriting. Reject invalid UTF-8 and unsupported control data. Equality compares the actual requested text with the decoded API body, including trailing newlines, outside shell command substitution. Tests must check provider round-tripping rather than assume all text is normalized by GitHub.

Escape untrusted titles, names, scopes, and source descriptions as literal Markdown text; create links only from validated repository/PR/commit identities. Never construct executable shell text from source values. Comparison links use pinned base/target SHAs while showing readable tag labels. For an initial all-history release, use a target history link, not a fictitious prior tag or root-parent comparison. Empty custom results say that no matching changes were found; an intentionally empty first release is distinguished. File/none/native modes are not rewritten with that message.

Prepare `notes.md` and `notes-report.json` under an invocation-specific runner temporary directory. Report preset, effective policy, configuration digest/origin, target/base SHAs, range decisions, included/excluded/covered record identities and reasons, known metadata mutability, body digest, and validation status. Do not dump authentication headers, tokens, commit emails, or full unrelated API responses.

Expose `notes-path`, `notes-report`, and `notes-state` outputs in addition to existing release outputs. `notes-state` is `prepared` for preview, `verified` when actual requested bytes have been compared successfully, and `preserved` when existing remote text was deliberately accepted without regeneration/provenance verification. For preserved output, `notes-path` contains the observed body, and the report must not invent a freshly resolved range or matching generation digest. The report schema is versioned.

These files are local outputs, not automatically uploaded artifacts, release assets, or a durable checkpoint service. A caller can retain `notes-path` and later use file mode to replay exact content. A digest is a reproducibility aid, not an authenticity signature.

## 8. Existing releases, retries, title, and races

Do not build a mandatory snapshot store, hidden body marker, or hidden release asset. Use explicit non-destructive behavior:

| `notes-existing` | Existing draft observed at invocation start | Existing published release observed at invocation start |
| --- | --- | --- |
| `auto` (default) | Prepare requested body and require exact equality before resuming. | Preserve observed body without regeneration; report `preserved`. |
| `verify` | Prepare and require equality. | Prepare and require equality; never rewrite on mismatch. |
| `preserve` | Explicitly accept the existing body, even an empty one, without claiming generated provenance. | Preserve existing body. |

New releases always prepare/validate their requested body before draft creation. The selected mode and file/config combinations are validated even on a preservation path, but unused generation evidence, file contents, and PR data need not be fetched merely to return a preserved existing result. The report says what was and was not evaluated. `none` requests an empty body for creation/verification; it never deletes an existing body under preservation.

Draft verification can fail after PR labels/titles or automatic base candidates have changed. That is an intentional safe failure, not a claim that live metadata is immutable. The error explains the alternatives: provide retained body bytes via file mode, explicitly accept the existing draft with `preserve`, or correct the draft outside the action. No silently regenerated overwrite.

GitHub immutable releases still allow title/note edits. Preserve published editorial work by default and never treat `immutable: true` as proof of body integrity. [S7]

For creation and draft resumption, title is the explicit `title`, otherwise the tag, and draft title must match. Notes presets do not generate titles. On an already published release, do not overwrite its title; validate a nonempty explicitly supplied title, otherwise preserve the observed title. A title mismatch is not repaired automatically. `notes-existing` controls the body only.

Read state before doing expensive generation. Validate repository identity, remote target, action-level configuration, and relevant release/asset/latest state on all publication paths. Preserve tag/commit binding, exact caller-owned asset set, digests, immutable-publish verification, no clobber, and no forced repairs.

The table is not permission to accept an incompatible concurrent creator. If the release was initially absent and another writer creates/publishes while this invocation prepares or creates its draft, compare that result with this invocation's prepared title/body before returning concurrent success. Otherwise fail without rewriting it. For a preserved existing draft, capture the accepted body and check it has not changed before this invocation publishes.

Recheck expected/accepted draft metadata after uploads and immediately before publish, and recheck after publish. A publish-response failure requires rereading release ID/state plus metadata/assets before recognizing concurrent or completed success. A postpublication mismatch reports that a release may already have been published; no rollback or atomic compare-and-swap guarantee is claimed. These checks narrow races but cannot prevent later authorized metadata edits.

## 9. Runtime, permissions, and bounded execution

Keep the root GitHub Action composite so it can preserve the existing caller-token contract by injecting `${{ inputs.token != '' && inputs.token || github.token }}` into `GH_TOKEN`. GitHub documents that composite actions consume inputs through the `inputs` context, while JavaScript actions receive static metadata inputs as `INPUT_*` environment variables; a JavaScript root action would not provide an equivalent dynamic `github.token` default through metadata alone. [S4] The composite pins `actions/setup-node` to a full commit SHA and selects Node.js 24 before invoking the committed TypeScript bundle. It never runs `npm install`/`npm ci` or downloads application dependencies during the release; setup-node may provision the runtime when the runner does not already have it cached.

Keep the Bash publisher's provenance/asset/state algorithms and existing `git`, `gh`, `node`, and platform utility requirements. Modify its notes boundaries rather than rewriting the entire publisher in a new language. Schema validation, collection, classification, rendering, text equality, and report emission live in the structured Node helper. Paths/data cross the boundary as explicit argument arrays, environment values, or files, never `eval` or executable snippets. Child exit codes propagate. The committed bundle targets Node 24 syntax/runtime APIs and is exercised on the supported Ubuntu/macOS runner matrix.

Bundle runtime dependencies with the action and commit reproducible distribution output. Use a lockfile, deterministic build verification, and a parser implementation tested against the selected Conventional Commits cases. No package installation, runtime template download, or caller repository code execution with the release token. Runtime/library patch versions are implementation maintenance choices, not another owner decision.

Retain Linux/macOS as the validated platform scope. Requiring a Node helper does not imply Windows support while the root action and publisher remain Bash-based. The composite action provisions Node.js 24 explicitly through the pinned setup action; the packaged helper still verifies that it is running on Node 24+ and tests that boundary on supported runners.

Custom commit-only generation needs no Pull requests API permission. Custom PR/hybrid mode requires the documented PR-read access as well as the release job's normal contents authorization. Commit-to-PR endpoints document PR-read requirements for fine-grained access; do not rely on public-repository anonymous allowances as the private-repository contract. [S6] Preview still needs whatever read/native-generation access its selected provider requires. Existing workflow-modification credential requirements remain separately applicable to publication.

Use local Git for complete commit evidence rather than treating the REST compare response as a complete history/path database. GitHub's unpaginated compare commit limit and separate file-list limit are reasons not to infer completeness from a small successful response. [S6]

Bound file sizes, parser depth, history traversal, API concurrency/pages/retries, and output size. Publish the actual tested limits with the implementation. Exhaustion, failed pagination, missing permissions, and invalid evidence are errors before publication, not empty changelogs or silent truncation. Retry transient reads/native preparation only within a finite budget; do not indiscriminately retry state-changing release operations without rereading state. Do not expose arbitrary matching code or unbounded regular expressions through configuration.

## 10. Preview and documentation experience

`notes-preview: true` verifies repository/target identity, resolves the requested policy, and prepares output/report without release mutation or asset validation/upload. Existing `tag` and `commit` remain required; preview does not create tags. Set `state: preview`, leave `release-url` empty, and return notes outputs. For `none`, prepare an empty file and an explanatory report. Preview is a point-in-time result; it does not reserve release state or freeze PR metadata for a later independent invocation.

The README continues to describe the old implementation until the new implementation passes its gates. When it ships, documentation must include: preset gallery from one common fixture, source/layout distinction, input conflict table, complete schema, default range examples including prereleases/backports/first release, per-provider capability and permission tables, notes/title/rerun semantics, preview and file replay examples, source-information limitations, and the clean-break notice.

Illustrative standard output, not a claim of executed generator output:

```md
## Breaking Changes

- **config:** replace the old option format (a1b2c3d)
  - Existing configuration files must use the new field names.

## Features

- **cli:** add a validation command (b2c3d4e)

## Fixes

- **upload:** handle paths containing spaces (c3d4e5f)

## Documentation

- clarify setup instructions (d4e5f6a)

## Other Changes

- adjust a default message (e5f6a7b)

**Full Changelog:** v1.4.2...v1.5.0
```

In the fixture, the breaking explanation comes from its commit footer; it is not inferred. Actual generated hashes/comparison labels link to validated full identities. Compact, conventional, changelog, detailed, scoped and PR/hybrid examples must show their real information differences without pretending cosmetic layouts changed the release range.

## 11. Fixture-based acceptance and release gate

The external acceptance repository is `releaseway/release-fixture`. This is not a synthetic unit-test directory: it is the black-box consumer that owns real Git tags, GitHub Releases, deterministic assets, and public workflow calls. Candidate validation must exercise `releaseway/actions` through its action interface from this repository, never by importing action implementation modules.

As observed on 2026-09-28, the fixture has published immutable releases `v0.1.0`, `v0.1.1`, and `v0.1.2`; tags `v1.0.0` and `v1.1.0` exist without published releases; and there are currently no pull requests. Its existing `release.yml` pins released `releaseway/actions` and remains the ordinary product-fixture workflow. Candidate acceptance gets a separate workflow so testing an unreleased action does not require temporarily repinning that stable workflow.

### 11.1 Mandatory validation layers

Every implementation release uses all three layers below. Passing one layer never substitutes for another.

1. **Deterministic engine tests in `releaseway/actions`.** Construct isolated Git repositories and provider-shaped JSON fixtures locally. Prove schema validation, Conventional Commit parsing, range selection, deterministic ordering, filters, renderers, report generation, UTF-8/newline behavior, size limits, and invalid-input failures. Golden Markdown is appropriate here because the input evidence is fully controlled.
2. **Publisher/lifecycle regression with the stateful fake GitHub CLI.** Extend the existing `test/release.py` harness (or split it without weakening coverage) to prove draft/published handling, exact notes equality, preserved bodies, tag movement, asset integrity, concurrent create/upload/publish behavior, lost responses, preview nonmutation, and error-before-mutation rules. Fault injection belongs here because deliberately racing or corrupting a live repository would be nondeterministic.
3. **Live black-box acceptance in `release-fixture`.** Run the packaged candidate against real GitHub Git/Release/PR APIs and real workflow execution. This layer verifies provider semantics, permissions, packaging, cross-repository action use, and actual immutable-release behavior. It does not attempt exhaustive fault injection.

A failure in a required layer blocks release readiness. If a live provider behavior cannot be made deterministic enough to assert exactly, assert the stable contract (identities, range, state, body digest relationship, asset set, provider mode) rather than GitHub-owned prose headings.

### 11.2 Candidate workflow shape

Add a dedicated manual workflow such as `.github/workflows/release-notes-acceptance.yml` to `release-fixture`. It takes a required **full 40-character `action-ref`** and a suite/scenario input. Do not use a dynamic expression in a cross-repository `uses:` reference. Instead:

1. checkout `release-fixture` with full history/tags;
2. checkout `releaseway/actions` at the supplied candidate SHA into a secondary path such as `release-action`;
3. invoke `uses: ./release-action`;
4. assert `notes.md`, `notes-report.json`, action outputs, and live GitHub state;
5. upload the notes/report/assertion artifacts for audit when the scenario produces them.

Use job-level least privileges: commit-only preview needs repository contents read; PR/hybrid preview adds pull-requests read; publishing needs contents write and whatever existing workflow-file authorization the target commit requires. The workflow records the exact candidate SHA in its summary and artifacts.

Candidate acceptance is tied to the exact `releaseway/actions` commit. Any source or committed distribution change after the accepted run invalidates that run and requires rerunning the gate.

### 11.3 Nonmutating live preview matrix

These scenarios run against the repository's existing history and must not create, edit, delete, publish, upload, or retarget a release.

| Scenario | Target/config | Required assertions |
| --- | --- | --- |
| Default standard baseline | target `v0.1.2`, default `notes: standard` | base resolves to published `v0.1.1`; the released range is the single target commit `e71793f...`; it remains visible as a maintenance/CI change; target/base full SHAs and body digest are reported |
| Published-release versus tag semantics | target `v1.1.0`, `range.strategy: auto` | unpublished `v1.0.0` is not treated as a published base; no descendant `v0.1.x` release is accepted as an ancestor base; first-release policy is applied and explained |
| Previous-tag override | target `v1.1.0`, `range.strategy: previous-tag` | base resolves to tag `v1.0.0`; report differs from the prior auto scenario for the documented reason |
| None/file byte handling | existing target tag, preview only | `none` yields an empty requested body; `file` round-trips a fixture containing final-newline, no-final-newline, Unicode, and Markdown metacharacter cases exactly |
| GitHub native | target `v0.1.2`, explicit native previous tag `v0.1.1` | output is nonempty when GitHub returns notes; effective provider/range are reported; action output bytes equal a direct Generate Release Notes response obtained with the same inputs in that run, without parsing GitHub headings |
| Invalid configuration | existing target tag, invalid/unsupported config | action fails before release mutation; expected error class/path is asserted |

For every preview case, capture relevant release metadata before and after the action. Existing release IDs, bodies, asset inventories and tag targets must remain unchanged; for an unpublished target such as `v1.1.0`, a release must still be absent afterward. This is the live proof for the `notes-preview` zero-mutation contract.

### 11.4 Persistent PR/hybrid fixture dataset

The current fixture has no PR history, so PR behavior cannot be claimed live-tested until the fixture intentionally gains a small permanent dataset. Build it once in `release-fixture` and preserve the resulting PR numbers/landing SHAs in a test expectation manifest.

Starting from a recorded baseline commit, create and merge at least:

- one PR by ordinary merge commit with a Conventional `feat(scope): ...` change and a matching feature label;
- one PR by squash merge with a Conventional `fix: ...` change and a bug/fix label;
- one PR by rebase merge with multiple commits so exact released-commit association is exercised;
- label metadata that intentionally disagrees with one Conventional category to prove configured precedence without erasing a breaking flag.

Tag the commit immediately after the PR-only sequence with a dedicated family such as `notes-pr-v1.0.0`. Use an explicit base at the recorded pre-PR baseline. A live `notes: pull-requests` preview must produce exactly the verified PR units, with the expected PR identities and covered commit identities in the report.

Then add one direct Conventional commit not belonging to a PR and tag the result as `notes-pr-v1.0.1`. Against the same explicit pre-PR base:

- `pull-requests` with default `unmatched: error` must fail because the direct commit is uncovered;
- `pull-requests` with `unmatched: omit` must succeed and visibly disclose the omitted commit count/identity;
- `hybrid` must emit the verified PR units plus that direct commit exactly once;
- exclusions applied to a proven PR must not cause its covered commits to reappear as hybrid fallback.

The test manifest is assertion data, not input to the notes engine. Updating the manifest after discovering a failure is not a fix; provider coverage logic or the advertised capability must be corrected first.

### 11.5 Live publication and idempotency campaign

Live immutable publication is a pre-release gate, not a per-commit CI test. Each candidate campaign uses a deliberately created fixture commit/tag in a separate family such as `notes-acceptance-v0.1.0-rc.N`. The fixture owns and pushes that tag before invoking the action; the action must never create or move it. Use prerelease publication with `latest: "false"` so acceptance artifacts do not become the fixture's ordinary latest product release.

For the chosen acceptance tag:

1. build the deterministic fixture archives with the existing fixture builder;
2. run candidate `notes-preview: true` with the exact publication notes/config inputs and retain the body/report digest;
3. run the candidate normally with the same inputs and assets;
4. assert `state=created`, `notes-state=verified`, exact release title, prerelease/latest state, remote tag target, `immutable=true`, complete asset basename set and SHA-256 digests, and release body bytes/digest equal to the prepared preview;
5. rerun the identical invocation and assert `state=existing`, default published-body handling reports `notes-state=preserved`, body/title/tag/assets are unchanged, and no replacement upload occurred;
6. run an explicit `notes-existing: verify` invocation against the same published release and assert exact equality succeeds without mutation.

Keep successful immutable acceptance releases and tags as an audit trail; do not depend on deletion for cleanup. The dedicated tag prefix prevents them from entering the ordinary `v*` fixture family. A new candidate that changes generation/publication code gets a new fixture tag rather than reusing an immutable one.

Do not use live immutable releases for destructive mismatch/race experiments. Published editorial-body mutation, concurrent creators with conflicting bodies, tag movement mid-run, failed upload, and lost publish responses stay in the deterministic lifecycle harness. A controlled temporary **draft** may be used live only when a provider-specific draft behavior cannot be proven otherwise; such a scenario must clean up the draft/tag in an `always()` step and must never be required for ordinary CI.

### 11.6 Range/channel live spot checks

The exhaustive range matrix remains local, but the fixture must provide provider-level spot checks:

- current published stable chain: `v0.1.1 -> v0.1.2`;
- unpublished-tag distinction: `v1.0.0 -> v1.1.0` via explicit `previous-tag`, contrasted with `auto`;
- acceptance prerelease chain after at least two `notes-acceptance-...-rc.N` releases: later RC auto-selects the previous eligible RC in the same family;
- stable/prerelease and first-release corner cases that would require awkward permanent GitHub state remain isolated-Git tests unless a real provider discrepancy is discovered.

A passing live spot check does not reduce the local range matrix: first release including root, stable/prerelease transitions, maintenance backports, non-SemVer patterns, same-SHA aliases, first-parent versus reachable ambiguity, shallow checkout, target different from checkout HEAD, and explicit unrelated bases all remain required deterministic tests.

### 11.7 Exact commands and release-readiness evidence

The implementation adds repo-local scripts so validation is reproducible rather than relying on ad hoc commands. The target command set is:

```sh
# releaseway/actions
npm ci
npm run typecheck
npm test
npm run build
npm run check:dist
python3 test/release.py
git diff --check
```

The packaged CI matrix runs the relevant action tests on Ubuntu and macOS. `check:dist` rebuilds in a clean temporary location or otherwise proves committed distribution output matches source without modifying the worktree.

The external fixture keeps its existing local product checks:

```sh
# releaseway/release-fixture
python3 test/fixtures.py
git diff --check
```

and lints the new acceptance workflow with the fixture's existing actionlint job.

Before publishing a `releaseway/actions` version, release-readiness evidence must include:

- exact candidate commit SHA;
- passing action unit/type/build/dist/lifecycle checks on the supported OS matrix;
- passing nonmutating `release-fixture` preview suite on that same SHA;
- passing PR/hybrid live suite once the persistent PR dataset exists if those modes are advertised in the release;
- one successful live immutable publication campaign and same-tag rerun on that same SHA;
- links/run IDs plus retained `notes.md` and `notes-report.json` artifacts;
- confirmation that the commit being tagged for the action is byte-for-byte the candidate accepted by the fixture.

If PR/hybrid provider proof is incomplete, do not ship those modes as supported merely because local mocks pass. Either fix the proof or narrow the first release's public capability matrix. Likewise, a fixture failure after local success is a release blocker, not an optional smoke-test warning.

## 12. Implementation work units and acceptance gates

Planning does not register a task queue or start these units. Implement in dependency order:

| Unit | Deliverable | Required validation before completion |
| --- | --- | --- |
| W1 — New contract and packaging | Composite root + bundled Node 24+ helper boundary, new inputs, schema, preset registry, removed old input, unchanged publication algorithm scaffold | Packaged helper/action smoke; token-default preservation; old-input absence; valid/invalid combinations; runtime and Linux/macOS checks; publisher safety baseline |
| W2 — Range and commit evidence | Isolated Git history, family/channel/ancestry selection, pinned graph range, complete messages, deterministic ordering | Initial history/root; equal SHA; prefixed/custom tags; never-published tags; stable/prerelease; backports; shallow checkout; target differs from HEAD; ambiguous reachable bases; no caller-ref mutation |
| W3 — Classification and layouts | Shared record model, Conventional Commits parser, categories, filters, six layouts, JSON diagnostics | Same-fixture golden files; unknown/custom types; scopes/case/! and footers; breaking preservation; strict errors; no invented semantics; Unicode/control/Markdown adversarial inputs |
| W4 — PR and native providers | Proven PR coverage, PR-only/hybrid policies, native prepare adapter and provider capability validation | Merge/squash/rebase/cherry-pick/overlap; exclusions do not reappear; incomplete pages and permissions; native opacity and one generation; integration proof of advertised coverage |
| W5 — Lifecycle and preview | Preparation, exact body comparison, three existing-body policies, concurrent recovery, file replay, preview outputs | Draft/published matrices; changed metadata; different concurrent bodies; interrupted upload/publish; trailing-newline fidelity; no hidden assets/markers; zero release mutations in preview |
| W6 — External fixture acceptance | Add the candidate-checkout acceptance workflow to `release-fixture`, preview assertions, persistent PR/hybrid dataset/manifest, live immutable publication and rerun gate | Exact candidate SHA; current stable/unpublished-tag preview matrix; PR merge/squash/rebase proofs; native provider proof; immutable body/assets/tag assertions; same-tag idempotency and verify rerun |
| W7 — Documentation and release readiness | Gallery, full schema/reference, permissions, breaking-change guide, self-workflow adoption and fixture acceptance evidence | Executable examples; end-to-end packaged action regression on Linux/macOS; all advertised fixture gates from section 11; clean source/distribution diff; action tag equals accepted candidate SHA |

Each unit has a real validation gate. Do not mark the project complete from formatting snapshots alone. Test publisher fault paths after integration, including published-but-failed postchecks. Independent work units may be committed when implementation/commit authority is granted; this decision session makes no commit.

The first implementation release must satisfy the advertised catalog. A failing collector proof is a correctness blocker to fix or explicitly narrow in the documented capability matrix, not a reason to silently drop records or pretend an unverified mode shipped.

## 13. Decision rationale and boundaries

Selected rather than hybrid default: commit-first avoids PR dependence, ambiguous coalescing, and mutable labels in ordinary generation while remaining useful without strict message discipline. Hybrid remains explicit for repositories that value PR-level entries.

Selected rather than GitHub-native default: an owned structured model permits stable custom layouts and an explainable default; native behavior remains selectable without parsing its Markdown.

Selected rather than implicit file precedence: explicit `file` makes a real `standard` default unambiguous and avoids incompatible meanings of `none`.

Selected rather than automatic repository config discovery: an explicit path makes the policy source visible and avoids claiming that caller HEAD necessarily equals the release target.

Selected rather than a checkpoint subsystem: exact draft verification, explicit preservation, and ordinary file replay cover the lifecycle without introducing storage, manifests, hidden assets, or unverifiable provenance claims. Published body preservation is a non-destructive default, not legacy compatibility.

The clean break concerns the action's public input contract. It does not authorize deleting old releases, changing caller repositories, weakening tag/asset verification, or automatically rewriting editorial content. No automatic version selection, tag creation, public release, or version-number choice is part of this feature decision.

## Primary references

External provider/standard facts were checked on 2026-09-28. Selected Releaseway policies are decisions, not behavior mandated by these sources.

- [S1 — Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [S2 — Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/)
- [S3 — GitHub automatically generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
- [S4 — GitHub action metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax)
- [S5 — GitHub REST releases](https://docs.github.com/en/rest/releases/releases)
- [S6 — GitHub REST commits](https://docs.github.com/en/rest/commits/commits)
- [S7 — Managing GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
- [S9 — Git rev-list](https://git-scm.com/docs/git-rev-list)
