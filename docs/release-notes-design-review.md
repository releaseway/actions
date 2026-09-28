# Release notes: historical design review and decision record

Recorded and updated: 2026-09-28 (Asia/Seoul).
Reviewed repository: `releaseway/actions`.
Code baseline: `49c543357d96884d0e5a683c45d45ebd50a8b612`.
Status: historical discussion record; superseded as an execution plan.

**Canonical selected design: [Release notes: selected design and implementation plan](release-notes-design.md).** The user delegated the remaining choices to the assistant after authorizing a clean break. The selected design now resolves the default, catalog, input/file/config contract, range, retry policy, runtime, and validation gates. Runtime implementation has not started.

Sections 3-8 below preserve the earlier review as an explicitly historical decision record, because the user asked for the discussion to be retained. Recommendations, candidate spellings, UNRESOLVED labels, and proposed work in those historical sections describe the state before delegation. They are NOT current execution instructions or unanswered questions. Use only the canonical design for implementation. The old baseline in section 2 remains a factual observation of the inspected code, not a compatibility requirement.

## 1. Accepted direction and selected decisions

The user requested diverse automatically generated notes for callers of the reusable action, including selectable classification policies, with a generally useful default. This is not limited to the repository's own release workflow. The user authorized removing `generate-notes` completely, without a deprecated input, compatibility aliases, or a transitional release. The latest instruction delegates remaining choices to the assistant's best judgment; selected details below are not a claim that the user personally chose each algorithm.

| Decision | Current selected outcome |
| --- | --- |
| D0 — Compatibility | Remove the old input and introduce `notes` directly. |
| D1 — Default | `standard`: commit evidence, Conventional Commits classification, visible fallback, grouped output; no implicit PR collection. |
| D2 — Content/config | Explicit `notes: file` with `notes-file`; literal empty-body `none`; explicit local YAML/JSON configuration with a strict versioned schema. |
| D3 — Retry | Default verifies existing drafts and preserves published bodies; explicit verify/preserve alternatives; ordinary file replay instead of a checkpoint service. |
| D4 — Range | Branch/channel-aware prior published release by default, alternate strategies and explicit pinned bases; complete initial history by default. |
| D5 — Breadth | Six custom layouts, PR-only/hybrid presets, native GitHub, file, none; independent supported overrides on one evidence model. |
| Runtime/verification | Bundled Node 24 engine and thin entry retain Bash publication algorithms; preview/report and graph/parser/provider/race/packaged-action gates. |

The hybrid-default, implicit file-mode, automatic configuration discovery, and mandatory checkpoint-store suggestions in the old review were not selected. Their rationale is retained only as history; the canonical design explains the chosen alternatives. No owner decision remains blocked. Implementation validation is still required.

This session changes design documents only. It does not implement the action, register tasks, commit, bump a version, publish a release, alter another repository, or authorize rewriting published editorial content. No release number is selected.

## 2. Verified old implementation (not the target contract)

These observations are about the checked-out implementation, not a future design:

| Surface | Current behavior | Local evidence |
| --- | --- | --- |
| Public inputs | `title`, `notes-file`, and boolean `generate-notes`; no `notes` or `notes-config` | `action.yml:15-26, 57-60` |
| Default | `generate-notes` defaults to `false`; with no file, no release body is supplied | `action.yml:23-26`; `scripts/release.sh:295-313` |
| Title | Explicit `title`, otherwise the tag; the action always supplies the API `name` field | `scripts/release.sh:295-307` |
| File mode | Sends the file as the release body; file must exist | `scripts/release.sh:311-313, 448-451` |
| Native generation | Passes `generate_release_notes` to Create Release; does not collect or classify changes itself | `scripts/release.sh:297-309` |
| Input conflict | File plus legacy `true` is rejected; file plus legacy `false` is allowed | `scripts/release.sh:438, 448-451` |
| Existing draft | Checks the title; checks file content using shell command-substitution newline handling; no-notes mode rejects an existing body; generated mode preserves the existing body without proving how it was produced | `scripts/release.sh:265-290`; `README.md:126-131` |
| Existing published release | Does not compare title/body with the new invocation; verifies release/asset/latest state and returns `existing` | `scripts/release.sh:466-477` |
| Publisher boundary | Verifies repository identity and remote tag, drafts, uploads/verifies assets, publishes, verifies immutability; does not generate versions or tags | `scripts/release.sh`; `README.md` |
| Tests | Python harness with a temporary Git remote and a stateful fake `gh`; existing draft-title/file-body/generated-body cases | `test/release.py:690-722`; `README.md:160-167` |

