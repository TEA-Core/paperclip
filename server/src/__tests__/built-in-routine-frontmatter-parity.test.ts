import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatterMarkdown } from "@paperclipai/shared/frontmatter";
import { ROUTINE_VARIABLE_TYPES } from "@paperclipai/shared";
import { listBuiltInAgentDefinitions } from "../services/built-in-agents.js";

/**
 * Parity between a built-in routine's markdown frontmatter and the inline
 * `variables` array in built-in-agents.ts (SUP-13905).
 *
 * WHY THIS EXISTS: the markdown is loaded with readBuiltInText() and embedded as
 * TEXT — it becomes the routine's prompt body. Its YAML frontmatter is never
 * parsed by the server, so nothing validated it and nothing compared it to the
 * inline array that actually defines the variables. The two drifted silently:
 *
 *   - recent-agent-reflection.md declared `type: string`, which is not a member
 *     of ROUTINE_VARIABLE_TYPES. Two separate agents "aligned the code with the
 *     doc", faithfully copied that value, and produced a tree that does not
 *     compile (TS2322) — the doc was the thing leading them off the cliff.
 *   - The same routine's inline options were `recent_active | recent_blocked |
 *     recent_completed` while the prompt branches on `recent_active | all |
 *     explicit`. Two documented modes were unselectable and two selectable modes
 *     were described nowhere. recent_blocked/recent_completed appeared in that
 *     one array and nowhere else in the tree — they were never implemented.
 *   - refresh-stale-summaries drifted on `required` alone.
 *
 * A type error only catches an invalid `type:`. It cannot catch options, labels,
 * defaults, or required flags going out of sync, and it cannot catch the invalid
 * value while it sits in the markdown. Hence this test.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const BUILT_INS_DIR = path.resolve(moduleDir, "../built-ins/agents");

interface DiscoveredRoutineDoc {
  agentDir: string;
  relativePath: string;
  absolutePath: string;
}

function discoverRoutineDocs(): DiscoveredRoutineDoc[] {
  const docs: DiscoveredRoutineDoc[] = [];
  for (const agentDir of fs.readdirSync(BUILT_INS_DIR)) {
    const routinesDir = path.join(BUILT_INS_DIR, agentDir, "routines");
    if (!fs.existsSync(routinesDir)) continue;
    for (const file of fs.readdirSync(routinesDir)) {
      if (!file.endsWith(".md")) continue;
      docs.push({
        agentDir,
        relativePath: path.join(agentDir, "routines", file),
        absolutePath: path.join(routinesDir, file),
      });
    }
  }
  return docs.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

const routineDocs = discoverRoutineDocs();

/**
 * Normalize a frontmatter variable entry into the RoutineVariable shape the
 * inline array uses, so the two are comparable field-for-field. Deliberately
 * does NOT coerce `type` — an invalid type must survive to be asserted on.
 */
function normalizeDocVariable(raw: unknown) {
  const entry = (raw ?? {}) as Record<string, unknown>;
  return {
    name: entry.name,
    label: entry.label ?? null,
    type: entry.type,
    defaultValue: entry.defaultValue ?? null,
    required: entry.required ?? false,
    options: Array.isArray(entry.options) ? entry.options : [],
  };
}

function normalizeCodeVariable(entry: {
  name: string;
  label: string | null;
  type: string;
  defaultValue: string | number | boolean | null;
  required: boolean;
  options: string[];
}) {
  return {
    name: entry.name,
    label: entry.label ?? null,
    type: entry.type,
    // "" and null both mean "no default"; the markdown cannot express the
    // distinction cleanly, so compare them as equivalent.
    defaultValue: entry.defaultValue === "" ? null : entry.defaultValue,
    required: entry.required,
    options: entry.options,
  };
}

function normalizeDocVariableForCompare(raw: unknown) {
  const normalized = normalizeDocVariable(raw);
  return {
    ...normalized,
    defaultValue: normalized.defaultValue === "" ? null : normalized.defaultValue,
  };
}

describe("built-in routine markdown/code parity", () => {
  it("discovers every built-in routine markdown doc", () => {
    // Guards the guard: if the directory layout moves, the loops below would
    // silently assert nothing and this suite would pass while covering nothing.
    expect(routineDocs.length).toBeGreaterThan(0);
    expect(routineDocs.map((doc) => doc.relativePath)).toContain(
      path.join("reflection-coach", "routines", "recent-agent-reflection.md"),
    );
  });

  it.each(routineDocs.map((doc) => [doc.relativePath, doc] as const))(
    "%s declares only valid routine variable types",
    (_label, doc) => {
      const { frontmatter } = parseFrontmatterMarkdown(fs.readFileSync(doc.absolutePath, "utf8"));
      const variables = frontmatter.variables;
      expect(Array.isArray(variables), `${doc.relativePath} has no variables list`).toBe(true);

      for (const variable of variables as unknown[]) {
        const normalized = normalizeDocVariable(variable);
        expect(
          ROUTINE_VARIABLE_TYPES,
          `${doc.relativePath}: variable "${String(normalized.name)}" declares type `
            + `"${String(normalized.type)}", which is not a RoutineVariableType. `
            + "An agent told this doc is the source of truth will copy it into "
            + "built-in-agents.ts and break the build.",
        ).toContain(normalized.type as (typeof ROUTINE_VARIABLE_TYPES)[number]);
      }
    },
  );

  it.each(routineDocs.map((doc) => [doc.relativePath, doc] as const))(
    "%s frontmatter matches the inline variables array",
    (_label, doc) => {
      const { frontmatter } = parseFrontmatterMarkdown(fs.readFileSync(doc.absolutePath, "utf8"));
      const routineKey = frontmatter.routineKey;
      expect(typeof routineKey, `${doc.relativePath} has no routineKey`).toBe("string");

      const definition = listBuiltInAgentDefinitions()
        .find((candidate) => candidate.bundle?.routine.routineKey === routineKey);
      expect(definition, `no built-in agent defines routine "${String(routineKey)}"`).toBeDefined();

      const codeVariables = definition!.bundle!.routine.variables.map(normalizeCodeVariable);
      const docVariables = (frontmatter.variables as unknown[]).map(normalizeDocVariableForCompare);

      expect(docVariables).toEqual(codeVariables);
    },
  );

  it("keeps every inline variable type valid too", () => {
    for (const definition of listBuiltInAgentDefinitions()) {
      for (const variable of definition.bundle?.routine.variables ?? []) {
        expect(
          ROUTINE_VARIABLE_TYPES,
          `${definition.key}: inline variable "${variable.name}" has type "${variable.type}"`,
        ).toContain(variable.type);
      }
    }
  });
});
