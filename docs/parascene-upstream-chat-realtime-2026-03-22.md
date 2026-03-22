# Parascene Upstream Chat/Realtime Notes

Reviewed on March 22, 2026 against:

- `crosshj/parascene` `main`
- `https://www.parascene.com/help/developer/api-chat`

This note separates what is publicly documented and safe for `paratui` to rely on now from what exists in upstream code but still looks like a browser-oriented implementation detail.

## What Changed Upstream

### Public and documented

These are live in the public help page and should be treated as stable enough for `paratui`:

- `POST /api/chat/dm`
- `POST /api/chat/channels`
- `GET /api/chat/threads`
- `GET /api/chat/threads/:threadId`
- `GET /api/chat/threads/:threadId/messages`
- `POST /api/chat/threads/:threadId/messages`
- `POST /api/chat/messages/:messageId/reactions`

Useful details from the current public doc:

- `GET /api/chat/threads` is ordered by recent activity and includes `title`, `other_user`, and `last_message`.
- Message history pagination is authoritative and uses `before` plus `nextBefore`.
- Reactions are now part of the official chat surface.

### In upstream code on March 22, 2026

These features now exist in repo code:

- Supabase session bridge for authenticated browser realtime:
  - `POST /api/auth/supabase-session`
- Supabase browser client boot/injection for logged-in pages
- Realtime Broadcast invalidation for chat
- User-inbox dirty broadcasts
- Reconnect and visibility-change resync behavior on the website
- Better DM/channel thread titles
- Server-derived channel merging in the website inbox
- Share-link support for chat embeds
- Sticky-scroll and resize handling for the web chat UI
- Avatars in the Connect thread list

## Important Interpretation

Upstream now has realtime chat code, but it is not a new documented standalone `paratui` websocket API in the public help page yet.

The repo shape suggests this model:

1. Authoritative chat state still comes from the HTTP chat API.
2. Supabase Realtime private Broadcast channels are used as a thin invalidation bus.
3. Clients receive a minimal `dirty` signal, then refetch authoritative thread or message data over HTTP.

That is good news for `paratui`, because it means we should not send chat payloads over realtime. We should continue to send and fetch over HTTP and only use realtime for freshness.

## Stability Matrix

### Safe for `paratui` now

- API-key auth with `Authorization: Bearer psn_...`
- Thread list via `GET /api/chat/threads`
- Room join/open via `POST /api/chat/channels`
- DM open via `POST /api/chat/dm`
- Message history via `GET /api/chat/threads/:threadId/messages`
- Send message via `POST /api/chat/threads/:threadId/messages`
- Message reactions
- Sorting rooms/DMs by `last_message.created_at`
- Using thread `title` directly in the TUI

### Real but still provisional for `paratui`

- `POST /api/auth/supabase-session`
- Supabase channel naming and topic layout
- Realtime event names and payload shape
- Reconnect/resync timing expectations
- Server-channel merging rules
- Share-link token/header contract for embeds

Unless these are published as an official client contract, `paratui` should treat them as opt-in experimental behavior.

## Best `paratui` Integration Strategy

### Phase 1: keep HTTP authoritative

This should remain the default path:

- load rooms and DMs from `GET /api/chat/threads`
- open rooms and DMs through the documented HTTP routes
- send messages through documented HTTP routes
- page older history through documented HTTP routes
- sort using `last_message.created_at`
- merge new messages by message id

This keeps `paratui` compatible even if the website’s realtime implementation changes.

### Phase 2: add realtime only as invalidation

If Harrison confirms the Supabase contract is stable enough for first-party clients, `paratui` should use it only for:

- `user:<viewerId>` dirty events:
  - refetch `GET /api/chat/threads`
- `room:<threadId>` dirty events:
  - refetch current room messages

Rules:

- never trust realtime payloads as the message source of truth
- never change current selection or wipe composer text on dirty events
- debounce room and inbox refresh
- merge results idempotently by message id
- keep polling fallback if realtime is unavailable

### Phase 3: document server-channel behavior

There is now upstream web logic to merge joined-server channels into the chat thread list.

For `paratui`, do not copy the browser heuristic blindly. Prefer one of:

- server exposes merged server channels in `GET /api/chat/threads`, or
- server documents the slugging rules and eligibility clearly enough for first-party clients

Until then:

- keep using real threads returned by `GET /api/chat/threads`
- keep local recent rooms as a fallback

### Phase 4: optional UX parity items

These are lower priority for the TUI:

- avatar-derived initials in room/DM lists
- embed preview support for share links
- richer reaction rendering

Useful, but not worth destabilizing the core chat path.

## Documentation Plan For `paratui`

We should document the upstream surface in three layers.

### 1. Stable integration note

Location:

- `docs/parascene-upstream-chat-realtime-2026-03-22.md`

Purpose:

- snapshot upstream changes
- record what is safe to depend on now
- record what is experimental

### 2. Runtime contract doc

Suggested future file:

- `docs/chat-runtime-contract.md`

Contents:

- which HTTP endpoints `paratui` uses
- when caches refresh
- how room/DM ordering works
- how composer state is preserved during background refresh
- how realtime dirty events map to HTTP refetches

### 3. Operator/user doc

Suggested future file:

- `docs/chat-usage.md`

Contents:

- how to join a room
- how DMs work
- how recent rooms are remembered
- how presence is refreshed
- what happens when realtime is unavailable

## Smallest Upstream Ask

The smallest useful ask to Harrison is not "give us a raw websocket."

The better ask is:

- document whether `POST /api/auth/supabase-session` is supported for first-party non-browser clients
- document the realtime topics:
  - `user:<viewerId>`
  - `room:<threadId>`
- document the event name and payload shape for `dirty`
- confirm that the intended client behavior is refetch-on-dirty over HTTP

If that becomes official, `paratui` can add realtime freshness cleanly without binding itself to undocumented browser internals.
