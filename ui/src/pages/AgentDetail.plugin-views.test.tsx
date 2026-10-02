// @vitest-environment jsdom

// Fork-only page test for the port of paperclipai/paperclip#13716.
// It proves the routing decisions that the upstream unit tests do not reach:
// a `plugin:<key>:<slot>` view renders the plugin tab instead of falling back
// to overview, and every other unknown view still falls back.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentDetail } from "./AgentDetail";
import { parseAgentDetailView } from "./agent-detail-navigation";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";

type SlotStub = {
  type: string;
  id: string;
  displayName: string;
  exportName: string;
  entityTypes: string[];
  pluginId: string;
  pluginKey: string;
  pluginDisplayName: string;
  pluginVersion: string;
};

type Crumb = { label: string; href?: string };

const harness = vi.hoisted(() => {
  const state = {
    slots: [] as SlotStub[],
    slotsLoading: false,
    breadcrumbs: [] as Crumb[],
    mounts: [] as Array<{ slotKey: string; context: Record<string, unknown> }>,
    outlets: [] as Array<{ slotTypes: string[]; entityType: unknown; context: Record<string, unknown> }>,
  };
  return {
    state,
    setBreadcrumbs: (crumbs: Crumb[]) => {
      state.breadcrumbs = crumbs;
    },
    closePanel: () => {},
    setSelectedCompanyId: () => {},
  };
});

vi.mock("../api/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/agents")>()),
  agentsApi: {
    get: vi.fn(async () => ({
      id: AGENT_ID,
      companyId: "company-1",
      name: "Codex Coder",
      urlKey: "codexcoder",
      role: "engineer",
      title: "Product engineer",
      status: "active",
      reportsTo: null,
      capabilities: "Builds and verifies product changes.",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      chainOfCommand: [],
      access: { canAssignTasks: true, taskAssignSource: "explicit_grant", membership: null, grants: [] },
    })),
    runtimeState: vi.fn(async () => null),
    list: vi.fn(async () => []),
    skills: vi.fn(async () => ({ desiredSkills: [] })),
  },
}));

vi.mock("../api/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/access")>()),
  accessApi: { getCurrentBoardAccess: vi.fn(async () => ({ source: "session", isInstanceAdmin: false })) },
}));

vi.mock("../api/instanceSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instanceSettings")>()),
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) },
}));

vi.mock("../api/heartbeats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/heartbeats")>()),
  heartbeatsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/issues", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/issues")>()),
  issuesApi: { list: vi.fn(async () => []) },
}));

vi.mock("../api/companySkills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/companySkills")>()),
  companySkillsApi: { list: vi.fn(async () => []) },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", issuePrefix: "ACME", name: "Acme" }],
    selectedCompanyId: "company-1",
    selectedCompany: null,
    setSelectedCompanyId: harness.setSelectedCompanyId,
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: harness.closePanel }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: harness.setBreadcrumbs }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ isMobile: false }),
}));

vi.mock("@/hooks/useChatConnectorsEnabled", () => ({
  useChatConnectorsEnabled: () => ({ enabled: false, loaded: true }),
}));

vi.mock("../hooks/useResourceMemberships", () => ({
  isStarred: () => false,
  resourceMembershipState: () => "joined",
  useResourceMemberships: () => ({ data: [] }),
  useResourceMembershipMutation: () => ({ isPending: false, variables: undefined, mutate: () => {} }),
}));

vi.mock("../components/AgentActionButtons", () => ({
  AgentActionButtons: ({ children }: { children?: React.ReactNode }) => <div data-testid="agent-actions">{children}</div>,
}));

vi.mock("../components/StarToggle", () => ({
  StarToggle: () => null,
}));

vi.mock("../components/onboarding/PillGuy", () => ({
  PillGuy: () => null,
}));

vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("./agent-skills/AgentSkillsTab", () => ({
  AgentSkillsTab: () => <div data-testid="skills-tab">skills tab stub</div>,
}));

vi.mock("./AgentToolsTab", () => ({
  AgentToolsTab: () => <div data-testid="tools-tab">tools tab stub</div>,
}));

