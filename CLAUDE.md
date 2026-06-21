# CLAUDE.md

See [`AGENTS.md`](./AGENTS.md) for contributor guidelines and [`SPEC.md`](./SPEC.md)
for the product spec.

## Key local facts

- **Test environment is Vitest + jsdom.** Pure-logic tests that need Node
  instead opt in per-file with a docblock pragma at the top:

  ```ts
  // @vitest-environment node
  ```

- **The data layer is abstracted behind `src/lib/data/DataSource.ts`.**
  `MockDataSource` is the current implementation; `SupabaseDataSource` will
  replace it later. Build against the `DataSource` interface, not a concrete
  source.

- **Design tokens are the `--rm-*` custom properties in
  `src/styles/global.css`** (e.g. `--rm-accent: #3a4ec4`, `--rm-bg`,
  `--rm-text`, `--rm-read`). Use the tokens; don't hard-code colors.
