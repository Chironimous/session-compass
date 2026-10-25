import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'
import type { SessionHistory } from '../types/index'
import type { SessionNode } from './model/ast.js'
import {
  detailsRows,
  digestOf,
  estimateSeconds,
  formatSeconds,
  generatedLine,
  infoCopyText,
  INFO_MAX_TOKENS,
  INFO_MODEL,
  markdownTable,
  mergeStructuralEvents,
  parseSummaryFile,
  parseTimeline,
  parseTimelineFile,
  progressFraction,
  statsOf,
  summaryFileOf,
  SUMMARY_SYSTEM_PROMPT,
  TIMELINE_SYSTEM_PROMPT,
  withSample,
  withTimestamps,
  BUTTON_HEADER,
  BUTTON_LEGEND,
  BUTTON_ROWS,
  plainCell,
  type InfoStats,
  type SummaryRecord,
  type TimelineRecord,
} from './info'
import { colorFor, promptsLabel, rasterCells, svgSource } from './graph'
import { BAR_COLUMNS, bandParts, GRAPH_COLUMNS, headerParts, SPARK_CELLS } from './layout'
import {
  appendLive,
  clipPrompt,
  contextOf,
  HistoryParser,
  matchOf,
  SAME_ENTRY_MS,
  type LiveEntry,
  type ParsedHistory,
  type TranscriptMatch,
} from './history'
import {
  answerMarkdown,
  conversationOf,
  copyTextOf,
  findMatches,
  matchLabel,
  nextMatch,
  thumbnailOf,
  parseIgnoreList,
  recordsOf,
  whenOf,
  type BrowserEntry,
  type IgnoreRules,
} from './browser'

const percent = atom({ plugin: 'session-compass', key: 'percent' } as const, null)
const history = atom({ plugin: 'session-compass', key: 'history' } as const, null)
const cursor = atom({ plugin: 'session-compass', key: 'cursor' } as const, null)
const browseAt = atom({ plugin: 'session-compass', key: 'browseAt' } as const, null)
const browseVersion = atom({ plugin: 'session-compass', key: 'browseVersion' } as const, 0)
const browseQuery = atom({ plugin: 'session-compass', key: 'browseQuery' } as const, '')
const infoTab = atom({ plugin: 'session-compass', key: 'infoTab' } as const, 'summary')
const infoVersion = atom({ plugin: 'session-compass', key: 'infoVersion' } as const, 0)

/** The usage bar's cells (10 since 2026-10-19, to make room for the navigator). */
const CELLS = 10
/** The terminal legend's button column: the widest label, `◀◀ ◀ n/N ▶ ▶▶`, and a gap. */
const LEGEND_BUTTON_COLUMNS = 16
/**
 * The graph keeps its size although the bar shrank (decided 2026-10-19). In
 * the VS Code panel it is a measured constant: at 240 the graph showed
 * 286 px next to a 220 px bar of 20 cells (extension 2.1.301).
 */
const GRAPH_WIDTH = 185
const GRAPH_HEIGHT = 22
/** The ◀◀ / ▶▶ buttons jump this many prompts. */
const BIG_STEP = 10
/**
 * The stored history's format: 2 since row ids (2026-10-19). A history held
 * or stored in an older one is rebuilt from the transcript once.
 */
const FORMAT = 2

/** One key per session; `index` lists them for pruning. */
const STORE_PREFIX = 'session:'
const STORE_INDEX = 'index'
/** $.store holds 4 MiB in all: keep the histories well below it. */
const STORE_BUDGET = 2 * 1024 * 1024
const STORE_SESSIONS = 200

type IndexEntry = { id: string; at: number; bytes: number }

/**
 * The working copy of the session's history; the `history` state is what
 * the band draws (a copy is published after every change). Entries that
 * arrive while the history loads wait in `pending`.
 */
let live: SessionHistory | null = null
let loadingId: string | null = null
let pending: LiveEntry[] = []
/**
 * The transcript the held history was read from, if it was: live entries
 * are checked against it during and after the load (a hook that awaited
 * across the end of the load records past the queue).
 */
let transcript: TranscriptMatch | undefined
/**
 * Prompt rows `session.append` stored before their prompt was recorded (the
 * engine stores the row while `prompt.submit` is still answering): the next
 * recorded prompt takes the first one that is at most SAME_ENTRY_MS old.
 */
let storedRows: Array<{ id: string; at: number }> = []

/**
 * Workaround for the VS Code panel (extension 2.1.301): it sometimes refuses
 * the first picture of a freshly started panel ("Picture not shown in this
 * editor") and only asks again when the picture's source changes; an equal
 * source is ignored. So a few seconds after the graph first appears, the
 * unchanged graph is drawn again with a changed source (an SVG comment).
 */
const REDRAW_AFTER_MS = [3_000, 10_000]
let redraw = 0
let redrawsScheduled = false

function scheduleRedraws($: EngineInterface): void {
  if (redrawsScheduled) return
  redrawsScheduled = true
  for (const ms of REDRAW_AFTER_MS) {
    $.clock.after(ms, () => {
      redraw += 1
      void publish($)
    })
  }
}

function emptyOf(id: string): SessionHistory {
  return { id, format: FORMAT, window: null, tokens: [], promptOf: [], prompts: [], ids: [] }
}

function copyOf(source: SessionHistory): SessionHistory {
  return {
    ...source,
    tokens: [...source.tokens],
    promptOf: [...source.promptOf],
    prompts: [...source.prompts],
    ids: [...source.ids],
  }
}

/**
 * Publishes and saves run one at a time, each taking the working copy as it
 * is when its turn comes: concurrent hooks (a load finishing while a request
 * is recorded) must not let an older snapshot land last.
 */
let publishing: Promise<void> = Promise.resolve()
let saving: Promise<void> = Promise.resolve()

function publish($: EngineInterface): Promise<void> {
  if (live && live.tokens.length > 0) scheduleRedraws($) // the graph appears now
  publishing = publishing
    .catch(() => undefined)
    .then(async () => {
      await update($, history, () => (live ? copyOf(live) : null))
    })
  return publishing
}

/** When the last prompt was recorded live (ms); a row id attaches only to a recent one. */
let lastPromptAt = Number.NEGATIVE_INFINITY

function record(entry: LiveEntry): void {
  if (entry.kind === 'prompt') {
    if (entry.id === undefined) {
      const row = storedRows.find(stored => Math.abs(entry.at - stored.at) <= SAME_ENTRY_MS)
      if (row) entry.id = row.id
    }
    storedRows = []
    lastPromptAt = entry.at
  }
  if (loadingId !== null) pending.push(entry)
  else if (live) appendLive(live, [entry], transcript)
}

/**
 * A stored prompt row's id: given to the prompt recorded just before (at
 * most SAME_ENTRY_MS ago) when it has none yet, else kept for the prompt
 * about to be recorded. True when a held prompt took it.
 */
