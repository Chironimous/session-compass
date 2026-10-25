import type { PairNode, SessionNode, StepNode } from './ast.js'

export function formatTimestamp(iso: string | null | undefined): string | null
export function toCompactExport(session: SessionNode): string
export function toFullExport(session: SessionNode): string
export function compactPairBlock(pair: PairNode): string
export function fullPairBlock(pair: PairNode): string
export function stepMarkdown(step: StepNode): string

/** Compact export + per-pair metadata comments: the input of the Info pane's model calls. */
export function toKnowledgeDigest(session: SessionNode, options?: { maxChars?: number }): string
export const KNOWLEDGE_DIGEST_MAX_CHARS: number
