import type { Register, SessionRateLimit } from 'claude-code'

/** Wait this long past the reported reset, so the first request lands after it. */
export const BUFFER_MS = 90_000
/** When no window says when it resets: wait this long, then this, then the last again. */
export const BACKOFF_MS = [5, 15, 30, 60].map(m => m * 60_000)
/** Give up on an agent that hits the limit this many times in a row. */
export const MAX_TRIES = 3
/** A window this full when a subagent's turn dies on an error counts as the cause. */
const FULL = 99

export const RESUME_TEXT =
  '[resume-agents] The usage limit that stopped you has reset. Continue your task from exactly ' +
  'where you stopped. A command or test that was running when you stopped did not finish: run it ' +
  'again before you rely on its result. Then finish the task and report as you were asked to.'

type Stopped = { id: string; description: string; tries: number }

/** "1h 42m", "7m", "40s" */
export function wait(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m`
  return `${s}s`
}

/**
 * When the limit resets, from the last rate-limit reading: the latest reset among
 * the full windows, else the fullest window at 90% or more (the reading taken
 * before the refusal can lag a point or two).
 */
export function resetFrom(limits: readonly SessionRateLimit[], now: number): number | undefined {
  const timed = limits
    .map(l => ({ pct: l.percentUsed, at: l.resetsAt ? Date.parse(l.resetsAt) : NaN }))
    .filter(l => Number.isFinite(l.at) && l.at > now)
  const full = timed.filter(l => l.pct >= 100)
  if (full.length > 0) return Math.max(...full.map(l => l.at))
  return timed.filter(l => l.pct >= 90).sort((a, b) => b.pct - a.pct)[0]?.at
}

/** What one load of the module remembers. A reload starts it over. */
type State = {
  limits: readonly SessionRateLimit[]
  stopped: Map<string, Stopped>
  timer?: { cancel: () => void }
  dueAt?: number
  backoff: number
  enabled: boolean
}

const S: State = { limits: [], stopped: new Map(), backoff: 0, enabled: true }

function limitIsFull(): boolean {
  return S.limits.some(l => l.percentUsed >= FULL)
}

function clear($: any): void {
  S.timer?.cancel()
  S.timer = undefined
  S.dueAt = undefined
  $.ui.status(undefined)
}

async function resumeAll($: any): Promise<number> {
  clear($)
  const agents: { id: string; status: string }[] = await $.agent.list().catch(() => [])
  const status = new Map(agents.map(a => [a.id, a.status]))
  let sent = 0
  for (const s of [...S.stopped.values()]) {
    // An agent the person stopped, or one that finished or runs again, stays as it is.
    const now = status.get(s.id)
    if (now === 'killed' || now === 'completed' || now === 'running') {
      S.stopped.delete(s.id)
      continue
    }
    const r = await $.session.send({ to: { agentId: s.id }, text: RESUME_TEXT }).catch(() => undefined)
    // A delivered agent stays listed until it ends a turn normally; a second limit adds a try.
    if (r?.isDelivered) sent += 1
    else S.stopped.delete(s.id)
  }
  if (sent > 0) {
    $.ui.toast(`resume-agents: restarted ${sent} agent${sent === 1 ? '' : 's'} after the usage limit reset.`)
  }
  return sent
}

async function schedule($: any): Promise<void> {
  if (!S.enabled || S.stopped.size === 0) return
  const now: number = await $.clock.now()
  const reset = resetFrom(S.limits, now)
  const at =
    reset !== undefined ? reset + BUFFER_MS : now + BACKOFF_MS[Math.min(S.backoff, BACKOFF_MS.length - 1)]
  if (reset === undefined) S.backoff += 1
  // One timer serves every stopped agent: keep the later of two times.
  if (S.dueAt !== undefined && S.dueAt >= at) return
  S.timer?.cancel()
  S.dueAt = at
  S.timer = $.clock.after(at - now, () => void resumeAll($))
  const n = S.stopped.size
  $.ui.status(`⏸ ${n} agent${n === 1 ? '' : 's'} stopped by the usage limit · restart in ${wait(at - now)}`)
}

async function noteStopped($: any, id: string): Promise<void> {
  const known = S.stopped.get(id)
  const tries = (known?.tries ?? 0) + 1
  if (tries > MAX_TRIES) {
    S.stopped.delete(id)
    $.ui.toast(`resume-agents: agent ${id} hit the usage limit ${MAX_TRIES} times in a row; left stopped.`)
    return
  }
  const agents: { id: string; description: string }[] = await $.agent.list().catch(() => [])
  const description = agents.find(a => a.id === id)?.description ?? known?.description ?? id
  S.stopped.set(id, { id, description, tries })
  await schedule($)
}

async function statusText($: any): Promise<string> {
  const now: number = await $.clock.now()
  const list = [...S.stopped.values()].map(s => `  ${s.description} (${s.id}), try ${s.tries} of ${MAX_TRIES}`)
  const head = !S.enabled
    ? 'resume-agents is off.'
    : S.stopped.size === 0
      ? 'resume-agents is on. No agent is waiting for the limit.'
      : `resume-agents: ${S.stopped.size} waiting, restart in ${wait((S.dueAt ?? now) - now)}:`
  return [head, ...list].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'resume-agents',
      description: 'Subagents stopped by a usage limit: status | now | cancel | off | on',
    })
    return next(e)
  })

  // The latest rate-limit reading: which window is full, and when it resets.
  on('session.measure', ($, e, next) => {
    S.limits = e.rateLimits
    if (e.rateLimits.every(l => l.percentUsed < 90)) S.backoff = 0
    return next(e)
  })

  // A subagent's turn that ended on the usage limit. The main session is left to
  // Claude Code's own "continue automatically at usage limit".
  on('classic.StopFailure', async ($, e, next) => {
    const result = await next(e)
    if (e.agent_id && e.error === 'rate_limit') await noteStopped($, e.agent_id)
    return result
  }).catch(($, e, next) => next(e))

  // The same end seen from the turn: an API error while a window is full.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined && e.reason === 'error' && limitIsFull()) await noteStopped($, e.agentId)
    if (e.agentId !== undefined && e.reason === 'answer') S.stopped.delete(e.agentId)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'resume-agents' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'off') {
      S.enabled = false
      clear($)
      return { text: 'resume-agents is off for this session.' }
    }
    if (arg === 'on') {
      S.enabled = true
      await schedule($)
      return { text: 'resume-agents is on.' }
    }
    if (arg === 'cancel') {
      const n = S.stopped.size
      S.stopped.clear()
      clear($)
      return { text: n ? `Forgot ${n} stopped agent${n === 1 ? '' : 's'}.` : 'Nothing is pending.' }
    }
    if (arg === 'now') {
      const sent = await resumeAll($)
      return { text: sent ? `Restarted ${sent} agent${sent === 1 ? '' : 's'}.` : 'No agent was waiting.' }
    }
    return { text: await statusText($) }
  })
}
