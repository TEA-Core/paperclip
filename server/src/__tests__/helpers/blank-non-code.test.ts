import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { blankNonCode } from "./blank-non-code.js";

/** The code-only view with whitespace runs collapsed, so expectations stay readable. */
function compact(source: string): string {
  return blankNonCode(source).replace(/\s+/g, " ").trim();
}

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** Net nesting depth of `{`, `(` and `[` in a code-only view; -1 on the first underflow. */
function nestingDepths(code: string): { brace: number; paren: number; bracket: number } {
  const depth = { brace: 0, paren: 0, bracket: 0 };
  for (const c of code) {
    if (c === "{") depth.brace++;
    else if (c === "}") depth.brace--;
    else if (c === "(") depth.paren++;
    else if (c === ")") depth.paren--;
    else if (c === "[") depth.bracket++;
    else if (c === "]") depth.bracket--;
    if (depth.brace < 0 || depth.paren < 0 || depth.bracket < 0) {
      return { brace: -1, paren: -1, bracket: -1 };
    }
  }
  return depth;
}

describe("blankNonCode", () => {
  it("keeps length and line breaks so indexes and line numbers map back", () => {
    const source = "const a = 'x\\'y'; // note\n/* a\nb */ const b = `t${a}\nu`;\n";
    const code = blankNonCode(source);
    expect(code).toHaveLength(source.length);
    expect(code.split("\n")).toHaveLength(source.split("\n").length);
    expect(code).toContain("const a =");
    expect(code).toContain("const b =");
    expect(code).not.toContain("note");
  });

  it("blanks a regex literal that holds a quote or a backtick, and keeps the code after it", () => {
    expect(compact("x.replace(/[`'\"]/g, ' '); live();")).toBe("x.replace( , ); live();");
    expect(compact("const r = /a\\/b/gi; live();")).toBe("const r = ; live();");
    expect(compact("const r = /[/]/; live();")).toBe("const r = ; live();");
  });

  it("treats a slash after an operand as division, not a regex", () => {
    expect(compact("const h = a / b / c; live();")).toBe("const h = a / b / c; live();");
    expect(compact("const h = (a + 1) / 2 / n; live();")).toBe("const h = (a + 1) / 2 / n; live();");
    expect(compact("const h = xs[0] / 2; live();")).toBe("const h = xs[0] / 2; live();");
  });

  it("treats a slash after a keyword or operator as a regex", () => {
    expect(compact("return /'/.test(s); live();")).toBe("return .test(s); live();");
    expect(compact("if (!/'/.test(s)) live();")).toBe("if (! .test(s)) live();");
  });

  // CodeRabbit on PR 1208. Each case below made the lexer lose sync, so a guard went blind.
  it("treats `of` as a name outside a for...of header", () => {
    expect(compact("const of = 12; const n = of / (dbOrTx === db ? 1 : 2) / 3;")).toBe(
      "const of = 12; const n = of / (dbOrTx === db ? 1 : 2) / 3;",
    );
    expect(compact("for (const x of /'/.exec(s)) live(); after();")).toBe("for (const x of .exec(s)) live(); after();");
  });

  it("reads a slash after an if, while or for header as a regex, and after any other parenthesis as division", () => {
    expect(compact("if (ok) /`/.test(s);\nif (dbOrTx === db) {}")).toBe("if (ok) .test(s); if (dbOrTx === db) {}");
    expect(compact("while (go) /'/.test(s); live();")).toBe("while (go) .test(s); live();");
    expect(compact("for (;;) /'/.test(s); live();")).toBe("for (;;) .test(s); live();");
    expect(compact("const h = f(a) / (dbOrTx === db ? 1 : 2) / 3;")).toBe("const h = f(a) / (dbOrTx === db ? 1 : 2) / 3;");
    expect(compact("if (ok) { x = (a) / b / c; }")).toBe("if (ok) { x = (a) / b / c; }");
  });

  it("reads a slash after a postfix ++ or -- as division", () => {
    expect(compact("count++ / (dbOrTx === db ? 1 : 2) / 3;")).toBe("count++ / (dbOrTx === db ? 1 : 2) / 3;");
    expect(compact("const h = xs[i]-- / 2 / 3; live();")).toBe("const h = xs[i]-- / 2 / 3; live();");
    expect(compact("x = ++n / 2 / 3; live();")).toBe("x = ++n / 2 / 3; live();");
    expect(compact("x = a + +/'/.test(s); live();")).toBe("x = a + + .test(s); live();");
  });

  it("keeps substitution code live and blanks template text, including nested templates", () => {
    expect(compact("`a ${live(1)} b`;")).toBe("live(1) ;");
    expect(compact("`${k ?? `n:${id}`}:x`; after();")).toBe("k ?? id ; after();");
    expect(compact("`${ {a: `}`}.a }`; after();")).toBe("{a: }.a ; after();");
  });

  it("blanks comments and plain strings", () => {
    expect(compact("a(); // c `\nb();")).toBe("a(); b();");
    expect(compact("a(); /* ' */ b();")).toBe("a(); b();");
    expect(compact("a('//', \"/*\"); b();")).toBe("a( , ); b();");
  });

  it("stays in sync across every source file the repo's source-text guards scan", () => {
    const offenders: string[] = [];
    for (const sub of ["routes", "services", "modules", "middleware"]) {
      for (const file of listTsFiles(path.join(srcRoot, sub))) {
        const depth = nestingDepths(blankNonCode(readFileSync(file, "utf-8")));
        if (depth.brace !== 0 || depth.paren !== 0 || depth.bracket !== 0) {
          offenders.push(path.relative(srcRoot, file));
        }
      }
    }
    expect(
      offenders,
      "These files leave unbalanced brackets in the code-only view: the lexer lost sync, so the source-text guards are blind past that point.",
    ).toEqual([]);
  });
});
