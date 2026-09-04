import test from "node:test";
import assert from "node:assert/strict";
import {
  WIN_TYPES,
  anGang,
  buGang,
  chooseBotDiscardIndex,
  discardTile,
  drawForCurrentSeat,
  drawFromBackByDice,
  drawIndicatorFromBack,
  getAnGangOptions,
  getBuGangOptions,
  getPengOptions,
  pengDiscard,
  skipReactions,
  sortTiles,
  startRound,
  takeGangReplacement,
} from "../src/index.js";

test("draws from the back by dice total", () => {
  const wall = ["wan-1", "wan-2", "wan-3", "wan-4"];

  assert.equal(drawFromBackByDice(wall, 2), "wan-3");
  assert.deepEqual(wall, ["wan-1", "wan-2", "wan-4"]);
});

test("takeGangReplacement resolves the dice stack with skips and pass-throughs", () => {
  // 墩内 [上层, 底层]，从排尾数：第 1 墩 [wan-5, wan-6]，第 2 墩 [wan-3, wan-4]，第 3 墩 [wan-1, wan-2]。
  const makeWall = () => ["wan-1", "wan-2", "wan-3", "wan-4", "wan-5", "wan-6"];
  const wallA = makeWall();
  assert.equal(takeGangReplacement(wallA, [], 2), "wan-3"); // 掷2 → 第2墩上层
  const wallB = makeWall();
  assert.equal(takeGangReplacement(wallB, [2], 2), "wan-4"); // 上层已被翻牌/杠取走 → 取该墩下层
  assert.deepEqual(wallB, ["wan-1", "wan-2", "wan-3", "wan-5", "wan-6"]);
  const wallC = makeWall();
  assert.equal(takeGangReplacement(wallC, [3, 3], 3), null); // 该墩两张都已被取走 → 空过
  assert.equal(wallC.length, 6);
  const wallD = makeWall();
  assert.equal(takeGangReplacement(wallD, [2], 4), null); // 剩余牌墙数不到第 4 墩 → 空过
  assert.equal(wallD.length, 6);
});

