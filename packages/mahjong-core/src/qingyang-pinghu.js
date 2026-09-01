import {
  SUITS,
  TILE_INDEX,
  TILE_TYPES,
  assertTile,
  countTile,
  countTiles,
  getRank,
  getSuit,
  isNumberTile,
} from "./tiles.js";

export const WIN_TYPES = {
  PING_HU: "pingHu",
  RUN_FENG: "runFeng",
  GANG_PING_HU: "gangPingHu",
  ZHI_GANG: "zhiGang",
};

export const QINGYANG_PINGHU_RULES = {
  allowDiscardWin: false,
  allowChi: false,
  allowPeng: true,
  allowMingGang: true,
  allowAnGang: true,
  allowBuGang: true,
  laiziLimitForPingHu: 2,
  beanRate: 1,
  scores: {
    [WIN_TYPES.PING_HU]: { normal: 5, dealer: 10 },
    [WIN_TYPES.RUN_FENG]: { normal: 10, dealer: 20 },
    [WIN_TYPES.GANG_PING_HU]: { normal: 25, dealer: 30 },
    [WIN_TYPES.ZHI_GANG]: { normal: 60, dealer: 70 },
  },
};

export function hasLackOneSuit(tiles) {
  const presentSuits = new Set();
  for (const tile of tiles) {
    assertTile(tile);
    const suit = getSuit(tile);
    if (SUITS.includes(suit)) {
      presentSuits.add(suit);
    }
  }
  return presentSuits.size <= 2;
}

export function canPingHu(tiles, laiziTile, options = {}) {
  assertTile(laiziTile);
  const { mustLackOneSuit = false, exposedMeldCount = 0 } = options;

  if (mustLackOneSuit && !hasLackOneSuit(tiles)) {
    return false;
  }

  const laiziCount = countTile(tiles, laiziTile);
  if (laiziCount >= QINGYANG_PINGHU_RULES.laiziLimitForPingHu) {
    return false;
  }

  return canStandardHu(tiles, laiziTile, { exposedMeldCount });
}

export function canHu(tiles, laiziTile, options = {}) {
  assertTile(laiziTile);
  const { mustLackOneSuit = false, runFeng = false, exposedMeldCount = 0 } = options;

  if (mustLackOneSuit && !hasLackOneSuit(tiles)) {
    return false;
  }

  if (runFeng) {
    return canStandardHu(tiles, laiziTile, { exposedMeldCount });
  }

  return canPingHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount });
}

export function canRunFeng(waitingTiles, laiziTile, options = {}) {
  assertTile(laiziTile);
  const { mustLackOneSuit = false, exposedMeldCount = 0 } = options;

  return TILE_TYPES.every((drawnTile) =>
    canHu([...waitingTiles, drawnTile], laiziTile, {
      mustLackOneSuit,
      exposedMeldCount,
      runFeng: true,
    }),
  );
}

export function resolveWinType(context) {
  const {
    tiles,
    laiziTile,
    mustLackOneSuit = false,
    exposedMeldCount = 0,
    isGangDraw = false,
    wasRunFengBeforeGang = false,
    wasRunFengBeforeDraw = false,
  } = context;

  if (isGangDraw && wasRunFengBeforeGang) {
    if (canHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount, runFeng: true })) {
      return WIN_TYPES.ZHI_GANG;
    }
    return null;
  }

  if (wasRunFengBeforeDraw) {
    if (canHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount, runFeng: true })) {
      return WIN_TYPES.RUN_FENG;
    }
    return null;
  }

  if (isGangDraw) {
    if (canPingHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount })) {
      return WIN_TYPES.GANG_PING_HU;
    }
    return null;
  }

  if (canPingHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount })) {
    return WIN_TYPES.PING_HU;
  }

  return null;
}

