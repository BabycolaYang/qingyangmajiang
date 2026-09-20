cc.Class({
    extends: cc.Component,

    properties: {
        // foo: {
        //    default: null,      // The default value will be used only when the component attaching
        //                           to a node for the first time
        //    url: cc.Texture2D,  // optional, default is typeof default
        //    serializable: true, // optional, default is true
        //    visible: true,      // optional, default is true
        //    displayName: 'Foo', // optional
        //    readonly: false,    // optional, default is false
        // },
        // ...
        bgmVolume:1.0,
        sfxVolume:1.0,
        
        bgmAudioID:-1,
    },

    // use this for initialization
    init: function () {
        var t = cc.sys.localStorage.getItem("bgmVolume");
        if(t != null){
            this.bgmVolume = parseFloat(t);    
        }
        
        var t = cc.sys.localStorage.getItem("sfxVolume");
        if(t != null){
            this.sfxVolume = parseFloat(t);    
        }
        
        cc.game.on(cc.game.EVENT_HIDE, function () {
            console.log("cc.audioEngine.pauseAll");
            cc.audioEngine.pauseAll();
        });
        cc.game.on(cc.game.EVENT_SHOW, function () {
            console.log("cc.audioEngine.resumeAll");
            cc.audioEngine.resumeAll();
        });
    },

    // called every frame, uncomment this function to activate update callback
    // update: function (dt) {

    // },
    
    getUrl:function(url){
        // 2.x: 走 resources bundle 相对路径（配合 ensureClip 用 cc.resources.load 加载）
        return "sounds/" + url;
    },

    // 按 url 加载 AudioClip 并缓存（Creator 2.x 的 audioEngine.play 只接受 AudioClip 实例）
    _clipCache: null,

    ensureClip:function(url, cb){
        var self = this;
        if(!self._clipCache){
            self._clipCache = {};
        }
        var cached = self._clipCache[url];
        if(cached){
            cb(null, cached);
            return;
        }
        cc.resources.load("sounds/" + url.replace(/\.[^./\\]+$/, ""), cc.AudioClip, function(err, clip){
            if(err || !clip){
                cc.warn("AudioMgr load failed:", url, err);
                cb(err || new Error("load clip failed"));
                return;
            }
            self._clipCache[url] = clip;
            cb(null, clip);
        });
    },

    playBGM(url){
        var self = this;
        console.log("playBGM", url);
        self.ensureClip(url, function(err, clip){
            if(err || !clip){
                return;
            }
            if(self.bgmAudioID >= 0){
                cc.audioEngine.stop(self.bgmAudioID);
            }
            self.bgmAudioID = cc.audioEngine.play(clip, true, self.bgmVolume);
        });
    },

    playSFX(url){
        if(!url){
            return;
        }
        var self = this;
        if(!(self.sfxVolume > 0)){
            return;
        }
        self.ensureClip(url, function(err, clip){
            if(err || !clip){
                return;
            }
            cc.audioEngine.play(clip, false, self.sfxVolume);
        });
    },
    
    setSFXVolume:function(v){
        if(this.sfxVolume != v){
            cc.sys.localStorage.setItem("sfxVolume",v);
            this.sfxVolume = v;
        }
    },
    
    setBGMVolume:function(v,force){
        if(this.bgmAudioID >= 0){
            if(v > 0){
                cc.audioEngine.resume(this.bgmAudioID);
            }
            else{
                cc.audioEngine.pause(this.bgmAudioID);
            }
            //cc.audioEngine.setVolume(this.bgmAudioID,this.bgmVolume);
        }
        if(this.bgmVolume != v || force){
            cc.sys.localStorage.setItem("bgmVolume",v);
            this.bgmVolume = v;
            cc.audioEngine.setVolume(this.bgmAudioID,v);
        }
    },
    
    pauseAll:function(){
        cc.audioEngine.pauseAll();
    },
    
    resumeAll:function(){
        cc.audioEngine.resumeAll();
    }
});
