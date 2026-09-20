// 青阳麻将（青羊平胡）玩法管理器
// 规则核心复用 packages/mahjong-core（ESM，Node 22 原生 require）：
// 缺一门、赖子（翻宝）、平胡/七小对/对对胡/全球独钓/风箭附加/头家加成/连打惩罚。
// 注意：core 为不可变模式，所有动作函数返回新 state，必须接收返回值。
var roomMgr = require("./roommgr");
var userMgr = require("./usermgr");
var db = require("../utils/db");
var crypto = require("../utils/crypto");
var core = require("../../../packages/mahjong-core/src/index.js");
var fs = require("fs");
var path = require("path");

var games = {};
var gameSeatsOfUsers = {};
var dissolvingList = [];

// ==================== 看门狗（防 AI/状态机卡死） ====================
var WD_DIR = path.join(__dirname, "..", "..", "logs");
var WD_LOG = path.join(WD_DIR, "qy_watchdog.log");
var WD_INTERVAL = 8000;

function wdLog(msg) {
    try {
        if (!fs.existsSync(WD_DIR)) fs.mkdirSync(WD_DIR, { recursive: true });
        fs.appendFileSync(WD_LOG, new Date().toISOString() + " " + msg + "\n");
    }
    catch (e) { /* 日志失败不影响主流程 */ }
}

var wdTimer = null;

function wdCheck() {
    try {
        var now = Date.now();
        for (var roomId in games) {
            var game = games[roomId];
            if (!game || !game.state) continue;
            if (game.state.status != "playing") continue;
            // 最近 16s 内有活动（摸牌/出牌/碰杠胡/过）则视为正常进行
            if (game.lastActivity && (now - game.lastActivity) < 16000) continue;
            var st = game.state;
            var waitingHuman = false;
            var waitingBot = false;
            var botSeat = -1;
            for (var i = 0; i < 4; ++i) {
                var r = game.reactions[i];
                if (!r || !hasOperations(r)) continue;
                var uid = game.roomInfo.seats[i].userId;
                if (uid < 0) { waitingBot = true; botSeat = i; }
                else waitingHuman = true;
            }
            var botToAct = false;
            if (st.phase == "discard" && st.currentSeat >= 0) {
                var cuid = game.roomInfo.seats[st.currentSeat].userId;
                if (cuid < 0) botToAct = true;
            }
            if (botToAct || waitingBot) {
                // AI 卡住 → 重排机器人
                wdLog("room=" + roomId + " watchdog: bot stuck (phase=" + st.phase + " seat=" + st.currentSeat + " botSeat=" + botSeat + ") -> rescheduleBots");
                game.lastActivity = now;
                scheduleBots(game);
                continue;
            }
            if (st.phase == "reaction" && !waitingHuman && !hasAnyReaction(game)) {
                // reaction 相位但全员无操作（异常残留）→ 推进摸牌
                wdLog("room=" + roomId + " watchdog: reaction drained -> doDraw");
                game.lastActivity = now;
                doDraw(game);
                continue;
            }
            if (waitingHuman) {
                // 真人 30s+ 未响应 → 代为过牌
                if (!game.lastActivity || (now - game.lastActivity) < 32000) continue;
                wdLog("room=" + roomId + " watchdog: human reaction timeout -> auto guo all");
                game.lastActivity = now;
                for (var j = 0; j < 4; ++j) {
                    var rj = game.reactions[j];
                    if (rj && hasOperations(rj)) {
                        game.reactions[j] = null;
                    }
                }
                var stNow = game.state;
                if (stNow.phase == "reaction" && !hasAnyReaction(game)) {
                    broadcastInGame(game, 'guo_notify', { seatindex: stNow.lastDiscard ? stNow.lastDiscard.seat : -1, pai: -1 }, game.roomInfo.seats[0].userId, true);
                    doDraw(game);
                }
            }
        }
    }
    catch (e) {
        wdLog("watchdog error: " + (e && e.message ? e.message : e));
    }
}

function armWatchdog() {
    if (wdTimer == null) {
        wdTimer = setInterval(wdCheck, WD_INTERVAL);
        wdLog("watchdog started, interval=" + WD_INTERVAL + "ms");
    }
}

var ACTION_CHUPAI = 1;
var ACTION_MOPAI = 2;
var ACTION_PENG = 3;
var ACTION_GANG = 4;
var ACTION_HU = 5;
var ACTION_ZIMO = 6;

// ==================== 牌 ID <-> core 牌名 映射 ====================
// 以客户端 MahjongMgr.js mahjongSprites 数组顺序为准：
// 0-8 筒、9-17 条、18-26 万、27 中、28 发、29 白、30 东、31 西、32 南、33 北
var ID_TO_TILE = [];
for (var i = 0; i < 9; ++i) ID_TO_TILE.push("tong-" + (i + 1));
for (var i = 0; i < 9; ++i) ID_TO_TILE.push("tiao-" + (i + 1));
for (var i = 0; i < 9; ++i) ID_TO_TILE.push("wan-" + (i + 1));
ID_TO_TILE.push("zhong"); // 27
ID_TO_TILE.push("fa");    // 28
ID_TO_TILE.push("bai");   // 29
ID_TO_TILE.push("east");  // 30
ID_TO_TILE.push("west");  // 31
ID_TO_TILE.push("south"); // 32
ID_TO_TILE.push("north"); // 33

var TILE_TO_ID = {};
for (var i = 0; i < ID_TO_TILE.length; ++i) {
    TILE_TO_ID[ID_TO_TILE[i]] = i;
}

function tilesToIds(tiles) {
    var ids = [];
    if (!tiles) return ids;
    for (var i = 0; i < tiles.length; ++i) {
        var id = TILE_TO_ID[tiles[i]];
        if (id != null) {
            ids.push(id);
        }
    }
    return ids;
}

// 把 core melds 转成客户端 seatData 风格分组
// peng -> pengs, mingGang -> diangangs, anGang -> angangs, buGang -> wangangs
function meldsToClient(melds) {
    var ret = { pengs: [], diangangs: [], angangs: [], wangangs: [] };
    for (var i = 0; i < melds.length; ++i) {
        var m = melds[i];
        var id = TILE_TO_ID[m.tile];
        if (m.type == "peng") ret.pengs.push(id);
        else if (m.type == "mingGang") ret.diangangs.push(id);
        else if (m.type == "anGang") ret.angangs.push(id);
        else if (m.type == "buGang") ret.wangangs.push(id);
    }
    return ret;
}

