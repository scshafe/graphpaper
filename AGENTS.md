# @scshafe/graphpaper Agent Contract

A managed library under the SCSHAFE library standard (`scshafe-library` v1).
It is published to GitHub Packages and deploys nothing. Read `README.md`,
`index.d.ts` and the `DESIGN-SCOPE-*.md` notes before meaningful changes.

## Invariants

- Framework-agnostic and dependency-free at runtime: `src/index.js` imports
  nothing. `elkjs` stays an optional peer (`window.ELK` or the
  `layoutEngine` option); without it the built-in layered fallback lays out.
  Never add a runtime dependency.
- DOM safety: the renderer hydrates untrusted models and never assigns
  `.innerHTML`; markup is validated and swapped as parsed DOM
  (`test/dom-safety.test.mjs` enforces this).
- Every option is off by default; with an option absent the rendered markup
  stays byte-identical to what it was before the option existed.
- `index.d.ts` is hand-written and ships as the `types` condition; keep it in
  step with `src/index.js` exports (`pnpm run typecheck`, the TS smoke).
- No build step: `src/`, `index.d.ts` and `diagram.css` ship as written
  (`pnpm run build` is a no-op the release scripts call; `clean` removes
  nothing).
- Toolchain is pnpm, pinned by `packageManager` (`pnpm@10.34.5`), with
  `pnpm-lock.yaml` committed and `strictDepBuilds: true`. Do not add
  `package-lock.json`.
- `.npmrc` holds only `@scshafe:registry=https://npm.pkg.github.com`. Never
  commit a credential, `_authToken` line or token to any file.
- The payload is the `files` whitelist in `package.json`; the release manifest
  `release/scshafe-graphpaper-<version>.payload.sha256` pins every packed
  file's sha256. A payload change (including `package.json`, `README.md` or
  `CHANGELOG.md`) needs `pnpm run release:manifest` in the same commit.
- `scripts/*.mjs` other than `scripts/release.config.mjs` are verbatim copies
  of scshafe-dev's master release scripts, and `ci.yml`/`publish.yml` are the
  master's renders. Do not edit them here; change `release.config.mjs`, or
  change the master and re-sync (`dev check --diff`). The packed-install
  smokes are `test/smoke/` (base, no `elkjs`) and `test/smoke/elk/` (the
  optional-peer phase); `elkjs` is pinned for them as an exact devDependency.
- Consumer and smoke imports use the scoped specifiers `@scshafe/graphpaper`
  and `@scshafe/graphpaper/diagram.css`. The unscoped `graphpaper` on
  registry.npmjs.org is an unrelated package.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm run verify             # tests, typecheck, payload, release bytes, packed install
pnpm run test:fresh-clone   # clean committed HEAD only: clone, install, verify
```

CI (`.github/workflows/ci.yml`) runs the same `verify` on the Node matrix in
`engines` on GitHub-hosted runners. Libraries never use a self-hosted runner.

## Releasing

- SemVer; `package.json` `version` is the authority. A release commit bumps
  the version, adds `## <x.y.z> — <date>` to `CHANGELOG.md` and regenerates
  the release manifest.
- After `ci.yml` is green on `main`, the owning agent pushes the annotated tag
  `v<x.y.z>` on that `main` commit. `.github/workflows/publish.yml` is the only
  publisher: it refuses tags not on `main` or not equal to the version,
  verifies, publishes, installs the published version back, compares
  integrity, and creates the GitHub Release with the digests.
- Never run `pnpm publish` by hand, never reuse, move or delete a tag or a
  published version. A bad release is superseded by a higher patch version
  with a changelog note.
- No prereleases in v1; co-development with consumers uses `pnpm link`, which
  must never be committed in a consumer.

## Agent identity

This repository has its own agent user, `agent-graphpaper`, on the owner's Arch
workstation (scshafe/infra `docs/platform/agent-identity.md`). It works in its
own clone and commits and opens PRs as `scshafe-agent[bot]`. The broker gives it
one-hour tokens for `scshafe/graphpaper` only, declared in `dev.toml
[identity]`. Other projects are reachable only through their public code or an
issue on their repository.

<!-- scshafe-dev:begin landing -->
## Verify and landing

Managed by scshafe-dev: `dev adopt` and `dev update` refresh this section from `dev.toml`; change `dev.toml`, not these lines.

Before finishing, both of these must pass:

```sh
pnpm run verify
dev check .
```

How a change lands:

1. Work on a branch and open a PR.
2. Run the two commands above. If the repository is private, GitHub Actions does not run for it: verify locally and say in the PR what you ran. If it is public, wait for CI to be green.
3. Merge your own PR with a merge commit, one change at a time: `gh pr merge <N> --merge --subject "Merge #<N>: <title>"`. Never squash or rebase (both are off on the repository), and pass `--subject`: `gh pr merge` does not make the `Merge #N: <title>` subject by itself.

The project's agent may merge its own PR and push `main`; there is no approval gate.
<!-- scshafe-dev:end landing -->
