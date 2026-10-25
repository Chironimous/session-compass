/**
 * Provenance classification.
 *
 * The single format-drift-sensitive module: every record is classified by
 * native fields first, heuristics second. The trust rule is asymmetric:
 * unknown HARNESS record types classify as infrastructure (hidden, counted),
 * while CONVERSATIONAL records that fit no rule classify as 'unclassified'
 * and stay visible.
 */

/** Harness bookkeeping types observed in the 2026-07 corpus census. */
export const INFRASTRUCTURE_TYPES = Object.freeze(new Set([
  'attachment',
  // 2026-09 census (CLI 2.1.27x): Remote Control bridge, harness latches,
  // owner-mismatch suppression — bookkeeping, never conversation.
  'bridge-session',
  'atis-latch',
  'history-suppression',
  'file-history-snapshot',
  'file-history-delta',
  'last-prompt',
  'permission-mode',
  'mode',
  'progress',
  'queue-operation',
  'frame-link',
]))

export const SESSION_META_TYPES = Object.freeze(new Set([
  'custom-title',
  'ai-title',
  'summary',
  // Session cost totals written by the CLI (2026-09): metadata, not dialog.
  'cost-state',
]))

/**
 * Trust rule: a `user`/`assistant` record whose `message` is a plain string
 * (seen in the wild — CLI 2.1.277 fixed a resume crash on it) must not lose
 * its text. Returns the record with the string lifted into one text block;
 * every other record is returned as is.
 * @param {any} record
 * @returns {any}
 */
export function normalizeRecord(record) {
  if (!record || typeof record !== 'object') return record
  if ((record.type === 'user' || record.type === 'assistant') && typeof record.message === 'string') {
    return { ...record, message: { role: record.type, content: [{ type: 'text', text: record.message }] } }
  }
  return record
}

const KNOWN_TYPES = Object.freeze(new Set([
  ...INFRASTRUCTURE_TYPES,
  ...SESSION_META_TYPES,
  'user',
  'assistant',
  'system',
]))

/** True for records the census marked as bookkeeping plus anything unknown. */
export function isKnownRecordType(type) {
  return KNOWN_TYPES.has(type)
}

const INTERRUPTION_PATTERN = /^\s*\[Request interrupted/i

/**
 * Classify one parsed JSONL record.
 * @param {any} record
 * @returns {import('./ast.js').RecordClass}
 */
export function classifyRecord(record) {
  record = normalizeRecord(record)
  if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
    // Not a conversational shape at all — bookkeeping noise, not user content.
    return 'infrastructure'
  }
  if (INFRASTRUCTURE_TYPES.has(record.type)) return 'infrastructure'
  if (SESSION_META_TYPES.has(record.type)) return 'session-meta'
  if (record.type === 'system' || record.isApiErrorMessage === true) return 'system-event'
  if (record.type === 'user') return classifyUserRecord(record)
  if (record.type === 'assistant') {
    return record.message && Array.isArray(record.message.content)
      ? 'assistant'
      : 'unclassified'
  }
  // Unknown top-level type: hidden but counted and flagged by the builder.
  return 'infrastructure'
}

/** @param {any} record */
function classifyUserRecord(record) {
  // Native field first: background-task completion notices are
  // harness-injected user records with origin.kind='task-notification'
  // (a real typed prompt carries origin.kind='human'). They must never
  // start a pair.
  if (record.origin?.kind === 'task-notification') return 'task-notification'

  const content = record.message?.content

  if (typeof content === 'string') {
    if (INTERRUPTION_PATTERN.test(content)) return 'system-event'
    if (content.includes('<command-name>')) return 'prompt-command'
    if (content.includes('<local-command-caveat>')) return 'infrastructure'
    if (content.includes('<local-command-stdout>')) return 'local-output'
    // Heuristic fallback for CLI versions that predate origin.kind.
    if (content.trimStart().startsWith('<task-notification>')) return 'task-notification'
    if (record.isMeta === true) return 'meta-injection'
    return 'prompt-human'
  }

  if (Array.isArray(content)) {
    const firstText = content.find(block => block?.type === 'text')
    if (typeof firstText?.text === 'string' && INTERRUPTION_PATTERN.test(firstText.text)) {
      return 'system-event'
    }
    if (record.isMeta === true) return 'meta-injection'
    const conversationalBlocks = content.filter(block =>
      ['text', 'image', 'document'].includes(block?.type))
    if (conversationalBlocks.length > 0) return 'prompt-human'
    if (content.every(block => block?.type === 'tool_result')) return 'tool-result'
    if (content.length > 0) return 'tool-result' // tool_result mixed with unknown blocks
  }

  // A user record whose content is neither string nor array: visible by the trust rule.
  return 'unclassified'
}

/**
 * Extract the command line from a string command record:
 * "/name args" plus the bare name.
 * @param {string} content
 * @returns {{ commandName: string, text: string }}
 */
export function extractCommand(content) {
  const name = content.match(/<command-name>(\/?[\w:-]+)<\/command-name>/)?.[1] ?? '/unknown'
  const commandName = name.startsWith('/') ? name : `/${name}`
  const args = content.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim() ?? ''
  return { commandName, text: args ? `${commandName} ${args}` : commandName }
}

/** @param {string} content */
export function extractLocalOutput(content) {
  return content.match(/<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/)?.[1]?.trim() ?? ''
}

/**
 * Label for a task-notification record: its <summary> line when present
 * (e.g. `Agent "Verify audit claims in repo" finished`).
 * @param {string} content
 */
export function extractTaskNotificationSummary(content) {
  return content.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ?? 'task notification'
}

/**
 * Clean human prompt text: IDE tags become short notes, system-reminder
 * blocks disappear (ported behavior from the legacy converter).
 * @param {string} text
 */
export function cleanPromptText(text) {
  if (typeof text !== 'string') return ''
  return text
    // IDE opened-file and selection notes are editor state, not prompt
    // content — dropped entirely so they never pollute prompt text or
    // pair labels. (The raw record keeps them for inspection.)
    .replace(/<ide_opened_file>.*?<\/ide_opened_file>/gs, '')
    .replace(/<ide_selection>.*?<\/ide_selection>/gs, '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .trim()
}
