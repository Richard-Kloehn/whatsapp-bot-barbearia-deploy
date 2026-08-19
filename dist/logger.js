"use strict";
/**
 * Logger com buffer em memória.
 * Captura console.log/warn/error e exibe na página /logs.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLogs = getLogs;
exports.paginaLogs = paginaLogs;
const MAX_LOGS = 1500;
const buffer = [];
function push(level, args) {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    buffer.push({ ts: new Date().toLocaleTimeString('pt-BR'), level, msg });
    if (buffer.length > MAX_LOGS)
        buffer.shift();
}
// (fix) SUPRESSAO DE RUIDO — o Baileys (via libsignal internamente) as vezes escreve
// direto no console (nao atraves do logger configurado em whatsapp.js, que fica em modo
// 'silent') sempre que a sessao de criptografia com um contato fica dessincronizada —
// "Bad MAC", "Failed to decrypt message with any known session", "MessageCounterError" e
// "Closing open session in favor of incoming prekey bundle". Isso e um comportamento
// NORMAL e AUTORRECUPERAVEL do proprio protocolo Signal usado pelo WhatsApp (a ultima
// mensagem acima e literalmente o Baileys se corrigindo sozinho) — nao e um bug deste
// bot, e nao da pra fazer o evento em si parar de acontecer (depende da rede/do proprio
// WhatsApp). O que da pra evitar e a POLUICAO do log: uma unica dessincronizacao real
// costuma gerar uma rajada de dezenas de linhas identicas em poucos segundos, escondendo
// qualquer coisa relevante que aconteca no meio. Deixa passar a primeira ocorrencia de
// cada padrao a cada 60s (prova de que ainda esta acontecendo) e resume o resto — nunca
// suprime SILENCIOSAMENTE por completo, so evita repetir a MESMA linha dezenas de vezes.
const PADROES_RUIDO_CONHECIDO = [
    /Bad MAC/i,
    /Failed to decrypt message with any known session/i,
    /MessageCounterError/i,
    /Closing open session in favor of incoming prekey bundle/i,
];
const JANELA_RUIDO_MS = 60 * 1000;
const _ruidoContadores = new Map(); // padrao -> { inicioJanela, contagem }
function ehRuidoConhecidoParaSuprimir(msg) {
    const padrao = PADROES_RUIDO_CONHECIDO.find(re => re.test(msg));
    if (!padrao) return false;
    const agora = Date.now();
    const chave = padrao.source;
    const atual = _ruidoContadores.get(chave);
    if (!atual || agora - atual.inicioJanela > JANELA_RUIDO_MS) {
        _ruidoContadores.set(chave, { inicioJanela: agora, contagem: 1 });
        return false; // primeira ocorrencia da janela — deixa passar normalmente
    }
    atual.contagem++;
    return true; // ja passou uma vez nesta janela — suprime as repeticoes
}
// A cada minuto, se algum padrao teve repeticoes suprimidas, imprime UM resumo (nunca
// fica completamente calado sobre o assunto, so evita repetir a mesma linha 50x).
setInterval(() => {
    const agora = Date.now();
    for (const [chave, info] of _ruidoContadores.entries()) {
        if (info.contagem > 1 && agora - info.inicioJanela <= JANELA_RUIDO_MS + 5000) {
            _warn(`[logger] Sessao WhatsApp dessincronizou ${info.contagem}x no ultimo minuto (Bad MAC/decrypt — autorrecuperavel pelo Baileys). Detalhes das ocorrencias individuais foram omitidos para nao poluir o log.`);
            push('WARN', [`Sessao WhatsApp dessincronizou ${info.contagem}x no ultimo minuto (autorrecuperavel) — detalhes omitidos`]);
        }
        if (agora - info.inicioJanela > JANELA_RUIDO_MS) _ruidoContadores.delete(chave);
    }
}, JANELA_RUIDO_MS);
// Intercepta console
const _log = console.log.bind(console);
const _warn = console.warn.bind(console);
const _error = console.error.bind(console);
console.log = (...args) => { _log(...args); push('INFO', args); };
console.warn = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (ehRuidoConhecidoParaSuprimir(msg)) return;
    _warn(...args); push('WARN', args);
};
console.error = (...args) => {
    const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    if (ehRuidoConhecidoParaSuprimir(msg)) return;
    _error(...args); push('ERROR', args);
};
function getLogs() {
    return [...buffer].reverse(); // mais recente primeiro
}
// Classifica cada linha em um "tipo" para permitir filtrar a view. O objetivo e
// separar CONVERSA (o que interessa no dia a dia: cliente <-> bot) de RUIDO TECNICO
// ([ai] Tool:, [ai] Estado atualizado, [database]...) sem descartar nada — o tecnico
// continua tudo ali, só escondido atrás de um clique por padrão.
function classificarLinha(msg, level) {
    if (msg.includes('🗣️ CLIENTE') || msg.includes('CLIENTE ('))
        return 'conversa-cliente';
    if (msg.includes('🤖 BOT RESPONDEU') || msg.includes('BOT RESPONDEU'))
        return 'conversa-bot';
    if (msg.includes('────'))
        return 'conversa-divisor';
    if (level === 'ERROR') return 'erro';
    if (level === 'WARN') return 'aviso';
    return 'tecnico';
}
function paginaLogs() {
    const entradas = getLogs();
    let ocultosErro = 0, ocultosAviso = 0, ocultosTecnico = 0;
    const linhas = entradas.map(e => {
        const msg = e.msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const tipo = classificarLinha(msg, e.level);
        if (tipo === 'erro') ocultosErro++;
        else if (tipo === 'aviso') ocultosAviso++;
        else if (tipo === 'tecnico') ocultosTecnico++;
        let cor = '#a3e635';
        let bg = 'transparent';
        let padding = '4px 8px';
        let fontSize = '12px';
        if (e.level === 'ERROR') { cor = '#ef4444'; bg = 'rgba(239,68,68,0.1)'; }
        else if (e.level === 'WARN') { cor = '#f59e0b'; bg = 'rgba(245,158,11,0.08)'; }
        if (tipo === 'conversa-cliente') {
            bg = 'rgba(100,200,255,0.12)'; cor = '#64c8ff'; padding = '8px 12px'; fontSize = '13px';
        } else if (tipo === 'conversa-bot') {
            bg = 'rgba(76,175,80,0.12)'; cor = '#4caf50'; padding = '8px 12px'; fontSize = '13px';
        } else if (tipo === 'conversa-divisor') {
            bg = 'rgba(100,100,100,0.1)'; padding = '2px 8px'; fontSize = '11px';
        }
        return `<div class="linha" data-tipo="${tipo}" style="padding:${padding};border-bottom:1px solid #1a1a1a;background:${bg}">
      <span style="color:#555;font-size:11px">${e.ts}</span>
      <span style="color:${cor};font-weight:bold;font-size:11px;margin:0 6px">[${e.level}]</span>
      <span style="color:${cor};font-size:${fontSize}">${msg}</span>
    </div>`;
    }).join('');
    const totalOcultosNaConversa = ocultosErro + ocultosAviso + ocultosTecnico;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Logs — Bot WhatsApp</title>
  <meta http-equiv="refresh" content="8">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:monospace;background:#0a0a0a;color:#ddd;padding:16px}
    h1{color:#25d366;font-size:16px;margin-bottom:4px}
    .sub{color:#555;font-size:12px;margin-bottom:12px}
    .legend{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px;font-size:12px}
    .legend-item{padding:8px;background:#1a1a1a;border-left:3px solid;border-radius:4px}
    .legend-cliente{border-left-color:#64c8ff}
    .legend-bot{border-left-color:#4caf50}
    .legend-error{border-left-color:#ef4444}
    .legend-warn{border-left-color:#f59e0b}
    .box{background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;max-height:75vh;overflow-y:auto}
    .empty{padding:20px;text-align:center;color:#444}
    .nav{display:flex;gap:8px;margin-bottom:12px}
    .nav a{color:#25d366;text-decoration:none;font-size:13px;padding:4px 10px;border:1px solid #25d36644;border-radius:6px}
    .nav a:hover{background:#25d36622}
    .filtros{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
    .filtros button{font-family:monospace;font-size:12px;padding:6px 12px;border-radius:20px;border:1px solid #333;background:#161616;color:#999;cursor:pointer}
    .filtros button.ativo{background:#25d366;color:#0a0a0a;border-color:#25d366;font-weight:bold}
    .badge{font-size:12px;color:#f59e0b;background:#1a1a1a;padding:5px 10px;border-radius:20px;border:1px solid #333}
  </style>
</head>
<body>
  <h1>📋 Logs — Bot WhatsApp Barbearia</h1>
  <p class="sub">Atualiza a cada 8s • Buffer com os ${MAX_LOGS} logs mais recentes</p>
  <div class="nav">
    <a href="/">← Painel QR</a>
    <a href="/logs">🔄 Atualizar agora</a>
  </div>
  <div class="filtros">
    <button data-filtro="conversa">💬 Só conversa</button>
    <button data-filtro="conversa-erros">💬 Conversa + erros/avisos</button>
    <button data-filtro="tudo">🔧 Tudo (técnico)</button>
    <span class="badge" id="badge-ocultos"></span>
  </div>
  <div class="legend">
    <div class="legend-item legend-cliente">🗣️ Mensagem de Cliente — o que foi recebido</div>
    <div class="legend-item legend-bot">🤖 Resposta do Bot — o que foi enviado</div>
    <div class="legend-item legend-error">❌ Erro — problema identificado</div>
    <div class="legend-item legend-warn">⚠️ Aviso — situação de alerta</div>
  </div>
  <div class="box" id="box">
    ${linhas || '<div class="empty">Nenhum log ainda...</div>'}
  </div>
  <script>
    (function(){
      var CONTAGEM = { erro: ${ocultosErro}, aviso: ${ocultosAviso}, tecnico: ${ocultosTecnico} };
      var linhas = document.querySelectorAll('#box .linha');
      var btns = document.querySelectorAll('.filtros button');
      var badge = document.getElementById('badge-ocultos');
      function tiposVisiveisPara(filtro) {
        if (filtro === 'conversa') return ['conversa-cliente', 'conversa-bot', 'conversa-divisor'];
        if (filtro === 'conversa-erros') return ['conversa-cliente', 'conversa-bot', 'conversa-divisor', 'erro', 'aviso'];
        return null; // tudo
      }
      function aplicar(filtro) {
        var visiveis = tiposVisiveisPara(filtro);
        linhas.forEach(function(l) {
          l.style.display = (!visiveis || visiveis.indexOf(l.getAttribute('data-tipo')) !== -1) ? '' : 'none';
        });
        btns.forEach(function(b) { b.classList.toggle('ativo', b.getAttribute('data-filtro') === filtro); });
        if (filtro === 'conversa') {
          var n = CONTAGEM.erro + CONTAGEM.aviso + CONTAGEM.tecnico;
          badge.textContent = n > 0 ? ('🙈 ' + n + ' logs técnicos ocultos (' + CONTAGEM.erro + ' erros, ' + CONTAGEM.aviso + ' avisos)') : '';
        } else if (filtro === 'conversa-erros') {
          badge.textContent = CONTAGEM.tecnico > 0 ? ('🙈 ' + CONTAGEM.tecnico + ' logs técnicos ocultos') : '';
        } else {
          badge.textContent = '';
        }
        try { localStorage.setItem('bot_logs_filtro', filtro); } catch (e) {}
      }
      btns.forEach(function(b) {
        b.addEventListener('click', function() { aplicar(b.getAttribute('data-filtro')); });
      });
      var salvo = 'conversa';
      try { salvo = localStorage.getItem('bot_logs_filtro') || 'conversa'; } catch (e) {}
      aplicar(salvo);
    })();
  </script>
</body>
</html>`;
}
