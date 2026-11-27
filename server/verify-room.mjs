// Start the BR4 server, then run node verify-room.mjs [http://localhost:2567].
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const origin = process.argv[2] || "http://127.0.0.1:2567";
const population = "test-" + randomUUID();
const clients = [];
async function until(test) {
  for (let i = 0; i < 500; i++) {
    if (test()) return;
    await sleep(20);
  }
  throw Error("Timed out waiting for test room");
}
async function connect() {
  const response = await fetch(origin + "/matchmake/joinOrCreate/drivers", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ population }),
  });
  assert.equal(response.status, 200);
  const seat = await response.json();
  const socket = new WebSocket(origin.replace(/^http/, "ws") + "/" + seat.processId + "/" + seat.roomId + "?sessionId=" + seat.sessionId);
  const driver = { socket, received: 0 };
  clients.push(driver);
  socket.binaryType = "arraybuffer";
  driver.control = message => socket.send(Buffer.concat([Buffer.from([17, 0]), Buffer.from(JSON.stringify(message))]));
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = publicKey.export({ type: "spki", format: "pem" });
  socket.onmessage = ({ data }) => {
    const bytes = Buffer.from(data);
    if (bytes[0] === 10) return socket.send(Buffer.from([10]));
    if (bytes[0] !== 17) return;
    if (bytes[1] === 1) { driver.received++; return; }
    const msg = JSON.parse(bytes.subarray(2));
    if (msg.op === "challenge") driver.control({
      op: "proof", publicKey: pem, signature: sign("sha256", Buffer.from(msg.nonce), privateKey).toString("base64"),
    });
    if (msg.op === "welcome") {
      driver.slot = msg.drivers.at(-1).slot;
      driver.control({ op: "visit", key: "world-City", visit: 1, members: [] });
    }
    if (msg.op === "member" && msg.driver.slot === driver.slot) driver.shard = msg.driver.shard;
  };
  await until(() => driver.shard !== undefined);
}
try {
  for (let i = 0; i < 21; i++) await connect();
  assert.equal(clients.filter(c => c.shard === 0).length, 20);
  assert.equal(clients[20].shard, 1);
  // Colyseus frame, scope/reliability bits, target slot, visit, kind, body.
  const frame = Buffer.from([17,1,3, 0,0,0,0, 1,0,0,0, 1,120, 0,0,0,0,0]);
  const send = () => clients[0].socket.send(frame);
  for (let i = 0; i < 130; i++) send();
  await until(() => clients.slice(1,20).every(c => c.received === 128));
  clients[1].control({ op: "ack", count: 128 });
  await sleep(100);
  send();
  await until(() => clients[1].received === 129);
  assert.equal(clients[2].received,128);
  assert.equal(clients[20].received,0);
  console.log("PASS 20 drivers share City, overflow is isolated, stalled recipients are bounded, acknowledgment resumes delivery.");
} finally {
  for (const driver of clients) driver.socket.close();
}
