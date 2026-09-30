# Changelog

All notable changes to `@scshafe/graphpaper` are recorded here. Versions
follow [SemVer](https://semver.org/). A release is the annotated tag
`v<x.y.z>` on a commit on `main` whose `package.json` version is `<x.y.z>`;
published versions are never deleted, replaced or reused.

## 0.5.1 — 2026-09-29

First version published to GitHub Packages. No API or runtime behaviour change
from 0.5.0: `src/index.js`, `index.d.ts` and `diagram.css` are byte-identical
to 0.5.0 (commit `89240f1`); the payload adds `CHANGELOG.md` and `LICENSE`,
and `package.json` and `README.md` differ.

- Renamed to `@scshafe/graphpaper` and published to
  `https://npm.pkg.github.com`. Consumers replace the
  `git+ssh://…/graphpaper.git#<sha>` dependency with an exact
  `@scshafe/graphpaper` version, change `graphpaper` and
  `graphpaper/diagram.css` import specifiers to `@scshafe/graphpaper` and
  `@scshafe/graphpaper/diagram.css`, and map the `@scshafe` scope to GitHub
  Packages in their `.npmrc`. The unscoped `graphpaper` on registry.npmjs.org
  is an unrelated package.
- `repository.url` is the HTTPS GitHub URL (GitHub Packages requires it to
  match the repository).
- `engines.node` is `>=22.22.0 <23 || >=24.18.0 <25`, the Node lines CI tests.
- Toolchain: pnpm 10 (`packageManager: pnpm@10.34.5`, `pnpm-lock.yaml`)
  replaces npm.
- Release checks: an exact payload file set, a pinned per-file sha256 release
  manifest (`release/scshafe-graphpaper-0.5.1.payload.sha256`), pack-twice
  byte reproducibility, a path/token scan of the tarball, and JS plus
  TypeScript smoke imports from a packed install.

## 0.5.0

Node selection (`onNodeSelect`, `selectDiagramNode`,
`clearDiagramNodeSelection`, `selectedDiagramNodeId`). Consumed by git commit
`89240f1`; never published to a registry.

## 0.4.0

Node badges; edge labels carry their edge's kind and flavour. Git only.

## 0.1.0

First tagged version (`v0.1.0`), extracted from mission-control. Git only.
