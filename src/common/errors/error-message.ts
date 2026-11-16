/**
 * Con `strict`, lo que llega a un `catch` es `unknown`: puede ser un `Error`,
 * un error de Firebase con `code`/`status`, o cualquier valor. Estos helpers
 * leen lo que haga falta sin asumir la forma.
 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String(error.message);
  }
  return String(error);
}

export function errorStatus(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return typeof error.status === 'number' ? error.status : undefined;
  }
  return undefined;
}

/** El `code` de un error de proveedor (Firebase: `auth/id-token-expired`...). */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return typeof error.code === 'string' ? error.code : undefined;
  }
  return undefined;
}
