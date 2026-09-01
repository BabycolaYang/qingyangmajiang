import {
  anGang,
  chooseBotDiscardIndex,
  discardTile,
  drawForCurrentSeat,
  finishWin,
  getPengOptions,
  nextDealer,
  pengDiscard,
  rollDice,
  skipReactions,
  startRound,
} from "../../../packages/mahjong-core/src/index.js";

const PLAYER_COUNT = 4;

export function createOnlineRoomManager() {
  const rooms = new Map();
  const clientIndex = new Map();

  function createRoom({ clientId, nickname, mustLackOneSuit = false }) {
    leaveRoom(clientId);

    const code = createRoomCode(rooms);
    const dealerDice = rollDice();
    const room = {
      code,
      ownerClientId: clientId,
      mustLackOneSuit,
      rounds: 4,
      currentRound: 1,
      dealerSeat: (dealerDice.total - 1) % PLAYER_COUNT,
      dealerDice,
      status: "waiting",
      seats: createSeats(),
      game: null,
      pendingReactions: new Set(),
    };
    rooms.set(code, room);

    sitClient(room, clientId, nickname, 0, clientIndex);
    return room;
  }

  function joinRoom({ clientId, nickname, roomCode }) {
    leaveRoom(clientId);

    const room = rooms.get(String(roomCode).toUpperCase());
    if (!room) {
      throw new Error("房间不存在");
    }
    if (!room.ownerClientId) {
      room.ownerClientId = clientId;
    }

    const existingSeat = room.seats.findIndex((seat) => seat.clientId === clientId);
    if (existingSeat >= 0) {
      sitClient(room, clientId, nickname, existingSeat, clientIndex);
      return room;
    }

    if (room.status !== "waiting") {
      throw new Error("牌局已经开始");
    }

    const seat = room.seats.findIndex((seatInfo) => !seatInfo.clientId);
    if (seat < 0) {
      throw new Error("房间已满");
    }

    sitClient(room, clientId, nickname, seat, clientIndex);
    return room;
  }

  function leaveRoom(clientId) {
    const entry = clientIndex.get(clientId);
    if (!entry) {
      return null;
    }

    const room = rooms.get(entry.roomCode);
    if (!room) {
      clientIndex.delete(clientId);
      return null;
    }

    const seat = room.seats[entry.seat];
    if (seat?.clientId === clientId) {
      room.seats[entry.seat] = createEmptySeat(entry.seat);
    }
    clientIndex.delete(clientId);

    if (room.ownerClientId === clientId) {
      const nextOwner = room.seats.find((seatInfo) => seatInfo.clientId);
      room.ownerClientId = nextOwner?.clientId ?? null;
    }

    return room;
  }

  function startGame(clientId) {
    const room = getClientRoom(clientId);
    ensureOwner(room, clientId);

    const dealerSeat = room.game?.nextDealerSeat ?? room.dealerSeat;
    const playerNames = room.seats.map((seat) => seat.name || `电脑${seat.seat + 1}`);
    const beanBalances = room.game
      ? room.game.players.map((player) => player.beans)
      : room.seats.map((seat) => seat.beans);

    room.game = startRound({
      dealerSeat,
      seed: `${room.code}-${room.currentRound}-${Date.now()}`,
      playerNames,
      beanBalances,
      mustLackOneSuit: room.mustLackOneSuit,
    });
    room.status = "playing";
    room.pendingReactions = new Set();
    return room;
  }

  function handleAction(clientId, action, payload = {}) {
    const room = getClientRoom(clientId);
    const seat = clientIndex.get(clientId).seat;

    if (!room.game || room.game.status !== "playing") {
      throw new Error("牌局未开始");
    }

    if (action === "discard") {
      if (room.game.currentSeat !== seat || room.game.phase !== "discard") {
        throw new Error("还没轮到你出牌");
      }
      room.game = discardTile(room.game, seat, Number(payload.handIndex));
      refreshPendingReactions(room);
      return room;
    }

    if (action === "pass") {
      room.pendingReactions.delete(seat);
      return room;
    }

    if (action === "peng") {
      if (!room.pendingReactions.has(seat)) {
        throw new Error("现在不能碰");
      }
      room.game = pengDiscard(room.game, seat);
      room.pendingReactions = new Set();
      return room;
    }

    if (action === "gang") {
      if (room.game.currentSeat !== seat || room.game.phase !== "discard") {
        throw new Error("现在不能杠");
      }
      room.game = anGang(room.game, seat, payload.tile);
      return room;
    }

    if (action === "win") {
      if (room.game.availableWin?.seat !== seat) {
        throw new Error("现在不能胡");
      }
      room.game = finishWin(room.game, seat);
      room.status = "ended";
      room.dealerSeat = room.game.nextDealerSeat;
      room.pendingReactions = new Set();
      syncBeansFromGame(room);
      return room;
    }

    throw new Error(`未知动作：${action}`);
  }

  function advanceRoomOnce(roomCode) {
    const room = rooms.get(roomCode);
    if (!room?.game || room.game.status !== "playing") {
      return { changed: false, room };
    }

    if (room.game.phase === "reaction") {
      refreshPendingReactions(room);
      if (room.pendingReactions.size > 0) {
        return { changed: false, room, waiting: true };
      }
      room.game = skipReactions(room.game);
      return { changed: true, room };
    }

    if (room.game.phase === "draw") {
      room.game = drawForCurrentSeat(room.game);
      if (room.game.status === "ended") {
        room.status = "ended";
        room.dealerSeat = room.game.nextDealerSeat;
        syncBeansFromGame(room);
      }
      if (room.game.availableWin?.seat === room.game.currentSeat && !isHumanSeat(room, room.game.currentSeat)) {
        room.game = finishWin(room.game, room.game.currentSeat);
        room.status = "ended";
        room.dealerSeat = room.game.nextDealerSeat;
        syncBeansFromGame(room);
      }
      return { changed: true, room };
    }

    if (room.game.phase === "discard") {
      if (isHumanSeat(room, room.game.currentSeat)) {
        return { changed: false, room, waiting: true };
      }

      if (room.game.availableWin?.seat === room.game.currentSeat) {
        room.game = finishWin(room.game, room.game.currentSeat);
        room.status = "ended";
        room.dealerSeat = room.game.nextDealerSeat;
        syncBeansFromGame(room);
        return { changed: true, room };
      }

      const player = room.game.players[room.game.currentSeat];
      const discardIndex = chooseBotDiscardIndex(player, room.game.laiziTile, {
        mustLackOneSuit: room.game.mustLackOneSuit,
      });
      room.game = discardTile(room.game, room.game.currentSeat, discardIndex);
      refreshPendingReactions(room);
      return { changed: true, room };
    }

    return { changed: false, room };
  }

  function getClientRoom(clientId) {
    const entry = clientIndex.get(clientId);
    if (!entry) {
      throw new Error("你还不在房间里");
    }
    const room = rooms.get(entry.roomCode);
    if (!room) {
      clientIndex.delete(clientId);
      throw new Error("房间不存在");
    }
    return room;
  }

  function getRoomForClient(clientId) {
    const entry = clientIndex.get(clientId);
    return entry ? rooms.get(entry.roomCode) ?? null : null;
  }

  function roomStateForClient(clientId) {
    const room = getRoomForClient(clientId);
    if (!room) {
      return { room: null, game: null };
    }
    const seat = clientIndex.get(clientId).seat;
    return {
      room: publicRoomState(room, clientId, seat),
      game: room.game ? publicGameForSeat(room.game, seat) : null,
    };
  }

  return {
    rooms,
    clientIndex,
    createRoom,
    joinRoom,
    leaveRoom,
    startGame,
    handleAction,
    advanceRoomOnce,
    getRoomForClient,
    roomStateForClient,
  };
}

