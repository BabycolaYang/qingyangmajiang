import test from "node:test";
import assert from "node:assert/strict";
import {
  WIN_TYPES,
  anGang,
  chooseBotDiscardIndex,
  discardTile,
  drawForCurrentSeat,
  drawFromBackByDice,
  getAnGangOptions,
  getPengOptions,
  pengDiscard,
  skipReactions,
  sortTiles,
  startRound,
} from "../src/index.js";

test("draws from the back by dice total", () => {
  const wall = ["wan-1", "wan-2", "wan-3", "wan-4"];

  assert.equal(drawFromBackByDice(wall, 2), "wan-3");
  assert.deepEqual(wall, ["wan-1", "wan-2", "wan-4"]);
});

test("starts a round with dealer extra tile and revealed laizi", () => {
  const state = startRound({ dealerSeat: 2, seed: "round-test" });

  assert.equal(state.players[2].hand.length, 14);
  assert.equal(state.players[0].hand.length, 13);
  assert.equal(state.players[1].hand.length, 13);
  assert.equal(state.players[3].hand.length, 13);
  assert.equal(state.wall.length, 82);
  assert.ok(state.indicatorTile);
  assert.ok(state.laiziTile);
  assert.equal(state.currentSeat, 2);
  assert.equal(state.phase, "discard");
});

test("advances from discard reaction to next player's draw", () => {
  let state = startRound({ dealerSeat: 0, seed: "draw-test" });
  state = discardTile(state, 0, 0);
  state = skipReactions(state);
  state = drawForCurrentSeat(state);

  assert.equal(state.currentSeat, 1);
  assert.equal(state.players[1].hand.length, 14);
  assert.equal(state.phase, "discard");
  assert.equal(state.lastDraw.seat, 1);
  assert.ok(state.lastDraw.tile);

  state = discardTile(state, 1, 0);
  assert.equal(state.lastDraw, null);
});

test("allows a player to peng the last discard", () => {
  let state = startRound({ dealerSeat: 0, seed: "peng-test" });
  const tile = state.players[0].hand[0];
  state.players[1].hand[0] = tile;
  state.players[1].hand[1] = tile;

  state = discardTile(state, 0, 0);

  assert.deepEqual(getPengOptions(state, 1), [tile]);

  state = pengDiscard(state, 1);

  assert.equal(state.currentSeat, 1);
  assert.equal(state.phase, "discard");
  assert.equal(state.players[1].melds.length, 1);
  assert.equal(state.players[1].melds[0].type, "peng");
  assert.equal(state.players[1].hand.length, 11);
});

test("performs an gang and draws replacement from the back", () => {
  let state = startRound({ dealerSeat: 0, seed: "gang-test" });
  state.players[0].hand = [
    "wan-1",
    "wan-1",
    "wan-1",
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-4",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
  ];

  assert.deepEqual(getAnGangOptions(state, 0), ["wan-1"]);

  const wallBefore = state.wall.length;
  const random = sequenceRandom([0, 0]);
  state = anGang(state, 0, "wan-1", random);

  assert.equal(state.players[0].melds.length, 1);
  assert.equal(state.players[0].melds[0].type, "anGang");
  assert.equal(state.players[0].hand.length, 11);
  assert.equal(state.wall.length, wallBefore - 1);
  assert.equal(state.diceHistory.at(-1).total, 2);
});

test("finishes gang draw as gang ping hu when it is not zhi gang", () => {
  let state = startRound({ dealerSeat: 0, seed: "gang-win-test" });
  state.players[0].hand = [
    "wan-1",
    "wan-1",
    "wan-1",
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-4",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
  ];
  state.wall.splice(state.wall.length - 2, 1, "east");

  const random = sequenceRandom([0, 0]);
  state = anGang(state, 0, "wan-1", random);

  assert.equal(state.availableWin.winType, WIN_TYPES.GANG_PING_HU);
});

test("bot discards an isolated honor instead of the leftmost connected tile", () => {
  const hand = sortTiles([
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-4",
    "tiao-5",
    "tiao-6",
    "tong-3",
    "tong-4",
    "tong-5",
    "east",
    "east",
    "south",
    "zhong",
    "bai",
  ]);
  const discardIndex = chooseBotDiscardIndex({ hand, melds: [] }, "north");
  const discardedTile = hand[discardIndex];

  assert.notEqual(discardIndex, 0);
  assert.ok(["south", "zhong", "bai"].includes(discardedTile));
});

test("bot keeps laizi when other discards are available", () => {
  const hand = sortTiles([
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-4",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "east",
    "east",
    "south",
    "zhong",
  ]);
  const discardIndex = chooseBotDiscardIndex({ hand, melds: [] }, "wan-1");

  assert.notEqual(hand[discardIndex], "wan-1");
});

function sequenceRandom(values) {
  let index = 0;
  return () => values[index++] ?? 0;
}
