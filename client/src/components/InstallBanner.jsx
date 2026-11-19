import { useEffect, useState } from 'react';
import { IconDeviceMobile, IconX } from '@tabler/icons-react';
import { canInstall, onInstallChange, promptInstall, isIos, isStandalone } from '../lib/pwa.js';
import { useI18n } from '../lib/i18n.jsx';

const DISMISS_KEY = 'twr.installDismissed';
const dismissed = () => {
  try {
    return localStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
};

// A small "Install Trip War Room" bar on phones and tablets when the browser
// offers installing (or, on iPhone, a hint to use Share > Add to Home Screen).
export default function InstallBanner() {
  const { t } = useI18n();
  const [available, setAvailable] = useState(canInstall());
  const [hidden, setHidden] = useState(dismissed());
  useEffect(() => onInstallChange(setAvailable), []);

  const ios = isIos() && !isStandalone();
  if (hidden || isStandalone() || (!available && !ios)) return null;
  const close = () => {
    setHidden(true);
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // not remembered; hides for this visit
    }
  };
  return (
    <div className="install-banner" role="region" aria-label={t('Install the app')}>
      <IconDeviceMobile size={20} aria-hidden="true" />
      <span className="grow small">{ios ? t('Install: tap Share, then "Add to Home Screen".') : t('Install Trip War Room on this device for quick access.')}</span>
      {!ios && <button className="small primary" onClick={() => promptInstall().then((ok) => ok && close())}>{t('Install')}</button>}
      <button className="ghost icon" onClick={close} aria-label={t('Not now')}><IconX size={16} aria-hidden="true" /></button>
    </div>
  );
}
