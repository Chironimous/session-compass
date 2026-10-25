/**
 * records → conversation AST.
 *
 * Pure (no filesystem, no VS Code, no DOM): takes parsed JSONL records in
 * file order and produces the SessionNode contract from ast.d.ts.
 * Deterministic by construction so snapshot tests stay useful.
 */

import {
  classifyRecord,
  cleanPromptText,
  extractCommand,
  extractLocalOutput,
  extractTaskNotificationSummary,
  isKnownRecordType,
  normalizeRecord,
} from './classify.js'
import { deriveAnswerText, SHOWN_MIN_CHARS } from './finalText.js'

const EXCERPT_LENGTH = 200
const DIGEST_LENGTH = 120

/**
 * @param {any[]} records parsed JSONL records in file order
 * @param {{
 *   conversationId?: string,
 *   ignore?: { literals?: readonly string[], patterns?: readonly RegExp[] },
 * }} [options]
 * @returns {import('./ast.js').SessionNode}
 */
export function buildConversationModel(records, options = {}) {
  const builder = new ModelBuilder(options.conversationId, normalizeIgnore(options.ignore))
  for (const record of records) builder.push(record)
  return builder.finish()
}

/**
 * @param {{ literals?: readonly string[], patterns?: readonly RegExp[] } | undefined} ignore
 * @returns {{ literals: Set<string>, patterns: RegExp[] } | null}
 */
function normalizeIgnore(ignore) {
  const literals = new Set((ignore?.literals ?? []).map(l => String(l).trim()).filter(Boolean))
  const patterns = (ignore?.patterns ?? []).filter(p => p instanceof RegExp)
  return literals.size || patterns.length ? { literals, patterns } : null
}

class ModelBuilder {
  constructor(conversationId, ignore = null) {
    this.conversationId = conversationId ?? null
    /** @type {{ literals: Set<string>, patterns: RegExp[] } | null} .ccscignore rules */
    this.ignore = ignore
    this.ignoredTotal = 0
    this.pairs = []
    this.sessionEvents = []
    this.orphans = []
    this.customTitle = null
    this.aiTitle = null
    this.models = new Set()
    this.usageByRequest = new Map()
    this.hiddenTypes = {}
    this.unknownTypes = new Set()
    this.compacted = false
    this.firstTimestamp = null
    this.lastTimestamp = null
    this.nodeCounter = 0

    /** @type {any} current pair under construction (internal shape) */
    this.pair = null
    /** @type {any} current machinery group, if one is open */
    this.group = null
    /** @type {Map<string, any>} toolUseId -> ToolStep awaiting its result */
    this.pendingTools = new Map()
  }

  nextId(prefix) {
    this.nodeCounter += 1
    return `${prefix}-${this.nodeCounter}`
  }

  push(record) {
    if (record && typeof record === 'object') {
      if (record.isCompactSummary || record.compactMetadata || record.isVisibleInTranscriptOnly) {
        this.compacted = true
      }
      if (typeof record.timestamp === 'string') {
        if (!this.firstTimestamp) this.firstTimestamp = record.timestamp
        this.lastTimestamp = record.timestamp
        // The pair's own lastTimestamp is advanced only by records that
        // BELONG to it (touchPair) — a new prompt must not extend the
        // previous pair's duration.
      }
      if (!this.conversationId && typeof record.sessionId === 'string') {
        this.conversationId = record.sessionId
      }
    }

    const compactionMarker = Boolean(record && typeof record === 'object'
      && (record.isCompactSummary || record.compactMetadata || record.isVisibleInTranscriptOnly))
    record = normalizeRecord(record)
    const recordClass = classifyRecord(record)
    this.dispatch(recordClass, record)
    // The pair at which compaction happened (the prompt this
    // record starts, or the pair it belongs to) — a timeline event.
    if (compactionMarker && this.pair) this.pair.compactedHere = true
  }

  dispatch(recordClass, record) {
    switch (recordClass) {
      case 'infrastructure': return this.pushInfrastructure(record)
      case 'session-meta': return this.pushSessionMeta(record)
      case 'system-event': return this.pushSystemEvent(record)
      case 'prompt-human': return this.pushPrompt(record, 'typed')
      case 'prompt-command': return this.pushPrompt(record, 'command')
      case 'meta-injection': return this.pushExpansion(record)
      case 'task-notification': return this.pushTaskNotification(record)
      case 'local-output': return this.pushLocalOutput(record)
      case 'tool-result': return this.pushToolResults(record)
      case 'assistant': return this.pushAssistant(record)
      case 'unclassified': return this.pushUnclassified(record)
    }
  }