export function publicGameForSeat(game, mySeat) {
  const viewGame = clone(game);
  const originalPlayers = clone(game.players);
  viewGame.players = Array.from({ length: PLAYER_COUNT }, (_, viewSeat) => {
    const originalSeat = toOriginalSeat(viewSeat, mySeat);
    const player = originalPlayers[originalSeat];
    return {
      ...player,
      seat: viewSeat,
      originalSeat,
      hand:
        game.status === "ended" || viewSeat === 0
          ? player.hand
          : Array.from({ length: player.hand.length }, () => "back"),
    };
  });

  viewGame.currentSeat = toViewSeat(game.currentSeat, mySeat);
  viewGame.dealerSeat = toViewSeat(game.dealerSeat, mySeat);
  viewGame.nextDealerSeat = toViewSeat(game.nextDealerSeat, mySeat);
  viewGame.winnerSeat =
    game.winnerSeat === null || game.winnerSeat === undefined
      ? game.winnerSeat
      : toViewSeat(game.winnerSeat, mySeat);
  viewGame.lastDiscard = game.lastDiscard
    ? { ...game.lastDiscard, seat: toViewSeat(game.lastDiscard.seat, mySeat) }
    : null;
  viewGame.lastDraw = game.lastDraw
    ? { ...game.lastDraw, seat: toViewSeat(game.lastDraw.seat, mySeat) }
    : null;
  viewGame.availableWin = game.availableWin
    ? { ...game.availableWin, seat: toViewSeat(game.availableWin.seat, mySeat) }
    : null;
  viewGame.runFengBeforeDraw = rotateArray(game.runFengBeforeDraw, mySeat);
  if (game.settlement) {
    viewGame.settlement = {
      ...game.settlement,
      winnerSeat: toViewSeat(game.settlement.winnerSeat, mySeat),
      dealerSeat: toViewSeat(game.settlement.dealerSeat, mySeat),
      deltas: rotateArray(game.settlement.deltas, mySeat),
      payments: rotateArray(game.settlement.payments, mySeat),
    };
  }

  return viewGame;
}

