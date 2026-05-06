/**
 * Base class for all origin-ai errors.
 */
export class OriginAiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status?: number,
    public readonly traceId?: string,
    public readonly responseBody?: unknown
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when environment variables are missing or invalid.
 */
export class OriginAiConfigError extends OriginAiError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
  }
}

/**
 * Thrown when 401/403 is returned.
 */
export class OriginAiAuthError extends OriginAiError {
  constructor(message: string, status: number, traceId?: string) {
    super(message, 'AUTH_ERROR', status, traceId);
  }
}

/**
 * Thrown on AbortError or timeout.
 */
export class OriginAiTimeoutError extends OriginAiError {
  constructor(message: string, traceId?: string) {
    super(message, 'TIMEOUT_ERROR', 408, traceId);
  }
}

/**
 * Thrown on fetch reject, DNS, or connection issues.
 */
export class OriginAiNetworkError extends OriginAiError {
  constructor(message: string, traceId?: string) {
    super(message, 'NETWORK_ERROR', undefined, traceId);
  }
}

/**
 * Thrown when 5xx is returned.
 */
export class OriginAiServerError extends OriginAiError {
  constructor(message: string, status: number, traceId?: string, responseBody?: unknown) {
    super(message, 'SERVER_ERROR', status, traceId, responseBody);
  }
}

/**
 * Thrown when 4xx (except 401/403/408) is returned.
 */
export class OriginAiClientError extends OriginAiError {
  constructor(message: string, status: number, traceId?: string, responseBody?: unknown) {
    super(message, 'CLIENT_ERROR', status, traceId, responseBody);
  }
}

/**
 * Thrown for any other unknown errors.
 */
export class OriginAiUnknownError extends OriginAiError {
  constructor(message: string, traceId?: string, originalError?: unknown) {
    super(message, 'UNKNOWN_ERROR', undefined, traceId, originalError);
  }
}
