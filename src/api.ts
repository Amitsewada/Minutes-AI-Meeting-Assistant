import { useCallback, useEffect, useState } from 'react';
import { validResponse } from './contracts';

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(message: string, code = 'REQUEST_FAILED', status = 0) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  const timeout = AbortSignal.timeout(30000);
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      ...options,
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
  } catch (error) {
    if (timeout.aborted) throw new ApiError('The server took too long to respond. Check your connection and try again.', 'REQUEST_TIMEOUT');
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('Cannot reach the server. Check that the backend is running, then try again.', 'NETWORK_ERROR');
  }
  if (response.status === 204) return undefined as T;
  let data;
  try { data = await response.json(); } catch {
    throw new ApiError('The server returned an unreadable response. Please try again.', 'INVALID_RESPONSE', response.status);
  }
  if (!response.ok) {
    let message = typeof data?.error === 'string' ? data.error : typeof data?.error?.message === 'string' ? data.error.message : 'The request could not be completed.';
    if (Array.isArray(data?.details)) {
      const details = data.details.filter((item: unknown): item is { path: string; message: string } => Boolean(item && typeof item === 'object' && 'path' in item && 'message' in item && typeof item.path === 'string' && typeof item.message === 'string'));
      if (details.length) message = details.slice(0, 4).map((item: { path: string; message: string }) => `${item.path || 'Input'}: ${item.message}`).join(' ');
    }
    throw new ApiError(message, data?.error?.code ?? data?.code, response.status);
  }
  if (!validResponse(path, options.method || 'GET', data)) throw new ApiError('The server returned unexpected data. Please try again; no changes have been shown.', 'INVALID_RESPONSE', response.status);
  return data as T;
}

export const json = (body: unknown, method = 'POST'): RequestInit => ({ method, body: JSON.stringify(body) });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
export function queryString(values: Record<string, string>) { return new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '')).toString(); }

export function useResource<T>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    if (!path) { setLoading(false); return; }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api<T>(path, { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) setData(value);
    }).catch(error => {
      if (!controller.signal.aborted) setError(errorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => { controller.abort(); };
  }, [path, revision]);
  return { data, error, loading, refresh, setData };
}

export function useDebounce(value: string, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setDebounced(value), delay); return () => clearTimeout(timer); }, [value, delay]);
  return debounced;
}
