# Astering Desktop

[![License: GPL-3.0-or-later](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

The Astering frontend packaged as an Electron desktop app. Astering is based on Vikunja; the original desktop wrapper copyright and GPL license remain intact.

Source and releases: [KanameMadoka520/Astering](https://github.com/KanameMadoka520/Astering). The root project uses AGPL-3.0-or-later; this wrapper retains its own [GPL-3.0-or-later license](LICENSE).

## Dev

As this package does not contain any code, only a thin wrapper around electron, you will need to do this to get the 
actual frontend bundle and build the app:

First, build the frontend:

```
cd ../frontend
pnpm install
pnpm run build
```

Then, copy the frontend to this directory:

```
cd desktop
cp -r ../frontend/dist frontend/
sed -i 's/\/api\/v1//g' frontend/index.html # Make sure to trigger the "enter the Astering URL" prompt
```

Then you can run the desktop app like this:

```
pnpm install
pnpm start
```

## Shared brand assets

After generating the frontend brand resources, run `pnpm brand:assets` here. This uses the frontend locked Sharp dependency and the final public `logo.png` to generate both desktop PNG icons and the macOS ICNS file (16 through 1024px PNG representations). The tray and package icons then use the same Astering star. It does not call image-generation services.

## Building for release

1. Run the snippet from above, but with a valid frontend version instead of `unstable`
2. Change the version in `package.json` (that's the one that will be used by electron-builder)
3. `pnpm install`
4. `pnpm run dist --linux --windows`

## License

This project is licensed under the GPL-3.0-or-later license. See the [LICENSE](LICENSE) file for details.

## Compatibility identifiers

The `vikunja-desktop` package name, `io.vikunja.desktop` application ID, `vikunja-desktop://callback` OAuth redirect, OAuth client ID, and `vikunjaDesktop` preload bridge remain compatibility identifiers. Do not rename them independently: existing installations, authentication callbacks and the frontend bridge rely on them. Product names, menus and repository links use Astering. Packaged builds explicitly retain the existing `Vikunja Desktop` profile directory, including session data; development retains the `vikunja-desktop` package directory. An explicit `--user-data-dir` override is respected. Branding does not reset login or preferences. See [brand migration](../docs/brand-migration.md).
