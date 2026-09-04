import test from "node:test";
import assert from "node:assert/strict";
import {
  TILE_TYPES,
  WIN_TYPES,
  canHu,
  canPingHu,
  canQiXiaoDui,
  canRunFeng,
  countWindArrowBonus,
  createWall,
  hasLackOneSuit,
  isDuiDuiHu,
  nextDealer,
  nextLaiziFromIndicator,
  normalizeRuleConfig,
  resolveWinDetail,
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

test("run feng ignores lack-breaking draws when must lack one suit", () => {
  // 缺两门（万+条）的全听手：打缺时摸到筒牌无法开牌，该牌不参与跑风判定。
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
  assert.equal(canRunFeng(waitingTiles, "zhong", { mustLackOneSuit: true }), true);

  // 手牌横跨三门数字牌：打缺时摸什么牌都无法开牌，不算跑风。
  const threeSuitTiles = [
    "wan-1",
    "wan-1",
    "wan-1",
    "tiao-1",
    "tiao-1",
    "tiao-1",
    "tong-1",
    "tong-1",
    "tong-1",
    "zhong",
    "zhong",
    "zhong",
    "zhong",
  ];
  assert.equal(canRunFeng(threeSuitTiles, "zhong", { mustLackOneSuit: true }), false);
  assert.equal(canRunFeng(threeSuitTiles, "zhong"), true);

  // 已缺门但并非全听（摸到筒牌以外的牌不能都开牌）。
  const notAllWaitTiles = [
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-4",
    "wan-5",
    "wan-6",
    "wan-7",
    "wan-8",
    "wan-9",
    "tiao-1",
    "tiao-2",
    "tiao-3",
    "tiao-4",
  ];
  assert.equal(canRunFeng(notAllWaitTiles, "zhong", { mustLackOneSuit: true }), false);
});

// 1 个赖子的标准平胡手牌（laiziTile = "zhong"）：四顺 + 将，无风箭对子。
const oneLaiziHand = [
  "wan-1",
  "wan-2",
  "wan-3",
  "tiao-2",
  "tiao-3",
  "tiao-4",
  "tong-5",
  "tong-6",
  "tong-7",
  "wan-7",
  "wan-8",
  "wan-9",
  "fa",
  "zhong",
];

test("scores self-draw by collecting from each other player", () => {
  // 非跑风 1 赖子 = 小开 1 子；涉及庄家的一侧多付头家加成 1 子；默认 5 倍场。
  const xiaoKai = resolveWinDetail({ tiles: oneLaiziHand, laiziTile: "zhong" });
  assert.equal(xiaoKai.baseType, WIN_TYPES.XIAO_KAI);
  assert.equal(xiaoKai.totalZi, 1);
  assert.equal(xiaoKai.headBonusZi, 1);

  assert.deepEqual(
    scoreWin({ winDetail: xiaoKai, winnerSeat: 1, dealerSeat: 0 }).deltas,
    [-10, 20, -5, -5],
  );
  assert.deepEqual(
    scoreWin({ winDetail: xiaoKai, winnerSeat: 1, dealerSeat: 0 }).payments,
    [10, 0, 5, 5],
  );

  // 跑风 1 赖子 = 2 子；庄家自胡每家付 2 + 2（跑风头家翻倍）= 4 子 = 20 豆。
  const paoFeng = resolveWinDetail({
    tiles: oneLaiziHand,
    laiziTile: "zhong",
    wasRunFengBeforeDraw: true,
  });
  assert.equal(paoFeng.baseType, WIN_TYPES.PAO_FENG_1);
  assert.deepEqual(
    scoreWin({ winDetail: paoFeng, winnerSeat: 0, dealerSeat: 0 }).deltas,
    [60, -20, -20, -20],
  );
});

test("dealer pays dealer points when a non-dealer wins", () => {
  const paoFeng = resolveWinDetail({
    tiles: oneLaiziHand,
    laiziTile: "zhong",
    wasRunFengBeforeDraw: true,
  });
  assert.deepEqual(
    scoreWin({ winDetail: paoFeng, winnerSeat: 2, dealerSeat: 0 }).deltas,
    [-20, -10, 40, -10],
  );
});

test("scores gang ping hu and zhi gang", () => {
  // 弯杠：小开 1 子 + 弯杠 4 子 = 5 子；涉及庄家的一侧再 +1 子（头家 1 子）。
  const wanGang = resolveWinDetail({
    tiles: oneLaiziHand,
    laiziTile: "zhong",
    isGangDraw: true,
    wasRunFengBeforeGang: false,
  });
  assert.equal(wanGang.totalZi, 5);
  assert.deepEqual(
    scoreWin({ winDetail: wanGang, winnerSeat: 2, dealerSeat: 0 }).payments,
    [30, 25, 0, 25],
  );
  assert.deepEqual(
    scoreWin({ winDetail: wanGang, winnerSeat: 0, dealerSeat: 0 }).payments,
    [0, 30, 30, 30],
  );

  // 直杠：跑风 2 子 + 直杠 10 子 = 12 子；涉及庄家的一侧再 +2 子（跑风头家 2 子）。
  const zhiGang = resolveWinDetail({
    tiles: oneLaiziHand,
    laiziTile: "zhong",
    isGangDraw: true,
    wasRunFengBeforeGang: true,
  });
  assert.equal(zhiGang.totalZi, 12);
  assert.deepEqual(
    scoreWin({ winDetail: zhiGang, winnerSeat: 3, dealerSeat: 0 }).payments,
    [70, 60, 60, 0],
  );
  assert.deepEqual(
    scoreWin({ winDetail: zhiGang, winnerSeat: 0, dealerSeat: 0 }).payments,
    [0, 70, 70, 70],
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

// ==================== 新计分体系 ====================

// 6 对 + 单张 + 赖子（zhong）的七小对（无风箭对子，独享 10 子）。
const qiXiaoDuiHand = [
  "wan-1",
  "wan-1",
  "wan-3",
  "wan-3",
  "tiao-5",
  "tiao-5",
  "tiao-7",
  "tiao-7",
  "tong-2",
  "tong-2",
  "tong-8",
  "tong-8",
  "tong-9",
  "zhong",
];

// 四刻 + 将的对对胡（east 对子另计风箭附加）。
const duiDuiHand = [
  "wan-1",
  "wan-1",
  "wan-1",
  "tong-5",
  "tong-5",
  "tong-5",
  "tong-8",
  "tong-8",
  "tong-8",
  "tiao-3",
  "tiao-3",
  "tiao-3",
  "east",
  "east",
];

test("canQiXiaoDui pairs the laizi with a single and counts four of a kind as two pairs", () => {
  assert.equal(canQiXiaoDui(qiXiaoDuiHand, "zhong"), true);
  assert.equal(
    canQiXiaoDui([
      "wan-1",
      "wan-1",
      "wan-1",
      "wan-1",
      "wan-3",
      "wan-3",
      "wan-5",
      "wan-5",
      "tiao-7",
      "tiao-7",
      "tong-2",
      "tong-2",
      "tong-9",
      "tong-9",
    ], "zhong"),
    true,
  );
  // 最多 1 个赖子
  assert.equal(canQiXiaoDui(["zhong", "zhong", ...qiXiaoDuiHand.slice(0, 12)], "zhong"), false);
});

test("resolves qi xiao dui as a standalone base type with its own head bonus", () => {
  const detail = resolveWinDetail({ tiles: qiXiaoDuiHand, laiziTile: "zhong" });
  assert.equal(detail.baseType, WIN_TYPES.QI_XIAO_DUI);
  assert.equal(detail.isQiXiaoDui, true);
  assert.equal(detail.totalZi, 10);
  assert.equal(detail.headBonusZi, 2);
  // 非庄家胡：庄家付 10+2=12 子，其余付 10 子（默认 5 倍）。
  assert.deepEqual(
    scoreWin({ winDetail: detail, winnerSeat: 2, dealerSeat: 0 }).payments,
    [60, 50, 0, 50],
  );
});

test("resolves dui dui hu and wind arrow bonuses", () => {
  // 恩豆 2 + 对对胡 4 + 风箭（east 对子）1 = 7 子。
  const detail = resolveWinDetail({ tiles: duiDuiHand, laiziTile: "zhong" });
  assert.equal(detail.baseType, WIN_TYPES.EN_DOU);
  assert.equal(detail.totalZi, 7);
  assert.deepEqual(
    detail.bonuses.map((bonus) => bonus.key),
    ["duiDuiHu", "windArrow"],
  );
  assert.equal(isDuiDuiHu(duiDuiHand, "zhong"), true);
  assert.equal(isDuiDuiHu(oneLaiziHand, "zhong"), false);

  // 头家胡牌：每家付 7 + 1 = 8 子 = 40 豆。
  assert.deepEqual(
    scoreWin({ winDetail: detail, winnerSeat: 0, dealerSeat: 0 }).payments,
    [0, 40, 40, 40],
  );
});

test("resolves quan qiu du diao with priority over dui dui hu", () => {
  // 全球独钓：只剩 2 张开牌（4 副露），独钓优先于对对胡，不叠加。
  const detail = resolveWinDetail({
    tiles: ["east", "east"],
    laiziTile: "zhong",
    exposedMeldCount: 4,
  });
  assert.equal(detail.baseType, WIN_TYPES.EN_DOU);
  assert.deepEqual(
    detail.bonuses.map((bonus) => bonus.key),
    ["quanQiuDuDiao", "windArrow"],
  );
  assert.equal(detail.totalZi, 2 + 6 + 1);
});

test("counts wind arrow bonuses from hand pairs and melds", () => {
  assert.equal(countWindArrowBonus(["east", "east", "fa"], [], "zhong"), 1);
  assert.equal(
    countWindArrowBonus(["east", "east", "fa"], [{ type: "peng", tile: "fa", tiles: ["fa", "fa", "fa"] }], "zhong"),
    2,
  );
  // 赖子搭配的碰组不算
  assert.equal(
    countWindArrowBonus(["east", "east"], [{ type: "peng", tile: "fa", tiles: ["fa", "fa", "zhong"] }], "zhong"),
    1,
  );
  // 赖子本身不计
  assert.equal(countWindArrowBonus(["east", "zhong", "fa"], [], "zhong"), 0);
});

test("scoreWin applies the custom multiplier", () => {
  const xiaoKai = resolveWinDetail({ tiles: oneLaiziHand, laiziTile: "zhong" });
  assert.deepEqual(
    scoreWin({ winDetail: xiaoKai, winnerSeat: 1, dealerSeat: 0, multiplier: 10 }).deltas,
    [-20, 40, -10, -10],
  );
});

test("rule switches disable base types entirely and strip bonuses only", () => {
  // 小开关闭：非跑风 1 赖子不可胡。
  assert.equal(
    resolveWinDetail({ tiles: oneLaiziHand, laiziTile: "zhong", ruleConfig: { rules: { xiaoKai: false } } }),
    null,
  );
  // 跑风两个开关都关闭：跑风赖子手不可胡。
  assert.equal(
    resolveWinDetail({
      tiles: oneLaiziHand,
      laiziTile: "zhong",
      wasRunFengBeforeDraw: true,
      ruleConfig: { rules: { paoFeng1: false, paoFeng2: false } } ,
    }),
    null,
  );
  // 七小对关闭：纯七小对手不可胡。
  assert.equal(
    resolveWinDetail({ tiles: qiXiaoDuiHand, laiziTile: "zhong", ruleConfig: { rules: { qiXiaoDui: false } } }),
    null,
  );

  // 附加开关关闭：仍可胡，只是不计该项加成。
  const duiDuiOff = resolveWinDetail({
    tiles: duiDuiHand,
    laiziTile: "zhong",
    ruleConfig: { rules: { duiDuiHu: false } },
  });
  assert.equal(duiDuiOff.baseType, WIN_TYPES.EN_DOU);
  assert.equal(duiDuiOff.totalZi, 3);

  // 头家加成关闭：庄家一侧不再多付。
  const noHead = resolveWinDetail({
    tiles: oneLaiziHand,
    laiziTile: "zhong",
    ruleConfig: { rules: { headBonus: false } },
  });
  assert.equal(noHead.headBonusZi, 0);
  assert.deepEqual(
    scoreWin({ winDetail: noHead, winnerSeat: 1, dealerSeat: 0 }).deltas,
    [-5, 15, -5, -5],
  );
});

test("normalizeRuleConfig fills defaults and guards the multiplier", () => {
  const defaults = normalizeRuleConfig(null);
  assert.equal(defaults.multiplier, 5);
  assert.equal(defaults.rules.enDou, true);
  assert.equal(defaults.rules.streakPenalty, true);

  assert.equal(normalizeRuleConfig({ multiplier: 0 }).multiplier, 5);
  assert.equal(normalizeRuleConfig({ multiplier: "x" }).multiplier, 5);
  assert.equal(normalizeRuleConfig({ multiplier: 10 }).multiplier, 10);
  assert.equal(normalizeRuleConfig({ multiplier: 10.7 }).multiplier, 10);

  const partial = normalizeRuleConfig({ multiplier: 10, rules: { qiXiaoDui: false } });
  assert.equal(partial.rules.qiXiaoDui, false);
  assert.equal(partial.rules.enDou, true);
  // 未知字段被忽略
  const unknown = normalizeRuleConfig({ multiplier: 10, rules: { noSuchRule: false } });
  assert.equal(unknown.rules.noSuchRule, undefined);
});
