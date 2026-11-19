// Generates a realistic, reproducible interaction dataset (spec 6.3: "trained
// on interaction data you generate yourself"). Synthetic travellers have one
// of five personas, plan trips mostly with like-minded friends, and like or
// dislike venues accordingly, with some noise.
//
// For each traveller it produces:
//   train  signals from two past trips (likes and a few dislikes)
//   test   the venues they go on to like on their NEXT trip (held out)
// The evaluation asks: given only `train`, do the top-5 recommendations hit
// the venues in `test`? (Precision@5, spec 1.3 target >= 0.6.)

const late = (v) => {
  const [oh] = v.hours.open.split(':').map(Number);
  const [ch] = v.hours.close.split(':').map(Number);
  return ch < oh || ch >= 23;
};
const isFood = (v) => ['breakfast', 'lunch', 'dinner', 'cafe', 'bar'].includes(v.category);

// Neighbourhoods known for going out, in the fixture and the Indian cities.
const NIGHTLIFE_AREAS = ['Bairro Alto', 'Cais do Sodré', 'Hauz Khas', 'Bandra West', 'Baga', 'Calangute', 'C-Scheme'];

// Rupee prices for the same kind of place are roughly 60 times the dollar
// figures the personas were written with (a $15 meal is about a ₹900 one).
export const PRICE_SCALE = { USD: 1, INR: 60 };

export const PERSONAS = {
  plantBased: {
    label: 'plant-based foodie',
    likes: (v, s = 1) => isFood(v) && v.dietaryTags.some((t) => t === 'vegan' || t === 'vegetarian') && v.pricePerPerson <= 40 * s,
  },
  backpacker: {
    label: 'budget backpacker',
    likes: (v, s = 1) => v.pricePerPerson <= 15 * s || (v.category === 'lodging' && v.pricePerPerson < 50 * s),
  },
  culture: {
    label: 'culture seeker',
    likes: (v, s = 1) => ['museum', 'attraction', 'tour'].includes(v.category) && v.pricePerPerson <= 60 * s,
  },
  nightOwl: {
    label: 'night owl',
    likes: (v) => (v.category === 'bar' || (isFood(v) && late(v))) || NIGHTLIFE_AREAS.includes(v.neighborhood),
  },
  luxury: {
    label: 'luxury traveller',
    likes: (v, s = 1) => v.pricePerPerson >= 45 * s || v.rating >= 4.8,
  },
};

// Small seeded random generator (same output every run).
export function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const shuffle = (list, rand) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function generateDataset(venues, { usersPerPersona = 24, seed = 2026, likeRate = 0.85, noiseRate = 0.04, trainShare = 0.55, priceScale = 1 } = {}) {
  const rand = rng(seed);
  const users = [];
  for (const [persona, def] of Object.entries(PERSONAS)) {
    for (let i = 0; i < usersPerPersona; i += 1) users.push({ userId: `${persona}_${i}`, persona, likes: (v) => def.likes(v, priceScale) });
  }

  // Trips: groups of 3-4, mostly the same persona (group affinity).
  const trips = [];
  const byPersona = Object.keys(PERSONAS).map((p) => shuffle(users.filter((u) => u.persona === p), rand));
  for (const group of byPersona) {
    for (let i = 0; i < group.length; i += 4) trips.push(group.slice(i, i + 4));
  }
  // A few mixed groups, as real friends don't all share one taste.
  for (let i = 0; i < users.length / 8; i += 1) trips.push(shuffle(users, rand).slice(0, 3));
  const companions = new Map(users.map((u) => [u.userId, new Set()]));
  for (const t of trips) for (const a of t) for (const b of t) if (a !== b) companions.get(a.userId).add(b.userId);

  const train = [];
  const test = new Map(); // userId -> Set of venueIds they like on the next trip
  for (const u of users) {
    // Everything this traveller would actually like (persona pool, with noise).
    const liked = venues.filter((v) => (u.likes(v) ? rand() < likeRate : rand() < noiseRate));
    const order = shuffle(liked, rand);
    const cut = Math.max(2, Math.round(order.length * trainShare));
    const coTraveledWith = [...companions.get(u.userId)];
    for (const v of order.slice(0, cut)) {
      train.push({ userId: u.userId, venueId: v.venueId, category: v.category, liked: true, weight: 1, source: 'generated', coTraveledWith });
    }
    // A couple of things they removed or voted down.
    const disliked = shuffle(venues.filter((v) => !u.likes(v)), rand).slice(0, 2);
    for (const v of disliked) {
      train.push({ userId: u.userId, venueId: v.venueId, category: v.category, liked: false, weight: 1, source: 'generated', coTraveledWith });
    }
    test.set(u.userId, new Set(order.slice(cut).map((v) => v.venueId)));
  }
  return { users, trips, train, test };
}
