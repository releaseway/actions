# Prepare distribution files

Select files produced by any build tool, verify their bytes, and return a new
static directory. This action does not execute scripts or upload to a host.

```yaml
- id: files
  uses: releaseway/actions/distribute@<full-sha>
  with:
    files: |
      dist/install.sh
      dist/diagnose.ps1
# Pass steps.files.outputs.path to your existing deployment step.
```

`files` accepts relative files, directories, `*`, `?`, and `**` patterns. Each
pattern must match. The static directory prefixes determine the common public
root; `dist/*` and `dist` publish the contents of `dist`. Hidden path segments
must be explicitly named. `root` overrides the source root and retains paths
relative to that directory. User paths always use `/`, including on Windows.

Add `tag` for an exact public github.com Release. `repository` defaults to the
caller repository; override it only for another public source. The read token
defaults to `github.token` and needs `contents: read`. Assets must have GitHub
SHA-256 digests. `verification: attested` additionally requires signed Release
verification supported by the installed `gh`; it fails if verification is missing.
`commit` optionally checks the full tag commit SHA. Local files need no `gh` or
API permissions. The runner must support Node24 JavaScript actions.

Use `config` instead of `files` only when renaming is needed:

```yaml
schema: 1
files:
  - from: dist/product-installer.sh
    to: install.sh
  - from: dist/updates.json
    to: updates/latest.json
```

Config `from` names an exact regular local file or exact Release asset; there
is no glob expansion. The schema is [config.schema.json](config.schema.json).
Duplicate/unknown keys, YAML anchors, aliases, and nesting beyond 16 levels are
rejected. Config paths are relative to the caller workspace; local `from` paths
are workspace/root relative. Public `to` paths remain independent of `root`.

`destination` adds a public prefix. `site` supplies an existing static build;
the action copies it without modifying the original. Equal bytes are accepted;
a differing selected target fails unless `conflict: replace` is explicit.
Replacements affect only selected files. To combine products, use the preceding
output `path` as the next invocation's `site`. Retention covers supplied baseline
files only: the action does not retrieve past deployments or prune old files.

Outputs are `path`, separate JSON `report`, and `digest`. The digest identifies
sorted final paths, sizes, and SHA-256 values, including baseline files. It omits
source provenance, timestamps, and permissions. Reports distinguish copied
bytes, observed Release snapshots, and signed verification; a digest alone is
not a signature or proof of a reproducible build.

POSIX local execute bits are preserved; remote files use `0644`. Windows mode is
advisory. Archive files are opaque and are never extracted. Symlinks, special
files, `.git` segments, and nonportable public path collisions are rejected.

Defaults: 1 GiB per file, 2 GiB final output, 10,000 selected files, 100,000 final
files, and a ten-minute processing deadline. Advanced `max-file-bytes` and
`max-total-bytes` accept positive integers up to 8 GiB. Output is published only
after every file succeeds; failed staging is removed and inputs stay unchanged.

## Optional GitHub Pages workflow

Call the reusable workflow at job level when these files form the entire site:

```yaml
permissions:
  contents: read
  actions: read
  deployments: read
  pages: write
  id-token: write
jobs:
  distribute:
    uses: releaseway/actions/.github/workflows/distribute-pages.yml@<full-sha>
    with:
      files: install.sh
```

With no `tag` or `artifact-id`, it resolves the latest stable public Release
inside the Pages concurrency lock. `tag` selects an exact Release;
`artifact-id` accepts the immutable ID returned by a preceding same-run
`actions/upload-artifact` producer. These choices are mutually exclusive.
Use `needs` to wait for a producer job and pass its artifact ID. Source artifact
`files` paths are relative to its extracted root; a caller config is checked out
at the caller SHA and stays separate from the payload. Name dotfiles explicitly
and opt into `include-hidden-files: true` in the producer upload when necessary.

Enable Pages with Actions as its source before calling this workflow. The
workflow preserves your domain and `github-pages` environment restrictions;
it never enables Pages or changes environment protections. PR and merge-group
callers cannot publish. For existing documentation sites, use the direct Action
with `site` and your existing deploy step instead of replacing the whole site.

The workflow returns `page-url`, `content-digest`, `delivery-digest`,
`report-artifact-id`, and `deployment-id`. The last value is the GitHub
**environment deployment** matched by exact run/job status URL, not an
undocumented output or internal Pages deployment identifier. The report artifact
expires after one day. Pages delivery adds an empty `.nojekyll`, preserves
explicit hidden files, and rejects `.github` because the official packager always
excludes it. It checks the archive membership before deploying and verifies
actual served bytes afterward.

Do not also acquire the `pages` concurrency group in the caller: the reusable
workflow already holds it. Running deployments are preserved; a newer pending
run may replace an older pending run. Latest supersession requires rerunning the
entire workflow. For other failures, a deploy-job rerun can reuse retained producer
artifacts; expired/missing artifacts require a full rerun. A failed post-deploy
verification may leave the new site live. The summary records the actual URL and
environment deployment when available; there is no automatic rollback.

Same-run artifacts are extracted by the official download action with digest
mismatch set to error. The workflow checks compressed size before download,
uses a five-minute download timeout, and checks the extracted tree afterward.
It does not enforce an uncompressed disk bound during the official extraction.
Hosted Ubuntu and a Node24-capable Actions runner are required. A missing
`job.workflow_*` identity fails explicitly; GHES is outside this adapter's scope.
