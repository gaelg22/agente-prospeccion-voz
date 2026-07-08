import { parsePhoneNumber, isValidPhoneNumber } from 'libphonenumber-js';

/**
 * Normalizes a raw phone string to E.164 format for Mexico (+52...).
 * Returns null if the number cannot be parsed or is not a valid MX number.
 */
export function normalizePhone(raw: string): string | null {
  try {
    if (!raw || raw.trim() === '') return null;

    const cleaned = raw.trim();

    // isValidPhoneNumber handles the MX default region
    if (!isValidPhoneNumber(cleaned, 'MX')) return null;

    const parsed = parsePhoneNumber(cleaned, 'MX');
    if (!parsed.isValid()) return null;

    return parsed.format('E.164');
  } catch {
    return null;
  }
}
