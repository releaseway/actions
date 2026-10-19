# Develop Releaseway Actions

Clone this repository and use Node.js 24. Run these commands from the repository
root. Consumer workflows use the [published Actions](README.md); no repository
clone or npm installation is needed to call them.

Use Node.js 24 or newer and pnpm 12.14.0, as pinned in `package.json`.

The deterministic validation suite is:

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm test
pnpm run build
pnpm run check:dist
python3 test/release.py
python3 test/release-evidence.py
git diff --check
```

CI runs the full packaged checks on Ubuntu and macOS. The separate `distribution.yml` workflow tests local preparation and prepared fixture scripts on Ubuntu, macOS, and Windows.

Live black-box acceptance lives in `releaseway/release-fixture`. It validates the exact candidate action SHA against real GitHub range/native/PR behavior and an immutable publication + rerun campaign before release readiness.

The repository release workflow requires `acceptance-runs` for a successful
`suite=all` fixture run and latest successful push CI at the tag's exact SHA. It also
checks the tagged action's typecheck, unit, dist and lifecycle behavior. See the
[candidate guide](https://github.com/releaseway/release-fixture#candidate-release-readiness)
for artifact retention, read permissions and retries. Pushing a new version tag starts another push CI run at the same SHA; wait for that run to succeed before dispatching publication. The gate checks the newest run, even if an earlier branch run already passed.

Distribution acceptance is separate from this release-note gate. Its [fixture guide](https://github.com/releaseway/release-fixture/tree/main/distribution-fixtures) covers public Release reads and all three actual Pages source modes; a successful notes suite alone does not prove Pages delivery.

The private `package.json` version is build metadata. Published Action versions
come from Git tags, and all entry points share the same release SHA.

[Back to Releaseway Actions](README.md)
