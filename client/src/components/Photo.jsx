import { useState } from 'react';
import { IconPhoto } from '@tabler/icons-react';

// A place photo from Wikimedia Commons with its credit (author and licence),
// linked to the file page as the licence requires. Falls back to a plain tile
// if there is no photo or it fails to load.
export default function Photo({ image, alt, className = '', children, credit = true, eager = false }) {
  const [failed, setFailed] = useState(false);
  const show = image?.url && !failed;
  return (
    <div className={`photo ${className}`}>
      {show ? (
        <img src={image.url} alt={alt} loading={eager ? 'eager' : 'lazy'} decoding="async" onError={() => setFailed(true)} />
      ) : (
        <div className="photo-empty" aria-hidden="true"><IconPhoto size={28} stroke={1.4} /></div>
      )}
      {children}
      {show && credit && (
        <a
          className="photo-credit"
          href={image.source}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={`Photo: ${image.credit}, ${image.license}, via Wikimedia Commons`}
        >
          {image.credit} · {image.license}
        </a>
      )}
    </div>
  );
}
