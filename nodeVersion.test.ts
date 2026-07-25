// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Three files independently name the Node major, and each one is read by a
// different consumer:
//
//  - `.nvmrc` — CI (`actions/setup-node@v6` with node-version-file), `nvm use`
//    on a contributor's machine, and the web sandbox's session-start hook;
//  - `engines.node` in package.json — Vercel's build image and function
//    runtime, plus npm's EBADENGINE warning;
//  - `@types/node` — what `tsc` believes the runtime's stdlib looks like.
//
// Nothing cross-checks them, and a mismatch is quiet in the worst way: the
// suite goes green on one runtime while production serves another, or tsc
// type-checks against APIs the deployed Node doesn't have. Renovate will also
// keep offering `@types/node` majors ahead of the runtime — this test is what
// turns "accept the bump" into a deliberate runtime move instead of a silent
// one. When that PR arrives, move all three together or none.

const read = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8');

const major = (range: string): string => {
  const match = /(\d+)\./.exec(range);
  if (!match) throw new Error(`no major version in ${JSON.stringify(range)}`);
  return match[1];
};

const pkg = JSON.parse(read('./package.json')) as {
  engines: { node: string };
  devDependencies: Record<string, string>;
};
const nvmrc = read('./.nvmrc').trim();

describe('Node version pinning', () => {
  it('pins .nvmrc to the active LTS major', () => {
    expect(nvmrc).toBe('24');
  });

  it('agrees between .nvmrc and engines.node', () => {
    expect(major(pkg.engines.node)).toBe(nvmrc);
  });

  it('types the runtime it actually runs on', () => {
    expect(major(pkg.devDependencies['@types/node'])).toBe(nvmrc);
  });
});
