import {
  anGang,
  buGang,
  chooseBotDiscardIndex,
  chooseBotReaction,
  discardTile,
  drawForCurrentSeat,
  finishWin,
  getAnGangOptions,
  getBuGangOptions,
  getMingGangOptions,
  getPengOptions,
  mingGangDiscard,
  nextDealer,
  normalizeRuleConfig,
  pengDiscard,
  rollDice,
  skipReactions,
  sortTiles,
  startRound,
} from "../../../packages/mahjong-core/src/index.js";
import { randomUUID } from "node:crypto";

const PLAYER_COUNT = 4;
// 保密期：开局动画（掷骰→发牌→理牌→翻牌骰）播完、客户端翻开指示牌（约 7.6s）时才公开赖子。
// 到点补发广播与翻牌动画对齐，翻开瞬间即亮牌面；客户端另有"等数据到手再翻开"的兜底。
const LAIZI_REVEAL_DELAY_MS = 7400;
// 断线后（等待/已结束状态）座位保留时长：超时未重连才清座，给刷新/闪断留足时间。
const DEFAULT_WAITING_EVICT_DELAY_MS = 120000;

// 统一错误构造：error.code 供客户端按码特殊处理（如 RECONNECT_FAILED 清 token）。
function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function createOnlineRoomManager({ waitingEvictDelayMs = DEFAULT_WAITING_EVICT_DELAY_MS } = {}) {
  const rooms = new Map();
  const clientIndex = new Map();

  function createRoom({ clientId, nickname, mustLackOneSuit = false, ruleConfig = null }) {
    leaveRoom(clientId);

    const code = createRoomCode(rooms);
    const dealerDice = rollDice();
    const room = {
      code,
      ownerClientId: clientId,
      mustLackOneSuit,
      ruleConfig: normalizeRuleConfig(ruleConfig),
      rounds: 4,
      currentRound: 1,
      dealerSeat: (dealerDice.total - 1) % PLAYER_COUNT,
      dealerDice,
      status: "waiting",
      seats: createSeats(),
      game: null,
      pendingReactions: new Set(),
      // 当前反应窗口内已点"过"的座位：防止 refreshPendingReactions 每拍重扫时把"过"弹回。
      passedReactions: new Set(),
      reactionWindowRef: null,
      evictTimer: null,
      evictAt: null,
    };
    rooms.set(code, room);

    sitClient(room, clientId, nickname, 0, clientIndex);
    return room;
  }

  function joinRoom({ clientId, nickname, roomCode }) {
    leaveRoom(clientId);

    const room = rooms.get(String(roomCode).toUpperCase());
    if (!room) {
      throw fail("ROOM_NOT_FOUND", "房间不存在");
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
      throw fail("GAME_STARTED", "牌局已经开始");
    }

    const seat = room.seats.findIndex((seatInfo) => !seatInfo.clientId);
    if (seat < 0) {
      throw fail("ROOM_FULL", "房间已满");
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

  // 断线（socket 关闭）：不清座、不换人，座位只标记离线。
  // - 对局中：isHumanSeat 判定失效 → 该座位由机器人托管代打，牌局不卡死；
  // - 等待/已结束：安排超时清座（waitingEvictDelayMs），重连则取消。
  function markDisconnected(clientId) {
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
      seat.connected = false;
    }
    scheduleRoomEvict(room);
    return room;
  }

  // 断线重连：凭房间号 + 座位 token 找回原座位（token 由客户端存 sessionStorage，刷新不丢）。
  // 重连成功后座位绑定新 clientId，等待中的清座定时器一并取消；找不到返回 null。
  function reconnectByToken({ roomCode, token, clientId }) {
    const room = rooms.get(String(roomCode ?? "").toUpperCase());
    if (!room) {
      return null;
    }
    const seat = room.seats.find((seatInfo) => seatInfo.token && seatInfo.token === token);
    if (!seat) {
      return null;
    }
    const previousClientId = seat.clientId;
    if (previousClientId && previousClientId !== clientId) {
      clientIndex.delete(previousClientId);
    }
    seat.clientId = clientId;
    seat.connected = true;
    if (room.ownerClientId === previousClientId) {
      // 房主刷新/断线重连：所有权跟随座位迁移，否则重连后会丢失房主按钮且无法解散。
      room.ownerClientId = clientId;
    }
    clientIndex.set(clientId, { roomCode: room.code, seat: seat.seat });
    clearEvictTimer(room);
    return room;
  }

  // 房主解散房间：整房销毁，返回仍映射到该房的 clientId 列表供服务器逐个下发 room:null。
  function dissolveRoom(clientId) {
    const entry = clientIndex.get(clientId);
    if (!entry) {
      throw fail("NOT_IN_ROOM", "你还不在房间里");
    }
    const room = rooms.get(entry.roomCode);
    if (!room) {
      clientIndex.delete(clientId);
      throw fail("ROOM_NOT_FOUND", "房间不存在");
    }
    if (room.ownerClientId !== clientId) {
      throw fail("NOT_OWNER", "只有房主能解散房间");
    }
    clearEvictTimer(room);
    rooms.delete(room.code);
    const clientIds = [];
    for (const [mappedClientId, mappedEntry] of clientIndex) {
      if (mappedEntry.roomCode === room.code) {
        clientIds.push(mappedClientId);
        clientIndex.delete(mappedClientId);
      }
    }
    return { room, clientIds };
  }

  function clearEvictTimer(room) {
    if (room.evictTimer) {
      clearTimeout(room.evictTimer);
      room.evictTimer = null;
      room.evictAt = null;
    }
  }

  // 没有在线真人时安排回收：超时后清掉离线座位；等待/已结束且无在线真人的房间整房删除。
  function scheduleRoomEvict(room) {
    // 对局中永不清座：断线座位由机器人托管代打，牌局继续。
    if (room.status === "playing") {
      return;
    }
    // 等待/已结束：有离线座位（超时清座让位给后续玩家）或已无人在线（回收房间）才安排定时器。
    const hasOfflineSeat = room.seats.some(
      (seatInfo) => seatInfo.clientId && seatInfo.connected === false,
    );
    if (!hasOfflineSeat && connectedHumanCount(room) > 0) {
      return;
    }
    clearEvictTimer(room);
    room.evictAt = Date.now() + waitingEvictDelayMs;
    const timer = setTimeout(() => {
      room.evictTimer = null;
      room.evictAt = null;
      evictDisconnected(room);
    }, waitingEvictDelayMs);
    timer.unref?.();
    room.evictTimer = timer;
  }

  // 超时回收：对局中不动（托管代打进行中）；其余状态清掉离线座位并按需删房。
  function evictDisconnected(room) {
    if (room.status === "playing") {
      return;
    }
    const evicted = [];
    for (const seatInfo of room.seats) {
      if (seatInfo.clientId && seatInfo.connected === false) {
        evicted.push(seatInfo.clientId);
        room.seats[seatInfo.seat] = createEmptySeat(seatInfo.seat);
      }
    }
    for (const evictedClientId of evicted) {
      const entry = clientIndex.get(evictedClientId);
      if (entry?.roomCode === room.code) {
        clientIndex.delete(evictedClientId);
      }
    }
    if ((room.status === "waiting" || room.status === "ended") && connectedHumanCount(room) === 0) {
      rooms.delete(room.code);
    }
  }

  function startGame(clientId) {
    const room = getClientRoom(clientId);
    ensureOwner(room, clientId);
    // 开新局前取消等待中的清座定时器（回收逻辑不会动对局中的房间，但定时器句柄要清）。
    clearEvictTimer(room);

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
      ruleConfig: room.ruleConfig,
    });
    room.status = "playing";
    room.pendingReactions = new Set();
    room.passedReactions = new Set();
    room.reactionWindowRef = null;
    // 保密期：开局先隐藏赖子/指示牌（手牌中性序下发），到 laiziRevealAt 时刻补发广播公开，
    // 与客户端开局动画的翻牌阶段对齐，翻开瞬间即亮牌面。
    room.laiziRevealAt = Date.now() + LAIZI_REVEAL_DELAY_MS;
    return room;
  }

  // 一局收尾（胡牌/荒庄统一入口）：清反应窗口、同步豆子，并安排无在线真人房间的回收定时器。
  function endRound(room) {
    room.status = "ended";
    room.dealerSeat = room.game.nextDealerSeat;
    room.pendingReactions = new Set();
    syncBeansFromGame(room);
    scheduleRoomEvict(room);
  }

  function handleAction(clientId, action, payload = {}) {
    const room = getClientRoom(clientId);
    const seat = clientIndex.get(clientId).seat;

    if (!room.game || room.game.status !== "playing") {
      throw fail("GAME_NOT_PLAYING", "牌局未开始");
    }

    if (action === "discard") {
      if (room.game.currentSeat !== seat || room.game.phase !== "discard") {
        throw fail("NOT_YOUR_TURN", "还没轮到你出牌");
      }
      // 客户端的 handIndex 基于下发视图的理牌序；翻牌公开前视图按"中性排序"下发
      //（不暴露赖子），与数据层的赖子置左序存在位置差异。客户端会随行附上点击的
      // 牌值，优先按牌值定位数据层索引，保证打出的就是玩家点的那张牌。
      let handIndex = Number(payload.handIndex);
      if (typeof payload.tile === "string") {
        const valueIndex = room.game.players[seat].hand.indexOf(payload.tile);
        if (valueIndex >= 0) {
          handIndex = valueIndex;
        }
      }
      room.game = discardTile(room.game, seat, handIndex);
      refreshPendingReactions(room);
      return room;
    }

    if (action === "pass") {
      room.pendingReactions.delete(seat);
      // 记入本窗口"已过"名单：refreshPendingReactions 每拍重扫真人座位，
      // 不记名会把已点"过"的玩家重新弹回决策窗口（"过"失效、牌局卡死）。
      (room.passedReactions ??= new Set()).add(seat);
      return room;
    }

    if (action === "peng") {
      if (!room.pendingReactions.has(seat)) {
        throw fail("INVALID_ACTION", "现在不能碰");
      }
      room.game = pengDiscard(room.game, seat);
      room.pendingReactions = new Set();
      return room;
    }

    if (action === "gang") {
      // 反应阶段：手里已有 3 张同牌，杠别人打出的第 4 张（明杠）。
      if (room.game.phase === "reaction") {
        if (getMingGangOptions(room.game, seat).length === 0) {
          throw fail("INVALID_ACTION", "现在不能杠");
        }
        room.game = mingGangDiscard(room.game, seat);
        room.pendingReactions = new Set();
        return room;
      }
      // 出牌阶段：自己回合可暗杠（手里 4 张同牌）或补杠（碰过后再拿到第 4 张）。
      if (room.game.currentSeat !== seat || room.game.phase !== "discard") {
        throw fail("NOT_YOUR_TURN", "现在不能杠");
      }
      if (payload.kind === "bu") {
        if (!getBuGangOptions(room.game, seat).includes(payload.tile)) {
          throw fail("INVALID_ACTION", "当前没有可补杠的牌");
        }
        room.game = buGang(room.game, seat, payload.tile);
        return room;
      }
      room.game = anGang(room.game, seat, payload.tile);
      return room;
    }

    if (action === "win") {
      if (room.game.availableWin?.seat !== seat) {
        throw fail("INVALID_ACTION", "现在不能胡");
      }
      room.game = finishWin(room.game, seat);
      endRound(room);
      return room;
    }

    throw fail("INVALID_ACTION", `未知动作：${action}`);
  }

  function advanceRoomOnce(roomCode) {
    const room = rooms.get(roomCode);
    if (!room?.game || room.game.status !== "playing") {
      return { changed: false, room };
    }

    if (room.game.phase === "reaction") {
      refreshPendingReactions(room);
      // 真人优先：还有真人等待碰/杠决策时，机器人不抢牌。
      if (room.pendingReactions.size === 0) {
        resolveBotReactions(room);
      }
      if (room.game.phase === "reaction") {
        if (room.pendingReactions.size > 0) {
          return { changed: false, room, waiting: true };
        }
        room.game = skipReactions(room.game);
      }
      return { changed: true, room };
    }

    if (room.game.phase === "draw") {
      room.game = drawForCurrentSeat(room.game);
      if (room.game.status === "ended") {
        endRound(room);
      }
      if (room.game.availableWin?.seat === room.game.currentSeat && !isHumanSeat(room, room.game.currentSeat)) {
        room.game = finishWin(room.game, room.game.currentSeat);
        endRound(room);
      }
      return { changed: true, room };
    }

    if (room.game.phase === "discard") {
      if (isHumanSeat(room, room.game.currentSeat)) {
        return { changed: false, room, waiting: true };
      }

      if (room.game.availableWin?.seat === room.game.currentSeat) {
        room.game = finishWin(room.game, room.game.currentSeat);
        endRound(room);
        return { changed: true, room };
      }

      const player = room.game.players[room.game.currentSeat];
      // 机器人：能暗杠先暗杠、碰过的牌再拿到第 4 张就直接补杠
      //（赖子除外，赖子是万能牌不能拿去杠），否则按 AI 出牌。
      const anGangTiles = getAnGangOptions(room.game, room.game.currentSeat)
        .filter((tile) => tile !== room.game.laiziTile);
      if (anGangTiles.length > 0) {
        room.game = anGang(room.game, room.game.currentSeat, anGangTiles[0]);
        return { changed: true, room };
      }
      const buGangTiles = getBuGangOptions(room.game, room.game.currentSeat)
        .filter((tile) => tile !== room.game.laiziTile);
      if (buGangTiles.length > 0) {
        room.game = buGang(room.game, room.game.currentSeat, buGangTiles[0]);
        return { changed: true, room };
      }
      const discardIndex = chooseBotDiscardIndex(player, room.game.laiziTile, {
        mustLackOneSuit: room.game.mustLackOneSuit,
        ruleConfig: room.game.ruleConfig,
      });
      room.game = discardTile(room.game, room.game.currentSeat, discardIndex);
      refreshPendingReactions(room);
      return { changed: true, room };
    }

    return { changed: false, room };
  }

  // 快速加入：优先进入一个未开局且有空位的房间；没有就自动创建新房间。
  function quickJoin({ clientId, nickname, mustLackOneSuit = false, ruleConfig = null }) {
    for (const room of rooms.values()) {
      if (room.status === "waiting" && room.seats.some((seat) => !seat.clientId)) {
        return joinRoom({ clientId, nickname, roomCode: room.code });
      }
    }
    return createRoom({ clientId, nickname, mustLackOneSuit, ruleConfig });
  }

  function getClientRoom(clientId) {
    const entry = clientIndex.get(clientId);
    if (!entry) {
      throw fail("NOT_IN_ROOM", "你还不在房间里");
    }
    const room = rooms.get(entry.roomCode);
    if (!room) {
      clientIndex.delete(clientId);
      throw fail("ROOM_NOT_FOUND", "房间不存在");
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
      game: room.game
        ? publicGameForSeat(room.game, seat, Date.now() >= (room.laiziRevealAt ?? 0))
        : null,
    };
  }

  return {
    rooms,
    clientIndex,
    createRoom,
    joinRoom,
    quickJoin,
    leaveRoom,
    markDisconnected,
    reconnectByToken,
    dissolveRoom,
    startGame,
    handleAction,
    advanceRoomOnce,
    getRoomForClient,
    roomStateForClient,
  };
}