  pushInfrastructure(record) {
    const type = record && typeof record === 'object' && typeof record.type === 'string'
      ? record.type
      : '(invalid)'
    this.hiddenTypes[type] = (this.hiddenTypes[type] ?? 0) + 1
    if (type !== '(invalid)' && !isKnownRecordType(type)) this.unknownTypes.add(type)
  }

  pushSessionMeta(record) {
    if (record.type === 'custom-title' && record.customTitle) this.customTitle = record.customTitle
    else if (record.type === 'ai-title' && record.aiTitle) this.aiTitle = record.aiTitle
    // 'summary' records carry resume-list metadata; nothing to render.
  }

  pushSystemEvent(record) {
    const content = record.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        : record.error ?? record.subtype ?? 'system event'
    const interruption = /^\s*\[Request interrupted/i.test(String(text))
    const event = {
      kind: 'system-event',
      id: this.nextId('sys'),
      recordUuid: record.uuid ?? null,
      subtype: record.subtype ?? null,
      level: record.level ?? null,
      message: String(text).trim(),
      interruption,
      timestamp: record.timestamp ?? null,
    }
    if (this.pair) {
      this.touchPair(record)
      this.pair.systemEvents.push(event)
      if (interruption) this.pair.interrupted = true
    } else {
      this.sessionEvents.push(event)
    }
  }

  pushPrompt(record, source) {
    this.finishPair()
    const content = record.message?.content
    let text = ''
    let commandName = null
    let imageCount = 0
    let documentCount = 0

    if (source === 'command') {
      const command = extractCommand(String(content))
      text = command.text
      commandName = command.commandName
    } else if (typeof content === 'string') {
      text = cleanPromptText(content)
    } else if (Array.isArray(content)) {
      const texts = []
      for (const block of content) {
        if (block?.type === 'text') texts.push(cleanPromptText(block.text))
        else if (block?.type === 'image') imageCount += 1
        else if (block?.type === 'document') documentCount += 1
        // tool_result blocks mixed into a prompt record route to machinery:
        else if (block?.type === 'tool_result') this.applyToolResult(block)
      }
      text = texts.filter(Boolean).join('\n\n')
    }

    this.pair = this.newPairShape({
      kind: 'prompt',
      id: record.uuid ?? this.nextId('prompt'),
      recordUuid: record.uuid ?? null,
      text,
      source,
      commandName,
      imageCount,
      documentCount,
      timestamp: record.timestamp ?? null,
    })
  }

  newPairShape(prompt) {
    return {
      prompt,
      items: [],
      systemEvents: [],
      interrupted: false,
      models: new Set(),
      usageByRequest: new Map(),
      contextTokens: null,
      toolCallCount: 0,
      runLabels: [],
      compactedHere: false,
      lastTimestamp: prompt.timestamp,
    }
  }

  /** Content arriving before any prompt: synthesize the continuation pair. */
  ensurePair() {
    if (!this.pair) {
      this.pair = this.newPairShape({
        kind: 'prompt',
        id: this.nextId('prompt'),
        recordUuid: null,
        text: '(continued session)',
        source: 'implicit',
        commandName: null,
        imageCount: 0,
        documentCount: 0,
        timestamp: this.lastTimestamp,
      })
    }
    return this.pair
  }

  /** Advance the open pair's activity clock with a record that belongs to it. */
  touchPair(record) {
    if (this.pair && typeof record?.timestamp === 'string') {
      this.pair.lastTimestamp = record.timestamp
    }
  }

  /** Append a machinery step to the open group, or top-level when none is open. */
  attachStep(step) {
    const pair = this.ensurePair()
    if (this.group) this.group.steps.push(step)
    else pair.items.push(step)
  }

  ensureGroup(groupType, label) {
    const pair = this.ensurePair()
    if (!this.group || this.group.label !== label) {
      this.group = {
        kind: 'group',
        id: this.nextId('group'),
        groupType,
        label,
        steps: [],
      }
      pair.items.push(this.group)
      pair.runLabels.push(label)
    }
    return this.group
  }

  pushExpansion(record) {
    this.touchPair(record)
    const content = record.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        : ''
    const firstLine = text.split('\n').map(l => l.trim()).find(Boolean) ?? '(injected content)'
    this.attachStep({
      kind: 'expansion',
      id: record.uuid ?? this.nextId('exp'),
      recordUuid: record.uuid ?? null,
      label: truncate(firstLine, 80),
      text,
      source: 'meta',
    })
  }

  /**
   * A background agent finished (task-notification): a collapsed step in
   * the CURRENT answer — never a new pair. The turn continues: the main
   * agent's next records still belong to the same prompt.
   */
  pushTaskNotification(record) {
    this.touchPair(record)
    const content = record.message?.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        : ''
    // The notice is unrelated to any open attribution run — close it so
    // the step lands top-level, between the surrounding prose.
    this.group = null
    this.attachStep({
      kind: 'expansion',
      id: record.uuid ?? this.nextId('task'),
      recordUuid: record.uuid ?? null,
      label: truncate(extractTaskNotificationSummary(text), 80),
      text,
      source: 'task-notification',
    })
  }

  pushLocalOutput(record) {
    this.touchPair(record)
    this.attachStep({
      kind: 'local-output',
      id: record.uuid ?? this.nextId('out'),
      recordUuid: record.uuid ?? null,
      text: extractLocalOutput(String(record.message?.content ?? '')),
    })
  }

  pushToolResults(record) {
    this.touchPair(record)
    const content = record.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (block?.type === 'tool_result') this.applyToolResult(block)
    }
  }

