# INBOX — what to publish today

This file is the handover. Whenever the site owner says **"new ones"**, read this first.
It is kept in the repo so it survives any new session; the last line is the newest.

## Standing orders (never change these)

1. **Two new film posts every day**, in English, written for readers **outside Sri Lanka**.
2. **A new release gets a post on the day it opens** (review) or the day before (preview).
3. Also cover, when they happen: **sports events** and **actor / actress special occasions**
   (birthdays, weddings, awards, festivals) — always with a named source.
4. **18+ / horror / psychological films get a little extra weight** — that is what this
   audience opens. Adults only, straight about the rating.
5. **Scheduled times areUTC** and chosen for a foreign evening audience:
   - Slot A — **14:30 UTC** (13:30 London, 08:30 New York): the European evening read.
   - Slot B — **19:00 UTC** (19:00 London, 14:00 New York): the American afternoon read.
   Two posts, one per slot. Never publish both at the same time.
6. **No Sri Lankan film topics** — the owner asked for the foreign market only.
7. **Never link a rip** (torrent, Telegram, "watch free" site). The panel blocks it and so
   does `scripts/publish-film-posts.mjs`. Offer the legal platform instead.
8. **Images:** press stills / posters saved under `public/images/blog/`. Credit under each
   picture. Never a stolen paparazzi private photo, never anything sexual, never a real
   person humiliated. Suspense, dread, tension — that is the goal, not nakedness.

## How a post goes live (pick one)

- **Fast way:** write the post as `content/film/<slug>.html`, add it to
  `content/film/index.json` with its `publish_at`, commit and push. The deploy publishes it
  and it appears in the blog, sitemap and RSS by itself at the time you set.
- **Manual way:** Admin → Blog → ＋ Article, paste from `content/film/PUBLISH-SHEET.md`,
  set the *Publish time* box.

## Queue

| Date | Slug | Title | Kind | Publish time (UTC) |
| --- | --- | --- | --- | --- |
| 2026-11-01 | `other-mommy-review-2026` | Other Mommy review: 17% on Rotten Tomatoes and I still could not look away | Film Review (18+) | 14:30 |
| 2026-11-01 | `verity-review-anne-hathaway` | Verity review: critics called it trash, audiences made it a $163 million hit | Film Review (18+) | 19:00 |
| 2026-11-02 | `ramayana-rise-of-a-legend-preview` | Ramayana: Rise of a Legend — what is confirmed, what is only talk, before 5 November | Film News | 14:30 |
| 2026-11-02 | `clayface-review-dc-body-horror` | Clayface review: DC finally made something that isn't a superhero film | Film Review (18+) | 19:00 |
| 2026-11-03 | `godzilla-minus-zero-preview` | Godzilla Minus Zero is out this week — and it is the safest bet of the month | Film Preview | 14:30 |
| 2026-11-03 | `amitabh-bachchan-health-rumours` | Amitabh Bachchan, 84: the health rumours, the truth, and the film he might do next | Actor News | 19:00 |

## Ideas for the next two days (verify before writing)

- **Next big openings:** *The Hunger Games: Sunrise on the Reaping* (20 Nov), Disney's
  *Hexed* (25 Nov), *Focker-in-Law* (25 Nov), *Dune: Part Three* (18 Dec),
  *Avengers: Doomsday* (18 Dec), *Jumanji: Open World* (25 Dec).
- **Streaming drops** worth a post on the day they land: Netflix / Prime / Shudder horror.
- **Sports** (only when a named event is actually on): cricket, football, F1 — a
  "how to watch legally in the UK / US / India" post works every single time.
- **Actor occasions:** birthdays and anniversaries that a foreign audience cares about.

> Rule for the next agent: never invent a fact about a real person. If it is not confirmed
> by a named source, it goes under "only a rumour" — or it does not go in at all.
