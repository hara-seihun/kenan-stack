import type { ErrorCode } from '../../shared/contract.js';

/** A plain, expected failure with a contract error code. Anything else thrown is `internal`. */
export class AppFailure extends Error {
  constructor(readonly code: ErrorCode, message: string) { super(message); }
}

export const fail = (code: ErrorCode, message: string): never => { throw new AppFailure(code, message); };

/** Map errors (including pg errors) to a contract error code. */
export function errorCode(e: unknown): ErrorCode {
  if (e instanceof AppFailure) return e.code;
  switch ((e as { code?: unknown })?.code) {
    case '23505': return 'conflict';          // unique_violation
    case '23503': return 'invalid_input';     // foreign_key_violation (unknown person/conversation)
    case '22P02': return 'invalid_input';     // invalid_text_representation (bad uuid)
    case '23514': return 'invalid_input';     // check_violation
    default: return 'internal';
  }
}