  applyToolResult(block) {
    const resultText = toolResultText(block)
    const step = block.tool_use_id ? this.pendingTools.get(block.tool_use_id) : undefined
    if (step) {
      step.resultText = resultText
      step.resultIsError = block.is_error === true
      step.resultMissing = false
      if (block.tool_use_id) this.pendingTools.delete(block.tool_use_id)
      return
    }
    // Orphan result (tool_use outside this file or missing): keep it visible.
    this.attachStep({
      kind: 'tool',
      id: this.nextId('tool'),
      recordUuid: null,
      toolName: '(unknown tool)',
      toolUseId: block.tool_use_id ?? null,
      isAgent: false,
      inputDigest: '',
      input: null,
      resultText,
      resultIsError: block.is_error === true,
      resultMissing: false,
    })
  }

  pushAssistant(record) {
    const pair = this.ensurePair()
    this.touchPair(record)
    if (typeof record.message?.model === 'string') {
      this.models.add(record.message.model)
      pair.models.add(record.message.model)
    }
    if (record.message?.usage) {
      // Multiple records share one API request (one per content block);
      // dedupe by requestId so tokens are not multiplied.
      const key = record.requestId ?? record.uuid ?? this.nextId('usage')
      this.usageByRequest.set(key, record.message.usage)
      pair.usageByRequest.set(key, record.message.usage)
      // Context occupancy = the full prompt of a request (input + cache
      // read + cache created); the pair keeps its maximum.
      const usage = record.message.usage
      const context = (usage.input_tokens ?? 0)
        + (usage.cache_read_input_tokens ?? 0)
        + (usage.cache_creation_input_tokens ?? 0)
      if (context > 0 && (pair.contextTokens === null || context > pair.contextTokens)) {
        pair.contextTokens = context
      }
    }

    const attribution = assistantAttribution(record)
    if (!attribution) this.group = null

    for (const block of record.message.content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text') {
        if (typeof block.text === 'string' && block.text.trim()) {
          // Prose is the answer speaking — never grouped, always visible.
          pair.items.push({
            kind: 'prose',
            id: this.nextId('prose'),
            recordUuid: record.uuid ?? null,
            text: block.text,
            attribution: attribution ? attribution.label : null,
          })
        }
      } else if (block.type === 'thinking') {
        this.placeAssistantStep(attribution, {
          kind: 'thinking',
          id: this.nextId('think'),
          recordUuid: record.uuid ?? null,
          text: block.thinking ?? '',
        })
      } else if (block.type === 'tool_use') {
        pair.toolCallCount += 1
        const step = {
          kind: 'tool',
          id: block.id ?? this.nextId('tool'),
          recordUuid: record.uuid ?? null,
          toolName: block.name ?? '(unnamed tool)',
          toolUseId: block.id ?? null,
          isAgent: block.name === 'Agent',
          inputDigest: toolInputDigest(block.name, block.input),
          input: block.input ?? null,
          resultText: null,
          resultIsError: false,
          resultMissing: true,
        }
        if (block.id) this.pendingTools.set(block.id, step)
        this.placeAssistantStep(attribution, step)
      } else {
        this.placeAssistantStep(attribution, {
          kind: 'unknown-block',
          id: this.nextId('blk'),
          recordUuid: record.uuid ?? null,
          blockType: String(block.type ?? '(none)'),
          raw: truncate(JSON.stringify(block), EXCERPT_LENGTH),
        })
      }
    }
  }

  placeAssistantStep(attribution, step) {
    if (attribution) {
      this.ensureGroup(attribution.groupType, attribution.label).steps.push(step)
    } else {
      this.ensurePair().items.push(step)
    }
  }

  pushUnclassified(record) {
    const node = {
      kind: 'unclassified',
      id: record?.uuid ?? this.nextId('uncl'),
      recordUuid: record?.uuid ?? null,
      recordType: String(record?.type ?? '(none)'),
      excerpt: truncate(JSON.stringify(record?.message?.content ?? record), EXCERPT_LENGTH),
      timestamp: record?.timestamp ?? null,
    }
    if (this.pair) {
      this.touchPair(record)
      this.pair.items.push(node)
    } else this.orphans.push(node)
  }

  /**
   * .ccscignore post-pass: drop matching prose/expansion items (a group
   * emptied by drops folds away too), BEFORE finalText derivation so an
   * ignored line can never become the answer. Counted, never silent.
   * @param {any} pair
   */
  applyIgnore(pair) {
    if (!this.ignore) return 0
    const { literals, patterns } = this.ignore
    let dropped = 0
    /** @param {string} text */
    const matches = text =>
      literals.has(text.trim()) || patterns.some(pattern => pattern.test(text))
    /** @param {any[]} items */
    const filterItems = items => items.filter(item => {
      if ((item.kind === 'prose' || item.kind === 'expansion') && matches(item.text)) {
        dropped += 1
        return false
      }
      if (item.kind === 'group') {
        item.steps = filterItems(item.steps)
        if (item.steps.length === 0) return false
      }
      return true
    })
    pair.items = filterItems(pair.items)
    this.ignoredTotal += dropped
    return dropped
  }

  finishPair() {
    const pair = this.pair
    if (!pair) return
    this.pair = null
    this.group = null

    const ignoredCount = this.applyIgnore(pair)

    // Final reports: segment the answer at task-notification boundaries
    // (control returned to the main agent there); each segment contributes
    // its concluding report. Non-final segments only speak with the
    // agent's own voice; the final segment keeps the full fallback chain
    // (the /awaken acid case). Answers without notifications are one
    // segment — exactly the pre-segmentation behavior.
    const segments = [[]]
    for (const item of pair.items) {
      segments[segments.length - 1].push(item)
      if (item.kind === 'expansion' && item.source === 'task-notification') {
        segments.push([])
      }
    }
    /** @type {{ itemId: string, text: string }[]} */
    const finalTexts = []
    segments.forEach((segmentItems, index) => {
      const prose = segmentItems.filter(item => item.kind === 'prose')
      const result = deriveAnswerText(
        prose.map(item => ({ text: item.text, attribution: item.attribution })),
      )
      if (!result) return
      const isLastSegment = index === segments.length - 1
      if (!isLastSegment && prose[result.index].attribution) return
      finalTexts.push({ itemId: prose[result.index].id, text: result.text })
    })
    const final = finalTexts.at(-1) ?? null

    // What the answer shows: each final report plus every own-voice text of
    // SHOWN_MIN_CHARS or more, in answer order. An answer written before
    // housekeeping tool calls is no longer hidden behind a short postscript.
    const finalIds = new Set(finalTexts.map(ref => ref.itemId))
    /** @type {{ itemId: string, text: string }[]} */
    const shownTexts = pair.items
      .filter(item => item.kind === 'prose')
      .filter(item => finalIds.has(item.id) || (!item.attribution && item.text.trim().length >= SHOWN_MIN_CHARS))
      .map(item => ({ itemId: item.id, text: item.text.trim() }))

    const hasContent = pair.items.length > 0
    const answer = hasContent
      ? {
          kind: 'answer',
          id: `${pair.prompt.id}-answer`,
          finalText: final ? final.text : null,
          finalTextItemId: final ? final.itemId : null,
          finalTexts,
          shownTexts,
          items: pair.items,
        }
      : null

    const state = final
      ? 'complete'
      : pair.interrupted
        ? 'interrupted'
        : 'no-answer'

    const durationMs = pair.prompt.timestamp && pair.lastTimestamp
      ? Math.max(0, Date.parse(pair.lastTimestamp) - Date.parse(pair.prompt.timestamp))
      : null

    this.pairs.push({
      kind: 'pair',
      id: pair.prompt.id,
      prompt: pair.prompt,
      answer,
      state,
      systemEvents: pair.systemEvents,
      properties: {
        timestamp: pair.prompt.timestamp,
        durationMs,
        models: [...pair.models],
        usage: sumUsage(pair.usageByRequest),
        contextTokens: pair.contextTokens,
        toolCallCount: pair.toolCallCount,
        runLabels: pair.runLabels,
        ignoredItemCount: ignoredCount,
        compactedHere: pair.compactedHere,
      },
    })
  }

  finish() {
    this.finishPair()
    const hiddenRecordCount = Object.values(this.hiddenTypes).reduce((a, b) => a + b, 0)
    return /** @type {import('./ast.js').SessionNode} */ ({
      kind: 'session',
      id: this.conversationId ?? '(unknown session)',
      pairs: this.pairs,
      systemEvents: this.sessionEvents,
      orphans: this.orphans,
      properties: {
        title: this.customTitle ?? this.aiTitle ?? null,
        created: this.firstTimestamp,
        modified: this.lastTimestamp,
        models: [...this.models],
        usage: sumUsage(this.usageByRequest),
        pairCount: this.pairs.length,
        compacted: this.compacted,
        hiddenRecordCount,
        hiddenRecordTypes: this.hiddenTypes,
        unknownRecordTypes: [...this.unknownTypes],
        ignoredItemCount: this.ignoredTotal,
      },
    })
  }
}

