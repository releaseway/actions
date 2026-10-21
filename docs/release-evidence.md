# Preserve and verify release approval evidence

The automation repositories' release workflows preserve approval
as `releaseway-evidence.json` before immutable publication. This guide describes
the scripts in its checkout; older releases retain their own approval policy.
It is for maintainers running
the scripts from a current actions, npm-actions or homebrew-actions checkout.
The Python helpers and policy files are identical in those three repositories.

## Approve a new candidate

Wait for the newest successful push CI at the exact candidate SHA, including any
new run started by the release tag. Complete the required public acceptance:

| Candidate | Required acceptance |
| --- | --- |
| actions | Full notes acceptance, legacy distribution/Pages receipts and the separate release-set aggregate from the same Pages-enabled run under `actions-release-set-v2`; exact-SHA test and distribution CI |
| npm-actions | Fresh staged submission and direct native publication, including tag-derived version and Node 22/24/26 consumers |
| homebrew-actions | Legacy public source/prebuilt acceptance and 21-case revision/platform acceptance under `homebrew-platforms-v2` |

Use `verify-release-evidence.py` for a read-only live readiness check. For Homebrew,
set `CANDIDATE_SHA`, `PUBLIC_RUN_ID` and `FEATURE_RUN_ID` to the full candidate SHA
and successful fixture run IDs:

```sh
python3 scripts/verify-release-evidence.py \
  --repository releaseway/homebrew-actions --candidate "$CANDIDATE_SHA" \
  --acceptance-runs "$PUBLIC_RUN_ID,$FEATURE_RUN_ID"
```