function recordRow(id: string, at: number): boolean {
  if (Math.abs(at - lastPromptAt) <= SAME_ENTRY_MS) {
    const entry = [...pending].reverse().find((e): e is LiveEntry & { kind: 'prompt' } => e.kind === 'prompt')
    if (entry) {
      if (!entry.id) entry.id = id
      return false // not yet in the history: nothing to publish
    }
    if (live && live.prompts.length > 0 && !live.ids[live.prompts.length - 1]) {
      live.ids[live.prompts.length - 1] = id
      return true
    }
  }
  storedRows.push({ id, at })
  return false
}

/** Starts loading the session's history when it is not the one held. */
async function track($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  if (live?.id === id || loadingId === id) return
  loadingId = id
  pending = []
  void load($, id).catch(error => debug($, `load failed: ${messageOf(error)}`))
}

async function load($: EngineInterface, id: string): Promise<void> {
  let base: SessionHistory | null = null
  // Set when the history was just read from the transcript, which may
  // already hold the prompts and requests that arrived meanwhile.
  let parsed: ParsedHistory | undefined
  let rebuilt = false
  try {
    // A hot reload keeps the state but not this module's variables.
    const held = await read($, history)
    const known = held?.id === id ? historyOf(id, held) : await fromStore($, id)
    if (known && known.format === FORMAT) {
      base = known
    } else {
      // None yet, or written by an earlier build: before row ids existed,
      // or by the build of 2026-10-19 whose failed load saved a history of
      // only the prompts typed after it. The transcript is the truth.
      parsed = (await backfill($, id).catch(error => {
        debug($, `transcript of ${id} not read: ${messageOf(error)}`)
        return null
      })) ?? undefined
      if (parsed) {
        base = {
          id,
          format: FORMAT,
          window: known?.window ?? null,
          tokens: [...parsed.tokens],
          promptOf: [...parsed.promptOf],
          prompts: [...parsed.prompts],
          ids: [...parsed.ids],
        }
        if (known) {
          rebuilt = true
          debug($, `history of ${id} rebuilt from the transcript (was format ${known.format})`)
        }
      } else if (known) {
        base = { ...known, format: FORMAT } // no transcript: keep what is held, ask once
      }
    }
  } catch (error) {
    debug($, `history of ${id} unavailable: ${messageOf(error)}`)
  }
  let window: number | null = null
  try {
    window = (await $.session.usage()).context.window ?? null
  } catch {
    window = null
  }
  // From here on nothing awaits until `live` holds the merged history.
  const merged = base ?? emptyOf(id)
  if (window) merged.window = window
  const waiting = pending
  transcript = parsed ? matchOf(parsed) : undefined
  appendLive(merged, waiting, transcript)
  live = merged
  loadingId = null
  pending = []
  await publish($)
  await update($, cursor, held => (held !== null && held >= 1 && held <= merged.prompts.length ? held : newestOf(merged)))
  if (parsed || rebuilt || waiting.length > 0) await persist($)
}

function newestOf(source: SessionHistory): number | null {
  return source.prompts.length > 0 ? source.prompts.length : null
}

async function fromStore($: EngineInterface, id: string): Promise<SessionHistory | null> {
  return historyOf(id, await $.store.get(STORE_PREFIX + id))
}

/**
 * A history as held in the state or the store, checked field by field: a
 * value written by an earlier version of the mod (no `ids` before
 * 2026-10-19) must not fail the load. Null when it is no history.
 */
function historyOf(id: string, value: unknown): SessionHistory | null {
  const source = value as Partial<SessionHistory> | null | undefined
  if (!source || !Array.isArray(source.tokens) || !Array.isArray(source.promptOf) || !Array.isArray(source.prompts)) return null
  const prompts = source.prompts.filter((s): s is string => typeof s === 'string')
  const ids = (Array.isArray(source.ids) ? source.ids : []).map(s => (typeof s === 'string' ? s : ''))
  while (ids.length < prompts.length) ids.push('')
  return {
    id,
    format: typeof source.format === 'number' ? source.format : 1,
    window: typeof source.window === 'number' ? source.window : null,
    tokens: source.tokens.filter((n): n is number => typeof n === 'number'),
    promptOf: source.promptOf.filter((n): n is number => typeof n === 'number'),
    prompts,
    ids: ids.slice(0, prompts.length),
  }
}

/** Saves the held history and drops the oldest sessions past the budget. */
function persist($: EngineInterface): Promise<void> {
  saving = saving.catch(() => undefined).then(() => save($))
  return saving
}

async function save($: EngineInterface): Promise<void> {
  if (!live) return
  const value = copyOf(live)
  const bytes = JSON.stringify(value).length
  await $.store.set(STORE_PREFIX + value.id, value)
  const stored = await $.store.get(STORE_INDEX)
  const index = (Array.isArray(stored) ? stored as IndexEntry[] : []).filter(entry => entry.id !== value.id)
  index.unshift({ id: value.id, at: await $.clock.now(), bytes })
  const kept: IndexEntry[] = []
  let total = 0
  for (const entry of index) {
    if (kept.length < STORE_SESSIONS && total + entry.bytes <= STORE_BUDGET) {
      kept.push(entry)
      total += entry.bytes
    } else {
      await $.store.delete(STORE_PREFIX + entry.id)
    }
  }
  await $.store.set(STORE_INDEX, kept)
}

/**
 * Rebuilds the history from the session's transcript, once: the file is
 * streamed through the OS's own printer (`cat`, Windows `type`), so its
 * size is not bound by the 4 MiB of `$.fs.read`, and parsed line by line.
 */
async function backfill($: EngineInterface, id: string): Promise<ParsedHistory | null> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const file = await findTranscript($, id, windows)
  if (!file) {
    debug($, `no transcript found for ${id}`)
    return null
  }
  const parser = new HistoryParser()
  const stream = $.process.spawn({ argv: windows ? ['cmd.exe', '/d', '/c', 'type', file] : ['cat', file] })
  for await (const chunk of stream) {
    if (chunk.stream === 'stdout') parser.push(chunk.text)
  }
  return parser.end()
}

/** Claude Code's configuration folder: `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
async function configDir($: EngineInterface, windows: boolean): Promise<string | null> {
  const home = windows ? await $.env.get('USERPROFILE') : await $.env.get('HOME')
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (home ? `${home}${windows ? '\\' : '/'}.claude` : null)
}

/** `<config>/projects/<slug>/<id>.jsonl`: the slug of the cwd first, else every project. */
async function findTranscript($: EngineInterface, id: string, windows: boolean): Promise<string | null> {
  const sep = windows ? '\\' : '/'
  const config = await configDir($, windows)
  if (!config) return null
  const projects = `${config}${sep}projects`
  const file = `${id}.jsonl`
  for (const dir of new Set([await $.session.cwd(), await $.session.root()])) {
    const candidate = `${projects}${sep}${dir.replace(/[^A-Za-z0-9]/g, '-')}${sep}${file}`
    if (await $.fs.exists(candidate)) return candidate
  }
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind !== 'dir') continue
    const candidate = `${projects}${sep}${entry.name}${sep}${file}`
    if (await $.fs.exists(candidate)) return candidate
  }
  return null
}

