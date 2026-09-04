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

// ==================== 基础胡型 ====================
// 新计分体系以"子"为内部单位（豆 = 子 × 倍率），子不展示给玩家。
// 基础型决定几分：恩豆 2 / 小开 1 / 1跑 2 / 2跑 3 / 七小对 10。
export const WIN_TYPES = {
  EN_DOU: "enDou", // 恩豆：没有赖子开牌
  XIAO_KAI: "xiaoKai", // 小开：1 个赖子开牌（非跑风）
  PAO_FENG_1: "paoFeng1", // 1 跑：跑风且 1 个赖子
  PAO_FENG_2: "paoFeng2", // 2 跑：跑风且 2 个及以上赖子
  QI_XIAO_DUI: "qiXiaoDui", // 七小对（单独算法，不叠加对对胡等牌型附加）
  // 旧版标识，兼容保留（仅用于展示兜底与旧用例映射）
  PING_HU: "pingHu",
  RUN_FENG: "runFeng",
  GANG_PING_HU: "gangPingHu",
  ZHI_GANG: "zhiGang",
};

export const BASE_ZI = {
  [WIN_TYPES.EN_DOU]: 2,
  [WIN_TYPES.XIAO_KAI]: 1,
  [WIN_TYPES.PAO_FENG_1]: 2,
  [WIN_TYPES.PAO_FENG_2]: 3,
  [WIN_TYPES.QI_XIAO_DUI]: 10,
};

// 附加分（单位：子）
export const BONUS_ZI = {
  wanGang: 4, // 弯杠：杠牌时胡了但不是跑风
  zhiGang: 10, // 直杠：杠牌时胡了且是跑风
  duiDuiHu: 4, // 对对胡：开牌时没有顺子
  quanQiuDuDiao: 6, // 全球独钓：只剩 2 张牌开牌（必含对对胡但不叠加）
};

// 头家（庄家）加成（单位：子）：每家多付的子数，跑风翻倍
export const HEAD_BONUS_ZI = {
  NORMAL: 1,
  RUN_FENG: 2,
  QI_XIAO_DUI: 2,
};

// 风箭牌范围（东南西北中发白）：手牌对子及以上或副露碰/杠，每个 +1 子
export const WIND_ARROW_TILES = [
  "east",
  "south",
  "west",
  "north",
  "zhong",
  "fa",
  "bai",
];

export const BONUS_LABELS = {
  wanGang: "弯杠",
  zhiGang: "直杠",
  duiDuiHu: "对对胡",
  quanQiuDuDiao: "全球独钓",
  windArrow: "风箭牌",
};

export const WIN_TYPE_LABELS = {
  [WIN_TYPES.EN_DOU]: "恩豆",
  [WIN_TYPES.XIAO_KAI]: "小开",
  [WIN_TYPES.PAO_FENG_1]: "跑风",
  [WIN_TYPES.PAO_FENG_2]: "两个跑",
  [WIN_TYPES.QI_XIAO_DUI]: "七小对",
};

// ==================== 规则配置 ====================
// 创建房间时可勾选的规则开关与倍率；mustLackOneSuit（打缺）保持独立字段。
export const DEFAULT_RULE_CONFIG = {
  multiplier: 5, // 默认 5 倍场
  rules: {
    enDou: true, // 恩豆：无赖子开牌 +2 子
    xiaoKai: true, // 小开：1 赖子开牌（非跑风）+1 子
    paoFeng1: true, // 1 跑：跑风 1 赖子 +2 子
    paoFeng2: true, // 2 跑：跑风 2 赖子 +3 子
    qiXiaoDui: true, // 七小对（关闭后纯七小对手牌不可胡）
    wanGang: true, // 弯杠 +4 子
    zhiGang: true, // 直杠 +10 子
    duiDuiHu: true, // 对对胡 +4 子
    quanQiuDuDiao: true, // 全球独钓 +6 子
    windArrowBonus: true, // 风箭对子/杠 每个 +1 子
    headBonus: true, // 头家加成：头家多付 1 子、跑风 2 子
    streakPenalty: true, // 连打惩罚：4 家连打同一张牌
  },
};

export const RULE_LABELS = {
  multiplier: "倍率",
  enDou: "恩豆（无赖子开牌 +2子）",
  xiaoKai: "小开（1个赖子开牌 +1子）",
  paoFeng1: "1跑（跑风1个赖子 +2子）",
  paoFeng2: "2跑（跑风2个赖子 +3子）",
  qiXiaoDui: "七小对（每家10子/头家12子）",
  wanGang: "弯杠（杠时胡、非跑风 +4子）",
  zhiGang: "直杠（杠时胡、跑风 +10子）",
  duiDuiHu: "对对胡（没有顺子 +4子）",
  quanQiuDuDiao: "全球独钓（只剩2张开牌 +6子）",
  windArrowBonus: "风箭附加（风箭对子/杠每个 +1子）",
  headBonus: "头家加成（头家多付1子、跑风2子）",
  streakPenalty: "连打惩罚（4家连打同一张牌）",
};

