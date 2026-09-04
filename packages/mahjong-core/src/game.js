import {
  SUITS,
  TILE_TYPES,
  countTile,
  countTiles,
  createWall,
  getRank,
  getSuit,
  isNumberTile,
  nextLaiziFromIndicator,
} from "./tiles.js";
import {
  canRunFeng,
  normalizeRuleConfig,
  resolveWinDetail,
  resolveWinType,
  scoreWin,
  nextDealer,
} from "./qingyang-pinghu.js";

export function createSeededRandom(seed = Date.now()) {
  let state = hashSeed(String(seed));
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function rollDice(random = Math.random) {
  const first = Math.floor(random() * 6) + 1;
  const second = Math.floor(random() * 6) + 1;
  return {
    dice: [first, second],
    total: first + second,
  };
}

export function shuffleTiles(tiles, random = Math.random) {
  const shuffled = [...tiles];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function sortTiles(tiles, laiziTile = null) {
  const order = new Map(TILE_TYPES.map((tile, index) => [tile, index]));
  // 赖子固定排在最左边，其余按花色点数排序。
  return [...tiles].sort((left, right) => {
    const leftLaizi = laiziTile && left === laiziTile ? 0 : 1;
    const rightLaizi = laiziTile && right === laiziTile ? 0 : 1;
    if (leftLaizi !== rightLaizi) {
      return leftLaizi - rightLaizi;
    }
    return order.get(left) - order.get(right);
  });
}

export function drawFromBackByDice(wall, diceTotal) {
  if (wall.length === 0) {
    throw new Error("Cannot draw from an empty wall");
  }
  const safeTotal = Math.max(1, Math.min(diceTotal, wall.length));
  const index = wall.length - safeTotal;
  const [tile] = wall.splice(index, 1);
  return tile;
}

// 杠牌补牌取牌：骰子点数 n 对应排尾第 n 墩（第 1 墩最靠排尾，与翻牌同口径）。
// consumedStacks 记录此前取过牌的墩号（翻牌 1 次 + 更早的每次杠补各 1 次）：
//   - 目标墩的上层已被取走 → 取该墩剩下的下层（"一张是翻牌/被杠，另一张还在"）；
//   - 目标墩两张都已取走，或剩余牌墙数不到第 n 墩 → 空过（返回 null，不补牌）。
export function takeGangReplacement(wall, consumedStacks, diceTotal) {
  const taken = consumedStacks.filter((stack) => stack === diceTotal).length;
  if (taken >= 2) {
    return null;
  }
  // 更靠排尾一侧（墩号更小）的每次取牌使目标墩位置向排尾移 1 张。
  const nearer = consumedStacks.filter((stack) => stack < diceTotal).length;
  const position = taken === 0 ? 2 * diceTotal - nearer : 2 * diceTotal - 1 - nearer;
  const index = wall.length - position;
  if (index < 0) {
    return null;
  }
  const [tile] = wall.splice(index, 1);
  return tile;
}

// 翻指示牌：每墩 2 张，从排尾按墩数出 diceTotal 墩，取该墩上层一张翻开。
// 排尾最后一墩为第 1 墩；墩内数组顺序为 [上层, 底层]，故第 N 墩上层下标为 len - 2N。
export function drawIndicatorFromBack(wall, diceTotal) {
  if (wall.length === 0) {
    throw new Error("Cannot draw from an empty wall");
  }
  const maxStacks = Math.floor(wall.length / 2);
  const safeTotal = Math.max(1, Math.min(diceTotal, maxStacks));
  const index = Math.max(0, Math.min(wall.length - 1, wall.length - 2 * safeTotal));
  const [tile] = wall.splice(index, 1);
  return tile;
}

export function startRound(options = {}) {
  const {
    dealerSeat = 0,
    seed = Date.now(),
    playerNames = ["我", "下家", "对家", "上家"],
    beanBalances = [1000, 1000, 1000, 1000],
    mustLackOneSuit = false,
    ruleConfig = null,
  } = options;

  const random = createSeededRandom(seed);
  const wall = shuffleTiles(createWall(), random);
  const players = Array.from({ length: 4 }, (_, seat) => ({
    seat,
    name: playerNames[seat] ?? `玩家${seat + 1}`,
    hand: [],
    melds: [],
    discards: [],
    beans: beanBalances[seat] ?? 1000,
  }));

  // 标准抓牌流程（青阳麻将与国标一致）：
  // 1) 每人先抓 3 次，每次 2 墩（4 张），共 12 张，从庄家开始按座位顺序轮流；
  // 2) 头家（庄家）跳着抓最后 2 张：抓第 1 张、跳过第 2 张、再抓第 3 张（共 14 张）；
  //    被跳过的那张仍留在墙头，下家补抓时自然摸到，不损失任何牌；
  // 3) 其余三家按座位顺序依次各补抓 1 张（各 13 张）。
  const seatOrder = [0, 1, 2, 3].map((offset) => (dealerSeat + offset) % players.length);
  for (let batch = 0; batch < 3; batch += 1) {
    for (const seat of seatOrder) {
      for (let tileIndex = 0; tileIndex < 4; tileIndex += 1) {
        players[seat].hand.push(wall.shift());
      }
    }
  }
  players[dealerSeat].hand.push(wall.shift());
  players[dealerSeat].hand.push(wall.splice(1, 1)[0]);
  for (const seat of seatOrder.slice(1)) {
    players[seat].hand.push(wall.shift());
  }

  const laiziDice = rollDice(random);
  // 翻牌骰的和按墩从排尾数（第 N 墩上层翻开），与桌面牌墙可视位置一一对应。
  const indicatorTile = drawIndicatorFromBack(wall, laiziDice.total);
  const laiziTile = nextLaiziFromIndicator(indicatorTile);

  // 开局骰：庄家开抓前先扔一次。点数和决定从哪家面前开墙（从庄家数起），
  // 两颗骰子中较小的点数决定在该家墙边留几墩后开始抓；
  // 翻牌骰（laiziDice）则是抓完牌后扔的第二次，从排尾数出翻牌。
  // 注意：为保持既有种子局面的翻牌结果不变，openingDice 在 laiziDice 之后取随机数。
  const openingDice = rollDice(random);

  // 有效摸牌区（死墙）：翻牌那墩及其排尾方向各墩不可摸，另加翻牌靠牌头一侧的
  // 一墩（俗称"翻牌前一墩"），共 (骰数+1) 墩；扣除翻牌自身 1 张后初始死墙 = 2×骰数+1 张。
  // 例：翻牌骰 3 → 倒数第 4 墩起不可摸（7 张）。摸到边界即流局；
  // 之后每次杠牌，边界（墩）= max(翻牌骰, 杠骰) + 1 + 杠的次数（见 advanceDeadWallByGang）。
  const deadWallTiles = laiziDice.total * 2 + 1;

  // 确定赖子后再理牌，让赖子排在手牌最左边。
  // initialHand 保留发牌原始顺序（理牌前），供开局发牌动画按抓牌批次明牌展示、发完再统一排序。
  for (const player of players) {
    player.initialHand = [...player.hand];
    player.hand = sortTiles(player.hand, laiziTile);
  }

  return {
    id: `round-${seed}`,
    seed,
    status: "playing",
    mustLackOneSuit,
    ruleConfig: normalizeRuleConfig(ruleConfig),
    penaltyStreak: null,
    wall,
    players,
    dealerSeat,
    nextDealerSeat: dealerSeat,
    currentSeat: dealerSeat,
    phase: "discard",
    laiziDice,
    indicatorTile,
    laiziTile,
    openingDice,
    deadWallTiles,
    diceHistory: [
      { reason: "opening", seat: dealerSeat, ...openingDice },
      { reason: "laizi", seat: dealerSeat, ...laiziDice },
    ],
    turn: 0,
    lastDiscard: null,
    lastDraw: null,
    availableWin: null,
    runFengBeforeDraw: [false, false, false, false],
    winnerSeat: null,
    winType: null,
    settlement: null,
    log: [
      {
        type: "roundStarted",
        dealerSeat,
        indicatorTile,
        laiziTile,
        dice: laiziDice,
        openingDice,
      },
    ],
  };
}

export function drawForCurrentSeat(state, options = {}) {
  const nextState = cloneGame(state);
  const player = nextState.players[nextState.currentSeat];
  if (nextState.status !== "playing") {
    return nextState;
  }
  if (nextState.phase !== "draw") {
    throw new Error(`Expected draw phase, got ${nextState.phase}`);
  }
  // 有效摸牌区：墙头摸到死墙边界（含牌墙摸穿）即流局。
  if (nextState.wall.length <= (nextState.deadWallTiles ?? 0)) {
    nextState.status = "ended";
    nextState.phase = "ended";
    nextState.nextDealerSeat = nextDealer({
      currentDealerSeat: nextState.dealerSeat,
      winnerSeat: null,
      isDraw: true,
    });
    nextState.log.push({ type: "drawGame" });
    return nextState;
  }

  const wasRunFengBeforeDraw = canRunFeng(player.hand, nextState.laiziTile, {
    mustLackOneSuit: nextState.mustLackOneSuit,
    exposedMeldCount: player.melds.length,
  });
  nextState.runFengBeforeDraw[player.seat] = wasRunFengBeforeDraw;

  const tile = nextState.wall.shift();
  // 摸牌即理牌：摸到的牌按顺序插入手牌（赖子最左）。
  // 客户端展示顺序与 handIndex 打出索引因此始终一致，摸牌不再挂在末尾。
  player.hand = sortTiles([...player.hand, tile], nextState.laiziTile);
  nextState.lastDraw = {
    seat: player.seat,
    tile,
  };
  nextState.phase = "discard";
  nextState.turn += 1;
  nextState.availableWin = buildAvailableWin(nextState, player.seat, {
    drawnTile: tile,
    wasRunFengBeforeDraw,
  });
  nextState.log.push({
    type: "draw",
    seat: player.seat,
    tile,
    wasRunFengBeforeDraw,
  });

  return nextState;
}

export function discardTile(state, seat, handIndex) {
  const nextState = cloneGame(state);
  const player = nextState.players[seat];
  if (nextState.status !== "playing") {
    return nextState;
  }
  if (nextState.phase !== "discard" || nextState.currentSeat !== seat) {
    throw new Error("It is not this player's discard turn");
  }
  if (handIndex < 0 || handIndex >= player.hand.length) {
    throw new Error(`Invalid hand index: ${handIndex}`);
  }

  const [tile] = player.hand.splice(handIndex, 1);
  // 打出后重新理牌（赖子仍排最左），之前单放的摸牌此时归位。
  player.hand = sortTiles(player.hand, nextState.laiziTile);
  player.discards.push(tile);
  nextState.lastDraw = null;
  nextState.lastDiscard = {
    seat,
    tile,
    discardIndex: player.discards.length - 1,
  };
  nextState.availableWin = null;
  nextState.phase = "reaction";
  nextState.log.push({ type: "discard", seat, tile });
  applyStreakPenalty(nextState, seat, tile);

  return nextState;
}

// 连打惩罚：四家连续打出同一张牌时，第一个打出的玩家向其余三家各付 1 子（折算为倍率豆）。
// 打出不同的牌立即重置计数；同一玩家重复打同一张不重复计数；触发后重新开表。
function applyStreakPenalty(nextState, seat, tile) {
  const rules = nextState.ruleConfig?.rules;
  if (!rules?.streakPenalty) {
    return;
  }

  const streak = nextState.penaltyStreak;
  if (!streak || streak.tile !== tile) {
    nextState.penaltyStreak = { tile, seats: [seat] };
    return;
  }
  if (streak.seats.includes(seat)) {
    return;
  }
  streak.seats.push(seat);
  if (streak.seats.length < nextState.players.length) {
    return;
  }

  const payerSeat = streak.seats[0];
  const amount = nextState.ruleConfig.multiplier;
  for (const player of nextState.players) {
    if (player.seat === payerSeat) {
      continue;
    }
    player.beans += amount;
  }
  nextState.players[payerSeat].beans -= amount * (nextState.players.length - 1);
  nextState.log.push({
    type: "streakPenalty",
    tile,
    payerSeat,
    amount,
    seats: [...streak.seats],
  });
  nextState.penaltyStreak = null;
}

// 摸牌展示一段时间后调用：把右端单放的摸牌并入手牌排序（赖子仍在最左），
// 之后不再单独展示摸牌。若期间已打出牌（lastDraw 已清空）则安全无操作。
export function mergeDrawnTile(state, seat = state.currentSeat) {
  const nextState = cloneGame(state);
  if (nextState.status !== "playing" || !nextState.lastDraw || nextState.lastDraw.seat !== seat) {
    return nextState;
  }
  const player = nextState.players[seat];
  player.hand = sortTiles(player.hand, nextState.laiziTile);
  nextState.lastDraw = null;
  return nextState;
}

export function skipReactions(state) {
  const nextState = cloneGame(state);
  if (nextState.phase !== "reaction") {
    return nextState;
  }
  nextState.currentSeat = (nextState.lastDiscard.seat + 1) % nextState.players.length;
  nextState.phase = "draw";
  nextState.lastDiscard = null;
  nextState.log.push({ type: "skipReactions", currentSeat: nextState.currentSeat });
  return nextState;
}

export function getPengOptions(state, seat) {
  if (state.phase !== "reaction" || !state.lastDiscard || state.lastDiscard.seat === seat) {
    return [];
  }
  const player = state.players[seat];
  if (countTile(player.hand, state.lastDiscard.tile) < 2) {
    return [];
  }
  return [state.lastDiscard.tile];
}

export function pengDiscard(state, seat) {
  const nextState = cloneGame(state);
  const options = getPengOptions(nextState, seat);
  if (options.length === 0) {
    throw new Error("Peng is not available");
  }

  const tile = options[0];
  const player = nextState.players[seat];
  removeTiles(player.hand, tile, 2);
  player.melds.push({ type: "peng", tile, tiles: [tile, tile, tile], fromSeat: nextState.lastDiscard.seat });

  const discarder = nextState.players[nextState.lastDiscard.seat];
  discarder.discards.splice(nextState.lastDiscard.discardIndex, 1);

  nextState.currentSeat = seat;
  nextState.phase = "discard";
  nextState.lastDiscard = null;
  nextState.availableWin = null;
  nextState.log.push({ type: "peng", seat, tile });
  return nextState;
}

// 反应阶段的明杠：别人打出的牌，自己手里已有 3 张（暗刻），可以亮牌开明杠。
export function getMingGangOptions(state, seat) {
  if (state.phase !== "reaction" || !state.lastDiscard || state.lastDiscard.seat === seat) {
    return [];
  }
  const player = state.players[seat];
  if (countTile(player.hand, state.lastDiscard.tile) < 3) {
    return [];
  }
  return [state.lastDiscard.tile];
}

// 明杠：亮出手里的 3 张与别人打出的 1 张组成杠子，掷骰从牌墙尾部补抓 1 张。
// 杠牌推进死墙边界：边界（墩）= max(翻牌骰, 历次杠骰) + 1 + 杠的次数，
// 张数 = 墩数×2 − 界内已取走的张数（翻牌 1 张 + 每次杠补 1 张）。
// 例：翻 5 不杠 → 5+1=6 墩；翻 3 杠 5 → 5+1+1=7 墩；翻 3 杠 2 → 3+1+1=5 墩；
// 杠骰比翻牌骰小时不拉低基数（仍取历史最大），比翻牌骰大时抬高基数；每次杠至少再推进 1 墩。
function advanceDeadWallByGang(state, dice) {
  const priorKongs = state.diceHistory.filter(
    (entry) => entry.reason !== "opening" && entry.reason !== "laizi"
  );
  const kongCount = priorKongs.length + 1;
  const baseDice = priorKongs.reduce(
    (max, entry) => Math.max(max, entry.total),
    state.laiziDice.total
  );
  state.deadWallTiles = (Math.max(baseDice, dice.total) + 1 + kongCount) * 2 - 1 - kongCount;
}

export function mingGangDiscard(state, seat, random = Math.random) {
  const nextState = cloneGame(state);
  const options = getMingGangOptions(nextState, seat);
  if (options.length === 0) {
    throw new Error("Ming gang is not available");
  }

  const tile = options[0];
  const player = nextState.players[seat];
  removeTiles(player.hand, tile, 3);
  player.melds.push({
    type: "mingGang",
    tile,
    tiles: [tile, tile, tile, tile],
    fromSeat: nextState.lastDiscard.seat,
  });

  const discarder = nextState.players[nextState.lastDiscard.seat];
  discarder.discards.splice(nextState.lastDiscard.discardIndex, 1);

  const wasRunFengBeforeGang = nextState.runFengBeforeDraw[seat] === true;
  const dice = rollDice(random);
  advanceDeadWallByGang(nextState, dice);
  // 杠补按墩取牌：骰子指到的墩已被取空或数不到时"空过"（不补牌，牌墙见底同理）。
  const consumedStacks = nextState.diceHistory
    .filter((entry) => entry.reason !== "opening")
    .map((entry) => entry.total);
  const drawnTile = takeGangReplacement(nextState.wall, consumedStacks, dice.total);
  if (drawnTile) {
    // 杠补与普通摸牌同口径：按理牌序插入手牌（赖子最左）。下发视图按理牌序重排，
    // 若核心层挂在末尾，视图索引与数据层索引会错位（点杠补牌会打出别的牌）。
    player.hand = sortTiles([...player.hand, drawnTile], nextState.laiziTile);
    nextState.lastDraw = {
      seat,
      tile: drawnTile,
      fromGang: true,
    };
    nextState.availableWin = buildAvailableWin(nextState, seat, {
      drawnTile,
      isGangDraw: true,
      wasRunFengBeforeGang,
    });
  }
  nextState.diceHistory.push({ reason: "mingGang", seat, ...dice });
  nextState.currentSeat = seat;
  nextState.phase = "discard";
  nextState.lastDiscard = null;
  nextState.log.push({ type: "mingGang", seat, tile, dice, drawnTile });

  return nextState;
}

export function getAnGangOptions(state, seat) {
  if (state.status !== "playing" || state.phase !== "discard" || state.currentSeat !== seat) {
    return [];
  }
  const player = state.players[seat];
  return TILE_TYPES.filter((tile) => countTile(player.hand, tile) === 4);
}

export function anGang(state, seat, tile, random = Math.random) {
  const nextState = cloneGame(state);
  const player = nextState.players[seat];
  if (!getAnGangOptions(nextState, seat).includes(tile)) {
    throw new Error(`An gang is not available for ${tile}`);
  }

  const wasRunFengBeforeGang = nextState.runFengBeforeDraw[seat] === true;
  removeTiles(player.hand, tile, 4);
  player.melds.push({ type: "anGang", tile, tiles: [tile, tile, tile, tile], concealed: true });

  const dice = rollDice(random);
  advanceDeadWallByGang(nextState, dice);
  // 杠补按墩取牌：骰子指到的墩已被取空或数不到时"空过"（不补牌）。
  const consumedStacks = nextState.diceHistory
    .filter((entry) => entry.reason !== "opening")
    .map((entry) => entry.total);
  const drawnTile = takeGangReplacement(nextState.wall, consumedStacks, dice.total);
  if (drawnTile) {
    // 杠补与普通摸牌同口径：按理牌序插入手牌（赖子最左），视图索引与数据层索引一致。
    player.hand = sortTiles([...player.hand, drawnTile], nextState.laiziTile);
    nextState.lastDraw = {
      seat,
      tile: drawnTile,
      fromGang: true,
    };
    nextState.availableWin = buildAvailableWin(nextState, seat, {
      drawnTile,
      isGangDraw: true,
      wasRunFengBeforeGang,
    });
  }
  nextState.diceHistory.push({ reason: "gang", seat, ...dice });
  nextState.phase = "discard";
  nextState.log.push({
    type: "anGang",
    seat,
    tile,
    dice,
    drawnTile,
    wasRunFengBeforeGang,
  });

  return nextState;
}

// 补杠（加杠）：碰过某牌后，自己回合手里又拿到第 4 张，可把碰组升级为明杠并从墙尾补牌。
export function getBuGangOptions(state, seat) {
  if (state.status !== "playing" || state.phase !== "discard" || state.currentSeat !== seat) {
    return [];
  }
  const player = state.players[seat];
  const pengTiles = player.melds
    .filter((meld) => meld.type === "peng")
    .map((meld) => meld.tile);
  return TILE_TYPES.filter((tile) => pengTiles.includes(tile) && countTile(player.hand, tile) >= 1);
}

// 执行补杠：手牌移除第 4 张并入对应碰组（type 升级为 buGang），掷骰从墙尾补一张。
// 牌墙见底时仍可成杠，只是补不出牌（与明杠口径一致）。
export function buGang(state, seat, tile, random = Math.random) {
  const nextState = cloneGame(state);
  const player = nextState.players[seat];
  if (!getBuGangOptions(nextState, seat).includes(tile)) {
    throw new Error(`Bu gang is not available for ${tile}`);
  }

  const wasRunFengBeforeGang = nextState.runFengBeforeDraw[seat] === true;
  removeTiles(player.hand, tile, 1);
  const pengMeld = player.melds.find((meld) => meld.type === "peng" && meld.tile === tile);
  pengMeld.type = "buGang";
  pengMeld.tiles = [...pengMeld.tiles, tile];

  const dice = rollDice(random);
  advanceDeadWallByGang(nextState, dice);
  // 杠补按墩取牌：骰子指到的墩已被取空或数不到时"空过"（不补牌）。
  const consumedStacks = nextState.diceHistory
    .filter((entry) => entry.reason !== "opening")
    .map((entry) => entry.total);
  const drawnTile = takeGangReplacement(nextState.wall, consumedStacks, dice.total);
  if (drawnTile) {
    // 杠补与普通摸牌同口径：按理牌序插入手牌（赖子最左），视图索引与数据层索引一致。
    player.hand = sortTiles([...player.hand, drawnTile], nextState.laiziTile);
    nextState.lastDraw = {
      seat,
      tile: drawnTile,
      fromGang: true,
    };
    nextState.availableWin = buildAvailableWin(nextState, seat, {
      drawnTile,
      isGangDraw: true,
      wasRunFengBeforeGang,
    });
  }
  nextState.diceHistory.push({ reason: "buGang", seat, ...dice });
  nextState.phase = "discard";
  nextState.log.push({
    type: "buGang",
    seat,
    tile,
    dice,
    drawnTile,
    wasRunFengBeforeGang,
  });

  return nextState;
}

export function finishWin(state, seat) {
  const nextState = cloneGame(state);
  if (!nextState.availableWin || nextState.availableWin.seat !== seat) {
    throw new Error("No available win for this player");
  }

  const settlement = scoreWin({
    winDetail: nextState.availableWin.detail,
    winnerSeat: seat,
    dealerSeat: nextState.dealerSeat,
    multiplier: nextState.ruleConfig?.multiplier,
  });
  for (const player of nextState.players) {
    player.beans += settlement.deltas[player.seat];
  }

  nextState.status = "ended";
  nextState.phase = "ended";
  nextState.winnerSeat = seat;
  nextState.winType = nextState.availableWin.winType;
  nextState.settlement = settlement;
  nextState.availableWin = null;
  nextState.nextDealerSeat = nextDealer({
    currentDealerSeat: nextState.dealerSeat,
    winnerSeat: seat,
    isDraw: false,
  });
  nextState.log.push({ type: "win", seat, settlement });

  return nextState;
}

export function chooseBotDiscardIndex(player, laiziTile, options = {}) {
  if (player.hand.length === 0) {
    return -1;
  }

  const { mustLackOneSuit = false, ruleConfig } = options;
  // 打缺感知：缺一门模式下，若手牌仍横跨 3 门数字牌，锁定数量最少的一门作为
  // 目标缺门；打这门牌获得大额加分，确保机器人会主动打缺。
  // （此时 resolveWinType 对所有候选都返回 0 进张，加分项可完全主导出牌选择。）
  const lackSuit = mustLackOneSuit ? chooseLackSuit(player.hand).suit : null;

  const exposedMeldCount = player.melds?.length ?? 0;
  const candidates = player.hand.map((tile, index) => {
    const remaining = player.hand.filter((_, handIndex) => handIndex !== index);
    const winningDraws = countWinningDraws(remaining, laiziTile, {
      exposedMeldCount,
      mustLackOneSuit,
      ruleConfig,
    });
    const structureScore = scoreHandStructure(remaining, laiziTile);
    const discardCost = scoreTileUsefulness(tile, player.hand, laiziTile);
    const laiziPenalty = tile === laiziTile ? 100000 : 0;
    const lackBonus =
      lackSuit && isNumberTile(tile) && getSuit(tile) === lackSuit ? 4000 : 0;

    return {
      index,
      score: winningDraws * 1000 + structureScore - discardCost - laiziPenalty + lackBonus,
    };
  });

  candidates.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }
    return right.index - left.index;
  });

  return candidates[0].index;
}

