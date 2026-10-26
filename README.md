# Session Compass

See how full your context is, jump back to any prompt, and get a summary of
the whole conversation.

Session Compass is a Claude Code mod. It adds a band above the prompt that
shows how full the context window is and how it grew over the session. In a
terminal it jumps back to earlier prompts; in the VS Code panel it opens a
conversation browser that shows them. On both, an Info pane summarizes the
conversation.

```
Terminal:  Context 30% ███░░░░░░░   ▁▂▂▃▃▄▅▅▆▇   ◀◀ ◀ 12/27 ▶ ▶▶   ⓘ ☰ ◔
VS Code:   Context 30% ███░░░░░░░   [ graph ]                 ⇅   ⓘ ☰ ◔
```

## What it shows

| Part | What it does |
| --- | --- |
| `Context 30%` and bar | The context window's current fill, 10 cells. Green below 80 %, yellow from 80 to 90 %, red above 90 %. |
| Graph | One point per model request of the main conversation, on a fixed 0–100 % scale of the context window. In VS Code and the Desktop app it is a small area chart; in a terminal it is one row of eighth-height blocks. |
| `◀◀ ◀ 12/27 ▶ ▶▶` | The prompt navigator, everywhere except the VS Code panel. `12/27` is the current prompt of all prompts in the session. `◀` and `▶` move one prompt, `◀◀` and `▶▶` move ten, and all of them stop at the first and the last prompt. Pressing `12/27` jumps to the current prompt again. Each press scrolls the chat so the prompt sits at the top, where the surface allows it (see [Development status](#development-status)). A new prompt moves the navigator to it. |
| `⇅` | In the VS Code panel only, in place of the navigator: opens the [conversation browser](#the-conversation-browser-vs-code). |
| `ⓘ` | Opens the [Info pane](#the-info-pane): Summary, Timeline and Details of the conversation. |
| `☰` | Puts `/context` into the prompt box, on a new line if you have already typed something. Press Enter to open Claude Code's context view. |
| `◔` | The same for `/usage`. |

A prompt is every prompt you type and every slash command. Task notifications
and other messages Claude Code adds itself are not counted.

**When the band gets narrow** it leaves parts out, in this order: first `☰`
and `◔`, then the bar, then the graph; `Context 70%` and the buttons that
open the panes stay. In a terminal (counted in characters): everything from
101 columns, without `☰` `◔` from 89, also without the bar from 79, and
`Context N%`, the navigator and `ⓘ` from 57. A terminal narrower than that
shows `Context N%`, the bar and, from 45 columns, the graph, without buttons.
The VS Code panel switches at widths measured on screen, and wraps the row
below the last step.

## The conversation browser (VS Code)

The VS Code panel does not let a mod scroll the chat, so there `⇅` opens a
pane that shows one prompt and its answer at a time:

- `◀◀ ◀ 17/34 ▶ ▶▶` moves through the prompts, by one or by ten, and stops at
  the first and the last. The browser opens at the newest prompt and follows
  new prompts while you stay on the newest.
- Next to it: when the prompt was sent, then two buttons. `⧉` copies the
  prompt and its whole answer as Markdown, under `# Prompt 28` and
  `# Response 28` headings. `♻` puts the prompt back into the prompt box, on
  a new line after anything you have typed.
- Below: the prompt in full, in a bubble like the chat's, with the images
  pasted into it as thumbnails, one under the other. Then the answer. Tool
  calls and thinking are left out.
- In a narrow pane the header leaves out `♻` first, then the date, then `◀◀`
  and `▶▶`. `◀ 17/34 ▶` and `⧉` stay.
- **Search**, as you type: the field under the header counts the prompts
  whose text or answer contains what you type, ignoring case: "2 of 7" while
  a matching prompt is shown, "7 matches" otherwise, or "no match". `▲` and
  `▼` (shown when they lead to another prompt) and Enter go to the previous
  or next one, wrapping around at the ends. Deleting the text ends the search.
  The VS Code panel empties the field after Enter; the search stays and shows
  dimmed in the empty field.

The pane's text cannot be selected: the VS Code panel switches selection off
in mod panes. That is why `⧉` exists.

**Thumbnails**: the panel draws images only inside a mod's SVG drawing, which
holds at most 131,072 characters. A pasted PNG wider than 250 pixels is
therefore shrunk to 250 pixels, in the mod, with the bundled
[fast-png](#files) library; a screenshot comes to about 32,000 characters.
The first look at a prompt takes about a tenth of a second per image; after
that the thumbnail is kept for the session. An image that still does not
fit (a large JPEG, or a PNG of pure noise) shows as "image n cannot be
shown".

**The answer** is what Claude wrote in its own voice during the turn: every
text of 200 characters or more, plus the turn's last substantial text (the
last of each stretch when background tasks handed control back mid-turn), in
order and separated by a line. Shorter notes in between ("Let me check…")
are left out, so an answer is not lost when Claude writes it before a few
more tool calls and a short closing note. Answers longer than 60,000
characters are cut, with a note.

**`.ccscignore`**: answer texts that match a rule in your `.ccscignore` are
dropped before the answer is picked, so housekeeping replies (such as a
`/loop`'s) never become the answer. One rule per line: an exact text or a
`/regular expression/`, and `#` for comments. The mod ships
`.ccscignore.def` with two rules, `Awaken skipped.` and
`/^Commandments loaded\./`, and copies it to
`~/.claude/session-compass/.ccscignore` (under `CLAUDE_CONFIG_DIR` if you set
it) the first time the browser opens. Edit that file: it lies outside the
mod's folder, so no update of the mod touches it. Versions before 0.6.0 kept
it in the mod's folder; the first browser opening copies it over.

The browser reads the session's transcript when it opens, and again after
each finished turn while it is open. In the author's longest session (19 MB)
reading took about 1.1 seconds. What it reads stays in memory and is dropped
when you close the pane.

## The Info pane

`ⓘ` opens a pane about the open conversation, in a terminal and in the VS Code
panel, with three tabs:

- **Summary:** what the conversation was for, its outcome, key decisions,
  notable details and open items, in the language you wrote your prompts in.
- **Timeline:** the conversation's topics, tasks, decisions and findings, each
  under the prompt it belongs to, plus model changes, compactions,
  interruptions and errors, which the mod reads from the transcript itself.
  Each entry's `↓ n` sets the browser to its prompt in VS Code (switch to
  the Browser tab to see it: a mod cannot bring a pane to the front), and
  scrolls the chat there in a terminal.
- **Details:** the conversation's properties: id, created, modified, models,
  tokens, prompt count, whether it was compacted; below them, what each of
  the mod's buttons does (as in [All buttons](#all-buttons)).

With the browser open too, the VS Code panel shows the two panes as tabs,
"Browser" and "Info".

**Summary and Timeline are made on request**, never by opening the pane:
"Generate summary & timeline" asks Claude Opus for both, one after the other,
through your own Claude Code session, so it counts against your plan or API
usage like any request. On a conversation of 68 prompts this took about two
minutes; beside the button the pane says how long it expects this one to
take. When the conversation has gone on since, the pane says "conversation
changed since" and offers "Regenerate". The input is a digest of the
conversation's prompts and answers (the texts the browser shows), at most
400,000 characters; a longer conversation keeps its most recent prompts and
the summary says so.

**While it runs**, a progress bar shows the time elapsed and about how long is
left, and Cancel stops it. The estimate: for each part, the median time per
character of the last 20 runs, times this conversation's size. The mod starts
from the Opus runs measured on two conversations while it was built, and every
finished generation refines it; the history is kept in the mod's own store.
The bar stops at 95 % until the run has really finished.

**`⧉` copies the shown tab as Markdown** (the pane's text cannot be
selected in the VS Code panel): the conversation's title as a `#` heading,
then "Summary · <conversation id>" (or Timeline, Details) and, for Summary and
Timeline, the "Generated …" line, then the tab itself: the summary's
sections, one `##` heading per timeline entry with its date and kind, or the
details table. A tab with nothing to copy yet shows no `⧉`.

**Where it is stored:** in your project, in `.ccsc/<session id>/`
(`summary.md`, `timeline.json`), next to the code the conversation was
about. The mod creates `.ccsc/.gitignore` containing `*`, so git ignores the
whole folder; delete that file if you want to commit them.

## All buttons

The VS Code panel shows no tooltips, so here is what each button does. The
Info pane's Details tab shows the same table.

| Button | What it does |
| --- | --- |
| `⇅` | Opens the conversation browser (VS Code panel) |
| `◀◀` `◀` `n/N` `▶` `▶▶` | Ten or one prompt back or forward; `n/N` shows the current prompt again (the navigator in a terminal, the browser in VS Code) |
| `ⓘ` | Opens the Info pane |
| `☰` | Puts `/context` into the prompt box |
| `◔` | Puts `/usage` into the prompt box |
| `⧉` | Copies, as Markdown: the shown prompt and its answer (browser), or the shown tab (Info pane) |
| `♻` | Puts the shown prompt back into the prompt box (browser) |
| `▲` `▼` | The previous or next prompt that contains the search text (browser) |
| `↓ n` | Sets the browser to prompt n (VS Code; its tab stays behind the Info pane), or scrolls the chat there (terminal) |

## What it reads and writes

The mod is code that runs with your permissions, like every mod.

- **Reads** the current session's transcript from
  `~/.claude/projects/<project>/<session-id>.jsonl` (or under
  `CLAUDE_CONFIG_DIR`): once to rebuild the history of a session it has not
  seen, and each time the browser or the Info pane opens or refreshes. It
  streams the file through `cat`, or `cmd.exe /c type` on Windows.
- **Reads** the environment variables `CLAUDE_CONFIG_DIR`, `HOME`, `OS` and
  `USERPROFILE`, to find the transcript and your `.ccscignore`; `OS` also
  sizes the band in the VS Code panel, whose cells are wider on the Mac.
- **Writes** its own store, which Claude Code keeps at
  `~/.claude/plugins/store/session-compass_*.json`: one history per session
  (token counts, the first 100 characters of each prompt, each prompt's
  message id), at most 200 sessions and 2 MiB, the oldest dropped first; and
  the Info pane's run times (the last 20 per part).
- **Writes** `~/.claude/session-compass/.ccscignore` (or under
  `CLAUDE_CONFIG_DIR`), your rules for the browser, created from
  `.ccscignore.def` the first time the browser opens.
- **Writes** `.ccsc/` in the project the session runs in: the Info pane's
  summary and timeline, and `.ccsc/.gitignore`.
- **Calls a model** only when you press "Generate summary & timeline" (or
  "Regenerate"): two requests to Claude Opus through the session's own client,
  with the digest of the conversation's prompts and answers as input. No other
  network requests. It never submits a prompt into the conversation. If the
  prompt box refuses the text, `☰` and `◔` run the command directly instead.

To check this yourself, clone the repository
(`git clone https://github.com/Chironimous/session-compass`) and run
`claude plugin validate session-compass`. Its `hooks:` and `calls:` lines list
every event the mod handles and everything it asks Claude Code to do.

## Install

Requirements: the Claude Code CLI 2.1.310 or later in the terminal, and the
VS Code extension 2.1.310 or later for the chat panel. Developed on Windows
11.

In a Claude Code session in a terminal, run:

```
/plugin install session-compass --marketplace Chironimous/session-compass
```

It adds the `chironimous` marketplace from GitHub (after asking you to
confirm) and opens Session Compass there to install. Or, from your shell:

```
claude plugin marketplace add Chironimous/session-compass
claude plugin install session-compass@chironimous
```

**After installing or updating:** a terminal session picks the change up when
it starts, or when you run `/reload-plugins`. The VS Code panel does not
reload mods by itself: run `/reload-plugins` there.

**To check that it loaded:** the band appears above the prompt. In a terminal,
`/plugin` also shows a line such as `1 mod active · session-compass`.

**Updates** arrive only when you ask for them, unless you turn on
auto-update: in `/plugin`, open **Marketplaces**, select `chironimous` and
choose **Enable auto-update**. To update by hand, run
`/plugin marketplace update chironimous` in a session, or
`claude plugin update session-compass@chironimous` in your shell.

**To remove it:** run `claude plugin uninstall session-compass@chironimous`
in your shell, then `/reload-plugins` in open sessions. The store file
(`~/.claude/plugins/store/session-compass_*.json`) can be deleted too.

## Development status

Version 0.6.1. In daily use by its author. Claude Code's mods API is in early access and changes between
releases, so a Claude Code update can break the mod.

What works:

- The bar, the graph and the `☰` `◔` buttons, in terminals and the VS Code
  panel.
- The prompt navigator's jumps in a terminal with Claude Code's fullscreen
  layout (the default, where Claude Code scrolls the chat itself).
- The conversation browser in the VS Code panel: navigation, answers,
  `.ccscignore`, `⧉` and image thumbnails, large screenshots included.
- The Info pane in the VS Code panel: generation, the three tabs, `⧉`.

Not yet confirmed on a real surface: the Info pane in a terminal (with the
timeline's `↓ n` scrolling the chat), and its progress bar. Confirmed in the
VS Code panel: the browser's search, the timeline's `↓ n`, the expected time
beside Generate and the button legend. The Info pane's generation was
measured on two real conversations (Haiku, Sonnet and Opus compared; Opus
chosen); the pane itself is covered by the
tests.

Known limits:

- **No jumps in the VS Code panel.** The panel refuses mods' requests to scroll
  the chat ("transcript not scrollable here", extension 2.1.310), which is
  reported to Anthropic. That is why the panel gets the browser instead.
- **No jumps on a terminal's main screen** (for example with
  `CLAUDE_CODE_NO_FLICKER=0`, or in tmux), where the terminal itself holds the
  scrollback and nothing can scroll the chat.
- **Prompts without a message id** move the counter only. This affects
  sessions whose transcript is no longer on disk.
- **VS Code panel:** the graph's per-column tooltips don't show, and the panel
  sometimes refuses the graph's first drawing. The mod draws it again 3 and
  10 seconds later.
- **Classic Windows console** (`conhost.exe`): its fonts lack the eighth-height
  blocks, so the terminal graph shows boxes. Windows Terminal and the VS Code
  terminal draw it correctly.
- **The narrow-panel widths are measured, not computed.** The panel draws its
  own buttons, so the mod cannot measure them. The widths at which the band
  and the browser header leave parts out were read off screenshots (extension
  2.1.310, Windows) with a small margin; another font size or zoom can shift
  them a little. Below the last step the row wraps.
- **No fixed header in the panes.** The VS Code panel scrolls a pane as a
  whole and offers no fixed region, so the browser's navigator and the Info
  pane's tabs scroll away with a long answer or summary (extension 2.1.310).
- The browser counts prompt/answer pairs, the band counts prompts its own,
  simpler way. They agree except in transcripts where Claude Code wrote part
  of a conversation twice.

## Files

| File | Role |
| --- | --- |
| `.claude-plugin/plugin.json` | The plugin's manifest |
| `.claude-plugin/marketplace.json` | The `chironimous` marketplace, which makes this repository installable |
| `.claude-plugin/types/` | API types Claude Code writes on every load (generated) |
| `.ccscignore.def` | The browser's default rules, copied to `~/.claude/session-compass/.ccscignore` on first use |
| `LICENSE` | MIT licence |
| `hooks/hooks.json` | Points Claude Code to the hooks module |
| `hooks/register.tsx` | The hooks: loading and saving the history, the band, the buttons, the browser and Info panes |
| `hooks/info.ts` | The Info pane's prompts, digest, timeline parsing, stored files, structural events, details rows, time estimate and copy text |
| `hooks/history.ts` | Reads a transcript into a history; merges live prompts and requests |
| `hooks/graph.ts` | Draws the graph, as SVG and as terminal blocks |
| `hooks/layout.ts` | Which parts of the band and the browser header fit a given width |
| `hooks/browser.ts` | The browser's entries, answer text, images, copy text and `.ccscignore` rules |
| `hooks/thumbnail.ts` | Shrinks a pasted PNG to a 250 px thumbnail |
| `hooks/model/` | The conversation model: turns transcript records into prompt/answer pairs (builder, record classifier, final-answer rule, digest for the Info pane, types) |
| `hooks/vendor/` | fast-png 8.0.0 with fflate 0.8.3 and iobuffer 6.0.1, bundled into one module (MIT licences in `LICENSES.txt`, how it was built in `BUILD.txt`) |
| `types/index.d.ts` | The mod's own state types |
| `tsconfig.json` | Type-checking setup |

## License

MIT, © 2026 Chironimous. See [LICENSE](LICENSE). The bundled fast-png,
fflate and iobuffer are MIT licensed too; their notices are in
`hooks/vendor/LICENSES.txt`.
