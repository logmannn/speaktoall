// Checks GitHub Releases for newer versions. Nothing is downloaded or installed;
// the host page shows a notice with release notes and a download link.
import { readFileSync } from "node:fs";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RETRY_AFTER_ERROR_MS = 30 * 60 * 1000;

function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/.exec(String(version).trim());
  return match && { parts: match.slice(1, 4).map(Number), prerelease: match[4] || "" };
}

// Positive if a is newer than b. Unparseable versions never count as newer.
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  }
  if (left.prerelease === right.prerelease) return 0;
  return left.prerelease ? -1 : 1; // 1.0.0 is newer than 1.0.0-beta
}

export function readPackageInfo() {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const repository = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url || "";
  const repo = /github(?:\.com[/:]|:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(repository)?.[1] || null;
  return { version: pkg.version, repo };
}

export function createUpdateChecker({ repo, currentVersion, fetchImpl = fetch, now = Date.now }) {
  let cached = null;
  let checkedAt = 0;
  let pending = null;

  async function fetchReleases() {
    const response = await fetchImpl(`https://api.github.com/repos/${repo}/releases?per_page=20`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "speaktoall-update-check" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const releases = (await response.json())
      .filter((release) => !release.draft && !release.prerelease && compareVersions(release.tag_name, currentVersion) > 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
      .map((release) => ({
        version: release.tag_name.replace(/^v/, ""),
        name: release.name || release.tag_name,
        notes: String(release.body || "").slice(0, 20000),
        url: release.html_url,
        publishedAt: release.published_at,
      }));
    return {
      current: currentVersion,
      available: releases.length > 0,
      latest: releases[0]?.version || null,
      url: releases[0]?.url || null,
      releases,
    };
  }

  return {
    async check() {
      if (!repo) return { current: currentVersion, available: false };
      const age = now() - checkedAt;
      if (cached && age < (cached.error ? RETRY_AFTER_ERROR_MS : CHECK_INTERVAL_MS)) return cached;
      pending ??= fetchReleases()
        .catch((error) => ({ current: currentVersion, available: false, error: error.message }))
        .then((result) => {
          cached = result;
          checkedAt = now();
          pending = null;
          return result;
        });
      return pending;
    },
  };
}

export function defaultUpdateChecker(env = process.env) {
  const { version, repo } = readPackageInfo();
  return createUpdateChecker({ repo: env.SPEAKTOALL_NO_UPDATE_CHECK ? null : repo, currentVersion: version });
}