Actions also requires `--distribution-run`; npm requires its staged/direct run IDs.
Missing, expired, failed, partial, other-SHA or previous-attempt evidence blocks
fresh collection. The checker also compares original native ZIP bytes with provider
artifacts for Homebrew feature acceptance. For release sets it checks the original
documentation/report ZIPs, provider digests and successful native/deployment jobs.
See the [distribution campaign guide](https://github.com/releaseway/release-fixture/tree/main/distribution-fixtures)
for its read-only candidate collector without publication.

The official release dispatch still takes an existing stable tag and the approved
run IDs. It prepares one frozen bundle, attaches it as a required draft asset,
publishes, and authenticates that asset. `--bundle PATH --release-tag TAG` on the
live checker exposes collection to workflow integrations; it needs the real
`GITHUB_*` collection identity supplied by GitHub Actions. Local readiness checks
do not need those variables. The workflow normally uses
`prepare-release-evidence.py` to handle fresh, draft and immutable states.

## Verify an existing release

Install Python 3 and a GitHub CLI that provides `gh release verify-asset`,
authenticate `gh`, and grant the required repository read access. Run from an
automation repository checkout. Set `AUTOMATION_REPOSITORY` to its `owner/repo`
and `RELEASE_TAG` to the release whose approval you want to authenticate:

```sh
python3 scripts/verify-archived-release.py \
  --repository "$AUTOMATION_REPOSITORY" --tag "$RELEASE_TAG" \
  --output /tmp/releaseway-evidence.json
```

Success reports `archive_authenticated`. The command downloads the immutable
Release asset, checks its provider digest and `gh release verify-asset` attestation,
then verifies the bundle. It uses Release/attestation services and does not call
the Actions artifact API. If your home cache is read-only, set `XDG_CACHE_HOME` to
a writable directory so GitHub CLI can initialize its verification cache.

Save the returned `candidate` and `sha256` through a trusted channel. On another
machine, set `CANDIDATE_SHA` and `EXPECTED_SHA256` to those values, and use the
same repository and tag. Check the copied file's internal consistency without
GitHub CLI, credentials or Actions API access:

```sh
python3 scripts/verify-evidence-bundle.py \
  --file /tmp/releaseway-evidence.json \
  --repository "$AUTOMATION_REPOSITORY" --tag "$RELEASE_TAG" \
  --candidate "$CANDIDATE_SHA" --expected-sha256 "$EXPECTED_SHA256"
```

Success reports `consistency_verified`. Obtain the expected digest through a
trusted channel; a digest read from the same untrusted file adds no authentication.
Offline consistency checks do not authenticate signatures or establish current
npm/Pages health. Run the product's live consumer/health checks for current state.

## What the bundle preserves

Schema 1 records candidate repository/tag/SHA, policy data and digest, checker
repository/commit/file digests, collection identity/time, provider CI/acceptance
run/attempt/workflow/SHA/event/status/times, job results, artifact metadata, original
ZIP bytes and SHA-256. It replays the installed trusted policy without executing
embedded code. The Homebrew feature receipt uses its own schema 2 inside this
schema-1 container and includes all 21 cases and 16 native receipts.
The actions release-set policy preserves seven original ZIPs: notes, legacy
distribution, release-set aggregate, two documentation artifacts and two Pages
reports. Its provider snapshots bind receipt identities to native jobs and both
environment deployments. Archived older policy IDs remain replayable; they cannot
approve a fresh candidate that requires the newer policy.

Limits are 8 MiB per bundle, 2 MiB for snapshots, 1 MiB per original/decompressed
artifact and 100 KiB per receipt. Duplicate JSON keys, boolean IDs, unsupported
policies, malformed base64 and unsafe/duplicate/extra ZIP members fail validation.
The collection workflow is recorded as in progress; a pre-publication bundle does
not invent its future success or a future Release ID. Release attestation binds
the completed publication to the asset afterward.

## Expiry, retries and conflicts

Actions retention expiry removes the original downloadable workflow artifact.
It does not expire the product source, tag or immutable Release. A completed
archive already contains the original ZIP bytes, so later Actions expiry does
not prevent its offline replay or Release-asset authentication.

A fresh collection with unavailable evidence must stop. Run a fresh complete
acceptance for the same candidate and supply its new run ID; do not claim it is
the original historical execution. For the allowlisted legacy backfill, missing
original evidence is `source_unavailable` and cannot be replaced by a later run.
The three legacy originals below have already been preserved.

A draft with the same candidate, tag, policy, run IDs and attempts reuses its
frozen bytes. Different inputs or changed required attempts/CI produce
`archive_conflict`. Inspect the unpublished draft and deliberately resolve it or
choose a new release tag before retrying; the workflow does not delete assets or
move tags automatically. A compatible empty partial draft can collect afresh.
Keep the original approved run IDs when reconciling a published immutable Release;
it authenticates and reuses the saved asset without requiring Actions artifacts.
An absent or mismatched required archive fails reconciliation.

New verifier commands use exit 0 for success, 1 for inconsistent evidence and 2
for unsupported input/schema/policy or unavailable file/tool. Failures preserve an
existing output file. The original live checker's default CLI behavior is retained.

## Preserved legacy releases

These immutable prerelease sidecars have `latest=false` and one evidence asset.
Original stable tags, Release IDs and latest selection were preserved. Their
`legacy-20261020` policy is restricted to these original releases and cannot
approve a fresh release. Verification was repeated on 2026-10-21, including
attestation authentication and replay with an empty `PATH`.

| Original | Sidecar | Asset ID / SHA-256 |
| --- | --- | --- |
| actions v0.6.3 | [evidence-v0.6.3](https://github.com/releaseway/actions/releases/tag/evidence-v0.6.3) | 661129940 / `9470fc633c961337266dc83cbed0883d037b344288c17607e61ada48849591fa` |
| npm-actions v0.7.1 | [evidence-v0.7.1](https://github.com/releaseway/npm-actions/releases/tag/evidence-v0.7.1) | 661130197 / `76ae489d0ca62445641e6432a45b6c30feb06479941214f35d3e07139faceb35` |
| homebrew-actions v0.4.3 | [evidence-v0.4.3](https://github.com/releaseway/homebrew-actions/releases/tag/evidence-v0.4.3) | 661130677 / `a789ee289142b2af987c2976e93e0c2c20ca0e12ca83077d7abb4a5ade9bb096` |

Preservation/rerun runs: [actions 39533750208](https://github.com/releaseway/actions/actions/runs/39533750208)/[39533906613](https://github.com/releaseway/actions/actions/runs/39533906613),
[npm 39533755865](https://github.com/releaseway/npm-actions/actions/runs/39533755865)/[39533914277](https://github.com/releaseway/npm-actions/actions/runs/39533914277),
[Homebrew 39533761171](https://github.com/releaseway/homebrew-actions/actions/runs/39533761171)/[39533920143](https://github.com/releaseway/homebrew-actions/actions/runs/39533920143).
