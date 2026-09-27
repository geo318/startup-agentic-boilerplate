/**
 * Tuple-style async error handling: `[data, null]` on success, `[null, error]` on failure.
 * Prefer ordinary try/catch for transactions, rollbacks, or multi-step recovery.
 */
export async function tryCatch<T>(
  promise: Promise<T>,
  onFinally?: () => void | Promise<void>,
): Promise<[T, null] | [null, Error]> {
  try {
    const data = await promise;
    return [data, null];
  } catch (error) {
    return [null, error instanceof Error ? error : new Error(String(error), { cause: error })];
  } finally {
    await onFinally?.();
  }
}