// 反应阶段的机器人碰/杠决策：返回 { action: "gang" | "peng", tile } 或 null（过）。
// 规则：明杠基本必杠（多摸一张牌且保持结构）；碰牌要求不亏结构（成刻 +90 能
// 弥补拆搭损失），且不碰赖子、不碰属于应打缺花色的牌。
export function chooseBotReaction(state, seat) {
  const player = state.players[seat];

  const gangOptions = getMingGangOptions(state, seat);
  if (gangOptions.length > 0 && !isBlockedForLack(player.hand, gangOptions[0], state.mustLackOneSuit)) {
    return { action: "gang", tile: gangOptions[0] };
  }

  const pengOptions = getPengOptions(state, seat);
  if (pengOptions.length === 0) {
    return null;
  }
  const tile = pengOptions[0];
  // 赖子当万能牌用，不拿来碰。
  if (tile === state.laiziTile) {
    return null;
  }
  if (isBlockedForLack(player.hand, tile, state.mustLackOneSuit)) {
    return null;
  }

  // 比较碰前后的结构分：碰后剩 11 张 + 成刻（+90），允许小幅亏损（-12）换速度。
  const remaining = [...player.hand];
  removeTiles(remaining, tile, 2);
  const scoreBefore = scoreHandStructure(player.hand, state.laiziTile);
  const scoreAfter = scoreHandStructure(remaining, state.laiziTile) + 90;
  if (scoreAfter < scoreBefore - 12) {
    return null;
  }
  return { action: "peng", tile };
}

