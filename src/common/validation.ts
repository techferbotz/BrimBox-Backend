import { BadRequestError } from "./errors/AppError";

// Small, shared input validators (Billanta's helpers). Controllers use these to check the SHAPE of
// a request before handing it to a service — business rules stay in the service layer.

// Require a JSON object body. express.json() leaves `{}` for an empty body, but a client can still
// send an array or a primitive.
export const requireObjectBody = (body: unknown): Record<string, unknown> => {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BadRequestError("Request body must be a JSON object");
  }
  return body as Record<string, unknown>;
};

/**
 * Require a non-empty string field, returning it trimmed.
 *
 * Rejects a non-string as well as a missing value: JSON bodies are attacker-controlled, so
 * `{"idToken": {"$ne": null}}` or `{"name": 123}` must never flow into a query untyped.
 */
export const requireString = (value: unknown, field: string, maxLength = 500): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BadRequestError(`"${field}" is required and must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new BadRequestError(`"${field}" must be at most ${maxLength} characters`);
  }
  return trimmed;
};

/**
 * Read an optional string field. Absent → undefined ("not sent"); null or blank → null ("clear
 * it"); otherwise the trimmed string.
 */
export const optionalString = (
  value: unknown,
  field: string,
  maxLength = 500
): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new BadRequestError(`"${field}" must be a string or null`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > maxLength) {
    throw new BadRequestError(`"${field}" must be at most ${maxLength} characters`);
  }
  return trimmed;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A UUID path parameter. A malformed id can't name anything, so it is a 404 rather than a 400 —
// the same answer as an id that doesn't exist (or belongs to someone else).
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);