The separate root checkout named `release-actions` is outside this review's write scope. Recording here does not update that checkout.

## 3. Review conclusions

The direction is viable, but treating this as an enum expansion alone would miss most of the engineering work. The main issues are input resolution, complete change collection, honest classification, and release lifecycle behavior. Formatting should consume a common model rather than own those decisions independently.

The recommended architecture is:

```text
raw caller inputs + explicitly sourced configuration
  -> resolve effective policy and validate capabilities
  -> inspect existing release state
  -> resolve and pin range (only when generation is needed)
  -> collect complete evidence
  -> establish PR/commit coverage and normalize change records
  -> filter and classify
  -> render a prepared notes document
  -> existing release lifecycle integration
```

This is a separation of responsibilities, not a requirement to introduce separate packages or services. Keep the existing publication guarantees and avoid rewriting the lifecycle merely to add notes.

### 3.1 Product model: provider, source, classifier, layout, and preset

The earlier list mixed different kinds of choices. `github` names a generation provider; `compact` describes a layout; `conventional` describes a classification-oriented preset; `none` disables the body. They can share a convenient public selector, but should resolve into distinct internal concepts.

A preset is a documented bundle of defaults, not an independent implementation. Reusable layouts should consume the same normalized records. Meaningful per-axis overrides should be available where the selected provider supports them. Reject incompatible overrides rather than silently ignoring them.

Candidate format families for a gallery, not a locked shipping catalog:

| Family | Intended experience | Important distinction |
| --- | --- | --- |
| Standard / categorized | Familiar grouped changes, clear breaking notices, comparison link | The eventual generally useful default; exact policy still to be selected |
| Compact | Short entries and minimal ancillary metadata | Brevity must not accidentally hide breaking-change notices |
| Conventional | Conventional type/scope grouping | Unknown/nonconforming messages need a documented fallback or selectable strict policy |
| Changelog-style | Added / Changed / Deprecated / Removed / Fixed / Security vocabulary | Inspired by Keep a Changelog; headings alone do not provide editorial curation |
| Detailed | More context, references, contributors, and explicit migration text when present | Additional fields must be sourced, not invented |
| By scope / component | Group by explicitly supplied scopes, labels, or configured path ownership | Useful as an optional extension once ownership semantics are verified |

GitHub-native generation and a supplied notes file remain useful alternatives. `grouped` and a grouped `standard` need not be two permanently duplicated engines. A `custom` selector is also not inherently necessary if a preset can accept declarative overrides; exact names remain subject to the API design.

Changing presentation alone should not unexpectedly change the range or remove records. A preset that intentionally changes inclusion policy must show that difference in the gallery and resolved-policy report.

### 3.2 Standards and the default

There is no single convention here that specifies the complete behavior of this action. Conventional Commits defines commit-message signals. Keep a Changelog describes human-oriented changelog organization. GitHub provides its own generation service and label-based configuration. None settles all range, deduplication, retry, and rendering choices. [S1][S2][S3]

The recommended target is a Releaseway-owned default that uses recognizable conventions, documents its exact policy, and remains overridable. The tentative name `standard` must not imply an industry-standard algorithm. A simpler viable alternative is a GitHub-native default with Releaseway presets explicitly selected; it requires less custom behavior but delegates the default presentation and native capabilities to GitHub.

Choose the new effective default for the desired user experience, not to preserve the existing empty-body behavior. The new release can activate it directly; no compatibility phase is required. Exact preset contents remain D1. Document the policy at each action revision, including deliberate changes between releases. Pinning the action revision should pin its local preset definitions, schema, and rendering behavior; it cannot pin future GitHub-native output or subsequently edited PR metadata.

