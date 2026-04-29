/// Hardcoded v1 catalog of CLI tools an IT admin can install into their
/// machine. Each entry maps to a brew install (with curl as the fallback
/// when brew isn't available) and a one-line CLAUDE.md hint that tells
/// Claude the tool exists. Claude already knows the popular CLIs from
/// training; for less-common tools the hint includes a `<tool> --help`
/// nudge so Claude can self-discover surface area on demand.
///
/// Why CLI instead of MCP servers: zero token cost until the tool is
/// actually invoked (no schemas in baseline context), no per-session
/// tool cap, and IT admins already know the brew/curl install pattern.

export type CatalogEntry = {
  /// Short stable id used as the entry key in the marker block.
  id: string;
  name: string;
  description: string;
  /// PATH-resolvable binary name — what `which` looks for.
  binary: string;
  /// Brew install command (preferred). Run as `brew install <pkg>` so
  /// the wrapper just substitutes <pkg>.
  brewPkg: string;
  /// Curl-based install fallback when brew is missing. Single shell
  /// command. Optional — if not supplied and brew is unavailable, the
  /// UI surfaces a "see vendor docs" link instead.
  curlInstall?: string;
  /// One-line guidance dropped into the project CLAUDE.md when the tool
  /// is installed. Should explain WHAT the tool is plus a HOW-TO nudge
  /// (e.g. "run `<tool> --help`") for less-known tools.
  claudeMdHint: string;
  /// External link shown next to the install button — vendor docs.
  docsUrl: string;
};

export const CATALOG: CatalogEntry[] = [
  {
    id: "aws",
    name: "AWS CLI",
    description: "AWS infrastructure: IAM, EC2, S3, RDS, CloudWatch, etc.",
    binary: "aws",
    brewPkg: "awscli",
    claudeMdHint:
      "AWS CLI (`aws`) is installed. Use it for AWS operations — auth via `aws configure` or AWS_PROFILE.",
    docsUrl: "https://docs.aws.amazon.com/cli/",
  },
  {
    id: "az",
    name: "Azure CLI",
    description: "Azure resources: AAD/Entra, VMs, storage, networking.",
    binary: "az",
    brewPkg: "azure-cli",
    claudeMdHint:
      "Azure CLI (`az`) is installed. Use it for Azure operations — auth via `az login`.",
    docsUrl: "https://learn.microsoft.com/cli/azure/",
  },
  {
    id: "gcloud",
    name: "Google Cloud SDK",
    description: "GCP projects, IAM, GKE, BigQuery, Cloud Run, etc.",
    binary: "gcloud",
    brewPkg: "google-cloud-sdk",
    claudeMdHint:
      "Google Cloud SDK (`gcloud`) is installed. Use it for GCP operations — auth via `gcloud auth login`.",
    docsUrl: "https://cloud.google.com/sdk/docs/",
  },
  {
    id: "gh",
    name: "GitHub CLI",
    description: "Repos, PRs, issues, releases, Actions.",
    binary: "gh",
    brewPkg: "gh",
    claudeMdHint:
      "GitHub CLI (`gh`) is installed. Use it for GitHub operations — auth via `gh auth login`.",
    docsUrl: "https://cli.github.com/",
  },
  {
    id: "okta",
    name: "Okta CLI",
    description: "Okta identity admin: users, groups, apps, policies.",
    binary: "okta",
    brewPkg: "okta/tap/okta-cli",
    claudeMdHint:
      "Okta CLI (`okta`) is installed. Run `okta --help` to see commands. Auth via `okta login`.",
    docsUrl: "https://cli.okta.com/",
  },
  {
    id: "mgc",
    name: "Microsoft Graph CLI",
    description: "M365/Entra admin: users, groups, licenses, mailboxes.",
    binary: "mgc",
    brewPkg: "microsoftgraph/tap/msgraph-cli",
    claudeMdHint:
      "Microsoft Graph CLI (`mgc`) is installed. Run `mgc --help` to see commands. Auth via `mgc login`.",
    docsUrl: "https://learn.microsoft.com/graph/cli/overview",
  },
  {
    id: "op",
    name: "1Password CLI",
    description: "Secrets management, item access, service accounts.",
    binary: "op",
    brewPkg: "1password-cli",
    claudeMdHint:
      "1Password CLI (`op`) is installed. Use `op item get`, `op read op://...` for secrets. Run `op --help` for the full surface.",
    docsUrl: "https://developer.1password.com/docs/cli/",
  },
];

export const PINKFISH_CONNECTIONS_URL = "https://app.pinkfish.ai/connections";

export function findEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.id === id);
}
