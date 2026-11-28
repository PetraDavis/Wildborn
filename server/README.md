# Wildborn game server

Accounts (username + password, no email), one-use invite codes, and play-together rooms for the Wildborn website.
Runs on Railway: Root Directory `/server`, a volume at `/data`, and two variables:

- `ADMIN_KEY`: secret, 30+ random characters. Opens the admin page at `/admin`. Never commit or share it.
- `ALLOWED_ORIGINS`: `https://petradavis.github.io`

The first start makes 10 invite codes; see them on the admin page. `GET /health` returns `{"ok":true}`.
The game connects to `wss://<domain>/ws` (set `WB_SERVER` in the website build).

`filter.js` is generated from the game's chat filter (mpchat.js) so the server and the game filter the same words.

Run locally: `npm install && ADMIN_KEY=some-long-test-key npm start` (needs Node 22.13+).
