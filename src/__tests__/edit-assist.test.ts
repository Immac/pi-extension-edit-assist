import { describe, it, expect } from 'vitest';

// Replicate the pure functions from edit-assist.ts for testing.
// These are the testable pure functions extracted from the extension.
// The extension itself also exports them via globalThis for state management.

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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 3) + '...';
}

function normalizeWhitespace(text: string): string[] {
  const variants: string[] = [];
  const original = text;
  // Normalize line endings
  const lf = original.replace(/\r\n/g, '\n');
  if (lf !== original) variants.push(lf);
  // Trim trailing whitespace per line
  const trimmed = original.split('\n').map(l => l.trimEnd()).join('\n');
  if (trimmed !== original) variants.push(trimmed);
  // Tabs to spaces
  const notabs = original.replace(/\t/g, '  ');
  if (notabs !== original) variants.push(notabs);
  return variants;
}

describe('edit-assist pure functions', () => {
  describe('similarity()', () => {
    it('returns 1 for identical strings', () => {
      expect(similarity('hello world', 'hello world')).toBe(1);
    });

    it('returns 0 for very short strings', () => {
      expect(similarity('a', 'b')).toBe(0);
    });

    it('returns 1 for equal empty strings', () => {
      // '' === '', so early return gives 1 — identical is always 1
      expect(similarity('', '')).toBe(1);
    });

    it('returns >0 for similar strings', () => {
      const s = similarity('function foo', 'function bar');
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(1);
    });

    it('returns 0 for completely different strings', () => {
      const s = similarity('abc', 'xyz');
      expect(s).toBe(0);
    });
  });

  describe('truncate()', () => {
    it('returns string unchanged when under max', () => {
      expect(truncate('hello', 10)).toBe('hello');
    });

    it('truncates with ellipsis when over max', () => {
      const result = truncate('hello world this is long', 10);
      expect(result).toBe('hello w...');
      expect(result.length).toBe(10);
    });

    it('returns empty string for empty input', () => {
      expect(truncate('', 5)).toBe('');
    });
  });

  describe('normalizeWhitespace()', () => {
    it('normalizes CRLF to LF', () => {
      const variants = normalizeWhitespace('line1\r\nline2\r\nline3');
      expect(variants).toContain('line1\nline2\nline3');
    });

    it('trims trailing whitespace per line', () => {
      const variants = normalizeWhitespace('line1   \nline2  \nline3');
      expect(variants).toContain('line1\nline2\nline3');
    });

    it('converts tabs to spaces', () => {
      const variants = normalizeWhitespace('\tindented');
      expect(variants).toContain('  indented');
    });

    it('returns empty array for already-normalized text', () => {
      const variants = normalizeWhitespace('normal\nlines');
      expect(variants).toEqual([]);
    });
  });
});
