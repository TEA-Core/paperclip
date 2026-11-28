// @vitest-environment jsdom

// The agent page loads under the agent's UUID, then replaces the URL with the
// agent's URL key. The agent query key includes the route reference, so the
// redirect must not send the page back to its loading skeleton: that remounts
// the run view and discards the feedback of an action started just before it.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../context/ToastContext";
import { AgentDetail } from "./AgentDetail";

const AGENT_ID = "11111111-2222-4333-8444-555555555555";
const RUN_ID = "66666666-7777-4888-8999-aaaaaaaaaaaa";
const DENIAL = "This chat source is no longer authorized.";

const agent = {
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
};

const failedRun = {
  id: RUN_ID,
  companyId: "company-1",
  agentId: AGENT_ID,
  status: "failed",
  invocationSource: "assignment",
  triggerDetail: "system",
  startedAt: "2026-01-01T00:00:00.000Z",
  finishedAt: "2026-01-01T00:00:30.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:30.000Z",
  error: "The fixture provider turn failed.",
  errorCode: "adapter_failed",
  exitCode: 1,
  signal: null,
  usageJson: null,
  resultJson: null,
  logBytes: 0,
  contextSnapshot: {},
};

const api = vi.hoisted(() => ({
  // The URL-key lookup never answers, so the page can only render from data
  // that was already loaded under the UUID.
  getAgent: vi.fn(),
  retryFailedRun: vi.fn(),
}));

vi.mock("../api/agents", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/agents")>()),
  agentsApi: {
    get: api.getAgent,
    retryFailedRun: api.retryFailedRun,
    runtimeState: vi.fn(async () => null),
    list: vi.fn(async () => []),
    skills: vi.fn(async () => ({ desiredSkills: [] })),
  },
}));

vi.mock("../api/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/access")>()),
  accessApi: {
    getCurrentBoardAccess: vi.fn(async () => ({ source: "local_implicit", isInstanceAdmin: true })),
    listUserDirectory: vi.fn(async () => ({ users: [] })),
  },
}));

vi.mock("../api/instanceSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/instanceSettings")>()),
  instanceSettingsApi: { getExperimental: vi.fn(async () => ({})) },
}));

vi.mock("../api/heartbeats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/heartbeats")>()),
  heartbeatsApi: {
    list: vi.fn(async () => [failedRun]),
    get: vi.fn(async () => failedRun),
    providerTraceMetadata: vi.fn(async () => []),
    events: vi.fn(async () => []),
    log: vi.fn(async () => ({ runId: RUN_ID, content: "", nextOffset: 0 })),
    workspaceOperations: vi.fn(async () => []),
    issuesForRun: vi.fn(async () => []),
  },
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
    setSelectedCompanyId: () => {},
  }),
}));

vi.mock("../context/PanelContext", () => ({
  usePanel: () => ({ closePanel: () => {} }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }),
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
  AgentActionButtons: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../components/StarToggle", () => ({ StarToggle: () => null }));
vi.mock("../components/onboarding/PillGuy", () => ({ PillGuy: () => null }));
vi.mock("../components/MarkdownBody", () => ({
  MarkdownBody: ({ children }: { children: string }) => <div>{children}</div>,
}));

vi.mock("@/plugins/slots", () => ({
  usePluginSlots: () => ({ slots: [], isLoading: false, errorMessage: null }),
  PluginSlotMount: () => null,
  PluginSlotOutlet: () => null,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function retryButton() {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === "Retry");
}

beforeEach(() => {
  api.getAgent.mockReset();
  api.getAgent.mockImplementation((ref: string) =>
    ref === AGENT_ID ? Promise.resolve(agent) : new Promise<never>(() => {}),
  );
  api.retryFailedRun.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
});

afterEach(async () => {
  await act(async () => root.unmount());
  queryClient.clear();
  container.remove();
});

describe("AgentDetail canonical agent redirect", () => {
  it("keeps the run page mounted so retry feedback survives the UUID-to-url-key redirect", async () => {
    api.retryFailedRun.mockRejectedValue(new Error(DENIAL));
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
          <MemoryRouter initialEntries={[`/ACME/agents/${AGENT_ID}/runs/${RUN_ID}`]} useTransitions={false}>
            <LocationProbe />
            <Routes>
              <Route path="/:companyPrefix/agents/:agentId/runs/:runId" element={<AgentDetail />} />
            </Routes>
          </MemoryRouter>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    expect(container.querySelector('[data-testid="location"]')?.textContent).toBe(
      `/ACME/agents/codexcoder/runs/${RUN_ID}`,
    );
    expect(container.querySelector('[data-slot="skeleton"]')).toBeNull();
    const retry = retryButton();
    expect(retry).toBeDefined();

    await act(async () => {
      retry!.click();
    });
    await settle();

    expect(api.retryFailedRun).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(DENIAL);
  });
});
