# Astering web frontend

Aster’s AI-integrated industrial system — projects, schedules, personal records and Arona in one workspace.

This Vue 3 frontend is part of [Astering](https://github.com/KanameMadoka520/Astering), maintained by KanameMadoka520. It builds on [Vikunja](https://vikunja.io/) and retains its AGPL-3.0-or-later license and contributor attribution. General project information and release instructions are in the [root README](../README.md).

## Project setup

```shell
pnpm install
```

## Local development

Copy `.env.local.example` to `.env.local` and set `DEV_PROXY` to an isolated development API, for example `http://127.0.0.1:3456`. Start the development frontend with:

```shell
pnpm run dev
```

`ASTERING_FRONTEND_BASE` sets an optional subpath, and `ASTERING_FRONTEND_PORT` sets the local frontend port. The existing `VIKUNJA_FRONTEND_BASE` and `VIKUNJA_FRONTEND_PORT` names remain supported when their Astering equivalents are absent. Existing browser login, drafts and preferences continue using their established storage keys.

To preview an existing local build, use `pnpm preview` and start the locally compiled API with `pnpm preview:astering`. `preview:vikunja` remains a compatibility alias.

## Local checks and production build

```shell
pnpm typecheck
pnpm lint
pnpm lint:styles
pnpm build
```

Run browser tests through the repository's `run-e2e-tests` skill and Mage, with an isolated database. Builds and releases are performed locally; this repository does not use GitHub Actions.

The branded SVG wordmarks and icon sizes can be rebuilt offline with `pnpm brand:assets`. The approved starlight logo, companion avatar and generation prompts live in `originalMedia/brand/`; the earlier product mascots have been replaced.

## License

[AGPL-3.0-or-later](../LICENSE). Upstream Vikunja and dependency copyrights remain in their respective files.
