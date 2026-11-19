// Finds every interface string: literals passed to t(...) in the source
// (including both branches of t(cond ? 'a' : 'b')), plus keys that are
// translated through a variable (categories, roles, dietary tags, ...).
// Used by the translation coverage test and the extraction script.

export const DYNAMIC_KEYS = [
  // venue categories
  'breakfast', 'lunch', 'dinner', 'cafe', 'bar', 'activity', 'tour', 'museum', 'attraction', 'lodging',
  // dietary tags
  'vegetarian', 'vegan', 'halal', 'kosher', 'gluten-free', 'dairy-free', 'nut-free',
  // trip roles and presence
  'leader', 'planner', 'viewer', 'admin', 'online', 'good connection', 'slow connection', 'poor connection',
  // cost split types
  'even', 'weighted',
  // explore category buttons
  'All', 'Landmarks', 'Tours and walks', 'Experiences', 'Museums', 'Food', 'Cafes', 'Nightlife', 'Stays',
  // sort options
  'Top rated', 'Price: low to high', 'Price: high to low', 'Most reviewed',
  // chat reactions
  'Agree', 'Love it', 'Funny', 'Wow', 'Celebrate', 'Disagree',
  // analytics metrics and rows
  'Planning time', 'Most online at once', 'Concierge questions', 'Conflicts flagged', 'Conflicts resolved', 'Votes held',
  'Pinned', 'Moved', 'Removed', 'Locked', 'On the board now', 'Chat messages', 'Ballots cast', 'Slot votes', 'Budget-split votes', 'Conflicts still open',
  // home activity feed
  '{who} pinned {place}', '{who} locked {place}', '{who} removed {place}', 'A vote closed', '{who} asked the Concierge', 'A clash was flagged',
  // trip room tabs
  'Budget', 'Concierge', 'Chat', 'People', 'Ideas',
];

const LITERAL = String.raw`'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"`;

export function extractKeys(source) {
  const keys = new Set();
  const call = /\bt\(\s*/g;
  let m;
  while ((m = call.exec(source))) {
    // Read the first argument up to a top-level comma or the closing paren.
    let i = call.lastIndex;
    let depth = 0;
    let arg = '';
    for (; i < source.length; i += 1) {
      const c = source[i];
      if (c === "'" || c === '"' || c === '`') {
        const end = source.indexOf(c, i + 1);
        let j = end;
        while (j > 0 && source[j - 1] === '\\') j = source.indexOf(c, j + 1);
        arg += source.slice(i, j + 1);
        i = j;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth -= 1;
      }
      if (c === ',' && depth === 0) break;
      arg += c;
    }
    for (const lit of arg.matchAll(new RegExp(LITERAL, 'g'))) {
      const raw = lit[1] ?? lit[2];
      if (raw === undefined) continue;
      keys.add(raw.replace(/\\'/g, "'").replace(/\\"/g, '"'));
    }
  }
  return keys;
}
