import { McpToolDef } from './tool.types';

export interface PreviewEnvelope {
  requiresConfirmation: true;
  action: string;
  description: string;
  kind: 'write' | 'destructive';
  destructive: boolean;
  preview: unknown;
  instructions: string;
}

/**
 * Envelope returned by every mutating tool that was called without
 * `confirm: true`. Consumers (the phase-2 copilot, external MCP clients)
 * show `preview` to a human and re-call the tool with the same arguments
 * plus `confirm: true` only after explicit approval.
 */
export function buildPreviewEnvelope(def: McpToolDef, preview: unknown): PreviewEnvelope {
  return {
    requiresConfirmation: true,
    action: def.name,
    description: def.description,
    kind: def.kind as 'write' | 'destructive',
    destructive: def.kind === 'destructive',
    preview,
    instructions:
      'This action was NOT executed. Show the preview to the user and ask for approval. ' +
      'Only after the user explicitly confirms, call this tool again with the same arguments plus confirm: true.',
  };
}