// 统计手牌中某数字花色的张数。
function countSuitTiles(tiles, suit) {
  return tiles.reduce(
    (total, tile) => total + (isNumberTile(tile) && getSuit(tile) === suit ? 1 : 0),
    0,
  );
}

// 定缺目标：手牌横跨 3 门数字牌时，返回张数最少的花色；已缺门（≤2 门）则返回 null。
function chooseLackSuit(tiles) {
  const suitsInHand = SUITS.filter((suit) => countSuitTiles(tiles, suit) > 0);
  if (suitsInHand.length < 3) {
    return { suit: null, count: 0 };
  }
  let lackSuit = suitsInHand[0];
  let lackCount = countSuitTiles(tiles, lackSuit);
  for (const suit of suitsInHand.slice(1)) {
    const count = countSuitTiles(tiles, suit);
    if (count < lackCount) {
      lackSuit = suit;
      lackCount = count;
    }
  }
  return { suit: lackSuit, count: lackCount };
}

// 缺一门模式下，判断这张牌是否属于应打缺的花色（此时碰/杠会把它锁进副露，妨碍打缺）。
function isBlockedForLack(tiles, tile, mustLackOneSuit) {
  if (!mustLackOneSuit || !isNumberTile(tile)) {
    return false;
  }
  const { suit: lackSuit } = chooseLackSuit(tiles);
  return lackSuit !== null && getSuit(tile) === lackSuit;
}

