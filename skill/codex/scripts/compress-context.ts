#!/usr/bin/env bun
// compress-context.ts — Level-A lossless context compressor for the /codex and /gemini skills.
//
// Reads a prompt on stdin, emits a (de-noised) prompt on stdout. SAFE by design:
//   - Fenced blocks are PROTECTED (byte-for-byte) by default. A block is compressed ONLY
//     when its info-string tag is empty/untagged or in COMPRESSIBLE_TAGS (log/text/output…).
//     => any code/data/diff/csv fenced with a language tag is never touched.
//   - Outside protected fences only NOISE is removed: ANSI/OSC escapes, trailing whitespace,
//     runs of >=3 blank lines, and runs of >=3 identical consecutive lines (log spam).
//   - No summarization / no reorder. Byte-for-byte preserved inside protected fences;
//     semantically lossless (noise only) outside.
//   - No-op on small input (< MIN_CHARS) and on invalid UTF-8: returns stdin verbatim.
//
// On failure or empty output the CALLER keeps the original prompt (see skill wiring), so
// this can never silently drop the prompt.
//
// Stats are appended as JSONL (auto-rotated at 5MB) to ~/.cache/cc-compress/stats.jsonl.
//
// Usage:  printf '%s' "$prompt" | bun compress-context.ts --skill codex [--guard 900000] [--quiet]

import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const argv = process.argv.slice(2);
const getArg = (name: string, def = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : def;
};
const SKILL = getArg("skill", "unknown");
const GUARD = parseInt(getArg("guard", "0")) || 0; // token threshold to warn about (0 = off)
const QUIET = argv.includes("--quiet");

const MIN_CHARS = 2000; // below this, compression isn't worth it — pass through verbatim
const estTokens = (s: string): number => Math.ceil(s.length / 4);

// Tags whose fenced blocks ARE compressed (everything else tagged is protected).
// Untagged fences (empty info string) are also compressed — they are usually pasted logs.
const COMPRESSIBLE_TAGS = new Set([
  "", "log", "logs", "text", "txt", "console", "output", "out", "term", "terminal",
  "plaintext", "plain", "shell-session", "shellsession", "sh-session", "stacktrace", "trace",
]);

// ANSI/terminal escape stripper. Every alternative is anchored to ESC (\x1b) so it NEVER
// touches bare text. Covers CSI, OSC (consumed to ST/BEL — no leaked URLs), and 2-char Fe.
// A bare \r is also dropped (collapses terminal progress redraws); CRLF is normalized earlier.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;

interface Segment {
  protect: boolean;
  lines: string[];
}

// Fence-aware splitter. Supports ``` and ~~~ fences (>=3 chars), tracks the opening marker
// char + length, and only closes on a bare fence of the SAME char with length >= opening.
// Inner fences (different char, or shorter, or carrying an info string) are treated as
// content, so nested/markdown code blocks stay intact.
const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)/;
const CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function segment(text: string): Segment[] {
  const out: Segment[] = [];
  const lines = text.split("\n");
  let cur: Segment = { protect: false, lines: [] };
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0;

  for (const line of lines) {
    if (inFence) {
      const c = line.match(CLOSE);
      if (c && c[1]![0] === fenceChar && c[1]!.length >= fenceLen) {
        cur.lines.push(line);
        out.push(cur);
        cur = { protect: false, lines: [] };
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      } else {
        cur.lines.push(line); // content inside the open block (incl. inner fences)
      }
      continue;
    }
    const o = line.match(OPEN);
    if (o) {
      const marker = o[1]!;
      const tag = (o[2] ?? "").toLowerCase();
      const protect = !COMPRESSIBLE_TAGS.has(tag);
      if (cur.lines.length) out.push(cur);
      cur = { protect, lines: [line] };
      inFence = true;
      fenceChar = marker[0]!;
      fenceLen = marker.length;
    } else {
      cur.lines.push(line);
    }
  }
  if (cur.lines.length || out.length === 0) out.push(cur);
  return out;
}

function compressLines(lines: string[]): string[] {
  const cleaned = lines.map((l) => l.replace(ANSI, "").replace(/[ \t]+$/g, ""));
  const out: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const line = cleaned[i] ?? "";
    let j = i + 1;
    while (j < cleaned.length && cleaned[j] === line) j++;
    const run = j - i;
    if (line === "") {
      // collapse only runs of >=3 blank lines to a single blank; keep 1-2 as-is
      if (run >= 3) out.push("");
      else for (let k = 0; k < run; k++) out.push("");
    } else if (run >= 3) {
      out.push(line, `  … (${run} identical lines collapsed)`);
    } else {
      for (let k = 0; k < run; k++) out.push(line);
    }
    i = j;
  }
  return out;
}

async function readStdin(): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const c of process.stdin) chunks.push(c as Uint8Array);
  return Buffer.concat(chunks);
}

const buf = await readStdin();

// Fatal UTF-8 decode: on invalid bytes, pass the input through verbatim (no compression),
// so we never corrupt non-text / binary-ish payloads.
let original: string;
try {
  original = new TextDecoder("utf-8", { fatal: true }).decode(buf);
} catch {
  process.stdout.write(buf);
  process.exit(0);
}

// Normalize CRLF -> LF so split/join never produces mixed endings.
const normalized = original.replace(/\r\n/g, "\n");

let result = normalized;
if (normalized.length >= MIN_CHARS) {
  result = segment(normalized)
    .map((s) => (s.protect ? s.lines.join("\n") : compressLines(s.lines).join("\n")))
    .join("\n");
}

process.stdout.write(result);

// ---- stats (best-effort, never fatal; auto-rotate at 5MB) ----
const origTok = estTokens(normalized);
const compTok = estTokens(result);
const savedPct = origTok > 0 ? Math.round((1 - compTok / origTok) * 1000) / 10 : 0;
try {
  const dir = join(homedir(), ".cache", "cc-compress");
  mkdirSync(dir, { recursive: true });
  const statsPath = join(dir, "stats.jsonl");
  try {
    if (statSync(statsPath).size > 5 * 1024 * 1024) writeFileSync(statsPath, "");
  } catch {
    /* file may not exist yet */
  }
  appendFileSync(
    statsPath,
    JSON.stringify({
      ts: new Date().toISOString(),
      skill: SKILL,
      orig_chars: normalized.length,
      comp_chars: result.length,
      orig_tok: origTok,
      comp_tok: compTok,
      saved_pct: savedPct,
      compressed: normalized.length >= MIN_CHARS,
    }) + "\n",
  );
} catch {
  /* ignore */
}
if (!QUIET && normalized.length >= MIN_CHARS) {
  process.stderr.write(`[cc-compress:${SKILL}] ${origTok} → ${compTok} tok (-${savedPct}%)\n`);
}
if (GUARD > 0 && compTok > GUARD) {
  process.stderr.write(
    `[cc-compress:${SKILL}] ⚠ still ${compTok} tok > guard ${GUARD} — large input, consider chunking (Level B)\n`,
  );
}
