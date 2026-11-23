import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/** Fetch `url` with `params`; refetches when params change. Returns { data, error, loading, reload }. */
export function useFetch(url, params, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled });
  const key = JSON.stringify(params || {});
  const seq = useRef(0);

  const load = useCallback(async () => {
    if (!enabled || !url) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await api.get(url, JSON.parse(key));
      if (id === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === seq.current) setState({ data: null, error, loading: false });
    }
  }, [url, key, enabled]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

/** Active items, optionally restricted to a ledger, for item pickers. */
export function useItems(ledger) {
  return useFetch('/items', { status: 'ACTIVE', ledger });
}
