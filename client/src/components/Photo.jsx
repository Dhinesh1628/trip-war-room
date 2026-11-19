import { useState } from 'react';
import { IconPhoto } from '@tabler/icons-react';
import { useI18n } from '../lib/i18n.jsx';

// A place photo (served by the app, originally from Wikimedia Commons) with
// its credit (author and licence) linked to the Commons file page, as the
// licence requires. Photos of a related dish, street or landmark carry a
// "Representative photo" label. Falls back to a plain tile if missing.

// The author and licence, linked to the Commons file page.
export function PhotoCredit({ image }) {
  const { t } = useI18n();
  if (!image?.url) return null;
  return (
    <a
      className="photo-credit"
      href={image.source}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={t('Photo: {credit}, {license}, via Wikimedia Commons', { credit: image.credit, license: image.license })}
    >
      {image.credit} · {image.license}
    </a>
  );
}

export default function Photo({ image, alt, className = '', children, credit = true, eager = false, label = true }) {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);
  const show = image?.url && !failed;
  return (
    <div className={`photo ${className}`}>
      {show ? (
        <img src={image.url} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="photo-empty" aria-hidden="true"><IconPhoto size={28} stroke={1.4} /></div>
      )}
      {show && label && image.representative && <span className="photo-label">{t('Representative photo')}</span>}
      {children}
      {show && credit && <PhotoCredit image={image} />}
    </div>
  );
}
