import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, createUpdateChecker, readPackageInfo } from "../src/updates.js";

const release = (tag, extra = {}) => ({
  tag_name: tag, name: tag, body: `- Change in ${tag}`, html_url: `https://example.test/${tag}`,
  published_at: "2026-12-01T00:00:00Z", draft: false, prerelease: false, ...extra,
});

function fakeFetch(releases, counter = { calls: 0 }) {
  return async () => {
    counter.calls++;
    return { ok: true, json: async () => releases };
  };
}

test("compares versions numerically", () => {
  assert.ok(compareVersions("v0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.equal(compareVersions("not-a-version", "1.0.0"), 0);
});

test("lists every newer published release, newest first", async () => {
  const checker = createUpdateChecker({
    repo: "owner/repo",
    currentVersion: "0.1.0",
    fetchImpl: fakeFetch([
      release("v0.1.0"), release("v0.3.0"), release("v0.2.0"),
      release("v0.4.0", { draft: true }), release("v0.5.0-beta", { prerelease: true }),
    ]),
  });
  const result = await checker.check();
  assert.equal(result.available, true);
  assert.equal(result.latest, "0.3.0");
  assert.deepEqual(result.releases.map((r) => r.version), ["0.3.0", "0.2.0"]);
  assert.equal(result.releases[1].notes, "- Change in v0.2.0");
});

test("reports no update when current and caches the answer", async () => {
  const counter = { calls: 0 };
  let time = 0;
  const checker = createUpdateChecker({
    repo: "owner/repo", currentVersion: "0.3.0", fetchImpl: fakeFetch([release("v0.3.0")], counter), now: () => time,
  });
  assert.equal((await checker.check()).available, false);
  time += 60_000;
  await checker.check();
  assert.equal(counter.calls, 1);
  time += 7 * 60 * 60 * 1000;
  await checker.check();
  assert.equal(counter.calls, 2);
});

test("network failures are reported quietly", async () => {
  const checker = createUpdateChecker({
    repo: "owner/repo", currentVersion: "0.1.0", fetchImpl: async () => { throw new Error("offline"); },
  });
  const result = await checker.check();
  assert.equal(result.available, false);
  assert.equal(result.error, "offline");
});

test("reads this project's version and GitHub repository", () => {
  const { version, repo } = readPackageInfo();
  assert.match(version, /^\d+\.\d+\.\d+/);
  assert.equal(repo, "logmannn/speaktoall");
});
