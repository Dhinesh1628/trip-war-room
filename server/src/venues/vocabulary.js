// The documented vocabularies. Uploads and user preferences are checked
// against these lists, so a typo like "vegeterian" is rejected rather than
// silently making a venue impossible to match.

export const DIETARY_TAGS = Object.freeze([
  'vegetarian',
  'vegan',
  'halal',
  'kosher',
  'gluten-free',
  'dairy-free',
  'nut-free',
]);

// Categories where dietary constraints apply (you eat or drink there).
export const FOOD_CATEGORIES = Object.freeze(['breakfast', 'lunch', 'dinner', 'cafe', 'bar']);

export const VENUE_CATEGORIES = Object.freeze([
  ...FOOD_CATEGORIES,
  'activity',
  'tour',
  'museum',
  'attraction',
  'lodging',
]);

export const TRANSIT_MODES = Object.freeze(['walk', 'metro', 'tram', 'bus', 'train', 'ferry', 'taxi']);

export const WEATHER_CONDITIONS = Object.freeze([
  'sunny',
  'partly-cloudy',
  'cloudy',
  'showers',
  'rain',
  'windy',
]);
