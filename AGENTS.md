# Environment Notes

- Use Node 26 for this repository. Node 24 remains supported; Node 25 breaks dependency installation and the dev toolchain.
- `package.json` declares the supported range as `>=24 <25 || >=26 <27`, and `.nvmrc` is set to `26`.
- The system Node 26 installation is verified, so use the standard commands:

```bash
npm install
npm run dev
```

- If `npm install` appears to succeed but packages like `esbuild` or `tslib` are missing or invalid, check which Node version is running first.
