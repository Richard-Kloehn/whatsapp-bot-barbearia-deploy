"use strict";
/**
 * Logger com buffer em memória.
 * Captura console.log/warn/error e exibe na página /logs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogs = getLogs;
exports.paginaLogs = paginaLogs;
const MAX_LOGS = 300;
const buffer = [];
function push(level, args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    buffer.push({ ts: new Date().toLocaleTimeString('pt-BR'), level, msg });
    if (buffer.length > MAX_LOGS)
        buffer.shift();
}
// Intercepta console
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
console.log = (...args) => { _log(...args); push('INFO', args); };
console.warn = (...args) => { _warn(...args); push('WARN', args); };
console.error = (...args) => { _error(...args); push('ERROR', args); };
function getLogs() {
    return [...buffer].reverse(); // mais recente primeiro
}
function paginaLogs() {
    const linhas = getLogs().map(e => {
        const cor = e.level === 'ERROR' ? '#ef4444' : e.level === 'WARN' ? '#f59e0b' : '#a3e635';
        const bg = e.level === 'ERROR' ? 'rgba(239,68,68,0.08)' : e.level === 'WARN' ? 'rgba(245,158,11,0.06)' : 'transparent';
        return `<div style="padding:4px 8px;border-bottom:1px solid #1a1a1a;background:${bg}">
      <span style="color:#555;font-size:11px">${e.ts}</span>
      <span style="color:${cor};font-weight:bold;font-size:11px;margin:0 6px">[${e.level}]</span>
      <span style="color:#ddd;font-size:12px">${e.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</span>
    </div>`;
    }).join('');
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Logs — Bot WhatsApp</title>
  <meta http-equiv="refresh" content="5">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:monospace;background:#0a0a0a;color:#ddd;padding:16px}
    h1{color:#25d366;font-size:16px;margin-bottom:4px}
    .sub{color:#555;font-size:12px;margin-bottom:12px}
    .box{background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;max-height:85vh;overflow-y:auto}
    .empty{padding:20px;text-align:center;color:#444}
    .nav{display:flex;gap:8px;margin-bottom:12px}
    .nav a{color:#25d366;text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid #25d36644;border-radius:6px}
    .nav a:hover{background:#25d36622}
  </style>
</head>
<body>
  <h1>📋 Logs — Bot WhatsApp Barbearia</h1>
  <p class="sub">Atualiza automaticamente a cada 5s • Mostrando os ${MAX_LOGS} logs mais recentes</p>
  <div class="nav">
    <a href="/">← Painel QR</a>
    <a href="/logs">🔄 Atualizar agora</a>
  </div>
  <div class="box">
    ${linhas || '<div class="empty">Nenhum log ainda...</div>'}
  </div>
</body>
</html>`;
}
