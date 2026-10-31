import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { safeParseBatchParams, executeBatch } from "../src/index.js";
import type { BatchParams } from "../src/types.js";

describe("batch schema", () => {
  it("parses valid subdirs targets", () => {
    const result = safeParseBatchParams({
      command: "echo $TARGET",
      targets: { kind: "subdirs", path: "/tmp/test-batch" },
    });
    expect(result.ok).toBe(true);
  });

  it("parses valid glob targets", () => {
    const result = safeParseBatchParams({
      command: "ls",
      targets: { kind: "glob", pattern: "/tmp/test-batch/*" },
    });
    expect(result.ok).toBe(true);
  });

  it("parses valid explicit targets", () => {
    const result = safeParseBatchParams({
      command: "pwd",
      targets: { kind: "explicit", paths: ["/tmp", "/var"] },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects empty command", () => {
    const result = safeParseBatchParams({
      command: "",
      targets: { kind: "subdirs", path: "/tmp" },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects missing targets", () => {
    const result = safeParseBatchParams({
      command: "echo hello",
    });
    expect(result.ok).toBe(false);
  });

  it.each([
    '{"kind":"explicit","paths":["/workspace/a"]}',
    { mode: "explicit", paths: ["/workspace/a"] },
    { kind: "explicit", paths: [], command: "pwd" },
  ])("rejects malformed selectors with an object recovery example", (targets) => {
    const result = safeParseBatchParams({ command: "pwd", targets });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const message = result.issues.map((issue) => issue.message).join(" ");
      expect(message).toContain('kind: "explicit"');
      expect(message).toContain("not a JSON string");
      expect(message).toContain("mode is only for sequential/parallel");
    }
  });

  it("rejects empty explicit paths", () => {
    const result = safeParseBatchParams({
      command: "echo hello",
      targets: { kind: "explicit", paths: [] },
    });
    expect(result.ok).toBe(false);
  });

  it("accepts optional params", () => {
    const result = safeParseBatchParams({
      command: "echo hello",
      targets: { kind: "explicit", paths: ["/tmp"] },
      mode: "parallel",
      max_concurrent: 8,
      timeout_secs: 60,
      fail_fast: true,
      summary_only: true,
    });
    expect(result.ok).toBe(true);
  });
});

describe("batch execution", () => {
  let testDir: string;
  let subdirs: string[];

  beforeAll(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "batch-test-"),
    );
    subdirs = ["repo-a", "repo-b", "repo-c"];
    for (const name of subdirs) {
      await fs.mkdir(path.join(testDir, name));
      await fs.writeFile(
        path.join(testDir, name, "marker.txt"),
        name,
      );
    }
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("preserves brace alternatives when resolving directory targets", async () => {
    const result = await executeBatch({
      command: "cat marker.txt",
      targets: { kind: "glob", pattern: path.join(testDir, "repo-{a,c}") },
      mode: "sequential",
    });
    expect((result.meta.targets as any[]).map((target) => target.path)).toEqual([
      path.join(testDir, "repo-a"),
      path.join(testDir, "repo-c"),
    ]);
  });

  it("handles deeply nested brace alternatives without failing resolution", async () => {
    const pattern = path.join(testDir, "{a,".repeat(4096) + "b" + "}".repeat(4096));
    const result = await executeBatch({
      command: "true",
      targets: { kind: "glob", pattern },
      mode: "sequential",
    });
    expect(result.message).toBe("No matching targets found.");
    expect(result.meta).toEqual({});
  });

  it("keeps a literal directory as one target instead of expanding its children", async () => {
    const result = await executeBatch({
      command: "pwd",
      targets: { kind: "glob", pattern: testDir },
      mode: "sequential",
    });
    expect((result.meta.targets as any[]).map((target) => target.path)).toEqual([
      testDir,
    ]);
  });

  it("runs command in each subdirectory (sequential)", async () => {
    const params: BatchParams = {
      command: "cat marker.txt",
      targets: { kind: "subdirs", path: testDir },
      mode: "sequential",
    };

    const result = await executeBatch(params);
    expect(result.message).toContain("Batch complete: 3 targets");
    expect(result.meta.targets).toHaveLength(3);

    const targets = result.meta.targets as any[];
    for (const t of targets) {
      expect(t.status).toBe("success");
    }
  });

  it("runs command in each subdirectory (parallel)", async () => {
    const params: BatchParams = {
      command: "cat marker.txt",
      targets: { kind: "subdirs", path: testDir },
      mode: "parallel",
      max_concurrent: 2,
    };

    const result = await executeBatch(params);
    expect(result.message).toContain("Batch complete: 3 targets");
    const targets = result.meta.targets as any[];
    expect(targets).toHaveLength(3);
  });

  it("captures failed targets", async () => {
    const params: BatchParams = {
      command: "false",
      targets: { kind: "subdirs", path: testDir },
      mode: "sequential",
    };

    const result = await executeBatch(params);
    const targets = result.meta.targets as any[];
    for (const t of targets) {
      expect(t.status).toBe("failed");
    }
  });

  it("fail_fast stops on first failure", async () => {
    const params: BatchParams = {
      command: "false",
      targets: { kind: "subdirs", path: testDir },
      mode: "sequential",
      fail_fast: true,
    };

    const result = await executeBatch(params);
    const targets = result.meta.targets as any[];
    expect(targets).toHaveLength(1);
    expect(targets[0].status).toBe("failed");
  });

  it("summary_only returns counts not details", async () => {
    const params: BatchParams = {
      command: "true",
      targets: { kind: "subdirs", path: testDir },
      mode: "sequential",
      summary_only: true,
    };

    const result = await executeBatch(params);
    expect(result.message).toContain("3/3 succeeded");
    expect(result.meta.summary).toBeDefined();
    expect(result.meta.targets).toBeUndefined();
  });

  it("handles explicit targets", async () => {
    const params: BatchParams = {
      command: "pwd",
      targets: {
        kind: "explicit",
        paths: [path.join(testDir, "repo-a"), path.join(testDir, "repo-b")],
      },
    };

    const result = await executeBatch(params);
    const targets = result.meta.targets as any[];
    expect(targets).toHaveLength(2);
  });

  it("handles non-existent explicit paths gracefully", async () => {
    const params: BatchParams = {
      command: "pwd",
      targets: {
        kind: "explicit",
        paths: ["/nonexistent/path/that/does/not/exist"],
      },
      summary_only: true,
    };

    const result = await executeBatch(params);
    // Should fail but not crash
    expect(result.message).toBeDefined();
  });
});

describe("name filtering", () => {
  let testDir: string;

  beforeAll(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "batch-filter-test-"),
    );
    await fs.mkdir(path.join(testDir, "repo-a"));
    await fs.mkdir(path.join(testDir, "repo-b"));
    await fs.mkdir(path.join(testDir, "other-c"));
  });

  afterAll(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("filters subdirs by name pattern", async () => {
    const result = await executeBatch({
      command: "true",
      targets: {
        kind: "subdirs",
        path: testDir,
        name_filter: "repo-*",
      },
      summary_only: true,
    });

    const summary = result.meta.summary as any;
    expect(summary.success).toBe(2);
  });

  it("filters subdirs by suffix pattern", async () => {
    const result = await executeBatch({
      command: "true",
      targets: {
        kind: "subdirs",
        path: testDir,
        name_filter: "*-a",
      },
      summary_only: true,
    });

    const summary = result.meta.summary as any;
    expect(summary).toBeDefined();
    expect(summary.success).toBe(1);
  });
});
