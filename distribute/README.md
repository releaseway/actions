# Prepare distribution files

Select files produced by any build tool, verify their bytes, and return a new
static directory for your existing publisher. Installers, bootstrap or diagnostic
scripts, application files, JSON and signatures use the same interface. The action
does not generate installers, execute scripts, extract archives, or upload to a host.

Available in [v0.5.1](https://github.com/releaseway/actions/releases/tag/v0.5.1).
Use `7427110b565bedef79ab0f80e6821a706d7f21ed` for both the step action and the
optional Pages workflow. All entry points in `releaseway/actions` share this version.

## Prepare local files

Save this as `.github/workflows/distribute.yml` in your repository, then dispatch
it from Actions. The sample creates two files so it can run without a project-specific
build tool. Replace that step with your own build once the sample works.

```yaml
name: Prepare distribution files
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  prepare:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Produce sample files
        run: |
          mkdir -p dist
          printf '#!/bin/sh\nprintf "ready\\n"\n' > dist/diagnose.sh
          printf '{"schema":1}\n' > dist/metadata.json
      - id: files
        uses: releaseway/actions/distribute@7427110b565bedef79ab0f80e6821a706d7f21ed # v0.5.1
        with:
          files: dist/*
      - name: Check prepared files
        env:
          DISTRIBUTION_PATH: ${{ steps.files.outputs.path }}
          DISTRIBUTION_REPORT: ${{ steps.files.outputs.report }}
        run: |
          cmp dist/diagnose.sh "$DISTRIBUTION_PATH/diagnose.sh"
          cmp dist/metadata.json "$DISTRIBUTION_PATH/metadata.json"
          test -s "$DISTRIBUTION_REPORT"
```

Success means both comparisons pass and the report exists. Pass `outputs.path`
to your upload command or existing deployment action; preparation does not publish
it. The report is outside the payload directory. You do not need to check out the
Releaseway repository or use `./distribute` in a consumer repository.

The runner must support Node24 JavaScript actions. Local preparation requires
no `gh`, generator installation or API permission; the checkout above uses
`contents: read`. Local inputs must already exist when the step starts.

## Read public GitHub Release assets

Add `tag` to read assets from an exact published Release in the caller repository.
For example, after publishing assets named `install.sh` and `updates.json` under
`v1.2.3`, use this step in a job with `contents: read`:

```yaml
- id: files
  uses: releaseway/actions/distribute@7427110b565bedef79ab0f80e6821a706d7f21ed # v0.5.1
  with:
    tag: v1.2.3
    files: |
      install.sh
      updates.json
```

`repository` defaults to the caller repository; override it only for another
public source. `tag` is literal, so `tag: latest` means a tag named `latest`.
Exact prerelease tags are supported. This action never implicitly selects the
latest Release. Private repositories, drafts and assets without GitHub SHA-256
digests are rejected. Downloaded bytes and the before/after Release/tag snapshot
are verified; observed metadata is not a guarantee that a Release is immutable.

The runner needs `gh`. The read token defaults to `github.token` and is passed
explicitly to `gh` on github.com. Local `gh` login state is not a substitute for
an empty token. `verification: attested` additionally requires signed Release
verification supported by the installed `gh`; it fails if verification is missing.
`commit` can require a full expected tag commit SHA. Remote-only preparation does
not need a caller checkout unless a local `config` or `site` is used.

## Select public paths

`files` accepts relative files, directories, `*`, `?`, and standalone `**` path
segments. Every pattern must match and the selection must contain regular files.
Negation, braces, character classes and extglobs are rejected. User paths always
use `/`, including on Windows.

Without `root`, fixed directory prefixes in the requests determine the common
public root. This does not change when a glob matches more files:

| Selection | Prepared paths |
| --- | --- |
| `dist/*` or directory `dist` | Contents of `dist`, without its prefix |
| `dist/a/install.sh` and `dist/b/install.sh` | `a/install.sh` and `b/install.sh` |
| `root: dist` with `files: a/install.sh` | `a/install.sh` |
| `root: .` with `files: dist/install.sh` | `dist/install.sh` |

Hidden path segments must be explicitly named; a directory or broad glob does
not select them automatically. Use `root: .` to retain their parent path, for
example `files: .well-known/info.json`. Baseline `site` trees include hidden files.

Use `config` instead of `files` when names must change. Save this example as
`.github/distribution.yml`, ensure the two source files exist, and pass
`config: .github/distribution.yml`:

```yaml
schema: 1
files:
  - from: dist/product-installer.sh
    to: install.sh
  - from: dist/updates.json
    to: updates/latest.json
```

Config `from` names an exact regular local file or exact Release asset; there
is no glob expansion. For Release sources use flat asset names such as
`product-installer.sh`, without a `dist/` prefix. The schema is
[config.schema.json](config.schema.json). Duplicate/unknown keys, YAML anchors,
aliases and nesting beyond 16 levels are rejected. Config paths are relative to
the caller workspace; local `from` paths are workspace/root relative. Public `to`
paths remain independent of `root`. `files` and `config` are mutually exclusive.

## Merge into an existing site

`destination` adds a public prefix. `site` supplies an existing static build;
the action copies it without modifying the original. After your build has created
`website/dist` and `dist/bootstrap`, a step can use:

```yaml
- id: files
  uses: releaseway/actions/distribute@7427110b565bedef79ab0f80e6821a706d7f21ed # v0.5.1
  with:
    files: dist/bootstrap/*
    destination: tools/tool-a/v1.2.3
    site: website/dist
```

Publish the returned `path` using your existing site deployment. Equal bytes at
the same target are accepted; differing bytes fail unless `conflict: replace` is
explicit. Replacements affect only selected files. To combine products or sources,
use the preceding output `path` as the next invocation's `site`. Retention covers
supplied baseline files only: the action does not retrieve past deployments,
prune old files, or preserve versions absent from the baseline.

## Step action reference

| Input | Default | Meaning |
| --- | --- | --- |
| `files` | Empty | Newline-separated relative paths or patterns; exactly one of `files` or `config` is required. |
| `config` | Empty | Caller workspace-relative YAML/JSON v1 file with exact `from`/`to` mappings. |
| `tag` | Empty: local source | Exact published public github.com Release tag. |
| `repository` | Caller repository | Public `owner/name`; Release source only. |
| `commit` | Empty | Full expected tag commit SHA; Release source only. |
| `token` | Caller `github.token` | Read token for Release APIs; unused for local files. |
| `verification` | `digest` | `digest`, or `attested` for Release sources. |
| `root` | Workspace, with common public prefix removed | Optional local root; supplied roots retain paths relative to that directory. Rejected for Release sources. |
| `destination` | Empty | Public path prefix. |
| `site` | Empty | Existing baseline directory, workspace-relative or absolute. |
| `conflict` | `error` | `error` or `replace` for selected baseline targets. |
| `max-file-bytes` | `1073741824` | Positive integer, at most 8 GiB. |
| `max-total-bytes` | `2147483648` | Positive integer for final output, at most 8 GiB. |

| Output | Meaning |
| --- | --- |
| `path` | New completed directory for a subsequent publisher. |
| `report` | Separate schema-1 JSON inventory and source verification report. |
| `digest` | SHA-256 of sorted final paths, sizes and file hashes, including baseline files. |

The content digest omits provenance, timestamps and permissions. Reports distinguish
copied bytes, observed Release snapshots and signed verification; a digest alone
is not a signature or proof of a reproducible build. POSIX local execute bits are
preserved; remote files use `0644`. Windows mode is advisory. Symlinks, special
files, `.git` segments, Windows device names, case/Unicode-normalized collisions,
and file/directory target conflicts are rejected.

Limits: 10,000 selected files, 100,000 final files, a 256 KiB config, a 32 MiB
report and a ten-minute processing deadline. Output is exposed only after every
file succeeds; failed staging is removed and inputs stay unchanged.

## Optional GitHub Pages workflow

Use the reusable workflow at job level when the selected files form the entire
site. First enable Pages with **GitHub Actions** as its source and allow the
calling ref in the `github-pages` environment. The workflow never enables Pages,
changes your domain, or changes environment protections. Callers must use a trusted
`push`, `release`, or `workflow_dispatch` event; PR and merge-group calls cannot
publish. Hosted Ubuntu and a Node24-capable Actions runner are required; GHES is
outside this adapter's scope.

For an existing documentation site, use the step action with `site` and your
existing deploy step. This convenience workflow deploys the complete selected site.

### Publish assets from the latest stable Release

Save this workflow in your repository. Its latest stable Release must already
contain an asset named `install.sh`; it reads no local build output.

```yaml
name: Distribute Release files to Pages
on:
  workflow_dispatch:
permissions:
  contents: read
  actions: read
  deployments: read
  pages: write
  id-token: write
jobs:
  distribute:
    uses: releaseway/actions/.github/workflows/distribute-pages.yml@7427110b565bedef79ab0f80e6821a706d7f21ed # v0.5.1
    with:
      files: install.sh
```

With no `tag` or `artifact-id`, the workflow resolves the latest stable public
Release inside its Pages concurrency lock. Add `tag: v1.2.3` for an exact Release;
`tag` and `artifact-id` cannot be combined. `repository` can override the public
Release source. An environment that allows only `main` will reject a caller run
from a tag; dispatch from an allowed branch and supply the source `tag` instead.

### Publish generated files from the same workflow run

A producer uploads its build output and passes the returned immutable artifact
ID to the Pages job. This complete sample publishes `index.html` and `metadata.json`:

```yaml
name: Distribute generated files to Pages
on:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-24.04
    outputs:
      artifact-id: ${{ steps.upload.outputs.artifact-id }}
    steps:
      - name: Produce sample files
        run: |
          mkdir -p dist
          printf '<!doctype html><title>Distribution ready</title>\n' > dist/index.html
          printf '{"schema":1}\n' > dist/metadata.json
      - id: upload
        uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with:
          name: distribution-source
          path: dist/
          if-no-files-found: error
  distribute:
    needs: build
    permissions:
      contents: read
      actions: read
      deployments: read
      pages: write
      id-token: write
    uses: releaseway/actions/.github/workflows/distribute-pages.yml@7427110b565bedef79ab0f80e6821a706d7f21ed # v0.5.1
    with:
      artifact-id: ${{ needs.build.outputs.artifact-id }}
      files: '*'
```

Source `files` paths are relative to the artifact's extracted root, so the sample
uses `*`, not `dist/*`. Include `include-hidden-files: true` in the producer upload
when dotfiles are needed, and name those paths explicitly in the consumer selection.
A caller `config` is checked out at the caller SHA and remains separate from the
payload; its `from` paths use the extracted root. Only one artifact ID from the
current repository/workflow run is accepted. Cross-run/repository artifacts are
not supported; use public Release assets or the step action for those sources.
Artifact metadata records producer run/SHA identity, not build reproducibility.

### Workflow reference and recovery

| Input | Default | Meaning |
| --- | --- | --- |
| `files` | Empty | Release asset patterns or artifact-relative paths; exactly one of `files` or `config`. |
| `config` | Empty | Caller workspace-relative exact mapping policy. |
| `tag` | Empty | Exact public Release tag; omit with `artifact-id`. |
| `artifact-id` | Empty | Same-run immutable source artifact ID; omit with `tag`. |
| `repository` | Caller repository | Public Release override; rejected for artifact sources. |
| `verification` | `digest` | `attested` is available only for Release sources. |

The workflow does not expose the step action's `site`, `root`, `destination`,
`conflict`, `commit`, `token`, or byte-limit inputs. Use exact mappings for public
layout, or the step action with your own publisher when those controls are needed.

| Output | Meaning |
| --- | --- |
| `page-url` | Actual deployed Pages URL. |
| `content-digest` | Prepared payload identity before Pages additions. |
| `delivery-digest` | Final payload identity including `.nojekyll`. |
| `report-artifact-id` | Immutable delivery report artifact ID, retained for one day. |
| `deployment-id` | GitHub **environment deployment** ID matched to the exact run/job, not an internal Pages deployment identifier. |

Pages delivery adds an empty `.nojekyll` (a nonempty input is rejected), preserves
explicit hidden files, and rejects `.github` because the official packager excludes
it. It checks exact archive membership before deploying and hashes actual served
bytes afterward. Sites and archives are limited to 1,000,000,000 bytes, including
tar overhead for the archive. A missing `job.workflow_*` identity fails explicitly.

Do not acquire the `pages` concurrency group in the caller: the reusable workflow
already holds it. Running deployments are preserved; a newer pending run may
replace an older pending run. Latest supersession requires rerunning the entire
workflow. A deploy-job rerun can otherwise reuse retained producer artifacts;
expired/missing artifacts require a full rerun. Failed post-deploy verification
may leave the new site live. The summary records the URL, environment deployment
and actual delivery state; there is no automatic rollback.

Same-run artifacts use the official download action with digest mismatch set to
error. Compressed input size is limited to 2 GiB before download, the download has
a five-minute timeout, and the extracted tree is checked afterward. There is no
uncompressed disk bound enforced during the official extraction.

[Local workflow](../examples/distribution-local.yml) ·
[Release workflow](../examples/distribution-release.yml) ·
[Pages Release workflow](../examples/distribution-pages.yml) ·
[Pages artifact workflow](../examples/distribution-pages-artifact.yml)