/** @param {any} record */
function assistantAttribution(record) {
  if (typeof record.attributionSkill === 'string' && record.attributionSkill) {
    return { groupType: 'skill', label: `skill: ${record.attributionSkill}` }
  }
  if (typeof record.attributionPlugin === 'string' && record.attributionPlugin) {
    return { groupType: 'plugin', label: `plugin: ${record.attributionPlugin}` }
  }
  if (typeof record.attributionMcpServer === 'string' && record.attributionMcpServer) {
    const tool = typeof record.attributionMcpTool === 'string' && record.attributionMcpTool
      ? `/${record.attributionMcpTool}`
      : ''
    return { groupType: 'mcp', label: `mcp: ${record.attributionMcpServer}${tool}` }
  }
  return null
}

/** @param {any} block */
function toolResultText(block) {
  let content = block.content
  if (Array.isArray(content)) {
    content = content
      .map(item => (typeof item === 'string' ? item : item?.text ?? ''))
      .join('\n')
  }
  if (content == null) return null
  return typeof content === 'string' ? content : JSON.stringify(content)
}

/**
 * Compact, human-scannable input summary per tool family — feeds tree
 * labels and cards.
 * @param {string | undefined} name
 * @param {any} input
 */
export function toolInputDigest(name, input) {
  if (!input || typeof input !== 'object') return ''
  if (['Read', 'Write', 'Edit'].includes(name ?? '')) {
    return String(input.file_path ?? input.path ?? '')
  }
  if (name === 'Bash' || name === 'PowerShell') {
    return truncate(String(input.command ?? ''), DIGEST_LENGTH)
  }
  if (name === 'Agent') return truncate(String(input.description ?? ''), DIGEST_LENGTH)
  if (name === 'Skill') return String(input.skill ?? '')
  if (['Glob', 'Grep'].includes(name ?? '')) {
    const where = input.path ? ` in ${input.path}` : ''
    return truncate(`${input.pattern ?? ''}${where}`, DIGEST_LENGTH)
  }
  return truncate(JSON.stringify(input), DIGEST_LENGTH)
}

/** @param {Map<string, any>} usageByRequest */
function sumUsage(usageByRequest) {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  }
  for (const usage of usageByRequest.values()) {
    totals.inputTokens += usage?.input_tokens ?? 0
    totals.outputTokens += usage?.output_tokens ?? 0
    totals.cacheReadTokens += usage?.cache_read_input_tokens ?? 0
    totals.cacheCreationTokens += usage?.cache_creation_input_tokens ?? 0
  }
  return totals
}

/**
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text
}