// ==================== 基础工具 ====================
function getGameByUserID(userId) {
    var roomId = roomMgr.getUserRoom(userId);
    if (roomId == null) return null;
    return games[roomId];
}

function getSeatData(userId) {
    return gameSeatsOfUsers[userId];
}

function hasOperations(reaction) {
    if (reaction == null) return false;
    return reaction.canHu || reaction.canPeng || reaction.canGang;
}

function hasAnyReaction(game) {
    for (var i = 0; i < game.reactions.length; ++i) {
        if (hasOperations(game.reactions[i])) {
            return true;
        }
    }
    return false;
}

function recordGameAction(game, si, action, pai) {
    game.actionList.push(si);
    game.actionList.push(action);
    if (pai != null) {
        game.actionList.push(pai);
    }
}

// ==================== 反应计算 ====================
// 计算某座位当前可做的操作（别人打牌时的碰/点杠/点炮胡，或自己摸牌后的自摸胡/暗杠/弯杠）
function computeReactionForSeat(game, seat) {
    var st = game.state;
    if (st.status != "playing") {
        return null;
    }
    var player = st.players[seat];

    if (st.phase == "reaction") {
        var ld = st.lastDiscard;
        if (!ld || ld.seat == seat) {
            return null;
        }
        var reaction = { canHu: false, canPeng: false, canGang: false, gangPai: [], detail: null };
        // 青阳规则：只能自摸，不允许点炮胡——别人打牌时只检测碰/点杠
        var mgOptions = core.getMingGangOptions(st, seat);
        reaction.canPeng = core.getPengOptions(st, seat).length > 0;
        reaction.canGang = mgOptions.length > 0;
        reaction.gangPai = tilesToIds(mgOptions);
        if (hasOperations(reaction)) {
            return reaction;
        }
        return null;
    }

    if (st.phase == "discard" && st.currentSeat == seat) {
        var reaction = { canHu: false, canPeng: false, canGang: false, gangPai: [], detail: null, isZimoTurn: true };
        // 自摸胡：core 在摸牌/杠补后已 buildAvailableWin
        if (st.availableWin && st.availableWin.seat == seat) {
            reaction.canHu = true;
            reaction.detail = st.availableWin.detail;
        }
        var ans = core.getAnGangOptions(st, seat);
        var bus = core.getBuGangOptions(st, seat);
        reaction.canGang = ans.length > 0 || bus.length > 0;
        reaction.gangPai = tilesToIds(ans.concat(bus));
        if (hasOperations(reaction)) {
            return reaction;
        }
        return null;
    }

    return null;
}

// ==================== 操作推送 ====================
// 显式按 game 定位的房间广播：多房间机器人共用 userId（-1001/-1002/-1003），
// roomMgr.userLocation 会被后开房间覆盖，userMgr.broacastInRoom 以 AI userId 反查房间会发错房间，
// 这里直接遍历 game.roomInfo.seats 发送，彻底绕开全局定位
function broadcastInGame(game, event, data, sender, includingSender) {
    if (game == null || game.roomInfo == null) {
        // 无 game 上下文（未开局解散等）：回退原定位（此时 sender 应为真人，定位可靠）
        userMgr.broacastInRoom(event, data, sender, includingSender);
        return;
    }
    var seats = game.roomInfo.seats;
    for (var i = 0; i < seats.length; ++i) {
        var rs = seats[i];
        if (rs.userId == sender && includingSender != true) {
            continue;
        }
        userMgr.sendMsg(rs.userId, event, data);
    }
}

function sendOperations(game, seatIndex, pai) {
    var reaction = game.reactions[seatIndex];
    var userId = game.roomInfo.seats[seatIndex].userId;
    if (hasOperations(reaction)) {
        var data = {
            pai: pai,
            hu: reaction.canHu,
            peng: reaction.canPeng,
            gang: reaction.canGang,
            gangpai: reaction.gangPai
        };
        userMgr.sendMsg(userId, 'game_action_push', data);
        data.si = seatIndex;
    }
    else {
        userMgr.sendMsg(userId, 'game_action_push');
    }
}

// 刷新指定座位反应并推送（有的话）
function refreshReaction(game, seat, pai) {
    game.reactions[seat] = computeReactionForSeat(game, seat);
    if (hasOperations(game.reactions[seat])) {
        sendOperations(game, seat, pai);
        return true;
    }
    return false;
}

function clearAllReactions(game) {
    game.reactions = [null, null, null, null];
}

// 剩余可正常摸的牌数 = 牌墙张数 - 死墙留底（开局按赖子骰留底，杠后补骰会动态更新，需实时计算）
function getDrawableCount(st) {
    var dead = st.deadWallTiles != null ? st.deadWallTiles : 0;
    if (dead < 0) {
        dead = 0;
    }
    var n = st.wall.length - dead;
    return n > 0 ? n : 0;
}

// ==================== 摸牌推进 ====================
// 无人有操作时推进到下一家摸牌
function doDraw(game) {
    if (game.drawTimer) {
        clearTimeout(game.drawTimer);
        game.drawTimer = null;
    }

    var st = game.state;
    if (st.status != "playing") {
        return;
    }

    if (st.phase == "reaction") {
        game.state = core.skipReactions(st);
        st = game.state;
    }

    game.state = core.drawForCurrentSeat(st);
    st = game.state;
    game.lastActivity = Date.now();
    var turnSeat = st.currentSeat;
    var turnUser = game.roomInfo.seats[turnSeat].userId;

    // 牌墙摸穿（进入死墙区）流局
    if (st.status == "ended") {
        doGameOver(game, turnUser);
        return;
    }

    broadcastInGame(game, 'mj_count_push', getDrawableCount(st), turnUser, true);
    recordGameAction(game, turnSeat, ACTION_MOPAI, TILE_TO_ID[st.lastDraw.tile]);
    userMgr.sendMsg(turnUser, 'game_mopai_push', TILE_TO_ID[st.lastDraw.tile]);

    game.reactions[turnSeat] = computeReactionForSeat(game, turnSeat);

    // 广播出牌方
    broadcastInGame(game, 'game_chupai_push', turnUser, turnUser, true);
    sendOperations(game, turnSeat, -1);

    // AI 座位自动出牌（摸牌后轮到 AI）
    scheduleBots(game);
}

