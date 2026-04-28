/// Hardcoded v1 catalog of MCP servers an IT admin can install into the
/// active OpenIT project. All six are first-party remote OAuth servers —
/// click Install, OAuth in the browser, done. Slack and GSuite are
/// deferred: Slack only has a community fork of an archived reference
/// server, and Google's official Workspace MCP is still in preview.
/// Both are still reachable via the "+ N more via Pinkfish" tile.
///
/// The Pinkfish CTA shown next to each card deep-links into the cloud
/// connections page — we lean on tool curation + breadth as the upsell.

export type CatalogEntry = {
  id: string;
  name: string;
  description: string;
  url: string;
  vendorTag: "first-party";
  pinkfishConnection?: string;
};

export const PINKFISH_CONNECTIONS_URL = "https://app.pinkfish.ai/connections";

export const CATALOG: CatalogEntry[] = [
  {
    id: "github",
    name: "GitHub",
    description: "Repos, PRs, issues, collaborators.",
    url: "https://api.githubcopilot.com/mcp/",
    vendorTag: "first-party",
    pinkfishConnection: "github",
  },
  {
    id: "linear",
    name: "Linear",
    description: "Issues, projects, cycles, comments.",
    url: "https://mcp.linear.app/mcp",
    vendorTag: "first-party",
    pinkfishConnection: "linear",
  },
  {
    id: "atlassian",
    name: "Atlassian (Jira + Confluence)",
    description: "Jira issues, sprints; Confluence pages.",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    vendorTag: "first-party",
    pinkfishConnection: "atlassian",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Pages, databases, search.",
    url: "https://mcp.notion.com/mcp",
    vendorTag: "first-party",
    pinkfishConnection: "notion",
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Issues, events, releases.",
    url: "https://mcp.sentry.dev/mcp",
    vendorTag: "first-party",
    pinkfishConnection: "sentry",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    description: "DNS, workers, observability.",
    // TODO(verify): Cloudflare publishes multiple per-product MCP servers;
    // this URL targets the bindings/observability bundle. Confirm before
    // shipping if a different surface is preferred.
    url: "https://bindings.mcp.cloudflare.com/sse",
    vendorTag: "first-party",
    pinkfishConnection: "cloudflare",
  },
];

/// Find a catalog entry by id. Used by the install modal + post-install
/// state to render the right metadata for the chosen server.
export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
