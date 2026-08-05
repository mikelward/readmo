// @vitest-environment node
//
// The monthly dependency update runs unattended and its PR never gets a normal
// `pull_request` CI run, so this validator is most of what stands between a
// silent transitive major and `main`. Its failure mode is a FALSE PASS, which
// is why every case below asserts behavior on a real lockfile shape rather
// than the presence of a rule.
//
// The lockfile fixtures are hand-built and deliberately small. Each one names
// the tree reshape it represents, because the shape is the whole point: the
// earlier versions of this check were correct on the case in front of them and
// blind to the next one, in both directions.

import { describe, expect, it } from 'vitest'

import {
  lockfileFailures,
  manifestFailures,
  matchInstances,
  majorOf,
  resolveEdge,
} from './check-dependency-update.mjs'

const pkg = (version: string, deps?: Record<string, string>) => ({
  version,
  ...(deps ? { dependencies: deps } : {}),
})

const root = (deps: Record<string, string>) => ({ '': { dependencies: deps } })

describe('manifestFailures', () => {
  const base = {
    name: 'example',
    scripts: { test: 'vitest run' },
    dependencies: { alpha: '^1.2.0' },
    devDependencies: { beta: '~3.4.5' },
  }

  it('accepts a bump to a version the declared range already allowed', () => {
    const after = { ...base, dependencies: { alpha: '^1.9.9' } }
    expect(manifestFailures(base, after)).toEqual([])
  })

  it('accepts a pure key reordering outside the dependency sections', () => {
    const after = { scripts: { test: 'vitest run' }, name: 'example', ...base }
    expect(manifestFailures(base, after)).toEqual([])
  })

  it('rejects a rewritten script, which would make every reported check meaningless', () => {
    const after = { ...base, scripts: { test: 'true' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('outside its dependency sections'),
    ])
  })

  it('rejects a major, which no declared caret range allows', () => {
    const after = { ...base, dependencies: { alpha: '^2.0.0' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects a caret minor on a 0.x package, where caret pins the minor', () => {
    const before = { ...base, dependencies: { alpha: '^0.6.0' } }
    const after = { ...base, dependencies: { alpha: '^0.7.0' } }
    expect(manifestFailures(before, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects a downgrade that keeps the major', () => {
    const before = { ...base, dependencies: { alpha: '^2.17.6' } }
    const after = { ...base, dependencies: { alpha: '^2.0.0' } }
    expect(manifestFailures(before, after)).toEqual([
      expect.stringContaining('moved outside its existing range'),
    ])
  })

  it('rejects an added or removed package', () => {
    expect(manifestFailures(base, { ...base, dependencies: { alpha: '^1.2.0', gamma: '^1.0.0' } }))
      .toEqual([expect.stringContaining('was ADDED')])
    expect(manifestFailures(base, { ...base, dependencies: {} })).toEqual([
      expect.stringContaining('was REMOVED'),
    ])
  })

  it('rejects a swapped range operator', () => {
    const after = { ...base, dependencies: { alpha: '~1.2.0' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('changed its range operator'),
    ])
  })

  it('stops on a range it cannot model rather than assuming it is fine', () => {
    const after = { ...base, dependencies: { alpha: 'git+https://example.com/alpha.git' } }
    expect(manifestFailures(base, after)).toEqual([
      expect.stringContaining('not a plain X.Y.Z registry range'),
    ])
  })
})

describe('resolveEdge', () => {
  const packages = {
    'node_modules/foo': pkg('2.0.0'),
    'node_modules/a': pkg('1.0.0', { foo: '*' }),
    'node_modules/a/node_modules/foo': pkg('1.0.0'),
    'node_modules/b': pkg('1.0.0', { foo: '*' }),
  }

  it('takes the nearest copy walking up from the dependent', () => {
    expect(resolveEdge(packages, 'node_modules/a', 'foo')).toBe('1.0.0')
  })

  it('falls through to a hoisted copy when there is no nested one', () => {
    expect(resolveEdge(packages, 'node_modules/b', 'foo')).toBe('2.0.0')
    expect(resolveEdge(packages, '', 'foo')).toBe('2.0.0')
  })

  it('returns null for an edge npm did not install', () => {
    expect(resolveEdge(packages, 'node_modules/a', 'absent')).toBeNull()
  })
})

describe('matchInstances', () => {
  const at = (path: string, version: string) => ({ path, name: 'bar', version, entry: pkg(version) })

  it('pairs by location first', () => {
    const { pairs, added, removed } = matchInstances(
      [at('node_modules/bar', '1.0.0')],
      [at('node_modules/bar', '1.0.1')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].after.version).toBe('1.0.1')
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })

  it('pairs a hoisted copy by version when its path changed', () => {
    const { pairs } = matchInstances(
      [at('node_modules/a/node_modules/bar', '1.0.0')],
      [at('node_modules/bar', '1.0.0')],
    )
    expect(pairs).toHaveLength(1)
    expect(pairs[0].after.path).toBe('node_modules/bar')
  })

  // The reason `name@version` is not the identity: in this workflow the
  // consumer being bumped is the normal case, so that key changes on almost
  // every instance and every edge out of it would read as deleted-and-added.
  it('pairs a consumer that was bumped AND hoisted, by major', () => {
    const { pairs, added, removed } = matchInstances(
      [at('node_modules/a/node_modules/bar', '1.2.0')],
      [at('node_modules/bar', '1.3.0')],
    )
    expect(pairs).toHaveLength(1)
    expect(added).toEqual([])
    expect(removed).toEqual([])
  })

  it('keeps two copies of one name distinct rather than collapsing them', () => {
    const { pairs } = matchInstances(
      [at('node_modules/a/node_modules/bar', '1.0.0'), at('node_modules/b/node_modules/bar', '2.0.0')],
      [at('node_modules/a/node_modules/bar', '1.0.1'), at('node_modules/b/node_modules/bar', '2.0.1')],
    )
    expect(pairs).toHaveLength(2)
    for (const pair of pairs) {
      expect(majorOf(pair.before.version)).toBe(majorOf(pair.after.version))
    }
  })

  // Two copies at the SAME version are indistinguishable to the version pass,
  // so which one it picks would otherwise come down to the order they happen
  // to be in — and an arbitrary pairing can cross two consumers over and
  // cancel a swap that really happened. Location affinity makes the choice
  // deterministic and tied to something npm's reshapes preserve.
  //
  // Asserted on the matcher directly rather than through a lockfile fixture:
  // every tree I could build to exercise this ended up unreachable (a package
  // relocated somewhere its own parent cannot resolve), and lockfileFailures
  // then rejected it for that instead — passing for a reason that has nothing
  // to do with the pairing. That narrowness is itself the finding: the residue
  // this closes is an ordering dependence in the matcher, not a shape npm has
  // been observed to produce.
  it('pairs same-version copies by location affinity, not by array order', () => {
    const before = [
      at('node_modules/x/node_modules/bar', '1.0.0'),
      at('node_modules/y/node_modules/bar', '1.0.0'),
    ]
    const candidates = [
      at('node_modules/x/node_modules/deep/node_modules/bar', '1.0.0'),
      at('node_modules/y/node_modules/deep/node_modules/bar', '1.0.0'),
    ]
    const branch = (path: string) => path.slice(0, 'node_modules/x'.length)

    // BOTH candidate orderings. With one ordering a first-acceptable-match
    // matcher happens to land correctly, so asserting only that one would pass
    // for luck rather than for the rule — which is exactly the failure this
    // whole file exists to avoid.
    for (const after of [candidates, [...candidates].reverse()]) {
      const { pairs } = matchInstances(before, after)
      expect(pairs).toHaveLength(2)
      for (const pair of pairs) {
        expect(branch(pair.after.path)).toBe(branch(pair.before.path))
      }
    }
  })

  it('reports an unpaired instance rather than dropping it', () => {
    const { pairs, added, removed } = matchInstances(
      [at('node_modules/bar', '1.0.0'), at('node_modules/x/node_modules/bar', '1.0.0')],
      [at('node_modules/bar', '1.0.0')],
    )
    expect(pairs).toHaveLength(1)
    expect(removed).toHaveLength(1)
    expect(added).toEqual([])
  })
})

describe('lockfileFailures', () => {
  it('passes a batch where everything moved within its major', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.2.0', { foo: '^1.0.0' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.3.0', { foo: '^1.0.0' }),
      'node_modules/foo': pkg('1.4.2'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  it('catches an in-place transitive major', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    // Asserts that it is REJECTED and which package is named, not which of the
    // three rules produced the message. More than one rule fires here, and a
    // test pinned to one rule's phrasing reports a wording change as a
    // regression while a real miss elsewhere goes unnoticed.
    expect(lockfileFailures(before, after).join('\n')).toContain('foo')
    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  // Round 17's finding. Two copies of one consumer swap majors in opposite
  // directions, so every per-NAME aggregate is bit-for-bit identical.
  it('catches two copies of a consumer swapping majors in opposite directions', () => {
    const shared = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/b': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/bar': pkg('1.0.0', { foo: '*' }),
    }
    const before = {
      ...shared,
      'node_modules/a/node_modules/bar/node_modules/foo': pkg('1.0.0'),
      'node_modules/b/node_modules/bar/node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...shared,
      'node_modules/a/node_modules/bar/node_modules/foo': pkg('2.0.0'),
      'node_modules/b/node_modules/bar/node_modules/foo': pkg('1.0.0'),
    }

    // The aggregate this fixture is built to defeat really is unchanged.
    const majors = (tree: Record<string, unknown>) =>
      Object.entries(tree)
        .filter(([path]) => path.endsWith('node_modules/foo'))
        .map(([, entry]) => majorOf((entry as { version: string }).version))
        .sort()
    expect(majors(before)).toEqual(majors(after))

    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  // Round 16's finding, and the one that keying by path misses: the consumer
  // changes location in the same batch as it crosses, so it shares no path to
  // compare and its old id looks deleted.
  it('catches a consumer that hoists as it crosses', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/bar': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  // The case neither summary rule can see: a nested foo@1 is dropped so its
  // dependent falls through to an already-hoisted foo@2, while another
  // dependent keeps its own foo@1. No shared path changed major, and the major
  // set for foo is still {1,2}. Nothing aggregate moved — but b crossed.
  it('catches a consumer falling through to a hoisted copy while the tree summary holds still', () => {
    const before = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/foo': pkg('2.0.0'),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
    }

    // Both summaries really are identical across this update — otherwise the
    // test would pass for a reason that has nothing to do with rule (3).
    const pathMajors = (tree: Record<string, { version?: string }>) =>
      Object.entries(tree)
        .filter(([path, entry]) => path.includes('node_modules/') && entry.version)
        .map(([path, entry]) => `${path}@${majorOf(entry.version as string)}`)
    const shared = pathMajors(before).filter((x) => pathMajors(after).includes(x))
    expect(pathMajors(before).filter((x) => !shared.includes(x))).toEqual([
      'node_modules/b/node_modules/foo@1',
    ])
    expect(new Set(pathMajors(after).map((x) => x.split('@').pop()))).toEqual(new Set(['1', '2']))

    const failures = lockfileFailures(before, after)
    expect(failures.join('\n')).toContain('different major')
    expect(failures.join('\n')).toContain('foo')
  })

  it('passes a dedupe that collapses two identical copies without changing what anyone resolves', () => {
    const before = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/b/node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0', b: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { foo: '*' }),
      'node_modules/b': pkg('1.0.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The false positive that sinks a naive `name@version` identity: the
  // consumer is bumped and hoisted in the same batch while what it resolves
  // does not move at all.
  it('passes a consumer that is itself bumped and hoisted with its dependency unchanged', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.2.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/bar': pkg('1.3.0', { foo: '*' }),
      'node_modules/foo': pkg('1.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  // The other half of the same trap, and the one that actually bites: with a
  // `name@version` identity this consumer goes unmatched, so its crossing is
  // never compared and the run goes green. The failure mode is silence, not a
  // false alarm — which is why it needs its own fixture rather than being
  // assumed covered by the no-false-positive case above.
  it('catches a consumer that crosses in the same batch as it is bumped and hoisted', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/bar': pkg('1.2.0', { foo: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/foo': pkg('2.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { bar: '*' }),
      'node_modules/a/node_modules/foo': pkg('1.0.0'),
      'node_modules/bar': pkg('1.3.0', { foo: '*' }),
      'node_modules/foo': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('different major')
  })

  it('passes a brand-new subdependency of something that moved in range', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.2.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.3.0', { fresh: '*' }),
      'node_modules/fresh': pkg('4.0.0'),
    }
    expect(lockfileFailures(before, after)).toEqual([])
  })

  it('catches a major the root itself resolves, even with the range untouched', () => {
    const before = {
      ...root({ alpha: '*' }),
      'node_modules/alpha': pkg('1.0.0'),
    }
    const after = {
      ...root({ alpha: '*' }),
      'node_modules/alpha': pkg('2.0.0'),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('alpha')
    expect(lockfileFailures(before, after)).not.toEqual([])
  })

  it('ignores link and workspace records, which carry no resolved version', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': { resolved: 'packages/a', link: true },
      'packages/a': { name: 'a' },
    }
    expect(lockfileFailures(before, { ...before })).toEqual([])
  })

  it('stops when an edge declared on both sides resolves on only one', () => {
    const before = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { opt: '*' }),
      'node_modules/opt': pkg('1.0.0'),
    }
    const after = {
      ...root({ a: '^1.0.0' }),
      'node_modules/a': pkg('1.0.0', { opt: '*' }),
    }
    expect(lockfileFailures(before, after).join('\n')).toContain('resolves to a copy on only one')
  })
})