// 出牌后无人操作时，延时把牌沉入弃牌区并推进摸牌
function scheduleAutoAdvance(game, delay) {
    if (game.drawTimer) {
        clearTimeout(game.drawTimer);
    }
    game.drawTimer = setTimeout(function () {
        game.drawTimer = null;
        var st = game.state;
        if (st.status != "playing") {
            return;
        }
        // 还有人有待操作（断线重连等情形）则不推进
        if (st.phase == "reaction" && hasAnyReaction(game)) {
            return;
        }
        var ld = st.lastDiscard;
        if (ld) {
            var discarder = game.roomInfo.seats[ld.seat].userId;
            broadcastInGame(game, 'guo_notify_push', { userId: discarder, pai: TILE_TO_ID[ld.tile] }, discarder, true);
        }
        doDraw(game);
    }, delay);
}

// ==================== 各动作 ====================
// 内部实现显式接收 game/seatIndex：AI 机器人多房间共用 userId，全局 gameSeatsOfUsers 会互相覆盖，
// 机器人动作必须走 doXxx 直调；真人客户端走 exports 薄壳（真人 userId 唯一，映射可靠）
function doChuPai(game, seatIndex, pai) {
    pai = Number.parseInt(pai);
    var userId = game.roomInfo.seats[seatIndex].userId;

    game.lastActivity = Date.now();
    var st = game.state;

    if (st.status != "playing") {
        console.log("game is over.");
        return;
    }

    if (st.phase != "discard" || st.currentSeat != seatIndex) {
        console.log("not your turn.");
        return;
    }

    if (hasOperations(game.reactions[seatIndex])) {
        console.log('plz guo before you chupai.');
        return;
    }

    var tile = ID_TO_TILE[pai];
    if (tile == null) {
        console.log("invalid pai:" + pai);
        return;
    }

    var handIndex = st.players[seatIndex].hand.indexOf(tile);
    if (handIndex == -1) {
        console.log("can't find mj." + pai);
        return;
    }

    try {
        game.state = core.discardTile(st, seatIndex, handIndex);
    }
    catch (e) {
        console.log("discard failed:" + e.message);
        return;
    }
    st = game.state;

    recordGameAction(game, seatIndex, ACTION_CHUPAI, pai);
    clearAllReactions(game);

    broadcastInGame(game, 'game_chupai_notify_push', { userId: userId, pai: pai }, userId, true);

    // 检查其他家是否可胡/碰/点杠
    var hasActions = false;
    for (var i = 0; i < 4; ++i) {
        if (i == seatIndex) {
            continue;
        }
        if (refreshReaction(game, i, pai)) {
            hasActions = true;
        }
    }

    // 无人操作：稍后自动沉牌并推进
    if (!hasActions) {
        scheduleAutoAdvance(game, 500);
    }

    // AI 座位自动响应（碰/杠/胡或过）
    scheduleBots(game);
}

exports.chuPai = function (userId, pai) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        console.log("can't find user game data.");
        return;
    }
    doChuPai(seatData.game, seatData.seatIndex, pai);
};

function doPeng(game, seatIndex) {
    var userId = game.roomInfo.seats[seatIndex].userId;
    game.lastActivity = Date.now();
    var st = game.state;
    var reaction = game.reactions[seatIndex];

    if (st.phase != "reaction" || !reaction || !reaction.canPeng) {
        console.log("peng not available.");
        return;
    }

    var tile = st.lastDiscard.tile;
    try {
        game.state = core.pengDiscard(st, seatIndex);
    }
    catch (e) {
        console.log("peng failed:" + e.message);
        return;
    }
    st = game.state;

    recordGameAction(game, seatIndex, ACTION_PENG, TILE_TO_ID[tile]);
    clearAllReactions(game);

    broadcastInGame(game, 'peng_notify_push', { userid: userId, pai: TILE_TO_ID[tile] }, userId, true);

    // 碰后轮到自己出牌
    broadcastInGame(game, 'game_chupai_push', userId, userId, true);
    refreshReaction(game, seatIndex, -1);
    sendOperations(game, seatIndex, -1);
    scheduleBots(game);
}

exports.peng = function (userId) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        console.log("can't find user game data.");
        return;
    }
    doPeng(seatData.game, seatData.seatIndex);
};

function doGang(game, seatIndex, pai) {
    var userId = game.roomInfo.seats[seatIndex].userId;
    game.lastActivity = Date.now();
    var st = game.state;
    var reaction = game.reactions[seatIndex];

    var tile = null;
    var gangtype = null;

    if (st.phase == "reaction") {
        // 点杠：别人打的牌自己手里有暗刻
        if (!reaction || !reaction.canGang) {
            console.log("gang not available.");
            return;
        }
        tile = st.lastDiscard.tile;
        gangtype = "diangang";
        try {
            game.state = core.mingGangDiscard(st, seatIndex, Math.random);
        }
        catch (e) {
            console.log("ming gang failed:" + e.message);
            return;
        }
    }
    else if (st.phase == "discard" && st.currentSeat == seatIndex) {
        // 暗杠 / 弯杠（补杠）
        if (!reaction || !reaction.canGang) {
            console.log("gang not available.");
            return;
        }
        tile = ID_TO_TILE[pai];
        if (tile == null) {
            console.log("invalid gang pai:" + pai);
            return;
        }
        if (core.getAnGangOptions(st, seatIndex).indexOf(tile) != -1) {
            gangtype = "angang";
            try {
                game.state = core.anGang(st, seatIndex, tile, Math.random);
            }
            catch (e) {
                console.log("an gang failed:" + e.message);
                return;
            }
        }
        else if (core.getBuGangOptions(st, seatIndex).indexOf(tile) != -1) {
            gangtype = "wangang";
            try {
                game.state = core.buGang(st, seatIndex, tile, Math.random);
            }
            catch (e) {
                console.log("bu gang failed:" + e.message);
                return;
            }
        }
        else {
            console.log("gang not available for pai:" + pai);
            return;
        }
    }
    else {
        console.log("can't gang now. phase:" + st.phase);
        return;
    }

    st = game.state;
    recordGameAction(game, seatIndex, ACTION_GANG, TILE_TO_ID[tile]);
    clearAllReactions(game);

    if (gangtype == "wangang") {
        broadcastInGame(game, 'hangang_notify_push', seatIndex, userId, true);
    }
    broadcastInGame(game, 'gang_notify_push', { userid: userId, pai: TILE_TO_ID[tile], gangtype: gangtype }, userId, true);

    // 杠后补牌（core 已从墙尾取牌并挂 lastDraw；空过时 lastDraw 为 null）
    broadcastInGame(game, 'mj_count_push', getDrawableCount(st), userId, true);
    if (st.lastDraw) {
        userMgr.sendMsg(userId, 'game_mopai_push', TILE_TO_ID[st.lastDraw.tile]);
    }

    // 杠开胡判定已由 core 在杠函数内部 buildAvailableWin 完成
    broadcastInGame(game, 'game_chupai_push', userId, userId, true);
    refreshReaction(game, seatIndex, -1);
    sendOperations(game, seatIndex, -1);
    scheduleBots(game);
}

