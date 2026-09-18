cc.Class({
    extends: cc.Component,

    properties: {
        _leixingxuanze: null,
        _gamelist: null,
        _currentGame: null,
        _qingyangRules: null,
        _qingyangChecks: null,
        _qingyangRobotCheck: null,
        _createroomAtlas: null,
        _beilvPos: null,
    },

    // use this for initialization
    onLoad: function () {

        this._gamelist = this.node.getChildByName('game_list');

        this._leixingxuanze = [];
        var t = this.node.getChildByName("leixingxuanze");
        for (var i = 0; i < t.childrenCount; ++i) {
            var n = t.children[i].getComponent("RadioButton");
            if (n != null) {
                this._leixingxuanze.push(n);
            }
        }

        this.setupQingyangUI();

        // 加载创建房间图集，用于“青阳平胡”页签标题与“倍率”“玩法”行标签字图
        var self = this;
        cc.loader.loadRes("textures/images/createroom", cc.SpriteAtlas, function (err, atlas) {
            if (err == null && atlas != null) {
                self._createroomAtlas = atlas;
                self.applyQingyangAtlas();
            }
            else {
                console.log("load createroom atlas failed:" + err);
                self.applyQingyangTextFallback();
            }
        });
    },

    // 青阳麻将建房界面：页签“青阳平胡” + 局数/倍率/14项规则开关(含缺一门)/添加机器人
    setupQingyangUI: function () {
        try {
            var t = this.node.getChildByName("leixingxuanze");
            if (t == null || this._gamelist == null) {
                return;
            }
            // 已初始化过则不重复
            if (this._gamelist.getChildByName("qingyang") != null) {
                return;
            }
            var radios = this._leixingxuanze;
            if (radios.length < 2) {
                return;
            }

            // 1. 克隆最后一个玩法页签作为“青阳平胡”
            //    页签标题改用图集里的“青阳平胡”字图(creatroom13)，异步加载后设置
            var last = radios[radios.length - 1];
            var prev = radios[radios.length - 2];
            var opt = cc.instantiate(last.node);
            opt.name = "qingyang_opt";
            opt.x = last.node.x + (last.node.x - prev.node.x);
            opt.y = last.node.y + (last.node.y - prev.node.y);
            t.addChild(opt);
            var rb = opt.getComponent("RadioButton");
            rb.checked = false;
            // 先清掉克隆来的“血流成河”标题字图，等图集加载完成再换成“青阳平胡”
            var titleNode = opt.getChildByName("title");
            if (titleNode != null) {
                var titleSpr = titleNode.getComponent(cc.Sprite);
                if (titleSpr != null) {
                    titleSpr.spriteFrame = null;
                }
            }
            rb.refresh();
            this._leixingxuanze.push(rb);

            // 2. 克隆 xlch 面板作为 qingyang 面板，再逐行改成青阳设置
            var xlchPanel = this._gamelist.getChildByName("xlch");
            if (xlchPanel == null) {
                return;
            }
            var panel = cc.instantiate(xlchPanel);
            panel.name = "qingyang";
            panel.active = false;
            this._gamelist.addChild(panel);

            var hideRow = function (name) {
                var n = panel.getChildByName(name);
                if (n != null) {
                    n.active = false;
                }
            };
            hideRow("dianganghua");
            hideRow("zimojiacheng");
            hideRow("zuidafanshu");
            hideRow("wanfaxuanze");

            // 圈数行：1圈/2圈/4圈（圈数制：庄家开牌连庄，非连庄轮转回起始庄算一圈）
            var jushuRow = panel.getChildByName("xuanzejushu");
            if (jushuRow != null) {
                jushuRow.active = true;
                jushuRow.setPosition(-442, 147);
                var quanTexts = ["1圈", "2圈", "4圈"];
                // prefab 只有 2 个单选按钮，不足 3 个时克隆最后一个补齐（沿用玩法页签克隆模式）
                var radios = [];
                for (var j = 0; j < jushuRow.childrenCount; ++j) {
                    if (jushuRow.children[j].getComponent("RadioButton") != null) {
                        radios.push(jushuRow.children[j]);
                    }
                }
                while (radios.length < quanTexts.length) {
                    var prev2 = radios[radios.length - 2];
                    var proto = radios[radios.length - 1];
                    var cp = cc.instantiate(proto);
                    cp.x = proto.x + (prev2 != null ? (proto.x - prev2.x) : 150);
                    jushuRow.addChild(cp);
                    radios.push(cp);
                }
                var qi = 0;
                for (var j = 0; j < jushuRow.childrenCount; ++j) {
                    var qn = jushuRow.children[j];
                    if (qn.getComponent("RadioButton") == null) {
                        continue;
                    }
                    if (qi < quanTexts.length) {
                        qn.active = true;
                        this.setOptionText(qn, quanTexts[qi]);
                    }
                    else {
                        qn.active = false;
                    }
                    qi++;
                }
                this.setRadioDefaults(jushuRow, 0);
                // 行标签改为“圈数”
                var jLbl = jushuRow.getChildByName("New Label");
                if (jLbl != null) {
                    this.setOptionText(jLbl, "圈数");
                }
            }

            // 倍率行：5分/10分，默认5分（difen 索引 0→5分 1→10分）
            var difenRow = panel.getChildByName("difenxuanze");
            if (difenRow != null) {
                difenRow.active = true;
                difenRow.setPosition(-442, 85);
                var difenTexts = ["5分", "10分"];
                var di = 0;
                for (var j = 0; j < difenRow.childrenCount; ++j) {
                    var dn = difenRow.children[j];
                    if (dn.getComponent("RadioButton") == null) {
                        continue;
                    }
                    if (di < difenTexts.length) {
                        dn.active = true;
                        this.setOptionText(dn, difenTexts[di]);
                    }
                    else {
                        dn.active = false;
                    }
                    di++;
                }
                this.setRadioDefaults(difenRow, 0);
                // “底分选择”文字节点先隐藏，等图集加载完成后换成“倍率”字图
                var oldLbl = difenRow.getChildByName("New Label");
                if (oldLbl != null) {
                    this._beilvPos = cc.v2(oldLbl.x, oldLbl.y);
                    oldLbl.active = false;
                }
            }

            // 3. 规则开关区：克隆 CheckBox 摆 4 行（14项规则含缺一门 + 添加机器人），左侧“玩法”字标签
            this._qingyangRules = [];
            this._qingyangChecks = [];
            this._qingyangRobotCheck = null;
            var wfxz = panel.getChildByName("wanfaxuanze");
            var tpl = null;
            if (wfxz != null) {
                for (var k = 0; k < wfxz.childrenCount; ++k) {
                    if (wfxz.children[k].getComponent("CheckBox") != null) {
                        tpl = wfxz.children[k];
                        break;
                    }
                }
            }
            if (tpl != null) {
                var cols = [-410, -160, 90, 340];
                // 行距60与背景横线节奏一致：每行居中于两线之间（线在 y=0,±60,±120...）
                var rowY = [30, -30, -90, -150];
                var ruleLayout = [
                    ["qiXiaoDui", "七小对", 0, 0],
                    ["duiDuiHu", "对对胡", 0, 1],
                    ["quanQiuDuDiao", "全球独钓", 0, 2],
                    ["queYimen", "缺一门", 0, 3],
                    ["enDou", "恩豆", 1, 0],
                    ["xiaoKai", "小开", 1, 1],
                    ["siXi", "四喜", 1, 2],
                    ["paoFeng1", "1跑", 1, 3],
                    ["paoFeng2", "2跑", 2, 0],
                    ["windArrowBonus", "风箭附加", 2, 1],
                    ["wanGang", "弯杠", 2, 2],
                    ["zhiGang", "直杠", 2, 3],
                    ["headBonus", "头家加成", 3, 0],
                    ["streakPenalty", "连打惩罚", 3, 1],
                ];
                for (var r = 0; r < ruleLayout.length; ++r) {
                    var item = ruleLayout[r];
                    var rNode = cc.instantiate(tpl);
                    rNode.setPosition(cols[item[3]], rowY[item[2]]);
                    panel.addChild(rNode);
                    var cb = rNode.getComponent("CheckBox");
                    cb.checked = true;
                    cb.refresh();
                    this.setOptionText(rNode, item[1]);
                    this._qingyangRules.push(item[0]);
                    this._qingyangChecks.push(cb);
                }
                var robotNode = cc.instantiate(tpl);
                robotNode.setPosition(cols[2], rowY[3]);
                panel.addChild(robotNode);
                var robotCb = robotNode.getComponent("CheckBox");
                robotCb.checked = true;
                robotCb.refresh();
                this.setOptionText(robotNode, "添加机器人");
                this._qingyangRobotCheck = robotCb;
            }
            else {
                console.log("setupQingyangUI: no checkbox template");
            }

            // 默认选中“青阳平胡”页签：显式互斥所有页签
            // （克隆页签的 onLoad 可能延迟注册进 radiogroupmgr，只调 check(rb) 清不掉旧页签的选中态）
            for (var s = 0; s < this._leixingxuanze.length; ++s) {
                var sr = this._leixingxuanze[s];
                var want = (sr === rb);
                if (sr.checked != want) {
                    sr.checked = want;
                    sr.refresh();
                }
            }
            if (cc.vv != null && cc.vv.radiogroupmgr != null) {
                cc.vv.radiogroupmgr.check(rb);
            }
        }
        catch (e) {
            console.log("setupQingyangUI failed:" + e.message);
        }
    },

    // 图集加载完成后：把“青阳平胡”页签标题、“倍率”“玩法”行标签设置为图集中的字图
    applyQingyangAtlas: function () {
        var atlas = this._createroomAtlas;
        if (atlas == null) {
            return;
        }
        var lz = this.node.getChildByName("leixingxuanze");
        var opt = lz != null ? lz.getChildByName("qingyang_opt") : null;
        if (opt != null) {
            var titleNode = opt.getChildByName("title");
            var titleSpr = titleNode != null ? titleNode.getComponent(cc.Sprite) : null;
            if (titleSpr != null) {
                titleSpr.spriteFrame = atlas.getSpriteFrame("creatroom13");
            }
        }
        var panel = this._gamelist != null ? this._gamelist.getChildByName("qingyang") : null;
        if (panel == null) {
            return;
        }
        // 倍率行标签（替换原“底分选择”文字）
        var difenRow = panel.getChildByName("difenxuanze");
        if (difenRow != null && difenRow.getChildByName("beilv_label") == null) {
            var blNode = new cc.Node("beilv_label");
            var blSpr = blNode.addComponent(cc.Sprite);
            blSpr.spriteFrame = atlas.getSpriteFrame("creatroom10");
            blNode.setContentSize(165, 46);
            blNode.setParent(difenRow);
            blNode.setPosition(this._beilvPos != null ? this._beilvPos : cc.v2(0, 0));
        }
        // 玩法行标签（规则开关区左侧）：字形左缘与上方“倍率”对齐；y 为四行区块垂直中心
        if (panel.getChildByName("wanfa_label") == null) {
            var wfNode = new cc.Node("wanfa_label");
            var wfSpr = wfNode.addComponent(cc.Sprite);
            wfSpr.spriteFrame = atlas.getSpriteFrame("creatroom15");
            wfNode.setContentSize(82, 40);
            wfNode.setParent(panel);
            wfNode.setPosition(-435, -60);
        }
    },

    // 图集加载失败时退化为文字显示
    applyQingyangTextFallback: function () {
        var lz = this.node.getChildByName("leixingxuanze");
        var opt = lz != null ? lz.getChildByName("qingyang_opt") : null;
        if (opt != null) {
            var titleNode = opt.getChildByName("title");
            if (titleNode != null) {
                var titleSpr = titleNode.getComponent(cc.Sprite);
                if (titleSpr != null) {
                    titleSpr.spriteFrame = null;
                }
                var lbl = titleNode.getComponent(cc.Label);
                if (lbl == null) {
                    lbl = titleNode.addComponent(cc.Label);
                    lbl.fontSize = 34;
                    lbl.lineHeight = 38;
                    lbl.horizontalAlign = cc.Label.HorizontalAlign.CENTER;
                    lbl.verticalAlign = cc.Label.VerticalAlign.CENTER;
                }
                lbl.string = "青阳平胡";
            }
        }
        var panel = this._gamelist != null ? this._gamelist.getChildByName("qingyang") : null;
        if (panel != null) {
            var difenRow = panel.getChildByName("difenxuanze");
            if (difenRow != null) {
                var old = difenRow.getChildByName("New Label");
                if (old != null) {
                    old.active = true;
                    var ol = old.getComponent(cc.Label);
                    if (ol != null) {
                        ol.string = "倍率";
                    }
                }
            }
            if (panel.getChildByName("wanfa_label") == null) {
                var wfNode = new cc.Node("wanfa_label");
                var wfLbl = wfNode.addComponent(cc.Label);
                wfLbl.fontSize = 30;
                wfLbl.lineHeight = 34;
                wfLbl.string = "玩法";
                wfNode.color = cc.color(97, 60, 16);
                wfNode.setParent(panel);
                wfNode.setPosition(-446, -60);
            }
        }
    },

    // 把一组 RadioButton 的默认选中项设为第 defaultIdx 个
    setRadioDefaults: function (rowNode, defaultIdx) {
        var idx = 0;
        for (var i = 0; i < rowNode.childrenCount; ++i) {
            var r = rowNode.children[i].getComponent("RadioButton");
            if (r == null) {
                continue;
            }
            r.checked = (idx == defaultIdx);
            r.refresh();
            idx++;
        }
    },

    // 设置选项文字：优先复用已有Label，没有则在节点右侧补一个
    setOptionText: function (node, text) {
        var lbl = node.getComponent(cc.Label) || node.getComponentInChildren(cc.Label);
        if (lbl != null) {
            lbl.string = text;
        }
        else {
            lbl = node.addComponent(cc.Label);
            lbl.fontSize = 30;
            lbl.lineHeight = 34;
            lbl.horizontalAlign = cc.Label.HorizontalAlign.LEFT;
            lbl.verticalAlign = cc.Label.VerticalAlign.CENTER;
            lbl.node.x = 40;
            lbl.string = text;
        }
        lbl.node.color = cc.color(97, 60, 16);
    },

    onBtnBack: function () {
        this.node.active = false;
    },

    onBtnOK: function () {
        var usedTypes = ['xzdd', 'xlch', 'qingyang'];
        var type = this.getType();
        if (usedTypes.indexOf(type) == -1) {
            return;
        }

        this.node.active = false;
        this.createRoom();
    },

    getType: function () {
        var type = 0;
        for (var i = 0; i < this._leixingxuanze.length; ++i) {
            if (this._leixingxuanze[i].checked) {
                type = i;
                break;
            }
        }
        if (type == 0) {
            return 'xzdd';
        }
        else if (type == 1) {
            return 'xlch';
        }
        else if (type == 2) {
            return 'qingyang';
        }
        return 'xzdd';
    },

    getSelectedOfRadioGroup: function (groupRoot) {
        var t = this._currentGame.getChildByName(groupRoot);

        var arr = [];
        for (var i = 0; i < t.children.length; ++i) {
            var n = t.children[i].getComponent("RadioButton");
            if (n != null) {
                arr.push(n);
            }
        }
        var selected = 0;
        for (var i = 0; i < arr.length; ++i) {
            if (arr[i].checked) {
                selected = i;
                break;
            }
        }
        return selected;
    },

    createRoom: function () {
        var self = this;
        var onCreate = function (ret) {
            if (ret.errcode !== 0) {
                cc.vv.wc.hide();
                //console.log(ret.errmsg);
                if (ret.errcode == 2222) {
                    cc.vv.alert.show("提示", "钻石不足，创建房间失败!");
                }
                else {
                    cc.vv.alert.show("提示", "创建房间失败,错误码:" + ret.errcode);
                }
            }
            else {
                cc.vv.gameNetMgr.connectGameServer(ret);
            }
        };

        var type = this.getType();
        var conf = null;
        if (type == 'xzdd') {
            conf = this.constructSCMJConf();
        }
        else if (type == 'xlch') {
            conf = this.constructSCMJConf();
        }
        else if (type == 'qingyang') {
            conf = this.constructQingyangConf();
        }
        conf.type = type;

        var data = {
            account: cc.vv.userMgr.account,
            sign: cc.vv.userMgr.sign,
            conf: JSON.stringify(conf)
        };
        console.log(data);
        cc.vv.wc.show("正在创建房间");
        cc.vv.http.sendRequest("/create_private_room", data, onCreate);
    },

    // 青阳麻将房间配置：difen=倍率索引(0→5分 1→10分)，jushuxuanze=局数，rules=规则开关(含 queYimen 缺一门)
    constructQingyangConf: function () {
        var rules = {};
        for (var i = 0; i < this._qingyangRules.length; ++i) {
            rules[this._qingyangRules[i]] = this._qingyangChecks[i].checked ? true : false;
        }
        var conf = {
            difen: this.getSelectedOfRadioGroup('difenxuanze'),
            zimo: 0,
            jiangdui: false,
            huansanzhang: false,
            zuidafanshu: 0,
            jushuxuanze: this.getSelectedOfRadioGroup('xuanzejushu'),
            dianganghua: 0,
            menqing: false,
            tiandihu: false,
            robots: this._qingyangRobotCheck != null ? (this._qingyangRobotCheck.checked ? true : false) : false,
            rules: rules,
        };
        return conf;
    },

    constructSCMJConf: function () {

        var wanfaxuanze = this._currentGame.getChildByName('wanfaxuanze');
        var huansanzhang = wanfaxuanze.children[0].getComponent('CheckBox').checked;
        var jiangdui = wanfaxuanze.children[1].getComponent('CheckBox').checked;
        var menqing = wanfaxuanze.children[2].getComponent('CheckBox').checked;
        var tiandihu = wanfaxuanze.children[3].getComponent('CheckBox').checked;

        var difen = this.getSelectedOfRadioGroup('difenxuanze');
        var zimo = this.getSelectedOfRadioGroup('zimojiacheng');
        var zuidafanshu = this.getSelectedOfRadioGroup('zuidafanshu');
        var jushuxuanze = this.getSelectedOfRadioGroup('xuanzejushu');
        var dianganghua = this.getSelectedOfRadioGroup('dianganghua');

        var conf = {
            difen:difen,
            zimo:zimo,
            jiangdui:jiangdui,
            huansanzhang:huansanzhang,
            zuidafanshu:zuidafanshu,
            jushuxuanze:jushuxuanze,
            dianganghua:dianganghua,
            menqing:menqing,
            tiandihu:tiandihu,
        };
        return conf;
    },


    // called every frame, uncomment this function to activate update callback
    update: function (dt) {

        var type = this.getType();
        if (this.lastType != type) {
            this.lastType = type;
            for (var i = 0; i < this._gamelist.childrenCount; ++i) {
                this._gamelist.children[i].active = false;
            }

            var game = this._gamelist.getChildByName(type);
            if (game) {
                game.active = true;
            }
            this._currentGame = game;
        }
    },
});
