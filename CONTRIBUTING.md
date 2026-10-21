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
corepack pnpm run build
corepack pnpm run check:dist
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

The repository release workflow requires `acceptance-runs` for a successful
`suite=all` fixture run and latest successful push CI at the tag's exact SHA. It also
checks the tagged action's typecheck, unit, dist and lifecycle behavior. See the
[candidate guide](https://github.com/releaseway/release-fixture#candidate-release-readiness)
for artifact retention, read permissions and retries. Pushing a new version tag starts another push CI run at the same SHA; wait for that run to succeed before dispatching publication. The gate checks the newest run, even if an earlier branch run already passed.

Every new official actions release also requires latest successful exact-SHA
`distribution.yml` push CI and `distribution-run`: a successful
`distribution-acceptance.yml` dispatch with Pages enabled. The current-attempt
legacy artifact must contain all three native platform receipts and all three
Pages source modes with matching candidate, fixture commit, run/attempt and served
digest. A separate release-set aggregate from that same run must also verify,
including both documentation deployments and the original report/docs ZIPs.
Notes-only or public-only acceptance cannot pass this common-version gate. See
the [fixture guide](https://github.com/releaseway/release-fixture/tree/main/distribution-fixtures).
Published releases retain their historical approval policy.

The private `package.json` version is build metadata. Published Action versions
come from Git tags, and all entry points share the same release SHA.

The repository release workflow freezes approval into a required
`releaseway-evidence.json` asset before publication and authenticates the immutable
asset afterward. See [preservation, offline verification and retry recovery](docs/release-evidence.md).
That guide also records preserved historical sidecars. These maintainer checks
are separate from the Action's consumer inputs.

[Back to Releaseway Actions](README.md)
