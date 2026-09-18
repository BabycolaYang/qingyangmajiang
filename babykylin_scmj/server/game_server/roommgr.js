var db = require('../utils/db');

var rooms = {};
var creatingRooms = {};

var userLocation = {};
var totalRooms = 0;

var DI_FEN = [1,2,5];
var QY_BEI_LV = [5,10];	//青阳平胡倍率：0→5分 1→10分
var MAX_FAN = [3,4,5];
var JU_SHU = [4,8];
var JU_SHU_COST = [2,3];
// 青阳圈数制：0→1圈 1→2圈 2→4圈；房卡 1圈/2圈=2、4圈=3
var QY_QUAN_SHU = [1,2,4];
var QY_QUAN_COST = [2,2,3];

function generateRoomId(){
	var roomId = "";
	for(var i = 0; i < 6; ++i){
		roomId += Math.floor(Math.random()*10);
	}
	return roomId;
}

function constructRoomFromDb(dbdata){
	var roomInfo = {
		uuid:dbdata.uuid,
		id:dbdata.id,
		numOfGames:dbdata.num_of_turns,
		//圈数制：已完成圈数（db 无字段，服务重启后从 0 重新累计，轮回起始庄继续算圈）
		numOfQuans:0,
		createTime:dbdata.create_time,
		nextButton:dbdata.next_button,
		seats:new Array(4),
		conf:JSON.parse(dbdata.base_info)
	};


	if(roomInfo.conf.type == "xlch"){
		roomInfo.gameMgr = require("./gamemgr_xlch");
	}
	else if(roomInfo.conf.type == "qingyang"){
		roomInfo.gameMgr = require("./gamemgr_qingyang");
	}
	else{
		roomInfo.gameMgr = require("./gamemgr_xzdd");
	}
	var roomId = roomInfo.id;

	for(var i = 0; i < 4; ++i){
		var s = roomInfo.seats[i] = {};
		s.userId = dbdata["user_id" + i];
		s.score = dbdata["user_score" + i];
		s.name = dbdata["user_name" + i];
		s.ready = false;
		s.seatIndex = i;
		s.numZiMo = 0;
		s.numJiePao = 0;
		s.numDianPao = 0;
		s.numAnGang = 0;
		s.numMingGang = 0;
		s.numChaJiao = 0;
		s.numXiaoKai = 0;
		s.numEnDou = 0;
		s.numPaoFeng = 0;
		s.numDuiDuiHu = 0;
		s.numQiXiaoDui = 0;
		s.numQuanQiu = 0;
		s.numSiXi = 0;
		s.numGenFa = 0;
		s.numWanGang = 0;
		s.numZhiGang = 0;

		if(s.userId > 0){
			userLocation[s.userId] = {
				roomId:roomId,
				seatIndex:i
			};
		}
	}
	rooms[roomId] = roomInfo;
	totalRooms++;
	return roomInfo;
}

exports.createRoom = function(creator,roomConf,gems,ip,port,callback){
	if(
		roomConf.type == null
		|| roomConf.difen == null
		|| roomConf.zimo == null
		|| roomConf.jiangdui == null
		|| roomConf.huansanzhang == null
		|| roomConf.zuidafanshu == null
		|| roomConf.jushuxuanze == null
		|| roomConf.dianganghua == null
		|| roomConf.menqing == null
		|| roomConf.tiandihu == null){
		callback(1,null);
		return;
	}

	if(roomConf.difen < 0){
		callback(1,null);
		return;
	}
	var diFenArr = (roomConf.type == "qingyang") ? QY_BEI_LV : DI_FEN;
	if(roomConf.difen >= diFenArr.length){
		callback(1,null);
		return;
	}

	if(roomConf.zimo < 0 || roomConf.zimo > 2){
		callback(1,null);
		return;
	}

	if(roomConf.zuidafanshu < 0 || roomConf.zuidafanshu > MAX_FAN.length){
		callback(1,null);
		return;
	}

	var quanArr = (roomConf.type == "qingyang") ? QY_QUAN_SHU : JU_SHU;
	if(roomConf.jushuxuanze < 0 || roomConf.jushuxuanze >= quanArr.length){
		callback(1,null);
		return;
	}

	var cost = (roomConf.type == "qingyang") ? QY_QUAN_COST[roomConf.jushuxuanze] : JU_SHU_COST[roomConf.jushuxuanze];
	//机器人局不扣房卡，也不做余额预检
	if(!(roomConf.robots) && cost > gems){
		callback(2222,null);
		return;
	}

	var fnCreate = function(){
		var roomId = generateRoomId();
		if(rooms[roomId] != null || creatingRooms[roomId] != null){
			fnCreate();
		}
		else{
			creatingRooms[roomId] = true;
			db.is_room_exist(roomId, function(ret) {

				if(ret){
					delete creatingRooms[roomId];
					fnCreate();
				}
				else{
					var createTime = Math.ceil(Date.now()/1000);
					var roomInfo = {
						uuid:"",
						id:roomId,
						numOfGames:0,
						//圈数制：已完成圈数，青阳首庄恒为 0 号位，轮回 0 即完成一圈
						numOfQuans:0,
						createTime:createTime,
						nextButton:0,
						seats:[],
						conf:{
							type:roomConf.type,
							baseScore:diFenArr[roomConf.difen],
						    zimo:roomConf.zimo,
						    jiangdui:roomConf.jiangdui,
						    hsz:roomConf.huansanzhang,
						    dianganghua:parseInt(roomConf.dianganghua),
						    menqing:roomConf.menqing,
						    tiandihu:roomConf.tiandihu,
						    maxFan:MAX_FAN[roomConf.zuidafanshu],
					    maxGames:((roomConf.type == "qingyang") ? QY_QUAN_SHU : JU_SHU)[roomConf.jushuxuanze],
					    robots:roomConf.robots ? true : false,
					    creator:creator,
					    rules:(roomConf.type == "qingyang" && roomConf.rules) ? roomConf.rules : null,
					}
				};

				if(roomConf.type == "xlch"){
					roomInfo.gameMgr = require("./gamemgr_xlch");
				}
				else if(roomConf.type == "qingyang"){
					roomInfo.gameMgr = require("./gamemgr_qingyang");
				}
				else{
					roomInfo.gameMgr = require("./gamemgr_xzdd");
				}
					console.log(roomInfo.conf);
					
					for(var i = 0; i < 4; ++i){
					roomInfo.seats.push({
						userId:0,
						//机器人局为积分制：所有人开局定位 1000 分
						score:(roomConf.robots ? 1000 : 0),
						name:"",
						ready:false,
						seatIndex:i,
						numZiMo:0,
						numJiePao:0,
						numDianPao:0,
						numAnGang:0,
						numMingGang:0,
						numChaJiao:0,
						numXiaoKai:0,
						numEnDou:0,
						numPaoFeng:0,
						numDuiDuiHu:0,
						numQiXiaoDui:0,
						numQuanQiu:0,
						numSiXi:0,
						numGenFa:0,
						numWanGang:0,
						numZhiGang:0,
					});
				}
					

					//写入数据库
					var conf = roomInfo.conf;
					db.create_room(roomInfo.id,roomInfo.conf,ip,port,createTime,function(uuid){
						delete creatingRooms[roomId];
						if(uuid != null){
							roomInfo.uuid = uuid;
							console.log(uuid);
							rooms[roomId] = roomInfo;
							totalRooms++;
							callback(0,roomId);
						}
						else{
							callback(3,null);
						}
					});
				}
			});
		}
	}

	fnCreate();
};