### 3.3 Clean-break API resolution

Accepted: `notes` is the only public generation-mode selector. Remove `generate-notes` from action metadata, environment forwarding, input parsing, supported examples, and tests whose purpose is to preserve its behavior. Do not add a deprecated declaration, a `deprecationMessage`, boolean compatibility aliases, or old/new selector conflict branches. A concise breaking-change explanation may tell callers how to rewrite their workflow; that is documentation, not a supported compatibility path.

This removes a public action input, not GitHub's `generate_release_notes` API field or its Generate Release Notes endpoint. Native GitHub generation remains a selectable capability under the new contract.

Input metadata and resolver behavior must agree. If file-only invocation remains supported, a metadata default must not manufacture an explicit generated-mode/file conflict. One possible implementation is a raw empty selector followed by effective-default resolution; another is an explicitly selected file mode. No raw-default technique is required by the removed input. Settle this with D2. With an empty-sentinel scheme, do not claim that an omitted and an explicitly empty value are distinguishable. [S4]

Proposed new-contract resolution requirements; mode spellings and file conflicts are not yet approved:

| Supplied selection | Proposed handling |
| --- | --- |
| `notes` selector alone | Use the selected mode/preset |
| Neither selector nor file | Use the selected generally useful automatic default directly; exact policy is D1 |
| File alone, selector omitted | Recommend using the file; explicit file-mode selection is another viable new-contract design under D2 |
| Explicit generated preset plus file | Recommend conflict unless composition is separately designed |
| Explicit `notes: none` plus file | Owner review needed: literal no-body meaning versus disable-generation meaning; see D2 |
| Misspelled/unsupported selector | Fail before draft creation with supported alternatives |
| Removed `generate-notes` key | Unsupported; never translate it into a mode or preserve its former file combinations |

Conflict detection applies to supported new-contract inputs and stays distinct from policy-override merging. A supplied file is caller-owned content, not implicitly a header, footer, or postprocessor for generated notes. The acceptance target is one coherent new API, not a matrix of old and new behavior.

### 3.4 Configuration semantics

Recommend a small, versioned, declarative schema rather than exposing every setting as an action input. The path and schema are not yet public. One simple viable shape is a `notes` selector plus an optional configuration-file input.

Specify these behaviors before shipping:

- Which settings each provider supports, and whether the config may select a preset or only override one. Avoid two competing preset selectors unless the precedence is justified.
- Unspecified fields inherit from the preset. A concrete boolean `false` must not be confused with omission.
- Recommend replacement of lists, not implicit concatenation; users must be able to remove inherited categories and filters. Define `null` and empty lists explicitly.
- Reject unknown keys, invalid types, conflicting rules, duplicate category identifiers, and unsupported provider combinations with paths into the configuration.
- Choose bounded YAML/JSON parsing and path/glob semantics; do not introduce executable hooks through a formatting feature.
- Repository configuration, any explicit per-run overrides, and the final effective values should have explainable provenance.

Do not assume that a checked-out `HEAD` is the release target. The current action checks repository identity and remote tag binding, not that the checkout is positioned at the requested release commit. Recommend target-commit-bound discovery for any automatically read repository configuration. An explicitly supplied generated/local configuration is a different source: identify it as such and capture its content digest. The final local-versus-target-file contract is part of D2.

### 3.5 Range selection

Allow meaningful policies such as previous published release, previous stable release, previous matching tag, or an explicit ref. Do not present those names as complete algorithms.

The resolver needs a defined candidate namespace/component, channel policy, ancestry requirement, ordering, and tie handling. A globally latest release, a most recent publish timestamp, a highest semantic version, and a nearest reachable tag are different choices. A backport can make these diverge.

Recommended automatic selection first restricts candidates to the relevant release line and ancestry of the requested target, excludes the current tag and drafts, and then applies a documented deterministic ordering. Non-SemVer tags must not be silently coerced to SemVer. When multiple candidates cannot be safely ordered, fail with explicit candidate choices rather than inventing a base.

