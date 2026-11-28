# Wildborn: notes for AI coding agents

Wildborn is a 3D browser game (three.js r128) where you play as a creature: hatch, hunt, grow up, and play together with friends.
The owner is Petra. These are her standing rules and the facts an agent needs before changing anything here.

## Petra's rules

- **Don't publish without Petra's word.** Changing the live website (`main` → GitHub Pages) or the live server (`production` → Railway) needs Petra to say "publish" (or "merge"/"deploy" for that change). Branches and pull requests are fine.
- **Ask before big design decisions.** Small fixes are fine; new game rules, prices, or features get a short question first, with a recommendation.
- **Quality over speed.** Test before handing over. Petra tests in a private test copy before anything goes live.
- **Original work only.** Creatures, names, and art are our own designs, even when inspired by other games.
- **Secrets never go in the repo or in chat**: no `ADMIN_KEY`, passwords, Railway login, or tokens. Only public values (like the server's domain) may be written down.
- **No scams in trading** (Petra: "I don't want scamming like in Adopt Me"). Player-to-player trades warn whoever gives more, and both players must lock in. Market stalls may ask any price on purpose.
- Petra often uses speech-to-text, so an odd word in a request is probably a misheard word.

## What's in this repo

| Path | What it is |
| --- | --- |
| `index.html` | The whole game as one built file. GitHub Pages serves it from `main`. |
| `previews/` | Stand-alone creature previews (not in the game yet). |
| `server/` | The multiplayer server: accounts, invite codes, play-together rooms and the admin page. |

`index.html` is **built**, not hand-edited. The game's source pieces (game, creatures, lands, magic, godhood, and the multiplayer files `mp.js`, `mpchat.js`, `mpnet.js`, `mptrade.js`, `mpfamily.js`, `mpmarket.js`) are put together by a build script into one file. Change the source piece and rebuild; don't patch the built file by hand.

## The server runs on Railway and deploys from `production`

- Hosted on **Railway** (a project on Petra's dad's account, budget $20/month: usage alert at $10, hard limit at $20).
- **Railway deploys from the `production` branch**, not `main`. Every push to `production` that touches `server/` redeploys the server.
- Settings live in `server/railway.json` (Railpack build, `npm start`, health check `GET /health`, restart on failure, **exactly 1 replica**, never sleeps).
- In the Railway service: Root Directory `/server`, Railway Config File `/server/railway.json`, a Volume mounted at `/data`, and the variables `ADMIN_KEY` (secret) and `ALLOWED_ORIGINS=https://petradavis.github.io`.
- No Postgres and no bucket: the data (accounts, invites, bans) is a SQLite file (`node:sqlite`) on the volume. That's why it must stay at 1 replica.
- The volume survives rebuilds and redeploys (only the container is replaced). On Railway the server refuses to start if no volume is attached, so data can never quietly land on the throwaway container disk.
- **To release server changes:** merge them into `main` through a pull request, then merge `main` into `production`. Only do the `production` step when Petra says so.
- The game connects to `wss://<railway domain>/ws`; the website build sets `WB_SERVER` to that address.
- Admin page: `https://<railway domain>/admin` (asks for `ADMIN_KEY`). Never ask Petra to send the key.

More detail: `server/README.md`.

## Working on the server

- Node 22.13 or newer (`node:sqlite`). Run locally: `cd server && npm install && ADMIN_KEY=some-long-test-key npm start`, then open `http://localhost:8080/admin`.
- `server/filter.js` is **generated** from the chat filter in `mpchat.js`, so the game and the server block the same words. Regenerate it when the filter changes; don't edit it by hand.
- The server checks what players send: it forces names to the account's username, filters chat and room titles, rate-limits, and caps room sizes. Keep those checks when changing the protocol.

## Multiplayer design notes

- Rooms mimic the Claude room API: each player has a "presence" object, merged per field. Trades, market sales, Wanted posts and auctions all work by players' games reading each other's presence. There is no server-side game logic.
- Anything that moves coins or creatures between players must be safe if a player leaves halfway: hold the payment first, and give it back if the other side never answers.
- Save slots are in `localStorage` (`slotKey(n)`, plus `-magic` and `-god` keys). When a creature moves between players, write or remove all three keys.

## Keeping this file up to date

When you learn something a future agent would otherwise have to ask Petra again (a new rule, a deploy step, a gotcha), add it here in the same pull request, or suggest the addition to Petra.
