import { describe, it, expect } from 'vitest';
import { isInCallingWindow, isMorningSlot, nextDayOppositeSlot } from '../calling-window';

// Helper: build a Date as if it's a specific MX time
// We create a UTC date that corresponds to a given MX CST (UTC-6) time
function mxTime(hour: number, minute = 0, dayOffset = 0): Date {
  // Base date: 2025-07-08 (Tuesday) — arbitrary weekday
  const base = new Date(Date.UTC(2025, 6, 8 + dayOffset, hour + 6, minute, 0));
  return base;
}

describe('isInCallingWindow', () => {
  it('returns true at 09:00 MX', () => {
    expect(isInCallingWindow(mxTime(9, 0))).toBe(true);
  });

  it('returns true at 12:30 MX', () => {
    expect(isInCallingWindow(mxTime(12, 30))).toBe(true);
  });

  it('returns true at 20:59 MX', () => {
    expect(isInCallingWindow(mxTime(20, 59))).toBe(true);
  });

  it('returns false at 21:00 MX', () => {
    expect(isInCallingWindow(mxTime(21, 0))).toBe(false);
  });

  it('returns false at 08:59 MX', () => {
    expect(isInCallingWindow(mxTime(8, 59))).toBe(false);
  });

  it('returns false at midnight MX', () => {
    expect(isInCallingWindow(mxTime(0, 0))).toBe(false);
  });
});

describe('isMorningSlot', () => {
  it('returns true at 09:00 MX', () => {
    expect(isMorningSlot(mxTime(9, 0))).toBe(true);
  });

  it('returns true at 14:59 MX', () => {
    expect(isMorningSlot(mxTime(14, 59))).toBe(true);
  });

  it('returns false at 15:00 MX', () => {
    expect(isMorningSlot(mxTime(15, 0))).toBe(false);
  });

  it('returns false at 20:00 MX', () => {
    expect(isMorningSlot(mxTime(20, 0))).toBe(false);
  });
});

describe('nextDayOppositeSlot', () => {
  it('returns next day 15:00 MX for a morning call', () => {
    const morningCall = mxTime(10, 0); // 10:00 MX
    const result = nextDayOppositeSlot(morningCall);
    // Result should be in the afternoon slot (hour 15 in MX)
    const resultHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(result);
    expect(parseInt(resultHour, 10)).toBe(15);
  });

  it('returns next day 09:00 MX for an afternoon call', () => {
    const afternoonCall = mxTime(16, 0); // 16:00 MX
    const result = nextDayOppositeSlot(afternoonCall);
    const resultHour = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Mexico_City',
      hour: 'numeric',
      hour12: false,
    }).format(result);
    expect(parseInt(resultHour, 10)).toBe(9);
  });

  it('is always in the future relative to the input date', () => {
    const now = mxTime(10, 0);
    const result = nextDayOppositeSlot(now);
    expect(result.getTime()).toBeGreaterThan(now.getTime());
  });
});
