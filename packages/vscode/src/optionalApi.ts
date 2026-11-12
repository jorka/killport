/**
 * Reads a VS Code API that may not exist in older versions.
 *
 * A plain `if (vscode.window.someNewApi)` is not enough: in versions where the API was still a
 * *proposal*, reading or using it throws "CANNOT use API proposal", which would stop the whole
 * extension from activating. (In 1.90-1.92 the terminal shell execution events exist, but
 * subscribing to them throws; see optionalEvent.)
 */
export function optionalApi<T>(read: () => T): T | undefined {
  try {
    return read() ?? undefined;
  } catch {
    return undefined;
  }
}

/** Subscribes to an event that may be missing or proposal-only; returns undefined if that fails. */
export function optionalEvent<T>(
  read: () => ((listener: (e: T) => unknown) => { dispose(): unknown }) | undefined,
  listener: (e: T) => unknown,
): { dispose(): unknown } | undefined {
  try {
    const event = read();
    return event ? event(listener) : undefined;
  } catch {
    return undefined;
  }
}
