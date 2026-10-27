# Development

Maintainer notes for changing and releasing ReviewBrief. People who only want reviews on their pull requests should follow the [README](README.md) and use `kadraman/reviewbrief@v1`.

## Reviewing changes in this repository

[`.github/workflows/reviewbrief.yml`](.github/workflows/reviewbrief.yml) uses `uses: ./`, so a pull request here runs the action from that branch. [`examples/reviewbrief.yml`](examples/reviewbrief.yml) is the file other repositories copy, and it stays pinned to `kadraman/reviewbrief@v1`.

Run the tests with Node.js 22.6 or newer:

```bash
npm test
```

## Releasing

`action.yml` is already at the repository root, `author` is `kadraman`, and the license is Apache-2.0. Consumers pin `kadraman/reviewbrief@v1`, so a release tag named `v1` is the ref those workflows run.

1. Merge the change to the default branch.
2. Create a GitHub release. Tag it `v1` when you want every existing `uses: kadraman/reviewbrief@v1` workflow to pick it up. For a patch release, tag the full version (for example `v1.2.3`) and move the `v1` tag to that commit.

## Publishing to the GitHub Marketplace

Listing requirements: this public repository, `action.yml` in the root, a unique action name, two-factor authentication on the publishing account, and acceptance of the Marketplace Developer Agreement.

Before listing, search the Marketplace, check that no GitHub user or organization owns the name, and search the web for existing products. The action name in `action.yml` is `reviewbrief`.

Create the release as above and tick **Publish this Action to the GitHub Marketplace**. The Marketplace install uses the same `kadraman/reviewbrief@v1` reference as the README.