exports.destroy = function(roomId){
	var roomInfo = rooms[roomId];
	if(roomInfo == null){
		return;
	}

	for(var i = 0; i < 4; ++i){
		var userId = roomInfo.seats[i].userId;
		if(userId > 0){
			delete userLocation[userId];
			db.set_room_id_of_user(userId,null);
		}
	}
	
	delete rooms[roomId];
	totalRooms--;
	db.delete_room(roomId);
}

exports.getTotalRooms = function(){
	return totalRooms;
}

exports.getRoom = function(roomId){
	return rooms[roomId];
};

exports.isCreator = function(roomId,userId){
	var roomInfo = rooms[roomId];
	if(roomInfo == null){
		return false;
	}
	return roomInfo.conf.creator == userId;
};

exports.enterRoom = function(roomId,userId,userName,callback){
	var fnTakeSeat = function(room){
		if(exports.getUserRoom(userId) == roomId){
			//已存在
			return 0;
		}

		for(var i = 0; i < 4; ++i){
			var seat = room.seats[i];
			if(seat.userId <= 0){
				seat.userId = userId;
				seat.name = userName;
				userLocation[userId] = {
					roomId:roomId,
					seatIndex:i
				};
				//console.log(userLocation[userId]);
				db.update_seat_info(roomId,i,seat.userId,"",seat.name);
				//正常
				return 0;
			}
		}	
		//房间已满
		return 1;	
	}
	var room = rooms[roomId];
	if(room){
		var ret = fnTakeSeat(room);
		callback(ret);
	}
	else{
		db.get_room_data(roomId,function(dbdata){
			if(dbdata == null){
				//找不到房间
				callback(2);
			}
			else{
				//construct room.
				room = constructRoomFromDb(dbdata);
				//
				var ret = fnTakeSeat(room);
				callback(ret);
			}
		});
	}
};

exports.setReady = function(userId,value){
	var roomId = exports.getUserRoom(userId);
	if(roomId == null){
		return;
	}

	var room = exports.getRoom(roomId);
	if(room == null){
		return;
	}

	var seatIndex = exports.getUserSeat(userId);
	if(seatIndex == null){
		return;
	}

	var s = room.seats[seatIndex];
	s.ready = value;
}

exports.isReady = function(userId){
	var roomId = exports.getUserRoom(userId);
	if(roomId == null){
		return;
	}

	var room = exports.getRoom(roomId);
	if(room == null){
		return;
	}

	var seatIndex = exports.getUserSeat(userId);
	if(seatIndex == null){
		return;
	}

	var s = room.seats[seatIndex];
	return s.ready;	
}


exports.getUserRoom = function(userId){
	var location = userLocation[userId];
	if(location != null){
		return location.roomId;
	}
	return null;
};

// AI 机器人入座后补登记定位（否则以其 userId 定位的广播全部失效）
exports.bindRobot = function(roomId,userId,seatIndex){
	userLocation[userId] = {
		userId: userId,
		seatIndex: seatIndex,
		roomId: roomId
	};
};

exports.getUserSeat = function(userId){
	var location = userLocation[userId];
	//console.log(userLocation[userId]);
	if(location != null){
		return location.seatIndex;
	}
	return null;
};

exports.getUserLocations = function(){
	return userLocation;
};

exports.exitRoom = function(userId){
	var location = userLocation[userId];
	if(location == null)
		return;

	var roomId = location.roomId;
	var seatIndex = location.seatIndex;
	var room = rooms[roomId];
	delete userLocation[userId];
	if(room == null || seatIndex == null) {
		return;
	}

	var seat = room.seats[seatIndex];
	seat.userId = 0;
	seat.name = "";

	var numOfPlayers = 0;
	for(var i = 0; i < room.seats.length; ++i){
		if(room.seats[i].userId > 0){
			numOfPlayers++;
		}
	}
	
	db.set_room_id_of_user(userId,null);

	if(numOfPlayers == 0){
		exports.destroy(roomId);
	}
};