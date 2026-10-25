/**
 * The conversation browser's data, built with the conversation model
 * (hooks/model/): one entry per prompt/answer pair, with the model's
 * final-answer rule. Pure functions, so the tests check them without a
 * surface.
 */
import { buildConversationModel } from './model/build.js'
import type { SessionNode } from './model/ast.js'
import { shrinkPng } from './thumbnail'

/** One prompt of the conversation and what the browser shows for it. */
export type BrowserEntry = {
  /** The prompt as typed (cleaned), or the command line. */
  prompt: string
  /** When the prompt was sent (ISO), when known. */
  at: string | null
  /**
   * The answer's shown texts, in order: each stretch's concluding text plus
   * every own-voice text of 200 characters or more (AnswerNode.shownTexts).
   */
  answers: string[]
  state: 'complete' | 'interrupted' | 'no-answer'
  /** Images pasted into the prompt, in order. */
  images: BrowserImage[]
}

/** One image pasted into a prompt, as the transcript embeds it. */
export type BrowserImage = {
  /** `image/png`, `image/jpeg`, … */
  media: string
  /** The image as base64, or null when the transcript holds none. */
  data: string | null
}

/** The rules of a `.ccscignore` file, as the model's builder takes them. */
export type IgnoreRules = { literals: string[]; patterns: RegExp[]; warnings: string[] }

/**
 * Parse .ccscignore content: one rule per line; blank lines and #-comments
 * skipped; /…/ lines compile to regexes (invalid ones are reported, not
 * fatal); everything else is an exact-match literal.
 */
export function parseIgnoreList(content: string): IgnoreRules {
  const literals: string[] = []
  const patterns: RegExp[] = []
  const warnings: string[] = []
  for (const rawLine of String(content).split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (line.length > 2 && line.startsWith('/') && line.endsWith('/')) {
      try {
        patterns.push(new RegExp(line.slice(1, -1)))
      } catch {
        warnings.push(`invalid regex in .ccscignore: ${line}`)
      }
    } else {
      literals.push(line)
    }
  }
  return { literals, patterns, warnings }
}

/** Parses JSONL text into records; a line that is not JSON (a partly written last one) is skipped. */
export function recordsOf(text: string): unknown[] {
  const records: unknown[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // a partially written line
    }
  }
  return records
}

/** The browser's entries for a transcript's records: one per prompt/answer pair of the model. */
export function entriesOf(records: unknown[], ignore?: IgnoreRules): BrowserEntry[] {
  return conversationOf(records, ignore).entries
}

/**
 * A transcript's records as the conversation model (for the Info pane) and as
 * the browser's entries, built once for both.
 */
export function conversationOf(records: unknown[], ignore?: IgnoreRules): { session: SessionNode; entries: BrowserEntry[] } {
  const model = buildConversationModel(records as any[], {
    ignore: ignore ? { literals: ignore.literals, patterns: ignore.patterns } : undefined,
  })
  return { session: model, entries: entriesOfModel(model, records) }
}

function entriesOfModel(model: SessionNode, records: unknown[]): BrowserEntry[] {
  const images = imagesOf(records)
  return model.pairs.map(pair => ({
    prompt: pair.prompt.text,
    at: pair.properties.timestamp ?? pair.prompt.timestamp ?? null,
    answers: (pair.answer?.shownTexts ?? []).map(report => report.text),
    state: pair.state,
    images: (pair.prompt.recordUuid && images.get(pair.prompt.recordUuid)) || [],
  }))
}

