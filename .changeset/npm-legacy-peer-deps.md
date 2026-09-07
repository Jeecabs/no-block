---
"@jeecabs/no-block": patch
---

Fix Git-source installs leaving the package without `node_modules`. Pi installs git packages with `npm install --omit=dev`, and npm 10's resolver crashes on vitest 4's optional peer set, so the `@aliou/*` runtime dependencies were never installed and every extension failed to load. Setting `legacy-peer-deps` in `.npmrc` avoids the crash.