Resolve mutable refs to commit SHAs. Define changes for the custom collector using the selected base and target's Git graph, not PR merge dates alone. Candidate policies should cover prerelease-to-prerelease increments, prerelease-to-stable cumulative notes, maintenance branches, monorepo tag prefixes, multiple tags on one commit, and rerunning old releases after newer ones exist.

First-release policy is a separate choice: include all target-reachable history (including root commits), intentionally produce an empty notes set, or require an explicit base. No base found because of permissions, missing objects, or incomplete pagination is NOT proof of a first release.

Recommended guardrail: reject unrelated/divergent bases in the standard path. An explicit comparison mode can later support them with named semantics. Never move/create a tag merely to obtain a notes range.

### 3.6 Change collection and PR/commit deduplication

`pull-requests`, `commits`, and `hybrid` are useful source choices, but hybrid is not a concatenation of PR titles and commit subjects.

Use stable record identities and retain the relation between included commits and PRs. Establish coverage before applying exclusion filters. Otherwise, excluding a PR can cause its commits to reappear as supposedly unmatched fallback entries, defeating the caller's exclusion policy.

A proposed hybrid algorithm starts with complete target-minus-base commit evidence, associates PRs where supported, retains only PRs relevant to the selected released changes, emits one PR entry for covered work, and emits commit entries for uncovered work. Merge, squash, rebase, cherry-pick, backport, and cross-branch cases need fixtures; message similarity is not sufficient proof of identity or coverage.

GitHub's commit-to-PR endpoint can return open as well as merged PRs for commits outside the default branch. An association alone is not proof that a PR was merged into the released history. The endpoint requires Pull requests read permission for protected access; public resources have different unauthenticated access allowances. [S6]

When coverage is ambiguous, do not silently drop commits. Provide diagnostics, and establish a tested policy for unmatched or partially covered evidence. Completeness and classification confidence are different properties and should not be collapsed into one success boolean.

Changed-path filtering also needs a definition: per commit, per PR, or net diff between releases. Renames, changes spanning multiple components, and excluded commits inside an otherwise included PR can produce different results. Do not advertise path filtering as complete using a truncated provider file list.

### 3.7 Classification and information preservation

Support selectable precedence such as labels before conventional metadata, conventional metadata before labels, explicit rules only, or no grouping. These are policies; label priority is not mandated by Conventional Commits.

Keep change kind, scope/component, breaking status, deprecation/removal status, security metadata, and highlight flags as separate fields. A precedence choice for the main category must not accidentally erase a breaking flag.

Conventional parsing needs optional scopes, `!`, bodies and trailers, multiline breaking descriptions, and both `BREAKING CHANGE` and `BREAKING-CHANGE` footer tokens. Types other than `feat` and `fix` are permitted, and the specification does not prescribe revert handling. Prefix checks such as `startsWith('feat:')` are not sufficient. [S1]

`feat!` indicates a breaking feature change; it does not imply removal. Security and removal cannot generally be inferred from `fix` or a generic breaking marker. Keep a Changelog-style sections need explicit mapping, reliable metadata, or an honest fallback. Calling an automatically classified commit list a fully curated changelog would overstate what was generated. [S2]

PR metadata and commit metadata may disagree. Define which message supplies the display text and which eligible underlying records contribute safety-relevant flags. Do not suppress a breaking trailer simply because the PR's primary label is documentation or maintenance.

Do not invent highlights, migration instructions, performance results, or user-impact summaries from sparse titles. Explicit highlight labels, supplied migration text, and user-configurable inclusion remain viable. Revert-pair suppression should be opt-in or postponed until the original/revert relationship and release range are proven.

### 3.8 Native GitHub generation is a separate capability boundary

Keep native output opaque; do not parse headings such as `What's Changed` to construct custom records. Native label/category configuration is a GitHub contract, not the Releaseway custom-classifier schema. [S3]

The current Create Release call cannot express the dedicated generation endpoint's `previous_tag_name` or `configuration_file_path`. The dedicated Generate Release Notes endpoint returns a generated name/body without saving a release. Supporting explicit native range/config control therefore requires a deliberate generation call followed by publication, not simply another field on the existing create call. [S5]

A native previous tag is not interchangeable with an arbitrary commit base. A local uncommitted config file is not interchangeable with the server-side repository configuration path. Reject unsupported combinations with actionable alternatives.

