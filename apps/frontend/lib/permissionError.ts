/**
 * A 403 is raised from inside the axios interceptor, which has no React tree to
 * render into. This tiny pub/sub is the bridge: the interceptor publishes, and
 * a single mounted modal subscribes.
 */
type Listener = (message?: string) => void;

const listeners = new Set<Listener>();

export function onPermissionError(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function triggerPermissionError(message?: string): void {
  listeners.forEach((fn) => fn(message));
}
