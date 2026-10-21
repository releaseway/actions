# Develop Releaseway Actions

Clone this repository and use a Node.js version supported by
[`package.json`](package.json). Run these commands from the repository
root. Consumer workflows use the [published Actions](README.md); no repository
clone or npm installation is needed to call them.

With Corepack available on `PATH`, it selects the pnpm version pinned in `package.json`.
Install GitHub CLI (`gh`) and Bash for the adapter regression tests. They use a
local HTTP fixture and the real CLI's JSON filtering; no GitHub token or external
API access is required.

The deterministic validation suite is:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run check:dist
python3 test/release-inputs.py
python3 test/release-reuse.py
python3 test/ci-contract.py
python3 test/release-preparation.py
python3 test/release.py
python3 test/release-evidence.py
python3 test/evidence-bundle.py
python3 test/homebrew-feature-evidence.py
python3 test/release-set-evidence.py
python3 test/app-free-evidence.py
git diff --check
```

CI runs the full packaged checks on Ubuntu and macOS. The separate `distribution.yml` workflow tests local preparation and prepared fixture scripts on Ubuntu, macOS, and Windows.

Live black-box acceptance lives in `releaseway/release-fixture`. It validates the exact candidate action SHA against real GitHub range/native/PR behavior and an immutable publication + rerun campaign before release readiness.

Full automation releases require `acceptance-runs` for a successful `suite=all`
fixture run and successful branch CI at the tag's exact SHA. Publication consumes
that CI instead of repeating its suites. See the
[candidate guide](https://github.com/releaseway/release-fixture#candidate-release-readiness)
for artifact retention, read permissions and retries. Tags run a lightweight
identity check against branch CI. A newer failure in the required branch workflow
cannot be hidden by an earlier success.

Full actions approvals also require successful exact-SHA
`distribution.yml` push CI and `distribution-run`: a successful
`distribution-acceptance.yml` dispatch with Pages enabled. The current-attempt
legacy artifact must contain all three native platform receipts and all three
Pages source modes with matching candidate, fixture commit, run/attempt and served
digest. A separate release-set aggregate from that same run must also verify,
including both documentation deployments and the original report/docs ZIPs.
Notes-only or public-only acceptance cannot pass this common-version gate. See
the [fixture guide](https://github.com/releaseway/release-fixture/tree/main/distribution-fixtures).
Published releases retain their historical approval policy.

Documentation-only releases can reuse an authenticated full approval when the
remaining Git inputs match. Current document checks and publication authentication
still run. See [approval reuse and forced full checks](docs/release-evidence.md#reuse-a-full-approval-for-documentation).

The private `package.json` version is build metadata. Published Action versions
come from Git tags, and all entry points share the same release SHA.

The repository release workflow freezes approval into a required
`releaseway-evidence.json` asset before publication and authenticates the immutable
asset afterward. See [preservation, offline verification and retry recovery](docs/release-evidence.md).
That guide also records preserved historical sidecars. These maintainer checks
are separate from the Action's consumer inputs.

[Back to Releaseway Actions](README.md)
