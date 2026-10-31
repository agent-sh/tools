import { batchToolDefinition, executeBatch, safeParseBatchParams } from "@agent-sh/harness-batch";
import { formatToolError, toolError } from "@agent-sh/harness-core";
import type { ToolExecutor } from "./agent.js";

export function makeBatchExecutor(workspaceRoot: string): ToolExecutor {
  return {
    tool: { type: "function", function: {
      name: batchToolDefinition.name,
      description: batchToolDefinition.description,
      parameters: batchToolDefinition.inputSchema as unknown as Record<string, unknown>,
    } },
    async execute(input) {
      const parsed = safeParseBatchParams(input);
      if (!parsed.ok) return formatToolError(toolError("INVALID_PARAM", parsed.issues.map((issue) => issue.message).join("; ")));
      return JSON.stringify(await executeBatch(parsed.value, workspaceRoot));
    },
  };
}