export function publicGameForSeat(game, mySeat, revealLaizi = true) {
  const viewGame = clone(game);
  const originalPlayers = clone(game.players);
  // 翻牌仪式结束前不公开赖子/指示牌，牌墙只发牌背（客户端只用到墙长）。
  if (!revealLaizi) {
    viewGame.laiziTile = null;
    viewGame.indicatorTile = null;
    viewGame.wall = viewGame.wall.map(() => "back");
  }
  viewGame.players = Array.from({ length: PLAYER_COUNT }, (_, viewSeat) => {
    const originalSeat = toOriginalSeat(viewSeat, mySeat);
    const player = originalPlayers[originalSeat];
    const publicAll = game.status === "ended";
    let hand;
    let initialHand = player.initialHand;
    if (publicAll || viewSeat === 0) {
      if (publicAll) {
        // 结算亮牌保持数据层原序（胡牌/荒庄时的真实手牌顺序）。
        hand = player.hand;
      } else {
        // 摸牌即理牌：数据层在手牌生成/摸牌时已按"赖子最左"排序，
        // 这里统一下发理牌序（与客户端显示顺序、handIndex 打出索引保持一致）。
        // 翻牌公开前按花色点数"中性排序"（真实顺序赖子最左会暴露赖子身份）。
        hand = revealLaizi ? sortTiles(player.hand, game.laiziTile) : sortTiles(player.hand, null);
      }
    } else {
      hand = Array.from({ length: player.hand.length }, () => "back");
      // 其他家的 initialHand 就是其真实手牌（理牌前的抓牌顺序），必须一并扣下。
      initialHand = Array.from(
        { length: (player.initialHand ?? player.hand).length },
        () => "back",
      );
    }
    return {
      ...player,
      seat: viewSeat,
      originalSeat,
      hand,
      initialHand,
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
    ruleConfig: room.ruleConfig,
    dealerSeat: toViewSeat(room.dealerSeat, seat),
    invitePath: `/apps/mobile/?online=1&room=${room.code}`,
    players: rotateArray(room.seats, seat).map((seatInfo, viewSeat) => ({
      seat: viewSeat,
      originalSeat: seatInfo.seat,
      name: seatInfo.name,
      beans: seatInfo.beans,
      connected: Boolean(seatInfo.clientId && seatInfo.connected !== false),
      isYou: seatInfo.clientId === clientId,
      isOwner: seatInfo.clientId === room.ownerClientId,
    })),
    // 座位凭据：客户端存 sessionStorage，断线重连时上报换绑新连接。
    yourToken: room.seats[seat]?.token ?? null,
    // 等待/已结束状态下离线座位的预计回收时间（毫秒时间戳），供客户端倒计时提示。
    evictAt: room.evictAt ?? null,
  };
}

function refreshPendingReactions(room) {
  // 每个反应窗口只开启一次：真人点"过"记入 passedReactions，不再被弹回
  // （此前每拍重加集合会导致"过"失效、牌局卡死）。窗口结束时（碰/杠/胡/
  // 过完）集合自然清空；窗口以"最后出牌对象"的引用变化来识别新一窗。
  if (room.game?.phase !== "reaction") {
    room.pendingReactions = new Set();
    return;
  }

  if (room.game.lastDiscard !== room.reactionWindowRef) {
    room.reactionWindowRef = room.game.lastDiscard;
    room.passedReactions = new Set();
  }

  // 断线/离座真人不再阻塞决策窗口（其座位由机器人托管代打）。
  for (const seat of Array.from(room.pendingReactions)) {
    if (!isHumanSeat(room, seat)) {
      room.pendingReactions.delete(seat);
    }
  }
  for (const seat of humanSeats(room)) {
    if (!room.passedReactions.has(seat) && getPengOptions(room.game, seat).length > 0) {
      room.pendingReactions.add(seat);
    }
  }
}

// 反应阶段让机器人即时决策碰/杠；真人仍走 pendingReactions 等待操作。
// 一次循环只处理一条（碰/杠会清空 lastDiscard、进入出牌阶段）。
function resolveBotReactions(room) {
  if (room.game.phase !== "reaction" || !room.game.lastDiscard) {
    return;
  }
  const discarderSeat = room.game.lastDiscard.seat;
  for (let offset = 1; offset <= 3; offset += 1) {
    const seat = (discarderSeat + offset) % room.game.players.length;
    if (isHumanSeat(room, seat)) {
      continue;
    }
    const reaction = chooseBotReaction(room.game, seat);
    if (!reaction) {
      continue;
    }
    room.game = reaction.action === "gang"
      ? mingGangDiscard(room.game, seat)
      : pengDiscard(room.game, seat);
    break;
  }
}

function humanSeats(room) {
  return room.seats.filter((seat) => isHumanSeat(room, seat.seat)).map((seat) => seat.seat);
}

// 真人座位 = 有人且在线；断线座位视为机器人托管（AI 代打），牌局不因掉线卡死。
function isHumanSeat(room, seat) {
  const seatInfo = room.seats[seat];
  return Boolean(seatInfo?.clientId && seatInfo.connected !== false);
}

function connectedHumanCount(room) {
  return room.seats.filter((seatInfo) => seatInfo.clientId && seatInfo.connected !== false).length;
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
    // 座位凭据：客户端存 sessionStorage（刷新不丢），断线后凭它找回原座位；
    // 重新入座生成新 token，旧凭据自动失效。
    token: randomUUID(),
    connected: true,
  };
  clientIndex.set(clientId, { roomCode: room.code, seat });
}

function ensureOwner(room, clientId) {
  if (room.ownerClientId !== clientId) {
    throw fail("NOT_OWNER", "只有房主能开局");
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
    token: null,
    connected: true,
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
