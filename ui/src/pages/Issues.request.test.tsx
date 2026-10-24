// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listCompact: vi.fn(),
  listProps: { current: null as Record<string, any> | null },
}));

vi.mock("@/lib/router", () => ({
  useLocation: () => ({ pathname: "/issues", search: "", hash: "" }),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));
vi.mock("../api/issues", () => ({ issuesApi: { listCompact: mocks.listCompact } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn().mockResolvedValue([]) } }));
vi.mock("../api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: vi.fn().mockResolvedValue([]) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company-1" }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true }) }));
vi.mock("@/hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }),
  usePublishSharedQueryData: vi.fn(),
}));
vi.mock("../components/IssuesList", () => ({
  IssuesList: (props: Record<string, any>) => {
    mocks.listProps.current = props;
    return null;
  },
}));

import { Issues } from "./Issues";

const page = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i}`, title: `${prefix}-${i}` }));

describe("Issues page list requests", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    mocks.listCompact.mockReset();
    mocks.listCompact.mockResolvedValue([]);
    mocks.listProps.current = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Issues />
        </QueryClientProvider>,
      );
    });
  }

  async function reportStatuses(statuses: string[]) {
    await act(async () => {
      mocks.listProps.current?.onStatusFilterChange?.(statuses);
    });
  }

  it("requests every status when no status filter is selected", async () => {
    await render();
    await reportStatuses([]);
    expect(mocks.listCompact).toHaveBeenCalledTimes(1);
    expect(mocks.listCompact.mock.calls[0][1].status).toBeUndefined();
  });

  it("sends the selected statuses to the server", async () => {
    await render();
    await reportStatuses(["todo", "in_progress", "blocked"]);
    expect(mocks.listCompact).toHaveBeenCalledTimes(1);
    expect(mocks.listCompact.mock.calls[0][1]).toMatchObject({
      status: "todo,in_progress,blocked",
      limit: 100,
      offset: 0,
      sortField: "updated",
      sortDir: "desc",
    });
  });

  it("refetches from offset 0 when the status filter changes", async () => {
    await render();
    await reportStatuses([]);
    await reportStatuses(["done"]);
    const statuses = mocks.listCompact.mock.calls.map(([, filters]) => [filters.status, filters.offset]);
    expect(statuses).toEqual([[undefined, 0], ["done", 0]]);
  });

  it("keeps the status filter on later pages", async () => {
    mocks.listCompact.mockResolvedValueOnce(page(100, "a"));
    await render();
    await reportStatuses(["todo"]);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      mocks.listProps.current?.onLoadMoreIssues?.();
    });
    expect(mocks.listCompact.mock.calls.map(([, filters]) => [filters.status, filters.offset])).toEqual([
      ["todo", 0],
      ["todo", 100],
    ]);
  });
});
