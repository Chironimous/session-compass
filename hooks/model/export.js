/**
 * AST → Markdown exports.
 *
 * Compact = the clean dialog: prompts and the answers' shown texts only.
 * Full = all prose, machinery as <details> blocks.
 * Pure and deterministic (timestamps format from local time via
 * formatTimestamp; snapshot tests normalize them).
 */

/** "YYYY-MM-DD HH:mm" in local time, or null. */
export function formatTimestamp(iso) {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const pad = value => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** @param {import('./ast.js').SessionNode} session */
export function toCompactExport(session) {
  return [
    sessionHeader(session),
    session.pairs.map(compactPairBlock).join('\n\n---\n\n'),
    '',
  ].join('\n')
}

/** @param {import('./ast.js').SessionNode} session */
export function toFullExport(session) {
  const preamble = [
    ...session.systemEvents.map(systemEventLine),
    ...session.orphans.map(unclassifiedLine),
  ]
  return [
    sessionHeader(session),
    ...(preamble.length ? [preamble.join('\n'), ''] : []),
    session.pairs.map(fullPairBlock).join('\n\n---\n\n'),
    '',
  ].join('\n')
}

/** One compact block: prompt heading + text + the answer's shown texts. */
export function compactPairBlock(pair) {
  const reports = pair.answer && pair.answer.shownTexts.length > 0
    ? pair.answer.shownTexts.map(report => report.text).join('\n\n')
    : null
  return `${pairHeading(pair)}\n\n${promptText(pair)}\n\n` +
    (reports ?? placeholder(pair))
}

/** One full block: prompt heading + text + the full answer content. */
export function fullPairBlock(pair) {
  const parts = [pairHeading(pair), promptText(pair)]
  if (!pair.answer) {
    parts.push(placeholder(pair))
  } else {
    for (const item of pair.answer.items) {
      if (item.kind === 'prose') parts.push(item.text.trim())
      else if (item.kind === 'group') parts.push(groupDetails(item))
      else if (item.kind === 'unclassified') parts.push(unclassifiedLine(item))
      else parts.push(stepDetails(item))
    }
    if (pair.answer.items.length === 0) parts.push(placeholder(pair))
  }
  parts.push(...pair.systemEvents.map(systemEventLine))
  return parts.join('\n\n')
}

/**
 * The Info pane's model input — the compact export plus one
 * metadata HTML comment per pair (id, timestamp, model, tool count, runs,
 * background agents) so a model can anchor timeline entries to pair ids.
 * A size guard keeps the most recent pairs and says so in a leading note.
 * @param {import('./ast.js').SessionNode} session
 * @param {{ maxChars?: number }} [options]
 */
export function toKnowledgeDigest(session, options = {}) {
  const maxChars = options.maxChars ?? KNOWLEDGE_DIGEST_MAX_CHARS
  const separator = '\n\n---\n\n'
  const blocks = session.pairs.map(pair => `${pairMetadata(pair)}\n${compactPairBlock(pair)}`)
  const header = sessionHeader(session)
  let kept = blocks
  let dropped = 0
  let total = header.length + blocks.reduce((sum, block) => sum + block.length + separator.length, 0)
  while (total > maxChars && kept.length > 1) {
    total -= kept[0].length + separator.length
    kept = kept.slice(1)
    dropped += 1
  }
  const note = dropped > 0
    ? `> Note: digest truncated — the first ${dropped} of ${session.pairs.length} prompts are omitted; only the most recent ${kept.length} follow.\n\n`
    : ''
  return [header, note + kept.join(separator), ''].join('\n')
}

/** ~100k tokens of digest; a named constant, not a setting. */
export const KNOWLEDGE_DIGEST_MAX_CHARS = 400_000

/** @param {import('./ast.js').PairNode} pair */
function pairMetadata(pair) {
  const agents = []
  const walk = items => {
    for (const item of items) {
      if (item.kind === 'group') walk(item.steps)
      else if (item.kind === 'tool' && item.isAgent && item.inputDigest) agents.push(item.inputDigest)
    }
  }
  if (pair.answer) walk(pair.answer.items)
  const fields = [
    `pair: ${pair.id}`,
    `at: ${pair.properties.timestamp ?? 'unknown'}`,
    `model: ${pair.properties.models.join('/') || 'unknown'}`,
    `tools: ${pair.properties.toolCallCount}`,
    `runs: ${pair.properties.runLabels.join('; ') || 'none'}`,
    `agents: ${agents.join('; ') || 'none'}`,
    ...(pair.properties.compactedHere ? ['compacted: here'] : []),
    ...(pair.state !== 'complete' ? [`state: ${pair.state}`] : []),
  ]
  return `<!-- ${fields.map(field => field.replace(/-->/g, '-- >')).join(' | ')} -->`
}

/** Plain (non-collapsible) step rendering. */
export function stepMarkdown(step) {
  const { label, body } = stepParts(step)
  return `**${label}**\n\n${body}`
}

// ------------------------------------------------------------------ private

function sessionHeader(session) {
  const properties = session.properties
  const meta = [`**Conversation:** ${session.id}`]
  if (properties.created) meta.push(`**Created:** ${formatTimestamp(properties.created)}`)
  if (properties.modified) meta.push(`**Modified:** ${formatTimestamp(properties.modified)}`)
  if (properties.models.length > 0) meta.push(`**Model:** ${properties.models.join(', ')}`)
  if (properties.compacted) meta.push('**Note:** this session was compacted')
  return `# ${properties.title ?? session.id}\n\n${meta.join('  \n')}\n`
}

function pairHeading(pair) {
  const time = formatTimestamp(pair.properties.timestamp)
  return `## Prompt${time ? ` — ${time}` : ''}`
}

function promptText(pair) {
  return pair.prompt.text || '*(empty prompt)*'
}

function placeholder(pair) {
  return pair.state === 'interrupted' ? '*(interrupted)*' : '*(no answer)*'
}

function stepParts(step) {
  switch (step.kind) {
    case 'tool':
      return {
        label: `${step.toolName}${step.inputDigest ? ` \`${step.inputDigest}\`` : ''}`,
        body: step.resultMissing ? '*(no result recorded)*' : fence(step.resultText ?? ''),
      }
    case 'thinking':
      return { label: 'thinking', body: step.text.trim() }
    case 'expansion':
      return { label: `expansion: ${step.label}`, body: step.text.trim() }
    case 'local-output':
      return { label: 'local output', body: fence(step.text) }
    default:
      return { label: `unknown block: ${step.blockType}`, body: fence(step.raw) }
  }
}

function stepDetails(step) {
  const { label, body } = stepParts(step)
  return `<details>\n<summary>${escapeHtml(label)}</summary>\n\n${body}\n\n</details>`
}

function groupDetails(group) {
  return `<details>\n<summary>${escapeHtml(group.label)}</summary>\n\n` +
    `${group.steps.map(stepDetails).join('\n\n')}\n\n</details>`
}

function systemEventLine(event) {
  return `> ⚠ ${event.subtype ? `${event.subtype}: ` : ''}${event.message.replace(/\s+/g, ' ').trim()}`
}

function unclassifiedLine(node) {
  return `> ⚑ unclassified ${node.recordType}: ${node.excerpt}`
}

function fence(text) {
  const guard = text.includes('```') ? '````' : '```'
  return `${guard}\n${text}\n${guard}`
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
