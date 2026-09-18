// 静态文件服务器：serve Cocos 构建产物 web-mobile 到 8080 端口（.cjs 避免 ESM 冲突）
// 用法: node static_web_server.cjs
var http = require('http');
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..', 'babykylin_scmj', 'client', 'build', 'web-mobile');
var PORT = 8080;

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.plist': 'application/xml',
  '.xml': 'application/xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.fnt': 'application/octet-stream',
  '.atlas': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm'
};

http.createServer(function (req, res) {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/' || urlPath === '') { urlPath = '/index.html'; }
  var filePath = path.join(ROOT, urlPath);
  // 防目录穿越
  if (filePath.indexOf(ROOT) !== 0) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, function (err, st) {
    if (err || !st.isFile()) {
      res.writeHead(404); res.end('Not Found'); return;
    }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, function () {
  console.log('static web server running at http://localhost:' + PORT + '/');
});
