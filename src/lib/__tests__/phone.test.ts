import { describe, it, expect } from 'vitest';
import { normalizePhone } from '../phone';

describe('normalizePhone', () => {
  it('normalizes a 10-digit local MX number', () => {
    expect(normalizePhone('5512345678')).toBe('+525512345678');
  });

  it('normalizes a number with spaces', () => {
    expect(normalizePhone('55 1234 5678')).toBe('+525512345678');
  });

  it('normalizes a number with dashes', () => {
    expect(normalizePhone('55-1234-5678')).toBe('+525512345678');
  });

  it('normalizes a number with country code +52', () => {
    expect(normalizePhone('+525512345678')).toBe('+525512345678');
  });

  it('normalizes a number with country code 52', () => {
    expect(normalizePhone('525512345678')).toBe('+525512345678');
  });

  it('returns null for an empty string', () => {
    expect(normalizePhone('')).toBeNull();
  });

  it('returns null for a whitespace-only string', () => {
    expect(normalizePhone('   ')).toBeNull();
  });

  it('returns null for a non-numeric string', () => {
    expect(normalizePhone('not-a-phone')).toBeNull();
  });

  it('returns null for a too-short number', () => {
    expect(normalizePhone('12345')).toBeNull();
  });

  it('returns null for a clearly invalid format', () => {
    // 15 digits — too long for any valid number
    expect(normalizePhone('555123456789012')).toBeNull();
  });
});
