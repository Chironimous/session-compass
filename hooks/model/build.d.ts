import type { SessionNode } from './ast.js'

export function buildConversationModel(
  records: unknown[],
  options?: {
    conversationId?: string
    ignore?: { literals?: readonly string[]; patterns?: readonly RegExp[] }
  },
): SessionNode

export function toolInputDigest(name: string | undefined, input: unknown): string
