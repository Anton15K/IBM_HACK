export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'include',
    headers:
      body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = response.status === 204 ? '' : await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new ApiError(
      response.ok
        ? 'Backend returned invalid JSON'
        : `HTTP ${response.status}: invalid backend response`,
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiError(
      (data as { error?: string })?.error ?? `HTTP ${response.status}`,
      response.status,
    );
  return data as T;
}
