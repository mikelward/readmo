// @vitest-environment node
//
// Guards on grafana/alerts.rules.yaml.
//
// THE FAILURE MODE HERE IS SILENCE, and it has two shapes. A rules file that
// does not parse loads NO alerts — mimirtool rejects the whole file, so one bad
// indentation silently disarms every rule in it, including the ones that were
// working yesterday. And a rule that parses but is written wrong either never
// fires or fires constantly and gets muted. Both look fine in a diff, and
// neither announces itself: the only symptom is an incident nobody was paged
// for, which is indistinguishable from no incident at all.
//
// So this parses the file rather than pattern-matching its text — parsing IS the
// first assertion — and then pins the properties that decide whether a rule can
// do its job: the `for:` hysteresis, the runbook an operator reads mid-incident,
// and for every RATIO alert both a divide-by-zero guard and an absolute floor. A
// ratio without a floor reads "100% errors" off two requests on an idle project
// and pages on nothing, which is how an alert file stops being trusted.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

interface Rule {
  alert?: string;
  expr?: string;
  for?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(resolve(here, 'alerts.rules.yaml'), 'utf8');

/** Parse once. A throw here fails every test below, which is the point. */
const doc = parse(source) as { groups?: { name?: string; rules?: Rule[] }[] };

const allRules: Rule[] = (doc.groups ?? []).flatMap((g) => g.rules ?? []);
const byName = (name: string) => allRules.find((r) => r.alert === name);

describe('grafana/alerts.rules.yaml', () => {
  it('is valid YAML in the shape Grafana/Mimir loads', () => {
    // Not ceremony: an unparseable file disarms every rule at once, and a file
    // that parses into the wrong shape (no `groups`) loads zero rules just as
    // quietly. Both are silent in review and silent in production.
    expect(Array.isArray(doc.groups)).toBe(true);
    expect(doc.groups!.length).toBeGreaterThan(0);
    for (const group of doc.groups!) {
      expect(typeof group.name).toBe('string');
      expect(Array.isArray(group.rules)).toBe(true);
    }
    // Guards the assertions below against passing vacuously over an empty list.
    expect(allRules.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every alert hysteresis, a severity and a runbook', () => {
    for (const rule of allRules) {
      const name = rule.alert ?? '(unnamed)';
      expect(typeof rule.alert, 'a rule has no alert name').toBe('string');
      expect(typeof rule.expr, `${name} has no expr`).toBe('string');
      // `for:` is what separates an alert from a pager that fires on one scrape.
      expect(rule.for, `${name} has no 'for:' hysteresis`).toBeTruthy();
      expect(rule.labels?.severity, `${name} has no severity`).toBeTruthy();
      expect(rule.annotations?.summary, `${name} has no summary`).toBeTruthy();
      // The runbook is the difference between being paged and knowing what to do.
      expect(rule.annotations?.runbook, `${name} has no runbook`).toBeTruthy();
    }
  });

  it('watches the API request path, not only the database', () => {
    // The failure this exists for: Postgres healthy and idle while PostgREST is
    // unreachable. Every DB-side rule stays quiet in that state — the metrics
    // scrape keeps succeeding, so ReadmoDBUnreachable does too — and the only
    // thing that moves is the share of API responses that are 5xx.
    const rule = byName('ReadmoApiErrorsHigh');
    expect(rule).toBeDefined();
    expect(rule!.expr).toContain('http_status_codes_total');
    expect(rule!.expr, 'must be restricted to 5xx, not all responses').toMatch(
      /5\.\./,
    );
  });

  it('watches transactions that abort instead of committing', () => {
    // A statement that dies before parse-analysis never gets a queryid, so
    // pg_stat_statements never records it: the query-rate and mean-duration
    // rules stay flat while the database does nothing but roll transactions
    // back. Nothing else in this file moves in that state.
    const rule = byName('ReadmoDBTransactionAbortStorm');
    expect(rule).toBeDefined();
    expect(rule!.expr).toContain('pg_stat_database_xact_rollback');
    expect(rule!.expr).toContain('pg_stat_database_xact_commit');
  });

  it('keeps every ratio alert quiet on an idle project', () => {
    // Two different failures, both needed. Without clamp_min the denominator can
    // be zero; without an absolute floor the ratio is meaningful but the sample
    // isn't, and one stray response out of two pages someone at 3am on a project
    // nobody is using. readmo's normal volume is a few thousand requests a DAY,
    // so this is not a hypothetical margin.
    for (const name of ['ReadmoApiErrorsHigh', 'ReadmoDBTransactionAbortStorm']) {
      const rule = byName(name);
      expect(rule, `${name} is missing`).toBeDefined();
      expect(rule!.expr, `${name} can divide by zero`).toContain('clamp_min');
      // An `and` clause holding the expression to a minimum absolute rate.
      expect(rule!.expr, `${name} has no absolute floor`).toMatch(
        /\band\b[\s\S]*>\s*[\d.]+/,
      );
    }
  });
});
