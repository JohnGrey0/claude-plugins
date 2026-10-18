import { expect, mock, test } from 'claude-code/testing'

const T0 = Date.parse('2026-10-17T20:00:00Z')
const RESET = '2026-10-17T21:30:00Z'

/** The world beneath the plugin: a mocked clock, a roster of agents, and recorders. */
function world(on: any, roster: { id: string; status: string; description: string }[]) {
  const clock = mock.clock(on, { now: T0 })
  const sent: { to: unknown; text: string }[] = []
  on('session.send', (_$: any, e: any) => {
    sent.push({ to: e.to, text: e.text })
    return { isDelivered: true }
  })
  on('agent.list', () => ({ value: roster }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('session.measure', (_$: any, e: any) => ({ changed: e.changed }))
  on('classic.StopFailure', () => ({}))
  on('turn.complete', () => ({ text: '' }))
  return { clock, sent }
}

const measure = (pct: number) => ({
  context: {} as any,
  rateLimits: [{ kind: 'five_hour', percentUsed: pct, resetsAt: RESET }],
  changed: ['rateLimits'] as any,
})

test('a subagent stopped by the usage limit is restarted after the reset', async ($: any, on: any) => {
  const { clock, sent } = world(on, [{ id: 'a1', status: 'failed', description: 'perf lane' }])
  await $.session.measure(measure(100))
  await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'a1', agent_type: 'general-purpose' })

  // Nothing before the reset.
  await clock.advance(Date.parse(RESET) - T0 - 1000)
  expect(sent.length).toBe(0)

  // The reset, plus the buffer of 90 s.
  await clock.advance(120_000)
  expect(sent.length).toBe(1)
  expect(sent[0].to).toBe('a1')
  expect(sent[0].text).toContain('usage limit')
})

test('the main session is left to Claude Code itself', async ($: any, on: any) => {
  const { clock, sent } = world(on, [])
  await $.session.measure(measure(100))
  await $.classic.StopFailure({ error: 'rate_limit' })
  await clock.advance(3 * 3600_000)
  expect(sent.length).toBe(0)
})

test('an agent the person stopped is never restarted', async ($: any, on: any) => {
  const { clock, sent } = world(on, [{ id: 'a2', status: 'killed', description: 'gui lane' }])
  await $.session.measure(measure(100))
  await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'a2', agent_type: 'general-purpose' })
  await clock.advance(3 * 3600_000)
  expect(sent.length).toBe(0)
})

test('other errors do not restart an agent', async ($: any, on: any) => {
  const { clock, sent } = world(on, [{ id: 'a3', status: 'failed', description: 'x' }])
  await $.session.measure(measure(40))
  await $.classic.StopFailure({ error: 'server_error', agent_id: 'a3', agent_type: 'general-purpose' })
  await clock.advance(3 * 3600_000)
  expect(sent.length).toBe(0)
})

test('with no reset time it retries after a wait', async ($: any, on: any) => {
  const { clock, sent } = world(on, [{ id: 'a4', status: 'failed', description: 'y' }])
  await $.classic.StopFailure({ error: 'rate_limit', agent_id: 'a4', agent_type: 'general-purpose' })
  await clock.advance(4 * 60_000)
  expect(sent.length).toBe(0)
  await clock.advance(2 * 60_000)
  expect(sent.length).toBe(1)
})
