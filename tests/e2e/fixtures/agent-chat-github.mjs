// Upstream GitHub simulation only. Paperclip's discovery, secret resolution,
// responsible-user authorization, and project creation all remain real.
if (process.env.NODE_ENV === "test") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // SUP-21902: the signoff e2e closes cards at Tier 2, so the guard resolves
    // the named probe head through the commits API with the company's synthetic
    // GITHUB_TOKEN. Serve a deterministic GitHub for that token only: the probe
    // head resolves to the delivery's recorded merge commit, and every other
    // probe answers in the fail-safe shape the guard expects.
    if (
      url.hostname === "api.github.com" &&
      headers.get("authorization") === "Bearer " + "paperclip-e2e-signoff-fixture"
    ) {
      const sha = "7d3f9c1e0a25b864d7f2c9e6a18b40c3d5e72f19";
      const path = url.pathname;
      if (/^\/repos\/[^/]+\/[^/]+\/commits\/[^/]+$/.test(path)) {
        return Response.json({ sha });
      }
      if (path.includes("/compare/")) {
        return Response.json({ ahead_by: 0, behind_by: 0, status: "identical", total_commits: 0 });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/pulls$/.test(path)) return Response.json([]);
      if (path === "/search/issues") {
        return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      }
      if (/^\/repos\/[^/]+\/[^/]+\/branches\/[^/]+$/.test(path)) {
        return Response.json({ name: "fold/tea-patches-v2026.722.0", commit: { sha } });
      }
      if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
        return Response.json({ full_name: "TEA-Core/paperclip", default_branch: "fold/tea-patches-v2026.722.0", allow_auto_merge: true });
      }
      if (path === "/graphql") return Response.json({ data: { repository: null } });
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    if (
      url.hostname === "api.github.com" &&
      headers.get("authorization") === "Bearer paperclip-e2e-repository-fixture"
    ) {
      if (url.pathname !== "/user/repos")
        return Response.json(
          { error: "Unsupported fixture GitHub request" },
          { status: 422 },
        );
      return Response.json([
        { id: 101, full_name: "chat-fixture/frontend", private: false },
        { id: 102, full_name: "chat-fixture/backend", private: false },
      ]);
    }
    return realFetch(input, init);
  };
}
