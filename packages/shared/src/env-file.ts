import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type EnvValueEncoding = "minimal" | "json";

export type UpdateEnvFileContentsOptions = {
  valueEncoding?: EnvValueEncoding;
};

type EnvLine = {
  contents: string;
  ending: string;
};

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
const MINIMAL_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]+$/;

export function encodeEnvValue(value: string, encoding: EnvValueEncoding = "json"): string {
  if (encoding === "minimal" && MINIMAL_ENV_VALUE_PATTERN.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function trailingEnvCommentStart(rawValue: string): number | null {
  let quote: "\"" | "'" | null = null;
  let escaped = false;

  for (let index = 0; index < rawValue.length; index += 1) {
    const character = rawValue[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "\"" && character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    // dotenv treats every unquoted # as the start of a comment, even when it
    // immediately follows the assignment separator or the value.
    if (character !== "#") continue;

    let commentStart = index;
    while (commentStart > 0 && /\s/.test(rawValue[commentStart - 1] ?? "")) {
      commentStart -= 1;
    }
    return commentStart;
  }

  return null;
}

function parseComparableEnvValue(rawValue: string): string | null {
  const commentStart = trailingEnvCommentStart(rawValue);
  const encodedValue = rawValue.slice(0, commentStart ?? rawValue.length).trim();

  if (encodedValue === "") return "";
  if (encodedValue.startsWith("\"") && encodedValue.endsWith("\"")) {
    try {
      const parsed = JSON.parse(encodedValue);
      return typeof parsed === "string" ? parsed : null;
    } catch {
      return null;
    }
  }
  if (encodedValue.startsWith("'") && encodedValue.endsWith("'")) {
    return encodedValue.slice(1, -1);
  }
  return encodedValue;
}

type EnvQuote = '"' | "'" | "`";

function closingQuoteIndex(text: string, quote: EnvQuote, start: number): number | null {
  for (let index = start; index < text.length; index += 1) {
    // dotenv's lexer treats a backslash immediately before the quote as an
    // escaped quote for single, double and backtick quotes alike.
    if (text[index] === "\\" && text[index + 1] === quote) {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return null;
}

type EnvSegment = {
  key: string | null;
  start: number;
  end: number;
  quoted: boolean;
  quoteClosed: boolean;
};

// Groups physical lines into logical assignments. A quoted value may span
// physical lines; its continuation lines are part of the same assignment
// and must never be treated as assignments of their own.
function groupEnvSegments(lines: EnvLine[]): EnvSegment[] {
  const segments: EnvSegment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].contents.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) {
      segments.push({ key: null, start: index, end: index, quoted: false, quoteClosed: true });
      continue;
    }

    const [, , key, , rawValue] = match;
    const valueStart = rawValue.length - rawValue.trimStart().length;
    const quote = rawValue[valueStart] as EnvQuote | undefined;
    if (quote !== '"' && quote !== "'" && quote !== "`") {
      segments.push({ key, start: index, end: index, quoted: false, quoteClosed: true });
      continue;
    }

    if (closingQuoteIndex(rawValue, quote, valueStart + 1) !== null) {
      segments.push({ key, start: index, end: index, quoted: true, quoteClosed: true });
      continue;
    }

    let end = lines.length - 1;
    let quoteClosed = false;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (closingQuoteIndex(lines[next].contents, quote, 0) !== null) {
        end = next;
        quoteClosed = true;
        break;
      }
    }
    segments.push({ key, start: index, end, quoted: true, quoteClosed });
    index = end;
  }

  return segments;
}

function splitEnvLines(contents: string): EnvLine[] {
  const lines: EnvLine[] = [];
  const newlinePattern = /\r\n|\n|\r/g;
  let lineStart = 0;
  let match: RegExpExecArray | null;

  while ((match = newlinePattern.exec(contents)) !== null) {
    lines.push({
      contents: contents.slice(lineStart, match.index),
      ending: match[0],
    });
    lineStart = newlinePattern.lastIndex;
  }

  if (lineStart < contents.length || contents.length === 0) {
    lines.push({ contents: contents.slice(lineStart), ending: "" });
  }

  return lines;
}

/**
 * Updates only the named assignments and preserves every unrelated byte.
 *
 * Duplicate managed keys are intentional: every occurrence is checked and any
 * stale occurrence is updated. Occurrences that already decode to the desired
 * value retain their original quoting and spacing.
 *
 * Refuses (throws, leaving the caller's file untouched) when a named
 * assignment has a quoted value spanning multiple physical lines, or an
 * unterminated quote: rewriting only the first physical line would leave
 * the continuation behind as a top-level assignment. Continuation lines of
 * unmanaged multiline values are preserved and never matched as keys.
 */
export function updateEnvFileContents(
  contents: string,
  entries: Record<string, string>,
  options: UpdateEnvFileContentsOptions = {},
): string {
  const valueEncoding = options.valueEncoding ?? "json";
  const missingEntries = new Map(Object.entries(entries));
  const lines = splitEnvLines(contents);
  const segments = groupEnvSegments(lines);

  for (const segment of segments) {
    if (!segment.key || entries[segment.key] === undefined) continue;
    if (segment.end > segment.start) {
      throw new Error(
        `Refusing to update env file: ${segment.key} has a quoted value spanning multiple lines`,
      );
    }
    if (segment.quoted && !segment.quoteClosed) {
      throw new Error(
        `Refusing to update env file: ${segment.key} has an unterminated quoted value`,
      );
    }
  }

  for (const segment of segments) {
    if (segment.end > segment.start || !segment.key) continue;

    const line = lines[segment.start];
    const match = line.contents.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) continue;

    const [, prefix, key, separator, rawValue] = match;
    const value = entries[key];
    if (value === undefined) continue;

    missingEntries.delete(key);
    if (parseComparableEnvValue(rawValue) === value) continue;

    const commentStart = trailingEnvCommentStart(rawValue);
    const trailingComment = commentStart === null ? "" : rawValue.slice(commentStart);
    line.contents = `${prefix}${key}${separator}${encodeEnvValue(value, valueEncoding)}${trailingComment}`;
  }

  if (missingEntries.size > 0) {
    const newline = lines.find((line) => line.ending.length > 0)?.ending ?? "\n";
    const insertedLines = Array.from(missingEntries, ([key, value]) => ({
      contents: `${key}=${encodeEnvValue(value, valueEncoding)}`,
      ending: newline,
    }));
    const trailingBlankIndex = lines.at(-1)?.contents === "" ? lines.length - 1 : lines.length;

    if (trailingBlankIndex === lines.length && lines.length > 0) {
      const previousLine = lines.at(-1)!;
      if (previousLine.ending === "") {
        previousLine.ending = newline;
        insertedLines.at(-1)!.ending = "";
      }
    }
    lines.splice(trailingBlankIndex, 0, ...insertedLines);
  }

  return lines.map((line) => `${line.contents}${line.ending}`).join("");
}

/** Writes a changed env file through a same-directory temporary file and rename. */
export function writeEnvFileAtomicallyIfChanged(
  filePath: string,
  previousContents: string | null,
  nextContents: string,
): boolean {
  if (previousContents === nextContents) return false;

  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    fs.writeFileSync(temporaryPath, nextContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }

  return true;
}
