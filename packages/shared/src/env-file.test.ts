import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { parse as parseDotenv } from "dotenv";
import { encodeEnvValue, updateEnvFileContents, writeEnvFileAtomicallyIfChanged } from "./env-file.js";

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
      /spanning multiple lines|multiple lines|unterminated|loader/,
    );
  });

  it("pre-condition: refuses an invisible opener even when the hidden line already holds the managed value", () => {
    const original =
      "FOO.BAR='alpha\nPAPERCLIP_DB_BACKUP_ENABLED=false\nomega'\nPAPERCLIP_DB_BACKUP_ENABLED=false\n";

    expect(() => updateEnvFileContents(original, { PAPERCLIP_DB_BACKUP_ENABLED: "false" })).toThrow(
      /no canonical assignment|loader key/,
    );
  });

  it("post-condition: refuses when leaving a line would change the loader value of a managed key", () => {
    const original = String.raw`PAPERCLIP_HOME="CANARY\tescape"` + "\n";

    expect(() => updateEnvFileContents(original, { PAPERCLIP_HOME: "CANARY\tescape" })).toThrow(
      /rewrite would change loader value/,
    );
  });

  it.each([
    "__proto__",
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__defineGetter__",
  ])("preserves an unmanaged %s line byte-for-byte", (key) => {
    const original = `${key}=x\nPAPERCLIP_HOME=/old\n`;

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/new" })).toBe(
      `${key}=x\nPAPERCLIP_HOME="/new"\n`,
    );
  });

  it("post-condition add-key: refuses a managed key that would emit a new loader key", () => {
    // A managed key carrying a newline would be emitted as two physical
    // lines; only the post-condition sees the extra loader key in the output.
    const entries = Object.fromEntries([["A\nDATABASE_URL", "x"]]);
    expect(() => updateEnvFileContents("PLAIN=1\n", entries)).toThrow(
      /would add loader key/,
    );
  });

  it("post-condition drop-key: refuses a managed entry the loader cannot hold", () => {
    const entries = Object.fromEntries([["__proto__", "x"]]);
    expect(() => updateEnvFileContents("PLAIN=1\n", entries)).toThrow(
      /would drop loader key/,
    );
  });

  it("agreement value comparison: refuses when a colon duplicate changes the loader value", () => {
    const original = 'PAPERCLIP_HOME=/old\nPAPERCLIP_HOME: "alpha\nbeta"\n';
    expect(() => updateEnvFileContents(original, { PAPERCLIP_HOME: "alpha\nbeta" })).toThrow(
      /writer and loader disagree/,
    );
  });

  it("refuses a file with a bare carriage return", () => {
    const original = "PAPERCLIP_HOME=/old\rPLAIN=1\r";
    expect(() => updateEnvFileContents(original, { PAPERCLIP_HOME: "/new" })).toThrow(
      /carriage return/,
    );
  });

  it("writes the temp file with mode 600 and removes it on error", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-file-atomic-"));
    const target = path.join(dir, "blocked");
    fs.mkdirSync(target);

    expect(() => writeEnvFileAtomicallyIfChanged(target, null, "KEY=1\n")).toThrow();
    expect(fs.readdirSync(dir).filter((name) => name.includes(".tmp"))).toEqual([]);

    const filePath = path.join(dir, ".env");
    expect(writeEnvFileAtomicallyIfChanged(filePath, null, "KEY=1\n")).toBe(true);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("does not rewrite a hidden line inside a shadowed quoted span opened on the next line", () => {
    const original = [
      "NOTE=",
      '"alpha',
      "PAPERCLIP_HOME=/evil",
      "DATABASE_URL=postgresql://attacker.invalid/db",
      'omega"',
      "NOTE=final",
      "PAPERCLIP_HOME=/good",
      "",
    ].join("\n");

    expect(updateEnvFileContents(original, { PAPERCLIP_HOME: "/good" })).toBe(original);
  });

  it.each([
    { name: "double-quoted", open: 'NOTE="alpha', close: 'omega"' },
    { name: "single-quoted", open: "NOTE='alpha", close: "omega'" },
    { name: "backtick", open: "NOTE=`alpha", close: "omega`" },
  ])("keeps a canary inside a $name span after the shadowing duplicate is deleted", ({ open, close }) => {
    const canary = "PAPERCLIP_SECRETS_MASTER_KEY=canary-key";
    const original = [open, "PAPERCLIP_HOME=/evil", canary, close, "NOTE=final", "PAPERCLIP_HOME=/good", ""].join("\n");

    const updated = updateEnvFileContents(original, { PAPERCLIP_HOME: "/good" });
    const edited = updated.split("\n").filter((line) => line !== "NOTE=final").join("\n");
    const parsed = parseDotenv(edited);

    expect(parsed.PAPERCLIP_SECRETS_MASTER_KEY).toBeUndefined();
    expect(parsed.NOTE).toContain(canary);
    expect(parsed.PAPERCLIP_HOME).toBe("/good");
  });

  it("refuses an unterminated quoted value even for an unmanaged key", () => {
    expect(() => updateEnvFileContents('UNRELATED="alpha\n', { PAPERCLIP_HOME: "/good" })).toThrow(
      /unterminated/,
    );
  });

  it("does not let the understood fallback rewrite a key the caller manages", () => {
    expect(() => updateEnvFileContents("FOO.BAR=1\n", { "FOO.BAR": "2" })).toThrow(
      /no canonical assignment/,
    );
  });

  it("recognises a closing single quote after a trailing backslash when no later single quote exists", () => {
    const original = "NOTE='cache\\'\nPAPERCLIP_DB_BACKUP_ENABLED=true\n";

    const updated = updateEnvFileContents(original, { PAPERCLIP_DB_BACKUP_ENABLED: "false" });

    expect(updated).toBe("NOTE='cache\\'\nPAPERCLIP_DB_BACKUP_ENABLED=\"false\"\n");
    expect(parseDotenv(updated).PAPERCLIP_DB_BACKUP_ENABLED).toBe("false");
  });

  it.each([
    { name: "double quote in a path", value: '/tmp/review"draft/wt' },
    { name: "backslash in a path", value: "/tmp/back\\slash/wt" },
    { name: "tab in a path", value: "/tmp/ta\tb/wt" },
    { name: "backslash-n in a path", value: "C:\\new\\wt" },
  ])("encodes a managed value with a $name so the loader reads it back", ({ value }) => {
    const updated = updateEnvFileContents("PAPERCLIP_CONFIG=/old\n", { PAPERCLIP_CONFIG: value });

    expect(parseDotenv(updated).PAPERCLIP_CONFIG).toBe(value);
    expect(updated).toContain(`PAPERCLIP_CONFIG='${value}'`);
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

  it.each([
    {
      name: "dotted",
      file: [
        'FOO.BAR="alpha',
        "PAPERCLIP_HOME=/hidden",
        "PAPERCLIP_SECRETS_MASTER_KEY=canary-master-key",
        'omega"',
        "FOO.BAR=final",
        "PAPERCLIP_SECRETS_MASTER_KEY=good-master-key",
        "",
      ].join("\n"),
      key: "PAPERCLIP_SECRETS_MASTER_KEY",
      shadow: "PAPERCLIP_SECRETS_MASTER_KEY=good-master-key",
    },
    {
      name: "digit-led",
      file: [
        '1FOO="alpha',
        "PAPERCLIP_CONTEXT=/hidden",
        "BETTER_AUTH_SECRET=canary-auth-secret",
        'omega"',
        "1FOO=final",
        "BETTER_AUTH_SECRET=good-auth-secret",
        "",
      ].join("\n"),
      key: "BETTER_AUTH_SECRET",
      shadow: "BETTER_AUTH_SECRET=good-auth-secret",
    },
    {
      name: "colon",
      file: [
        'A.B: "alpha',
        "PAPERCLIP_HOME=/hidden",
        "DATABASE_URL=postgresql://canary.invalid/db",
        'omega"',
        "A.B=final",
        "DATABASE_URL=postgresql://good.invalid/db",
        "",
      ].join("\n"),
      key: "DATABASE_URL",
      shadow: "DATABASE_URL=postgresql://good.invalid/db",
    },
    {
      name: "next-line dotted",
      file: [
        "A.B=",
        '"',
        "PAPERCLIP_HOME=/old",
        "DATABASE_URL=postgresql://canary.invalid/db",
        '"',
        "A.B=final",
        "DATABASE_URL=postgresql://good.invalid/db",
        "",
      ].join("\n"),
      key: "DATABASE_URL",
      shadow: "DATABASE_URL=postgresql://good.invalid/db",
    },
  ])("does not plant a $name canary that loads after the shadowing line is deleted (SUP-24365)", ({ file, key, shadow }) => {
    const managed = {
      PAPERCLIP_HOME: "/managed/home",
      PAPERCLIP_INSTANCE_ID: "wt",
      PAPERCLIP_CONFIG: "/managed/config.json",
      PAPERCLIP_CONTEXT: "/managed/context.json",
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_WORKTREE_NAME: "wt",
    };

    const updated = updateEnvFileContents(file, managed);
    const edited = updated.split("\n").filter((line) => line !== shadow).join("\n");

    expect(parseDotenv(edited)[key]).toBeUndefined();
  });

  it.each([
    {
      name: "colon next line",
      file: [
        "FOO:",
        ' "alpha',
        "PAPERCLIP_HOME=/hidden",
        "BETTER_AUTH_SECRET=canary-auth-secret",
        'omega"',
        "FOO=final",
        "BETTER_AUTH_SECRET=good-auth-secret",
        "",
      ].join("\n"),
      key: "BETTER_AUTH_SECRET",
      shadow: "BETTER_AUTH_SECRET=good-auth-secret",
    },
    {
      name: "D8 colon newline quote",
      file: [
        "FOO:",
        ' "alpha',
        "DATABASE_URL=postgresql://canary.invalid/db",
        "PAPERCLIP_CONTEXT=/hidden",
        'omega"',
        "FOO=final",
        "DATABASE_URL=postgresql://good.invalid/db",
        "",
      ].join("\n"),
      key: "DATABASE_URL",
      shadow: "DATABASE_URL=postgresql://good.invalid/db",
    },
    {
      name: "split equals",
      file: [
        "FOO",
        '="alpha',
        "PAPERCLIP_HOME=/hidden",
        "DATABASE_URL=postgresql://canary.invalid/db",
        'omega"',
        "FOO=final",
        "DATABASE_URL=postgresql://good.invalid/db",
        "",
      ].join("\n"),
      key: "DATABASE_URL",
      shadow: "DATABASE_URL=postgresql://good.invalid/db",
    },
  ])("does not plant a $name canary that loads after the shadowing line is deleted (SUP-24365)", ({ file, key, shadow }) => {
    const managed = {
      PAPERCLIP_HOME: "/managed/home",
      PAPERCLIP_INSTANCE_ID: "wt",
      PAPERCLIP_CONFIG: "/managed/config.json",
      PAPERCLIP_CONTEXT: "/managed/context.json",
      PAPERCLIP_IN_WORKTREE: "true",
      PAPERCLIP_DB_BACKUP_ENABLED: "false",
      PAPERCLIP_WORKTREE_NAME: "wt",
    };

    const updated = updateEnvFileContents(file, managed);
    const edited = updated.split("\n").filter((line) => line !== shadow).join("\n");

    expect(parseDotenv(edited)[key]).toBeUndefined();
  });


  it("keeps an assignment hidden by an escaped quote from becoming a loader key (SUP-24365)", () => {
    const original = [
      'NOTE="alpha\\"',
      "DATABASE_URL=postgresql://attacker.invalid/db",
      'omega"',
      "PAPERCLIP_HOME=/old",
      "",
    ].join("\n");

    const updated = updateEnvFileContents(original, { PAPERCLIP_HOME: "/good" });

    expect(parseDotenv(updated).DATABASE_URL).toBeUndefined();
    expect(parseDotenv(updated).PAPERCLIP_HOME).toBe("/good");
  });

  it("keeps a backtick span grouped so a hidden assignment is not a loader key (SUP-24365)", () => {
    const original = [
      "NOTE=`alpha",
      "PAPERCLIP_HOME=/evil",
      "BETTER_AUTH_SECRET=canary-auth-secret",
      "omega`",
      "NOTE=final",
      "PAPERCLIP_HOME=/good",
      "",
    ].join("\n");

    const updated = updateEnvFileContents(original, { PAPERCLIP_HOME: "/good" });
    const edited = updated.split("\n").filter((line) => line !== "NOTE=final").join("\n");

    expect(updated.startsWith("NOTE=`alpha\nPAPERCLIP_HOME=/evil\nBETTER_AUTH_SECRET=canary-auth-secret\nomega`\n")).toBe(true);
    expect(parseDotenv(edited).BETTER_AUTH_SECRET).toBeUndefined();
    expect(parseDotenv(updated).PAPERCLIP_HOME).toBe("/good");
  });

  it("removes only a dead writer's temp and keeps one whose pid is alive (SUP-24365)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-file-orphan-"));
    const filePath = path.join(dir, ".env");
    const deadOrphan = path.join(dir, `..env.999999.${"123e4567-e89b-12d3-a456-426614174000"}.tmp`);
    const liveOrphan = path.join(dir, `..env.1.${"123e4567-e89b-12d3-a456-426614174001"}.tmp`);
    fs.writeFileSync(filePath, "KEY=old\n");
    fs.writeFileSync(deadOrphan, "partial\n");
    fs.writeFileSync(liveOrphan, "partial\n");

    expect(writeEnvFileAtomicallyIfChanged(filePath, "KEY=old\n", "KEY=new\n")).toBe(true);

    expect(fs.existsSync(deadOrphan)).toBe(false);
    expect(fs.existsSync(liveOrphan)).toBe(true);
  });

  it("cleans a dead writer's orphan on a no-op without replacing the env file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-env-noop-orphan-"));
    const filePath = path.join(dir, ".env");
    const deadOrphan = path.join(dir, "..env.424242.dead.tmp");
    const liveOrphan = path.join(dir, `..env.${process.pid}.live.tmp`);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (pid === 424242) throw Object.assign(new Error("dead fixture writer"), { code: "ESRCH" });
      return true;
    });
    try {
      fs.writeFileSync(filePath, "KEY=current\n");
      fs.writeFileSync(deadOrphan, "partial\n");
      fs.writeFileSync(liveOrphan, "partial\n");
      const before = fs.statSync(filePath);
      expect(writeEnvFileAtomicallyIfChanged(filePath, "KEY=current\n", "KEY=current\n")).toBe(false);
      expect(fs.existsSync(deadOrphan)).toBe(false);
      expect(fs.readFileSync(liveOrphan, "utf8")).toBe("partial\n");
      expect(fs.readFileSync(filePath, "utf8")).toBe("KEY=current\n");
      expect(fs.statSync(filePath)).toMatchObject({ ino: before.ino, mtimeMs: before.mtimeMs });
    } finally {
      kill.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a trailing comment when a backslash escapes the comment marker (SUP-24365)", () => {
    expect(updateEnvFileContents("KEY=a\\# note\n", { KEY: "new" })).toBe('KEY="new"# note\n');
    expect(updateEnvFileContents("KEY='a\\' # note\n", { KEY: "new" })).toBe('KEY="new" # note\n');
  });

  it("refuses a single quote followed by a backslash that cannot round-trip (N21)", () => {
    expect(() => updateEnvFileContents("KEY=\\\n", { KEY: "'\\" })).toThrow(/rewrite would change loader value/);
  });
});
