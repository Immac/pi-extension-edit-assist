# Edit Assist

Progressive auto-recovery for pi's `edit` tool — fixes whitespace mismatches silently, provides diagnostic context on failure, and activates fuzzy matching after consecutive failures.

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue?style=flat-square&logo=typescript)
![MIT License](https://img.shields.io/badge/license-MIT-green?style=flat-square)
![Pi Extension](https://img.shields.io/badge/pi--extension-orange?style=flat-square)

---

## Features

- **🔍 Whitespace normalization** — silently strips trailing whitespace, normalizes CRLF→LF, and expands tabs before every edit call
- **📋 Diagnostic context** — when an edit fails, shows the closest matching block with line numbers and a similarity score
- **⚡ Progressive ladder** — 1st and 2nd failures give diagnostics; 3rd failure activates auto-recovery with fuzzy matching
- **🔄 Self-resetting** — a successful edit in normal mode resets the failure counter; auto-recovery success flips back to normal
- **🧠 System prompt guidance** — injects file-editing guidelines every turn: prefer `edit` over `write`, investigate failures instead of rewriting
- **📦 Mutation-queue safe** — uses `withFileMutationQueue` so parallel sibling edits on the same file don't clobber each other
- **🔙 Legacy session compat** — `prepareArguments` folds flat `oldText`/`newText` from older sessions into the modern `edits[]` shape

## How it works

```
                    tool_call hook                  tool_result hook
                    (normalize whitespace)           (manage ladder)
                         │                               │
Call #1 ──► edit.execute() ──► path: normal ──► fails ──► failureCount=1
                         │                     diagnostic returned

Call #2 ──► edit.execute() ──► path: normal ──► fails ──► failureCount=2
                         │                     diagnostic    ⚡ flag = on

Call #3 ──► edit.execute() ──► flag=TRUE ──► path: fuzzy recovery ──► success
                         │     match + apply        flag reset, notify
```

### Auto-recovery matching

When in recovery mode, the tool uses **Dice coefficient** on character bigrams to find the best-matching block in the file, then applies the edit against the *actual* text rather than the LLM's guessed text.

## Usage

### Loading from a custom path

```bash
pi -e ~/path/to/edit-assist/dist/extensions/edit-assist/edit-assist.js
```

### Adding via `settings.json`

```json
{
  "extensions": ["~/path/to/edit-assist/dist/extensions/edit-assist/edit-assist.js"]
}
```

### What changes

No new commands or tools. The built-in `edit` tool is **overridden** — same name, same schema, same UI rendering — but with three behavioral enhancements layered on:

1. **System prompt** gains a "File Editing Guidelines" section each turn
2. **Whitespace is normalized** silently before every edit
3. **Failure recovery escalates** — diagnostics → auto-recovery → reset

## Development

```bash
# Prerequisites
npm install
npm link @earendil-works/pi-coding-agent   # for type resolution

# Build
npm run build

# Watch
npm run watch
```

## Architecture

Single-file extension (~380 lines):

| Component | Lines | Role |
|-----------|-------|------|
| Schema + state | ~30 | TypeBox schema, failure counter, recovery flag |
| `normalizeEditWhitespace` | ~25 | Pre-flight CRLF/tabs/trailing-whitespace fix |
| `similarity` / `fuzzyLocate` | ~50 | Dice coefficient + block matching |
| `buildDiagnostic` | ~30 | Line-numbered context around closest match |
| `applyWithRecovery` | ~40 | Fuzzy-recovery edit execution |
| `applyWithDiagnostic` | ~40 | Exact-match execution with partial progress |
| Event handlers | ~60 | `before_agent_start`, `tool_call`, `tool_result`, `session_start` |
| `registerTool` | ~70 | Tool override with `prepareArguments` + `execute` |

## License

MIT