/**
 * Puts `/<command>` into the prompt box, so Enter opens the command's own
 * dialog (better than the transcript text `$.command.run` writes): on a new
 * line after a draft, else alone. Falls back to running the command where
 * the box refuses the text (a dialog holds the keys, no box) or the fill
 * fails; that needs the engine to list the command.
 */
async function offerCommand($: EngineInterface, command: string): Promise<void> {
  try {
    const { text } = await $.prompt.read()
    const prefix = text.length === 0 || text.endsWith('\n') ? '' : '\n'
    const filled = await $.prompt.fill({ text: `${prefix}/${command}`, mode: 'append' })
    if (filled.isFilled) return
    debug($, `/${command} not filled in (${filled.refusal ?? 'refused by a hook'}); running it instead`)
  } catch (error) {
    debug($, `/${command} not filled in (${messageOf(error)}); running it instead`)
  }
  await $.command.run({ command })
}

/**
 * Moves the navigator's cursor to prompt `to` (clamped to the prompts held)
 * and scrolls the transcript to that prompt's row, its top at the window's
 * top. A prompt whose row id is unknown, or whose row the surface does not
 * scroll, moves the cursor only; the refusal goes to the debug log.
 */
async function jump($: EngineInterface, to: number): Promise<void> {
  if (!live || live.prompts.length === 0) return
  const target = Math.min(live.prompts.length, Math.max(1, to))
  const id = live.ids[target - 1]
  // The scroll is asked for first, before anything here awaits: the engine
  // moves a transcript row only while the call answers the press. Called
  // after the cursor's state round trips it was refused "not person-
  // initiated" (2026-10-19), so the cursor moves second.
  const scrolling = id ? $.ui.scroll({ to: { requestId: id }, block: 'start' }) : undefined
  await update($, cursor, () => target)
  if (!id || !scrolling) {
    debug($, `prompt ${target}: row id unknown, not scrolled`)
    return
  }
  try {
    const result = await scrolling
    if (result.deny) debug($, `prompt ${target} (row ${id}) not scrolled to: ${result.deny}`)
  } catch (error) {
    debug($, `prompt ${target} (row ${id}) not scrolled to: ${messageOf(error)}`)
  }
}

/**
 * The conversation browser (VS Code panel only, decided 2026-10-24): the
 * panel refuses a mod's scroll to a chat message, so instead of jumping, a
 * pane shows one prompt and its answer at a time. Its data is read from the
 * transcript when the pane opens, and again after each turn while it is
 * open (19 MB streamed in 1.1 s in the panel, 2026-10-24), and kept in this
 * module only: nothing of it is stored.
 */
const BROWSER_ID = 'session-compass-browser'
const BROWSER_TITLE = 'Browser'
/** At most this many characters of a prompt are drawn. */
const PROMPT_LIMIT = 8_000

type Browser = { sessionId: string; session: SessionNode; entries: BrowserEntry[]; warnings: string[] }
let browser: Browser | null = null
let browserError: string | null = null
let browserLoading: Promise<void> | null = null

/** Reads the transcript into the browser's entries; one read at a time. */
function loadBrowser($: EngineInterface): Promise<void> {
  if (browserLoading) return browserLoading
  browserLoading = readBrowser($)
    .catch(error => {
      browserError = messageOf(error)
      debug($, `browser not loaded: ${browserError}`)
    })
    .finally(() => {
      browserLoading = null
    })
  return browserLoading
}

/**
 * A whole file streamed through the OS's own printer (`cat`, Windows
 * `type`): not bound by the 4 MiB of `$.fs.read` (19 MB in 1.1 s in the
 * VS Code panel, 2026-10-24).
 */
async function streamFile($: EngineInterface, file: string, windows: boolean): Promise<string> {
  const parts: string[] = []
  const stream = $.process.spawn({ argv: windows ? ['cmd.exe', '/d', '/c', 'type', file] : ['cat', file] })
  for await (const chunk of stream) {
    if (chunk.stream === 'stdout') parts.push(chunk.text)
  }
  return parts.join('')
}

async function readBrowser($: EngineInterface): Promise<void> {
  const sessionId = await $.session.id()
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const file = await findTranscript($, sessionId, windows)
  if (!file) throw new Error(`no transcript found for session ${sessionId}`)
  const text = await streamFile($, file, windows)
  const rules = await ignoreRules($)
  const { session, entries } = conversationOf(recordsOf(text), rules)
  const before = browser?.sessionId === sessionId ? browser.entries.length : 0
  browser = { sessionId, session, entries, warnings: rules.warnings }
  browserError = null
  // At the newest prompt (or not placed yet), the browser follows new prompts.
  await update($, browseAt, at => (at === null || at > entries.length || at === before ? entries.length || null : at))
  await update($, browseVersion, version => version + 1)
}

/**
 * The person's rules in `<config>/session-compass/.ccscignore`, outside the
 * mod's folder, which a marketplace update replaces (decided 2026-10-25). On
 * first use it is created from the `.ccscignore` an older version kept in the
 * mod's folder, else from the shipped `.ccscignore.def`; from then on the
 * person edits it, and no update touches it.
 */
async function ignoreRules($: EngineInterface): Promise<IgnoreRules> {
  const windows = (await $.env.get('OS')) === 'Windows_NT'
  const sep = windows ? '\\' : '/'
  try {
    const config = await configDir($, windows)
    if (!config) throw new Error('no configuration folder')
    const file = `${config}${sep}session-compass${sep}.ccscignore`
    let content = ''
    if (await $.fs.exists(file)) {
      content = String(await $.fs.read(file))
    } else {
      const older = `${$.plugin.root}${sep}.ccscignore`
      const template = `${$.plugin.root}${sep}.ccscignore.def`
      const source = (await $.fs.exists(older)) ? older : (await $.fs.exists(template)) ? template : null
      content = source ? String(await $.fs.read(source)) : ''
      await $.fs.write(file, content)
    }
    return parseIgnoreList(content)
  } catch (error) {
    debug($, `.ccscignore not read: ${messageOf(error)}`)
    return parseIgnoreList('')
  }
}

/**
 * Opens the browser pane, first of all: an open answering the press is
 * placed at any width, as the scroll was only moved while it answered
 * (2026-10-19). Then reads the transcript.
 */
async function openBrowser($: EngineInterface): Promise<void> {
  const opening = $.ui.open({ id: BROWSER_ID, title: BROWSER_TITLE, closeOnEscape: true })
  await loadBrowser($)
  const opened = await opening
  if (!opened.isPlaced) debug($, `browser not placed: ${opened.reason}`)
}

/**
 * Sets the browser to prompt `n` (a timeline entry's `↓ n`), opening it if
 * needed (first, answering the press). It does not come to the front: no
 * call shows a pane (`$.ui.open` on an open one only retitles it, contract
 * 2.1.304), and closing and reopening the browser or the Info pane did not
 * change the pane shown either (tried 2026-10-25). Hence `↓`, "set the
 * browser to this prompt", rather than an arrow that promises a jump.
 */
