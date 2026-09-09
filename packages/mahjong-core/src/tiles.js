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

const SUIT_ALIASES = new Map([
  ["wan", "wan"],
  ["万", "wan"],
  ["tiao", "tiao"],
  ["条", "tiao"],
  ["tong", "tong"],
  ["筒", "tong"],
  ["饼", "tong"],
]);

const HONOR_ALIASES = new Map([
  ["east", "east"],
  ["dong", "east"],
  ["东", "east"],
  ["south", "south"],
  ["nan", "south"],
  ["南", "south"],
  ["west", "west"],
  ["xi", "west"],
  ["西", "west"],
  ["north", "north"],
  ["bei", "north"],
  ["北", "north"],
  ["zhong", "zhong"],
  ["中", "zhong"],
  ["fa", "fa"],
  ["发", "fa"],
  ["bai", "bai"],
  ["白", "bai"],
]);

const SUIT_PATTERN = "wan|万|tiao|条|tong|筒|饼";
const SUIT_TOKEN_RE = new RegExp(`^(${SUIT_PATTERN})([1-9]+)$`, "i");
const RANK_SUIT_TOKEN_RE = new RegExp(`^([1-9]+)(${SUIT_PATTERN})$`, "i");
const HONOR_RUN_RE = /^[东南西北中发白]+$/;

function expandSuitTiles(suit, digits, repeat) {
  return digits.split("").flatMap((rank) =>
    Array.from({ length: repeat }, () => `${suit}-${rank}`)
  );
}

function normalizeRepeatSuffix(rawToken) {
  const repeatMatch = rawToken.match(/^(.+?)[x*×](\d+)$/i);
  if (!repeatMatch) {
    return { body: rawToken, repeat: 1 };
  }
  const repeat = Number(repeatMatch[2]);
  if (repeat < 1 || repeat > 4) {
    throw new Error(`无效的重复张数：${rawToken}（只支持 x1 到 x4）`);
  }
  return { body: repeatMatch[1], repeat };
}

function parseTileToken(rawToken) {
  const { body, repeat } = normalizeRepeatSuffix(rawToken);

  const exact = TILE_INDEX.has(body) ? body : TILE_INDEX.has(body.toLowerCase()) ? body.toLowerCase() : null;
  if (exact) {
    return Array.from({ length: repeat }, () => exact);
  }

  const honor = HONOR_ALIASES.get(body) ?? HONOR_ALIASES.get(body.toLowerCase());
  if (honor) {
    return Array.from({ length: repeat }, () => honor);
  }

  const suitFirst = body.match(SUIT_TOKEN_RE);
  if (suitFirst) {
    const suit = SUIT_ALIASES.get(suitFirst[1].toLowerCase()) ?? SUIT_ALIASES.get(suitFirst[1]);
    return expandSuitTiles(suit, suitFirst[2], repeat);
  }

  const rankFirst = body.match(RANK_SUIT_TOKEN_RE);
  if (rankFirst) {
    const suit = SUIT_ALIASES.get(rankFirst[2].toLowerCase()) ?? SUIT_ALIASES.get(rankFirst[2]);
    return expandSuitTiles(suit, rankFirst[1], repeat);
  }

  const honorRun = body.match(HONOR_RUN_RE);
  if (honorRun) {
    return [...body].flatMap((char) =>
      Array.from({ length: repeat }, () => HONOR_ALIASES.get(char))
    );
  }

  throw new Error(`无法识别的牌：${rawToken}`);
}

export function parseTilesText(text) {
  if (typeof text !== "string") {
    throw new Error("牌型文本必须是字符串");
  }
  const tokens = text.split(/[\s,，、;；]+/).filter(Boolean);
  return tokens.flatMap((token) => parseTileToken(token));
}

