import test from "node:test";
import assert from "node:assert/strict";
import { createOnlineRoomManager } from "../src/online-room-manager.js";
import { sortTiles } from "../../../packages/mahjong-core/src/index.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

test("keeps laizi secret during intro, reveals at laiziRevealAt with true-sorted hand", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");

  const stateForA = () => manager.roomStateForClient("a");
  const game = room.game;
  const myView = () => stateForA().game.players[0];
  const realHand = game.players[myView().originalSeat].hand;

  // 保密期：开局首个 roomState 不携带赖子/指示牌，手牌按中性顺序（不暴露赖子）下发。
  assert.equal(stateForA().game.laiziTile, null);
  assert.equal(stateForA().game.indicatorTile, null);
  assert.deepEqual(myView().hand, sortTiles(realHand, null));

  // 其他家依旧只见牌背（与保密期无关，始终生效）。
  for (const other of stateForA().game.players.slice(1)) {
    assert.equal(other.hand.every((tile) => tile === "back"), true);
    assert.equal((other.initialHand ?? []).every((tile) => tile === "back"), true);
    assert.equal(other.initialHand.length, other.hand.length); // 庄家 14 张、闲家 13 张
  }
  // 自己的 initialHand 保留明牌（发牌动画要用，理牌前抓牌顺序）。
  assert.equal(myView().initialHand.some((tile) => tile !== "back"), true);

  // 保密期到期：赖子/指示牌公开，手牌按真实顺序（赖子最左）下发。
  room.laiziRevealAt = Date.now() - 1;
  const revealed = stateForA();
  assert.equal(revealed.game.laiziTile, game.laiziTile);
  assert.equal(revealed.game.indicatorTile, game.indicatorTile);
  assert.deepEqual(myView().hand, sortTiles(realHand, game.laiziTile));
});

test("hand stays sorted when drawing: drawn tile sorts into hand, view and data stay consistent", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");
  room.laiziRevealAt = Date.now() - 1;

  const stateForA = () => manager.roomStateForClient("a").game.players[0];
  const originalSeat = stateForA().originalSeat;
  const laiziTile = room.game.laiziTile;
  const before = [...room.game.players[originalSeat].hand];

  // 模拟抓牌（与 drawForCurrentSeat 一致）：摸牌即理牌——直接插入手牌排序位（赖子最左）。
  const drawnTile = room.game.wall[0];
  room.game.players[originalSeat].hand = sortTiles([...before, drawnTile], laiziTile);
  room.game.lastDraw = { seat: originalSeat, tile: drawnTile };

  // 下发整手理牌序（摸牌不再挂右端单放）：
  // 客户端用 lastDraw 定位摸牌高亮，显示顺序与 handIndex 打出索引始终一致。
  const pending = stateForA();
  assert.deepEqual(pending.hand, sortTiles([...before, drawnTile], laiziTile));

  // 打出一张后（lastDraw 清空）：整手仍是理牌序下发。
  const hand = [...room.game.players[originalSeat].hand];
  hand.splice(hand.lastIndexOf(drawnTile), 1);
  room.game.players[originalSeat].hand = hand;
  room.game.lastDraw = null;
  assert.deepEqual(stateForA().hand, sortTiles(hand, laiziTile));
});

