---
description: Enable edit assist — progressive recovery for the edit tool
argument-hint: "[on|off]"
---
Edit assist overrides the built-in `edit` tool with a progressive recovery ladder:

1. **Normal:** exact match, or fail with diagnostic context (line numbers, closest block)
2. **Escalation:** after 2 consecutive failures, auto-recovery primes
3. **Auto-recovery:** fuzzy-match the intended block via bigram similarity and apply automatically

Also adds system prompt guidelines to prefer `edit` over `write` and investigate failures instead of rewriting.

Usage: `/edit-assist on` or `/edit-assist off`
