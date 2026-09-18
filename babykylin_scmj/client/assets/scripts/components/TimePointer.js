cc.Class({
    extends: cc.Component,

    properties: {
        _arrow:null,
        _pointer:null,
        _timeLabel:null,
        _time:-1,
        _alertTime:-1,
    },

    // use this for initialization
    onLoad: function () {
        var gameChild = this.node.getChildByName("game");
        if(gameChild == null){
            return;
        }
        this._arrow = gameChild.getChildByName("arrow");
        if(this._arrow == null){
            return;
        }
        this._pointer = this._arrow.getChildByName("pointer");
        var lblNode = this._arrow.getChildByName("lblTime");
        if(lblNode != null){
            this._timeLabel = lblNode.getComponent(cc.Label);
            if(this._timeLabel != null){
                this._timeLabel.string = "00";
            }
        }

        this.initPointer();

        var self = this;

        this.node.on('game_begin',function(data){
            self.initPointer();
        });

        this.node.on('game_playing',function(data){
            self.initPointer();
        });

        this.node.on('game_sync',function(data){
            self.initPointer();
        });

        this.node.on('game_chupai',function(data){
            self.initPointer();
            self._time = 10;
            self._alertTime = 3;
        });
    },

    initPointer:function(){
        if(cc.vv == null || cc.vv.gameNetMgr == null){
            return;
        }
        if(this._arrow == null){
            return;
        }
        this._arrow.active = cc.vv.gameNetMgr.gamestate == "playing";
        if(!this._arrow.active){
            return;
        }
        var turn = cc.vv.gameNetMgr.turn;
        if(turn == null || turn < 0 || this._pointer == null){
            return;
        }
        var localIndex = cc.vv.gameNetMgr.getLocalIndex(turn);
        for(var i = 0; i < this._pointer.children.length; ++i){
            this._pointer.children[i].active = i == localIndex;
        }
    },

    // called every frame, uncomment this function to activate update callback
    update: function (dt) {
        //自愈：对局进行中轮盘若被意外隐藏，强制恢复显示
        if(cc.vv != null && cc.vv.gameNetMgr != null && cc.vv.gameNetMgr.gamestate == "playing"){
            if(this._arrow != null && !this._arrow.active){
                this.initPointer();
                if(this._time <= 0){
                    this._time = 10;
                    this._alertTime = 3;
                }
            }
        }
        if(this._time > 0){
            this._time -= dt;
            if(this._alertTime > 0 && this._time < this._alertTime){
                cc.vv.audioMgr.playSFX("timeup_alarm.mp3");
                this._alertTime = -1;
            }
            var pre = "";
            if(this._time < 0){
                this._time = 0;
            }

            var t = Math.ceil(this._time);
            if(t < 10){
                pre = "0";
            }
            if(this._timeLabel != null){
                this._timeLabel.string = pre + t;
            }
        }
    },
});
