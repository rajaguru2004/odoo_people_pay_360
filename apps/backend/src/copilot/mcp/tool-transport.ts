/**
 * Abstraction over "where the copilot's tools live". The default production
 * implementation speaks MCP over loopback HTTP to this same backend's /mcp
 * endpoint (dogfooding the exact contract external MCP clients use); tests
 * bind an in-memory fake to the same token.
 */
export const COPILOT_TOOL_TRANSPORT = Symbol('COPILOT_TOOL_TRANSPORT');

/** Auth material from the requesting user's HTTP request. The HTTP transport
 *  forwards `authorization`/`branchId`; the in-process transport uses `user`. */
export interface AuthForwardContext {
  authorization: string;
  branchId?: string;
  /** Resolved principal (req.user) — used by the in-process transport. */
  user?: import('../../mcp/tool.types').HrmPrincipal;
}

export interface CopilotTool {
  name: string;
  description?: string;
  inputSchema?: any; // JSON Schema
}

export interface CopilotToolTransport {
  listTools(auth: AuthForwardContext): Promise<CopilotTool[]>;
  /** Returns the parsed tool result payload (already JSON-decoded). */
  callTool(auth: AuthForwardContext, name: string, args: Record<string, unknown>): Promise<any>;
}
