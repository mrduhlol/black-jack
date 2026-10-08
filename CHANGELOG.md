# Changelog

## Liar's Table overhaul (Oct 2026)

The liar's side is now a full citizen: authentic rules, its own front page,
cast, sound kit, chat, and test coverage.

- **Authentic 20-card deck** — 6 Kings, 6 Queens, 6 Aces, 2 wild Jokers.
  5 cards each, tables are Kings/Queens/Aces only, max 3 cards per play,
  6-chamber / 1-bullet roulette by default, max 4 seats.
- **Devil card variant** (host toggle) — one marked card rides alone; a
  challenged devil sends every other seat to the chamber in a queue.
- **Front page takeover** — picking Liar's Table re-skins the whole landing
  (bar table hero, wanted-poster setup, wood-and-brass sections) with its own
  avatar cast that is remembered separately per table — as is your nickname.
- **Table experience** — bar chat + emotes (lobby included), round-table
  seats with turn/next badges, reveal suspense beat, chamber spin and live
  countdowns, victory veil with standings, memory-aid holdings line,
  observer countdowns, keyboard shortcuts (`L` / `C` / `Enter`).
- **Sound kit** — card slaps, LIAR! sting, revolver spin, empty clicks,
  gunshot with screen shake, survival sigh, low-time beeps.
- **Robustness** — mid-game joins gated, idle rooms park instead of spinning
  alarms, decide-stage unstick on leave, name hygiene, chat anti-spam
  cooldowns, double-tap guards on bets/actions, two-tap kicks, stored-XSS
  fixes, live felt print that follows table settings.
- **Tests** — engine unit suite plus bot-driven end-to-end games for both
  tables: full games, rematches, lobby chat, cooldowns
  (`npm run e2e:liars`, `npm run e2e:blackjack` against `npm run dev`).
- **Sharing** — Open Graph / Twitter cards with a preview image.

## Earlier

- Mobile table fit: circular felt arc, no-scroll actions, chat bottom sheet.
- Blackjack promo video and motion-graphics skill.
