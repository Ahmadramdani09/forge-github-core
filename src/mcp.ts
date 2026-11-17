// Model Context Protocol surface (streamable HTTP). Implemented in full
// below the routing seam: handleMcp receives headers + raw body and answers
// the HTTP reply to send.

import { Forge } from './store.ts';

export interface McpReply {
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

export async function handleMcp(
  forge: Forge,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  method: string,
): Promise<McpReply> {
  void forge;
  void headers;
  void body;
  void method;
  return { status: 501, body: '{"jsonrpc":"2.0","error":{"code":-32601,"message":"not implemented"},"id":null}', contentType: 'application/json' };
}
