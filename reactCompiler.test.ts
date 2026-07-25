// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { reactCompilerBabelPlugin } from './vite.config';

// The React Compiler reaches our bundle through three packages that version
// independently: @babel/core (the transform engine), @rolldown/plugin-babel
// (which drives it from Vite, since plugin-react v6 transforms with oxc), and
// babel-plugin-react-compiler (wrapped by plugin-react's `reactCompilerPreset`).
// A major bump in any of them — @babel/core 7 → 8 being the one that prompted
// this file — can break the seam between them.
//
// `npm run build` only catches the loud half of that: a plugin that *throws*.
// The failure mode this test exists for is the quiet one — the preset loading
// but no longer applying, so every bundle ships with the memoization silently
// gone and nothing red anywhere. So the assertions below are about the compiler
// having actually run, not just about the plugin having returned.
//
// We drive the plugin's hooks directly instead of running a real `vite build`:
// the integration lives entirely in the transform hook, and a build in the unit
// suite would cost seconds per run to re-prove what CI's build step already
// covers (that Vite calls these hooks the way we do here).

/**
 * The slice of the rolldown plugin we drive. `@rolldown/plugin-babel` returns a
 * rolldown `Plugin`, whose hooks are `ObjectHook` unions that can't be called
 * without narrowing at every step; this states the shape the plugin documents
 * for the hooks we exercise, so the test body stays readable.
 */
interface DrivenPlugin {
  name: string;
  config(): { optimizeDeps?: { include?: string[] } } | undefined;
  configResolved(config: unknown): void;
  applyToEnvironment(environment: { name: string; config: unknown }): boolean;
  transform: {
    filter: {
      id: { include: RegExp[]; exclude: RegExp[] };
      code: RegExp[];
    };
    handler(
      this: unknown,
      code: string,
      id: string,
      options: { moduleType: string },
    ): Promise<{ code?: string; map?: unknown } | undefined>;
  };
}

/** A component the compiler can memoize: TSX, hooks used unconditionally. */
const MEMOIZABLE = `
import { useState } from 'react';

interface Props {
  items: readonly number[];
}

export function Counter({ items }: Props) {
  const [n, setN] = useState(0);
  const doubled = items.map((i) => i * 2);
  return (
    <button onClick={() => setN(n + 1)}>
      {n} of {doubled.length}
    </button>
  );
}
`;

/**
 * A component the compiler must bail out on: the hook call is conditional, so
 * it can't prove memoization is safe. Bail-out mode means "leave it alone",
 * not "fail the build" — that's what makes the compiler safe to enable at all.
 */
const BAILS_OUT = `
import { useState } from 'react';

export function Maybe({ items }: { items: readonly number[] }) {
  if (items.length > 0) {
    const [x] = useState(0);
    return <span>{x}</span>;
  }
  return <span>empty</span>;
}
`;

/** Nothing component-shaped: no hooks, no capitalized callables. */
const PLAIN_MODULE = `export const total = (a: number, b: number) => a + b;\n`;

const CLIENT_ENV = { name: 'client', config: { consumer: 'client' } };

/**
 * Build the plugin and walk it through the lifecycle Vite drives on a client
 * build: `configResolved` (computes the transform filter) then
 * `applyToEnvironment` (registers the per-environment Babel options, without
 * which the transform hook is a no-op).
 */
async function clientPlugin(): Promise<DrivenPlugin> {
  const plugin = (await reactCompilerBabelPlugin()) as unknown as DrivenPlugin;
  plugin.configResolved({ command: 'build', isProduction: true });
  expect(plugin.applyToEnvironment(CLIENT_ENV)).toBe(true);
  return plugin;
}

/** Transform as the client environment, surfacing `this.error` as a throw. */
function transform(
  plugin: DrivenPlugin,
  code: string,
  id = '/src/components/Counter.tsx',
) {
  const context = {
    environment: { name: CLIENT_ENV.name },
    error(err: { message?: string } | string): never {
      throw new Error(typeof err === 'string' ? err : (err.message ?? 'error'));
    },
  };
  return plugin.transform.handler.call(context, code, id, {
    moduleType: 'tsx',
  });
}

describe('React Compiler via @rolldown/plugin-babel', () => {
  it('memoizes a component through the Babel pipeline', async () => {
    const plugin = await clientPlugin();
    const result = await transform(plugin, MEMOIZABLE);

    // `_c` is the compiler's memo cache and the import proves the preset ran;
    // both disappear together if the preset silently stops applying.
    expect(result?.code).toContain('react/compiler-runtime');
    expect(result?.code).toMatch(/_c\(\d+\)/);
    // Still the same component, and the TSX parsed (types + JSX in one file).
    expect(result?.code).toContain('export function Counter');
    expect(result?.code).toContain('useState(0)');
  });

  it('emits a source map for the transformed component', async () => {
    const plugin = await clientPlugin();
    const result = await transform(plugin, MEMOIZABLE);

    // Without a map, every stack trace and breakpoint in a memoized component
    // points at compiler output instead of the source file.
    expect(result?.map).toBeTruthy();
  });

  it('targets the compiler runtime built into React 19', async () => {
    const plugin = await clientPlugin();

    // target '19' means react/compiler-runtime; targeting 17/18 would instead
    // pull the standalone `react-compiler-runtime` package we don't install.
    expect(plugin.config()?.optimizeDeps?.include).toEqual([
      'react/compiler-runtime',
    ]);
  });

  it('bails out instead of failing on a component it cannot prove safe', async () => {
    const plugin = await clientPlugin();
    const result = await transform(
      plugin,
      BAILS_OUT,
      '/src/components/Maybe.tsx',
    );

    // The rule violation must not throw, and the component must come back
    // uncompiled rather than half-memoized.
    const code = result?.code ?? BAILS_OUT;
    expect(code).not.toContain('react/compiler-runtime');
    expect(code).not.toMatch(/_c\(\d+\)/);
    expect(code).toContain('export function Maybe');
  });

  it('only runs on client bundles', async () => {
    const plugin = (await reactCompilerBabelPlugin()) as unknown as DrivenPlugin;
    plugin.configResolved({ command: 'build', isProduction: true });

    // Auto-memoization is a browser-rendering optimization; running Babel over
    // a server environment's modules would be pure build cost.
    expect(
      plugin.applyToEnvironment({
        name: 'ssr',
        config: { consumer: 'server' },
      }),
    ).toBe(false);
  });

  it('narrows the transform to component-shaped source files', async () => {
    const plugin = await clientPlugin();
    const { id, code } = plugin.transform.filter;

    // The filter is what keeps Babel off the ~99% of modules with no component
    // in them. An empty filter would silently make every build pay for Babel;
    // an over-narrow one would silently skip real components.
    const matchesCode = (source: string) => code.some((re) => re.test(source));
    expect(matchesCode(MEMOIZABLE)).toBe(true);
    expect(matchesCode(PLAIN_MODULE)).toBe(false);

    const matchesId = (path: string) =>
      id.include.some((re) => re.test(path)) &&
      !id.exclude.some((re) => re.test(path));
    expect(matchesId('/src/components/Counter.tsx')).toBe(true);
    expect(matchesId('/node_modules/react-router-dom/dist/index.js')).toBe(
      false,
    );
  });
});
