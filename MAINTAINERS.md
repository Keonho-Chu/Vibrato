# Maintainers

Maintainers own the `Vibrato` repository: they review and merge pull requests,
cut releases from `main`, and are reachable for governance decisions.

## Roster

| GitHub | Role | Access |
| --- | --- | --- |
| [Keonho-Chu](https://github.com/Keonho-Chu) | Owner / maintainer | admin |
| [VIVA-cc](https://github.com/VIVA-cc) | Release approver | write |

Access is granted at the GitHub repository level. `admin` is reserved for the
repository owner. The release approver is the required reviewer on the
`npm-release` deployment environment; a release cannot publish until they
approve it, and the person who pushed the release tag cannot approve their own
deployment.

The GitHub **Contributors** panel is derived from commit history, which this
repository inherited from its upstream lineage (see [NOTICE.md](./NOTICE.md)).
Appearing there grants no repository access.

## Branch and release policy

- All pull requests target `dev`. `main` is reserved for maintainer-directed
  release flow; maintainers advance `dev` into `main` when cutting a release.
- `main` and `dev` are protected against deletion and force-push.
- Stable releases are cut with `bun run release <version>` from a clean `main`
  checkout; the script pushes the release commit and the immutable `v<version>`
  tag atomically. Release tags are never retagged, deleted, or force-pushed.
- See [CONTRIBUTING.md](./CONTRIBUTING.md) for the contribution flow and the
  changelog rules that apply to every PR.
