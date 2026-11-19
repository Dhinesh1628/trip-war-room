import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n.jsx';

// "Continue with Google" using Google Identity Services. The script loads
// only when the server has a Google client id; Google returns a signed ID
// token ("credential") that the server verifies.
const SRC = 'https://accounts.google.com/gsi/client';
let loading = null;
function loadScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => {
        loading = null;
        reject(new Error('Google sign-in could not load'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export default function GoogleButton({ clientId, onCredential, text = 'continue_with' }) {
  const box = useRef(null);
  const { lang } = useI18n();
  const [error, setError] = useState(null);
  const latest = useRef(onCredential);
  latest.current = onCredential;

  useEffect(() => {
    let cancelled = false;
    loadScript()
      .then(() => {
        if (cancelled || !box.current) return;
        window.google.accounts.id.initialize({ client_id: clientId, callback: (r) => latest.current(r.credential), ux_mode: 'popup' });
        box.current.innerHTML = '';
        window.google.accounts.id.renderButton(box.current, {
          theme: 'outline',
          size: 'large',
          shape: 'rectangular',
          text,
          width: Math.min(box.current.offsetWidth || 360, 400),
          locale: lang,
        });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [clientId, lang, text]);

  return (
    <div>
      <div ref={box} className="google-btn" />
      {error && <div className="error">{error}</div>}
    </div>
  );
}
