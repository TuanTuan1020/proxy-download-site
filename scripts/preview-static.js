#!/usr/bin/env node
/**
 * 纯静态预览：只把 web/ 当作静态目录提供，不启动 API、不提供 /download。
 * 用途：验证"前端能否脱离 Node 服务独立工作"（等同于 GitHub Pages / 对象存储静态托管）。
 * 用法：node scripts/preview-static.js [--port=8790]
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1]) || 8790;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let file = path.resolve(WEB, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
    if (!file.startsWith(WEB)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      const body = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`静态预览（无 API、无下载服务）：http://127.0.0.1:${port}/`);
  });
