import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { createOnlineRoomManager } from "../apps/server/src/online-room-manager.js";
import { createUserStore } from "../apps/server/src/user-store.js";
import { acceptWebSocketUpgrade, readFrames } from "../apps/server/src/websocket.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 4174);
const host = process.env.HOST ?? (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const manager = createOnlineRoomManager();
// 注册/登录用户存储（JSON 文件持久化）：登录后联机座位以账号昵称为准。
const userStore = createUserStore({ filePath: join(root, "data", "users.json") });
const peers = new Map();
const advanceTimers = new Map();
// 赖子翻牌到期的补发广播定时器（每房一个，开局时刷新）。
const laiziTimers = new Map();

// 统一错误构造：error.code 随 error 消息下发，客户端按码特殊处理（如 RECONNECT_FAILED 清 token）。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
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
  // 注册 / 登录 / token 自动登录：成功后把账号绑定到当前连接，
  // 之后建坊/入座的昵称一律以账号昵称为准（防伪冒，也用于区分用户）。
  if (message.type === "register" || message.type === "login") {
    try {
      const user = message.type === "register"
        ? userStore.register({
          username: message.username,
          password: message.password,
          nickname: message.nickname,
        })
        : userStore.login({ username: message.username, password: message.password });
      peer.user = { username: user.username, nickname: user.nickname };
      peer.send({ type: "authResult", ok: true, user: peer.user, token: user.token });
    } catch (error) {
      // 注册/登录校验失败：把原因回给客户端展示。
      peer.send({ type: "authResult", ok: false, reason: error.code ?? "AUTH_ERROR", message: error.message });
    }
    return;
  }

  if (message.type === "authToken") {
    const user = userStore.authByToken(message.token);
    if (!user) {
      peer.send({ type: "authResult", ok: false, reason: "TOKEN_INVALID" });
      return;
    }
    peer.user = { username: user.username, nickname: user.nickname };
    peer.send({ type: "authResult", ok: true, user: peer.user, token: user.token });
    return;
  }

  if (message.type === "logout") {
    peer.user = null;
    peer.send({ type: "authResult", ok: true, user: null });
    return;
  }

  if (message.type === "createRoom") {
    const room = manager.createRoom({
      clientId: peer.id,
      nickname: peer.user?.nickname ?? message.nickname,
      mustLackOneSuit: message.mustLackOneSuit,
      ruleConfig: message.ruleConfig,
    });
    broadcastRoom(room.code);
    return;
  }

  if (message.type === "joinRoom") {
    const room = manager.joinRoom({
      clientId: peer.id,
      nickname: peer.user?.nickname ?? message.nickname,
      roomCode: message.roomCode,
    });
    broadcastRoom(room.code);
    return;
  }

  if (message.type === "quickJoin") {
    const room = manager.quickJoin({
      clientId: peer.id,
      nickname: peer.user?.nickname ?? message.nickname,
      mustLackOneSuit: message.mustLackOneSuit,
      ruleConfig: message.ruleConfig,
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
    scheduleLaiziReveal(room.code, room.laiziRevealAt);
    return;
  }

  if (message.type === "action") {
    const room = manager.handleAction(peer.id, message.action, message.payload);
    broadcastRoom(room.code);
    scheduleAdvance(room.code);
    return;
  }

  if (message.type === "reconnect") {
    // 断线重连：凭房间号 + 座位 token 找回原座位（客户端存 sessionStorage，刷新不丢）。
    const room = manager.reconnectByToken({
      roomCode: message.roomCode,
      token: message.token,
      clientId: peer.id,
    });
    if (!room) {
      throw fail("RECONNECT_FAILED", "重连失败，房间不存在或已解散");
    }
    broadcastRoom(room.code);
    scheduleAdvance(room.code);
    return;
  }

  if (message.type === "dissolveRoom") {
    const { room, clientIds } = manager.dissolveRoom(peer.id);
    // 停掉该房的对局推进定时器，避免解散后再空转一拍。
    const pendingAdvance = advanceTimers.get(room.code);
    if (pendingAdvance) {
      clearTimeout(pendingAdvance);
      advanceTimers.delete(room.code);
    }
    const pendingLaizi = laiziTimers.get(room.code);
    if (pendingLaizi) {
      clearTimeout(pendingLaizi);
      laiziTimers.delete(room.code);
    }
    // 解散后逐个通知：原来在此房的连接全部收到 room:null 返回大厅。
    for (const clientId of clientIds) {
      peers.get(clientId)?.send({ type: "roomState", room: null, game: null });
    }
    return;
  }
}

// 赖子翻牌动画到期后补发一次房间状态：manager 按 laiziRevealAt 决定是否公开赖子，
// 若无这次广播，客户端只能等到下一次碰/杠才有机会看到"翻 X 赖 Y"。
function scheduleLaiziReveal(roomCode, revealAt) {
  const previous = laiziTimers.get(roomCode);
  if (previous) {
    clearTimeout(previous);
  }
  const timer = setTimeout(() => {
    laiziTimers.delete(roomCode);
    // broadcastRoom 内部按"连接仍在该房"过滤收件人，空房广播天然无副作用。
    broadcastRoom(roomCode);
  }, Math.max(0, (revealAt ?? Date.now()) - Date.now()) + 60);
  timer.unref?.();
  laiziTimers.set(roomCode, timer);
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
  // 断线不清座：座位标记离线由机器人托管代打，客户端可凭 token 重连找回。
  const room = manager.markDisconnected(peer.id);
  if (room) {
    broadcastRoom(room.code);
  }
}

function sendError(peer, error) {
  peer.send({
    type: "error",
    code: error?.code ?? "ERROR",
    message: error instanceof Error ? error.message : String(error),
  });
}