test("gang replacement discards the tile clicked in the view, not another tile", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");
  room.laiziRevealAt = Date.now() - 1;

  const mySeat = manager.roomStateForClient("a").game.players[0].originalSeat;
  const laiziTile = room.game.laiziTile;
  const gangTile = ["wan-1", "tiao-1", "tong-1", "east"].find((tile) => tile !== laiziTile);

  // 轮到"a"出牌，手里凑出 4 张同牌可暗杠（14 张）。
  const player = room.game.players[mySeat];
  const filler = [
    "wan-2",
    "wan-3",
    "wan-4",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-2",
    "tong-3",
    "tong-4",
    "south",
  ];
  player.hand = sortTiles([...filler, gangTile, gangTile, gangTile, gangTile], laiziTile);
  room.game.currentSeat = mySeat;
  room.game.phase = "discard";

  manager.handleAction("a", "gang", { tile: gangTile });

  // 杠补后：下发视图与数据层同为理牌序。
  const drawnTile = room.game.lastDraw.tile;
  const viewHand = manager.roomStateForClient("a").game.players[0].hand;
  assert.deepEqual(viewHand, sortTiles(room.game.players[mySeat].hand, laiziTile));

  // 客户端按视图索引点击杠补牌（不带牌值）：打出的必须是那张杠补牌本身。
  // 修复前数据层把杠补牌挂在末尾，视图索引会打到另一张牌。
  const viewIndex = viewHand.lastIndexOf(drawnTile);
  manager.handleAction("a", "discard", { handIndex: viewIndex });
  assert.equal(room.game.lastDiscard.tile, drawnTile);
});

test("discard prefers the tile value when pre-reveal neutral ordering differs from data order", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");
  // 保密期内：视图按中性序（赖子不置左）下发，与数据层赖子置左序不同。

  const mySeat = manager.roomStateForClient("a").game.players[0].originalSeat;
  room.game.laiziTile = "fa";
  const player = room.game.players[mySeat];
  const filler = [
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-4",
    "wan-5",
    "wan-6",
    "wan-7",
    "wan-8",
    "wan-9",
    "tiao-1",
    "tiao-2",
    "tiao-3",
    "tiao-4",
  ];
  player.hand = sortTiles([...filler, "fa"], "fa");
  room.game.currentSeat = mySeat;
  room.game.phase = "discard";

  // 视图（中性序）里赖子不在最左，与数据层（赖子置左）顺序不同。
  const viewHand = manager.roomStateForClient("a").game.players[0].hand;
  const viewIndex = viewHand.indexOf("fa");
  assert.notEqual(viewIndex, 0);
  assert.notDeepEqual(viewHand, player.hand);

  // 客户端点的是视图里的赖子：带牌值出牌，服务器按牌值定位，打出赖子本身。
  manager.handleAction("a", "discard", { handIndex: viewIndex, tile: "fa" });
  assert.equal(room.game.lastDiscard.tile, "fa");
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

test("disconnect keeps the seat with a token, bots play for the seat, token reconnects", () => {
  const manager = createOnlineRoomManager({ waitingEvictDelayMs: 100000 });
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });
  manager.startGame("a");

  const seatToken = room.seats[1].token;
  assert.equal(typeof seatToken, "string");
  assert.equal(seatToken.length > 0, true);

  // b 掉线：座位保留、标记离线，且公开状态里可见（（离线）标记的数据来源）。
  const disconnectedRoom = manager.markDisconnected("b");
  assert.equal(disconnectedRoom.code, room.code);
  assert.equal(room.seats[1].clientId, "b");
  assert.equal(room.seats[1].connected, false);
  assert.equal(room.seats[1].token, seatToken);
  const stateForA = manager.roomStateForClient("a");
  const bView = stateForA.room.players.find((player) => player.originalSeat === 1);
  assert.equal(bView.connected, false);

  // 对局中掉线：机器人托管代打（轮到 b 出牌时自动出，不卡死牌局）。
  room.game.currentSeat = 1;
  room.game.phase = "discard";
  const result = manager.advanceRoomOnce(room.code);
  assert.equal(result.changed, true);
  assert.equal(room.game.phase, "reaction");
  assert.equal(room.game.lastDiscard.seat, 1);

  // token 重连：换绑新 clientId 找回原座位，token 不变（服务端不下发新凭据）。
  const reconnected = manager.reconnectByToken({
    roomCode: room.code,
    token: seatToken,
    clientId: "b2",
  });
  assert.equal(reconnected.code, room.code);
  assert.equal(room.seats[1].clientId, "b2");
  assert.equal(room.seats[1].connected, true);
  assert.equal(room.seats[1].token, seatToken);
  assert.equal(manager.clientIndex.has("b"), false);
  assert.equal(manager.clientIndex.get("b2").seat, 1);
  const stateForB2 = manager.roomStateForClient("b2");
  assert.equal(stateForB2.room.seat, 1);
});

