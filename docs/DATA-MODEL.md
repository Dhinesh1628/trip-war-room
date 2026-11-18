# Data model (as shipped)

MongoDB through Mongoose (spec Option B). The six core entities from spec 7.2
are all present (User, Trip, ItineraryItem, VenueMetadata, ChatMessage,
Interaction), plus five supporting collections. Model files are listed under
each table.

```mermaid
erDiagram
  USER ||--o{ REFRESH_TOKEN : "has sessions"
  USER ||--o{ TRIP : "leads (leaderUserId)"
  TRIP }o--o{ USER : "participants[] (role, muted)"
  TRIP ||--o{ ITINERARY_ITEM : "board"
  TRIP ||--o{ VOTE : "slot and split votes"
  TRIP ||--o{ CHAT_MESSAGE : "chat, system, conflict, ai_answer"
  TRIP ||--o{ TRIP_EVENT : "event log"
  DESTINATION ||--o{ VENUE : "catalog"
  VENUE ||--o{ ITINERARY_ITEM : "venueId (+ snapshot)"
  USER ||--o{ INTERACTION : "taste signals"
  VENUE ||--o{ INTERACTION : "venueId"

  USER {
    ObjectId _id
    string email UK
    string displayName
    string passwordHash "bcrypt, never returned"
    string role "user | admin"
    string[] preferences_dietaryTags
    number preferences_budgetCeiling "whole-trip USD per person"
  }
  REFRESH_TOKEN {
    string tokenHash UK "sha256"
    ObjectId userId
    string family "rotation chain"
    date expiresAt "TTL index"
    date revokedAt
  }
  TRIP {
    ObjectId _id
    ObjectId leaderUserId
    string destination "slug"
    string startDate "YYYY-MM-DD"
    string endDate
    number totalBudget
    string inviteCode UK
    string status "drafting | live | finalized"
    object[] participants "userId, role, muted, joinedAt"
    ObjectId[] removedUserIds
    bool roomLocked
    object settings "maxParticipants, defaultJoinRole, aiVerbosity"
  }
  ITINERARY_ITEM {
    ObjectId _id
    ObjectId tripId
    string venueId
    object venue "snapshot at pin time"
    int dayIndex
    string startTime "HH:MM"
    string endTime
    string lifecycleStage "drafting | voting | locked"
    int positionVersion "optimistic concurrency"
    ObjectId pinnedByUserId
    ObjectId lockedByUserId
    ObjectId[] attendeeIds "empty = everyone"
    object split "type, weights"
  }
  VOTE {
    ObjectId _id
    ObjectId tripId
    string kind "slot | split"
    ObjectId[] itemIds
    object proposal "split votes"
    date closesAt
    map ballots "userId to choice"
    string status "open | resolved | cancelled"
    string resolution
  }
  CHAT_MESSAGE {
    ObjectId _id
    ObjectId tripId
    ObjectId userId "null for system and AI"
    string type "chat | system | conflict | ai_answer"
    string body "plain text, cleaned"
    string clientMsgId "dedupe on resend"
    map reactions
    object meta
  }
  TRIP_EVENT {
    ObjectId tripId
    number seq "unique with tripId"
    string type
    ObjectId userId
    ObjectId itemId
    object data
    date ts
  }
  DESTINATION {
    string slug UK
    string name
    object center
    object[] transit
    object weather "monthly, daily"
    string datasetVersion
  }
  VENUE {
    string _id "v_lis_001"
    string destination
    string name
    string category
    number pricePerPerson
    string[] dietaryTags
    object hours "open, close"
    object coordinates "lat, lng"
    number rating
    int reviewCount
    bool indoor
    string description
  }
  INTERACTION {
    ObjectId userId
    ObjectId tripId
    string destination
    string venueId
    string category
    bool liked
    number weight
    string source "pin | vote | remove | feedback | generated"
    ObjectId[] coTraveledWith
  }
```

## Collections

| Collection | Model file | Key indexes | Notes |
|---|---|---|---|
| `users` | `auth/user.model.js` | `email` unique | `role` is the account role; trip roles live on each trip |
| `refreshtokens` | `auth/refreshToken.model.js` | `tokenHash` unique, `userId`, `family`, `expiresAt` TTL | Only hashes are stored; rotation with reuse detection |
| `trips` | `trips/trip.model.js` | `inviteCode` unique, `(participants.userId, createdAt)` | `participants[]` carries the per-trip role (Viewer, Planner, Leader) |
| `itineraryitems` | `board/itineraryItem.model.js` | `(tripId, dayIndex)` (spec 9.2) | `positionVersion` is the optimistic-concurrency field (spec 7.2) |
| `votes` | `board/vote.model.js` | `tripId` | Slot and budget-split votes; open votes are restored when a room reloads |
| `chatmessages` | `chat/chatMessage.model.js` | `(tripId, createdAt)`, `(tripId, userId, clientMsgId)` unique (partial) | Doubles as the notice log (`system`, `conflict`, `ai_answer`), as spec 7.2.1 allows |
| `tripevents` | `board/tripEvent.model.js` | `(tripId, seq)` unique | Event log behind session analytics |
| `destinations` | `venues/destination.model.js` | `slug` unique | Transit links and mocked weather |
| `venues` | `venues/venue.model.js` | `(destination, coordinates.lat, coordinates.lng)` (spec 9.2), `(destination, category)` | `_id` is the dataset's venue id |
| `interactions` | `recs/interaction.model.js` | `userId`, `(destination, venueId)` | Feeds the recommender |

## Differences from the spec's reference schema (7.2.1)

- **Roles:** `users.role` is `user` or `admin`; Viewer, Planner and Leader are
  per-trip roles in `trips.participants[]` (see DECISIONS.md, Phase 1).
- **`itinerary_items.votes`:** this field exists, but votes live in their own
  `votes` collection, because a vote spans several items and has its own
  lifecycle.
- **Item cost data** is a `venue` snapshot taken at pin time, so a later dataset
  upload doesn't change an existing board's budget.
- **Added for later phases:** `attendeeIds` and `split` on items,
  `removedUserIds` and `roomLocked` on trips, and the `tripevents` and
  `refreshtokens` collections.
