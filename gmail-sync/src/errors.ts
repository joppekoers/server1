export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const toError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)));

export const attempt = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch(toError);

export function parseJson<T>(text: string): T | Error {
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    return toError(error);
  }
}

export async function readJson<T>(res: Response): Promise<T | Error> {
  const text = await attempt(res.text());
  return text instanceof Error ? text : parseJson<T>(text);
}

export function exitOnError<T>(value: T | Error): T {
  if (value instanceof Error) {
    console.error("Fatal:", value);
    process.exit(1);
  }
  return value;
}