function publicRoomState(room, clientId, seat) {
  return {
    code: room.code,
    seat,
    isOwner: room.ownerClientId === clientId,
    status: room.status,
    rounds: room.rounds,
    currentRound: room.currentRound,
    mustLackOneSuit: room.mustLackOneSuit,
    dealerSeat: toViewSeat(room.dealerSeat, seat),
    invitePath: `/apps/mobile/?online=1&room=${room.code}`,
    players: rotateArray(room.seats, seat).map((seatInfo, viewSeat) => ({
      seat: viewSeat,
      originalSeat: seatInfo.seat,
      name: seatInfo.name,
      beans: seatInfo.beans,
      connected: Boolean(seatInfo.clientId),
      isYou: seatInfo.clientId === clientId,
      isOwner: seatInfo.clientId === room.ownerClientId,
    })),
  };
}

function refreshPendingReactions(room) {
  room.pendingReactions = new Set();
  if (room.game?.phase !== "reaction") {
    return;
  }

  for (const seat of humanSeats(room)) {
    if (getPengOptions(room.game, seat).length > 0) {
      room.pendingReactions.add(seat);
    }
  }
}

function humanSeats(room) {
  return room.seats.filter((seat) => seat.clientId).map((seat) => seat.seat);
}

function isHumanSeat(room, seat) {
  return Boolean(room.seats[seat]?.clientId);
}

function syncBeansFromGame(room) {
  if (!room.game) {
    return;
  }
  for (const player of room.game.players) {
    room.seats[player.seat].beans = player.beans;
  }
}

function sitClient(room, clientId, nickname, seat, clientIndex) {
  const safeName = sanitizeNickname(nickname);
  room.seats[seat] = {
    seat,
    clientId,
    name: safeName,
    beans: room.seats[seat]?.beans ?? 1000,
  };
  clientIndex.set(clientId, { roomCode: room.code, seat });
}

function ensureOwner(room, clientId) {
  if (room.ownerClientId !== clientId) {
    throw new Error("只有房主能开局");
  }
}

function createSeats() {
  return Array.from({ length: PLAYER_COUNT }, (_, seat) => createEmptySeat(seat));
}

function createEmptySeat(seat) {
  return {
    seat,
    clientId: null,
    name: "",
    beans: 1000,
  };
}

function createRoomCode(rooms) {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error("无法生成房号");
}

function sanitizeNickname(nickname) {
  const safeName = String(nickname || "").trim().slice(0, 8);
  return safeName || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
}

function toViewSeat(originalSeat, mySeat) {
  return (originalSeat - mySeat + PLAYER_COUNT) % PLAYER_COUNT;
}

function toOriginalSeat(viewSeat, mySeat) {
  return (mySeat + viewSeat) % PLAYER_COUNT;
}

function rotateArray(items, mySeat) {
  if (!Array.isArray(items)) {
    return items;
  }
  return Array.from({ length: items.length }, (_, viewSeat) => items[toOriginalSeat(viewSeat, mySeat)]);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
