#!/usr/bin/env node
// Validates the diff the monthly dependency update produced, from the publish
// job — a runner that installed nothing and executed no dependency code. See
// AGENTS.md "Dependency updates" for why the validation lives there rather
// than on the machine that ran the batch.
//
// This is a checked-in script, not a `node -e` string in the workflow, for two
// reasons that both cost real time before:
//
//   1. A single-quoted shell argument ends at the first apostrophe. One in a
//      comment truncated the program from 7247 to 4905 characters, and the
//      remainder was still valid JS that exited 0 — silently skipping every
//      rule below the cut, with nothing red anywhere.
//   2. A graph algorithm with no unit tests cannot be reasoned about by
//      inspection. Its blind spots were found by review rather than by the
//      suite, repeatedly, and each fix reopened the previous one.
//
// Everything here is a pure function over parsed JSON, exported for
// check-dependency-update.test.ts. The CLI at the bottom is the only part that
// touches git or the filesystem.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEP_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

// The fields npm records for a package's own dependency edges. Listing them
// explicitly rather than walking every key keeps `engines` and friends out.
// An optional or peer edge npm DID install is a real consumer resolving to a
// real copy and can cross a major like any other, so all three count.
const EDGE_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

const canon = (v) =>
  v === null || typeof v !== "object"
    ? v
    : Array.isArray(v)
      ? v.map(canon)
      : Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canon(v[k])]),
        );

const stripDeps = (o) =>
  canon(Object.fromEntries(Object.entries(o).filter(([k]) => !DEP_SECTIONS.includes(k))));

const parseRange = (r) => {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(String(r));
  return m ? { op: m[1], v: [+m[2], +m[3], +m[4]] } : null;
};

const cmp = (x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2];

// Exclusive upper bound of a range, per npm caret/tilde semantics. `^0.6.0`
// allows < 0.7.0, not < 1.0.0 — caret on a 0.x package pins the minor.
const ceil = ({ op, v: [x, y, z] }) =>
  op === "^"
    ? x > 0
      ? [x + 1, 0, 0]
      : y > 0
        ? [0, y + 1, 0]
        : [0, 0, z + 1]
    : op === "~"
      ? [x, y + 1, 0]
      : [x, y, z + 1];

/**
 * What `npm update` is allowed to have done to package.json.
 *
 * Two separate claims: everything outside the dependency sections is
 * untouched, and inside them every move stays within the range that was
 * already declared. The first matters because a filename allowlist still lets
 * package.json itself be rewritten — a postinstall pointing `scripts.test` at
 * `true` would make the reported checks meaningless while the diff still read
 * as an ordinary bump.
 *
 * Comparing majors would not be enough for the second: `^2.17.6` -> `^2.0.0`
 * keeps the major while downgrading, and `^0.6.0` -> `^0.7.0` keeps it while
 * stepping outside what caret means on a 0.x package. So the test is the real
 * one — does the new floor satisfy the OLD range.
 */
export function manifestFailures(before, after) {
  const out = [];

  if (JSON.stringify(stripDeps(before)) !== JSON.stringify(stripDeps(after))) {
    out.push(
      "package.json changed outside its dependency sections. `npm update` does not do that — inspect before trusting this batch.",
    );
  }

  for (const section of DEP_SECTIONS) {
    const a = before[section] || {};
    const b = after[section] || {};
    for (const name of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (!(name in a)) {
        out.push(`${section}.${name} was ADDED; npm update does not add packages.`);
        continue;
      }
      if (!(name in b)) {
        out.push(`${section}.${name} was REMOVED; npm update does not remove packages.`);
        continue;
      }
      if (a[name] === b[name]) continue;

      const from = parseRange(a[name]);
      const to = parseRange(b[name]);
      // Deliberately conservative: a prerelease or exotic range this validator
      // cannot model stops the run rather than being waved through on the
      // assumption that it is fine.
      if (!from || !to) {
        out.push(
          `${section}.${name}: ${a[name]} -> ${b[name]} is not a plain X.Y.Z registry range this job can validate.`,
        );
        continue;
      }
      if (from.op !== to.op) {
        out.push(`${section}.${name} changed its range operator: ${a[name]} -> ${b[name]}.`);
        continue;
      }
      if (cmp(to.v, from.v) < 0 || cmp(to.v, ceil(from)) >= 0) {
        out.push(
          `${section}.${name} moved outside its existing range: ${a[name]} -> ${b[name]}. npm update only bumps the floor to a version the declared range already allowed.`,
        );
      }
    }
  }

  return out;
}

const ROOT = "";

export const nameOf = (path) =>
  path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);

// The root entry has no `node_modules/`; link and workspace records carry no
// version. Neither is a resolved package.
const isPackage = (path, entry) =>
  path.includes("node_modules/") && !!entry && typeof entry.version === "string";

export const majorOf = (version) => {
  const m = /^\d+/.exec(String(version));
  return m ? m[0] : null;
};

/**
 * Resolve one dependency edge the way npm does: from the dependent directory,
 * walk up through each ancestor node_modules until one holds the name. That is
 * the copy the consumer actually gets.
 */
