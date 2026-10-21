# Choose an Action reference

Choose a Releaseway release that supports the inputs you need, then pin its full
40-character commit SHA in your workflow. Each repository releases independently:

| Repository | Release history | Placeholder in examples |
| --- | --- | --- |
| `releaseway/actions` | [Releases](https://github.com/releaseway/actions/releases) | `<actions-sha>` |
| `releaseway/npm-actions` | [Releases](https://github.com/releaseway/npm-actions/releases) | `<npm-actions-sha>` |
| `releaseway/homebrew-actions` | [Releases](https://github.com/releaseway/homebrew-actions/releases) | `<homebrew-actions-sha>` |

## Fill in a workflow example

1. Open the repository's Releases page and select a release. Follow its commit
   link and copy the full commit SHA. For an annotated tag, use the commit it
   points to, rather than the tag object's SHA.
2. Read the README and guides at that tag or commit. Documentation on the default
   branch describes that checkout and can include features absent from a published
   release. Confirm the selected ref's action metadata, workflow inputs and config
   schema before using an advanced example.
3. Replace every matching placeholder with that literal SHA. For `actions`, use
   the same SHA for the root action, `prepare`, `distribute` and Pages workflow.
   Resolve third-party placeholders such as `<checkout-sha>` and
   `<upload-artifact-sha>` from those repositories' releases in the same way.
4. Save the completed workflow in your repository. Reusable workflow `uses`
   references must be literal; GitHub expressions cannot supply their ref.

The angle-bracket placeholders are substitution points, not runnable refs. Version
numbers in policy and output examples describe sample product data; `schema`
numbers identify file formats. Neither selects an automation release.

The [example workflows](../examples) retain concrete SHA pins for their reviewed
dependencies. Check those pins and the corresponding release or commit before
adopting a template. To evaluate a feature without a published release, select a
reviewed source commit that implements it and treat that selection as candidate
evaluation. A default-branch guide or successful candidate test does not establish
stable availability.

## Update an installed workflow

Review release notes and compatibility at the proposed commit before replacing
the workflow's pin. Dependabot can propose updates to SHA-pinned GitHub Actions.
Keep executable workflow dependencies pinned rather than using `main`, a moving
major tag or a runtime lookup in `uses`.

Keep publication identities and validation runs in release notes or acceptance
records. Those records describe a particular execution; they are not a list of
current dependency versions.
