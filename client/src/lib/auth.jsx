import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, refresh, setToken } from './api.js';

const AuthContext = createContext(null);

// Who is signed in. On load it tries the refresh cookie, so a returning
// visitor is signed straight back in.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    refresh()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const start = useCallback((r) => {
    setToken(r.accessToken);
    setUser(r.user);
    return r.user;
  }, []);

  const login = useCallback((email, password) => api('POST', '/auth/login', { email, password }).then(start), [start]);
  const register = useCallback(
    (email, password, displayName) => api('POST', '/auth/register', { email, password, displayName }).then(start),
    [start],
  );
  const logout = useCallback(async () => {
    await api('POST', '/auth/logout').catch(() => {});
    setToken(null);
    setUser(null);
  }, []);

  return <AuthContext.Provider value={{ user, setUser, ready, login, register, logout }}>{children}</AuthContext.Provider>;
}

export const useAuth = () => useContext(AuthContext);
