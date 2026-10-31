// Verify the Desktop copy's build-time dependency set.
//
// The Web twin's `ensure-links.mjs` junctions `node_modules/@deepseek-ai/*`
// into the local 0.1.7 dsh checkout. This copy must NOT do that: version
// isolation means it compiles against the published 0.2.0-rc.2 packages its
// package.json pins — exactly the line the Desktop app bundles. Linking back to
// a checkout would silently re-couple the two versions.
//
// Read-only: it reports a missing or mismatched package and exits non-zero
// instead of repairing it, so a broken build cannot be mistaken for a good one.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Build-time dsh packages and the exact version this copy targets. */
const EXPECTED = {
  cordis: '4.0.5',
  schemastery: '3.18.5',
  'dsh-web': '0.2.1-rc.2',
  'dsh-web-search-deepseek': '0.2.1-rc.2',
  'dsh-credentials': '0.2.1-rc.2',
  'dsh-launch-environment': '0.2.1-rc.2',
  // Build-time only: dsh-web's own typings re-export WebError from it, so
  // without this package `skipLibCheck` silently degrades WebError's
  // constructor to zero arguments and every `new WebError(msg, code)` fails.
  'dsh-llm': '0.2.1-rc.2',
  'dsh-client-ui-settings': '0.2.1-rc.2',
  'dsh-client-ui-slots': '0.2.1-rc.2',
}

let failures = 0

for (const [name, expected] of Object.entries(EXPECTED)) {
  const manifest = join(process.cwd(), 'node_modules', '@deepseek-ai', name, 'package.json')
  if (!existsSync(manifest)) {
    console.error(`[ensure-deps] MISSING @deepseek-ai/${name} (expected ${expected}) — run pnpm install`)
    failures += 1
    continue
  }
  const actual = JSON.parse(readFileSync(manifest, 'utf8')).version
  if (actual !== expected) {
    console.error(`[ensure-deps] MISMATCH @deepseek-ai/${name}: ${actual} != ${expected}`)
    failures += 1
    continue
  }
  console.log(`[ensure-deps] ok @deepseek-ai/${name}@${actual}`)
}

if (failures > 0) {
  console.error(`[ensure-deps] ${failures} package(s) unusable; refusing to build against the wrong dsh line`)
  process.exit(1)
}
console.log('[ensure-deps] all build-time dsh packages target 0.2.1-rc.2')