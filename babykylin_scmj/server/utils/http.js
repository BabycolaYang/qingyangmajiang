var http = require('http');
var https = require('https');
var qs = require('querystring');
var child_process = require('child_process');

String.prototype.format = function(args) {
	var result = this;
	if (arguments.length > 0) {
		if (arguments.length == 1 && typeof (args) == "object") {
			for (var key in args) {
				if(args[key]!=undefined){
					var reg = new RegExp("({" + key + "})", "g");
					result = result.replace(reg, args[key]);
				}
			}
		}
		else {
			for (var i = 0; i < arguments.length; i++) {
				if (arguments[i] != undefined) {
					//var reg = new RegExp("({[" + i + "]})", "g");//这个在索引大于9时会有问题，谢谢何以笙箫的指出
					var reg = new RegExp("({)" + i + "(})", "g");
					result = result.replace(reg, arguments[i]);
				}
			}
		}
	}
	return result;
};

exports.post = function (host,port,path,data,callback) {
	
	var content = qs.stringify(data);  
	var options = {  
		hostname: host,  
		port: port,  
		path: path + '?' + content,  
		method:'GET'
	};  
	  
	var req = http.request(options, function (res) {  
		console.log('STATUS: ' + res.statusCode);  
		console.log('HEADERS: ' + JSON.stringify(res.headers));  
		res.setEncoding('utf8');  
		res.on('data', function (chunk) {  
			//console.log('BODY: ' + chunk);
			callback(chunk);
		});  
	});
	  
	req.on('error', function (e) {  
		console.log('problem with request: ' + e.message);  
	});  
	  
	req.end(); 
};

exports.get2 = function (url,data,callback,safe) {
	var content = qs.stringify(data);
	var url = url + '?' + content;
	var proto = http;
	if(safe){
		proto = https;
	}
	var req = proto.get(url, function (res) {  
		//console.log('STATUS: ' + res.statusCode);  
		//console.log('HEADERS: ' + JSON.stringify(res.headers));  
		res.setEncoding('utf8');  
		res.on('data', function (chunk) {  
			//console.log('BODY: ' + chunk);
			var json = JSON.parse(chunk);
			callback(true,json);
		});  
	});
	  
	req.on('error', function (e) {  
		console.log('problem with request: ' + e.message);
		callback(false,e);
	});  
	  
	req.end(); 
};

exports.get = function (host,port,path,data,callback,safe) {
	var content = qs.stringify(data);  
	var options = {  
		hostname: host,  
		path: path + '?' + content,  
		method:'GET'
	};
	if(port){
		options.port = port;
	}
	var proto = http;
	if(safe){
		proto = https;
	}
	var req = proto.request(options, function (res) {  
		//console.log('STATUS: ' + res.statusCode);  
		//console.log('HEADERS: ' + JSON.stringify(res.headers));  
		res.setEncoding('utf8');  
		res.on('data', function (chunk) {  
			//console.log('BODY: ' + chunk);
			var json = JSON.parse(chunk);
			callback(true,json);
		});  
	});
	  
	req.on('error', function (e) {  
		console.log('problem with request: ' + e.message);
		callback(false,e);
	});  
	  
	req.end(); 
};

// Synchronous GET implemented with the bundled curl.exe (the original
// node-fibers yield/run approach does not work on modern Node).
exports.getSync = function (url,data,safe,encoding) {
	var content = qs.stringify(data);
	var fullUrl = url + '?' + content;

	var ret = {
		err:null,
		data:null,
	};

	// -s silent, -k ignore TLS certs, -L follow redirects, -i include headers
	var r = child_process.spawnSync('curl.exe',
		['-s', '-k', '-L', '--max-time', '15', '-i', fullUrl],
		{ encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });

	if (r.error) {
		console.log('problem with request: ' + r.error.message);
		ret.err = r.error;
		return ret;
	}

	var buf = r.stdout;
	var sep = Buffer.from('\r\n\r\n');
	var idx = buf.indexOf(sep);
	if (idx < 0) {
		ret.err = new Error('bad response');
		return ret;
	}

	var headerStr = buf.slice(0, idx).toString('utf8');
	var m = headerStr.match(/content-type:\s*([^\r\n]+)/i);
	ret.type = m ? m[1].trim() : null;
	var body = buf.slice(idx + sep.length);

	if (encoding != 'binary') {
		try {
			ret.data = JSON.parse(body.toString('utf8'));
		} catch(e) {
			console.log('JSON parse error: ' + e + ', url: ' + fullUrl);
		}
	}
	else{
		ret.data = body;
	}
	return ret;
};

exports.send = function(res,errcode,errmsg,data){
	if(data == null){
		data = {};
	}
	data.errcode = errcode;
	data.errmsg = errmsg;
	var jsonstr = JSON.stringify(data);
	res.send(jsonstr);
};