test("flips the upper tile of the dice-total-th stack from the back", () => {
  // 8 张 = 4 墩（墩内 [上层, 底层]）：[1,2] [3,4] [5,6] [7,8]，排尾 [7,8] 为第 1 墩。
  const wall1 = ["wan-1", "wan-2", "wan-3", "wan-4", "wan-5", "wan-6", "wan-7", "wan-8"];
  assert.equal(drawIndicatorFromBack(wall1, 1), "wan-7");
  assert.deepEqual(wall1.length, 7);

  // 第 2 墩从尾数是 [5,6]，取其上层 5。
  const wall2 = ["wan-1", "wan-2", "wan-3", "wan-4", "wan-5", "wan-6", "wan-7", "wan-8"];
  assert.equal(drawIndicatorFromBack(wall2, 2), "wan-5");
  assert.deepEqual(wall2.length, 7);
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

test("an gang passes when the dice stack is gone from the wall", () => {
  let state = startRound({ dealerSeat: 0, seed: "gang-skip-test" });
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
  // 牌墙只剩排尾 1 墩（2 张）：骰子掷出 2 时数不到第 2 墩，必须空过。
  state.wall = ["wan-8", "wan-9"];

  state = anGang(state, 0, "wan-1", sequenceRandom([0, 0]));

  // 空过：不补牌、不设 lastDraw，仍进入出牌阶段可正常出牌。
  assert.equal(state.players[0].hand.length, 10);
  assert.equal(state.wall.length, 2);
  assert.equal(state.phase, "discard");
  assert.equal(state.lastDraw, null);
  assert.equal(state.diceHistory.at(-1).reason, "gang");
  assert.equal(state.diceHistory.at(-1).total, 2);

  state = discardTile(state, 0, 0);
  assert.equal(state.players[0].hand.length, 9);
});

test("performs bu gang by upgrading the peng meld and draws replacement", () => {
  let state = startRound({ dealerSeat: 0, seed: "bu-gang-test" });
  // 模拟碰过 tong-9 后、自己回合又摸到第 4 张的牌型（11 张手牌 + 1 组碰）。
  state.players[0].hand = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "tong-9",
    "east",
  ];
  state.players[0].melds = [
    { type: "peng", tile: "tong-9", tiles: ["tong-9", "tong-9", "tong-9"], fromSeat: 1 },
  ];

  // 暗杠与补杠互斥：手里只有 1 张 tong-9，只能补杠。
  assert.deepEqual(getBuGangOptions(state, 0), ["tong-9"]);
  assert.ok(!getAnGangOptions(state, 0).includes("tong-9"));

  const wallBefore = state.wall.length;
  const random = sequenceRandom([0]);
  state = buGang(state, 0, "tong-9", random);

  assert.equal(state.players[0].melds.length, 1);
  assert.equal(state.players[0].melds[0].type, "buGang");
  assert.deepEqual(state.players[0].melds[0].tiles, [
    "tong-9",
    "tong-9",
    "tong-9",
    "tong-9",
  ]);
  assert.equal(state.players[0].hand.length, 11);
  assert.equal(state.wall.length, wallBefore - 1);
  assert.equal(state.lastDraw.fromGang, true);
  assert.equal(state.diceHistory.at(-1).reason, "buGang");
  assert.equal(state.log.at(-1).type, "buGang");
  assert.equal(state.phase, "discard");
});

test("allows bu gang immediately after peng", () => {
  let state = startRound({ dealerSeat: 0, seed: "peng-bugang-test" });
  // 玩家 1 手里有一个暗刻 tiao-5（13 张），玩家 0 打出第 4 张。
  state.players[1].hand = [
    "tiao-5",
    "tiao-5",
    "tiao-5",
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
  ];
  state.players[0].hand[0] = "tiao-5";

  state = discardTile(state, 0, 0);
  state = pengDiscard(state, 1);

  // 碰完立刻进入自己的出牌阶段，此时即可用手中最后一张补杠。
  assert.equal(state.currentSeat, 1);
  assert.equal(state.phase, "discard");
  assert.deepEqual(getBuGangOptions(state, 1), ["tiao-5"]);

  const wallBefore = state.wall.length;
  state = buGang(state, 1, "tiao-5", sequenceRandom([0, 0]));

  assert.equal(state.players[1].melds.length, 1);
  assert.equal(state.players[1].melds[0].type, "buGang");
  assert.deepEqual(state.players[1].melds[0].tiles, [
    "tiao-5",
    "tiao-5",
    "tiao-5",
    "tiao-5",
  ]);
  assert.equal(state.players[1].hand.length, 11);
  assert.equal(state.wall.length, wallBefore - 1);
  assert.equal(state.lastDraw.fromGang, true);
  assert.equal(state.phase, "discard");
});

test("draws until the dead-wall boundary then ends in a draw game", () => {
  let state = startRound({ dealerSeat: 0, seed: "dead-wall-test" });

  // 初始死墙 = 2×翻牌骰 + 1 张（翻牌墩及其排尾方向 + 前一墩，扣翻牌 1 张）。
  assert.equal(state.deadWallTiles, state.laiziDice.total * 2 + 1);

  // 墙上只剩死墙 + 1 张时仍可正常摸牌，摸完恰好触及边界。
  state.wall = state.wall.slice(0, state.deadWallTiles + 1);
  state.phase = "draw";
  state = drawForCurrentSeat(state);
  assert.equal(state.status, "playing");
  assert.equal(state.wall.length, state.deadWallTiles);

  // 已到有效摸牌区边界，再摸即荒庄流局。
  state.phase = "draw";
  state = drawForCurrentSeat(state);
  assert.equal(state.status, "ended");
  assert.equal(state.phase, "ended");
  assert.equal(state.log.at(-1).type, "drawGame");
});

test("advances the dead-wall boundary on each gang", () => {
  let state = startRound({ dealerSeat: 0, seed: "dead-wall-gang-test" });
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

  const before = state.deadWallTiles;
  // 杠骰 2 不超过翻牌骰：边界 = (max(翻牌骰,2)+1+1) 墩 → 恰好比不杠多推进 1 张。
  state = anGang(state, 0, "wan-1", sequenceRandom([0, 0]));

  assert.equal(state.deadWallTiles, before + 1);
});

test("big gang dice raises the dead-wall base and later gangs extend from it", () => {
  let state = startRound({ dealerSeat: 0, seed: "dead-wall-big-dice-test" });
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

  // 第一次杠骰 12：边界 = (12+1+1) 墩×2 − 翻牌 1 张 − 杠补 1 张 = 26 张。
  state = anGang(state, 0, "wan-1", sequenceRandom([0.999, 0.999]));
  assert.equal(state.deadWallTiles, 26);

  // 第二次杠骰 2：基数仍取历史最大杠骰 12 → (12+1+2) 墩×2 − 1 − 2 = 27 张（小骰只多推 1 墩）。
  state.players[0].hand = [
    "tiao-1",
    "tiao-1",
    "tiao-1",
    "tiao-1",
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
  state = anGang(state, 0, "tiao-1", sequenceRandom([0, 0]));
  assert.equal(state.deadWallTiles, 27);
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
  // 杠骰 2 → 排尾第 2 墩上层；此前只有翻牌（骰 10，不占用第 2 墩），无错位，
  // 该墩上层在从尾数第 4 张，把它换成 east 让杠后正好补到。
  state.wall.splice(state.wall.length - 4, 1, "east");

  const random = sequenceRandom([0, 0]);
  state = anGang(state, 0, "wan-1", random);

  // 杠上开胡（非跑风）：winType 为基础型（该手无赖子 → 恩豆），
  // isGangDraw 标记杠胡并附加弯杠。
  assert.equal(state.availableWin.winType, WIN_TYPES.EN_DOU);
  assert.equal(state.availableWin.detail.isGangDraw, true);
  assert.ok(state.availableWin.detail.bonuses.some((bonus) => bonus.key === "wanGang"));
});

test("startRound stores normalized rule config with defaults for unspecified rules", () => {
  const state = startRound({
    dealerSeat: 0,
    seed: "rule-config-test",
    ruleConfig: { multiplier: 10, rules: { streakPenalty: false, duiDuiHu: false } },
  });

  assert.equal(state.ruleConfig.multiplier, 10);
  assert.equal(state.ruleConfig.rules.streakPenalty, false);
  assert.equal(state.ruleConfig.rules.duiDuiHu, false);
  // 未指定的开关回退默认值（默认全开）。
  assert.equal(state.ruleConfig.rules.enDou, true);
  assert.equal(state.ruleConfig.rules.qiXiaoDui, true);
  assert.equal(state.penaltyStreak, null);
});

test("streak penalty charges the first discarder when all four players discard the same tile", () => {
  let state = startRound({ dealerSeat: 0, seed: "streak-penalty-test" });
  const streakTile = ["east", "south", "west", "north"].find((tile) => tile !== state.laiziTile);

  // 给四家各塞一张同款字牌，确保每家都能按序打出。
  for (const player of state.players) {
    player.hand = sortTiles([...player.hand, streakTile], state.laiziTile);
  }
  const beansBefore = state.players.map((player) => player.beans);

  // 庄家先打，随后三家轮流摸牌后各打同一张，第四张触发连打惩罚。
  for (let turn = 0; turn < 4; turn += 1) {
    const seat = turn % 4;
    const handIndex = state.players[seat].hand.indexOf(streakTile);
    state = discardTile(state, seat, handIndex);
    if (turn < 3) {
      state = skipReactions(state);
      state = drawForCurrentSeat(state);
    }
  }

  const penalty = state.log.find((entry) => entry.type === "streakPenalty");
  assert.ok(penalty, "应产生连打惩罚日志");
  assert.equal(penalty.tile, streakTile);
  assert.equal(penalty.payerSeat, 0);
  assert.equal(penalty.amount, 5);
  assert.equal(state.penaltyStreak, null);

  // 首打者（庄家）给其余三家各 1 子（默认 5 倍 = 5 豆）。
  assert.equal(state.players[0].beans, beansBefore[0] - 15);
  for (const seat of [1, 2, 3]) {
    assert.equal(state.players[seat].beans, beansBefore[seat] + 5);
  }
});

test("streak penalty resets when a different tile is discarded", () => {
  let state = startRound({ dealerSeat: 0, seed: "streak-reset-test" });
  const tiles = ["east", "south", "west", "north"].filter((tile) => tile !== state.laiziTile);

  for (const player of state.players) {
    player.hand = sortTiles([...player.hand, tiles[0], tiles[1]], state.laiziTile);
  }

  // 三家打同一张后被一张异牌打断：不触发惩罚并重置计数。
  state = discardTile(state, 0, state.players[0].hand.indexOf(tiles[0]));
  state = skipReactions(state);
  state = drawForCurrentSeat(state);
  state = discardTile(state, 1, state.players[1].hand.indexOf(tiles[0]));
  state = skipReactions(state);
  state = drawForCurrentSeat(state);
  state = discardTile(state, 2, state.players[2].hand.indexOf(tiles[0]));
  state = skipReactions(state);
  state = drawForCurrentSeat(state);
  state = discardTile(state, 3, state.players[3].hand.indexOf(tiles[1]));

  assert.equal(state.log.filter((entry) => entry.type === "streakPenalty").length, 0);
  assert.deepEqual(state.penaltyStreak, { tile: tiles[1], seats: [3] });
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
