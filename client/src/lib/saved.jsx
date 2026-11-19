import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { del, get, put } from './api.js';
import { useAuth } from './auth.jsx';

// The heart button: which places this traveller saved. Loaded once after
// sign-in; toggling updates the screen first and the server right after.
const SavedContext = createContext(null);

export function SavedProvider({ children }) {
  const { user } = useAuth();
  const [ids, setIds] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!user) return setIds([]);
    get('/users/me/saved')
      .then((r) => setIds(r.saved.map((v) => v.venueId)))
      .catch(() => setIds([]));
  }, [user]);

  const toggle = useCallback(async (venueId) => {
    const saving = !ids.includes(venueId);
    setIds((now) => (saving ? [venueId, ...now] : now.filter((id) => id !== venueId)));
    setError(null);
    try {
      const r = saving ? await put(`/users/me/saved/${venueId}`) : await del(`/users/me/saved/${venueId}`);
      setIds(r.savedVenueIds);
    } catch (err) {
      setIds((now) => (saving ? now.filter((id) => id !== venueId) : [venueId, ...now]));
      setError(err.message);
    }
  }, [ids]);

  const value = useMemo(() => ({ ids, has: (id) => ids.includes(id), toggle, error }), [ids, toggle, error]);
  return <SavedContext.Provider value={value}>{children}</SavedContext.Provider>;
}

export const useSaved = () => useContext(SavedContext);