async function openBrowserAt($: EngineInterface, n: number): Promise<void> {
  const opening = $.ui.open({ id: BROWSER_ID, title: BROWSER_TITLE, closeOnEscape: true })
  await update($, browseAt, () => n)
  await loadBrowser($)
  const opened = await opening
  if (!opened.isPlaced) debug($, `browser not placed: ${opened.reason}`)
}

/** The magnifier before the search field (chosen 2026-10-25): an SVG, grey for both themes. */
const MAGNIFIER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="#8a8a8a" stroke-width="1.6"/><line x1="10" y1="10" x2="14.5" y2="14.5" stroke="#8a8a8a" stroke-width="1.8" stroke-linecap="round"/></svg>'

/**
 * Puts an earlier prompt back into the prompt box: on a new line after a
 * draft, else alone. Nothing runs if the box refuses it.
 */
async function reusePrompt($: EngineInterface, text: string): Promise<void> {
  const { text: draft } = await $.prompt.read()
  const prefix = draft.length === 0 || draft.endsWith('\n') ? '' : '\n'
  const filled = await $.prompt.fill({ text: `${prefix}${text}`, mode: 'append' })
  if (!filled.isFilled) debug($, `prompt not reused (${filled.refusal ?? 'refused by a hook'})`)
}

/**
 * The Info pane (both surfaces, decided 2026-10-24): what the open
 * conversation was about. Tabs Summary · Timeline · Details (the Description
 * tab was dropped on 2026-10-24: the VS Code panel cannot edit it). Summary
 * and Timeline are made on request with `$.model.complete` (INFO_MODEL) and
 * stored in the project: `<session root>/.ccsc/<session id>/`, the folder
 * self-ignored for git by `.ccsc/.gitignore` (`*`).
 */
const INFO_ID = 'session-compass-info'
const INFO_TITLE = 'Info'
/** The mod's store key of the generation run history (InfoStats). */
const INFO_STATS_KEY = 'info-stats'

type InfoFiles = {
  sessionId: string
  summary: SummaryRecord | null
  timeline: TimelineRecord | null
}
let info: InfoFiles | null = null
let infoLoading: Promise<void> | null = null
let infoError: string | null = null
/**
 * A generation in progress: which part, since when, the expected seconds of
 * both parts (null without a run history), and how to cancel it.
 */
let infoRun: {
  phase: 'summary' | 'timeline'
  startedAt: number
  estimate: { summary: number | null; timeline: number | null }
  controller: AbortController
} | null = null

/** The generation run times, read when the Info pane loads and kept current by each run. */
let infoStats: InfoStats | null = null
/** Digest length per conversation model, so the expected time is not rebuilt on every drawing. */
const digestLengths = new WeakMap<SessionNode, number>()

/** The expected seconds of a whole generation (summary and timeline) for `session`. */
function expectedSeconds(session: SessionNode): number | null {
  if (!infoStats) return null
  let chars = digestLengths.get(session)
  if (chars === undefined) {
    chars = digestOf(session).length
    digestLengths.set(session, chars)
  }
  const summary = estimateSeconds(infoStats, 'summary', chars)
  const timeline = estimateSeconds(infoStats, 'timeline', chars)
  return summary !== null && timeline !== null ? summary + timeline : null
}

function bumpInfo($: EngineInterface): void {
  update($, infoVersion, version => version + 1).catch(error => debug($, `info not redrawn: ${messageOf(error)}`))
}

/** `<session root>/.ccsc` and this conversation's folder in it. */
async function infoPaths($: EngineInterface, sessionId: string) {
  const root = await $.session.root()
  const sep = root.includes('\\') ? '\\' : '/'
  const base = `${root}${sep}.ccsc`
  const dir = `${base}${sep}${sessionId}`
  return {
    gitignore: `${base}${sep}.gitignore`,
    summary: `${dir}${sep}summary.md`,
    timeline: `${dir}${sep}timeline.json`,
  }
}

async function readIfThere($: EngineInterface, file: string): Promise<string | null> {
  return (await $.fs.exists(file)) ? String(await $.fs.read(file)) : null
}

/** Writes one of the conversation's files, creating `.ccsc/.gitignore` first. */
async function writeInfoFile($: EngineInterface, file: string, text: string): Promise<void> {
  const paths = await infoPaths($, info?.sessionId ?? (await $.session.id()))
  if (!(await $.fs.exists(paths.gitignore))) await $.fs.write(paths.gitignore, '*\n')
  await $.fs.write(file, text)
}

/** Reads the conversation (shared with the browser) and its stored files; one load at a time. */
function loadInfo($: EngineInterface): Promise<void> {
  if (infoLoading) return infoLoading
  infoLoading = (async () => {
    await loadBrowser($)
    const sessionId = await $.session.id()
    const paths = await infoPaths($, sessionId)
    const summary = await readIfThere($, paths.summary)
    const timeline = await readIfThere($, paths.timeline)
    infoStats = statsOf(await $.store.get(INFO_STATS_KEY))
    info = {
      sessionId,
      summary: summary === null ? null : parseSummaryFile(summary),
      timeline: timeline === null ? null : parseTimelineFile(timeline),
    }
  })()
    .catch(error => {
      infoError = messageOf(error)
      debug($, `info not loaded: ${infoError}`)
    })
    .finally(() => {
      infoLoading = null
      bumpInfo($)
    })
  return infoLoading
}

/** Redraws the progress bar every second while a generation runs. */
function tickInfo($: EngineInterface): void {
  $.clock.after(1_000, () => {
    if (!infoRun) return
    bumpInfo($)
    tickInfo($)
  })
}

/**
 * Generates Summary, then Timeline, of the open conversation with
 * INFO_MODEL, and stores both. The timeline's JSON is checked entry by
 * entry; an unreadable or empty one is asked for once more. Cancel aborts
 * the call in flight; a finished summary stays.
 */