exports.gang = function (userId, pai) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        console.log("can't find user game data.");
        return;
    }
    doGang(seatData.game, seatData.seatIndex, pai);
};

function doHu(game, seatIndex) {
    var userId = game.roomInfo.seats[seatIndex].userId;
    game.lastActivity = Date.now();
    var st = game.state;
    var reaction = game.reactions[seatIndex];

    if (!reaction || !reaction.canHu) {
        console.log("hu not available.");
        return;
    }

    var isZimo = false;
    var huTile = null;

    if (st.phase == "discard" && st.currentSeat == seatIndex && st.availableWin && st.availableWin.seat == seatIndex) {
        // 自摸（含杠开）
        isZimo = true;
        huTile = st.lastDraw ? st.lastDraw.tile : null;
        try {
            game.state = core.finishWin(st, seatIndex);
        }
        catch (e) {
            console.log("zimo failed:" + e.message);
            return;
        }
    }
    else {
        // 青阳规则：只能自摸胡，不允许点炮胡
        console.log("hu not available now.");
        return;
    }

    st = game.state;
    if (game.firstHupai < 0) {
        game.firstHupai = seatIndex;
    }

    recordGameAction(game, seatIndex, isZimo ? ACTION_ZIMO : ACTION_HU, huTile == null ? -1 : TILE_TO_ID[huTile]);

    broadcastInGame(game, 'hu_push', {
        seatindex: seatIndex,
        iszimo: isZimo,
        hupai: isZimo ? -1 : TILE_TO_ID[huTile]
    }, userId, true);

    // 青阳一局一胡：胡牌即结算本局
    doGameOver(game, userId, false, huTile);
};

exports.hu = function (userId) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        console.log("can't find user game data.");
        return;
    }
    doHu(seatData.game, seatData.seatIndex);
};

function doGuo(game, seatIndex) {
    var userId = game.roomInfo.seats[seatIndex].userId;
    userMgr.sendMsg(userId, "guo_result");

    var st = game.state;
    var reaction = game.reactions[seatIndex];

    if (reaction == null) {
        // 无操作可放弃：不刷新 lastActivity，避免空 guo 干扰看门狗判断
        return;
    }

    // 有真实操作，刷新活动时间
    game.lastActivity = Date.now();

    // 自己回合（放弃自摸胡/暗杠/弯杠）：清掉操作，继续等他出牌
    if (st.phase == "discard" && st.currentSeat == seatIndex) {
        game.reactions[seatIndex] = null;
        return;
    }

    // 他人打牌阶段：放弃碰/杠/胡
    game.reactions[seatIndex] = null;

    // 还有人未响应则继续等待
    if (hasAnyReaction(game)) {
        return;
    }

    var ld = st.lastDiscard;
    if (ld) {
        var discarder = game.roomInfo.seats[ld.seat].userId;
        broadcastInGame(game, 'guo_notify_push', { userId: discarder, pai: TILE_TO_ID[ld.tile] }, discarder, true);
    }
    doDraw(game);
};

exports.guo = function (userId) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        return;
    }
    doGuo(seatData.game, seatData.seatIndex);
};

// ==================== AI 机器人 ====================
// 机器人约定：userId 为负数（-1000-座位号），bind 共享假 socket（isOnline=true、推送静默）
var BOT_SOCKET = {
    emit: function () {},
    disconnect: function () {}
};

function fillWithRobots(roomInfo) {
    for (var i = 0; i < roomInfo.seats.length; ++i) {
        var s = roomInfo.seats[i];
        if (s.userId < 0) {
            // 已入座的机器人：每局开局前重新置为准备（doGameOver 会清 ready）
            s.ready = true;
            // 防御：服务端重启后 bot socket 丢失，重新绑定定位与假 socket
            roomMgr.bindRobot(roomInfo.id, s.userId, i);
            userMgr.bind(s.userId, BOT_SOCKET);
            continue;
        }
        if (s.userId > 0) {
            continue;
        }
        s.userId = -1000 - i;
        s.name = "机器人" + (i + 1);
        s.score = 1000;
        s.ready = true;
        // 先登记定位（广播以 bot userId 定位房间），再广播入座通知
        // 入座广播直接按座位表直发：多房间机器人 userId 冲突时 userLocation 定位会发错房间
        roomMgr.bindRobot(roomInfo.id, s.userId, i);
        userMgr.bind(s.userId, BOT_SOCKET);
        var joinNotice = {
            userid: s.userId,
            ip: s.ip,
            score: s.score,
            name: s.name,
            online: true,
            ready: true,
            seatindex: i
        };
        for (var j = 0; j < roomInfo.seats.length; ++j) {
            var tu = roomInfo.seats[j].userId;
            if (tu != s.userId) {
                userMgr.sendMsg(tu, 'new_user_comes_push', joinNotice);
            }
        }
    }
}

function clearBotTimers(game) {
    if (!game.botTimers) {
        return;
    }
    for (var k in game.botTimers) {
        clearTimeout(game.botTimers[k]);
    }
    game.botTimers = {};
}

// 扫描所有 AI 座位，给需要行动的（有可操作反应 / 轮到出牌）排定时器
function scheduleBots(game) {
    if (!game.botTimers) {
        game.botTimers = {};
    }
    clearBotTimers(game);
    var st = game.state;
    if (!st || st.status != "playing") {
        return;
    }
    for (var i = 0; i < 4; ++i) {
        var userId = game.roomInfo.seats[i].userId;
        if (userId >= 0) {
            continue;
        }
        var need = false;
        var delay = 700 + Math.floor(Math.random() * 900);
        if (st.phase == "reaction" && game.reactions[i] && hasOperations(game.reactions[i])) {
            need = true;
        }
        else if (st.phase == "discard" && st.currentSeat == i) {
            need = true;
            delay = 800 + Math.floor(Math.random() * 1000);
        }
        if (need) {
            (function (si, d) {
                game.botTimers[si] = setTimeout(function () {
                    botAct(game, si);
                }, d);
            })(i, delay);
        }
    }
}

