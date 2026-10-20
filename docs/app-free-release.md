# Release in one workflow

The [workflow template](../examples/app-free-release.yml) pins the immutable
releases actions [v0.6.0](https://github.com/releaseway/actions/releases/tag/v0.6.0),
npm-actions [v0.7.0](https://github.com/releaseway/npm-actions/releases/tag/v0.7.0)
and Homebrew [v0.4.2](https://github.com/releaseway/homebrew-actions/releases/tag/v0.4.2)
by full commit SHA. Copy it into the product repository and configure the product
policies and publication prerequisites below.

The product owns its workflow, source build, signing and consumer tests. Releaseway
plans versions, verifies and binds tags, publishes immutable Releases and connects
its existing npm, Homebrew and file-delivery steps. The template has no App or PAT
secret. Optional Homebrew publication uses the existing tap deploy key.

## Minimal policies

Product `.github/releaseway.yml`:

```yaml
strategy: source-tag
```

This defaults to branch `main`, prefix `v`, initial version `0.1.0`, automatic
Conventional Commit bumps and automatic GitHub latest policy. Set only policies
that your product needs. To keep the existing marker strategy, omit strategy or
use `strategy: release-commit`; its npm step must also pass the existing
`release-commit` output so the marker is validated against the workflow source.

For tag-derived npm versions, `.github/npm/packages.yml`:

```yaml
version:
  source: git-tag
publish:
  mode: direct
  channels:
    stable: latest
    prerelease: next
```

Use `mode: stage` when maintainer approval is required. An accepted stage is not a
public version. Packages must meet existing npm Trusted Publishing prerequisites.
Without tag-derived policy, the original manifest-version publication path remains
available and does not need release-tag.

Both user policy files may omit `schema`. Omission **always means schema 1**, not
the newest version. Explicit numeric `schema: 1` is equivalent. Null, booleans,
strings and unsupported versions fail. Generated plans, annotations and reports
keep mandatory schema fields; users do not edit those documents.

## Order and authority

1. Read origin and save a version plan without changing remote refs.
2. Build and test that exact source, passing the version through environment/output.
3. Download the plan and build by immutable artifact ID. Resume from the planned
   source using the same policy; create the tag only after the build succeeds.
4. Publish the GitHub Release with the returned tag and commit.
5. Run the selected npm, Homebrew or Pages jobs through `needs`.

Source-tag keeps source and tag target identical. The existing marker strategy
still creates its deterministic commit. Never confuse an annotated tag object's
SHA with the commit output. For native npm packages, publish the configured native
assets before npm packaging; the product determines their build matrix and names.
The sample `version.txt` producer is deliberately replaceable.

The plan artifact and build artifact are addressed by ID, not searched by name or
latest run. Workflow artifacts expire and are not a permanent release database.
Source-tag identity in origin allows retries without retaining the plan forever.
Missing expired artifacts require a fresh plan/build or explicit resolution of the
existing release; do not transform plan JSON or choose a new version just to retry.

## Permissions

| Job | Authority |
| --- | --- |
| plan/build | contents read; private Git repositories also need checkout/fetch access |
| release | contents write and permission to create the configured tag |
| npm | contents read, id-token write, configured caller workflow Trusted Publisher |
| Homebrew | caller read plus existing write deploy key scoped to the destination tap |
| Pages | existing contents/actions/deployments read and pages/id-token write |

The source-tag strategy does not need branch write permission, but GitHub still
requires contents write to create a tag. Repository tag rules, immutable Release
settings, npm package bootstrap/Trusted Publisher registration, tap branch policy
and Pages activation/environment protection remain prerequisites. The workflow
does not modify these settings or request a broader token automatically.

A tag pushed with GITHUB_TOKEN does not trigger a separate tag-push workflow.
Follow-up work in the template stays in the same run. If a product deliberately
uses a separate workflow, an explicit workflow_dispatch is an optional alternative:
grant actions write only to its dispatch job, send the exact release identity, and
check the resulting workflow's completion independently. This split is not required.
The npm publisher remains a step in the product's registered caller workflow.

## Recovery

| Observed result | Next action |
| --- | --- |
| build failed before resume | reuse the same source and plan; no tag was created by planning |
| tag write response was lost | inspect origin and resume the same identity |
| branch moved while creating the tag | preserve the tag; inspect and resume if its identity and ancestry still match |
| tag name or source policy conflicts | stop; do not retarget a tag or auto-increment away from the conflict |
| GitHub draft upload failed | retry the same tag with matching assets; the existing draft is retained |
| npm partially completed | retry the same selected tag; public versions are skipped, remaining packages proceed |
| tap or Pages failed | retry that delivery from the verified existing Release |

`diagnostics-path` is a separate schema 1 sidecar. Existing report formats and
public result enums remain unchanged. `already-published` proves existence;
`published` proves verified bytes; `staged` proves submission acceptance. npm
channel verification is not performed and dist-tags are not automatically repaired.
Use a guarded `always()` upload to retain sidecars on controlled failures. An absent
sidecar after a filesystem/runner failure is not evidence of no remote mutation.
GitHub, npm, the tap and Pages are independent systems: no global transaction,
exactly-once execution or automatic rollback is promised.

## Candidate acceptance gate

The dedicated `release-fixture` app-free workflow and the optional app-free path
in `npm-actions-fixture/direct.yml` exercise both same-source versions. The original
notes, stage and native acceptance routes remain required. After real runs, execute
`python3 scripts/verify-app-free-evidence.py` with `--actions-sha`, `--npm-sha`,
`--git-run`, `--npm-run`, `--notes-run`, `--stage-run`, and `--legacy-native-run`.
All SHAs and run IDs must identify the verified candidates/current attempts. Enable
Homebrew and Pages in the Git fixture run for the complete gate. This checker reads
GitHub/npm/public delivery state; it does not dispatch, publish or alter permissions.
