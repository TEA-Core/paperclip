import { describe, expect, it } from "vitest";
import { encodeEnvValue, updateEnvFileContents } from "./env-file.js";

describe("env file editor", () => {
  it("pins minimal and JSON value encoding", () => {
    expect(encodeEnvValue("plain-value", "minimal")).toBe("plain-value");
    expect(encodeEnvValue("#439edb", "minimal")).toBe('"#439edb"');
    expect(encodeEnvValue("plain-value", "json")).toBe('"plain-value"');
  });

  it("preserves unrelated content and CRLF while updating every stale duplicate", () => {
    const original = [
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      "export PAPERCLIP_HOME = '/old path'  # managed path",
      "PAPERCLIP_DUPLICATE=stale",
      'PAPERCLIP_DUPLICATE="current"',
      "TRAILING=untouched",
      "",
    ].join("\r\n");

    const updated = updateEnvFileContents(
      original,
      {
        PAPERCLIP_HOME: "/new path",
        PAPERCLIP_DUPLICATE: "current",
        PAPERCLIP_WORKTREE_COLOR: "#439edb",
      },
      { valueEncoding: "minimal" },
    );

    expect(updated).toBe([
      "# operator comment",
      "UNKNOWN='keep this encoding'",
      "",
      'export PAPERCLIP_HOME = "/new path"  # managed path',
      "PAPERCLIP_DUPLICATE=current",
      'PAPERCLIP_DUPLICATE="current"',
      "TRAILING=untouched",
      'PAPERCLIP_WORKTREE_COLOR="#439edb"',
      "",
    ].join("\r\n"));
    expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("uses JSON encoding for changed values without re-encoding current assignments", () => {
    const original = [
      "PAPERCLIP_CURRENT=plain-value",
      "PAPERCLIP_CHANGED=old",
      "UNKNOWN=\"operator value\"",
      "",
    ].join("\n");

    expect(
      updateEnvFileContents(
        original,
        {
          PAPERCLIP_CURRENT: "plain-value",
          PAPERCLIP_CHANGED: "new",
          PAPERCLIP_ADDED: "added",
        },
        { valueEncoding: "json" },
      ),
    ).toBe([
      "PAPERCLIP_CURRENT=plain-value",
      'PAPERCLIP_CHANGED="new"',
      'UNKNOWN="operator value"',
      'PAPERCLIP_ADDED="added"',
      "",
    ].join("\n"));
  });

  it("does not treat an unquoted dotenv comment as the managed value", () => {
    expect(
      updateEnvFileContents(
        ["PAPERCLIP_COLOR=#439edb", "PAPERCLIP_HOME=old# keep this comment"].join("\n"),
        {
          PAPERCLIP_COLOR: "#439edb",
          PAPERCLIP_HOME: "new",
        },
        { valueEncoding: "minimal" },
      ),
    ).toBe(
      ['PAPERCLIP_COLOR="#439edb"#439edb', "PAPERCLIP_HOME=new# keep this comment"].join("\n"),
    );
  });

  it("is a no-op when every managed duplicate is already current", () => {
    const original = [
      "export PAPERCLIP_HOME = '/same path' # first",
      'PAPERCLIP_HOME="/same path"',
      "UNKNOWN=value",
    ].join("\n");

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/same path" })).toBe(original);
  });

  // The worktree repair manages these keys through this writer. A quoted
  // value that spans physical lines must never be rewritten by its first
  // line: the continuation would become a top-level assignment.
  const managedKeys = [
    "PAPERCLIP_HOME",
    "PAPERCLIP_INSTANCE_ID",
    "PAPERCLIP_CONFIG",
    "PAPERCLIP_CONTEXT",
    "PAPERCLIP_IN_WORKTREE",
    "PAPERCLIP_DB_BACKUP_ENABLED",
    "PAPERCLIP_WORKTREE_NAME",
    "PAPERCLIP_TOOL_ACTION_SIGNING_SECRET",
  ];

  it.each(managedKeys.flatMap((key) => [
    { key, quote: '"' as const },
    { key, quote: "'" as const },
  ]))("refuses to rewrite a quoted multiline value for $key ($quote)", ({ key, quote }) => {
    const original = [
      `${key}=${quote}alpha`,
      "DATABASE_URL=postgresql://attacker:secret@evil.invalid/db",
      `omega${quote}`,
      "",
    ].join("\n");

    expect(() => updateEnvFileContents(original, { [key]: "managed-new-value" })).toThrow(
      /spanning multiple lines|multiple lines/,
    );
  });

  it.each([
    {
      name: "escaped quote does not close the value",
      original: 'PAPERCLIP_HOME="alpha\\"\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\nomega"\n',
    },
    {
      name: "escaped backslash at end of first line",
      original: 'PAPERCLIP_HOME="alpha\\\\\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\nomega"\n',
    },
    {
      name: "CRLF multiline value",
      original: 'PAPERCLIP_HOME="alpha\r\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\r\nomega"\r\n',
    },
    {
      name: "trailing comment after the closing quote",
      original: 'PAPERCLIP_HOME="alpha\nomega" # managed note\n',
    },
    {
      name: "multiline duplicate after a single-line duplicate",
      original: 'PAPERCLIP_HOME="/old"\nPAPERCLIP_HOME="alpha\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\nomega"\n',
    },
    {
      name: "multiline duplicate before a single-line duplicate",
      original: 'PAPERCLIP_HOME="alpha\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db\nomega"\nPAPERCLIP_HOME="/old"\n',
    },
    {
      name: "unterminated multiline value as the last line without a newline",
      original: 'PAPERCLIP_HOME="alpha\nDATABASE_URL=postgresql://attacker:secret@evil.invalid/db',
    },
  ])("refuses to rewrite a managed multiline value: $name", ({ original }) => {
    expect(() => updateEnvFileContents(original, { PAPERCLIP_HOME: "/new" })).toThrow(
      /spanning multiple lines|multiple lines|unterminated/,
    );
  });

  it("does not rewrite a managed-looking line inside an unmanaged multiline value", () => {
    const original = [
      'UNRELATED="alpha',
      "PAPERCLIP_HOME=/evil",
      'omega"',
      "",
    ].join("\n");

    const updated = updateEnvFileContents(original, { PAPERCLIP_HOME: "/good" });

    expect(updated).toBe([
      'UNRELATED="alpha',
      "PAPERCLIP_HOME=/evil",
      'omega"',
      'PAPERCLIP_HOME="/good"',
      "",
    ].join("\n"));
  });
});
