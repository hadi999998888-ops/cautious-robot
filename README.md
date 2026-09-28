# Ceko Hub — real chat server

GitHub Pages can host the `index.html`, but it cannot run a Node.js/WebSocket server. Use Render/Railway/Fly.io/etc. for `server.js`, or deploy this whole folder to a Node host.

## Run locally

```bash
npm install
npm start
```

The server listens on `PORT` (default `3000`). Health check: `/api/health`.

## Deploy

Upload `server.js`, `package.json`, and `data/` to GitHub. On a Node host use:
- Build: `npm install`
- Start: `npm start`

Then put the public server URL into `CHAT_SERVER_URL` inside `index.html`.

The server stores users and the last 20,000 messages in `data/db.json`. For a production-scale service, use a real database and authentication provider.