async function generateInfo($: EngineInterface): Promise<void> {
  if (infoRun) return
  const controller = new AbortController()
  infoRun = { phase: 'summary', startedAt: await $.clock.now(), estimate: { summary: null, timeline: null }, controller }
  infoError = null
  bumpInfo($)
  tickInfo($)
  try {
    await loadBrowser($)
    const sessionId = await $.session.id()
    const conversation = browser?.sessionId === sessionId ? browser : null
    if (!conversation) throw new Error(browserError ?? 'the conversation could not be read')
    const session = conversation.session
    const paths = await infoPaths($, sessionId)
    if (!info || info.sessionId !== sessionId) info = { sessionId, summary: null, timeline: null }
    const digest = digestOf(session)
    const sourceModified = session.properties.modified
    // The estimate: per part, the median ms per digest character of past
    // runs (the mod's store; seeded with the measured Opus runs).
    let stats = statsOf(await $.store.get(INFO_STATS_KEY))
    infoRun.estimate = {
      summary: estimateSeconds(stats, 'summary', digest.length),
      timeline: estimateSeconds(stats, 'timeline', digest.length),
    }
    bumpInfo($)
    const record = async (part: 'summary' | 'timeline', since: number) => {
      stats = withSample(stats, part, { ms: (await $.clock.now()) - since, chars: digest.length })
      infoStats = statsOf(stats)
      await $.store.set(INFO_STATS_KEY, stats).catch(error => debug($, `run time not kept: ${messageOf(error)}`))
    }
    const ask = (system: string) =>
      $.model.complete({ model: INFO_MODEL, system, prompt: digest, maxTokens: INFO_MAX_TOKENS }, { signal: controller.signal })

    const summaryStart = await $.clock.now()
    const summary = await ask(SUMMARY_SYSTEM_PROMPT)
    if (!summary.isAnswered) throw new Error(`no summary (${summary.reason})`)
    const summaryRecord: SummaryRecord = {
      generatedAt: new Date(await $.clock.now()).toISOString(),
      sourceModified,
      model: INFO_MODEL,
      markdown: summary.text.trim(),
    }
    await writeInfoFile($, paths.summary, summaryFileOf(summaryRecord))
    await record('summary', summaryStart)
    info.summary = summaryRecord
    infoRun.phase = 'timeline'
    bumpInfo($)

    const pairIds = new Set(session.pairs.map(pair => pair.id))
    const timelineStart = await $.clock.now()
    let parsed = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const reply = await ask(TIMELINE_SYSTEM_PROMPT)
      if (!reply.isAnswered) throw new Error(`no timeline (${reply.reason})`)
      parsed = parseTimeline(reply.text, pairIds)
      if (parsed.isReadable && parsed.entries.length > 0) break
      debug($, `timeline attempt ${attempt} unusable: ${parsed.problems.join('; ')}`)
    }
    if (!parsed || !parsed.isReadable || parsed.entries.length === 0) {
      throw new Error(`the timeline came back unusable twice (${parsed?.problems.join('; ') || 'no entries'})`)
    }
    if (parsed.problems.length > 0) debug($, `timeline entries dropped: ${parsed.problems.join('; ')}`)
    const timelineRecord: TimelineRecord = {
      version: 1,
      generatedAt: new Date(await $.clock.now()).toISOString(),
      sourceModified,
      model: INFO_MODEL,
      entries: withTimestamps(parsed.entries, session),
    }
    await writeInfoFile($, paths.timeline, `${JSON.stringify(timelineRecord, null, 2)}\n`)
    await record('timeline', timelineStart)
    info.timeline = timelineRecord
  } catch (error) {
    infoError = controller.signal.aborted ? 'Generation cancelled.' : `Generation failed: ${messageOf(error)}`
    debug($, infoError)
  } finally {
    infoRun = null
    bumpInfo($)
  }
}

/** Opens the Info pane, first of all (an open answering the press is placed at any width), then reads. */
async function openInfo($: EngineInterface): Promise<void> {
  const opening = $.ui.open({ id: INFO_ID, title: INFO_TITLE, closeOnEscape: true })
  await loadInfo($)
  const opened = await opening
  if (!opened.isPlaced) debug($, `info not placed: ${opened.reason}`)
}