export function scoreWin({ winType, winnerSeat, dealerSeat, playerCount = 4 }) {
  if (!QINGYANG_PINGHU_RULES.scores[winType]) {
    throw new Error(`Unsupported win type: ${winType}`);
  }
  if (playerCount !== 4) {
    throw new Error("Qingyang Pinghu currently expects 4 players");
  }

  const isDealer = winnerSeat === dealerSeat;
  const scoreConfig = QINGYANG_PINGHU_RULES.scores[winType];
  const payments = Array(playerCount).fill(0);
  const deltas = Array(playerCount).fill(0);

  for (let seat = 0; seat < playerCount; seat += 1) {
    if (seat === winnerSeat) {
      continue;
    }

    const payerIsDealer = seat === dealerSeat;
    const points = isDealer || payerIsDealer ? scoreConfig.dealer : scoreConfig.normal;
    const beanDelta = points * QINGYANG_PINGHU_RULES.beanRate;
    payments[seat] = beanDelta;
    deltas[seat] = -beanDelta;
    deltas[winnerSeat] += beanDelta;
  }

  return {
    winType,
    winnerSeat,
    dealerSeat,
    isDealer,
    normalPoints: scoreConfig.normal,
    dealerPoints: scoreConfig.dealer,
    pointsPerLoser: isDealer ? scoreConfig.dealer : scoreConfig.normal,
    payments,
    beanRate: QINGYANG_PINGHU_RULES.beanRate,
    deltas,
  };
}

export function nextDealer({ currentDealerSeat, winnerSeat, isDraw, playerCount = 4 }) {
  if (isDraw || winnerSeat === currentDealerSeat) {
    return currentDealerSeat;
  }
  return (currentDealerSeat + 1) % playerCount;
}

function canStandardHu(tiles, laiziTile, options = {}) {
  const { exposedMeldCount = 0 } = options;
  const concealedGroupCount = 4 - exposedMeldCount;
  if (concealedGroupCount < 0 || concealedGroupCount > 4) {
    return false;
  }

  const expectedTileCount = concealedGroupCount * 3 + 2;
  if (tiles.length !== expectedTileCount) {
    return false;
  }

  const laiziCount = countTile(tiles, laiziTile);
  const counts = countTiles(tiles);
  counts[TILE_INDEX.get(laiziTile)] = 0;

  return canChoosePair(counts, laiziCount);
}

function canChoosePair(counts, laiziCount) {
  if (laiziCount >= 2 && canFormGroups(counts, laiziCount - 2)) {
    return true;
  }

  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= 2) {
      const nextCounts = [...counts];
      nextCounts[index] -= 2;
      if (canFormGroups(nextCounts, laiziCount)) {
        return true;
      }
    }

    if (counts[index] >= 1 && laiziCount >= 1) {
      const nextCounts = [...counts];
      nextCounts[index] -= 1;
      if (canFormGroups(nextCounts, laiziCount - 1)) {
        return true;
      }
    }
  }

  return false;
}

function canFormGroups(counts, laiziCount, memo = new Map()) {
  const key = `${counts.join(",")}|${laiziCount}`;
  if (memo.has(key)) {
    return memo.get(key);
  }

  const firstIndex = counts.findIndex((count) => count > 0);
  if (firstIndex === -1) {
    const result = laiziCount % 3 === 0;
    memo.set(key, result);
    return result;
  }

  if (tryTriplet(counts, laiziCount, firstIndex, memo)) {
    memo.set(key, true);
    return true;
  }

  if (trySequence(counts, laiziCount, firstIndex, memo)) {
    memo.set(key, true);
    return true;
  }

  memo.set(key, false);
  return false;
}

function tryTriplet(counts, laiziCount, index, memo) {
  const naturalCount = counts[index];
  const neededLaizi = Math.max(0, 3 - naturalCount);
  if (neededLaizi > laiziCount) {
    return false;
  }

  const nextCounts = [...counts];
  nextCounts[index] = Math.max(0, naturalCount - 3);
  return canFormGroups(nextCounts, laiziCount - neededLaizi, memo);
}

function trySequence(counts, laiziCount, index, memo) {
  const tile = TILE_TYPES[index];
  if (!isNumberTile(tile)) {
    return false;
  }

  const suit = getSuit(tile);
  const rank = getRank(tile);
  if (rank > 7) {
    return false;
  }

  const sequenceIndexes = [rank, rank + 1, rank + 2].map((nextRank) =>
    TILE_INDEX.get(`${suit}-${nextRank}`),
  );
  let neededLaizi = 0;
  const nextCounts = [...counts];

  for (const sequenceIndex of sequenceIndexes) {
    if (nextCounts[sequenceIndex] > 0) {
      nextCounts[sequenceIndex] -= 1;
    } else {
      neededLaizi += 1;
    }
  }

  if (neededLaizi > laiziCount) {
    return false;
  }

  return canFormGroups(nextCounts, laiziCount - neededLaizi, memo);
}
