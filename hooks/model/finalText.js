/**
 * The substantial-block rule.
 *
 * The answer's level-1 text is the LAST text with at least
 * SUBSTANTIAL_MIN_CHARS non-whitespace characters; if none qualifies, the
 * last non-empty text; if none exists, null. The threshold is an agreed
 * starting value to be tuned against real sessions.
 */

export const SUBSTANTIAL_MIN_CHARS = 40

/**
 * An own-voice text of at least this many characters (trimmed) is shown
 * with the answer even when it is not a final report (AnswerNode.shownTexts).
 * Decided 2026-10-25 after measuring 574 prompt/answer pairs: the last
 * substantial text alone hid a longer answer in 41 pairs, among them 20 of
 * 500+ characters (an answer written before housekeeping tool calls, then a
 * short postscript); with 200 none of those 20 stays hidden, for 5.7 % more
 * answer text.
 */
export const SHOWN_MIN_CHARS = 200

/**
 * @param {string[]} texts prose texts in answer order
 * @returns {{ text: string, index: number } | null}
 */
export function deriveFinalText(texts) {
  let lastNonEmpty = null
  for (let index = texts.length - 1; index >= 0; index--) {
    const text = typeof texts[index] === 'string' ? texts[index].trim() : ''
    if (!text) continue
    if (lastNonEmpty === null) lastNonEmpty = { text, index }
    if (text.replace(/\s/g, '').length >= SUBSTANTIAL_MIN_CHARS) {
      return { text, index }
    }
  }
  return lastNonEmpty
}

/**
 * Answer-level rule over prose items: the agent's OWN voice outranks
 * attributed (skill/plugin/MCP) text, so a harness-initiated cycle late in
 * a turn (e.g. a scheduled skill run) cannot shadow the real answer.
 * Preference: substantial un-attributed > substantial any >
 * non-empty un-attributed > non-empty any.
 * @param {{ text: string, attribution: string | null }[]} items prose items in answer order
 * @returns {{ text: string, index: number } | null} index into `items`
 */
export function deriveAnswerText(items) {
  /** @type {string[]} */
  const ownTexts = []
  /** @type {number[]} */
  const ownIndexes = []
  items.forEach((item, index) => {
    if (!item.attribution) {
      ownTexts.push(item.text)
      ownIndexes.push(index)
    }
  })
  const own = deriveFinalText(ownTexts)
  if (own && isSubstantial(own.text)) {
    return { text: own.text, index: ownIndexes[own.index] }
  }
  const any = deriveFinalText(items.map(item => item.text))
  if (any && isSubstantial(any.text)) return any
  if (own) return { text: own.text, index: ownIndexes[own.index] }
  return any
}

/** @param {string} text */
function isSubstantial(text) {
  return text.replace(/\s/g, '').length >= SUBSTANTIAL_MIN_CHARS
}
