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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function editAssist(pi: ExtensionAPI): void;
//# sourceMappingURL=edit-assist.d.ts.map