import { apiPath } from './path.js';
import { errorStatus, type ErrorCode, type Result } from '../shared/contract.js';

/**
 * `unreachable`: no answer from Kenan itself. The network failed, or something in front of it (the entrance during a
 * restart, a captive portal) answered with a page instead of Kenan's JSON. Its body is never shown or parsed.
 */
export type ApiErrorCode = ErrorCode | 'unreachable';
export class ApiError extends Error { constructor(public code: ApiErrorCode, message: string) { super(message); } }

const ERROR_CODES = new Set<string>(Object.keys(errorStatus));
const unreachable = (detail: string) => new ApiError('unreachable', `Can't reach Kenan right now (${detail}). It reconnects by itself.`);

/** Kenan's answer or a typed error; anything that isn't Kenan's `Result` JSON is `unreachable`. */
export async function readResult<T>(response: Response): Promise<T> {
  if (!(response.headers.get('content-type') ?? '').includes('application/json')) throw unreachable(`HTTP ${response.status}`);
  let body: unknown;
  try { body = await response.json(); } catch { throw unreachable(`HTTP ${response.status}, unreadable reply`); }
  const result = body as Partial<Result<T>> | null;
  if (result?.ok === true && 'value' in result) return result.value as T;
  const error = result?.ok === false ? (result as { error?: { code?: unknown; message?: unknown } }).error : undefined;
  if (typeof error?.code === 'string' && ERROR_CODES.has(error.code) && typeof error.message === 'string') throw new ApiError(error.code as ErrorCode, error.message);
  throw unreachable(`HTTP ${response.status}, unexpected reply`);
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiPath('/api' + path), {
      method, credentials: 'same-origin',
      headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch { throw unreachable('no connection'); }
  return readResult<T>(response);
}

export const isUnreachable = (error: unknown): boolean => error instanceof ApiError && error.code === 'unreachable';
