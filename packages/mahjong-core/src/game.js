import {
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

export function sortTiles(tiles) {
  const order = new Map(TILE_TYPES.map((tile, index) => [tile, index]));
  return [...tiles].sort((left, right) => order.get(left) - order.get(right));
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

export function startRound(options = {}) {
  const {
    dealerSeat = 0,
    seed = Date.now(),
    playerNames = ["我", "下家", "对家", "上家"],
    beanBalances = [1000, 1000, 1000, 1000],
    mustLackOneSuit = false,
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

  for (let round = 0; round < 13; round += 1) {
    for (const player of players) {
      player.hand.push(wall.shift());
    }
  }
  players[dealerSeat].hand.push(wall.shift());

  for (const player of players) {
    player.hand = sortTiles(player.hand);
  }

  const laiziDice = rollDice(random);
  const indicatorTile = drawFromBackByDice(wall, laiziDice.total);
  const laiziTile = nextLaiziFromIndicator(indicatorTile);

  return {
    id: `round-${seed}`,
    seed,
    status: "playing",
    mustLackOneSuit,
    wall,
    players,
    dealerSeat,
    nextDealerSeat: dealerSeat,
    currentSeat: dealerSeat,
    phase: "discard",
    laiziDice,
    indicatorTile,
    laiziTile,
    diceHistory: [{ reason: "laizi", ...laiziDice }],
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
  if (nextState.wall.length === 0) {
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
  player.hand = sortTiles([...player.hand, tile]);
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
  const drawnTile = drawFromBackByDice(nextState.wall, dice.total);
  player.hand = sortTiles([...player.hand, drawnTile]);
  nextState.lastDraw = {
    seat,
    tile: drawnTile,
    fromGang: true,
  };
  nextState.diceHistory.push({ reason: "gang", seat, ...dice });
  nextState.availableWin = buildAvailableWin(nextState, seat, {
    drawnTile,
    isGangDraw: true,
    wasRunFengBeforeGang,
  });
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

export function finishWin(state, seat) {
  const nextState = cloneGame(state);
  if (!nextState.availableWin || nextState.availableWin.seat !== seat) {
    throw new Error("No available win for this player");
  }

  const settlement = scoreWin({
    winType: nextState.availableWin.winType,
    winnerSeat: seat,
    dealerSeat: nextState.dealerSeat,
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

  const { mustLackOneSuit = false } = options;
  const exposedMeldCount = player.melds?.length ?? 0;
  const candidates = player.hand.map((tile, index) => {
    const remaining = player.hand.filter((_, handIndex) => handIndex !== index);
    const winningDraws = countWinningDraws(remaining, laiziTile, {
      exposedMeldCount,
      mustLackOneSuit,
    });
    const structureScore = scoreHandStructure(remaining, laiziTile);
    const discardCost = scoreTileUsefulness(tile, player.hand, laiziTile);
    const laiziPenalty = tile === laiziTile ? 100000 : 0;

    return {
      index,
      score: winningDraws * 1000 + structureScore - discardCost - laiziPenalty,
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

function countWinningDraws(waitingTiles, laiziTile, options = {}) {
  const { exposedMeldCount = 0, mustLackOneSuit = false } = options;
  if (canRunFeng(waitingTiles, laiziTile, { exposedMeldCount, mustLackOneSuit })) {
    return TILE_TYPES.length;
  }

  return TILE_TYPES.reduce((total, drawnTile) => {
    const winType = resolveWinType({
      tiles: [...waitingTiles, drawnTile],
      laiziTile,
      exposedMeldCount,
      mustLackOneSuit,
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
  const winType = resolveWinType({
    tiles: player.hand,
    laiziTile: state.laiziTile,
    mustLackOneSuit: state.mustLackOneSuit,
    exposedMeldCount: player.melds.length,
    ...extra,
  });

  if (!winType) {
    return null;
  }

  return {
    seat,
    winType,
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
