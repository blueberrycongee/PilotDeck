# Dependency security update — 2026-10-19

`pnpm audit --prod --json` against this workspace's lockfile reports 7 advisories after
this update (0 critical, 1 high, 5 moderate, 1 low), down from 169 (2 critical,
61 high). These counts describe registry advisories, not confirmed exploitable
application paths. The audit still exits nonzero; no advisories are suppressed.

The reported PDF.js, Multer, Sharp, Undici, shell-quote, and MCP SDK versions have
been upgraded to patched releases. CSV parsing and React Router receive compatible
updates as well. Version-qualified overrides in `pnpm-workspace.yaml` apply
compatible transitive security patches without forcing consumers onto another
major API. The lockfile records the complete resolved graph. Review and remove
these overrides as direct dependencies adopt patched versions themselves.

## Remaining advisories

| Package / dependency path | Severity | Advisory and follow-up |
| --- | --- | --- |
| `braces` via Tailwind / Chokidar | High | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm): deeply nested patterns exhaust the stack. No patched release is listed. Track upstream; keep build/watch patterns trusted. |
| `sprintf-js` via gray-matter / js-yaml / argparse | Moderate | [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): unbounded precision in attacker-controlled format strings. No patched release is listed. Track upstream; the dependency's presence alone does not establish control of its format strings. |
| `uuid` via ExcelJS | Moderate | [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq): v3/v5/v6 output-buffer bounds. Patched in 11.1.1; ExcelJS currently resolves 8.3.2. Requires a consumer-compatible upgrade or upstream backport. |
| `react-router` via react-router-dom | Moderate | [GHSA-wrjc-x8rr-h8h6](https://github.com/advisories/GHSA-wrjc-x8rr-h8h6): external navigation from crafted paths. Patched in 7.18.0; migration from v6 remains separate work. |
| `react-router` via react-router-dom | Moderate | [GHSA-337j-9hxr-rhxg](https://github.com/advisories/GHSA-337j-9hxr-rhxg): SSR error hydration constructor injection. Patched in 7.18.0. The current app uses declarative `BrowserRouter`, which the advisory excludes; the lockfile still matches. |
| `postcss-selector-parser` via @tailwindcss/typography | Moderate | [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf): quadratic selector parsing. Patched in 7.1.6; the consumer currently resolves v6. This path is build tooling; a major upgrade needs compatibility validation. |
| `katex` | Low | [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7): inherited renderer settings after existing prototype pollution. Patched in 0.18.2; current Markdown integrations resolve 0.16.x. Upgrade the renderer integrations together and verify math output. |

## Validation

Use Node 22 and the frozen pnpm lockfile. The root and UI TypeScript checks and
`pnpm run build:web` pass with this dependency graph. Existing runtime and Web
regression suites exercise the updated consumers. Registry advisories change over
time, so rerun `pnpm audit --prod --json` when reviewing or merging this branch.