function countWinningDraws(waitingTiles, laiziTile, options = {}) {
  const { exposedMeldCount = 0, mustLackOneSuit = false, ruleConfig } = options;
  const config = normalizeRuleConfig(ruleConfig);
  if (canRunFeng(waitingTiles, laiziTile, { exposedMeldCount, mustLackOneSuit })) {
    // 全听手摸任何牌都胡，但按跑风分类结算：相应基础型全部关闭时，
    // 全听手反而一手不可胡（0 进张），避免机器人在受限房间里高估全听型。
    const laiziCount = countTile(waitingTiles, laiziTile);
    const runFengEnabled =
      laiziCount === 0
        ? config.rules.enDou || config.rules.paoFeng1
        : laiziCount === 1
          ? config.rules.paoFeng1 || config.rules.paoFeng2
          : config.rules.paoFeng2;
    return runFengEnabled ? TILE_TYPES.length : 0;
  }

  return TILE_TYPES.reduce((total, drawnTile) => {
    const winType = resolveWinType({
      tiles: [...waitingTiles, drawnTile],
      laiziTile,
      exposedMeldCount,
      mustLackOneSuit,
      ruleConfig,
    });
    return total + (winType ? 1 : 0);
  }, 0);
}

function scoreHandStructure(tiles, laiziTile) {
  const counts = countTiles(tiles);
  let score = countTile(tiles, laiziTile) * 120;

  for (const tile of TILE_TYPES) {
    const count = countTile(tiles, tile);
    if (count === 0 || tile === laiziTile) {
      continue;
    }

    if (count >= 3) {
      score += 90;
    } else if (count === 2) {
      score += 42;
    } else {
      score += scoreTileShape(tile, counts);
    }
  }

  return score;
}