export function resolveEdge(packages, fromPath, name) {
  let prefix = fromPath;
  for (;;) {
    const candidate = (prefix ? prefix + "/" : "") + "node_modules/" + name;
    const entry = packages[candidate];
    if (entry && entry.version) return entry.version;
    if (!prefix) return null;
    const cut = prefix.lastIndexOf("/node_modules/");
    prefix = cut === -1 ? "" : prefix.slice(0, cut);
  }
}

const instancesByName = (packages) => {
  const byName = new Map();
  for (const [path, entry] of Object.entries(packages)) {
    if (!isPackage(path, entry)) continue;
    const name = nameOf(path);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ path, name, version: entry.version, entry });
  }
  for (const list of byName.values()) list.sort((x, y) => (x.path < y.path ? -1 : 1));
  return byName;
};

/**
 * Pair up the instances of ONE package name across the two trees.
 *
 * This is the part the earlier keyed-by-X versions of this check kept getting
 * wrong, in both directions. An npm path is a LOCATION, not an identity: key an
 * instance by its path and a consumer that hoists looks deleted-and-recreated,
 * so the crossing it just made reads as an edge that never existed. Key it by
 * name instead and two copies of one consumer collapse into one bucket, so a
 * swap between them cancels out. Neither key dominates — each catches exactly
 * what the other misses — and no third key fixes it either: `name@version`
 * changes the moment the consumer is itself bumped, which is the normal case
 * in this workflow.
 *
 * So: match, do not key. Strongest evidence first, and anything left unpaired
 * is reported as an addition or removal rather than quietly dropped.
 */
export function matchInstances(before, after) {
  const pairs = [];
  const leftBefore = [...before];
  const leftAfter = [...after];

  // Among the candidates a pass accepts, take the one whose location is most
  // like the original. Picking the first acceptable candidate instead is not
  // merely arbitrary, it is exploitable: two copies of one package at the SAME
  // version, both relocated in the same batch, are indistinguishable to the
  // version pass, so an arbitrary pairing can cross them over and cancel a
  // swap that really happened. Depth and shared prefix are what tell those two
  // apart, and they are stable under the reshapes npm actually performs.
  const affinity = (b, a) => {
    if (b.path === a.path) return Number.MAX_SAFE_INTEGER;
    let shared = 0;
    while (shared < b.path.length && shared < a.path.length && b.path[shared] === a.path[shared]) {
      shared += 1;
    }
    return shared;
  };

  const take = (isMatch) => {
    for (let i = leftBefore.length - 1; i >= 0; i--) {
      const b = leftBefore[i];
      let best = -1;
      let bestScore = -1;
      for (let j = 0; j < leftAfter.length; j++) {
        if (!isMatch(b, leftAfter[j])) continue;
        const score = affinity(b, leftAfter[j]);
        if (score > bestScore) {
          bestScore = score;
          best = j;
        }
      }
      if (best === -1) continue;
      pairs.push({ before: b, after: leftAfter[best] });
      leftBefore.splice(i, 1);
      leftAfter.splice(best, 1);
    }
  };

  take((b, a) => b.path === a.path); // same location — the ordinary case
  take((b, a) => b.version === a.version); // same copy, moved by a hoist or dedupe
  take((b, a) => majorOf(b.version) === majorOf(a.version)); // bumped within its range

  // Whatever is left is an instance at some major disappearing while one at a
  // different major appears. Pairing them is not a guess that they are "the
  // same" — it is what surfaces that as a crossing instead of as an unrelated
  // add and remove that cancel in the reporting.
  while (leftBefore.length && leftAfter.length) {
    pairs.push({ before: leftBefore.shift(), after: leftAfter.shift() });
  }

  pairs.sort((x, y) => (x.before.path < y.before.path ? -1 : 1));
  return { pairs, removed: leftBefore, added: leftAfter };
}

const edgeNames = (entry) => {
  const names = new Set();
  for (const field of EDGE_FIELDS) {
    for (const name of Object.keys((entry && entry[field]) || {})) names.add(name);
  }
  return names;
};

const label = (instance) =>
  instance.path === ROOT
    ? "the root package"
    : `${instance.name}@${instance.version} (${instance.path})`;

/**
 * Every consumer whose resolved major for some dependency moved.
 *
 * package.json only governs DIRECT dependencies. A bare `npm update` also
 * moves subdependencies to whatever their own ranges allow, and a transitive
 * range of `*` or `>=x` permits a major — which would never show up in the
 * manifest diff.
 *
 * THREE rules. Rule (3) is the load-bearing one and, on every fixture in
 * check-dependency-update.test.ts, it rejects everything (1) and (2) reject —
 * that was measured, not assumed, by running the fixtures against a copy with
 * the first two removed.
 *
 * (1) and (2) are kept anyway, for two reasons and NOT because a gap in (3) is
 * known: they name the ordinary in-place bump in one line instead of as a
 * consumer edge, which is what a human reading a failed run wants first; and
 * four earlier rounds of this check each REPLACED its predecessor when it
 * should have joined it, so "the new rule subsumes the old one" is precisely
 * the reasoning that has been wrong here every time it was applied. Cheap
 * corroboration from a different angle is worth more than the lines it costs.
 */
