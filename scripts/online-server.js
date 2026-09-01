import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createOnlineRoomManager } from "../apps/server/src/online-room-manager.js";
import { acceptWebSocketUpgrade, readFrames } from "../apps/server/src/websocket.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const manager = createOnlineRoomManager();
const peers = new Map();
const advanceTimers = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname === "/health") {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === "/") {
    response.writeHead(302, { Location: "/apps/mobile/?online=1" });
    response.end();
    return;
  }

  serveStatic(url, response);
});

server.on("upgrade", (request, socket) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const peer = acceptWebSocketUpgrade(request, socket);
  if (!peer) {
    return;
  }

  peers.set(peer.id, peer);
  peer.send({ type: "connected", clientId: peer.id });

  socket.on("data", (chunk) => {
    try {
      readFrames(peer, chunk, (message) => handlePeerMessage(peer, message));
    } catch (error) {
      sendError(peer, error);
    }
  });
  socket.on("close", () => removePeer(peer));
  socket.on("error", () => removePeer(peer));
});

server.listen(port, host, () => {
  console.log(`Qingyang online prototype: http://${host}:${port}/apps/mobile/?online=1`);
});

function serveStatic(url, response) {
  const safePath = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  let filePath = join(root, safePath);

  if (!filePath.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  if (existsSync(filePath) && statSync(filePath).isDirectory()) {
    filePath = join(filePath, "index.html");
  }

  if (!existsSync(filePath)) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  response.writeHead(200, {
    "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
  });
  createReadStream(filePath).pipe(response);
}

function handlePeerMessage(peer, message) {
  if (message.type === "createRoom") {
    const room = manager.createRoom({
      clientId: peer.id,
      nickname: message.nickname,
      mustLackOneSuit: message.mustLackOneSuit,
    });
    broadcastRoom(room.code);
    return;
  }

  if (message.type === "joinRoom") {
    const room = manager.joinRoom({
      clientId: peer.id,
      nickname: message.nickname,
      roomCode: message.roomCode,
    });
    broadcastRoom(room.code);
    return;
  }

  if (message.type === "leaveRoom") {
    const room = manager.leaveRoom(peer.id);
    if (room) {
      broadcastRoom(room.code);
    }
    peer.send({ type: "roomState", room: null, game: null });
    return;
  }

  if (message.type === "startGame") {
    const room = manager.startGame(peer.id);
    broadcastRoom(room.code);
    scheduleAdvance(room.code);
    return;
  }

  if (message.type === "action") {
    const room = manager.handleAction(peer.id, message.action, message.payload);
    broadcastRoom(room.code);
    scheduleAdvance(room.code);
    return;
  }
}

function scheduleAdvance(roomCode, delay = 520) {
  if (advanceTimers.has(roomCode)) {
    return;
  }
  const timer = setTimeout(() => {
    advanceTimers.delete(roomCode);
    const result = manager.advanceRoomOnce(roomCode);
    if (result.room) {
      broadcastRoom(roomCode);
    }
    if (result.changed) {
      scheduleAdvance(roomCode);
    }
  }, delay);
  advanceTimers.set(roomCode, timer);
}

function broadcastRoom(roomCode) {
  for (const [clientId, peer] of peers) {
    const room = manager.getRoomForClient(clientId);
    if (room?.code === roomCode) {
      peer.send({
        type: "roomState",
        ...manager.roomStateForClient(clientId),
      });
    }
  }
}

function removePeer(peer) {
  if (!peers.has(peer.id)) {
    return;
  }
  peers.delete(peer.id);
  const room = manager.leaveRoom(peer.id);
  if (room) {
    broadcastRoom(room.code);
  }
}

function sendError(peer, error) {
  peer.send({
    type: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}
