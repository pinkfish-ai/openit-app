// Build-time helper. Fetches the latest GH release once during `astro build`
// (or at dev-server start). If the repo has no releases yet, returns a
// pending placeholder so the page still renders.

const REPO = "pinkfish-ai/openit-app";

export interface ReleaseInfo {
  available: boolean;
  version: string;
  arm64DmgUrl: string | null;
  x64DmgUrl: string | null;
  releaseUrl: string | null;
}

export async function getLatestRelease(): Promise<ReleaseInfo> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) {
      return pending();
    }
    const data = (await res.json()) as {
      tag_name: string;
      html_url: string;
      assets: Array<{ name: string; browser_download_url: string }>;
    };
    const findAsset = (suffix: string) =>
      data.assets.find((a) => a.name.endsWith(suffix))?.browser_download_url ?? null;
    return {
      available: true,
      version: data.tag_name.replace(/^v/, ""),
      arm64DmgUrl: findAsset("_aarch64.dmg"),
      x64DmgUrl: findAsset("_x64.dmg"),
      releaseUrl: data.html_url,
    };
  } catch {
    return pending();
  }
}

function pending(): ReleaseInfo {
  return {
    available: false,
    version: "0.1.0",
    arm64DmgUrl: null,
    x64DmgUrl: null,
    releaseUrl: null,
  };
}
