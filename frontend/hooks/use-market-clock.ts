'use client';

/**
 * useMarketClock — UTC clock and trading-session state for the session badges
 * and the XAUUSD panel. Sessions are indicative reference windows in UTC.
 */

import { useEffect, useState } from 'react';
import { activeSessions, currentSessionLabel, isLondonNewYorkOverlap, isWeekendClosed } from '@tradepilot/shared';

export const SESSION_WINDOWS = [
  { id: 'SYDNEY', label: 'Sydney', start: '21:00', end: '06:00' },
  { id: 'ASIAN', label: 'Asian', start: '00:00', end: '08:00' },
  { id: 'LONDON', label: 'London', start: '07:00', end: '16:00' },
  { id: 'NEW_YORK', label: 'New York', start: '12:00', end: '21:00' },
] as const;

export interface MarketClock {
  utcTime: string;
  activeSessions: ReturnType<typeof activeSessions>;
  label: string;
  weekendClosed: boolean;
  londonNewYorkOverlap: boolean;
}

export function useMarketClock(): MarketClock {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return {
    utcTime: now.toISOString().slice(11, 19),
    activeSessions: activeSessions(now),
    label: currentSessionLabel(now),
    weekendClosed: isWeekendClosed(now),
    londonNewYorkOverlap: isLondonNewYorkOverlap(now),
  };
}
