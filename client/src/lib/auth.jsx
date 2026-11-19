import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, get, refresh, setToken } from './api.js';
import { clearBoards } from './offline.js';

const AuthContext = createContext(null);

// Who is signed in. On load it tries the refresh cookie, so a returning
// visitor is signed straight back in. Also knows which sign-in methods the
// server offers (Google, phone codes, email).
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [providers, setProviders] = useState({ google: null, phone: false, email: false, testInbox: false });

  useEffect(() => {
    refresh()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
    get('/auth/providers').then(setProviders).catch(() => {});
  }, []);

  const start = useCallback((r) => {
    if (!r?.accessToken) return r; // e.g. a phone sign-in that still needs a name
    setToken(r.accessToken);
    setUser(r.user);
    return r.user;
  }, []);

  const login = useCallback((email, password, remember = true) => api('POST', '/auth/login', { email, password, remember }).then(start), [start]);
  const register = useCallback(
    (email, password, displayName, remember = true) => api('POST', '/auth/register', { email, password, displayName, remember }).then(start),
    [start],
  );
  const loginWithGoogle = useCallback((credential, remember = true) => api('POST', '/auth/google', { credential, remember }).then(start), [start]);
  const requestCode = useCallback((phone) => api('POST', '/auth/otp/request', { phone }), []);
  const verifyCode = useCallback(
    (phone, code, displayName, remember = true) => api('POST', '/auth/otp/verify', { phone, code, remember, ...(displayName ? { displayName } : {}) }).then(start),
    [start],
  );
  const resetPassword = useCallback((token, password, remember = true) => api('POST', '/auth/password/reset', { token, password, remember }).then(start), [start]);
  const logout = useCallback(async () => {
    await api('POST', '/auth/logout').catch(() => {});
    clearBoards(); // saved offline boards stay with the person, not the device
    setToken(null);
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, ready, providers, login, register, loginWithGoogle, requestCode, verifyCode, resetPassword, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