If a body has already been prepared, do not also request native generation during creation: the API documents that a supplied body is prepended to generated notes. That would duplicate or unexpectedly compose content. The title remains independently explicit unless a title feature is separately selected. [S5]

### 3.9 Determinism, retries, and metadata mutability

Define determinism narrowly and honestly: the same captured evidence, effective configuration, and generator version should produce the same bytes. Fixed tag SHAs alone do not freeze PR titles, labels, contributor identities, or native output. Stable sorting and a checksum cannot fix a changed source snapshot.

GitHub immutable releases lock assets and associated tags while the release exists, but still allow editing the title and release notes. Therefore immutability does NOT prove release-body integrity. [S7]

Recommend no automatic overwrite of a published release body as a safety and editorial-ownership property, not a backward-compatibility requirement. The new existing-release contract may differ from the current implementation. Decide explicitly whether it requires notes evidence or PR access; avoid fetching mutable data merely to return a published result when that evidence is not needed by the selected policy.

For new generated modes, choose a retry contract before integration. Options include preserving the first prepared body, verifying against a retained prepared artifact/snapshot, or explicitly regenerating and rejecting differences. Regenerating from mutable live PR data by default can make harmless retries fail or change the notes.

Recommended target: prepare and validate the body before creating the draft; retain an explicitly scoped checkpoint if strict generated-note verification is promised; never silently rewrite an existing body. Resume semantics for checkpoint-free drafts and old releases remain an owner decision (D3).

A digest stored only beside mutable body content is not an authenticated expected value. An HTML marker is not a signature. Adding a manifest as a release asset also changes the caller's exact-asset-set contract, and modifying GitHub-native output breaks the promise to preserve it verbatim. Do not choose either storage mechanism accidentally.

Handle concurrent creators and failure recovery explicitly: interrupted generation, draft creation, partial asset upload, publish response loss, and another writer changing metadata. Verify what is possible at each boundary; do not promise atomic metadata immutability that the provider does not supply.

### 3.10 Permissions, completeness, API budget, and platform cost

A custom PR/hybrid collector adds an access dependency beyond ordinary content publication. In workflows with an explicit permissions block, unspecified permissions become `none`. PR-reading modes therefore need documented permission requirements; an existing private-repository workflow using only `contents: write` may need adjustment. [S6][S8] The user permits that contract change: document and validate the new requirements instead of preserving an old mode or silently downgrading collection.

Separate requirements for native generation, local commit collection, and PR enrichment. Use the least required permissions. A 403/404, inaccessible metadata, rate limit, or incomplete page must not be reported as zero changes or silently cause a different source policy.

GitHub's Compare Commits endpoint limits an unpaginated response to 250 commits. With pagination, its changed-file list is still restricted to the first page and at most 300 files for the comparison. Full commit pagination does not prove complete path evidence. [S6]

Use bounded concurrency, pagination, caching by immutable identities where appropriate, and explicit limits for history/entries/output. Do not claim that cached mutable labels are frozen facts. Specify behavior at limits; the recommended publishing default is to fail before creating a misleading incomplete release rather than silently truncate. An intentional summarized mode must visibly disclose omitted counts and must not masquerade as complete notes.

Contributor listing and first-time-contributor detection are distinct features. The latter requires historical evidence, not merely the current-range author set. Avoid fetching or exposing commit emails just to print public attribution.

The current action is composite Bash and its regression matrix covers Linux/macOS. Structured parsing, YAML, classification, and rendering should not become a large ad hoc shell parser. Recommend retaining the public action/lifecycle boundary while evaluating a small structured helper. Python and a bundled Node helper have different runtime/dependency implications; choose after a focused capability proof, not by silently adding an installation requirement. Do not advertise new platform support as a side effect of this plan.

### 3.11 Security and trust boundaries

Treat PR titles, labels, commit messages, tag names, config values, and template data as untrusted input. Pass data through structured argument/JSON/file interfaces, never shell evaluation or interpolation into executable commands. Encode release URLs and render Markdown data deliberately; use safe multiline output/logging handling.

