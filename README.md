# Kaboo

Kaboo, the memory card game, for 2 to 8 players in the browser. One person opens a table and shares the link. Everyone who opens the link can sit down. No accounts needed.

The server holds the deck and every hand. Each player's browser only receives the cards that player is allowed to see, so nobody can peek by reading the page.

## Run it on your computer

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000, type your name and click **Open a table**. Copy the invite link from the lobby and send it to your friends.

Friends on the same Wi-Fi can use `http://<your-computer's-IP>:3000/t/<CODE>`. For friends anywhere, use a tunnel (below) or deploy it.

Run the self-test (240 random games plus a real WebSocket game):

```bash
npm test
```

## Share from your computer with a free tunnel

[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/) gives you a public HTTPS link with no account:

```bash
npm start
# in a second terminal
cloudflared tunnel --url http://localhost:3000
```

It prints a `https://….trycloudflare.com` address. Open it, open a table, and share the invite link. The link works only while your computer and the tunnel are running.

## Deploy for free

### Render (easiest)

1. Push this folder to a GitHub repository.
2. On render.com choose **New > Blueprint**, pick the repository. `render.yaml` sets up a free web service.
3. Open the `https://<name>.onrender.com` address it gives you.

Free services sleep after 15 minutes with no traffic. The first visit after that takes about a minute to wake up. While anyone has the game open, their browser pings the server every 30 seconds, which keeps it awake. Tables are kept in memory, so a restart or redeploy ends games in progress.

### Koyeb

Koyeb gives every account one free web service (512 MB, Frankfurt or Washington). It asks for a card to verify your account. Create a web service from your GitHub repository. It builds from the included `Dockerfile` and serves on port 3000.

### Azure App Service (Free F1)

Works, but the free plan allows only 5 WebSocket connections, so 5 players at most. Create a Linux Node 20 web app on the F1 plan, turn on **Web sockets** under Configuration, and deploy with `az webapp up --runtime "NODE:20-lts" --sku F1`.

## Files

- `server.js`: web server, tables, WebSockets
- `game.js`: the rules and what each player may see
- `public/index.html`: the game table
- `test.js`: rules simulation and a live server test

## House rules this version uses

- KABOO isn't blocked when you're above 3 points (blocking it would reveal your score).
- A KABOO caller who only ties for lowest doesn't win.
- A Counter-KABOO caller who doesn't win also takes the +20.
- Matt's pairs rule, jokers and the memory aid are options the host sets in the lobby.
- Memory aid (off by default): a "Seen" button on your hand shows every card you have legitimately seen. A remembered card follows it when it gets swapped (swaps are announced, so an attentive player could track them too), and it is forgotten when the card leaves that spot. Each player's memory stays on the server and is sent only to them.
- Card powers only work when you discard a card you drew from the deck. After drawing, press **Use power**. Tapping one of your cards instead keeps the drawn card, and its power is lost.
