export const SUITS = ["wan", "tiao", "tong"];
export const WINDS = ["east", "south", "west", "north"];
export const DRAGONS = ["zhong", "fa", "bai"];

export const TILE_TYPES = [
  ...SUITS.flatMap((suit) =>
    Array.from({ length: 9 }, (_, index) => `${suit}-${index + 1}`),
  ),
  ...WINDS,
  ...DRAGONS,
];

export const TILE_INDEX = new Map(TILE_TYPES.map((tile, index) => [tile, index]));

export function assertTile(tile) {
  if (!TILE_INDEX.has(tile)) {
    throw new Error(`Unknown tile: ${tile}`);
  }
}

export function createWall() {
  return TILE_TYPES.flatMap((tile) => [tile, tile, tile, tile]);
}

export function isNumberTile(tile) {
  return SUITS.some((suit) => tile.startsWith(`${suit}-`));
}

export function getSuit(tile) {
  if (tile.includes("-")) {
    return tile.split("-")[0];
  }
  if (WINDS.includes(tile)) {
    return "wind";
  }
  if (DRAGONS.includes(tile)) {
    return "dragon";
  }
  assertTile(tile);
}

export function getRank(tile) {
  if (!tile.includes("-")) {
    return null;
  }
  return Number(tile.split("-")[1]);
}

export function nextLaiziFromIndicator(indicator) {
  assertTile(indicator);

  if (isNumberTile(indicator)) {
    const suit = getSuit(indicator);
    const rank = getRank(indicator);
    return `${suit}-${rank === 9 ? 1 : rank + 1}`;
  }

  const windIndex = WINDS.indexOf(indicator);
  if (windIndex >= 0) {
    return WINDS[(windIndex + 1) % WINDS.length];
  }

  const dragonIndex = DRAGONS.indexOf(indicator);
  if (dragonIndex >= 0) {
    return DRAGONS[(dragonIndex + 1) % DRAGONS.length];
  }

  assertTile(indicator);
}

export function tileLabel(tile) {
  assertTile(tile);
  const suitLabels = {
    wan: "万",
    tiao: "条",
    tong: "筒",
  };
  const honorLabels = {
    east: "东",
    south: "南",
    west: "西",
    north: "北",
    zhong: "中",
    fa: "发",
    bai: "白",
  };

  if (isNumberTile(tile)) {
    return `${getRank(tile)}${suitLabels[getSuit(tile)]}`;
  }

  return honorLabels[tile];
}

export function countTiles(tiles) {
  const counts = Array(TILE_TYPES.length).fill(0);
  for (const tile of tiles) {
    assertTile(tile);
    counts[TILE_INDEX.get(tile)] += 1;
  }
  return counts;
}

export function countTile(tiles, wantedTile) {
  assertTile(wantedTile);
  return tiles.reduce((total, tile) => total + (tile === wantedTile ? 1 : 0), 0);
}