Recommend declarative customization with bounded matching. A format option must not implicitly grant arbitrary JavaScript, shell, remote template download, or repository script execution with a release-writing token. Any later executable extension needs a separate explicit trust model.

Limit file access to the declared/configured trust scope; resolve paths and symlinks deliberately. Distinguish caller checkout paths from the action's installation directory. Validate configuration and necessary provider access before mutating a release. Do not write secrets or full authenticated API dumps into preview artifacts or logs.

### 3.12 Title, manual content, and presentation UX

Keep explicit `title` and its tag fallback independent from the notes preset as the conservative scope assumption. The user asked about title behavior, but did not request an automatic title policy or approve a title-template language.

A separate title-template option is viable later if requested. Do not silently change release titles when switching from compact to detailed notes, or consume GitHub's generated title merely because its endpoint returns one.

Manual notes should remain a clear escape hatch. Current file comparison has shell newline normalization; migration must define text encoding and equality rather than claiming existing byte-exact verification. Header/footer composition is optional future scope, not an implicit reinterpretation of `notes-file`.

Show a rendered gallery using the same underlying fixture, plus an effective-policy/diagnostics preview, before users publish. Distinguish GitHub Release body from Actions job summary. A preview command/action/output shape is not yet selected and must not be documented as available.

## 4. Owner decision log

This section records the discussion the user explicitly asked to preserve. Accepted decisions are distinguished from unresolved proposals. Resolve the remaining product decisions in dependency order; do not reopen the compatibility choice.

### D0. Compatibility policy — ACCEPTED

Owner direction on 2026-09-28: this is early-version software, and a changed contract is acceptable. The new generation selector is `notes`; remove `generate-notes` completely from the supported API. Do not retain a deprecated input, shim, boolean alias, coexistence contract, compatibility-only file combinations, or transitional default-switch release.

The new release may activate a generally useful automatic default immediately. Its exact source/range/classification policy remains D1. No particular version number or release publication is selected by this decision.

Consequences: simplify the resolver and tests around the new contract, update examples and permission requirements directly, and describe the break in release documentation. This API decision does not authorize overwriting existing published content, bypassing publication checks, or changing other repositories.

### D1. Default identity and policy — UNRESOLVED

Evidence: the user wants a generally useful default and diverse selectable alternatives. D0 removes old omission behavior as a constraint, but does not choose the new provider, source, range, or classification policy.

Recommendation: a documented Releaseway-owned default using recognizable conventions, with supported independent overrides. Select it by comparing outputs from the same representative fixtures and verifying collection and permission requirements. The name `standard` remains tentative.

Viable alternative: GitHub-native generation as the default, with custom policy presets explicitly selected. That reduces custom behavior in the default path but delegates presentation and supported native options to GitHub. It does not replace the accepted goal of offering Releaseway classification presets.

Impact of a wrong choice: a less useful default, surprising inclusion/classification, unnecessary access requirements, and confusing preset differences. This decision concerns the new user experience, not a legacy transition.

### D2. Selector/config/file composition — UNRESOLVED

Evidence: caller-owned files remain useful, but the new selector/file relationship and configuration origin/merge semantics have not been approved. Prior `generate-notes` combinations do not constrain this decision.

Recommendation: file alone selects supplied content instead of the automatic default; explicit `none` means no body and conflicts with a file, and an explicit generated preset also conflicts with a file unless composition is separately designed. Use a versioned declarative policy schema, replacement list semantics, and clearly identified target-bound versus explicitly supplied local config sources.

Viable alternatives: require an explicit file mode to make content-source selection uniform, at the cost of a more verbose file invocation; or define `none` as disabling generation while allowing supplied content, at the cost of a less literal no-body meaning. File-plus-generated composition is a distinct feature and should not be smuggled in as precedence.

Impact of a wrong choice: ambiguous content selection, accidental generation, and a difficult-to-use schema. Exact path, keys, and supported override combinations need examples before approval.

### D3. Existing release and retry contract

Evidence: published notes are not compared today, native draft bodies are preserved, PR metadata can change, and GitHub release-body edits remain possible even with immutable releases.

