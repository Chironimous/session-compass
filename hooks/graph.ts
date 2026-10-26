/**
 * The context-history graph as plain data: an SVG document for surfaces that
 * draw `Svg` (VS Code, Desktop), a coloured block sparkline for the terminal.
 * Pure functions, so the tests check them without a surface.
 *
 * The scale is fixed: 100 % is the context window (or the peak, when the
 * window is unknown or smaller), never the session's own peak.
 */
import type { History } from './history'

export const GREEN = '#46a758'
export const YELLOW = '#d4a800'
export const RED = '#e5484d'

/** The usage bar's colour rule: green < 80 %, yellow 80–90 %, red > 90 %. */
export function colorFor(p: number): string {
  if (p > 90) return RED
  if (p >= 80) return YELLOW
  return GREEN
}

/** One drawn column: the largest request in its slice of the history. */
export type Bucket = {
  tokens: number
  /** 1-based prompt number of that request (0: before any prompt). */
  prompt: number
}

/** Splits the points into at most `count` contiguous slices, keeping each slice's peak. */
export function buckets(history: History, count: number): Bucket[] {
  const n = history.tokens.length
  if (n === 0 || count <= 0) return []
  const size = Math.max(1, Math.ceil(n / count))
  const result: Bucket[] = []
  for (let start = 0; start < n; start += size) {
    let best = start
    for (let index = start; index < Math.min(n, start + size); index += 1) {
      if ((history.tokens[index] ?? 0) > (history.tokens[best] ?? 0)) best = index
    }
    result.push({ tokens: history.tokens[best] ?? 0, prompt: history.promptOf[best] ?? 0 })
  }
  return result
}

/** The scale's 100 %: the window, or the peak when it is larger or the window unknown. */
export function scaleOf(history: History, window: number | null): number {
  const peak = Math.max(0, ...history.tokens)
  return Math.max(window ?? 0, peak, 1)
}

export function formatK(value: number): string {
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The tooltip of one column: prompt number, context, and the prompt's start. */
export function tooltipOf(history: History, bucket: Bucket, scale: number): string {
  const percent = Math.round((bucket.tokens / scale) * 100)
  const head = bucket.prompt > 0 ? `Prompt ${bucket.prompt}` : 'Before the first prompt'
  const text = bucket.prompt > 0 ? history.prompts[bucket.prompt - 1] ?? '' : ''
  return `${head} · ${formatK(bucket.tokens)} tokens (${percent}%)${text ? `\n${text}` : ''}`
}

/**
 * An area chart: one path filled with a gradient whose hard stops sit at
 * 80 % and 90 % of the height, so the parts above them turn yellow and red;
 * one transparent column per bucket carries its tooltip (`<title>`).
 */
export function svgSource(history: History, window: number | null, width: number, height: number, redraw = 0): string {
  const columns = buckets(history, Math.max(1, Math.floor(width / 2)))
  const scale = scaleOf(history, window)
  const step = width / Math.max(1, columns.length)
  const y = (tokens: number) => (height - Math.min(1, tokens / scale) * height).toFixed(1)
  const top = columns.map((bucket, index) => `L${(index * step).toFixed(1)},${y(bucket.tokens)} L${((index + 1) * step).toFixed(1)},${y(bucket.tokens)}`)
  const area = columns.length > 0 ? `M0,${height} ${top.join(' ')} L${width},${height} Z` : ''
  const at = (fraction: number) => (height * (1 - fraction)).toFixed(1)
  const hover = columns.map((bucket, index) =>
    `<rect x="${(index * step).toFixed(1)}" y="0" width="${step.toFixed(1)}" height="${height}" fill="transparent"><title>${escapeXml(tooltipOf(history, bucket, scale))}</title></rect>`)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    // Changes the source, not the picture: see the redraw in register.tsx.
    redraw > 0 ? `<!--redraw ${redraw}-->` : '',
    `<defs><linearGradient id="fill" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${height}">`,
    `<stop offset="0" stop-color="${RED}"/><stop offset="${(1 - 0.9).toFixed(2)}" stop-color="${RED}"/>`,
    `<stop offset="${(1 - 0.9).toFixed(2)}" stop-color="${YELLOW}"/><stop offset="${(1 - 0.8).toFixed(2)}" stop-color="${YELLOW}"/>`,
    `<stop offset="${(1 - 0.8).toFixed(2)}" stop-color="${GREEN}"/><stop offset="1" stop-color="${GREEN}"/>`,
    `</linearGradient></defs>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="#808080" stroke-opacity="0.6"/>`,
    `<line x1="0" y1="${at(0.8)}" x2="${width}" y2="${at(0.8)}" stroke="#808080" stroke-opacity="0.25"/>`,
    area ? `<path d="${area}" fill="url(#fill)"/>` : '',
    ...hover,
    `</svg>`,
  ].join('')
}

/** `▁` … `█`: U+2581 + n draws n + 1 eighths of a cell's height. */
const ONE_EIGHTH = 0x2581
const SPACE = 0x20
/** The terminal's own colour (`Raster` colour with bit 24 alone). */
const TERMINAL_DEFAULT = 0x01000000

function rgbOf(hex: string): number {
  return Number.parseInt(hex.slice(1), 16)
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64Of(bytes: Uint8Array): string {
  let out = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0
    const b = bytes[index + 1] ?? 0
    const c = bytes[index + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += BASE64[(triple >> 18) & 63]
    out += BASE64[(triple >> 12) & 63]
    out += index + 1 < bytes.length ? BASE64[(triple >> 6) & 63] : '='
    out += index + 2 < bytes.length ? BASE64[triple & 63] : '='
  }
  return out
}

/**
 * The terminal's graph as one row of `Raster` cells (little-endian u32
 * triplets [codePoint, foreground, background], base64): one cell per
 * bucket, `▁` to `█` for 8 heights, coloured by level; unused cells are
 * spaces. Only for terminals that draw these blocks (see register.tsx): the
 * classic Windows console's fonts lack all but `▄` and `█`.
 */
export function rasterCells(history: History, window: number | null, columns: number): string {
  const scale = scaleOf(history, window)
  const words = new Uint32Array(columns * 3)
  for (let cell = 0; cell < columns; cell += 1) {
    words.set([SPACE, TERMINAL_DEFAULT, TERMINAL_DEFAULT], cell * 3)
  }
  buckets(history, columns).forEach((bucket, x) => {
    if (!(bucket.tokens > 0)) return
    const fraction = Math.min(1, bucket.tokens / scale)
    const eighths = Math.min(8, Math.max(1, Math.round(fraction * 8)))
    words.set([ONE_EIGHTH + eighths - 1, rgbOf(colorFor(fraction * 100)), TERMINAL_DEFAULT], x * 3)
  })
  const bytes = new Uint8Array(words.length * 4)
  const view = new DataView(bytes.buffer)
  words.forEach((word, index) => view.setUint32(index * 4, word, true))
  return base64Of(bytes)
}
