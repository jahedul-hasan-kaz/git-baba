import { useCallback, useEffect, useRef, useState } from 'react';
import type { FriendlyError } from '../../shared/types';
import { toFriendly } from '../services/api';

/** Loads data and re-runs when deps change. Errors are captured, never thrown. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    const mySeq = ++seq.current;
    setLoading(true);
    try {
      const d = await fn();
      if (mySeq === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (err) {
      if (mySeq === seq.current) setError(toFriendly(err));
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}

/** Wraps an action with a busy flag. */
export function useBusy() {
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      return await fn();
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, run };
}
