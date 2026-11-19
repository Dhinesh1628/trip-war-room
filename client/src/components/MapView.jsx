import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { price } from '../lib/format.js';

// OpenStreetMap with a price pin per place. Clicking a pin opens the place.
// Tiles come from tile.openstreetmap.org (credited in the corner, as the
// tile policy requires).
export default function MapView({ venues, onOpen, label = 'Map of places' }) {
  const box = useRef(null);
  const map = useRef(null);
  const layer = useRef(null);

  useEffect(() => {
    map.current = L.map(box.current, { scrollWheelZoom: false, attributionControl: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(map.current);
    layer.current = L.layerGroup().addTo(map.current);
    map.current.setView([22.5, 79], 5); // India
    return () => {
      map.current.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map.current) return;
    layer.current.clearLayers();
    const points = [];
    for (const v of venues) {
      const ll = [v.coordinates.lat, v.coordinates.lng];
      points.push(ll);
      const icon = L.divIcon({
        className: 'map-pin-wrap',
        html: `<span class="map-pin">${price(v.pricePerPerson, v.currency)}</span>`,
        iconSize: null,
      });
      const m = L.marker(ll, { icon, keyboard: true, title: v.name, alt: v.name });
      m.on('click', () => onOpen?.(v));
      m.on('keypress', (e) => e.originalEvent.key === 'Enter' && onOpen?.(v));
      m.addTo(layer.current);
    }
    if (points.length === 1) map.current.setView(points[0], 14);
    else if (points.length) map.current.fitBounds(points, { padding: [36, 36], maxZoom: 15 });
  }, [venues, onOpen]);

  return <div ref={box} className="map-box" role="region" aria-label={label} />;
}
