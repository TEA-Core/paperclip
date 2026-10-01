// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { SidebarProvider } from "@/context/SidebarContext";
import { AgentChatSidebar } from "./AgentChatSidebar";

// The chat-row link renders through `@/lib/router`'s `NavLink`, which resolves a
// company prefix via `useCompany`. No company is selected in this isolated unit,
// so `applyCompanyPrefix` returns the bare href unchanged — stub the context to
// keep the test free of the API bootstrap the real provider performs.
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [],
    selectedCompanyId: null,
    selectedCompany: null,
    loading: false,
  }),
  CompanyProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SUP-18109 regression: `tests/e2e/agent-chat.spec.ts:566` asserted that after
// `star.focus()` -> Tab -> Shift+Tab the star control read `opacity: 1`. That
// depended on the `focus-visible:` variant, which is a *heuristic* (it reflects
// how focus was acquired) and flaked, ejecting merge-queue entries. The fix adds
// a `group-focus-within/agent-chat:opacity-100` variant so the control is opaque
// whenever any descendant of its row has focus — a deterministic, focus-state
// driven rule. This test locks in that exact class (SUP-17963 claimed it landed;
// it did not) and the focus-within scoping that makes it apply.
//
// jsdom does not apply Tailwind CSS and does not drive native Tab navigation, so
// the computed opacity outcome and the literal keyboard path are asserted by the
// e2e `:566` test; here we assert the DOM contract the e2e relies on.

const agents = [
  { id: "agent-alpha", name: "Alpha", createdAt: "2026-01-01T00:00:00.000Z", icon: "bot" },
  { id: "agent-zeta", name: "Zeta", createdAt: "2026-01-02T00:00:00.000Z", icon: "bot" },
] as unknown as Agent[];

let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  flushSync(() => {
    root.render(
      <SidebarProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </SidebarProvider>,
    );
  });
}

function sidebar() {
  return (
    <AgentChatSidebar
      agents={agents}
      activeId="agent-alpha"
      starredIds={[]}
      recentIds={["agent-zeta"]}
      onToggleStar={() => {}}
      onOpenChat={() => {}}
      href={(id) => `/chats/${id}`}
    />
  );
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: 1280,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  flushSync(() => root.unmount());
  container.remove();
});

describe("AgentChatSidebar star control focus-within visibility", () => {
  it("carries the focus-within reveal class that the e2e :566 path depends on", () => {
    render(sidebar());
    const star = container.querySelector<HTMLButtonElement>('button[aria-label="Star Zeta"]');
    expect(star).toBeTruthy();

    // The class SUP-17963 claimed landed but did not — the deterministic fix.
    expect(star!.className).toContain("group-focus-within/agent-chat:opacity-100");

    // Baseline is intact: the control still starts hidden and keeps its other
    // reveal paths (row hover + keyboard focus-visible + coarse pointers).
    expect(star!.className).toContain("opacity-0");
    expect(star!.className).toContain("group-hover/agent-chat:opacity-100");
    expect(star!.className).toContain("focus-visible:opacity-100");
  });

  it("is keyboard-focusable and nested in its group/agent-chat row so focus-within applies", () => {
    render(sidebar());
    const star = container.querySelector<HTMLButtonElement>('button[aria-label="Star Zeta"]')!;

    // Focus step of the :566 sequence: programmatic focus lands on the control.
    star.focus();
    expect(document.activeElement).toBe(star);

    // The control lives inside its `group/agent-chat` row, so when it holds
    // focus the row is `:focus-within` and the group-focus-within variant above
    // flips its opacity to 1 — the deterministic guarantee the e2e asserts.
    const row = star.closest('[class*="group/agent-chat"]');
    expect(row).toBeTruthy();
    expect(row!.contains(star)).toBe(true);
  });
});
