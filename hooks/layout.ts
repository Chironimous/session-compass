/**
 * The band's and the browser header's layout by width: which parts fit.
 * Pure, so the tests check every width step without a surface.
 */

/** The terminal graph's cells. */
export const SPARK_CELLS = 20
/** The bar row ("Context " + bar + " 100%") takes about this many cells. */
export const BAR_COLUMNS = 23
/** The graph's gap and cells. */
export const GRAPH_COLUMNS = 2 + SPARK_CELLS
/** The navigator: a gap, "[ ◀◀ ] [ ◀ ] [ 14/25 ] [ ▶ ] [ ▶▶ ]" with gaps. */
const NAV_COLUMNS = 2 + 6 + 1 + 5 + 1 + 9 + 1 + 5 + 1 + 6
/** The command buttons: a gap and "[ ⓘ ] [ ☰ ] [ ◔ ]". */
const BUTTON_COLUMNS = 2 + 5 + 1 + 5 + 1 + 5
/** The Info button alone: a gap and "[ ⓘ ]". */
const INFO_COLUMNS = 2 + 5
/** "Context 100% " without the bar. */
const LABEL_COLUMNS = 13
/**
 * VS Code panel: the widths (`bodyColumns`) from which a band or browser
 * header variant fits on one line. Read off screenshots of a temporary
 * probe (2026-10-25, extension 2.1.310), then a cell or two of margin. A narrower band drops ☰ ◔ first, then the bar, then the graph
 * (decided 2026-10-25); a narrower header drops ♻, then the date, then
 * ◀◀ ▶▶, and keeps ⧉, the pane's only way to copy.
 */
const PANEL_BAND_ALL = 54
const PANEL_BAND_NO_COMMANDS = 48
const PANEL_BAND_NO_BAR = 38
const PANEL_HEADER_ALL = 46
const PANEL_HEADER_NO_REUSE = 39
const PANEL_HEADER_NO_DATE = 28
/**
 * The panel's band thresholds outside Windows. The panel's cell is the wider
 * of "0" and "─" in its UI font, a wider cell on the Mac: at the panel's
 * maximum width the Mac reported 49 columns where Windows reported 70
 * (temporary probes, 2026-10-26), so the band's measured widths are scaled by
 * 49/70 there and rounded up. Linux is untested and treated like the Mac.
 */
export const PANEL_SCALE_NOT_WINDOWS = 49 / 70

/** What the band draws: the bar, the graph, the buttons, and ☰ ◔ among them. */
export type BandParts = { bar: boolean; graph: boolean; buttons: boolean; commands: boolean }

/**
 * The band's parts for its width. The terminal counts exact cells and, below
 * the narrowest variant, drops the buttons and keeps bar and graph (it cannot
 * wrap); the VS Code panel uses the measured widths, times `panelScale` (1 on
 * Windows, else `PANEL_SCALE_NOT_WINDOWS`), and wraps below them. The Desktop
 * app is untested and keeps everything.
 */
export function bandParts(surface: string, columns: number, panelScale = 1): BandParts {
  const all = { bar: true, graph: true, buttons: true, commands: true }
  if (surface === 'terminal') {
    if (columns >= BAR_COLUMNS + GRAPH_COLUMNS + NAV_COLUMNS + BUTTON_COLUMNS) return all
    if (columns >= BAR_COLUMNS + GRAPH_COLUMNS + NAV_COLUMNS + INFO_COLUMNS) return { ...all, commands: false }
    if (columns >= LABEL_COLUMNS + GRAPH_COLUMNS + NAV_COLUMNS + INFO_COLUMNS) return { ...all, bar: false, commands: false }
    if (columns >= LABEL_COLUMNS + NAV_COLUMNS + INFO_COLUMNS) return { bar: false, graph: false, buttons: true, commands: false }
    return { ...all, buttons: false, commands: false }
  }
  if (surface === 'vscode') {
    const at = (measured: number) => Math.ceil(measured * panelScale)
    if (columns >= at(PANEL_BAND_ALL)) return all
    if (columns >= at(PANEL_BAND_NO_COMMANDS)) return { ...all, commands: false }
    if (columns >= at(PANEL_BAND_NO_BAR)) return { ...all, bar: false, commands: false }
    return { bar: false, graph: false, buttons: true, commands: false }
  }
  return all
}

/** What the browser's header draws: ◀◀ ▶▶, the date, ♻ (◀ n/N ▶ and ⧉ always). */
export type HeaderParts = { bigSteps: boolean; date: boolean; reuse: boolean }

/** The browser header's parts for the pane's width (VS Code panel, measured). */
export function headerParts(columns: number): HeaderParts {
  if (columns >= PANEL_HEADER_ALL) return { bigSteps: true, date: true, reuse: true }
  if (columns >= PANEL_HEADER_NO_REUSE) return { bigSteps: true, date: true, reuse: false }
  if (columns >= PANEL_HEADER_NO_DATE) return { bigSteps: true, date: false, reuse: false }
  return { bigSteps: false, date: false, reuse: false }
}
