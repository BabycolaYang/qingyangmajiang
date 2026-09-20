// 静态文件服务器：serve Cocos 构建产物 web-mobile 到 8080 端口（.cjs 避免 ESM 冲突）
// 用法: node static_web_server.cjs
// 2026-09-19 卡顿优化：文本类文件 gzip（带缓存）+ ETag/304 协商缓存，公网 3Mbps 带宽下显著提速
var http = require('http');
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

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

// 需要 gzip 的文本类扩展名（png/mp3 等已压缩格式不压）
var GZIP_EXT = { '.js': 1, '.json': 1, '.html': 1, '.css': 1, '.xml': 1, '.plist': 1, '.fnt': 1, '.atlas': 1 };
// gzip 上限，超过则直传（避免 1 核机压缩超大文件阻塞事件循环）
var GZIP_MAX = 4 * 1024 * 1024;

// gzip 结果内存缓存：path -> {etag, buf}
var gzipCache = {};

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
    // ETag：size + mtime，内容变了自动失效
    var etag = '"' + st.size + '-' + st.mtimeMs + '"';

    // 客户端缓存命中：304 免传（二次进入游戏近乎零流量）
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }

    var acceptGzip = /gzip/.test(req.headers['accept-encoding'] || '');
    if (acceptGzip && GZIP_EXT[ext] && st.size <= GZIP_MAX && st.size > 512) {
      var cached = gzipCache[filePath];
      if (cached && cached.etag === etag) {
        res.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Encoding': 'gzip',
          'Content-Length': cached.buf.length,
          'ETag': etag,
          'Cache-Control': 'no-cache',
          'Vary': 'Accept-Encoding'
        });
        res.end(cached.buf);
        return;
      }
      fs.readFile(filePath, function (e, raw) {
        if (e) { res.writeHead(404); res.end('Not Found'); return; }
        zlib.gzip(raw, { level: 6 }, function (e2, buf) {
          if (e2) { res.writeHead(500); res.end('gzip error'); return; }
          gzipCache[filePath] = { etag: etag, buf: buf };
          res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Encoding': 'gzip',
            'Content-Length': buf.length,
            'ETag': etag,
            'Cache-Control': 'no-cache',
            'Vary': 'Accept-Encoding'
          });
          res.end(buf);
        });
      });
      return;
    }

    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'ETag': etag,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}).listen(PORT, function () {
  console.log('static web server running at http://localhost:' + PORT + '/');
});
