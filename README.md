# dsh-web-search-multi-desktop

Desktop-profile twin of [`@dsh-external/dsh-web-search-multi`](../dsh-web-search-multi),
version-isolated so the Desktop install and the Web install can never move each
other.

The Web profile runs the local dsh checkout (**0.1.7-alpha.2**); the installed
Desktop app bundles dsh **0.2.0-rc.2**. Those are two different plugin hosts, so
one shared source tree cannot serve both.

## Why isolation is load-bearing, not cosmetic

dsh 0.2.0-rc.2's `dsh-app-boot` adds a peer-compatibility gate
(`evaluatePluginCompatibility`, `dsh-app-boot/lib/index.js:286-313`). For every
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` peer it requires:

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

A bundle that fails is skipped wholesale (`loadProfileDirectory` pushes it into
`profile.skippedBundles`; the loader row is then disabled) — the plugin does not
half-load, it disappears.

Measured on this machine with the app's own semver 7.8.5:

| peer range | `0.2.0-rc.2` |
| --- | --- |
| `^0.1.7-alpha.2` (Web twin) | **false** — caret normalizes to `>=0.1.7-alpha.2 <0.2.0-0` |
| `^0.2.0-rc.2` (this copy) | **true** |

So installing the Web package into the Desktop profile silently skips it. This
copy exists to carry the 0.2.0 line's peer range, its own package identity and
its own build.

`.recon/verify-desktop-copy.mjs` in the workspace asserts both directions: the
gate accepts this copy and rejects the Web twin.

## What differs from the Web twin

| | Web twin | This copy |
| --- | --- | --- |
| directory | `../dsh-web-search-multi` | `../dsh-web-search-multi-desktop` |
| package name | `@dsh-external/dsh-web-search-multi` | `@dsh-external/dsh-web-search-multi-desktop` |
| version | `0.0.1` | `0.2.0-desktop.1` |
| dsh peers | `^0.1.7-alpha.2` | `^0.2.0-rc.2` |
| build target | local 0.1.7 checkout | published 0.2.0-rc.2 packages |
| build deps | `scripts/ensure-links.mjs` junctions into the checkout | `scripts/ensure-links.mjs` only verifies installed 0.2.0-rc.2 versions |
| client bundle id | `...-multi` | `...-multi-desktop` |
| `dsh.client.inject` | 4 entries | 2 — the real prerequisites only |
| Plugins-page card | renders its own card in every view | honours the `plugins.item` view contract |
| Host source (`src/*.ts`, `src/composite.ts`, …) | — | **unchanged** |

`src/`'s Host half, `cordis.patch.yml`'s row id and the settings namespace stay
identical on purpose: the row id `web-search-multi` is what the browser half
binds its form to through `configForms.get('web-search-multi')`, and it is scoped
to one profile's composition, not to the package identity. Isolation lives in
the package name, version and code copy.

## Plugins-page card contract

`plugins.item` owns the row chrome. The plugin-manager's `ItemCard` renders the
registration's `label` as the card title and then calls the component back with
`view: "summary"` for the line printed underneath; the plugin's own page renders
the same title and one-liner and then asks for `view: "page"` for the form.
The Web twin ignored `view` and returned its own bordered `<li>` — complete with
a second copy of the title — in every case, so the list row showed the title
twice and nested a card inside its own description slot.

This copy returns the bare one-liner for `summary` and the form for `page`, the
same shape as the built-in `dsh-client-ui-settings-web-search` card. The unsaved
badge moved into the form footer so dirty state stays visible without the
dropped header.

The client bundle must be rebuilt after the rename: client-modules keys browser
bundles by **package name** and rejects a bundle that registers any other id
(`bundle <url> loaded without registering "<id>" via __ModuleLoader__.load`).

## Build

```bash
pnpm install                  # 0.2.0-rc.2 dsh devDependencies
pnpm run build:host           # tsc, against 0.2.0-rc.2 typings
pnpm run build:client         # tsdown -> lib/client.js
node tests/compatibility.test.mjs
```

`pnpm-workspace.yaml` pins `nodeLinker: hoisted` for local builds: under the
default isolated linker, Node's ESM loader in this environment does not
realpath the junctions, so tsdown cannot resolve its own `ansis`.

## Install into the Desktop profile

The Desktop app owns `$DSH_HOME/profiles/desktop`; stop it before touching that
profile.

1. `profiles/desktop/package.json`
   - `dependencies`: `"@dsh-external/dsh-web-search-multi-desktop": "link:<path to this repo>"`
   - `dsh.profile.bundles`: append `"@dsh-external/dsh-web-search-multi-desktop"`
2. `pnpm install` inside `profiles/desktop` (pnpm 11.7.0, the version the app bundles).
3. `profiles/desktop/cordis.patch.yml`:

```yaml
- id: web-search-multi
  name: "@dsh-external/dsh-web-search-multi-desktop"
  config:
    mode: exa
- id: web
  config:
    searchProvider: multi-search
    fetchProvider: http
```

Do **not** add an `insert:` for `web-search-multi`: the package's own bundle
patch inserts the row, and a second insert raises `WEB_DUPLICATE_PROVIDER`. The
`web` pin is required — dsh-base ships `searchProvider: deepseek-official`, and
with two usable providers and no pin the seam refuses to choose.

4. Restart the Desktop app. Changing a link target, the provider pin or Host
   code requires a restart; a client-only fix only needs a page reload.

## Verification

```bash
node .recon/verify-desktop-copy.mjs          # gate + host half + bundle id
node tests/compatibility.test.mjs            # settings-card behaviour
```

Then in the Desktop app: **Settings → Plugins → Multi-engine search** should
show the card, and `web_search` should route through the Multi-search provider
(`mode: exa` first, falling through per `failover`). Credentials are shared with
the Web profile through `$DSH_HOME/.credentials.yaml`, so the same keys apply.

## Rollback

Restore `profiles/desktop/cordis.patch.yml`, `package.json` and `pnpm-lock.yaml`
from their `*.bak-before-multi-search-desktop` copies, run `pnpm install`, and
restart. The Web profile is untouched by any of this.