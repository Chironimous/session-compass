/**
 * Context history of one session, rebuilt from its Claude Code JSONL
 * transcript (a backfill, once per session; later points come live from
 * `turn.step`). Pure and line-based, so a streamed file can be fed in
 * pieces of any size.
 *
 * One point per model request of the main conversation: the request's
 * context = uncached input + cache read + cache created (output excluded),
 * the same formula as the status line. Each point remembers the prompt it
 * belongs to; prompts are the records Claude Code's transcript shows as
 * typed prompts or slash commands (a simplified form of
 * model/classify.js: the JSONL format is undocumented and drifts).
 */

export type History = {
  /** Context tokens per request, in order. */
  tokens: number[]
  /** For each point, the 1-based number of its prompt (0: before any prompt). */
  promptOf: number[]
  /** The first PROMPT_CHARS characters of each prompt, in order. */
  prompts: string[]
  /**
   * Each prompt's row id (the transcript record's `uuid`, which the engine
   * also draws the prompt's transcript row under); '' when unknown.
   */
  ids: string[]
}

export const PROMPT_CHARS = 100

const INTERRUPTION = /^\s*\[Request interrupted/i

export function emptyHistory(): History {
  return { tokens: [], promptOf: [], prompts: [], ids: [] }
}

/**
 * A request's context: uncached input + cache read + cache created. The
 * transcript's `usage` and the live `turn.step` usage share these names.
 */
export function contextOf(usage: {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
}

/**
 * A parsed transcript: the history plus when each prompt and request was
 * written (ms since the epoch, NaN without a timestamp). The times are not
 * stored; they only let a merge recognise live entries the file already has.
 */
export type ParsedHistory = History & {
  promptAt: number[]
  tokenAt: number[]
}

/** Feeds raw text in pieces; complete lines are parsed as they arrive. */
export class HistoryParser {
  readonly history: ParsedHistory = { ...emptyHistory(), promptAt: [], tokenAt: [] }
  private rest = ''
  private readonly seen = new Set<string>()

  push(text: string): void {
    const lines = (this.rest + text).split('\n')
    this.rest = lines.pop() ?? ''
    for (const line of lines) this.line(line)
  }

  end(): ParsedHistory {
    if (this.rest) this.line(this.rest)
    this.rest = ''
    return this.history
  }

  private line(raw: string): void {
    const line = raw.trim()
    if (!line) return
    let record: any
    try {
      record = JSON.parse(line)
    } catch {
      return // a partially written line
    }
    if (!record || typeof record !== 'object' || record.isSidechain === true) return
    const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : Number.NaN
    if (record.type === 'user') {
      const text = promptText(record)
      if (text !== null) {
        this.history.prompts.push(text)
        this.history.ids.push(typeof record.uuid === 'string' ? record.uuid : '')
        this.history.promptAt.push(at)
      }
      return
    }
    if (record.type !== 'assistant') return
    const usage = record.message?.usage
    if (!usage || typeof usage !== 'object') return
    // One request spans several records (one per content block): count it once.
    const id = record.requestId ?? record.message?.id
    if (typeof id === 'string') {
      if (this.seen.has(id)) return
      this.seen.add(id)
    }
    const tokens = contextOf(usage)
    if (!(tokens > 0)) return // synthetic messages (API errors) carry no usage
    this.history.tokens.push(tokens)
    this.history.promptOf.push(this.history.prompts.length)
    this.history.tokenAt.push(at)
  }
}

/**
 * A prompt or request recorded live, with when the hook saw it (ms). A
 * prompt's `id` is its row id once `session.append` has handed it over,
 * which may happen before or after the prompt is recorded.
 */
export type LiveEntry =
  | { kind: 'prompt'; text: string; at: number; id?: string }
  | { kind: 'point'; tokens: number; at: number }

/** How far apart a live entry and its transcript record may be and still be one. */
export const SAME_ENTRY_MS = 10_000

/**
 * The transcript a history was read from, kept to recognise live entries
 * it already holds; `used*` mark records already matched to one.
 */
export type TranscriptMatch = {
  parsed: ParsedHistory
  usedPrompts: Set<number>
  usedTokens: Set<number>
}

export function matchOf(parsed: ParsedHistory): TranscriptMatch {
  return { parsed, usedPrompts: new Set(), usedTokens: new Set() }
}

/**
 * Appends live entries to a history, in order. With `match` (the history
 * was read from the transcript), an entry the transcript already holds is
 * skipped: the same prompt text, or the same request size, written at most
 * SAME_ENTRY_MS from when the hook saw it. Each transcript record stands for
 * one live entry at most, so a repeat at another time is kept.
 */
export function appendLive(target: History, entries: readonly LiveEntry[], match?: TranscriptMatch): void {
  const parsed = match?.parsed
  const usedPrompts = match?.usedPrompts ?? new Set<number>()
  const usedTokens = match?.usedTokens ?? new Set<number>()
  const near = (a: number, b: number) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= SAME_ENTRY_MS
  for (const entry of entries) {
    if (entry.kind === 'prompt') {
      const twin = parsed?.prompts.findIndex((text, index) =>
        !usedPrompts.has(index) && text === entry.text && near(parsed.promptAt[index] ?? Number.NaN, entry.at))
      if (twin !== undefined && twin >= 0) {
        usedPrompts.add(twin)
        if (entry.id && !target.ids[twin]) target.ids[twin] = entry.id
        continue
      }
      target.prompts.push(entry.text)
      target.ids.push(entry.id ?? '')
    } else {
      const twin = parsed?.tokens.findIndex((tokens, index) =>
        !usedTokens.has(index) && tokens === entry.tokens && near(parsed.tokenAt[index] ?? Number.NaN, entry.at))
      if (twin !== undefined && twin >= 0) {
        usedTokens.add(twin)
        continue
      }
      target.tokens.push(entry.tokens)
      target.promptOf.push(target.prompts.length)
    }
  }
}

/**
 * The prompt's text when a user record is a typed prompt or a slash
 * command, else null (tool results, notices, injected meta records).
 */
export function promptText(record: any): string | null {
  if (record.origin?.kind === 'task-notification') return null
  const content = typeof record.message === 'string' ? record.message : record.message?.content
  if (typeof content === 'string') {
    if (INTERRUPTION.test(content)) return null
    if (content.includes('<command-name>')) {
      const name = content.match(/<command-name>(\/?[\w:-]+)<\/command-name>/)?.[1] ?? '/unknown'
      const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
      return clipPrompt(`${name.startsWith('/') ? name : `/${name}`}${args ? ` ${args}` : ''}`)
    }
    if (content.includes('<local-command-caveat>') || content.includes('<local-command-stdout>')) return null
    if (content.trimStart().startsWith('<task-notification>')) return null
    if (record.isMeta === true) return null
    return clipPrompt(content)
  }
  if (Array.isArray(content)) {
    const first = content.find((block: any) => block?.type === 'text')
    if (typeof first?.text === 'string' && INTERRUPTION.test(first.text)) return null
    if (record.isMeta === true) return null
    const parts = content
      .filter((block: any) => ['text', 'image', 'document'].includes(block?.type))
      .map((block: any) => block.type === 'text' ? String(block.text ?? '') : `[${block.type}]`)
    return parts.length > 0 ? clipPrompt(parts.join(' ')) : null
  }
  return null
}

/** Harness tags out, whitespace collapsed, at most PROMPT_CHARS characters. */
export function clipPrompt(text: string): string {
  const clean = text
    .replace(/<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>[\s\S]*?<\/\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return clean.length > PROMPT_CHARS ? `${clean.slice(0, PROMPT_CHARS - 1)}…` : clean
}
