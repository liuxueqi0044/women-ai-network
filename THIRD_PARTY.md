# Third-party software

Dependencies are resolved from `pnpm-lock.yaml`; dependency source code and `node_modules` are not vendored in this snapshot.

The current lockfile includes software under MIT, Apache-2.0, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, Unlicense, BlueOak-1.0.0, Python-2.0, CC-BY-4.0, and package-specific dual or combined terms. In particular, the platform-specific Sharp binary reports `Apache-2.0 AND LGPL-3.0-or-later`, and `caniuse-lite` reports CC-BY-4.0.

These licenses apply to their respective packages, not to the original project code. Before distribution or deployment, generate and review the complete inventory from the pinned lockfile:

```bash
pnpm licenses list --prod --json
pnpm licenses list --dev --json
```

The repository's CI also creates a CycloneDX software bill of materials.