vi.mock("@/plugins/slots", () => ({
  // Mirrors the real hook: a disabled query reports no slots and isLoading=false.
  usePluginSlots: (filters: { slotTypes: string[]; entityType?: string | null; enabled?: boolean }) => {
    if (filters.enabled === false) return { slots: [], isLoading: false, errorMessage: null };
    if (harness.state.slotsLoading) return { slots: [], isLoading: true, errorMessage: null };
    return {
      slots: harness.state.slots.filter(
        (slot) => filters.slotTypes.includes(slot.type)
          && (!filters.entityType || slot.entityTypes.includes(filters.entityType)),
      ),
      isLoading: false,
      errorMessage: null,
    };
  },
  PluginSlotMount: ({ slot, context }: { slot: SlotStub; context: Record<string, unknown> }) => {
    harness.state.mounts.push({ slotKey: `${slot.pluginKey}:${slot.id}`, context });
    return <section data-testid="plugin-slot-mount" data-slot={`${slot.pluginKey}:${slot.id}`}>{slot.displayName} body</section>;
  },
  PluginSlotOutlet: (props: { slotTypes: string[]; entityType?: unknown; context: Record<string, unknown> }) => {
    harness.state.outlets.push({ slotTypes: props.slotTypes, entityType: props.entityType, context: props.context });
    return <div data-testid="plugin-slot-outlet" />;
  },
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const insightsSlot: SlotStub = {
  type: "detailTab",
  id: "insights",
  displayName: "Acme insights",
  exportName: "InsightsTab",
  entityTypes: ["agent"],
  pluginId: "plugin-acme",
  pluginKey: "acme",
  pluginDisplayName: "Acme",
  pluginVersion: "1.0.0",
};

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function settle() {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

async function renderAt(path: string) {
  // gcTime: Infinity schedules no garbage-collection timers, so no timer outlives the test.
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]} useTransitions={false}>
          <LocationProbe />
          <Routes>
            <Route path="/:companyPrefix/agents/:agentId/overview" element={<p data-testid="overview-landing">overview</p>} />
            <Route path="/:companyPrefix/agents/:agentId/:tab" element={<AgentDetail />} />
            <Route path="/:companyPrefix/agents/:agentId/runs/:runId" element={<AgentDetail />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function pathname() {
  return container.querySelector('[data-testid="location"]')?.textContent;
}

beforeEach(() => {
  harness.state.slots = [];
  harness.state.slotsLoading = false;
  harness.state.breadcrumbs = [];
  harness.state.mounts = [];
  harness.state.outlets = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("AgentDetail plugin detail views (fork port of #13716)", () => {
  it("renders a plugin detail tab on its own view instead of falling back to overview", async () => {
    harness.state.slots = [insightsSlot];

    await renderAt("/ACME/agents/codexcoder/plugin:acme:insights");

    expect(pathname()).toBe("/ACME/agents/codexcoder/plugin:acme:insights");
    expect(container.querySelector('[data-testid="overview-landing"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.getAttribute("data-slot")).toBe("acme:insights");
    expect(container.querySelector("h2")?.textContent).toBe("Acme insights");
    expect(harness.state.breadcrumbs.at(-1)).toEqual({ label: "Acme insights" });
  });

  it("hands the plugin the agent UUID as entityId and mounts the header toolbar outlet", async () => {
    harness.state.slots = [insightsSlot];

    await renderAt("/ACME/agents/codexcoder/plugin:acme:insights");

    const expectedContext = {
      companyId: "company-1",
      companyPrefix: "ACME",
      entityId: AGENT_ID,
      entityType: "agent",
    };
    expect(harness.state.mounts.at(-1)).toEqual({ slotKey: "acme:insights", context: expectedContext });
    expect(harness.state.outlets.at(-1)).toEqual({
      slotTypes: ["toolbarButton", "contextMenuItem"],
      entityType: "agent",
      context: expectedContext,
    });
  });

  it("passes the raw route prefix to the plugin as companyPrefix, without changing its case", async () => {
    harness.state.slots = [insightsSlot];

    await renderAt("/acme/agents/codexcoder/plugin:acme:insights");

    expect(pathname()).toBe("/acme/agents/codexcoder/plugin:acme:insights");
    expect(harness.state.mounts.at(-1)?.context).toEqual({
      companyId: "company-1",
      companyPrefix: "acme",
      entityId: AGENT_ID,
      entityType: "agent",
    });
  });

  it.each([
    { view: "skills", path: "/ACME/agents/codexcoder/skills", marker: "skills tab stub" },
    { view: "tools", path: "/ACME/agents/codexcoder/tools", marker: "tools tab stub" },
    { view: "runs/<runId>", path: "/ACME/agents/codexcoder/runs/run-1", marker: "No runs yet." },
  ])("mounts the header toolbar outlet on the built-in $view view", async ({ path, marker }) => {
    harness.state.slots = [insightsSlot];

    await renderAt(path);

    expect(pathname()).toBe(path);
    expect(container.textContent).toContain(marker);
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    expect(harness.state.outlets.at(-1)).toEqual({
      slotTypes: ["toolbarButton", "contextMenuItem"],
      entityType: "agent",
      context: { companyId: "company-1", companyPrefix: "ACME", entityId: AGENT_ID, entityType: "agent" },
    });
  });

  it("holds a plugin deep link on a skeleton while plugin slots load", async () => {
    harness.state.slotsLoading = true;

    await renderAt("/ACME/agents/codexcoder/plugin:acme:insights");

    expect(pathname()).toBe("/ACME/agents/codexcoder/plugin:acme:insights");
    expect(container.querySelector('[data-testid="overview-landing"]')).toBeNull();
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });

  it("canonicalises a UUID agent ref to the url key and keeps the plugin view", async () => {
    harness.state.slots = [insightsSlot];

    await renderAt(`/ACME/agents/${AGENT_ID}/plugin:acme:insights`);

    expect(pathname()).toBe("/ACME/agents/codexcoder/plugin:acme:insights");
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.getAttribute("data-slot")).toBe("acme:insights");
  });

  it("replaces a plugin view that no installed plugin contributes with overview", async () => {
    harness.state.slots = [insightsSlot];

    await renderAt("/ACME/agents/codexcoder/plugin:gone:tab");

    expect(pathname()).toBe("/ACME/agents/codexcoder/overview");
    expect(container.querySelector('[data-testid="overview-landing"]')).not.toBeNull();
  });

  it.each(["not-a-view", "Plugin:acme:insights", "pluginacme"])(
    "still falls back to overview for the unknown non-plugin view %s",
    async (tab) => {
      harness.state.slots = [insightsSlot];

      await renderAt(`/ACME/agents/codexcoder/${tab}`);

      expect(parseAgentDetailView(tab)).toBe("overview");
      expect(pathname()).toBe("/ACME/agents/codexcoder/overview");
      expect(container.querySelector('[data-testid="overview-landing"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
    },
  );
});