Recommendation: retain published no-overwrite behavior; do not claim strict verification without an authoritative prepared-body expectation. For new generated drafts, prefer a prepared snapshot/checkpoint contract with explicit behavior when it is unavailable. First evaluate how that evidence is retained without silently adding assets or modifying native notes.

Viable alternatives: preserve the existing body and explicitly report that provenance was not verified, or offer strict verification using caller-retained notes/snapshot artifacts. Always regenerating from live data is easy to implement but deliberately makes retries sensitive to metadata drift and must be an explicit policy, not an invisible guarantee.

Impact of a wrong choice: false failures, overwriting editorial corrections, accepting an incompatible draft, and overstated integrity claims. Strict mode must remain blocked until persistence and comparison semantics are testable.

### D4. Automatic base and first-release policy

Evidence: several meaningful base strategies were requested as choices, but no specific ordering, channel, or initial-history behavior was chosen. The existing action does not resolve a custom notes range.

Recommendation: a default automatic resolver scoped to compatible release history and target ancestry, with deterministic ordering and explicit overrides; treat prerelease channel and first release as separate policies. Recommend all target-reachable history for an intentional first release, with disclosed size limits, while retaining explicit-empty and require-base alternatives.

Viable alternatives: commit/tag-only history for simpler operation without release metadata; stable-only cumulative notes; explicit base required for maximum caller control. Each trades convenience, relevant release-line matching, and API requirements differently.

Impact of a wrong choice: omitted changes, inclusion from another component/maintenance line, or an enormous first-release body. A global latest-release shortcut is not an adequate substitute for this decision.

### D5. Initial capability breadth

Evidence: the user wants varied choices; no exact preset list, full override schema, runtime expansion, or component ownership rules have been approved.

Recommendation: implement shared collection/classification/rendering foundations and a genuinely diverse gallery, while publishing an explicit capability matrix. Keep path/component grouping, first-time contributor history, and arbitrary custom layouts behind their own validation gates rather than claiming every combination works.

Viable alternative: ship a broad configuration language immediately; it offers more initial flexibility but multiplies permission, completeness, conflict, and regression cases. A minimal native-only solution is simpler but does not meet the accepted custom classification direction by itself.

Impact of a wrong choice: either artificial product limits or an unmaintainable option surface. Demonstrated output differences and evidence requirements should determine the initial catalog, not an arbitrary fixed preset count.

## 5. Proposed implementation sequence (not queued or started)

| Unit | Dependency and deliverable | Validation gate |
| --- | --- | --- |
| P1 — Contract and examples | Apply accepted D0; resolve D1/D2; new selector truth table, direct default, preset gallery and supported overrides | Golden effective-policy fixtures, valid/invalid new input combinations, removal of the old public input and compatibility branches |
| P2 — Range and collection proof | P1 source/capability decisions; resolve D4 using merge/squash/rebase/backport fixtures | Complete commit/PR coverage, pagination/permission failures, first release, target not equal to checkout HEAD |
| P3 — Shared model and formats | P2 normalized records; classification provenance, independent breaking flags, declarative config, multiple renderers | Same-fixture output snapshots; standards parser cases; unknown/conflicting input; security bounds |
| P4 — Preparation and lifecycle | D3 and P3; prepared body integration with draft/resume/published branches | Fault injection and concurrent publication; no silent metadata overwrite or extra assets; tag, provenance, and asset-safety regressions |
| P5 — User documentation and rollout | P1-P4 contracts; capability/permission matrix, gallery, new-contract examples, concise breaking-change explanation | Executable examples and Linux/macOS regression; controlled native-service integration if authorized; no deprecated API in the supported reference |

These units are dependency-ordered proposals, not an assertion that five tasks have been registered. Lifecycle tests for repository/tag binding, provenance, exact assets, publication, and recovery remain integrated safety gates. Replace tests whose only purpose is preserving the removed input or old omission behavior with new-contract assertions. The repository's own workflow should adopt the new contract only after implementation is verified; changes to other callers require separate authorization.

## 6. Required acceptance matrix for implementation

