import test from "node:test";
import assert from "node:assert/strict";
import { createOnlineRoomManager } from "../src/online-room-manager.js";

test("creates an online room and joins a second player", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({
    clientId: "a",
    nickname: "青阳",
    mustLackOneSuit: true,
  });

  assert.equal(room.seats[0].name, "青阳");
  assert.equal(room.mustLackOneSuit, true);

  manager.joinRoom({
    clientId: "b",
    nickname: "朋友",
    roomCode: room.code,
  });

  const stateForB = manager.roomStateForClient("b");
  assert.equal(stateForB.room.seat, 1);
  assert.equal(stateForB.room.players[0].name, "朋友");
  assert.equal(stateForB.room.players[3].name, "青阳");
});

test("starts a game and hides other players hands from each client", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  manager.startGame("a");

  const stateForA = manager.roomStateForClient("a");
  const stateForB = manager.roomStateForClient("b");

  assert.equal(stateForA.game.players[0].name, "房主");
  assert.equal(stateForB.game.players[0].name, "朋友");
  assert.equal(stateForA.game.players[0].hand.some((tile) => tile !== "back"), true);
  assert.equal(stateForA.game.players[1].hand.every((tile) => tile === "back"), true);
  assert.equal(stateForB.game.players[0].hand.some((tile) => tile !== "back"), true);
  assert.equal(stateForB.game.players[3].hand.every((tile) => tile === "back"), true);
});

test("server accepts a player discard only on that player's turn", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");

  room.game.currentSeat = 1;
  room.game.phase = "discard";

  assert.throws(
    () => manager.handleAction("a", "discard", { handIndex: 0 }),
    /还没轮到你出牌/,
  );

  manager.handleAction("b", "discard", { handIndex: 0 });
  assert.equal(room.game.phase, "reaction");
});

