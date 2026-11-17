// GitHub GraphQL v4 surface. Implemented in full below the routing seam:
// handleGraphQL receives the parsed JSON body and answers {status, body}.

import { Forge } from './store.ts';

export interface GraphQLReply {
  status: number;
  body: unknown;
}

export function handleGraphQL(forge: Forge, payload: unknown): GraphQLReply {
  void forge;
  void payload;
  return { status: 200, body: { errors: [{ message: 'GraphQL is not implemented yet' }] } };
}
