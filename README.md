poo
- Room codes
- Up to 12 players per room
- Hidden impostor role
- Movement
- Tasks
- Kills
- Bodies + reports
- Emergency meetings
- Voting
- Win conditions
- Cloudflare Workers + Durable Objects WebSockets

## Deploy

Install Node.js, then:

```bash
npm install
npx wrangler login
npm run dev
```

For production:

```bash
npm run deploy
```

Wrangler will create the Durable Object migration from `wrangler.toml`.

## Notes

This is a deliberately original game implementation rather than using Among Us assets, names, maps, or copyrighted game files. You can customize the art, names, map and mechanics in `public/`.

Cloudflare Durable Objects coordinate each room's WebSocket connections and shared game state.