export function lockfileFailures(beforePackages, afterPackages) {
  const out = [];

  // (1) BY PATH — an entry present before and after whose own major moved.
  //     The cheapest rule and the one that catches an ordinary in-place bump.
  for (const [path, entry] of Object.entries(beforePackages)) {
    if (!isPackage(path, entry)) continue;
    const now = afterPackages[path];
    if (!isPackage(path, now)) continue;
    if (majorOf(entry.version) !== majorOf(now.version)) {
      out.push(
        `${path} crossed a major in the lockfile: ${entry.version} -> ${now.version}. Even a transitive major is a deliberate migration, not a monthly batch.`,
      );
    }
  }

  const beforeByName = instancesByName(beforePackages);
  const afterByName = instancesByName(afterPackages);

  // (2) BY NAME — the SET of majors a package resolves to, changed in either
  //     direction. A major disappearing counts as much as one appearing: the
  //     last consumer of it went somewhere.
  for (const [name, instances] of [...afterByName].sort()) {
    const had = beforeByName.get(name);
    // A package that is entirely new is a new subdependency of something that
    // moved in range, which rule (1) and the manifest check already bound.
    if (!had) continue;
    const before = new Set(had.map((i) => majorOf(i.version)));
    const now = new Set(instances.map((i) => majorOf(i.version)));
    if ([...before].some((m) => !now.has(m)) || [...now].some((m) => !before.has(m))) {
      out.push(
        `${name} changed which majors it resolves to: ${[...before].sort().join(", ")} -> ${[...now].sort().join(", ")}. Even a transitive major is a deliberate migration, not a monthly batch.`,
      );
    }
  }

  // (3) BY MATCHED INSTANCE — the exact one, and the reason the first two are
  //     not enough on their own. They summarize the tree, and a summary can
  //     hold perfectly still while a consumer moves underneath it: drop a
  //     nested foo@1 so its dependent falls through to an already-hoisted
  //     foo@2, and as long as some other dependent kept a foo@1, no path
  //     changed major and the major set for foo is still {1,2}.
  const consumers = [];
  if (beforePackages[ROOT] && afterPackages[ROOT]) {
    // The root has a stable identity and real edges of its own, so it is
    // paired with itself rather than run through the matcher.
    consumers.push({
      before: { path: ROOT, name: ROOT, version: "", entry: beforePackages[ROOT] },
      after: { path: ROOT, name: ROOT, version: "", entry: afterPackages[ROOT] },
    });
  }
  for (const [name, instances] of [...beforeByName].sort()) {
    consumers.push(...matchInstances(instances, afterByName.get(name) || []).pairs);
  }

  for (const pair of consumers) {
    const declaredBefore = edgeNames(pair.before.entry);
    const declaredAfter = edgeNames(pair.after.entry);
    for (const dep of [...declaredBefore].sort()) {
      // An edge the bump added or dropped is a legitimate change of what this
      // package depends on, not a crossing. Only edges present on BOTH sides
      // have a before-and-after to compare.
      if (!declaredAfter.has(dep)) continue;

      const was = resolveEdge(beforePackages, pair.before.path, dep);
      const now = resolveEdge(afterPackages, pair.after.path, dep);

      // Neither resolves: an optional or peer edge npm declined to install on
      // both sides. Nothing to compare.
      if (was === null && now === null) continue;
      if (was === null || now === null) {
        out.push(
          `${label(pair.before)} declares ${dep} on both sides but it resolves to a copy on only one of them (${was ?? "nothing"} -> ${now ?? "nothing"}). This job cannot tell whether that crossed a major.`,
        );
        continue;
      }
      if (majorOf(was) !== majorOf(now)) {
        out.push(
          `${label(pair.before)} now resolves ${dep} to a different major: ${was} -> ${now}. Even a transitive major is a deliberate migration, not a monthly batch.`,
        );
      }
    }
  }

  return out;
}

export function allFailures({ manifestBefore, manifestAfter, lockBefore, lockAfter }) {
  return [
    ...manifestFailures(manifestBefore, manifestAfter),
    ...lockfileFailures(lockBefore.packages || {}, lockAfter.packages || {}),
  ];
}

function main() {
  const show = (path) =>
    JSON.parse(execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8" }));
  const read = (path) => JSON.parse(readFileSync(path, "utf8"));

  const failures = allFailures({
    manifestBefore: show("package.json"),
    manifestAfter: read("package.json"),
    lockBefore: show("package-lock.json"),
    lockAfter: read("package-lock.json"),
  });

  for (const failure of failures) console.error(`::error::${failure}`);
  if (failures.length) process.exit(1);
  console.log("Dependency diff validated: no majors, no out-of-range moves.");
}

// Only when run directly, so importing this from a test does not shell out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
