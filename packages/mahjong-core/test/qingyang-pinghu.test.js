import test from "node:test";
import assert from "node:assert/strict";
import {
  TILE_TYPES,
  WIN_TYPES,
  canHu,
  canPingHu,
  canQiXiaoDui,
  canRunFeng,
  countIdleLaizi,
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

// 构造手牌：真实牌（如 "wan-1,wan-2"）+ N 个赖子
function handWithLaizi(realTiles, laiziCount, laiziTile = "zhong") {
  return [
    ...realTiles.split(",").map((tile) => tile.trim()),
    ...Array.from({ length: laiziCount }, () => laiziTile),
  ];
}

test("counts idle laizi: run partners absorb one laizi each, pairs and singles do not", () => {
  const laizi = "zhong";
  // 用户口径验证例：12357+2 赖 → 57 搭子用掉 1 个赖子 → 1 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-1,wan-2,wan-3,wan-5,wan-7", 2), laizi), 1);
  // 12345+2 赖 → 45 搭子用掉 1 个 → 1 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-1,wan-2,wan-3,wan-4,wan-5", 2), laizi), 1);
  // 12355+2 赖 → 对子不用赖子 → 2 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-1,wan-2,wan-3,wan-5,wan-5", 2), laizi), 2);
  // 1235+3 赖 → 无搭子 → 3 闲（结算分层封顶为 2 跑）
  assert.equal(countIdleLaizi(handWithLaizi("wan-1,wan-2,wan-3,wan-5", 3), laizi), 3);
  // 78+2 赖 → 搭子用掉 1 个 → 1 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-7,wan-8", 2), laizi), 1);
  // 789 完整顺子 → 2 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-7,wan-8,wan-9", 2), laizi), 2);
  // 55 对子不吸收赖子
  assert.equal(countIdleLaizi(handWithLaizi("wan-5,wan-5", 2), laizi), 2);
  // 111,23+1 赖 → 23+赖连成顺子 → 0 闲
  assert.equal(countIdleLaizi(handWithLaizi("wan-1,wan-1,wan-1,wan-2,wan-3", 1), laizi), 0);
  // 不拆完整顺子去吸收：12357 优先组 123，再算 57 搭子
  assert.equal(countIdleLaizi(handWithLaizi("tiao-1,tiao-2,tiao-3,tiao-5,tiao-7", 2), laizi), 1);
});

test("run-feng tier follows idle laizi count on the pre-draw hand", () => {
  const laizi = "zhong";
  // 摸牌前 13 张：123万、234条、567筒、57万+2 赖（57 搭子用掉 1 个赖子 → 1 闲）
  const preDraw = [
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-6",
    "tong-7",
    "wan-5",
    "wan-7",
    laizi,
    laizi,
  ];
  const drawn = "wan-6"; // 摸成 567万 开牌
  const tiles = [...preDraw, drawn];
  const detail = resolveWinDetail({
    tiles,
    laiziTile: laizi,
    wasRunFengBeforeDraw: true,
    idleLaiziCount: countIdleLaizi(preDraw, laizi),
    ruleConfig: normalizeRuleConfig({}),
  });
  assert.equal(detail.baseType, WIN_TYPES.PAO_FENG_1);
  assert.equal(detail.totalZi, 2);
});

test("run-feng tier falls back to 1 pao when idle count is 0 with laizi present", () => {
  const laizi = "zhong";
  // 13 张：123万、123万、456条、789筒 + 1 赖（显式传 idle=0 模拟赖子全被搭子用掉）
  const preDraw = [
    "wan-1",
    "wan-2",
    "wan-3",
    "wan-1",
    "wan-2",
    "wan-3",
    "tiao-4",
    "tiao-5",
    "tiao-6",
    "tong-7",
    "tong-8",
    "tong-9",
    laizi,
  ];
  assert.equal(preDraw.length, 13);
  const drawn = "wan-2"; // 摸成 22 将 + 123 + 12赖 + 123
  const detail = resolveWinDetail({
    tiles: [...preDraw, drawn],
    laiziTile: laizi,
    wasRunFengBeforeDraw: true,
    idleLaiziCount: 0,
    ruleConfig: normalizeRuleConfig({}),
  });
  assert.equal(detail.baseType, WIN_TYPES.PAO_FENG_1);
  assert.equal(detail.totalZi, 2);
});

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

// 四刻 + 将的对对胡（east 刻子另计风箭附加，east 对子不计）。
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
  "east",
  "east",
  "east",
  "tiao-3",
  "tiao-3",
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
  // 恩豆 2 + 对对胡 4 + 风箭（east 刻子）1 = 7 子。
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
  // east 对子不再计风箭附加（需 3 张一样才算）。
  const detail = resolveWinDetail({
    tiles: ["east", "east"],
    laiziTile: "zhong",
    exposedMeldCount: 4,
  });
  assert.equal(detail.baseType, WIN_TYPES.EN_DOU);
  assert.deepEqual(
    detail.bonuses.map((bonus) => bonus.key),
    ["quanQiuDuDiao"],
  );
  assert.equal(detail.totalZi, 2 + 6);
});

