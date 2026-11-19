export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const isUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export const isRetryKey = value => typeof value === 'string' && /^[a-z0-9:_-]{8,128}$/i.test(value);

export function cleanText(value, maxLength, label, required = false) {
  if (value === undefined && !required) return '';
  if (typeof value !== 'string') throw new HttpError(422, `${label} must be text.`);
  const cleaned = value.replace(/\r\n?/g, '\n').trim();
  if ((required && !cleaned) || cleaned.length > maxLength || /[\x00-\x09\x0B-\x1F\x7F]/.test(cleaned)) {
    throw new HttpError(422, `${label} must ${required ? 'contain text and ' : ''}be at most ${maxLength} characters.`);
  }
  return cleaned;
}
