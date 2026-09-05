type Handler = (message: string) => void;

let _handler: Handler | null = null;

export function registerPermissionErrorHandler(fn: Handler) {
  _handler = fn;
}

export function triggerPermissionError(message?: string) {
  _handler?.(
    message ?? "You don't have permission to perform this action.",
  );
}
