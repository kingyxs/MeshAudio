'use strict';
// Public phone ingress: deliberately excludes the desktop control API.
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

function createWebMicrophoneGateway(options) {
  const { root, dataDir, lineForId, register, upgrade } = options;
  const tlsDir = path.join(dataDir, 'web-microphone');
  let secure = null, error = null;
  const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const tlsPaths = {
    cert: process.env.MESHAUDIO_WEB_MIC_CERT || path.join(tlsDir, 'server.crt'),
    key: process.env.MESHAUDIO_WEB_MIC_KEY || path.join(tlsDir, 'server.key')
  };
  function status() {
    const httpAddress = plain.address(), tlsAddress = secure?.address();
    return {
      port: httpAddress?.port || null, securePort: tlsAddress?.port || null,
      secure: Boolean(tlsAddress), error,
      scheme: tlsAddress ? 'https' : 'http',
      page: '/ios-node.html',
      note: 'iPhone microphone requires HTTPS and a trusted certificate; keep Safari in foreground.'
    };
  }
  function url(host, id, setup = false) {
    const state = status(), port = setup ? state.port : state.securePort || state.port;
    return host && port ? `${setup ? 'http' : state.scheme}://${host}:${port}${id ? `/line/${encodeURIComponent(id)}` : '/ios-node.html'}` : null;
  }
  function handler(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { res.writeHead(400); return res.end(); }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method === 'POST' && pathname === '/api/browser-source') return register(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    if (pathname === '/web-microphone-ca.cer') {
      const ca = path.join(tlsDir, 'ca.cer');
      if (!fs.existsSync(ca)) { res.writeHead(404); return res.end('Certificate is not configured.'); }
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Disposition': 'attachment; filename="MeshAudio-web-microphone.cer"' });
      return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(ca));
    }
    if (pathname === '/browser-node.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(path.join(root, 'browser-node.js')));
    }
    const match = pathname.match(/^\/line\/([a-z0-9-]+)$/);
    const line = match ? lineForId(match[1]) : null;
    if (!['/', '/ios-node.html', '/browser-node.html'].includes(pathname) && !line) { res.writeHead(404); return res.end('not found'); }
    let html = fs.readFileSync(path.join(root, 'browser-node.html'), 'utf8');
    const state = status();
    const link = url(req.headers.host?.replace(/:\d+$/, '') || '', line?.id);
    const secureHelp = req.socket.encrypted ? '' : `<section class="banner" id="httpsSetup"><strong>iPhone 麦克风需要可信 HTTPS</strong><p>${state.secure ? `先在 iPhone 安装并信任本机证书，再<a href="${escape(link)}">打开 HTTPS 麦克风页面</a>。` : '电脑端尚未配置 HTTPS。请执行 tools/configure-web-microphone.ps1 后重启 MeshAudio。'}</p><p><a href="/web-microphone-ca.cer">下载本机麦克风证书</a> → 设置 → 已下载描述文件 → 安装；再到「通用 → 关于本机 → 证书信任设置」开启对 MeshAudio Web Microphone 的完全信任。只信任你自己电脑生成的证书。</p></section>`;
    const info = line ? `<section class="banner" id="airplayContext">关联的 AirPlay 线路：<strong>${escape(line.name)}</strong>。本页只发送麦克风，会在画布创建独立的网页麦克风来源；AirPlay 媒体来源仍在控制中心手动连接。</section>` : '';
    html = html.replace('<main>', `<main>${info}${secureHelp}`).replace('<html lang="zh-CN">', '<html lang="zh-CN" data-microphone-only="true">');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.method === 'HEAD' ? undefined : html);
  }
  function handleUpgrade(req, socket) {
    let parsed;
    try { parsed = new URL(req.url, 'http://localhost'); } catch { return socket.destroy(); }
    if (parsed.pathname !== '/browser-audio') return socket.destroy();
    upgrade(req, socket, parsed);
  }
  const plain = http.createServer(handler);
  plain.on('upgrade', handleUpgrade);
  plain.on('error', err => { error = `HTTP: ${err.message}`; console.error('[web-microphone]', error); });
  plain.listen(Number(process.env.MESHAUDIO_AIRPLAY_GUIDE_PORT || 4176), options.bindHost);
  try {
    if (fs.existsSync(tlsPaths.cert) && fs.existsSync(tlsPaths.key)) {
      secure = https.createServer({ cert: fs.readFileSync(tlsPaths.cert), key: fs.readFileSync(tlsPaths.key), minVersion: 'TLSv1.2' }, handler);
      secure.on('upgrade', handleUpgrade);
      secure.on('error', err => { error = `HTTPS: ${err.message}`; console.error('[web-microphone]', error); });
      secure.listen(Number(process.env.MESHAUDIO_WEB_MIC_TLS_PORT || 4177), options.bindHost);
    } else if (process.env.MESHAUDIO_WEB_MIC_CERT || process.env.MESHAUDIO_WEB_MIC_KEY) error = 'HTTPS certificate or key file is missing';
  } catch (err) { error = `HTTPS: ${err.message}`; console.error('[web-microphone]', error); secure = null; }
  return { status, url, close() { plain.close(); secure?.close(); } };
}
module.exports = { createWebMicrophoneGateway };
