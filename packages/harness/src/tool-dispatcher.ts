import type { ToolContext, ToolDefinition } from "@poncho-ai/sdk";

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolExecutionResult {
  callId: string;
  tool: string;
  output?: unknown;
  error?: string;
}

export class ToolDispatcher {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  registerMany(tools: ToolDefinition[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(call: ToolCall, context: ToolContext): Promise<ToolExecutionResult> {
    const definition = this.tools.get(call.name);
    if (!definition) {
      return {
        callId: call.id,
        tool: call.name,
        error: `Tool not found: ${call.name}`,
      };
    }

    try {
      const output = await definition.handler(call.input, context);
      return {
        callId: call.id,
        tool: call.name,
        output,
      };
    } catch (error) {
      return {
        callId: call.id,
        tool: call.name,
        error: error instanceof Error ? error.message : "Unknown tool error",
      };
    }
  }

  async executeBatch(
    calls: ToolCall[],
    context: ToolContext,
  ): Promise<ToolExecutionResult[]> {
    return Promise.all(calls.map(async (call) => this.execute(call, context)));
  }
}
