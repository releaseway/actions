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