test("owner reconnect keeps ownership: isOwner stays true and dissolve works", () => {
  const manager = createOnlineRoomManager({ waitingEvictDelayMs: 100000 });
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  // 房主掉线再重连（如刷新页面换新连接）：所有权跟随座位迁移。
  manager.markDisconnected("a");
  const ownerToken = room.seats[0].token;
  manager.reconnectByToken({ roomCode: room.code, token: ownerToken, clientId: "a2" });

  const state = manager.roomStateForClient("a2");
  assert.equal(state.room.isOwner, true);
  assert.equal(room.ownerClientId, "a2");

  // 重连后的房主仍能解散房间（S4 依赖 isOwner 的客户端按钮 + 服务端校验）。
  const { clientIds } = manager.dissolveRoom("a2");
  assert.deepEqual([...clientIds].sort(), ["a2", "b"]);
});

test("waiting-state disconnect is evicted after the timeout while others stay", async () => {
  const manager = createOnlineRoomManager({ waitingEvictDelayMs: 30 });
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  manager.markDisconnected("b");
  await sleep(60);

  // b 超时被清座；a 在线不受影响；房间仍在等待开局。
  assert.equal(room.seats[1].clientId, null);
  assert.equal(room.seats[1].name, "");
  assert.equal(manager.clientIndex.has("b"), false);
  assert.equal(room.seats[0].clientId, "a");
  assert.equal(manager.rooms.has(room.code), true);

  // 清座后旧 token 重连失败（null）。
  const stale = manager.reconnectByToken({
    roomCode: room.code,
    token: "expired-token",
    clientId: "b3",
  });
  assert.equal(stale, null);
});

test("all-human disconnected room is removed after the timeout", async () => {
  const manager = createOnlineRoomManager({ waitingEvictDelayMs: 30 });
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  manager.markDisconnected("a");
  manager.markDisconnected("b");
  await sleep(60);

  assert.equal(manager.rooms.has(room.code), false);
  assert.equal(manager.getRoomForClient("a"), null);
  assert.equal(manager.getRoomForClient("b"), null);
});

test("only the owner can dissolve the room; dissolving notifies everyone", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });
  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  assert.throws(
    () => manager.dissolveRoom("b"),
    /只有房主能解散房间/,
  );

  const { clientIds } = manager.dissolveRoom("a");
  assert.deepEqual([...clientIds].sort(), ["a", "b"]);
  assert.equal(manager.rooms.has(room.code), false);
  assert.equal(manager.getRoomForClient("a"), null);
  assert.equal(manager.getRoomForClient("b"), null);
});

test("server rejects actions with error codes for client-side branching", () => {
  const manager = createOnlineRoomManager();
  const room = manager.createRoom({ clientId: "a", nickname: "房主" });

  // 未入房做任何动作 → NOT_IN_ROOM（客户端按码提示）。
  assert.throws(
    () => manager.handleAction("nobody", "pass"),
    (error) => error.code === "NOT_IN_ROOM",
  );

  assert.throws(
    () => manager.joinRoom({ clientId: "x", nickname: "路人", roomCode: "000000" }),
    (error) => error.code === "ROOM_NOT_FOUND",
  );

  manager.joinRoom({ clientId: "b", nickname: "朋友", roomCode: room.code });

  // 等待中做对局动作 → GAME_NOT_PLAYING。
  assert.throws(
    () => manager.handleAction("a", "pass"),
    (error) => error.code === "GAME_NOT_PLAYING",
  );

  manager.startGame("a");
  assert.throws(
    () => manager.joinRoom({ clientId: "c", nickname: "晚到", roomCode: room.code }),
    (error) => error.code === "GAME_STARTED",
  );
});
