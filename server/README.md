# Wildborn game server

Accounts (username + password, no email), one-use invite codes, and play-together rooms for the Wildborn website.
Runs on Railway next to a Railway **Postgres** service, which stores accounts, invite codes, sign-ins and settings. The service needs three variables:

- `ADMIN_KEY`: secret, 30+ random characters. Opens the admin page at `/admin`. Never commit or share it.
- `ALLOWED_ORIGINS`: `https://petradavis.github.io`
- `DATABASE_URL`: `${{Postgres.DATABASE_URL}}` (Railway fills in the real address). Without it the server won't start.

Deploys from the `production` branch. Railway settings live in `server/railway.json` (Railpack build, `npm start`, health check on `/health`,
restart on failure, exactly 1 replica because play-together rooms live in the server's memory, never sleeps). In the service's Settings set:
Source branch `production`, Root Directory `/server`, and Railway Config File `/server/railway.json` (Railway doesn't look inside the Root Directory for it).
The game server needs no volume; Postgres keeps its own. Variables are set in Railway, not in this file. To release: merge `main` into `production`.

The first start makes 10 invite codes; see them on the admin page. `GET /health` returns `{"ok":true}` when the database answers. The tables are created on the first start.
Opening the server's home page (`/`) sends you to the game website (`GAME_URL`, default `https://petradavis.github.io/Wildborn/`).
The game connects to `wss://<domain>/ws` (set `WB_SERVER` in the website build).

`filter.js` is generated from the game's chat filter (mpchat.js) so the server and the game filter the same words.

Run locally (needs Node 20+ and a Postgres): `npm install && DATABASE_URL=postgres://user@localhost/wildborn ADMIN_KEY=some-long-test-key npm start`.
