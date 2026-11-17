/**
 * Source-scan helper shared by the repo's source-text guards
 * (`no-tx-identity-discriminator.test.ts`, `activity-log-board-api-key-guard.test.ts`).
 *
 * `blankNonCode` returns a string of the SAME length and with the SAME line
 * breaks as `source`, in which every comment, string literal, template-literal
 * text part and regular-expression literal is replaced by spaces (including its
 * delimiters). Code inside a template `${ ... }` substitution stays visible and
 * the `${` / `}` pair is blanked, so braces stay balanced in the result. Index
 * arithmetic and line numbers computed on the result therefore map straight back
 * onto the original file.
 *
 * Why this is a real lexer and not a quote-pairing loop: a scanner that only
 * pairs quote characters loses sync on two shapes that are common in this repo.
 * A regular-expression literal that contains a quote character
 * (`/[\r\n*_`<>]/g`) opens a phantom string, and a nested template
 * (`${a ?? `b`}`) closes the outer template early. After either, every later
 * "string" is read as code and every later "code" as a string, so the scan is
 * blind to the rest of the file.
 */

/** Keywords after which a `/` starts a regular expression, not a division. */
export const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "delete",
  "void",
  "throw",
  "in",
  "instanceof",
  "new",
  "else",
  "do",
  "yield",
  "await",
]);

/** Punctuation after which a `/` starts a regular expression. `control)` closes an `if`/`while`/`for` header. */
const REGEX_PRECEDING_PUNCTUATION = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "<", ">", "~", "^", "control)", "...",
]);

const CONTROL_KEYWORDS = new Set(["if", "while", "with"]);

function isIdentifierChar(c: string | undefined): boolean {
  return c !== undefined && /[A-Za-z0-9_$]/.test(c);
}

export function blankNonCode(source: string): string {
  const out = source.split("");
  const n = source.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  // One entry per open `{` in code: "tpl" for a template `${`, "brace" otherwise.
  const braces: Array<"tpl" | "brace"> = [];
  // The last significant code token, to tell a regex from a division.
  let prevPunctuation: string | null = null;
  let prevWord: string | null = null;
  // One entry per open `(`: the kind of header it belongs to.
  const parens: Array<"for" | "control" | "plain"> = [];

  /** Blank a template text part starting after a backtick or `}`; returns the next index. */
  const scanTemplateText = (start: number): number => {
    let i = start;
    while (i < n) {
      const c = source[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(start - 1, i + 1);
        return i + 1;
      }
      if (c === "$" && source[i + 1] === "{") {
        blank(start - 1, i + 2);
        braces.push("tpl");
        return i + 2;
      }
      i++;
    }
    blank(start - 1, n);
    return n;
  };

  const setPunctuation = (c: string) => {
    prevPunctuation = c;
    prevWord = null;
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const j = end < 0 ? n : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") {
        j += source[j] === "\\" ? 2 : 1;
      }
      const end = j < n && source[j] === c ? j + 1 : j;
      blank(i, end);
      i = end;
      prevPunctuation = null;
      prevWord = "string";
      continue;
    }
    if (c === "`") {
      i = scanTemplateText(i + 1);
      // A completed template is an operand; an opened `${` starts an expression.
      if (braces[braces.length - 1] === "tpl" && source[i - 1] === "{") {
        setPunctuation("{");
      } else {
        prevPunctuation = null;
        prevWord = "template";
      }
      continue;
    }
    if (c === "{") {
      braces.push("brace");
      setPunctuation("{");
      i++;
      continue;
    }
    if (c === "}") {
      const closed = braces.pop();
      if (closed === "tpl") {
        // End of a `${ ... }` substitution: resume the enclosing template text.
        out[i] = " ";
        i = scanTemplateText(i + 1);
        if (braces[braces.length - 1] === "tpl" && source[i - 1] === "{") {
          setPunctuation("{");
        } else {
          prevPunctuation = null;
          prevWord = "template";
        }
      } else {
        setPunctuation("}");
        i++;
      }
      continue;
    }
    if (c === "/") {
      const regexAllowed =
        (prevPunctuation === null && prevWord === null) ||
        (prevPunctuation !== null && REGEX_PRECEDING_PUNCTUATION.has(prevPunctuation)) ||
        (prevWord !== null && REGEX_PRECEDING_KEYWORDS.has(prevWord)) ||
        // `of` is a keyword only in a `for (... of ...)` header; elsewhere it is a name.
        (prevWord === "of" && parens[parens.length - 1] === "for");
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < n && source[j] !== "\n") {
          const rc = source[j];
          if (rc === "\\") {
            j += 2;
            continue;
          }
          if (rc === "[") inClass = true;
          else if (rc === "]") inClass = false;
          else if (rc === "/" && !inClass) {
            closed = true;
            j++;
            break;
          }
          j++;
        }
        if (closed) {
          while (j < n && isIdentifierChar(source[j])) j++;
          blank(i, j);
          i = j;
          prevPunctuation = null;
          prevWord = "regex";
          continue;
        }
      }
      setPunctuation("/");
      i++;
      continue;
    }
    if (isIdentifierChar(c)) {
      let j = i;
      while (j < n && isIdentifierChar(source[j])) j++;
      // A word after `.` or `?.` is a property name, so it is an operand even when it spells a
      // keyword: `obj.of / x` and `obj?.await / x` divide.
      prevWord = prevPunctuation === "." ? `.${source.slice(i, j)}` : source.slice(i, j);
      prevPunctuation = null;
      i = j;
      continue;
    }
    if (c === "(") {
      // The header of `if (...)`, `while (...)`, `for (...)` and `with (...)` is not an
      // operand: a `/` after its closing parenthesis starts a regex statement.
      const control = prevWord === "for" ? "for" : prevWord !== null && CONTROL_KEYWORDS.has(prevWord) ? "control" : "plain";
      parens.push(control);
      setPunctuation("(");
      i++;
      continue;
    }
    if (c === ")") {
      // A plain `)` ends an operand, so a following `/` is a division.
      const closed = parens.pop();
      prevPunctuation = closed === "for" || closed === "control" ? "control)" : ")";
      prevWord = null;
      i++;
      continue;
    }
    if (c === "]") {
      prevPunctuation = c;
      prevWord = null;
      i++;
      continue;
    }
    if ((c === "+" || c === "-") && next === c) {
      // `x++ / y` is a division, so a postfix operator keeps the operand. A prefix `++x`
      // is always followed by an operand, which sets the state again, so one rule fits both.
      prevPunctuation = ")";
      prevWord = null;
      i += 2;
      continue;
    }
    if (c === "!" && ((prevWord !== null && !REGEX_PRECEDING_KEYWORDS.has(prevWord)) || prevPunctuation === ")" || prevPunctuation === "]")) {
      // TypeScript's non-null assertion (`x! / y`) keeps the operand, so a slash divides. In
      // `x != y` the `=` that follows sets the state again, so no special case is needed.
      prevPunctuation = ")";
      prevWord = null;
      i++;
      continue;
    }
    if (c === "." && source.startsWith("...", i)) {
      // A spread is not a property access: `...of / 2` reads `of` as a name, `.../re/` as a regex.
      setPunctuation("...");
      i += 3;
      continue;
    }
    if (c !== " " && c !== "\t" && c !== "\n" && c !== "\r") {
      setPunctuation(c);
    }
    i++;
  }
  return out.join("");
}
