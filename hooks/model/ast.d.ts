/**
 * The conversation AST — the typed contract the browser and the Info pane
 * consume. Built from Claude Code JSONL records by
 * `build.js`; classification rules live in `classify.js`.
 */

/** Provenance classes assigned to raw records. */
export type RecordClass =
  | 'prompt-human'
  | 'prompt-command'
  | 'meta-injection'
  | 'task-notification'
  | 'tool-result'
  | 'local-output'
  | 'assistant'
  | 'session-meta'
  | 'system-event'
  | 'infrastructure'
  | 'unclassified'

export interface UsageTotals {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

export interface SessionProperties {
  title: string | null
  created: string | null
  modified: string | null
  models: string[]
  usage: UsageTotals
  pairCount: number
  compacted: boolean
  /** Records hidden as infrastructure, total and by record type. */
  hiddenRecordCount: number
  hiddenRecordTypes: Record<string, number>
  /** Record types outside the known set — hidden but flagged (trust rule). */
  unknownRecordTypes: string[]
  /** Answer items dropped by the user's .ccscignore rules. */
  ignoredItemCount: number
}

export interface SessionNode {
  kind: 'session'
  id: string
  pairs: PairNode[]
  /** Events outside any pair (before the first prompt, or trailing). */
  systemEvents: SystemEventNode[]
  /** Visible unclassified records outside any pair (trust rule: never hidden). */
  orphans: UnclassifiedNode[]
  properties: SessionProperties
}

export type PairState = 'complete' | 'interrupted' | 'no-answer'

export interface PairProperties {
  /** Prompt timestamp (ISO). */
  timestamp: string | null
  /** Prompt timestamp to the pair's last record. */
  durationMs: number | null
  models: string[]
  usage: UsageTotals
  /**
   * Context-window occupancy at this pair: the largest prompt size among
   * its requests (input + cache-read + cache-created tokens).
   */
  contextTokens: number | null
  toolCallCount: number
  /** Machinery group labels in order, e.g. ["skill: loop"]. */
  runLabels: string[]
  /** Answer items dropped from this pair by .ccscignore rules. */
  ignoredItemCount: number
  /** A compaction marker record landed in this pair (timeline event). */
  compactedHere: boolean
}

export interface PairNode {
  kind: 'pair'
  id: string
  prompt: PromptNode
  answer: AnswerNode | null
  state: PairState
  systemEvents: SystemEventNode[]
  properties: PairProperties
}

/**
 * 'implicit' marks a pair synthesized for content arriving before any
 * prompt (resumed/continued sessions).
 */
export type PromptSource = 'typed' | 'command' | 'implicit'

export interface PromptNode {
  kind: 'prompt'
  id: string
  /** uuid of the source JSONL record, for raw inspection. */
  recordUuid: string | null
  /** What the user typed (cleaned), or the command line for source 'command'. */
  text: string
  source: PromptSource
  commandName: string | null
  imageCount: number
  documentCount: number
  timestamp: string | null
}

/** One segment-final report (see AnswerNode.finalTexts). */
export interface FinalTextRef {
  /** Id of the prose item that provided this report. */
  itemId: string
  text: string
}

export interface AnswerNode {
  kind: 'answer'
  id: string
  /** The LAST report — kept for compatibility; equals finalTexts.at(-1). */
  finalText: string | null
  /** Id of the prose item that provided finalText. */
  finalTextItemId: string | null
  /**
   * The final reports, in order: the answer is segmented at background-task
   * notifications (control returned to the main agent there), and each
   * segment contributes its concluding report (finalText.js's rule) + the
   * own-voice-over-attributed preference. Answers without notifications
   * have exactly one entry.
   */
  finalTexts: FinalTextRef[]
  /**
   * What the answer shows (browser, its copy, the Info pane's digest): each
   * final report plus every own-voice prose text of at least
   * SHOWN_MIN_CHARS (finalText.js) characters, in answer order, each once.
   */
  shownTexts: FinalTextRef[]
  /** Ordered content: prose (visible), groups/steps (collapsed), unclassified (visible, flagged). */
  items: AnswerItem[]
}

export type AnswerItem =
  | ProseItem
  | MachineryGroupNode
  | StepNode
  | UnclassifiedNode

/** Assistant text — the answer speaking. Always visible. */
export interface ProseItem {
  kind: 'prose'
  id: string
  recordUuid: string | null
  text: string
  /** Attribution active while this text was produced (e.g. "skill: loop"), or null. */
  attribution: string | null
}

export interface MachineryGroupNode {
  kind: 'group'
  id: string
  groupType: 'skill' | 'plugin' | 'mcp'
  /** Display label, e.g. "skill: loop". */
  label: string
  steps: StepNode[]
}

export type StepNode =
  | ToolStep
  | ThinkingStep
  | ExpansionStep
  | LocalOutputStep
  | UnknownBlockStep

export interface ToolStep {
  kind: 'tool'
  id: string
  recordUuid: string | null
  toolName: string
  toolUseId: string | null
  /** Agent calls are opaque by decision — the result is the subagent's answer. */
  isAgent: boolean
  /** Compact printable input summary for labels/cards. */
  inputDigest: string
  input: unknown
  resultText: string | null
  resultIsError: boolean
  /** True when no tool_result was found for this tool_use. */
  resultMissing: boolean
}

export interface ThinkingStep {
  kind: 'thinking'
  id: string
  recordUuid: string | null
  text: string
}

/**
 * Harness-injected text rendered as a collapsed step: skill/command
 * instruction expansions (isMeta) and background-task notifications.
 */
export interface ExpansionStep {
  kind: 'expansion'
  id: string
  recordUuid: string | null
  /** First line of the injected text, truncated — for tree/card labels. */
  label: string
  text: string
  /** What injected it: isMeta expansion, or a background-task notification (a segment boundary of the final reports). */
  source: 'meta' | 'task-notification'
}

/** Output of a local command run outside the model (<local-command-stdout>). */
export interface LocalOutputStep {
  kind: 'local-output'
  id: string
  recordUuid: string | null
  text: string
}

/** A content block type this version does not know. Visible, flagged. */
export interface UnknownBlockStep {
  kind: 'unknown-block'
  id: string
  recordUuid: string | null
  blockType: string
  raw: string
}

export interface SystemEventNode {
  kind: 'system-event'
  id: string
  recordUuid: string | null
  subtype: string | null
  level: string | null
  message: string
  /** True for "[Request interrupted …]" user records. */
  interruption: boolean
  timestamp: string | null
}

/** A conversational record no rule matched. Visible by the trust rule. */
export interface UnclassifiedNode {
  kind: 'unclassified'
  id: string
  recordUuid: string | null
  recordType: string
  excerpt: string
  timestamp: string | null
}
