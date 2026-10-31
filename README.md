# dsh-web-search-multi-desktop

DSH 桌面端（Desktop app）的多引擎搜索插件：`web_search` 在 Tavily / Exa /
DeepSeek 原生搜索之间按额度自动切换。**当前主线版本。**

包名带 `-desktop`，因为它只按桌面端内置的 dsh 线构建：peer 范围锁在
`^0.2.1-rc.1`，构建对照桌面端打包的 dsh **0.2.1-rc.2**。

Web 端的同名插件 `@dsh-external/dsh-web-search-multi`（跑 0.1.7-alpha.2
profile）**已弃用**，不再维护。下文保留的对比只解释"桌面端为什么必须独立成包"。

## Why isolation is load-bearing, not cosmetic

dsh 0.2.x's `dsh-app-boot` adds a peer-compatibility gate (first shipped in
0.2.0-rc.2): `evaluatePluginCompatibility`, `dsh-app-boot/lib/index.js:286-313`.
For every
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
| `^0.1.7-alpha.2` (retired Web build) | **false** — caret normalizes to `>=0.1.7-alpha.2 <0.2.0-0` |
| `^0.2.0-rc.2` (this line) | **true** |

> 上表是对 0.2.0-rc.2 做的历史测量；0.2.1 线沿用同一条 caret 规则。

把 0.1.7 线的包装进 Desktop profile 会被静默跳过，所以桌面端这份必须自带
0.2.x 的 peer 范围、自己的包身份和自己的构建产物。

`../.recon/verify-desktop-copy.mjs`（工作区内，不在本仓库）对此断言两个方向：
闸门接受本包、拒绝 0.1.7 线的包。

## What differs from the retired Web build

| | retired Web build | this package |
| --- | --- | --- |
| directory | — (removed from disk) | `../dsh-web-search-multi-desktop` |
| package name | `@dsh-external/dsh-web-search-multi` | `@dsh-external/dsh-web-search-multi-desktop` |
| version | `0.0.1` | `0.2.1-desktop.1` |
| dsh peers | `^0.1.7-alpha.2` | `^0.2.1-rc.1` |
| build target | local 0.1.7 checkout | published 0.2.1-rc.2 packages |
| build deps | `scripts/ensure-links.mjs` junctions into the checkout | `scripts/ensure-links.mjs` only verifies installed 0.2.1-rc.2 versions |
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
The retired Web build ignored `view` and returned its own bordered `<li>` — complete with
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
pnpm install                  # 0.2.1-rc.2 dsh devDependencies
pnpm run build:host           # tsc, against 0.2.1-rc.2 typings
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
(`mode: exa` first, falling through per `failover`). Credentials come from
`$DSH_HOME/.credentials.yaml`, so the same keys apply at both layers.

## Rollback

Restore `profiles/desktop/cordis.patch.yml`, `package.json` and `pnpm-lock.yaml`
from their `*.bak-before-multi-search-desktop` copies, run `pnpm install`, and
restart. Rollback touches the Desktop profile only.