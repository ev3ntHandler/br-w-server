import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { Room, Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";

// One socket carries social traffic across travel. World broadcasts are fanned
// out here so the browser uploads each vehicle snapshot only once.
const MAX_DRIVERS = 20;
const MAX_PACKET = 264 * 1024;
const control = (client, value) => client.sendBytes(0, Buffer.from(JSON.stringify(value)));
class DriverLobby extends Room {
  onCreate() {
    this.drivers = new Map();
    this.serial = 0;
    this.maxMessagesPerSecond = 500;
    this.onMessageBytes(0, (client, bytes) => {
      if (bytes.length > 8192) return client.leave(4000, "Invalid control message");
      try {
        const message = JSON.parse(Buffer.from(bytes).toString());
        if (!client.userData.driver) this.authenticate(client, message);
        else if (message.op === "visit") this.visit(client, message);
        else if (message.op === "ack" && Number.isSafeInteger(message.count)) {
          const flow = client.userData;
          if (message.count > flow.acked && message.count <= flow.sent) flow.acked = message.count;
        }
      } catch { client.leave(4000, "Invalid control message"); }
    });
    this.onMessageBytes(1, (client, bytes) => this.route(client, Buffer.from(bytes)));
  }

  onJoin(client) {
    const nonce = randomBytes(24).toString("hex");
    client.userData = { nonce, sent: 0, acked: 0 };
    client.userData.timeout = this.clock.setTimeout(() => client.leave(4000, "Identity timeout"), 20000);
    control(client, { op: "challenge", nonce });
  }

  authenticate(client, { op, publicKey, signature }) {
    if (op !== "proof" || typeof publicKey !== "string" || publicKey.length > 550 ||
        !publicKey.startsWith("-----BEGIN PUBLIC KEY-----")) return client.leave(4000, "Invalid key");
    const key = createPublicKey(publicKey);
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength !== 2048 ||
        !verify("sha256", Buffer.from(client.userData.nonce), key, Buffer.from(signature, "base64"))) {
      return client.leave(4000, "Invalid driver proof");
    }
    client.userData.timeout.clear();
    const id = createHash("sha256").update(publicKey).digest("hex");
    for (const existing of this.drivers.values()) {
      if (existing.userData.driver.id === id) {
        this.remove(existing);
        existing.leave(4001, "Driver opened another session");
        break;
      }
    }
    const driver = { id, slot: ++this.serial, key: "", shard: 0, visit: 0, order: 0 };
    client.userData.driver = driver;
    this.drivers.set(driver.slot, client);
    control(client, { op: "welcome", drivers: [...this.drivers.values()].map(c => c.userData.driver) });
    this.notifyOthers(client, { op: "member", driver });
  }

  visit(client, { key, visit, members }) {
    const d = client.userData.driver;
    if (typeof key !== "string" || key.length > 160 || !Number.isSafeInteger(visit) ||
        visit <= d.visit || !Array.isArray(members) || members.length > MAX_DRIVERS ||
        !members.every(id => typeof id === "string" && /^[0-9a-f]{64}$/.test(id))) return;
    const counts = new Map();
    for (const other of this.drivers.values()) {
      const peer = other.userData.driver;
      if (other !== client && peer.key === key) counts.set(peer.shard, 1 + (counts.get(peer.shard) || 0));
    }
    let shard = 0;
    while ((counts.get(shard) || 0) >= MAX_DRIVERS) shard++;
    Object.assign(d, { key, shard, visit, order: ++this.serial });
    client.userData.members = new Set(members);
    for (const peer of this.drivers.values()) control(peer, { op: "member", driver: d });
  }

  route(client, bytes) {
    const d = client.userData.driver;
    if (!d || bytes.length < 12 || bytes.length > MAX_PACKET) return;
    const flags = bytes[0], world = !!(flags & 1), ephemeral = !!(flags & 2);
    const target = bytes.readUInt32LE(1), visit = bytes.readUInt32LE(5);
    if (flags > 3 || !bytes[9] || 10 + bytes[9] >= bytes.length ||
        (world && (!d.key || d.visit !== visit))) return;
    bytes.writeUInt32LE(d.slot, 1);
    const recipients = target ? [this.drivers.get(target)] : this.drivers.values();
    for (const peer of recipients) {
      if (!peer || peer === client) continue;
      const p = peer.userData.driver;
      if (world && (d.key !== p.key || d.shard !== p.shard ||
          (client.userData.members?.size && !client.userData.members.has(p.id)) ||
          (peer.userData.members?.size && !peer.userData.members.has(d.id)))) continue;
      if (peer.ref.bufferedAmount > 1024 * 1024) { peer.leave(4002, "Slow connection"); continue; }
      // A background browser can drain the TCP socket while its game loop is
      // suspended. Count snapshots actually consumed by the recipient as well.
      if (ephemeral) {
        const flow = peer.userData;
        if (flow.sent - flow.acked >= 128 || peer.ref.bufferedAmount > 48 * 1024) continue;
        flow.sent++;
      }
      peer.sendBytes(1, bytes);
    }
  }

  notifyOthers(client, message) {
    for (const peer of this.drivers.values()) if (peer !== client) control(peer, message);
  }

  remove(client) {
    const driver = client.userData?.driver;
    if (driver && this.drivers.delete(driver.slot)) {
      this.notifyOthers(client, { op: "left", slot: driver.slot });
    }
    if (client.userData) client.userData.driver = null;
  }

  onLeave(client) {
    client.userData?.timeout?.clear();
    this.remove(client);
  }
}

const server = new Server({
  transport: new WebSocketTransport({ maxPayload: MAX_PACKET + 2, pingInterval: 10000, pingMaxRetries: 4 }),
  express: app => app.get("/health", (_request, response) => response.json({ service: "br4", protocol: 1 })),
});
server.define("drivers", DriverLobby).filterBy(["population"]);
await server.listen(Number(process.env.PORT || 2567), "0.0.0.0");