/** Each prompt record's pasted images, by the record's uuid: its own image blocks, in order. */
export function imagesOf(records: unknown[]): Map<string, BrowserImage[]> {
  const result = new Map<string, BrowserImage[]>()
  for (const record of records as any[]) {
    if (record?.type !== 'user' || record.isMeta === true || typeof record.uuid !== 'string') continue
    const content = record.message?.content
    if (!Array.isArray(content)) continue
    const blocks = content.filter((block: any) => block?.type === 'image')
    if (blocks.length === 0) continue
    result.set(record.uuid, blocks.map((block: any) => ({
      media: typeof block.source?.media_type === 'string' ? block.source.media_type : 'image/png',
      data: block.source?.type === 'base64' && typeof block.source.data === 'string' ? block.source.data : null,
    })))
  }
  return result
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** The first bytes of base64 data (enough for an image header). */
function headOf(base64: string, bytes: number): number[] {
  const out: number[] = []
  for (let index = 0; index + 3 < base64.length && out.length < bytes; index += 4) {
    const quad = [0, 1, 2, 3].map(offset => BASE64.indexOf(base64[index + offset] ?? 'A'))
    if (quad.some(value => value < 0)) break
    const triple = (quad[0]! << 18) | (quad[1]! << 12) | (quad[2]! << 6) | quad[3]!
    out.push((triple >> 16) & 255, (triple >> 8) & 255, triple & 255)
  }
  return out.slice(0, bytes)
}

/** A PNG's width and height from its header, or null for anything else. */
export function pngSize(base64: string): { width: number; height: number } | null {
  const b = headOf(base64, 24)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (b.length < 24 || signature.some((value, index) => b[index] !== value)) return null
  const word = (at: number) => ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
  const width = word(16)
  const height = word(20)
  return width > 0 && height > 0 ? { width, height } : null
}

/** An SVG source may hold this many characters (contract 2.1.304). */
export const SVG_LIMIT = 131_072

/** A pasted image's thumbnail width in pixels (decided 2026-10-24). */
export const THUMB_WIDTH = 250

export type Thumbnail = { source: string; width: number; height: number }

/**
 * Thumbnails already made, by image: shrinking one takes about 0.1 s
 * (measured 2026-10-24), and the browser draws the same prompt again on
 * every press. Kept for the session, as the browser's data is.
 */
const thumbnails = new Map<string, Thumbnail | null>()

/**
 * The image as a small SVG drawing (the panel has no image element for
 * mods), at most `width` pixels wide at its own proportions: a PNG wider
 * than that is shrunk (./thumbnail.ts), another image is embedded as it is.
 * Null without data, or when the drawing would not fit an SVG source (a
 * large JPEG, a PNG fast-png cannot read).
 */
export function thumbnailOf(image: BrowserImage, width = THUMB_WIDTH): Thumbnail | null {
  if (!image.data) return null
  const key = `${width}:${image.data.length}:${image.data.slice(0, 96)}:${image.data.slice(-96)}`
  const known = thumbnails.get(key)
  if (known !== undefined) return known
  let media = image.media
  let data = image.data
  let size = media === 'image/png' ? pngSize(data) : null
  if (size && size.width > width) {
    const small = shrinkPng(data, width)
    if (small) {
      media = 'image/png'
      data = small.data
      size = { width: small.width, height: small.height }
    }
  }
  const shownWidth = Math.min(width, size?.width ?? width)
  const shownHeight = Math.max(1, Math.round(shownWidth * (size ? size.height / size.width : 3 / 4)))
  const viewWidth = size?.width ?? 4
  const viewHeight = size?.height ?? 3
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${shownWidth}" height="${shownHeight}" viewBox="0 0 ${viewWidth} ${viewHeight}">`
    + `<image width="${viewWidth}" height="${viewHeight}" preserveAspectRatio="xMidYMid meet" href="data:${media};base64,${data}"/></svg>`
  const thumb = source.length <= SVG_LIMIT ? { source, width: shownWidth, height: shownHeight } : null
  thumbnails.set(key, thumb)
  return thumb
}

/**
 * Prompt `number` as Markdown for the clipboard: the prompt under
 * `# Prompt n`, as typed (so it can be reused without stripping quote
 * marks), and the whole answer, uncut, under `# Response n`.
 */
export function copyTextOf(entry: BrowserEntry, number: number, isNewest = false): string {
  const response = entry.answers.length > 0
    ? entry.answers.join('\n\n---\n\n')
    : answerMarkdown(entry, Number.POSITIVE_INFINITY, isNewest)
  return `# Prompt ${number}\n\n${entry.prompt}\n\n# Response ${number}\n\n${response}\n`
}

/** How many characters of answer text one drawing shows (a drawing holds 100 000). */
export const ANSWER_LIMIT = 60_000

/**
 * The answer as Markdown: every concluding text, separated by a rule; cut
 * at `limit` characters with a note saying so. Without a text, what the
 * pair's state says.
 */
export function answerMarkdown(entry: BrowserEntry, limit = ANSWER_LIMIT, isNewest = false): string {
  if (entry.answers.length === 0) {
    if (entry.state === 'interrupted') return '*The answer was interrupted.*'
    return isNewest ? '*Answer in progress.*' : '*No answer.*'
  }
  const text = entry.answers.join('\n\n---\n\n')
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n\n*… the answer is ${text.length.toLocaleString('en-US')} characters long; the browser shows the first ${limit.toLocaleString('en-US')}.*`
}

/**
 * The 1-based numbers of the prompts whose text or answer contains `query`,
 * ignoring case; none for a blank query.
 */
export function findMatches(entries: readonly BrowserEntry[], query: string): number[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const matches: number[] = []
  entries.forEach((entry, index) => {
    if ([entry.prompt, ...entry.answers].some(text => text.toLowerCase().includes(needle))) matches.push(index + 1)
  })
  return matches
}

/**
 * The match after (`direction` 1) or before (-1) prompt `here`, wrapping
 * around at the ends; null without matches.
 */
export function nextMatch(matches: readonly number[], here: number, direction: 1 | -1): number | null {
  if (matches.length === 0) return null
  if (direction === 1) return matches.find(n => n > here) ?? matches[0]!
  return [...matches].reverse().find(n => n < here) ?? matches[matches.length - 1]!
}

/** What the search shows beside its arrows: "2 of 7", "7 matches", "no match"; '' without a query. */
export function matchLabel(matches: readonly number[], here: number, query: string): string {
  if (!query.trim()) return ''
  if (matches.length === 0) return 'no match'
  const position = matches.indexOf(here)
  if (position >= 0) return `${position + 1} of ${matches.length}`
  return matches.length === 1 ? '1 match' : `${matches.length} matches`
}

/** `24.10.2026 13:45` in local time, or '' without a valid timestamp. */
export function whenOf(iso: string | null): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(date.getDate())}.${two(date.getMonth() + 1)}.${date.getFullYear()} ${two(date.getHours())}:${two(date.getMinutes())}`
}
