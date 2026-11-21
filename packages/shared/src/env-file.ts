import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseDotenv } from "dotenv";

export type EnvValueEncoding = "minimal" | "json";

export type UpdateEnvFileContentsOptions = {
  valueEncoding?: EnvValueEncoding;
};

type EnvLine = {
  contents: string;
  ending: string;
};

const ENV_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;
// dotenv's opener class, including dotted, digit-led, hyphenated and colon
// assignments the writer does not manage. A quoted span opened by one of
// these must still be grouped, or a later rewrite plants a hidden line as
// a loadable key.
const LOADER_ASSIGNMENT_PATTERN = /^(\s*(?:export\s+)?)([\w.-]+)(\s*=\s*|:\s+)(.*)$/;
const MINIMAL_ENV_VALUE_PATTERN = /^[A-Za-z0-9_./:@-]+$/;

export function encodeEnvValue(value: string, encoding: EnvValueEncoding = "json"): string {
  if (encoding === "minimal" && MINIMAL_ENV_VALUE_PATTERN.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

// Encodes a value the loader reads back exactly. The default encoding is
// kept whenever it round-trips through dotenv; a value it mangles (a
// double quote, a backslash, a tab) falls back to a literal single-quoted
// form when that round-trips instead.
function encodeValueForLoader(value: string, encoding: EnvValueEncoding): string {
  const candidate = encodeEnvValue(value, encoding);
  if (ownValue(parseDotenv(`__WRITER_KEY__=${candidate}`), "__WRITER_KEY__") === value) {
    return candidate;
  }
  if (!value.includes("'") && !/[\r\n]/.test(value)) {
    const singleQuoted = `'${value}'`;
    if (ownValue(parseDotenv(`__WRITER_KEY__=${singleQuoted}`), "__WRITER_KEY__") === value) {
      return singleQuoted;
    }
  }
  return candidate;
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

function naiveClosingLine(lines: EnvLine[], start: number, quote: EnvQuote, startOffset: number): number {
  for (let index = start; index < lines.length; index += 1) {
    const text = index === start ? lines[index].contents.slice(startOffset) : lines[index].contents;
    if (text.includes(quote)) return index;
  }
  return -1;
}

// Groups physical lines into logical assignments. A quoted value may span
// physical lines; its continuation lines are part of the same assignment
// and must never be treated as assignments of their own.
function groupEnvSegments(lines: EnvLine[]): EnvSegment[] {
  const segments: EnvSegment[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const canonical = lines[index].contents.match(ENV_ASSIGNMENT_PATTERN);
    const match = canonical ?? lines[index].contents.match(LOADER_ASSIGNMENT_PATTERN);
    if (!match) {
      segments.push({ key: null, start: index, end: index, quoted: false, quoteClosed: true });
      continue;
    }

    // Non-canonical openers are preserved, never rewritten. Grouping them
    // still keeps their continuation lines from being treated as keys.
    const key = canonical ? canonical[2] : null;
    const rawValue = match[4];

    // The loader allows whitespace (including newlines) between the
    // separator and a quoted value, so the opening quote may sit on a
    // following line. That whole span belongs to this assignment.
    if (rawValue.trim() === "") {
      let openingLine = index + 1;
      while (openingLine < lines.length && lines[openingLine].contents.trim() === "") {
        openingLine += 1;
      }
      const openingContents = openingLine < lines.length ? lines[openingLine].contents : "";
      const openingStart = openingContents.length - openingContents.trimStart().length;
      const openingQuote = openingContents[openingStart] as EnvQuote | undefined;
      if (openingQuote === '"' || openingQuote === "'" || openingQuote === "`") {
        if (closingQuoteIndex(openingContents, openingQuote, openingStart + 1) !== null) {
          segments.push({ key, start: index, end: openingLine, quoted: true, quoteClosed: true });
          index = openingLine;
          continue;
        }
        let end = lines.length - 1;
        let quoteClosed = false;
        for (let next = openingLine + 1; next < lines.length; next += 1) {
          if (closingQuoteIndex(lines[next].contents, openingQuote, 0) !== null) {
            end = next;
            quoteClosed = true;
            break;
          }
        }
        segments.push({ key, start: index, end, quoted: true, quoteClosed });
        index = end;
        continue;
      }
    }

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
    if (!quoteClosed) {
      // The loader's regex backtracks when no later quote exists: a quote
      // immediately after a backslash on the opening line itself then
      // closes the value (for example `NOTE='cache\'`).
      const openingInLine = lines[index].contents.length - rawValue.length + valueStart;
      const naive = naiveClosingLine(lines, index, quote, openingInLine + 1);
      if (naive === index) {
        segments.push({ key, start: index, end: index, quoted: true, quoteClosed: true });
        continue;
      }
      if (naive > index) {
        end = naive;
        quoteClosed = true;
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
function ownValue(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function unclosedQuoteInLine(text: string): boolean {
  let quote: EnvQuote | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\" && text[index + 1] === quote) {
        index += 1;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") quote = character;
  }
  return quote !== null;
}

// The loader (dotenv) is the oracle for what a file means. The writer's
// own segmentation only understands canonical `KEY=` openers, so any key
// or decoded value dotenv sees that the segmentation cannot account for
// makes the file ambiguous for this writer: refuse instead of guessing.
// A single-line assignment in an opener spelling the writer does not
// manage (dotted, hyphenated or digit-led keys, colon assignments) is
// unmanaged-but-understood when the loader's value for the whole file
// equals the value that line alone decodes to: it is preserved as-is.
function assertLoaderAgreement(
  parsedByLoader: Record<string, string>,
  lines: EnvLine[],
  segments: EnvSegment[],
  entries: Record<string, string>,
): void {
  const accounted = new Map<string, string | undefined>();
  for (const segment of segments) {
    if (!segment.key) continue;
    const segmentText = lines
      .slice(segment.start, segment.end + 1)
      .map((line) => line.contents)
      .join("\n");
    accounted.set(segment.key, ownValue(parseDotenv(segmentText), segment.key));
  }

  const understood = new Map<string, string>();
  for (const line of lines) {
    if (unclosedQuoteInLine(line.contents)) continue;
    for (const [key, value] of Object.entries(parseDotenv(line.contents))) {
      understood.set(key, value);
    }
  }

  for (const [key, value] of Object.entries(parsedByLoader)) {
    if (accounted.has(key)) {
      if (accounted.get(key) !== value) {
        throw new Error(
          `Refusing to update env file: writer and loader disagree on the value of ${key}`,
        );
      }
      continue;
    }
    if (!Object.hasOwn(entries, key) && understood.get(key) === value) continue;
    throw new Error(
      `Refusing to update env file: loader key ${key} has no canonical assignment the writer understands`,
    );
  }
}

function assertRewriteMatchesLoader(
  inputParsed: Record<string, string>,
  output: string,
  entries: Record<string, string>,
): void {
  const outputParsed = parseDotenv(output);
  const expectedKeys = new Set([...Object.keys(inputParsed), ...Object.keys(entries)]);

  for (const key of Object.keys(outputParsed)) {
    if (!expectedKeys.has(key)) {
      throw new Error(`Refusing to update env file: rewrite would add loader key ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(outputParsed, key)) {
      throw new Error(`Refusing to update env file: rewrite would drop loader key ${key}`);
    }
  }
  for (const [key, value] of Object.entries(outputParsed)) {
    const expected = Object.hasOwn(entries, key) ? entries[key] : ownValue(inputParsed, key);
    if (value !== expected) {
      throw new Error(`Refusing to update env file: rewrite would change loader value of ${key}`);
    }
  }
}

export function updateEnvFileContents(
  contents: string,
  entries: Record<string, string>,
  options: UpdateEnvFileContentsOptions = {},
): string {
  const valueEncoding = options.valueEncoding ?? "json";
  const missingEntries = new Map(Object.entries(entries));
  if (/\r(?!\n)/.test(contents)) {
    throw new Error("Refusing to update env file: bare carriage return in env file");
  }
  const lines = splitEnvLines(contents);
  const segments = groupEnvSegments(lines);
  const parsedByLoader = parseDotenv(contents);
  assertLoaderAgreement(parsedByLoader, lines, segments, entries);

  for (const segment of segments) {
    if (segment.quoted && !segment.quoteClosed) {
      throw new Error(
        `Refusing to update env file: ${segment.key ?? "assignment"} has an unterminated quoted value`,
      );
    }
    if (!segment.key || !Object.hasOwn(entries, segment.key)) continue;
    if (segment.end > segment.start) {
      throw new Error(
        `Refusing to update env file: ${segment.key} has a quoted value spanning multiple lines`,
      );
    }
  }

  for (const segment of segments) {
    if (segment.end > segment.start || !segment.key) continue;

    const line = lines[segment.start];
    const match = line.contents.match(ENV_ASSIGNMENT_PATTERN);
    if (!match) continue;

    const [, prefix, key, separator, rawValue] = match;
    if (!Object.hasOwn(entries, key)) continue;
    const value = entries[key];
    if (value === undefined) continue;

    missingEntries.delete(key);
    if (parseComparableEnvValue(rawValue) === value) continue;

    const commentStart = trailingEnvCommentStart(rawValue);
    const trailingComment = commentStart === null ? "" : rawValue.slice(commentStart);
    line.contents = `${prefix}${key}${separator}${encodeValueForLoader(value, valueEncoding)}${trailingComment}`;
  }

  if (missingEntries.size > 0) {
    const newline = lines.find((line) => line.ending.length > 0)?.ending ?? "\n";
    const insertedLines = Array.from(missingEntries, ([key, value]) => ({
      contents: `${key}=${encodeValueForLoader(value, valueEncoding)}`,
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

  const output = lines.map((line) => `${line.contents}${line.ending}`).join("");
  assertRewriteMatchesLoader(parsedByLoader, output, entries);
  return output;
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

  // Remove temp orphans left by a writer process that is no longer alive
  // (a SIGKILL between temp write and rename). A live writer's temp, and
  // this process's own, are never touched.
  const temporaryPrefix = `.${path.basename(filePath)}.`;
  try {
    for (const entry of fs.readdirSync(directory)) {
      if (!entry.startsWith(temporaryPrefix) || !entry.endsWith(".tmp")) continue;
      const ownerPid = Number(entry.slice(temporaryPrefix.length).split(".")[0]);
      if (!Number.isInteger(ownerPid) || ownerPid === process.pid) continue;
      try {
        process.kill(ownerPid, 0);
      } catch (error) {
        // EPERM means the pid is alive and owned by someone else. Only a
        // missing process (ESRCH) is a dead writer's orphan.
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") continue;
        try {
          fs.unlinkSync(path.join(directory, entry));
        } catch {
          // The orphan may already have been renamed or removed.
        }
      }
    }
  } catch {
    // Cleanup is best-effort and never blocks the write itself.
  }

  const temporaryPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    // The temp file is created with mode 600 at open time; the rename keeps
    // that mode, so no post-rename chmod is needed.
    fs.writeFileSync(temporaryPath, nextContents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
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