function debug($: EngineInterface, text: string): void {
  try {
    $.ui.log(`[session-compass] ${text}`, { to: 'debug' })
  } catch {
    // Logging must never fail a hook.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const { context } = await $.session.usage()
    await update($, percent, () => context.percent ?? null)
    await track($)
    return result
  })

  // Pushed by the engine after each main-thread turn whose fill moved.
  on('session.measure', async ($, e, next) => {
    await update($, percent, () => e.context.percent ?? null)
    const window = e.context.window ?? null
    if (live && window && live.window !== window) {
      live.window = window
      await publish($)
    }
    return next(e)
  })

  // One prompt per typed prompt or slash command, counted as the transcript
  // parser counts them: meta prompts and task notifications are not the user's.
  // The cursor moves to the newest prompt with each.
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    try {
      const counted = !e.isMeta && e.origin?.kind !== 'task-notification'
      if (counted && !('drop' in result && result.drop !== undefined)) {
        await track($)
        record({ kind: 'prompt', text: clipPrompt(e.text), at: await $.clock.now() })
        await publish($)
        if (live) await update($, cursor, () => newestOf(live!))
      }
    } catch (error) {
      debug($, `prompt not recorded: ${messageOf(error)}`)
    }
    return result
  }).catch(($, e, next) => next(e)) // a failure here must never hold up a prompt

  // The stored row of a prompt or slash command (the person's, on main) gives
  // the prompt its row id: the scroll target of the navigator.
  on('session.append', async ($, e, next) => {
    const result = await next(e)
    try {
      const counted = (e.door === 'prompt' || e.door === 'command')
        && e.agentId === undefined
        && e.message.isMeta !== true
        && e.origin.kind !== 'task-notification'
      if (counted && result.uuid) {
        if (recordRow(result.uuid, await $.clock.now())) await publish($)
      }
    } catch (error) {
      debug($, `row id not recorded: ${messageOf(error)}`)
    }
    return result
  }).catch(($, e, next) => next(e)) // a failure here must never hold up a row

  // One point per model request of the main conversation, from its own usage.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    try {
      const tokens = e.agentId === undefined && result.usage ? contextOf(result.usage) : 0
      if (tokens > 0) {
        await track($)
        record({ kind: 'point', tokens, at: await $.clock.now() })
        await publish($)
      }
    } catch (error) {
      debug($, `point not recorded: ${messageOf(error)}`)
    }
    return result
  }).catch(async function* ($, e, next) {
    return yield* next(e) // a failure here must never hold up a request
  })

  // Saved once per turn, not per request: the store is one file.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined) await persist($)
    } catch (error) {
      debug($, `history not saved: ${messageOf(error)}`)
    }
    // The browser and the Info pane read the finished turn while one of them
    // is open; with both closed the data is dropped (read again on opening).
    try {
      if (e.agentId === undefined && browser) {
        const open = (await $.ui.panes()).some(pane => pane.id === BROWSER_ID || pane.id === INFO_ID)
        if (open) void loadBrowser($).then(() => bumpInfo($))
        else browser = null
      }
    } catch (error) {
      debug($, `browser not refreshed: ${messageOf(error)}`)
    }
    return result
  })

  on('session.end', async ($, e, next) => {
    try {
      await persist($)
    } catch (error) {
      debug($, `history not saved: ${messageOf(error)}`)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const p = await read($, percent)
    const shown = await read($, history)
    const at = await read($, cursor)
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // By surface, not by the table: the terminal's table answers `'Svg' in`
    // too (seen in the 2.1.302 test kit) but draws nothing visible for it.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const Raster = e.surface === 'terminal' && 'Raster' in table ? table.Raster : undefined
    const filled = p === null ? 0 : Math.min(CELLS, Math.round((p / 100) * CELLS))
    const hasHistory = shown !== null && shown.tokens.length > 0
    const prompts = shown?.prompts.length ?? 0
    // Every terminal gets the graph (decided 2026-10-18, KISS): the classic
    // Windows console's fonts lack the eighth blocks and show boxes there.
    const sparkFits = Raster !== undefined && e.props.bodyColumns >= BAR_COLUMNS + GRAPH_COLUMNS
    const parts = bandParts(e.surface, e.props.bodyColumns)
    const offer = (command: string) => () => {
      offerCommand($, command).catch(error => debug($, `/${command} not run: ${messageOf(error)}`))
    }
    const go = (to: number) => () => {
      jump($, to).catch(error => debug($, `jump failed: ${messageOf(error)}`))
    }
    const browse = () => {
      openBrowser($).catch(error => debug($, `browser not opened: ${messageOf(error)}`))
    }
    const showInfo = () => {
      openInfo($).catch(error => debug($, `info not opened: ${messageOf(error)}`))
    }
    const here = at ?? prompts
    // Gaps in cells. The panel draws each Button as a native button with its
    // own padding and font (extension 2.1.301 takes only `label` and
    // `dimColor`), so the gaps are all a mod can save there; the terminal
    // keeps a cell between its bracketed buttons, or they run together.
    const buttonGap = e.surface === 'terminal' ? 1 : 0
    const groupGap = e.surface === 'terminal' ? 2 : 1

    // The row spans the band so the spacer can push the buttons to its end:
    // in cells on the terminal ("100%" left it content-sized there).
    return (
      <Box alignItems="center" width={e.surface === 'terminal' ? e.props.bodyColumns : '100%'}>
        <Text dimColor>{`Context ${p === null ? '--%' : `${p}%`} `}</Text>
        {parts.bar ? (
          <Text color={p === null ? undefined : colorFor(p)}>
            {'█'.repeat(filled)}
          </Text>
        ) : undefined}
        {parts.bar ? <Text dimColor>{'░'.repeat(CELLS - filled)}</Text> : undefined}
        {parts.graph && hasHistory && Svg && (
          <Box marginLeft={2}>
            <Svg
              source={svgSource(shown, shown.window, GRAPH_WIDTH, GRAPH_HEIGHT, redraw)}
              alt={`Context per request: ${shown.tokens.length} requests over ${promptsLabel(prompts)}`}
              width={GRAPH_WIDTH}
              height={GRAPH_HEIGHT}
              isInteractive
            />
          </Box>
        )}
        {parts.graph && hasHistory && Raster && sparkFits && (
          // One row, so the band keeps one line: eighth blocks, 8 heights.
          <Box marginLeft={2}>
            <Raster
              key="graph"
              columns={SPARK_CELLS}
              rows={1}
              cells={rasterCells(shown, shown.window, SPARK_CELLS)}
            />
          </Box>
        )}
        {parts.buttons && (
          // Grows to push the buttons to the row's end (a Fragment takes no
          // conditional children, a Box does).
          <Box flexGrow={1} justifyContent="flex-end" alignItems="center">
            {/* No hotkeys: a band button's digit fires from an empty prompt too.
                Each group is one box that never wraps: the panel's row wraps
                its children (a row Box is `flex-wrap: wrap` there unless told
                otherwise), and a lone button landed on a second line. */}
            {/* VS Code's panel refuses a mod's scroll to a chat message
                (extension 2.1.309), so there one button opens the browser
                in place of the navigator; everywhere else the navigator. */}
            {e.surface === 'vscode' ? (
              <Box marginLeft={groupGap}>
                <Button key="browse" label="⇅" onPress={browse} />
              </Box>
            ) : prompts > 0 ? (
              <Box marginLeft={groupGap} flexWrap="nowrap">
                <Box marginRight={buttonGap}>
                  <Button key="back10" label="◀◀" onPress={go(here - BIG_STEP)} />
                </Box>
                <Button key="back" label="◀" onPress={go(here - 1)} />
                <Box marginLeft={buttonGap}>
                  <Button key="cursor" label={`${here}/${prompts}`} onPress={go(here)} />
                </Box>
                <Box marginLeft={buttonGap}>
                  <Button key="forward" label="▶" onPress={go(here + 1)} />
                </Box>
                <Box marginLeft={buttonGap}>
                  <Button key="forward10" label="▶▶" onPress={go(here + BIG_STEP)} />
                </Box>
              </Box>
            ) : undefined}
            <Box marginLeft={groupGap} flexWrap="nowrap">
              {/* ⓘ (U+24D8): the Info pane, an "i in a circle". */}
              <Button key="info" label="ⓘ" onPress={showInfo} />
              {parts.commands ? (
                <Box marginLeft={buttonGap}>
                  <Button key="context" label="☰" onPress={offer('context')} />
                </Box>
              ) : undefined}
              {parts.commands ? (
                <Box marginLeft={buttonGap}>
                  <Button key="usage" label="◔" onPress={offer('usage')} />
                </Box>
              ) : undefined}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  // The mod's panes: the conversation browser (one prompt and its answer at
  // a time) and the Info pane. One hook for both: a second registration on
  // the same event would be a repeat.
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== BROWSER_ID && e.requestId !== INFO_ID) return next(e)
    const at = await read($, browseAt)
    const query = await read($, browseQuery)
    await read($, browseVersion) // draws again when new data arrives
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Markdown = 'Markdown' in table ? table.Markdown : undefined
    const sessionId = await $.session.id()

    if (e.requestId === INFO_ID) {
      const held = await read($, infoTab)
      // A tab held from before the Description tab was dropped falls back.
      const tab = held === 'timeline' || held === 'details' ? held : 'summary'
      await read($, infoVersion) // draws again when data or a run changes
      const pad = e.surface === 'terminal' ? 1 : 2
      const conversation = browser?.sessionId === sessionId ? browser : null
      const files = info?.sessionId === sessionId ? info : null
      if (!conversation || !files) {
        // Not read yet, or dropped by a hot reload of the mod.
        if (!infoLoading && !infoError) void loadInfo($)
        return (
          <Box flexDirection="column" paddingX={pad}>
            <Text dimColor>{infoError ?? browserError ?? 'Reading the conversation…'}</Text>
          </Box>
        )
      }
      const session = conversation.session
      const now = await $.clock.now()
      const setTab = (target: 'summary' | 'timeline' | 'details') => () => {
        update($, infoTab, () => target).catch(error => debug($, `tab not changed: ${messageOf(error)}`))
      }
      const generate = () => {
        generateInfo($).catch(error => debug($, `not generated: ${messageOf(error)}`))
      }
      const cancel = () => infoRun?.controller.abort()
      const generated = files.summary ?? files.timeline
      // ⧉ copies the shown tab as Markdown; asked for first, in the press.
      const copyText = infoCopyText(tab, sessionId, session, files)
      const label = tab === 'summary' ? 'Summary' : tab === 'timeline' ? 'Timeline' : 'Details'
      const copy = (press: { surface: typeof e.surface }) => {
        if (copyText === null) return
        $.ui.copy({ text: copyText, surface: press.surface })
          .then(result => {
            if (result.isCopied) $.ui.toast(`${label} copied as Markdown`)
            else debug($, `not copied: ${result.reason}`)
          })
          .catch(error => debug($, `not copied: ${messageOf(error)}`))
      }
      const tabs = [
        ['summary', 'Summary'],
        ['timeline', 'Timeline'],
        ['details', 'Details'],
      ] as const

      // A run shows its progress: elapsed over the expected time of both
      // parts (at most 95 % until done) as a text bar, and what is left.
      let progress
      if (infoRun) {
        const elapsedMs = Math.max(0, now - infoRun.startedAt)
        const { summary: summarySeconds, timeline: timelineSeconds } = infoRun.estimate
        const total = summarySeconds !== null && timelineSeconds !== null ? summarySeconds + timelineSeconds : null
        const fraction = progressFraction(elapsedMs, total)
        const remaining = total !== null ? Math.round(total - elapsedMs / 1000) : null
        const expectation = remaining === null
          ? 'no timing history yet'
          : remaining > 0 ? `about ${formatSeconds(remaining)} left` : 'finishing…'
        const cells = 20
        const filled = fraction === null ? 0 : Math.round(fraction * cells)
        progress = { elapsed: formatSeconds(Math.round(elapsedMs / 1000)), expectation, filled, empty: cells - filled, hasBar: fraction !== null }
      }

      // Before a run, what it will take (decided 2026-10-25): the same estimate
      // as the progress bar's, for summary and timeline together.
      const expected = infoRun ? null : expectedSeconds(session)
      const expectation = expected === null ? '' : ` about ${formatSeconds(expected)}`

      // A timeline entry's `↓ n` sets the browser to its prompt in VS Code
      // (its tab stays where it is); elsewhere the chat scrolls there (the
      // navigator's jump, by the prompt's row id).
      const numberOf = new Map(session.pairs.map((pair, index) => [pair.id, index + 1]))
      const rowIdOf = new Map(session.pairs.map(pair => [pair.id, pair.prompt.recordUuid]))
      const goTo = (pairId: string, n: number) => () => {
        if (e.surface === 'vscode') {
          openBrowserAt($, n).catch(error => debug($, `browser not opened: ${messageOf(error)}`))
          return
        }
        const rowId = rowIdOf.get(pairId)
        const target = rowId && live ? live.ids.indexOf(rowId) + 1 : 0
        if (target > 0) jump($, target).catch(error => debug($, `jump failed: ${messageOf(error)}`))
        else debug($, `prompt ${n} has no row to jump to`)
      }

      // Summary and Timeline share one status: running, generated (and stale), or nothing yet.
      const status = infoRun && progress ? (
        <Box flexDirection="column">
          <Box alignItems="center">
            <Text dimColor>{`Generating the ${infoRun.phase} · ${progress.elapsed} elapsed · ${progress.expectation} `}</Text>
            <Button key="info-cancel" label="Cancel" onPress={cancel} />
          </Box>
          {progress.hasBar ? (
            <Box key="info-progress">
              <Text color="suggestion">{'█'.repeat(progress.filled)}</Text>
              <Text dimColor>{'░'.repeat(progress.empty)}</Text>
            </Box>
          ) : undefined}
        </Box>
      ) : generated ? (
        <Box alignItems="center">
          <Text dimColor>{`${generatedLine(generated, session.properties.modified)} `}</Text>
          <Button key="info-generate" label="Regenerate" onPress={generate} />
          {expectation ? <Text dimColor>{expectation}</Text> : undefined}
        </Box>
      ) : (
        <Box alignItems="center">
          <Button key="info-generate" label="Generate summary & timeline" onPress={generate} />
          {expectation ? <Text dimColor>{expectation}</Text> : undefined}
        </Box>
      )

      let body
      if (tab === 'summary') {
        body = files.summary
          ? (Markdown ? <Markdown key="info-summary" text={files.summary.markdown} /> : <Text>{files.summary.markdown}</Text>)
          : <Text dimColor>No summary yet.</Text>
      } else if (tab === 'timeline') {
        const items = files.timeline ? mergeStructuralEvents(files.timeline.entries, session) : []
        body = files.timeline ? (
          <Box flexDirection="column">
            {items.map((item, index) => {
              const n = numberOf.get(item.pairId)
              return (
                <Box key={`event-${index}`} flexDirection="column" marginBottom={1}>
                  <Box alignItems="center">
                    <Text dimColor>{`${whenOf(item.timestamp)} · ${item.kind} `}</Text>
                    {n !== undefined ? <Button key={`timeline-go-${index}`} label={`↓ ${n}`} onPress={goTo(item.pairId, n)} /> : undefined}
                  </Box>
                  <Text bold>{item.title}</Text>
                  <Text>{item.summary}</Text>
                </Box>
              )
            })}
          </Box>
        ) : (
          <Text dimColor>{infoRun?.phase === 'summary' ? 'Waiting for the summary…' : 'No timeline yet.'}</Text>
        )
      } else {
        const details = markdownTable(detailsRows(session))
        // Below the properties, what each button does (the panel shows no tooltips).
        body = (
          <Box flexDirection="column">
            {Markdown ? <Markdown key="info-details" text={details} /> : <Text>{details}</Text>}
            <Box marginTop={1} flexDirection="column">
              {Markdown && e.surface !== 'terminal' ? (
                <Markdown key="info-legend" text={BUTTON_LEGEND} />
              ) : (
                // The terminal lays a Markdown table out as wide as a reply, wider
                // than a pane, and its rows broke; two Text columns wrap in the pane.
                [BUTTON_HEADER, ...BUTTON_ROWS].map(([buttons, what], index) => (
                  <Box key={`legend-${index}`}>
                    <Box width={LEGEND_BUTTON_COLUMNS} flexShrink={0}>
                      <Text bold={index === 0}>{plainCell(buttons)}</Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text bold={index === 0}>{plainCell(what)}</Text>
                    </Box>
                  </Box>
                ))
              )}
            </Box>
          </Box>
        )
      }

      return (
        <Box flexDirection="column" paddingX={pad} paddingBottom={1}>
          <Text bold>{session.properties.title ?? sessionId}</Text>
          <Box marginTop={1} alignItems="center" width="100%">
            <Box flexWrap="nowrap">
              {tabs.map(([id, name], index) => (
                <Box key={`tab-${id}`} marginLeft={index === 0 ? 0 : 1}>
                  {/* The active tab drawn normally, the others dim (the panel then drops the button's fill). */}
                  <Button key={`info-tab-${id}`} label={name} dimColor={tab !== id} onPress={setTab(id)} />
                </Box>
              ))}
            </Box>
            <Box flexGrow={1} />
            {/* No ⧉ while the tab has nothing to copy (the panel's Buttons cannot be greyed out). */}
            {copyText !== null ? <Button key="info-copy" label="⧉" onPress={copy} /> : undefined}
          </Box>
          {tab === 'summary' || tab === 'timeline' ? (
            <Box marginTop={1} flexDirection="column">
              {status}
              {infoError && !infoRun ? <Text dimColor>{infoError}</Text> : undefined}
            </Box>
          ) : undefined}
          <Box marginTop={1} flexDirection="column">
            {body}
          </Box>
        </Box>
      )
    }

    const data = browser?.sessionId === sessionId ? browser : null
    if (!data) {
      // Not read yet, or dropped by a hot reload of the mod.
      if (!browserLoading && !browserError) void loadBrowser($)
      return (
        <Box flexDirection="column">
          <Text dimColor>{browserError ? `The conversation could not be read: ${browserError}` : 'Reading the conversation…'}</Text>
        </Box>
      )
    }
    const count = data.entries.length
    if (count === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No prompts in this conversation yet.</Text>
        </Box>
      )
    }
    const here = Math.min(count, Math.max(1, at ?? count))
    const entry = data.entries[here - 1]!
    const step = (to: number) => () => {
      update($, browseAt, () => Math.min(count, Math.max(1, to))).catch(error => debug($, `browser not moved: ${messageOf(error)}`))
    }
    const reuse = () => {
      reusePrompt($, entry.prompt).catch(error => debug($, `prompt not reused: ${messageOf(error)}`))
    }
    // The panel makes a pane's text unselectable (its root is `user-select:
    // none`, re-enabled only in the chat), so one button copies the prompt
    // and the answer as Markdown. The copy is asked for first, in the press.
    const copy = (press: { surface: typeof e.surface }) => {
      $.ui.copy({ text: copyTextOf(entry, here, here === count), surface: press.surface })
        .then(result => {
          if (result.isCopied) $.ui.toast(`Prompt ${here} and its response copied as Markdown`)
          else debug($, `not copied: ${result.reason}`)
        })
        .catch(error => debug($, `not copied: ${messageOf(error)}`))
    }
    // Pasted images as thumbnails (decided 2026-10-24, after a trial): the
    // panel draws an image embedded in a mod's SVG; a `file:` link to the
    // pasted file showed as plain text, so there are no links (KISS).
    const Svg = 'Svg' in table ? table.Svg : undefined
    const thumbnails = entry.images.map((image, index) => ({ index, thumb: thumbnailOf(image) }))
    const prompt = entry.prompt.length > PROMPT_LIMIT ? `${entry.prompt.slice(0, PROMPT_LIMIT)}…` : entry.prompt
    const answer = answerMarkdown(entry, undefined, here === count)

    // A narrow pane leaves header parts out instead of wrapping the row.
    const parts = headerParts(e.props.bodyColumns)
    const header = (
      <Box alignItems="center" width="100%">
        <Box flexWrap="nowrap" alignItems="center">
          {parts.bigSteps ? <Button key="browse-back10" label="◀◀" onPress={step(here - BIG_STEP)} /> : undefined}
          <Button key="browse-back" label="◀" onPress={step(here - 1)} />
          <Box marginX={1}>
            <Text>{`${here}/${count}`}</Text>
          </Box>
          <Button key="browse-forward" label="▶" onPress={step(here + 1)} />
          {parts.bigSteps ? <Button key="browse-forward10" label="▶▶" onPress={step(here + BIG_STEP)} /> : undefined}
        </Box>
        {parts.date ? (
          <Box marginLeft={2}>
            <Text dimColor>{whenOf(entry.at)}</Text>
          </Box>
        ) : undefined}
        <Box flexGrow={1} />
        <Box flexWrap="nowrap">
          {/* ⧉ (U+29C9) copy, ♻ (U+267B) reuse: text characters, as ☰ and ◔. */}
          <Button key="copy" label="⧉" onPress={copy} />
          {parts.reuse ? (
            <Box marginLeft={1}>
              <Button key="reuse" label="♻" onPress={reuse} />
            </Box>
          ) : undefined}
        </Box>
      </Box>
    )

    // The search, as you type (decided 2026-10-25): the count follows every
    // keystroke; Enter and ▲ ▼ go to the next or previous prompt whose text
    // or answer contains the text, wrapping around. ▲ ▼ show only when they
    // lead to another prompt. The text is kept as typed, untrimmed: the panel
    // ignores a drawn value it has seen typed (its echo rule, 2.1.310), so a
    // redraw per keystroke cannot overwrite typing. Enter empties the panel's
    // field; the search stays, and the placeholder shows it.
    // Not every surface's table has an Input; where none does, no search.
    const Input = 'Input' in table ? table.Input : undefined
    const matches = findMatches(data.entries, query)
    const found = matchLabel(matches, here, query)
    const canStep = matches.some(n => n !== here)
    const goMatch = (direction: 1 | -1) => {
      const target = nextMatch(matches, here, direction)
      if (target !== null) update($, browseAt, () => target).catch(error => debug($, `search failed: ${messageOf(error)}`))
    }
    const search = Input && (
      <Box marginTop={1} alignItems="center" width="100%">
        {Svg ? (
          <Box marginRight={1}>
            <Svg source={MAGNIFIER_SVG} alt="Search" width={14} height={14} />
          </Box>
        ) : undefined}
        <Box flexGrow={1}>
          <Input
            key="browse-find"
            placeholder={query.trim() ? query : 'Search prompts and answers'}
            value={query}
            onInput={(value: string) => {
              update($, browseQuery, () => value).catch(error => debug($, `search failed: ${messageOf(error)}`))
            }}
            onSubmit={() => goMatch(1)}
          />
        </Box>
        {canStep || found ? (
          <Box marginLeft={1} flexWrap="nowrap" alignItems="center">
            {canStep ? <Button key="find-previous" label="▲" onPress={() => goMatch(-1)} /> : undefined}
            {canStep ? <Button key="find-next" label="▼" onPress={() => goMatch(1)} /> : undefined}
            {found ? (
              <Box marginLeft={1}>
                <Text dimColor>{found}</Text>
              </Box>
            ) : undefined}
          </Box>
        ) : undefined}
      </Box>
    )

    // The look of the panel's own chat (extension 2.1.309): room at the
    // sides, and the prompt in a bubble like a sent prompt. Theme keys, so
    // light themes follow: `promptBorder` is the bubble's border colour;
    // the bubble's fill (the input background) has no key, so the fill is
    // `userMessageBackground`, which the panel maps to the editor's.
    // No width on the padded box: the panel adds padding to a box's width
    // (CSS content-box), so "100%" plus padding spilled over on the right.
    return (
      <Box flexDirection="column" paddingX={2} paddingBottom={1}>
        {header}
        {search}
        <Box
          key="prompt"
          marginTop={1}
          alignSelf="flex-start"
          borderStyle="round"
          borderColor="promptBorder"
          backgroundColor="userMessageBackground"
          paddingX={1}
          flexDirection="column"
        >
          {entry.images.length > 0 && Svg ? (
            // One under the other, a line apart, so two images do not read as one.
            <Box flexDirection="column">
              {thumbnails.map(({ index, thumb }) => (
                <Box key={`thumb-${index}`} marginBottom={1}>
                  {thumb ? (
                    <Svg source={thumb.source} alt={`Image ${index + 1} of this prompt`} width={thumb.width} height={thumb.height} />
                  ) : (
                    <Text dimColor>{`[image ${index + 1} cannot be shown]`}</Text>
                  )}
                </Box>
              ))}
            </Box>
          ) : undefined}
          <Text>{prompt}</Text>
        </Box>
        <Box marginTop={1} flexDirection="column">
          {Markdown ? <Markdown key="answer" text={answer} /> : <Text>{answer}</Text>}
        </Box>
        {data.warnings.length > 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{data.warnings.join(' · ')}</Text>
          </Box>
        ) : undefined}
      </Box>
    )
  })
}
