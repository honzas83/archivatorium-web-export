# Environment Notes

- Use Node 24 for this repository. The default system `node v25` breaks dependency installation and the dev toolchain.
- `package.json` declares the supported range as `>=18 <25`, and `.nvmrc` is set to `24`.
- In this environment, the working commands are:

```bash
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js install
/Users/honzas/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node /opt/homebrew/lib/node_modules/npm/bin/npm-cli.js run dev
```

- If `npm install` appears to succeed but packages like `esbuild`, `electron`, or `tslib` are missing or invalid, check which Node version is running first.
