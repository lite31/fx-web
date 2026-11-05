# Anti-slop provenance

Source repository: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop).
Installed from the local `install-anti-slop` skill's
`assets/anti-slop/` bundle on 2026-10-19.

The exact upstream commit is **unknown**. The installed skill's lock entry names
that repository and records computed hash
`4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`;
that hash is skill metadata, not a verified Git revision of these plugin files.

`SOURCE.sha256` records every copied file's SHA-256 digest and relative path.
Each copied file was compared byte for byte with the local bundle. Preserve this
manifest and the pristine version in Git when making local changes; do not treat
a newer upstream HEAD as the identity of this installation.

Installed entry points, relative to fx-web:

- `tools/oxlint/anti-slop/index.ts`: generic rules.
- `tools/oxlint/anti-slop/effect/index.ts`: opt-in Effect rules.

No rule implementations were changed. Only this provenance record and
`SOURCE.sha256` were added. Both plugins use `@oxlint/plugins@1.86.0`, matching
the installed Oxlint version.

The nested `vendor/eslint-stylistic/` retains its own license and
[upstream record](vendor/eslint-stylistic/UPSTREAM.md), including its verified
source commit and local adaptations. Keep both files with redistributed copies.

The Effect import rule analyzes relative project imports. Package-alias imports
are not covered.
