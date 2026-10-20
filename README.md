<a id="actions"></a>

# Releaseway Actions

Prepare versions, publish immutable GitHub Releases, and distribute existing files
from GitHub Actions. Keep your build and installer-generation commands in your
project; Releaseway handles the release and file-verification steps around them.

## Choose your workflow

- **Publish a GitHub Release:** use the root step action with an existing tag and
  built assets. Start with the [quick start](#quick-start).
- **Calculate a version and create its tag:** use the [`prepare` step action](prepare/README.md),
  then build and publish with its outputs.
- **Prepare files for any static host:** use the [`distribute` step action](distribute/README.md).
  It accepts local files or public Release assets and returns a verified directory.
- **Deploy those files to GitHub Pages:** call the optional
  [Pages reusable workflow](distribute/README.md#optional-github-pages-workflow) at
  job level, using Release assets or a same-run build artifact.

## One workflow, no additional App

See the [same-run release guide](docs/app-free-release.md) for the
source-tag strategy, explicit npm tag selection, least-permission jobs and recovery.
The template pins verified stable releases by full commit SHA.

## Version

[v0.6.0](https://github.com/releaseway/actions/releases/tag/v0.6.0) uses commit
`804562f2eb9d7662810298835f7339bd6f26fcfa`. Pin every entry point to this full SHA;
the root action, `prepare`, `distribute` and Pages workflow share one version.

## Quick start

Publish a Release from an **existing stable Git tag**. First enable immutable
releases in your repository settings and push the tag. Save the workflow below
as `.github/workflows/release.yml`, then dispatch it with that tag.

The sample creates a small text asset so it needs no project-specific build
script. Replace that producer with your real build and change `assets` to match.
The hosted Ubuntu runner supplies Git and `gh`; self-hosted runners also need Bash
and support for Node24 Actions. The root action sets up Node.js 24 itself.

```yaml
name: Publish a release
on:
  workflow_dispatch:
    inputs:
      tag:
        description: Existing stable Git tag to publish
        required: true
        type: string
permissions:
  contents: write
concurrency:
  group: release
  cancel-in-progress: false
jobs:
  release:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ inputs.tag }}
          fetch-depth: 0
          fetch-tags: true
      - id: source
        run: echo "commit=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - name: Produce a sample asset
        env:
          RELEASE_TAG: ${{ inputs.tag }}
        run: |
          mkdir -p dist
          printf '%s\n' "$RELEASE_TAG" > dist/version.txt
      - id: release
        uses: releaseway/actions@804562f2eb9d7662810298835f7339bd6f26fcfa # v0.6.0
        with:
          tag: ${{ inputs.tag }}
          commit: ${{ steps.source.outputs.commit }}
          assets: dist/version.txt
      - name: Show the published release
        env:
          RELEASE_URL: ${{ steps.release.outputs.release-url }}
        run: |
          printf 'Release: %s\n' "$RELEASE_URL" >> "$GITHUB_STEP_SUMMARY"
```

Success returns a `release-url` and a verified immutable Release containing
`version.txt`. `notes: standard` is the default: it groups Conventional Commits,
keeps other commits visible, and includes a comparison link when a base exists.

The default token is `github.token`. Targets that change workflow files relative
to the default branch need an additional credential with workflow-write permission;
see [publication permissions](docs/publishing.md#permissions). For prereleases,
file-based notes, preview without publication, or retries, use the
[publishing reference](docs/publishing.md).

## Distribute files

After your build creates `dist/`, add a step:

```yaml
- id: files
  uses: releaseway/actions/distribute@804562f2eb9d7662810298835f7339bd6f26fcfa # v0.6.0
  with:
    files: dist/*
```

Pass `steps.files.outputs.path` to your existing publisher. Preparation preserves
file bytes and returns an inventory and SHA-256 digest. Local files need no GitHub
API permission or `gh`. Add `tag` to read public Release assets instead.

The [distribution guide](distribute/README.md) includes complete local and Pages
workflows, renaming, path prefixes, existing-site merging, permissions and recovery.
Installers, diagnostic scripts, applications, metadata and signatures use the same
file interface. Execution and installation behavior remain with your project.

## Reference

### Publishing

**API:** <a id="inputs"></a>[Inputs](docs/publishing.md#inputs) · <a id="outputs"></a>[Outputs](docs/publishing.md#outputs) · <a id="permissions"></a>[Permissions](docs/publishing.md#permissions)

**Release notes:** <a id="release-note-modes"></a>[Modes](docs/publishing.md#release-note-modes) · <a id="preset-gallery"></a>[Presets](docs/publishing.md#preset-gallery) · <a id="default-classification"></a>[Classification](docs/publishing.md#default-classification) · <a id="configuration"></a>[Configuration](docs/publishing.md#configuration)

**Notes options:** <a id="input-combinations"></a>[Input combinations](docs/publishing.md#input-combinations) · <a id="pull-request-and-hybrid-evidence"></a>[PR and hybrid evidence](docs/publishing.md#pull-request-and-hybrid-evidence) · <a id="preview"></a>[Preview](docs/publishing.md#preview) · <a id="file-notes"></a>[File notes](docs/publishing.md#file-notes)

**Publication policy:** <a id="range-selection"></a>[Range selection](docs/publishing.md#range-selection) · <a id="existing-release-bodies"></a>[Existing release bodies](docs/publishing.md#existing-release-bodies) · <a id="release-lifecycle-guarantees"></a>[Lifecycle guarantees](docs/publishing.md#release-lifecycle-guarantees) · <a id="bounded-execution"></a>[Limits](docs/publishing.md#bounded-execution) · <a id="releases-without-assets"></a>[Releases without assets](docs/publishing.md#releases-without-assets)

**Compatibility:** <a id="early-0x-contract-break"></a>[Early 0.x changes](docs/publishing.md#early-0x-contract-break)

<a id="version-series-and-release-preparation"></a>

### Version preparation

See the [`prepare` guide](prepare/README.md) for automatic versioning, version-series
boundaries, plan/resume, existing-tag resolution and explicit tag binding.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks, CI platforms and exact-candidate
release acceptance. The [distribution fixture guide](https://github.com/releaseway/release-fixture/tree/main/distribution-fixtures)
covers public source and Pages acceptance separately.

## License

[MIT](LICENSE)