function scoreTileUsefulness(tile, tiles, laiziTile) {
  if (tile === laiziTile) {
    return 1000;
  }

  const counts = countTiles(tiles);
  const count = countTile(tiles, tile);
  if (count >= 3) {
    return 90;
  }
  if (count === 2) {
    return 48;
  }

  return scoreTileShape(tile, counts);
}

function scoreTileShape(tile, counts) {
  if (!isNumberTile(tile)) {
    return 4;
  }

  const suit = getSuit(tile);
  const rank = getRank(tile);
  let score = 8;

  const has = (nextRank) => {
    if (nextRank < 1 || nextRank > 9) {
      return false;
    }
    return counts[TILE_TYPES.indexOf(`${suit}-${nextRank}`)] > 0;
  };

  if (has(rank - 1)) score += 24;
  if (has(rank + 1)) score += 24;
  if (has(rank - 2)) score += 10;
  if (has(rank + 2)) score += 10;
  if (has(rank - 1) && has(rank + 1)) score += 24;
  if ((has(rank - 2) && has(rank - 1)) || (has(rank + 1) && has(rank + 2))) {
    score += 30;
  }

  return score;
}

function buildAvailableWin(state, seat, extra) {
  const player = state.players[seat];
  const detail = resolveWinDetail({
    tiles: player.hand,
    laiziTile: state.laiziTile,
    mustLackOneSuit: state.mustLackOneSuit,
    exposedMeldCount: player.melds.length,
    melds: player.melds,
    ruleConfig: state.ruleConfig,
    ...extra,
  });

  if (!detail) {
    return null;
  }

  return {
    seat,
    winType: detail.baseType,
    detail,
    drawnTile: extra.drawnTile,
  };
}

function removeTiles(tiles, tile, count) {
  let removed = 0;
  for (let index = tiles.length - 1; index >= 0 && removed < count; index -= 1) {
    if (tiles[index] === tile) {
      tiles.splice(index, 1);
      removed += 1;
    }
  }
  if (removed !== count) {
    throw new Error(`Could not remove ${count} ${tile} tiles`);
  }
}

function cloneGame(state) {
  return JSON.parse(JSON.stringify(state));
}

function hashSeed(seed) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
