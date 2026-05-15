/**
 * Edit Assist — Progressive auto-recovery for the edit tool
 *
 * Ladder (by consecutive failures):
 *   Call #1: normal edit, fails => diagnostic context returned
 *   Call #2: normal edit, fails => diagnostic + auto-recovery primed
 *   Call #3+: auto-recovery path => fuzzy match + apply => success => ladder resets
 *
 * State is stored on globalThis to survive across extension reloads.
 */

import type { EditToolCallEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import type { TextContent } from "@earendil-works/pi-ai";
import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { Type } from "typebox";

const STATE_KEY = "EDIT_ASSIST_STATE";

interface LadderState {
  failureCount: number;
  autoRecoveryMode: boolean;
}

function getState(): LadderState {
  const g = globalThis as Record<string, unknown>;
  return (g[STATE_KEY] as LadderState) ?? { failureCount: 0, autoRecoveryMode: false };
}

function setState(s: LadderState): void {
  (globalThis as Record<string, unknown>)[STATE_KEY] = s;
}

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  edits: Type.Array(
    Type.Object({
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
    }),
    { description: "One or more targeted replacements. Each edits[].oldText must be unique in the file." },
  ),
});

function normalizeEditWhitespace(event: EditToolCallEvent): void {
  if (!event.input.edits) return;
  for (const edit of event.input.edits) {
    if (!edit.oldText) continue;
    const original = edit.oldText;
    const variants = [
      original.replace(/\r\n/g, "\n"),
      original.replace(/[ \t]+$/gm, ""),
      original.split("\n").map((l: string) => l.trimEnd()).join("\n"),
      original.replace(/\t/g, "  "),
    ];
    for (const v of variants) {
      if (v !== original) { edit.oldText = v; break; }
    }
  }
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) {
    const bg = a.slice(i, i + 2);
    bigrams.set(bg, (bigrams.get(bg) ?? 0) + 1);
  }
  let intersection = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const bg = b.slice(i, i + 2);
    const count = bigrams.get(bg) ?? 0;
    if (count > 0) { bigrams.set(bg, count - 1); intersection++; }
  }
  return (2 * intersection) / (a.length - 1 + b.length - 1);
}

interface MatchResult { start: number; end: number; text: string; }

function fuzzyLocate(content: string, needle: string, minScore = 0.5): MatchResult | null {
  const lines = content.split("\n");
  const needleLines = needle.split("\n");
  const anchorLine = needleLines.reduce((b, l) => (l.trim().length > b.trim().length ? l : b), needleLines[0] ?? "").trim();
  if (!anchorLine) return null;
  let bestScore = 0, bestIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(lines[i]?.trim() ?? "", anchorLine);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  if (bestScore < minScore || bestIdx === -1) return null;
  const startLine = Math.max(0, bestIdx - Math.floor(needleLines.length / 2));
  const endLine = Math.min(lines.length, startLine + needleLines.length);
  const block = lines.slice(startLine, endLine).join("\n");
  if (block.length === 0) return null;
  const precedingLines = lines.slice(0, startLine);
  const start = precedingLines.join("\n").length + (precedingLines.length > 0 ? 1 : 0);
  const end = start + block.length;
  return { start, end, text: block };
}

