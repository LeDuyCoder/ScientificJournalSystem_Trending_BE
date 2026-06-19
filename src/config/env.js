/**
 * Read an environment variable and convert it to a number.
 *
 * @param {string} name - Environment variable name.
 * @param {number} defaultValue - Value returned when env is missing or invalid.
 * @returns {number}
 */
export function getEnvNumber(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = Number(raw);
  return Number.isNaN(n) ? defaultValue : n;
}

/**
 * Read a required environment variable.
 *
 * @param {string} name - Environment variable name.
 * @returns {string}
 * @throws {Error} If the env var is missing.
 */
export function getEnvRequired(name) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return raw;
}

/**
 * Read an optional environment variable.
 *
 * Used for local dev when DB env vars are not configured yet.
 * If the value is missing, returns the provided `defaultValue` (default: undefined)
 * instead of throwing.
 *
 * @param {string} name - Environment variable name.
 * @param {string|undefined} [defaultValue] - Returned value when env var is missing.
 * @returns {string|undefined}
 */
export function getEnvOptional(name, defaultValue = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return raw;
}



