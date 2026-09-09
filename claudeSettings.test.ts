// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// `.claude/settings.json` is what lets the PR watch arm its own follow-up
// checks and read GitHub without a permission dialog. A dropped entry doesn't
// fail anything — the watch just stalls on a prompt nobody is there to answer,
// which is silent by construction. So the calls the loop makes are asserted
// here rather than discovered in a session.
const allow: string[] = JSON.parse(
  readFileSync(new URL('./.claude/settings.json', import.meta.url), 'utf8'),
).permissions.allow

describe('.claude/settings.json', () => {
  it('allows the scheduler calls the watch re-arms itself with', () => {
    for (const tool of ['send_later', 'create_trigger', 'list_triggers', 'update_trigger', 'delete_trigger']) {
      expect(allow).toContain(`mcp__Claude_Code_Remote__${tool}`)
    }
  })

  it('allows the PR-watch GitHub calls', () => {
    for (const tool of [
      'subscribe_pr_activity',
      'unsubscribe_pr_activity',
      'pull_request_read',
      'add_reply_to_pull_request_comment',
      'resolve_review_thread',
      'create_pull_request',
      'update_pull_request',
      'merge_pull_request',
    ]) {
      expect(allow).toContain(`mcp__github__${tool}`)
    }
  })

  // A tool name takes no arguments, so there is nothing to inject. A `Bash(…)`
  // rule is a pattern over a whole command line, and a trailing `*` matches the
  // rest of it: `Bash(git push origin claude/*)` also admits
  // `git push origin claude/topic:main`, where the text after the colon is the
  // destination. That boundary is the point of this file.
  // A bare `Bash` is the wider rule of the two — it preauthorizes every command
  // rather than a pattern — so a check that only rejected `Bash(` would stay
  // green through the worse edit.
  it('preauthorizes no shell command', () => {
    expect(allow.filter((rule) => rule === 'Bash' || rule.startsWith('Bash('))).toEqual([])
  })
})
