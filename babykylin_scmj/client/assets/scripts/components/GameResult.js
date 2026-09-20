cc.Class({
    extends: cc.Component,

    properties: {
        _gameresult:null,
        _seats:[],
        // 统计面板：11 项（两列×6行），[显示文案, endinfo字段名]（青阳只能自摸，无自摸/接炮/点炮项）
        _statDefs: {
            default: [
                ["暗杠", "numangang"], ["弯杠", "numwangang"], ["直杠", "numzhigang"],
                ["跟打", "numgenfa"], ["小开", "numxiaokai"], ["恩豆", "numendou"],
                ["跑风", "numpaofeng"], ["对对胡", "numduiduihu"], ["七对", "numqixiaodui"],
                ["独钓", "numquanqiu"], ["四喜", "numsixi"],
            ],
            visible: false,
        },
        _statRows: {
            default: [],
            visible: false,
        },
    },

    // use this for initialization
    onLoad: function () {
        if(cc.vv == null){
            return;
        }

        this._gameresult = this.node.getChildByName("game_result");
        //this._gameresult.active = false;

        var seats = this._gameresult.getChildByName("seats");
        for(var i = 0; i < seats.children.length; ++i){
            this._seats.push(seats.children[i].getComponent("Seat"));
        }

        this.setupStatsLayout();

        var btnClose = cc.find("Canvas/game_result/btnClose");
        if(btnClose){
            cc.vv.utils.addClickEvent(btnClose,this.node,"GameResult","onBtnCloseClicked");
        }

        var btnShare = cc.find("Canvas/game_result/btnShare");
        if(btnShare){
            cc.vv.utils.addClickEvent(btnShare,this.node,"GameResult","onBtnShareClicked");
        }

        //初始化网络事件监听器
        var self = this;
        this.node.on('game_end',function(data){self.onGameEnd(data);});
    },

    // 统计区改造：隐藏场景里旧的 6 行标签/值节点，用第一个标签做模板
    // 动态生成两列×7行（字号20），行距在原 6 行区间内等分，不超出座位卡
    setupStatsLayout: function () {
        // 兜底：cc.Class default 嵌套数组在某些实例化路径下会被置空，强制恢复
        if (!this._statDefs || this._statDefs.length === 0) {
            this._statDefs = [
                ["暗杠", "numangang"], ["弯杠", "numwangang"], ["直杠", "numzhigang"],
                ["跟打", "numgenfa"], ["小开", "numxiaokai"], ["恩豆", "numendou"],
                ["跑风", "numpaofeng"], ["对对胡", "numduiduihu"], ["七对", "numqixiaodui"],
                ["独钓", "numquanqiu"], ["四喜", "numsixi"],
            ];
        }
        this._statRows = [];
        var oldNames = ["zimocishu","jiepaocishu","dianpaocishu","angangcishu","minggangcishu","chajiaocishu"];
        for (var s = 0; s < this._seats.length; ++s) {
            var seatNode = this._seats[s].node;
            for (var n = 0; n < oldNames.length; ++n) {
                var oldV = seatNode.getChildByName(oldNames[n]);
                if (oldV != null) {
                    oldV.active = false;
                }
            }
            var rows = [];
            var labels = seatNode.getChildByName("labels");
            if (labels != null && labels.children.length > 0) {
                var tpl = labels.children[0];
                var minY = tpl.y, maxY = tpl.y;
                for (var c = 1; c < labels.children.length; ++c) {
                    var cy = labels.children[c].y;
                    if (cy < minY) { minY = cy; }
                    if (cy > maxY) { maxY = cy; }
                }
                var topY = maxY;
                var rowsPerCol = 6;
                var dy = (labels.children.length > 1 && maxY - minY >= 40) ? (maxY - minY) / (rowsPerCol - 1) : 36;
                var baseX = tpl.x;
                var colGap = 128;
                var created = [];
                for (var r = 0; r < this._statDefs.length; ++r) {
                    var col = r < rowsPerCol ? 0 : 1;
                    var row = r % rowsPerCol;
                    var node = cc.instantiate(tpl);
                    node.x = baseX + col * colGap;
                    node.y = topY - row * dy;
                    labels.addChild(node);
                    var lb = node.getComponent(cc.Label);
                    lb.fontSize = 20;
                    lb.string = this._statDefs[r][0] + "  0";
                    created.push(lb);
                }
                // 隐藏旧的 6 个标签（克隆件追加在尾部，前 6 个仍是旧节点）
                for (var c2 = 0; c2 < 6 && c2 < labels.children.length; ++c2) {
                    labels.children[c2].active = false;
                }
                rows = created;
            }
            this._statRows.push(rows);
        }
    },

    showResult:function(seat,info,idx){
        seat.node.getChildByName("zuijiapaoshou").active = false; // 青阳只能自摸，无"最佳炮手"

        var rows = this._statRows != null ? this._statRows[idx] : null;
        if(rows == null || rows.length != this._statDefs.length){
            return; // 动态布局未就绪时跳过（旧统计节点已隐藏）
        }
        for(var r = 0; r < rows.length; ++r){
            var d = this._statDefs[r];
            var v = info[d[1]] != null ? info[d[1]] : 0;
            rows[r].string = d[0] + "  " + v;
        }
    },

    onGameEnd:function(endinfo){
        var seats = cc.vv.gameNetMgr.seats;
        // 起始积分 1000，按 delta（相对起始积分的变化）展示正负值
        var maxdelta = -Infinity;
        for(var i = 0; i < seats.length; ++i){
            var d = endinfo[i].delta != null ? endinfo[i].delta : 0;
            if(d > maxdelta){
                maxdelta = d;
            }
        }

        for(var i = 0; i < seats.length; ++i){
            var seat = seats[i];
            var delta = endinfo[i].delta != null ? endinfo[i].delta : 0;
            var isBigwin = delta > 0 && delta == maxdelta;
            // 起始 1000，正负分展示：正数带 + 号，负数自带 - 号
            this._seats[i].setInfo(seat.name, delta > 0 ? "+" + delta : delta, isBigwin);
            this._seats[i].setID(seat.userid);
            this.showResult(this._seats[i],endinfo[i],i);
        }
    },

    onBtnCloseClicked:function(){
        cc.vv.wc.show('正在返回游戏大厅');
        cc.director.loadScene("hall");
    },

    onBtnShareClicked:function(){
        cc.vv.anysdkMgr.shareResult();
    }
});