// AI 单步决策入口：整体异常保护——timer 回调抛异常会导致游戏死锁，兜底过牌并重新调度
function botAct(game, seatIndex) {
    try {
        botActInner(game, seatIndex);
    }
    catch (e) {
        console.error("[qingyang] botAct error seat=" + seatIndex + ":", e && e.stack || e);
        try {
            if (game && game.state && game.state.status == "playing") {
                var uid = game.roomInfo.seats[seatIndex].userId;
                if (uid != null && uid < 0) {
                    // 直调内部版：绕开 gameSeatsOfUsers（多房间机器人 userId 会互相覆盖）
                    doGuo(game, seatIndex);
                }
            }
        }
        catch (e2) {}
        try {
            scheduleBots(game);
        }
        catch (e3) {}
    }
}

// AI 单步决策：按当前相位分流（reaction：胡>杠/碰策略>过；discard：自摸胡>杠>智能出牌）
function botActInner(game, seatIndex) {
    if (game.botTimers) {
        delete game.botTimers[seatIndex];
    }
    var st = game ? game.state : null;
    if (!st || st.status != "playing") {
        return;
    }
    var userId = game.roomInfo.seats[seatIndex].userId;
    if (userId >= 0) {
        return;
    }
    var r = game.reactions[seatIndex];

    if (st.phase == "reaction") {
        if (!r || !hasOperations(r)) {
            return;
        }
        // 青阳规则：reaction 相位不允许胡（只能自摸），机器人只碰/杠/过
        var choice = null;
        try {
            choice = core.chooseBotReaction(st, seatIndex);
        }
        catch (e) {
            choice = null;
        }
        if (choice && choice.action == "gang" && r.canGang) {
            doGang(game, seatIndex, r.gangPai[0]);
            return;
        }
        if (choice && choice.action == "peng" && r.canPeng) {
            doPeng(game, seatIndex);
            return;
        }
        doGuo(game, seatIndex);
        return;
    }

    if (st.phase == "discard" && st.currentSeat == seatIndex) {
        if (r && hasOperations(r)) {
            if (r.canHu) {
                doHu(game, seatIndex);
                return;
            }
            if (r.canGang) {
                // 缺一门模式下用 core 的安全杠决策过滤：弯杠放行，暗杠若把整门
                // 锁进副露造成三门僵局（或杠的是缺门）则放弃，直接出牌。
                var botGangTile = null;
                if (st.mustLackOneSuit) {
                    try {
                        botGangTile = core.chooseBotGangTile(st, seatIndex);
                    }
                    catch (e) {
                        botGangTile = null;
                    }
                }
                if (!st.mustLackOneSuit || botGangTile) {
                    doGang(game, seatIndex, st.mustLackOneSuit ? TILE_TO_ID[botGangTile] : r.gangPai[0]);
                    return;
                }
            }
        }
        var player = st.players[seatIndex];
        var idx = -1;
        try {
            // 传入缺一门规则：机器人优先打缺门花色（否则 lackBonus 恒为 0，感知不到打缺）
            idx = core.chooseBotDiscardIndex(player, st.laiziTile, {
                mustLackOneSuit: st.mustLackOneSuit,
                ruleConfig: st.ruleConfig
            });
        }
        catch (e) {
            idx = -1;
        }
        if (idx == null || idx < 0 || idx >= player.hand.length) {
            idx = 0;
        }
        doChuPai(game, seatIndex, TILE_TO_ID[player.hand[idx]]);
    }
}

// ==================== 开始新的一局 ====================
exports.begin = function (roomId) {
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return;
    }
    var seats = roomInfo.seats;

    var game = {
        conf: roomInfo.conf,
        roomInfo: roomInfo,
        gameIndex: roomInfo.numOfGames,
        button: roomInfo.nextButton,
        state: null,
        reactions: [null, null, null, null],
        firstHupai: -1,
        actionList: [],
        drawTimer: null,
        lastActivity: Date.now()
    };

    // 合并建房时勾选的规则；老房间 conf.rules 为空时回退默认规则
    var ruleConfig = core.normalizeRuleConfig({
        multiplier: roomInfo.conf.baseScore || 5,
        rules: roomInfo.conf.rules || null
    });
    // 缺一门：默认开启，建房时取消勾选(rules.queYimen === false)则关闭
    var mustLackOne = !(roomInfo.conf.rules != null && roomInfo.conf.rules.queYimen === false);

    var playerNames = [];
    var beanBalances = [];
    for (var i = 0; i < 4; ++i) {
        playerNames.push(seats[i].name || ("玩家" + (i + 1)));
        beanBalances.push(seats[i].score || 0);
    }

    game.ruleConfig = ruleConfig;
    game.state = core.startRound({
        dealerSeat: game.button,
        seed: Date.now(),
        playerNames: playerNames,
        beanBalances: beanBalances,
        mustLackOneSuit: mustLackOne,
        ruleConfig: ruleConfig
    });
    var st = game.state;

    for (var i = 0; i < 4; ++i) {
        var data = {
            game: game,
            seatIndex: i,
            userId: seats[i].userId
        };
        gameSeatsOfUsers[data.userId] = data;
    }

    games[roomId] = game;
    roomInfo.numOfGames++;

    // 开局即存档（原版时机）：base_info 快照此时为开局 13 张手牌
    store_game(game);

    for (var i = 0; i < seats.length; ++i) {
        var s = seats[i];
        // 通知手牌（core 已按赖子最左理牌，客户端直接按此顺序显示）
        userMgr.sendMsg(s.userId, 'game_holds_push', tilesToIds(st.players[i].hand));
        // 通知剩余牌数
        userMgr.sendMsg(s.userId, 'mj_count_push', getDrawableCount(st));
        // 通知局数
        userMgr.sendMsg(s.userId, 'game_num_push', roomInfo.numOfGames);
        // 通知当前圈数（已完成圈数+1）
        userMgr.sendMsg(s.userId, 'game_quan_push', (roomInfo.numOfQuans || 0) + 1);
        // 通知游戏开始（data 必须是数字 button）
        userMgr.sendMsg(s.userId, 'game_begin_push', game.button);
        // 赖子信息（新事件，旧客户端自动忽略）
        userMgr.sendMsg(s.userId, 'game_laizi_push', {
            indicator: TILE_TO_ID[st.indicatorTile],
            laizi: TILE_TO_ID[st.laiziTile]
        });
    }

    // 直接进入打牌阶段（无换三张/定缺）
    // 修复：broacastInRoom 依赖 sender 反查房间，sender=null 时直接 return，
    // 导致 game_playing_push 从未发出，客户端 gamestate 卡在 begin，中间轮盘不显示
    broadcastInGame(game, 'game_playing_push', null, null, true);

    var dealerUser = seats[game.button].userId;
    broadcastInGame(game, 'game_chupai_push', dealerUser, dealerUser, true);
    refreshReaction(game, game.button, -1);
    sendOperations(game, game.button, -1);

    // AI 座位自动行动（庄家是 AI 时自动出牌）
    armWatchdog();
    scheduleBots(game);
};

