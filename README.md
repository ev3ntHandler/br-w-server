# Deploying BR4 multiplayer

The browser downloads the game from itch.io and connects to a Node service running Colyseus. Each driver uses one secure WebSocket connection for gameplay, chat and parties.

## Render

1. Register on Render. Put the contents of `builds/br4-colyseus-server.zip` in a Git repository you can connect to Render. The ZIP contains the `server/` directory and `render.yaml`. The game assets stay on itch.io.
2. In Render choose **New → Blueprint**, select the repository and deploy the free Web Service. For manual setup choose **New → Web Service**, Node, Free, root directory `server`, build command `npm ci --omit=dev`, start command `npm start`, and health check `/health`. Use Node 22 or newer.
3. Open the service's HTTPS URL with `/health` appended. It should return JSON identifying BR4 and protocol 1.
4. Use the public HTTPS origin in the multiplayer picker. It remembers the last successful connection. To prefill the address for everyone, set `network/colyseus_url` in the Godot project and export. For an existing Web build, set `window.BR4_SERVER_URL = "https://your-service.onrender.com";` before the engine is created in `index.html` and rezip the export.
5. Upload `builds/br4-itch-web.zip` as a playable HTML game on itch.io, with `index.html` at the ZIP root. Single-player works independently of the server.

The service needs no application key. Render sets PORT. A sleeping free service may take a minute to answer the first request. Multiplayer sessions are kept in memory and disconnect if the service restarts.

## Development

Run `npm ci` and `npm start` inside `server/`. The native default is `http://127.0.0.1:2567`. Use the same address in a locally hosted HTTP browser build. HTTPS embeds require a public HTTPS origin. The desktop environment override is `BR4_COLYSEUS_URL`.

## How it works

The Godot adapter uses HTTPRequest for Colyseus seat reservation and WebSocketPeer for JOIN_ROOM and ROOM_DATA_BYTES. Colyseus authenticates a one-time challenge against the driver's existing RSA key. Separate platform and test namespaces keep their own social lobby. The server assigns at most 20 drivers to each instance of a roam world. Race packets also require matching membership. The longest continuously present driver leads the world simulation.

Each browser uploads a broadcast once. Room message 0 carries membership and authentication. Message 1 carries bounded binary Godot data with optional compression. The server assigns the sender, checks each world visit and forwards packets to the appropriate drivers. It skips transient snapshots when a recipient falls behind. Client acknowledgments track consumption even when a background browser continues to drain its socket. Direct messages retain application-level delivery receipts across reconnects.

Use one server instance with this in-memory deployment. The protocol adapter targets the locked Colyseus 0.18 packages. Verify the seat reservation, binary room messages and two-client party regression when upgrading them.

[Render deployment documentation](https://render.com/docs/deploy-node-express-app) · [Render Free](https://render.com/docs/free)