| Axis | Positive and adversarial cases |
| --- | --- |
| Inputs | Direct automatic default; omitted/empty selector semantics; explicit presets and no-body mode; selected file/composition contract; invalid preset; no false conflicts from metadata defaults; removed generate-notes declaration, environment forwarding, aliases, and compatibility branches |
| Configuration | Target tree differs from checkout HEAD; explicit local file; unknown/duplicate keys; false/null/empty-list inheritance; unsupported provider override; list replacement |
| Range | Initial tag including root commits; no valid base versus permission failure; old-release rerun; stable/prerelease transition; maintenance backport; prefixed non-SemVer tags; aliases on one SHA; unrelated history |
| Collection | PR-only/commit-only/hybrid; merge/squash/rebase; direct commits; cherry-picks/backports; ambiguous association; excluded PR commits must not reappear as fallback |
| Completeness | More than 250 commits, paginated PRs, more than 300 changed files, interrupted pagination, rate limit, 403/404, inaccessible objects; no incomplete-success publication |
| Classification | Scope plus !; footer-only breaking; multiline trailers; BREAKING-CHANGE alias; permitted custom types; mismatched PR label/title/commit signal; removal versus breaking; unknown text; explicit revert behavior |
| Rendering | One fixture across all presets; preserved breaking information; ordering/tie stability; Unicode and multiline content; empty release/sections; no invented highlights or migration guidance |
| Native provider | Opaque Markdown; dedicated previous-tag/config call; unsupported commit-base rejection; no double generation/prepend; explicitly preserved title |
| Lifecycle | Existing published release under the new contract; drafts with and without prepared evidence; edited remote body; metadata drift between runs; failure after draft/upload/publish; concurrent creators with different metadata |
| Security | Shell and workflow-command payloads in source text; multiline output delimiters; unsafe template constructs; symlink/path escapes; bounded parsing/matching; no credential leakage |
| Runtime/docs | Linux/macOS; unchanged tag and asset guarantees; permissions by mode; all published example configs validated; no runtime network installation hidden by the new default |

Strict acceptance requires every included/excluded record to be explainable, collection failures to remain distinct from an empty change set, and repeated rendering of the same captured inputs to be stable. Formatting snapshots alone do not establish collector correctness or retry safety.

## 7. Recording-session verification and limits

The 2026-09-28 follow-up updates only this record for accepted decision D0. Superseded compatibility recommendations were removed from the active API design, decision log, work sequence, and acceptance matrix. Section 2 deliberately retains observations of the old implementation; those are code-baseline facts, not future compatibility requirements. The record was already an untracked file when this follow-up began. No implementation, commit, task registration, version bump, or release publication is part of this update.

The repository was clean before this record was initially created. The initial recording session inspected the action metadata, notes-related lifecycle implementation, README, and relevant regression cases. No runtime source, action input, release workflow, or tests were changed as part of the recording request.

Document validation consists of reading the saved artifact, checking references/section completeness and Git whitespace status, and confirming the final change scope. Running the runtime regression suite is not required for a Markdown-only discussion record and would not validate an unimplemented generator. No live GitHub release was created and no new-generation behavior is claimed as tested.

## 8. Primary references

These sources were checked on 2026-09-28. They support external provider/standard facts, not the unapproved Releaseway design proposals. Local baseline references above are the authority for current repository behavior.

- [S1 — Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/): syntax, scopes, breaking markers, allowed additional types, unspecified revert semantics.
- [S2 — Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): human-oriented curation and change-category meanings.
- [S3 — GitHub automatically generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes): native content and label/category configuration.
- [S4 — GitHub action metadata syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/metadata-syntax): input defaults. The target design has no declaration for the removed public input.
- [S5 — GitHub REST releases API](https://docs.github.com/en/rest/releases/releases): create versus generate-notes endpoints, name/body behavior, previous_tag_name, configuration_file_path.
- [S6 — GitHub REST commits API](https://docs.github.com/en/rest/commits/commits): commit-to-PR association semantics/permissions and compare pagination/file limits.
- [S7 — Managing GitHub releases](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository): immutable assets/tags versus editable title/notes.
- [S8 — GitHub Actions workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax): explicit permission blocks and unspecified permission behavior.