const pengOf = (tile) => ({ type: "peng", tile, tiles: [tile, tile, tile] });

test("resolves dui dui hu with exposed pungs", () => {
  // 碰出一副刻子后胡牌：暗牌 11 张（3 暗刻 + 将），对对胡应成立。
  const melds = [pengOf("tong-9")];
  const tiles = [
    "wan-1",
    "wan-1",
    "wan-1",
    "tiao-2",
    "tiao-2",
    "tiao-2",
    "tong-5",
    "tong-5",
    "tong-5",
    "east",
    "east",
  ];
  const detail = resolveWinDetail({
    tiles,
    laiziTile: "zhong",
    exposedMeldCount: 1,
    melds,
  });
  assert.equal(detail.baseType, WIN_TYPES.EN_DOU);
  assert.deepEqual(
    detail.bonuses.map((bonus) => bonus.key),
    ["duiDuiHu"],
  );
  assert.equal(detail.totalZi, 2 + 4);
  assert.equal(isDuiDuiHu(tiles, "zhong", melds), true);

  // 暗牌里含顺子则不算对对胡（副露刻子也救不回来）。
  const runTiles = [
    "wan-1",
    "wan-1",
    "wan-1",
    "tiao-2",
    "tiao-3",
    "tiao-4",
    "tong-5",
    "tong-5",
    "tong-5",
    "east",
    "east",
  ];
  assert.equal(isDuiDuiHu(runTiles, "zhong", melds), false);
  const runDetail = resolveWinDetail({
    tiles: runTiles,
    laiziTile: "zhong",
    exposedMeldCount: 1,
    melds,
  });
  assert.deepEqual(runDetail.bonuses, []);
  assert.equal(runDetail.totalZi, 2);
});

test("dui dui hu excludes quan qiu du diao shape even when its rule is off", () => {
  // 全球独钓规则关闭时，"4 组副露只剩对子开牌"也不得回算成对对胡。
  const fourPungs = [pengOf("wan-2"), pengOf("wan-3"), pengOf("tong-5"), pengOf("tong-7")];
  const detail = resolveWinDetail({
    tiles: ["east", "east"],
    laiziTile: "zhong",
    exposedMeldCount: 4,
    melds: fourPungs,
    ruleConfig: { rules: { quanQiuDuDiao: false } },
  });
  assert.equal(detail.baseType, WIN_TYPES.EN_DOU);
  assert.deepEqual(detail.bonuses, []);
  assert.equal(detail.totalZi, 2);
  assert.equal(isDuiDuiHu(["east", "east"], "zhong", fourPungs), false);

  // 赖子替位的碰仍算刻子：2 副露（其中 1 个赖子碰）+ 2 暗刻 + 将 → 对对胡成立。
  const laiziPeng = { type: "peng", tile: "wan-3", tiles: ["wan-3", "wan-3", "zhong"] };
  assert.equal(
    isDuiDuiHu(
      ["wan-1", "wan-1", "wan-1", "tiao-2", "tiao-2", "tiao-2", "east", "east"],
      "zhong",
      [laiziPeng, pengOf("tong-7")],
    ),
    true,
  );
});

