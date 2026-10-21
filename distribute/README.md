# Prepare distribution files

Select files produced by any build tool, verify their bytes, and return a new
static directory for your existing publisher. Installers, bootstrap or diagnostic
scripts, application files, JSON and signatures use the same interface. The action
does not generate installers, execute scripts, extract archives, or upload to a host.

Replace `<actions-sha>` with the full commit SHA of your selected
[release](https://github.com/releaseway/actions/releases), and resolve third-party
SHA placeholders as described in the [reference guide](../docs/action-references.md).
Use the same actions SHA for the step action and optional Pages workflow.

This guide describes its checkout. Read it at the selected ref before copying an
example. [Collecting several Releases](#collect-several-releases) requires schema 2
support; merging a documentation artifact through Pages also requires
`site-artifact-id`. Confirm both in that ref's schema and workflow inputs. Use a
reviewed source commit for candidate evaluation when no published release supports
the required interface.

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
      - uses: actions/checkout@<checkout-sha>

      - name: Produce sample files
        run: |
          mkdir -p dist
          printf '#!/bin/sh\nprintf "ready\\n"\n' > dist/diagnose.sh
          printf '{"schema":1}\n' > dist/metadata.json

      - id: files
        uses: releaseway/actions/distribute@<actions-sha>
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
it.

The report is outside the payload directory. You do not need to check out the
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
  uses: releaseway/actions/distribute@<actions-sha>
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
  uses: releaseway/actions/distribute@<actions-sha>
  with:
    files: dist/bootstrap/*
    destination: tools/tool-a/v1.2.3
    site: website/dist
```

Publish the returned `path` using your existing site deployment. Equal bytes at
the same target are accepted; differing bytes fail unless `conflict: replace` is
explicit. Replacements affect only selected files. To combine products or sources,
use the preceding output `path` as the next invocation's `site`.

Retention covers
supplied baseline files only: the action does not retrieve past deployments,
prune old files, or preserve versions absent from the baseline.

<a id="collect-several-releases-unreleased"></a>

## Collect several Releases

Collect a version family into one site without a release-list job, matrix or
artifact merge. The step action and Pages workflow both read a schema 2 policy.
Keep the policy in your repository and pin a ref with the required schema support.

### Choose the versions and files

Publish `bootstrap.sh` and `diagnose.ps1` on the public repository's v1.x Releases.
`metadata.json` is optional. Save the following as
`.github/distribution/release-set.json`, or copy the
[sample policy](../examples/distribution-release-set.json):

```json
{
  "schema": 2,
  "releases": {
    "tag-prefix": "v",
    "range": ">=1.0.0 <2.0.0",
    "include-prereleases": false,
    "on-empty": "skip"
  },
  "files": [
    {"from": "bootstrap.sh", "to": "install.sh", "required": true},
    {"from": "diagnose.ps1", "to": "install.ps1", "required": true},
    {"from": "metadata.json", "to": "metadata.json", "required": false}
  ],
  "aliases": {
    "select": "highest-stable",
    "files": [{"from": "install.sh", "to": "install.sh"}, {"from": "install.ps1", "to": "install.ps1"}]
  }
}
```

With complete v1.0.0 and v1.1.0 Releases, the result includes
`v1.0.0/install.sh`, `v1.1.0/install.sh` and root `install.sh`. The root alias is
a verified copy from v1.1.0. These paths are relative to the site's base URL,
including a repository prefix on project Pages sites. A later v1.2.0 rebuild
retains the selected v1.0.0/v1.1.0 paths and moves the alias to v1.2.0.

The range uses SemVer after removing the exact `tag-prefix`. Only canonical
versions match; build metadata (`+...`) is excluded. Drafts never match.
`include-prereleases` defaults to false and excludes either a GitHub prerelease
flag or a SemVer prerelease. Set it to true to include both stable and prerelease
versions using SemVer's `includePrerelease` range evaluation. `highest-stable`
uses the greatest SemVer with neither prerelease marker; it does not use GitHub's
global latest pointer or infer release-series boundaries from Git history.

For exact or non-SemVer tags, replace `releases` and `aliases` with these fields,
keeping `schema` and `files` above:

```yaml
releases:
  tags: [v1.0.0, v1.1.0]
  on-empty: skip

aliases:
  tag: v1.1.0
  files:
    - from: install.sh
      to: install.sh
```

Explicit tags may include published prereleases. Missing or draft tags fail.
Use either `tags` or `tag-prefix`/`range`. Alias `tag` must be selected;
`select: highest-stable` requires a range. Alias `from` names a required file's
mapped `to`, and alias `to` names its public destination. An alias whose chosen
Release has no files fails; there is no fallback to an older complete Release.

Files use exact flat asset names and exact portable relative destinations.
`required` defaults to true, and at least one file must be required. With
`on-empty: skip`, a Release with none of the configured asset names is reported
as `skipped-empty`. If any configured asset is present but a required asset is
missing, preparation fails. The default `on-empty: error` rejects empty Releases.
No matching Releases, or all Releases skipped, also fails even with a site baseline.
Globs, filename templates and regular expressions are not supported in schema 2.

### Merge with your documentation build

The [complete step workflow](../examples/distribution-release-set.yml) builds
sample documentation, prepares the Releases with `site: website/dist`, checks
the output and uploads the resulting site for your existing publisher. Replace
the sample build with your own tool. One invocation creates one verified directory;
it never executes the downloaded installers.

For Pages, use the [complete documentation workflow](../examples/distribution-pages-release-set.yml).
It uploads the documentation once and passes its immutable artifact ID as
`site-artifact-id`, together with the checked-in config. The workflow copies the
whole documentation tree, including uploaded hidden files, then adds the version
files and aliases. Success returns the deployed `page-url`, report artifact and
environment deployment ID after checking the actual served bytes.

The documentation artifact must be from the caller repository and current run.
Its ID, run head SHA, expiry and archive digest are checked separately from the
Release source. A public `repository` override changes only the Release source.
Policy is always checked out at the caller SHA; a config inside the documentation
artifact is not used as policy. Do not combine schema 2 with `files`, `tag`,
payload `artifact-id`, local `root` or single-tag `commit`. `site-artifact-id` is
available only with schema 2. Pages keeps the existing permissions, environment
requirements and `pages` concurrency group.

### Retention, reports and recovery

Retention is the set selected on each rebuild plus the supplied baseline.
Keep old Releases, assets and selector coverage to preserve their URLs with a
fresh documentation build. Deleting or replacing source assets, narrowing the
range, or supplying a different baseline can change the result. No previous
deployment is fetched and no permanent archive is promised. `conflict: replace`
on the step action replaces only selected baseline targets; Pages uses the default
conflict error, so keep documentation paths separate from installer paths.

Schema 2 reports keep the policy and its digest, candidate tags/commits and
Release/asset IDs, selected/skipped status, each file's source and aliases'
`aliasOf` version paths. The baseline records `local-site` or the exact workflow
artifact/run/SHA/digest. See [config.schema.json](config.schema.json) and
[report.schema.json](report.schema.json); runtime checks also validate paths,
digests and references. Schema 1 input still produces schema 1 reports. Output
names and the content digest algorithm are unchanged; Pages reports also retain
the pre-delivery digest and include its empty `.nojekyll` in the delivery digest.

Membership, tag commits, flags and configured asset snapshots are rechecked before
preparation succeeds and before/after Pages served verification. A source change
or `superseded` selection requires a full rerun. Snapshot checks observe GitHub
at separate times; they are not an atomic or permanent source guarantee. If a
post-deploy check fails, the new site may already be live (`deployed-unverified`);
inspect the summary and rerun the whole workflow after resolving the source change.
Missing or expired artifacts also require a full rerun. There is no automatic rollback.

The existing global byte/file limits and ten-minute core deadline cover all
Releases, baseline files and alias copies together. Listing is bounded to twenty
pages of 100 Releases and fails when completeness cannot be established. Temporary
disk use includes downloaded originals, the copied site, extracted documentation
and Pages packaging. Pages retains its 1,000,000,000-byte site/archive limit;
link large packages directly to GitHub Releases when the site would exceed it.
Version menus and generated download-index pages are outside this feature.

## Step action reference

| Input | Default | Meaning |
| --- | --- | --- |
| `files` | Empty | Newline-separated relative paths or patterns; exactly one of `files` or `config` is required. |
| `config` | Empty | Caller workspace-relative YAML/JSON schema 1 mappings or schema 2 release-set policy. |
| `tag` | Empty: local source, or v2 Release set | Exact published public github.com Release tag; rejected with schema 2. |
| `repository` | Caller repository | Public `owner/name`; Release source only. |
| `commit` | Empty | Full expected tag commit SHA; single Release only. |
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
| `report` | Separate schema-1 inventory, or schema-2 release-set inventory and provenance report. |
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

For an existing documentation site, pass `site-artifact-id` with a schema 2 policy
as shown in the [documentation merge example](#merge-with-your-documentation-build),
or use the step action with `site` and your existing publisher. This reusable
workflow deploys the complete merged site.

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
    uses: releaseway/actions/.github/workflows/distribute-pages.yml@<actions-sha>
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
        uses: actions/upload-artifact@<upload-artifact-sha>
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

    uses: releaseway/actions/.github/workflows/distribute-pages.yml@<actions-sha>
    with:
      artifact-id: ${{ needs.build.outputs.artifact-id }}
      files: '*'
```

Source `files` paths are relative to the artifact's extracted root, so the sample
uses `*`, not `dist/*`. Include `include-hidden-files: true` in the producer upload
when dotfiles are needed, and name those paths explicitly in the consumer selection.
A caller `config` is checked out at the caller SHA and remains separate from the
payload; its `from` paths use the extracted root.

Only one artifact ID from the
current repository/workflow run is accepted. Cross-run/repository artifacts are
not supported; use public Release assets or the step action for those sources.
Artifact metadata records producer run/SHA identity, not build reproducibility.

### Workflow reference and recovery

| Input | Default | Meaning |
| --- | --- | --- |
| `files` | Empty | Release asset patterns or artifact-relative paths; exactly one of `files` or `config`. |
| `config` | Empty | Caller workspace-relative schema 1 mappings or schema 2 release-set policy. |
| `tag` | Empty | Exact public Release tag; omit with `artifact-id`. |
| `artifact-id` | Empty | Same-run immutable source artifact ID; omit with `tag`. |
| `site-artifact-id` | Empty | Same-run documentation artifact baseline; schema 2 only. |
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
[Pages artifact workflow](../examples/distribution-pages-artifact.yml) ·
[Release-set workflow](../examples/distribution-release-set.yml) ·
[Pages documentation + release set](../examples/distribution-pages-release-set.yml)