// 合并任意来源的规则配置（房间/客户端/存档），未知字段回退默认值。
export function normalizeRuleConfig(config) {
  const multiplierRaw = Number(config?.multiplier);
  const multiplier =
    Number.isFinite(multiplierRaw) && multiplierRaw > 0
      ? Math.floor(multiplierRaw)
      : DEFAULT_RULE_CONFIG.multiplier;

  const rules = { ...DEFAULT_RULE_CONFIG.rules };
  if (config && typeof config.rules === "object" && config.rules !== null) {
    for (const key of Object.keys(rules)) {
      if (typeof config.rules[key] === "boolean") {
        rules[key] = config.rules[key];
      }
    }
  }

  return { multiplier, rules };
}

// ==================== 基础胡牌结构（沿用原有判定） ====================

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
  if (laiziCount >= 2) {
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

// ==================== 七小对 ====================
// 7 个对子；4 张同牌算 2 对；最多 1 个赖子（赖子须与单张配对）。
export function canQiXiaoDui(tiles, laiziTile, options = {}) {
  assertTile(laiziTile);
  const { mustLackOneSuit = false } = options;

  if (!Array.isArray(tiles) || tiles.length !== 14) {
    return false;
  }
  if (mustLackOneSuit && !hasLackOneSuit(tiles)) {
    return false;
  }

  const laiziCount = countTile(tiles, laiziTile);
  if (laiziCount > 1) {
    return false;
  }

  // 剔除赖子后统计真实对子与单张
  const counts = countTiles(tiles);
  counts[TILE_INDEX.get(laiziTile)] = 0;

  let pairs = 0;
  let singles = 0;
  for (const count of counts) {
    pairs += Math.floor(count / 2);
    singles += count % 2;
  }

  // 赖子先补单张凑对（单张 + 赖子 = 1 对），剩余赖子必须能自成一对。
  // 等价于牌数恒等式：2×对子 + 单张 + 赖子 = 14。
  const remainingLaizi = laiziCount - singles;
  if (remainingLaizi < 0 || remainingLaizi % 2 !== 0) {
    return false;
  }
  return pairs + singles + remainingLaizi / 2 === 7;
}

// ==================== 对对胡 ====================
// 14 张全部由刻子加一对将组成，不允许任何顺子（赖子可补位）。
function canFormTripletGroups(counts, laiziCount, memo = new Map()) {
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

  let result = false;
  // 3 张真牌成刻
  if (!result && counts[firstIndex] >= 3) {
    const nextCounts = [...counts];
    nextCounts[firstIndex] -= 3;
    result = canFormTripletGroups(nextCounts, laiziCount, memo);
  }
  // 2 真 + 1 赖成刻
  if (!result && counts[firstIndex] >= 2 && laiziCount >= 1) {
    const nextCounts = [...counts];
    nextCounts[firstIndex] -= 2;
    result = canFormTripletGroups(nextCounts, laiziCount - 1, memo);
  }
  // 1 真 + 2 赖成刻
  if (!result && counts[firstIndex] >= 1 && laiziCount >= 2) {
    const nextCounts = [...counts];
    nextCounts[firstIndex] -= 1;
    result = canFormTripletGroups(nextCounts, laiziCount - 2, memo);
  }
  // 3 赖成刻
  if (!result && laiziCount >= 3) {
    result = canFormTripletGroups(counts, laiziCount - 3, memo);
  }

  memo.set(key, result);
  return result;
}

export function isDuiDuiHu(tiles, laiziTile) {
  assertTile(laiziTile);
  if (!Array.isArray(tiles) || tiles.length !== 14) {
    return false;
  }

  const laiziCount = countTile(tiles, laiziTile);
  const counts = countTiles(tiles);
  counts[TILE_INDEX.get(laiziTile)] = 0;

  // 选将：2 真 / 1 真 1 赖 / 2 赖
  for (let index = 0; index < counts.length; index += 1) {
    if (counts[index] >= 2) {
      const nextCounts = [...counts];
      nextCounts[index] -= 2;
      if (canFormTripletGroups(nextCounts, laiziCount, new Map())) {
        return true;
      }
    }
    if (counts[index] >= 1 && laiziCount >= 1) {
      const nextCounts = [...counts];
      nextCounts[index] -= 1;
      if (canFormTripletGroups(nextCounts, laiziCount - 1, new Map())) {
        return true;
      }
    }
  }
  if (laiziCount >= 2 && canFormTripletGroups(counts, laiziCount - 2, new Map())) {
    return true;
  }
  return false;
}

// ==================== 风箭附加 ====================
// 手牌里真实风箭张数 >= 2（对子及以上）每门 +1；副露区每个风箭碰/杠 +1。
// 赖子不计入（赖子搭配成型的风箭不算，例如赖子碰出的风刻）。
export function countWindArrowBonus(tiles, melds = [], laiziTile) {
  assertTile(laiziTile);
  let count = 0;

  const counts = countTiles(tiles);
  counts[TILE_INDEX.get(laiziTile)] = 0;
  for (const tile of WIND_ARROW_TILES) {
    if (counts[TILE_INDEX.get(tile)] >= 2) {
      count += 1;
    }
  }

  for (const meld of melds) {
    const meldTiles = meld?.tiles ?? [];
    if (meldTiles.includes(laiziTile)) {
      continue;
    }
    if (meldTiles.some((meldTile) => WIND_ARROW_TILES.includes(meldTile))) {
      count += 1;
    }
  }

  return count;
}

// ==================== 胡牌明细解析 ====================

function buildWinDetail({
  baseType,
  config,
  isRunFeng,
  isGangDraw,
  tiles,
  laiziTile,
  melds,
  exposedMeldCount = 0,
}) {
  const bonuses = [];

  // 杠上开胡：跑风为直杠（+10），非跑风为弯杠（+4）
  if (isGangDraw) {
    if (isRunFeng && config.rules.zhiGang) {
      bonuses.push({ key: "zhiGang", label: BONUS_LABELS.zhiGang, zi: BONUS_ZI.zhiGang });
    } else if (!isRunFeng && config.rules.wanGang) {
      bonuses.push({ key: "wanGang", label: BONUS_LABELS.wanGang, zi: BONUS_ZI.wanGang });
    }
  }

  // 牌型附加（七小对不叠加）：全球独钓优先，独钓不再计对对胡
  if (baseType !== WIN_TYPES.QI_XIAO_DUI) {
    const isQuanQiuDuDiao = exposedMeldCount === 4 && tiles.length === 2;
    if (config.rules.quanQiuDuDiao && isQuanQiuDuDiao) {
      bonuses.push({
        key: "quanQiuDuDiao",
        label: BONUS_LABELS.quanQiuDuDiao,
        zi: BONUS_ZI.quanQiuDuDiao,
      });
    } else if (config.rules.duiDuiHu && isDuiDuiHu(tiles, laiziTile)) {
      bonuses.push({ key: "duiDuiHu", label: BONUS_LABELS.duiDuiHu, zi: BONUS_ZI.duiDuiHu });
    }
  }

  // 风箭附加（含七小对；赖子搭配的不算）
  if (config.rules.windArrowBonus) {
    const windArrowCount = countWindArrowBonus(tiles, melds, laiziTile);
    if (windArrowCount > 0) {
      bonuses.push({
        key: "windArrow",
        label: `${BONUS_LABELS.windArrow}×${windArrowCount}`,
        zi: windArrowCount,
      });
    }
  }

  const baseZi = BASE_ZI[baseType];
  const bonusZi = bonuses.reduce((total, bonus) => total + bonus.zi, 0);
  const headBonusZi = isRunFeng
    ? HEAD_BONUS_ZI.RUN_FENG
    : baseType === WIN_TYPES.QI_XIAO_DUI
      ? HEAD_BONUS_ZI.QI_XIAO_DUI
      : HEAD_BONUS_ZI.NORMAL;

  return {
    baseType,
    baseZi,
    bonuses,
    bonusZi,
    totalZi: baseZi + bonusZi,
    headBonusZi: config.rules.headBonus ? headBonusZi : 0,
    isRunFeng,
    isGangDraw,
    isQiXiaoDui: baseType === WIN_TYPES.QI_XIAO_DUI,
  };
}

// 解析胡牌明细：基础型 + 附加分 + 头家加成，全部以"子"为单位。
// 返回 null 表示按当前规则配置不可胡。
export function resolveWinDetail(context) {
  const {
    tiles,
    laiziTile,
    mustLackOneSuit = false,
    exposedMeldCount = 0,
    isGangDraw = false,
    wasRunFengBeforeGang = false,
    wasRunFengBeforeDraw = false,
    melds = [],
    ruleConfig,
  } = context;

  assertTile(laiziTile);
  const config = normalizeRuleConfig(ruleConfig);
  const laiziCount = countTile(tiles, laiziTile);
  const isRunFeng = isGangDraw ? wasRunFengBeforeGang : wasRunFengBeforeDraw;

  // ① 七小对优先：一旦成立即按七小对单独结算，不叠加对对胡/独钓等牌型附加
  if (
    config.rules.qiXiaoDui &&
    exposedMeldCount === 0 &&
    canQiXiaoDui(tiles, laiziTile, { mustLackOneSuit })
  ) {
    return buildWinDetail({
      baseType: WIN_TYPES.QI_XIAO_DUI,
      config,
      isRunFeng,
      isGangDraw,
      tiles,
      laiziTile,
      melds,
    });
  }

  // ② 基础型：跑风按赖子数分 1 跑/2 跑（0 赖子归恩豆），
  //    非跑风为恩豆/小开；对应开关关闭时该牌型不可胡。
  let baseType = null;
  if (isRunFeng) {
    if (laiziCount === 0) {
      if (config.rules.enDou) {
        baseType = WIN_TYPES.EN_DOU;
      }
    } else if (laiziCount === 1) {
      if (config.rules.paoFeng1) {
        baseType = WIN_TYPES.PAO_FENG_1;
      }
    } else if (config.rules.paoFeng2) {
      baseType = WIN_TYPES.PAO_FENG_2;
    }
  } else if (laiziCount === 0) {
    if (config.rules.enDou) {
      baseType = WIN_TYPES.EN_DOU;
    }
  } else if (laiziCount === 1) {
    if (config.rules.xiaoKai) {
      baseType = WIN_TYPES.XIAO_KAI;
    }
  }

  if (!baseType) {
    return null;
  }

  // 仍须满足标准胡牌结构（顺子/刻子/将，含赖子补位）
  if (!canHu(tiles, laiziTile, { mustLackOneSuit, exposedMeldCount, runFeng: isRunFeng })) {
    return null;
  }

  return buildWinDetail({
    baseType,
    config,
    isRunFeng,
    isGangDraw,
    tiles,
    laiziTile,
    melds,
    exposedMeldCount,
  });
}

// 兼容旧接口：把新明细映射回旧四类牌型（新逻辑一律经由 resolveWinDetail）。
export function resolveWinType(context) {
  const detail = resolveWinDetail(context);
  if (!detail) {
    return null;
  }
  if (detail.isQiXiaoDui) {
    return detail.baseType;
  }
  if (detail.isGangDraw) {
    return detail.isRunFeng ? WIN_TYPES.ZHI_GANG : WIN_TYPES.GANG_PING_HU;
  }
  return detail.isRunFeng ? WIN_TYPES.RUN_FENG : WIN_TYPES.PING_HU;
}

// ==================== 结算 ====================
// 把"子"乘以倍率折算成豆。头家胡牌（或向头家付分）时该份多付 headBonusZi 子。
export function scoreWin({
  winDetail,
  winnerSeat,
  dealerSeat,
  playerCount = 4,
  multiplier = DEFAULT_RULE_CONFIG.multiplier,
}) {
  if (!winDetail || !BASE_ZI[winDetail.baseType]) {
    throw new Error("scoreWin requires a valid winDetail from resolveWinDetail");
  }
  if (playerCount !== 4) {
    throw new Error("Qingyang Pinghu currently expects 4 players");
  }

  const { totalZi, headBonusZi } = winDetail;
  const isDealer = winnerSeat === dealerSeat;
  const payments = Array(playerCount).fill(0);
  const deltas = Array(playerCount).fill(0);

  for (let seat = 0; seat < playerCount; seat += 1) {
    if (seat === winnerSeat) {
      continue;
    }

    const involvesDealer = isDealer || seat === dealerSeat;
    const zi = involvesDealer ? totalZi + headBonusZi : totalZi;
    const beans = zi * multiplier;
    payments[seat] = beans;
    deltas[seat] = -beans;
    deltas[winnerSeat] += beans;
  }

  return {
    winDetail,
    winType: winDetail.baseType,
    totalZi,
    headBonusZi,
    multiplier,
    winnerSeat,
    dealerSeat,
    isDealer,
    payments,
    deltas,
  };
}

export function nextDealer({ currentDealerSeat, winnerSeat, isDraw, playerCount = 4 }) {
  if (isDraw || winnerSeat === currentDealerSeat) {
    return currentDealerSeat;
  }
  return (currentDealerSeat + 1) % playerCount;
}

// ==================== 标准胡牌递归（沿用原有实现） ====================

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