test("ambiguous triplet and sequence decompositions are not dui dui hu", () => {
  // 223344 既能摆 22/33/44 又能摆 234/234：只要存在顺子开牌摆法就不算对对胡。
  const ambiguousTiles = [
    "wan-2",
    "wan-2",
    "wan-3",
    "wan-3",
    "wan-4",
    "wan-4",
    "tong-5",
    "tong-5",
    "tong-5",
    "tiao-6",
    "tiao-6",
    "tiao-6",
    "east",
    "east",
  ];
  assert.equal(isDuiDuiHu(ambiguousTiles, "zhong"), false);
  const ambiguousDetail = resolveWinDetail({
    tiles: ambiguousTiles,
    laiziTile: "zhong",
  });
  assert.equal(ambiguousDetail.baseType, WIN_TYPES.EN_DOU);
  assert.deepEqual(ambiguousDetail.bonuses, []);
  assert.equal(ambiguousDetail.totalZi, 2);

  // 对照：同样骨架换成 222（无顺子摆法）→ 对对胡照常成立。
  const pureTripletTiles = [
    "wan-2",
    "wan-2",
    "wan-2",
    "tong-5",
    "tong-5",
    "tong-5",
    "tiao-6",
    "tiao-6",
    "tiao-6",
    "wan-8",
    "wan-8",
    "wan-8",
    "east",
    "east",
  ];
  assert.equal(isDuiDuiHu(pureTripletTiles, "zhong"), true);
  const pureDetail = resolveWinDetail({
    tiles: pureTripletTiles,
    laiziTile: "zhong",
  });
  assert.deepEqual(
    pureDetail.bonuses.map((bonus) => bonus.key),
    ["duiDuiHu"],
  );
  assert.equal(pureDetail.totalZi, 2 + 4);
});

test("si xi bonus adds 20 zi when winning hand holds four laizi tiles", () => {
  // 开牌手牌集齐 4 张赖子（跑风 2 跑档）：全刻摆法成立 → 对对胡与四喜叠加。
  const siXiTiles = [
    "zhong",
    "zhong",
    "zhong",
    "zhong",
    "wan-2",
    "wan-2",
    "wan-5",
    "wan-5",
    "tong-5",
    "tong-5",
    "tong-8",
    "tong-8",
    "east",
    "east",
  ];
  const detail = resolveWinDetail({
    tiles: siXiTiles,
    laiziTile: "zhong",
    wasRunFengBeforeDraw: true,
    idleLaiziCount: 4,
  });
  assert.equal(detail.baseType, WIN_TYPES.PAO_FENG_2);
  assert.deepEqual(
    detail.bonuses.map((bonus) => bonus.key),
    ["siXi", "duiDuiHu"],
  );
  assert.equal(detail.totalZi, 3 + 20 + 4);

  // 四喜规则关闭时不再计四喜。
  const detailOff = resolveWinDetail({
    tiles: siXiTiles,
    laiziTile: "zhong",
    wasRunFengBeforeDraw: true,
    idleLaiziCount: 4,
    ruleConfig: { rules: { siXi: false } },
  });
  assert.deepEqual(
    detailOff.bonuses.map((bonus) => bonus.key),
    ["duiDuiHu"],
  );
  assert.equal(detailOff.totalZi, 3 + 4);
});

test("counts wind arrow bonuses from hand triplets and melds", () => {
  // 对子不计：2 张一样不算风箭附加
  assert.equal(countWindArrowBonus(["east", "east", "fa"], [], "zhong"), 0);
  // 3 张一样（刻子）计 1 子；4 张同样只算 1 组
  assert.equal(countWindArrowBonus(["east", "east", "east", "fa"], [], "zhong"), 1);
  assert.equal(countWindArrowBonus(["east", "east", "east", "east"], [], "zhong"), 1);
  // 手牌刻子与副露碰杠可以叠加
  assert.equal(
    countWindArrowBonus(["east", "east", "east"], [{ type: "peng", tile: "fa", tiles: ["fa", "fa", "fa"] }], "zhong"),
    2,
  );
  // 赖子搭配的碰组不算；手牌对子也不计
  assert.equal(
    countWindArrowBonus(["east", "east"], [{ type: "peng", tile: "fa", tiles: ["fa", "fa", "zhong"] }], "zhong"),
    0,
  );
  // 赖子本身不计：赖子牌（zhong）凑成的 3 张视为赖子搭配，不算风箭
  assert.equal(countWindArrowBonus(["east", "zhong", "zhong", "zhong", "fa"], [], "zhong"), 0);
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
