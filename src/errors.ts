export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'LAST_OWNER',
  'ALREADY_MEMBER',
  'INVITATION_INVALID',
  'INVITATION_EMAIL_MISMATCH',
  'FEATURE_NOT_AVAILABLE',
  'INVALID_CREDENTIALS',
  'EMAIL_TAKEN',
  'REFRESH_REUSED',
  'RATE_LIMITED',
  'TENANT_NOT_FOUND',
  'TENANT_NOT_READY',
  'TENANT_SUSPENDED',
  'SLUG_INVALID',
  'SLUG_RESERVED',
  'SLUG_TAKEN',
  'TENANT_PROVISION_FAILED',
  'TENANT_LIMIT_REACHED',
  'TOKEN_INVALID',
  'NOT_FOUND',
  'MIGRATION_CHECKSUM_MISMATCH',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** An error that is safe to show to API clients: it maps to an HTTP status and a stable code. */
export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, statusCode: number, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}
