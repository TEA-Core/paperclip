// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityFeed } from "./ActivityFeed";

function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> | undefined;
  flushSync(() => {
    result = callback();
  });
  return result;
}

const companyState = vi.hoisted(() => ({
  selectedCompanyId: "company-1",
}));

const mockIssuesApi = vi.hoisted(() => ({
  list: vi.fn(),
  listCompact: vi.fn(),
}));

const mockActivityApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockAgentsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => companyState,
}));

vi.mock("../api/issues", () => ({
  issuesApi: mockIssuesApi,
}));

vi.mock("../api/activity", () => ({
  activityApi: mockActivityApi,
}));

vi.mock("../api/agents", () => ({
  agentsApi: mockAgentsApi,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

describe("ActivityFeed", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockIssuesApi.list.mockReset();
    mockIssuesApi.listCompact.mockReset();
    mockActivityApi.list.mockReset();
    mockAgentsApi.list.mockReset();
    mockIssuesApi.list.mockResolvedValue([]);
    mockIssuesApi.listCompact.mockResolvedValue([]);
    mockActivityApi.list.mockResolvedValue([]);
    mockAgentsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
  });

  it("resolves issue names with a bounded compact list covering the activity page", async () => {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <ActivityFeed />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });

    await waitForAssertion(() => {
      expect(mockIssuesApi.listCompact).toHaveBeenCalledWith("company-1", { limit: 100 });
    });
    expect(mockIssuesApi.list).not.toHaveBeenCalled();

    flushSync(() => root.unmount());
  });
});