// ==================== 断线重连同步 ====================
exports.setReady = function (userId, callback) {
    var roomId = roomMgr.getUserRoom(userId);
    if (roomId == null) {
        return;
    }
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return;
    }
    // 解散流程已触发的房间不再接受准备/开新局（forceEnd 结算到房间销毁有 1.5s 窗口）
    if (roomInfo._dissolving) {
        return;
    }

    roomMgr.setReady(userId, true);

    var game = games[roomId];
    if (game == null) {
        // 开启 AI 时补机器人入座并置为准备（第二局起 doGameOver 会清 ready，需重置）
        if (roomInfo.conf.robots) {
            fillWithRobots(roomInfo);
        }
        if (roomInfo.seats.length == 4) {
            for (var i = 0; i < roomInfo.seats.length; ++i) {
                var s = roomInfo.seats[i];
                if (s.ready == false || userMgr.isOnline(s.userId) == false) {
                    return;
                }
            }
            // 4 人到齐且都准备好了，开始新的一局
            exports.begin(roomId);
        }
    }
    else {
        var st = game.state;
        var data = {
            state: "playing",
            numofmj: getDrawableCount(st),
            button: game.button,
            turn: st.currentSeat,
            chuPai: st.lastDiscard ? TILE_TO_ID[st.lastDiscard.tile] : -1,
            huanpaimethod: -1,
            // 赖子信息（断线重连时客户端左上角显示）
            laizi: st.laiziTile != null ? TILE_TO_ID[st.laiziTile] : -1,
            laiziIndicator: st.indicatorTile != null ? TILE_TO_ID[st.indicatorTile] : -1
        };

        data.seats = [];
        for (var i = 0; i < 4; ++i) {
            var sp = st.players[i];
            var mc = meldsToClient(sp.melds);
            var sd = {
                userid: roomInfo.seats[i].userId,
                folds: tilesToIds(sp.discards),
                angangs: mc.angangs,
                diangangs: mc.diangangs,
                wangangs: mc.wangangs,
                pengs: mc.pengs,
                que: -1,
                hued: false,
                iszimo: false
            };
            if (roomInfo.seats[i].userId == userId) {
                sd.holds = tilesToIds(sp.hand);
            }
            data.seats.push(sd);
        }

        userMgr.sendMsg(userId, 'game_sync_push', data);

        // 重建各座位反应并推送待操作提示
        for (var i = 0; i < 4; ++i) {
            if (roomInfo.seats[i].userId > 0) {
                refreshReaction(game, i, data.chuPai);
            }
        }
    }
};

// ==================== 结束一局 ====================
function constructGameBaseInfo(game) {
    // 存档（原版格式）：回放所需的开局快照，game_seats 为每人初始 13 张手牌
    // （客户端 prepareReplay 用它初始化 holds，再由 action_records 从头重放摸牌/出牌）
    var st = game.state;
    var baseInfo = {
        type: "qingyang",
        button: game.button,
        index: game.gameIndex,
        game_seats: []
    };
    for (var i = 0; i < 4; ++i) {
        baseInfo.game_seats.push(tilesToIds(st.players[i].hand));
    }
    return JSON.stringify(baseInfo);
}

function store_game(game, callback) {
    var baseinfo = constructGameBaseInfo(game);
    db.create_game(game.roomInfo.uuid, game.gameIndex, baseinfo, callback);
}

function store_single_history(userId, history) {
    db.get_user_history(userId, function (data) {
        if (data == null) {
            data = [];
        }
        while (data.length >= 10) {
            data.shift();
        }
        data.push(history);
        db.update_user_history(userId, data);
    });
}

function store_history(roomInfo) {
    var seats = roomInfo.seats;
    var history = {
        uuid: roomInfo.uuid,
        id: roomInfo.id,
        time: roomInfo.createTime,
        seats: new Array(4)
    };

    for (var i = 0; i < seats.length; ++i) {
        var rs = seats[i];
        var hs = history.seats[i] = {};
        hs.userid = rs.userId;
        hs.name = crypto.toBase64(rs.name);
        hs.score = rs.score;
    }

    for (var i = 0; i < seats.length; ++i) {
        var s = seats[i];
        if (s.userId == null || s.userId < 0) continue; // AI 座位不存历史
        store_single_history(s.userId, history);
    }
}

