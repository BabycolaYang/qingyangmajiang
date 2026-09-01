import test from "node:test";
import assert from "node:assert/strict";
import {
  TILE_TYPES,
  WIN_TYPES,
  canHu,
  canPingHu,
  canRunFeng,
  createWall,
  hasLackOneSuit,
  nextDealer,
  nextLaiziFromIndicator,
  resolveWinType,
  scoreWin,
} from "../src/index.js";

test("creates a 136-tile wall without flowers", () => {
  const wall = createWall();
  assert.equal(wall.length, 136);
  assert.equal(TILE_TYPES.length, 34);
  assert.equal(wall.filter((tile) => tile === "wan-1").length, 4);
});

test("resolves laizi by suit, wind cycle, and dragon cycle", () => {
  assert.equal(nextLaiziFromIndicator("wan-9"), "wan-1");
  assert.equal(nextLaiziFromIndicator("tiao-3"), "tiao-4");
  assert.equal(nextLaiziFromIndicator("tong-8"), "tong-9");
  assert.equal(nextLaiziFromIndicator("north"), "east");
  assert.equal(nextLaiziFromIndicator("bai"), "zhong");
});

test("detects standard ping hu with one laizi", () => {
  const tiles = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
    "east",
    "east",
    "fa",
    "zhong",
  ];

  assert.equal(canPingHu(tiles, "zhong"), true);
});

test("blocks ping hu when the winning hand has two laizi", () => {
  const tiles = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
    "east",
    "east",
    "zhong",
    "zhong",
  ];

  assert.equal(canPingHu(tiles, "zhong"), false);
  assert.equal(canHu(tiles, "zhong", { runFeng: true }), true);
});

test("checks lack-one-suit only for wan, tiao, and tong", () => {
  assert.equal(hasLackOneSuit(["wan-1", "wan-2", "east", "zhong"]), true);
  assert.equal(hasLackOneSuit(["wan-1", "tiao-2", "tong-3", "east"]), false);
});

test("detects a run-feng thirteen-wait shape with four laizi", () => {
  const waitingTiles = [
    "east",
    "east",
    "east",
    "south",
    "south",
    "south",
    "west",
    "west",
    "west",
    "zhong",
    "zhong",
    "zhong",
    "zhong",
  ];

  assert.equal(canRunFeng(waitingTiles, "zhong"), true);
});

test("run feng respects lack-one-suit option", () => {
  const waitingTiles = [
    "wan-1",
    "wan-1",
    "wan-1",
    "tiao-1",
    "tiao-1",
    "tiao-1",
    "east",
    "east",
    "east",
    "zhong",
    "zhong",
    "zhong",
    "zhong",
  ];

  assert.equal(canRunFeng(waitingTiles, "zhong"), true);
  assert.equal(canRunFeng(waitingTiles, "zhong", { mustLackOneSuit: true }), false);
});

test("scores self-draw by collecting from each other player", () => {
  assert.deepEqual(
    scoreWin({
      winType: WIN_TYPES.PING_HU,
      winnerSeat: 1,
      dealerSeat: 0,
    }).deltas,
    [-10, 20, -5, -5],
  );

  assert.deepEqual(
    scoreWin({
      winType: WIN_TYPES.PING_HU,
      winnerSeat: 1,
      dealerSeat: 0,
    }).payments,
    [10, 0, 5, 5],
  );

  assert.deepEqual(
    scoreWin({
      winType: WIN_TYPES.RUN_FENG,
      winnerSeat: 0,
      dealerSeat: 0,
    }).deltas,
    [60, -20, -20, -20],
  );
});

test("dealer pays dealer points when a non-dealer wins", () => {
  assert.deepEqual(
    scoreWin({
      winType: WIN_TYPES.RUN_FENG,
      winnerSeat: 2,
      dealerSeat: 0,
    }).deltas,
    [-20, -10, 40, -10],
  );
});

test("scores gang ping hu and zhi gang", () => {
  assert.equal(
    scoreWin({
      winType: WIN_TYPES.GANG_PING_HU,
      winnerSeat: 2,
      dealerSeat: 0,
    }).pointsPerLoser,
    25,
  );
  assert.equal(
    scoreWin({
      winType: WIN_TYPES.GANG_PING_HU,
      winnerSeat: 0,
      dealerSeat: 0,
    }).pointsPerLoser,
    30,
  );
  assert.equal(
    scoreWin({
      winType: WIN_TYPES.ZHI_GANG,
      winnerSeat: 3,
      dealerSeat: 0,
    }).pointsPerLoser,
    60,
  );
  assert.equal(
    scoreWin({
      winType: WIN_TYPES.ZHI_GANG,
      winnerSeat: 0,
      dealerSeat: 0,
    }).pointsPerLoser,
    70,
  );
});

test("resolves win type from draw context", () => {
  const tiles = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
    "east",
    "east",
    "fa",
    "zhong",
  ];

  assert.equal(resolveWinType({ tiles, laiziTile: "zhong" }), WIN_TYPES.PING_HU);
  assert.equal(
    resolveWinType({ tiles, laiziTile: "zhong", isGangDraw: true }),
    WIN_TYPES.GANG_PING_HU,
  );
  assert.equal(
    resolveWinType({
      tiles,
      laiziTile: "zhong",
      isGangDraw: true,
      wasRunFengBeforeGang: true,
    }),
    WIN_TYPES.ZHI_GANG,
  );
});

test("does not resolve two-laizi standard hand as run feng without run-feng state", () => {
  const tiles = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
    "east",
    "east",
    "zhong",
    "zhong",
  ];

  assert.equal(resolveWinType({ tiles, laiziTile: "zhong" }), null);
  assert.equal(
    resolveWinType({ tiles, laiziTile: "zhong", wasRunFengBeforeDraw: true }),
    WIN_TYPES.RUN_FENG,
  );
});

test("moves dealer to current dealer's next seat after non-dealer win", () => {
  assert.equal(nextDealer({ currentDealerSeat: 0, winnerSeat: 0, isDraw: false }), 0);
  assert.equal(nextDealer({ currentDealerSeat: 0, winnerSeat: 2, isDraw: false }), 1);
  assert.equal(nextDealer({ currentDealerSeat: 3, winnerSeat: 1, isDraw: false }), 0);
  assert.equal(nextDealer({ currentDealerSeat: 2, winnerSeat: 1, isDraw: true }), 2);
});
