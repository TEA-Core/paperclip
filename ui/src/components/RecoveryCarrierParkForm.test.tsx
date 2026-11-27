// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveryCarrierParkForm } from "./RecoveryCarrierParkForm";
import { recoveryCarrierParkFixture } from "../fixtures/recoveryCarrierParkFixture";
import type { RecoveryCarrierParkCandidate } from "@paperclipai/shared";

// React's test-runner flag is not part of the DOM global declarations.
const reactTestGlobal: typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean } = globalThis;
reactTestGlobal.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  container?.remove();
  root = null;
  container = null;
});

async function open(candidate: RecoveryCarrierParkCandidate = recoveryCarrierParkFixture) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  container = element;
  root = createRoot(element);
  await act(async () => {
    root!.render(<RecoveryCarrierParkForm candidate={candidate} onPark={() => { throw new Error("Unexpected park submission"); }} />);
  });
  await act(async () => { element.querySelector("button")!.click(); });
  return element;
}

describe("RecoveryCarrierParkForm", () => {
  it("announces both required board acceptance fields accessibly", async () => {
    const element = await open();
    for (const field of [element.querySelector("select"), element.querySelector("textarea")]) {
      expect(field).not.toBeNull();
      expect(field!.required || field!.getAttribute("aria-required") === "true").toBe(true);
    }
  });

  it("explains the specific live blocker instead of silently disabling board acceptance", async () => {
    const blocker = { ...recoveryCarrierParkFixture.expectedBlockers[0]!, status: "in_progress" as const };
    const element = await open({ ...recoveryCarrierParkFixture, expectedBlockers: [blocker] });
    const alert = element.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain(blocker.id);
    expect(element.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });
});
