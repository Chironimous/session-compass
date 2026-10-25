export type Percent = number | null

/**
 * The context history of the session on screen: one point per model request
 * of the main conversation, each tied to its prompt (see hooks/history.ts).
 */
export type SessionHistory = {
  /** The session the history belongs to (`$.session.id()`). */
  id: string
  /** The stored format: 2 since row ids; older ones are rebuilt from the transcript. */
  format: number
  /** The live context window in tokens; null until known. */
  window: number | null
  tokens: number[]
  promptOf: number[]
  prompts: string[]
  /** Each prompt's transcript row id (the scroll target); '' when unknown. */
  ids: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-compass': {
      percent: Percent
      history: SessionHistory | null
      /** The prompt navigator's position: a 1-based prompt number, null without prompts. */
      cursor: number | null
      /** The conversation browser's position (VS Code): a 1-based prompt number, null before it opened. */
      browseAt: number | null
      /** Counts the browser's data loads, so its pane draws again when new data arrives. */
      browseVersion: number
      /** The browser's search text, as last confirmed (Enter or an arrow); '' for none. */
      browseQuery: string
      /** The Info pane's tab. */
      infoTab: 'summary' | 'timeline' | 'details'
      /** Counts changes of the Info pane's data (loaded, generated, saved), so it draws again. */
      infoVersion: number
    }
  }
}