function buildDiagnostic(content: string, needle: string): string {
  const match = fuzzyLocate(content, needle, 0.3);
  if (!match) return `  "${truncate(needle, 60)}" - not found anywhere in the file`;
  const lines = content.split("\n");
  const startLine = content.slice(0, match.start).split("\n").length;
  const ctxStart = Math.max(0, startLine - 3);
  const ctxEnd = Math.min(lines.length, startLine + Math.max(needle.split("\n").length, 3) + 3);
  const context = lines.slice(ctxStart, ctxEnd).map((l, i) => {
    const lineNum = ctxStart + i + 1;
    const marker = lineNum === startLine + 1 ? ">" : " ";
    return "  " + marker + " " + String(lineNum).padStart(4) + "| " + l;
  }).join("\n");
  return [
    `  Attempted: "${truncate(needle, 80)}"`,
    "  Closest block at line " + (startLine + 1) + " (similarity: " + Math.round(match ? similarity(match.text, needle) * 100 : 0) + "%):",
    context,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

interface Edit { oldText: string; newText: string; }

function normalizeEdits(params: Record<string, unknown>): Edit[] {
  const edits = params.edits as Edit[] | undefined;
  if (edits && edits.length > 0) return edits;
  if (typeof params.oldText === "string" && typeof params.newText === "string") {
    return [{ oldText: params.oldText, newText: params.newText }];
  }
  return [];
}

interface AppliedEdit extends Edit { recovered: boolean; }

async function applyWithRecovery(path: string, content: string, edits: Edit[]) {
  let current = content;
  const applied: AppliedEdit[] = [];
  for (const edit of edits) {
    const idx = current.indexOf(edit.oldText);
    if (idx === -1) {
      const match = fuzzyLocate(current, edit.oldText);
      if (match) {
        current = current.slice(0, match.start) + edit.newText + current.slice(match.end);
        applied.push({ ...edit, recovered: true });
      } else {
        applied.push({ ...edit, recovered: false });
      }
    } else {
      current = current.slice(0, idx) + edit.newText + current.slice(idx + edit.oldText.length);
      applied.push({ ...edit, recovered: true });
    }
  }
  const recoveryCount = applied.filter((a) => a.recovered).length;
  const failCount = applied.filter((a) => !a.recovered).length;
  await writeFile(path, current, "utf-8");
  const parts: string[] = ["Applied " + applied.length + " edit(s) to " + path];
  if (recoveryCount > 0) parts.push("Auto-recovered " + recoveryCount + " fuzzy match(es)");
  if (failCount > 0) parts.push("" + failCount + " edit(s) could not be matched");
  const isError = failCount === applied.length;
  const result: { content: TextContent[]; details: Record<string, unknown>; isError?: boolean } = {
    content: [{ type: "text" as const, text: parts.join(" - ") }],
    details: { autoRecovered: recoveryCount > 0, applied, path },
  };
  if (isError) result.isError = true;
  return result;
}

async function applyWithDiagnostic(path: string, content: string, edits: Edit[]) {
  let current = content;
  const applied: Edit[] = [];
  const failed: Edit[] = [];
  for (const edit of edits) {
    const idx = current.indexOf(edit.oldText);
    if (idx === -1) { failed.push(edit); }
    else {
      current = current.slice(0, idx) + edit.newText + current.slice(idx + edit.oldText.length);
      applied.push(edit);
    }
  }
  if (applied.length > 0) await writeFile(path, current, "utf-8");
  if (failed.length > 0) {
    const s = getState();
    const hdr = "[state: failureCount=" + s.failureCount + ", autoRecovery=" + s.autoRecoveryMode + "]";
    const diagnostics = failed.map((f) => buildDiagnostic(content, f.oldText)).join("\n\n");
    const msg = applied.length > 0
      ? hdr + "\n" + "Applied " + applied.length + "/" + edits.length + " edit(s) to " + path + ".\n\nFailed edit(s):\n" + diagnostics
      : hdr + "\n" + "Could not apply " + edits.length + " edit(s) to " + path + ":\n\n" + diagnostics;
    return {
      content: [{ type: "text" as const, text: msg }],
      details: { applied, failed: failed.length, path },
      isError: true,
    };
  }
  return {
    content: [{ type: "text" as const, text: "Applied all " + edits.length + " edit(s) to " + path }],
    details: { edits: edits.length, path },
  };
}

export default function editAssist(pi: ExtensionAPI) {
  pi.on("session_start", () => {
    setState({ failureCount: 0, autoRecoveryMode: false });
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt + "\n\n## File Editing Guidelines\n\n" +
        "- Prefer the `edit` tool over `write` when modifying existing files.\n" +
        "  `edit` makes precise, targeted replacements and is safer than overwriting.\n" +
        "- If `edit` fails (`oldText` not found), do NOT fall back to `write`.\n" +
        "  Instead:\n" +
        "  1. Use `read` to inspect the current file content around the target area\n" +
        "  2. Identify why the match failed (whitespace, encoding, already applied, etc.)\n" +
        "  3. Retry `edit` with the corrected exact `oldText` from the file\n" +
        "- Only use `write` for new files or when the entire file content genuinely\n" +
        "  needs to be replaced from scratch.\n",
    };
  });

  pi.on("tool_call", (event) => {
    if (isToolCallEventType("edit", event)) normalizeEditWhitespace(event);
  });

  pi.registerTool({
    name: "edit",
    label: "edit",
    description:
      "Edit a single file using exact text replacement. " +
      "If the match fails, diagnostic context is provided. After consecutive failures, " +
      "auto-recovery activates with fuzzy matching.",
    promptSnippet: "Edit files with precise text replacement; auto-recovers from match failures",
    promptGuidelines: [
      "Use edit for targeted text replacements in existing files. Keep oldText small and unique.",
      "If oldText does not match, re-read the file and construct oldText from the actual content.",
    ],
    parameters: editSchema,

    prepareArguments(args): { path: string; edits: Edit[] } {
      if (!args || typeof args !== "object") return { path: "", edits: [] };
      const input = args as Record<string, unknown>;
      if (typeof input.oldText !== "string" || typeof input.newText !== "string") {
        return args as unknown as { path: string; edits: Edit[] };
      }
      return {
        path: typeof input.path === "string" ? input.path : "",
        edits: [
          ...(Array.isArray(input.edits) ? (input.edits as Edit[]) : []),
          { oldText: input.oldText as string, newText: input.newText as string },
        ],
      };
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Edit aborted by caller." }], details: {}, isError: true };
      }

      const absolutePath = resolve(ctx.cwd, params.path);
      const edits = normalizeEdits(params as unknown as Record<string, unknown>);
      if (edits.length === 0) {
        return { content: [{ type: "text" as const, text: "No edits provided." }], details: {} };
      }

      return withFileMutationQueue(absolutePath, async () => {
        if (signal?.aborted) {
          return { content: [{ type: "text" as const, text: "Edit aborted by caller." }], details: {}, isError: true };
        }

        let content: string;
        try {
          await access(absolutePath, constants.R_OK);
          content = await readFile(absolutePath, "utf-8");
        } catch {
          return {
            content: [{ type: "text" as const, text: "Cannot read " + params.path + ": file does not exist or is not readable." }],
            details: { error: "not_found" },
            isError: true,
          };
        }

        const state = getState();

        if (state.autoRecoveryMode) {
          const result = await applyWithRecovery(absolutePath, content, edits);
          if (!result.isError) {
            setState({ failureCount: 0, autoRecoveryMode: false });
            try { ctx.ui.notify("edit: auto-recovery succeeded, back to normal", "info"); } catch { /* no-op */ }
          }
          return result;
        }

        const result = await applyWithDiagnostic(params.path, content, edits);
        if (result.isError) {
          state.failureCount++;
          if (state.failureCount >= 2) {
            state.autoRecoveryMode = true;
            try { ctx.ui.notify("edit: auto-recovery primed for next attempt", "warning"); } catch { /* no-op */ }
          }
          setState(state);
        } else {
          setState({ failureCount: 0, autoRecoveryMode: false });
        }
        return result;
      });
    },
  });
}
