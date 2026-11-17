/** Types for the loopback MCP + OAuth provider in oauth-refresh-fixture.mjs. */
export interface OAuthRefreshFixtureOptions {
  port?: number;
  supportsOfflineAccess?: boolean;
  grantTypes?: string[];
  challengeScope?: boolean;
  resourceScopes?: string[];
  accessTokenLifetimeSeconds?: number;
}

export interface OAuthRefreshFixture {
  origin: string;
  mcpUrl: string;
  issuer: string;
  /**
   * Diagnostic events in arrival order: `kind` plus kind-specific fields
   * (registration, authorization, token, mcp_unauthorized, mcp). The module is
   * plain JavaScript and builds this as an untyped array, so it is `any[]` here,
   * the same type TypeScript infers for it when it checks JavaScript.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  events: any[];
  /** Advance only provider time; callers can separately expire their cached token. */
  advanceTime(ms: number): void;
  close(): Promise<void>;
}

export declare function startOAuthRefreshFixture(options?: OAuthRefreshFixtureOptions): Promise<OAuthRefreshFixture>;