function doGameOver(game, userId, forceEnd, huTileOverride) {
    // 房间定位优先用 game：AI 的 userId 在多房间下会被 roomMgr.userLocation 错误覆盖，
    // 反查会定位到别人的房间导致结算/踢人/销房全错；game 为空（未开局解散）才回退 userId 反查
    var roomId = (game != null && game.roomInfo != null) ? game.roomInfo.id : roomMgr.getUserRoom(userId);
    if (roomId == null) {
        return;
    }
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return;
    }

    var results = [];
    var dbresult = [0, 0, 0, 0];

    var fnNoticeResult = function (isEnd) {
        var endinfo = null;
        if (isEnd) {
            endinfo = [];
            for (var i = 0; i < roomInfo.seats.length; ++i) {
                var rs = roomInfo.seats[i];
                endinfo.push({
                    delta: rs.score - 1000, // 相对起始积分的正负变化
                    numangang: rs.numAnGang,
                    numminggang: rs.numMingGang,
                    numchadajiao: 0,
                    numxiaokai: rs.numXiaoKai,
                    numendou: rs.numEnDou,
                    numpaofeng: rs.numPaoFeng,
                    numduiduihu: rs.numDuiDuiHu,
                    numqixiaodui: rs.numQiXiaoDui,
                    numquanqiu: rs.numQuanQiu,
                    numsixi: rs.numSiXi,
                    numgenfa: rs.numGenFa,
                    numwangang: rs.numWanGang,
                    numzhigang: rs.numZhiGang
                });
            }
        }
        broadcastInGame(game, 'game_over_push', { results: results, endinfo: endinfo }, userId, true);
        if (isEnd) {
            setTimeout(function () {
                store_history(roomInfo); // 青阳含 1 圈房，统一写入历史
                userMgr.kickAllInRoom(roomId);
                roomMgr.destroy(roomId);
                db.archive_games(roomInfo.uuid);
            }, 1500);
        }
    };

    if (game != null) {
        var st = game.state;
        var settlement = st.settlement;
        // 胡牌：优先用调用方显式传入（点炮场景 lastDraw 已被清空，结算内部取不到）
        var huTile = huTileOverride != null ? huTileOverride : null;
        if (huTile == null && settlement && settlement.winDetail) {
            huTile = settlement.winDetail.drawnTile || null;
        }
        if (huTile == null && st.lastDraw && st.winnerSeat != null) {
            huTile = st.lastDraw.tile;
        }

        for (var i = 0; i < roomInfo.seats.length; ++i) {
            var rs = roomInfo.seats[i];
            var sp = st.players[i];

            rs.ready = false;

            var delta = settlement ? settlement.deltas[i] : 0;
            rs.score += delta;

            // 胡牌统计：青阳只能自摸，无接炮/点炮概念
            var isWinner = st.winnerSeat === i && settlement != null;

            // 胡牌牌型统计：恩豆/小开/跑风/七对按基础型；对对胡/全球独钓/四喜按附加项
            if (isWinner && settlement != null && settlement.winDetail != null) {
                var wd = settlement.winDetail;
                if (wd.baseType == "enDou") {
                    rs.numEnDou += 1;
                }
                else if (wd.baseType == "xiaoKai") {
                    rs.numXiaoKai += 1;
                }
                else if (wd.baseType == "paoFeng1" || wd.baseType == "paoFeng2") {
                    rs.numPaoFeng += 1;
                }
                else if (wd.baseType == "qiXiaoDui") {
                    rs.numQiXiaoDui += 1;
                }
                var bonuses = wd.bonuses || [];
                for (var b = 0; b < bonuses.length; ++b) {
                    if (bonuses[b].key == "duiDuiHu") {
                        rs.numDuiDuiHu += 1;
                    }
                    else if (bonuses[b].key == "quanQiuDuDiao") {
                        rs.numQuanQiu += 1;
                    }
                    else if (bonuses[b].key == "siXi") {
                        rs.numSiXi += 1;
                    }
                    else if (bonuses[b].key == "wanGang") {
                        rs.numWanGang += 1; // 杠上开胡非跑风
                    }
                    else if (bonuses[b].key == "zhiGang") {
                        rs.numZhiGang += 1; // 杠上开胡且跑风
                    }
                }
            }

            // 跟打惩罚统计：四家连打同一张，首个打牌者受罚
            var stLog = st.log || [];
            for (var li = 0; li < stLog.length; ++li) {
                if (stLog[li].type == "streakPenalty" && stLog[li].payerSeat === i) {
                    rs.numGenFa += 1;
                }
            }

            // 杠动作统计（青阳"弯杠/直杠"是胡牌附加型，已在 bonuses 中判定：
            // 弯杠=杠上开胡非跑风，直杠=杠上开胡且跑风；这里只数动作次数）
            var numGangs = 0;
            for (var m = 0; m < sp.melds.length; ++m) {
                var mt = sp.melds[m].type;
                if (mt == "anGang") {
                    rs.numAnGang += 1;
                    numGangs++;
                }
                else if (mt == "mingGang" || mt == "buGang") {
                    rs.numMingGang += 1;
                    numGangs++;
                }
            }

            // 手牌：赢家把胡牌放到末尾（客户端 pop 最后一张作为胡牌展示）
            var holds = tilesToIds(sp.hand);
            var huId = -1;
            if (isWinner && huTile != null) {
                huId = TILE_TO_ID[huTile];
                var hi = holds.indexOf(huId);
                if (hi != -1) {
                    holds.splice(hi, 1);
                }
                holds.push(huId);
            }

            var mc = meldsToClient(sp.melds);
            var userRT = {
                userId: rs.userId,
                pengs: mc.pengs,
                actions: [],
                wangangs: mc.wangangs,
                diangangs: mc.diangangs,
                angangs: mc.angangs,
                numofgen: numGangs,
                holds: holds,
                dingque: -1,
                huinfo: [],
                fan: isWinner && settlement ? settlement.totalZi : 0,
                score: delta,
                totalscore: rs.score,
                qingyise: false,
                pattern: "",
                isganghu: false,
                menqing: false,
                zhongzhang: false,
                jingouhu: false,
                haidihu: false,
                tianhu: false,
                dihu: false,
                huorder: isWinner ? 0 : -1
            };

            // 青阳结算明细：胡型/附加分/头家加成（客户端结算面板用）
            userRT.isZimo = isWinner ? isZimoWin(game, st) : false;
            userRT.winDetail = (isWinner && settlement && settlement.winDetail) ? {
                baseType: settlement.winDetail.baseType,
                baseZi: settlement.winDetail.baseZi,
                bonusZi: settlement.winDetail.bonusZi,
                totalZi: settlement.winDetail.totalZi,
                headBonusZi: settlement.winDetail.headBonusZi,
                bonuses: settlement.winDetail.bonuses
            } : null;

            // 动作记录（客户端结算面板按 type 渲染图标）
            for (var m = 0; m < sp.melds.length; ++m) {
                var mt = sp.melds[m].type;
                if (mt == "peng") continue;
                userRT.actions.push({ type: mt == "mingGang" ? "diangang" : (mt == "anGang" ? "angang" : "wangang") });
            }
            if (isWinner) {
                var zimoWin = isZimoWin(game, st);
                userRT.actions.push({ type: zimoWin ? "zimo" : "hu" });
                // 客户端结算面板（onGameOver_XLCH）遍历 huinfo 渲染胡牌详情
                var wd = settlement ? settlement.winDetail : null;
                var patternLabel = "";
                if (wd && wd.isQiXiaoDui) {
                    patternLabel = "7pairs";
                }
                else if (wd && wd.bonuses) {
                    for (var b = 0; b < wd.bonuses.length; ++b) {
                        if (wd.bonuses[b].key == "duiDuiHu") { patternLabel = "duidui"; break; }
                    }
                }
                userRT.huinfo.push({
                    ishupai: true,
                    pai: huId,
                    action: zimoWin ? "zimo" : "hu",
                    pattern: patternLabel,
                    fan: settlement ? settlement.totalZi : 0,
                    numofgen: numGangs,
                    haidihu: false,
                    tianhu: false,
                    dihu: false
                });
            }

            results.push(userRT);
            dbresult[i] = delta;
            delete gameSeatsOfUsers[rs.userId];
        }
        delete games[roomId];
        if (game.drawTimer) {
            clearTimeout(game.drawTimer);
            game.drawTimer = null;
        }
        clearBotTimers(game);

        // 下一局庄家（胡牌/流局均已由 core 计算好）
        // 圈数制：庄家开牌(胡)则连庄不轮转；非连庄轮转回到本圈起始庄(0号位)即完成一圈
        var old = roomInfo.nextButton;
        if (st.nextDealerSeat != null) {
            roomInfo.nextButton = st.nextDealerSeat;
        }
        if (old !== roomInfo.nextButton && roomInfo.nextButton === 0) {
            roomInfo.numOfQuans = (roomInfo.numOfQuans || 0) + 1;
        }
        if (old != roomInfo.nextButton) {
            db.update_next_button(roomId, roomInfo.nextButton);
        }
    }

    if (forceEnd || game == null) {
        fnNoticeResult(true);
    }
    else {
        // 局结束：开局时已 create_game 存档，这里只更新结果与动作记录
        db.update_game_result(roomInfo.uuid, game.gameIndex, dbresult);
        // 记录打牌信息
        var str = JSON.stringify(game.actionList);
        db.update_game_action_records(roomInfo.uuid, game.gameIndex, str);
        // 保存游戏局数
        db.update_num_of_turns(roomId, roomInfo.numOfGames);

        // 如果是第一次，并且不是强制解散 则扣除房卡（座位0是 AI 时改扣房主；机器人局免房卡）
        if (roomInfo.numOfGames == 1 && !(roomInfo.conf.robots)) {
            var cost = 2;
            if (roomInfo.conf.maxGames >= 4) {
                cost = 3;
            }
            var payUser = roomInfo.seats[0].userId;
            if (payUser < 0) {
                payUser = roomInfo.conf.creator;
            }
            db.cost_gems(payUser, cost);
        }

        // 圈数制：maxGames 复用为圈数上限，打满 N 圈结束（N 圈 = 庄家轮转 N 个来回，连庄局不计圈）
        var isEnd = ((roomInfo.numOfQuans || 0) >= roomInfo.conf.maxGames);
        fnNoticeResult(isEnd);
    }
}

