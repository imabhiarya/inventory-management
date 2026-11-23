import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, setUnauthorizedHandler } from '../api.js';

const AppContext = createContext(null);

export function AppProvider({ children }) {
  const [user, setUser] = useState(null);
  const [meta, setMeta] = useState(null); // { settings, ledgers, today, currentFy }
  const [loading, setLoading] = useState(true);

  const loadMeta = useCallback(async () => {
    setMeta(await api.get('/settings'));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
    (async () => {
      try {
        const { user: u } = await api.get('/auth/me');
        setUser(u);
        await loadMeta();
      } catch {
        setUser(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [loadMeta]);

  const login = useCallback(
    async (username, password) => {
      const { user: u } = await api.post('/auth/login', { username, password });
      await loadMeta();
      setUser(u);
    },
    [loadMeta],
  );

  const logout = useCallback(async () => {
    await api.post('/auth/logout').catch(() => {});
    setUser(null);
  }, []);

  const value = useMemo(() => {
    const ledgerLabel = (key) => (meta?.allLedgers || meta?.ledgers)?.find((l) => l.key === key)?.label || key;
    return {
      user,
      meta,
      settings: meta?.settings,
      loading,
      login,
      logout,
      reloadMeta: loadMeta,
      ledgerLabel,
      canWrite: user && ['admin', 'storekeeper'].includes(user.role),
      isAdmin: user?.role === 'admin',
    };
  }, [user, meta, loading, login, logout, loadMeta]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export const useApp = () => useContext(AppContext);