function isZimoWin(game, st) {
    // 自摸：胡牌来自 lastDraw（点炮时胡牌来自 lastDiscard，finishWin 不清 lastDiscard）
    return st.lastDiscard == null || (st.lastDraw != null && st.lastDraw.tile != null && st.settlement != null && st.winnerSeat != null && st.lastDiscard.seat !== st.winnerSeat);
}

// ==================== 解散相关 ====================
exports.isPlaying = function (userId) {
    var seatData = gameSeatsOfUsers[userId];
    if (seatData == null) {
        return false;
    }
    var st = seatData.game.state;
    if (st.status == "ended") {
        return false;
    }
    return true;
};

exports.hasBegan = function (roomId) {
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return false;
    }
    return roomInfo.numOfGames > 0;
};

exports.doDissolve = function (roomId) {
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null || roomInfo._dissolving) {
        return null;
    }
    // 幂等保护：标记解散中，防止重复触发 doGameOver（广播风暴）
    roomInfo._dissolving = true;
    // 清空投票状态，断掉 dissolveAgree 的循环入口
    roomInfo.dr = null;

    var game = games[roomId];
    doGameOver(game, roomInfo.seats[0].userId, true);
};

exports.dissolveRequest = function (roomId, userId) {
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return null;
    }

    if (roomInfo.dr != null) {
        return null;
    }

    var seatIndex = roomMgr.getUserSeat(userId);
    if (seatIndex == null) {
        return null;
    }

    roomInfo.dr = {
        endTime: Date.now() + 30000,
        states: [false, false, false, false]
    };
    roomInfo.dr.states[seatIndex] = true;

    // 机器人自动同意解散：人机房无需等待机器人投票
    for (var i = 0; i < roomInfo.seats.length; ++i) {
        if (roomInfo.seats[i].userId < 0) {
            roomInfo.dr.states[i] = true;
        }
    }

    dissolvingList.push(roomId);

    return roomInfo;
};

exports.dissolveAgree = function (roomId, userId, agree) {
    var roomInfo = roomMgr.getRoom(roomId);
    if (roomInfo == null) {
        return null;
    }

    if (roomInfo.dr == null) {
        return null;
    }

    var seatIndex = roomMgr.getUserSeat(userId);
    if (seatIndex == null) {
        return null;
    }

    if (agree) {
        roomInfo.dr.states[seatIndex] = true;
    }
    else {
        roomInfo.dr = null;
        var idx = dissolvingList.indexOf(roomId);
        if (idx != -1) {
            dissolvingList.splice(idx, 1);
        }
    }
    return roomInfo;
};

function update() {
    for (var i = dissolvingList.length - 1; i >= 0; --i) {
        var roomId = dissolvingList[i];

        var roomInfo = roomMgr.getRoom(roomId);
        if (roomInfo != null && roomInfo.dr != null) {
            if (Date.now() > roomInfo.dr.endTime) {
                console.log("delete room and games");
                exports.doDissolve(roomId);
                dissolvingList.splice(i, 1);
            }
        }
        else {
            dissolvingList.splice(i, 1);
        }
    }
}

setInterval(update, 1000);

// 青阳麻将无换三张/定缺阶段，保留空实现以兼容 socket 分发
exports.dingQue = function (userId, que) {
};

exports.huanSanZhang = function (userId, p1, p2, p3) {
};
