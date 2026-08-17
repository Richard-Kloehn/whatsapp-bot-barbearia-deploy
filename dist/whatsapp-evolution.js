"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registrarHandlerCron = registrarHandlerCron;
exports.aoConectar = aoConectar;
exports.isReady = isReady;
exports.getEstado = getEstado;
exports.iniciarServidor = iniciarServidor;
exports.reinicializar = reinicializar;
exports.conectar = conectar;
exports.iniciarKeepalive = iniciarKeepalive;
exports.enviarMensagem = enviarMensagem;
exports.registrarHandlerMensagem = registrarHandlerMensagem;
/**
 * Conexão WhatsApp via Evolution API (REST + webhook), em vez de Baileys embutido no processo.
 *
 * DIFERENÇA DE ARQUITETURA IMPORTANTE: a Evolution API é um SERVIDOR SEPARADO (normalmente
 * rodando em Docker, na sua VPS ou num serviço tipo Railway/EasyPanel) que mantém a conexão
 * real com o WhatsApp. Este bot NÃO conecta mais diretamente ao WhatsApp — ele:
 *   1) manda comandos pra Evolution API via REST (criar instância, pedir QR, enviar mensagem);
 *   2) RECEBE mensagens de volta via um WEBHOOK — a Evolution API precisa conseguir fazer um
 *      POST HTTP pra este bot toda vez que chega uma mensagem nova. Ou seja, o endereço deste
 *      bot (EVOLUTION_WEBHOOK_URL) precisa ser alcançável pela Evolution API pela internet
 *      (não pode ser "localhost" a menos que os dois rodem no mesmo servidor/rede).
 *
 * Variáveis de ambiente necessárias no .env:
 *   EVOLUTION_API_URL      = URL base da sua Evolution API (ex: https://evolution.seudominio.com)
 *   EVOLUTION_API_KEY      = a apikey configurada no servidor da Evolution API
 *   EVOLUTION_INSTANCE     = nome da instância (ex: barbearia) — criado automaticamente se não existir
 *   EVOLUTION_WEBHOOK_URL  = URL pública deste bot + rota do webhook (ex: https://seubot.com/webhook/evolution)
 *
 * IMPORTANTE — payload do webhook pode variar por versão da Evolution API (v1 vs v2 mudaram
 * nomes de evento e alguns campos). Este arquivo tenta cobrir os formatos mais comuns
 * (documentados e vistos em uso real), mas é ALTAMENTE recomendado, no primeiro dia rodando,
 * observar o log "[evolution] Payload recebido (debug)" (fica ativo por padrão — desative
 * depois com EVOLUTION_DEBUG_WEBHOOK=false no .env) e comparar com o que este arquivo espera,
 * ajustando os pontos marcados com "AJUSTE SE NECESSARIO" caso sua versão difira.
 */
const http_1 = require('http');
const express = require('express');
const logger_1 = require('./logger');

const PORT = Number(process.env.PORT ?? 3002);
const EVOLUTION_API_URL = String(process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = String(process.env.EVOLUTION_API_KEY || '');
const EVOLUTION_INSTANCE = String(process.env.EVOLUTION_INSTANCE || 'barbearia');
const EVOLUTION_WEBHOOK_URL = String(process.env.EVOLUTION_WEBHOOK_URL || '');
const EVOLUTION_DEBUG_WEBHOOK = String(process.env.EVOLUTION_DEBUG_WEBHOOK || 'true').toLowerCase() !== 'false';

let estado = { status: 'initializing', qr: null, pairingCode: null, updatedAt: new Date().toISOString() };
let _ready = false;
let _everConnected = false;
let _onConectado = null;
let _cronHandler = null;
let _mensagemHandler = null;
let _pollTimer = null;

function registrarHandlerMensagem(fn) { _mensagemHandler = fn; }
function registrarHandlerCron(fn) { _cronHandler = fn; }
function aoConectar(cb) { _onConectado = cb; }
function isReady() { return _ready; }
function getEstado() { return estado; }

function setEstado(status, extra) {
    estado = { ...estado, status, updatedAt: new Date().toISOString(), ...(extra || {}) };
    console.log(`[evolution] Status: ${status}`);
}

function checarConfigObrigatoria() {
    const faltando = [];
    if (!EVOLUTION_API_URL) faltando.push('EVOLUTION_API_URL');
    if (!EVOLUTION_API_KEY) faltando.push('EVOLUTION_API_KEY');
    if (!EVOLUTION_WEBHOOK_URL) faltando.push('EVOLUTION_WEBHOOK_URL');
    if (faltando.length) {
        throw new Error(`[config] Variaveis obrigatorias ausentes para usar a Evolution API: ${faltando.join(', ')}. Defina no .env antes de iniciar o bot.`);
    }
}

// ── Cliente REST da Evolution API ────────────────────────────────────────────
async function evoFetch(caminho, opcoes = {}) {
    const resp = await fetch(`${EVOLUTION_API_URL}${caminho}`, {
        ...opcoes,
        headers: {
            'Content-Type': 'application/json',
            apikey: EVOLUTION_API_KEY,
            ...(opcoes.headers || {}),
        },
    });
    const texto = await resp.text();
    let corpo = null;
    try { corpo = texto ? JSON.parse(texto) : null; } catch { corpo = texto; }
    if (!resp.ok) {
        const msg = (corpo && (corpo.message || corpo.error)) || texto || resp.statusText;
        throw new Error(`Evolution API ${opcoes.method || 'GET'} ${caminho} -> ${resp.status}: ${JSON.stringify(msg)}`);
    }
    return corpo;
}

/** Cria a instância se ainda não existir (idempotente: ignora erro de "já existe"). */
async function garantirInstanciaCriada() {
    try {
        await evoFetch('/instance/create', {
            method: 'POST',
            body: JSON.stringify({
                instanceName: EVOLUTION_INSTANCE,
                qrcode: true,
                integration: 'WHATSAPP-BAILEYS',
                webhook: {
                    url: EVOLUTION_WEBHOOK_URL,
                    byEvents: false,
                    base64: true,
                    events: ['QRCODE_UPDATED', 'MESSAGES_UPSERT', 'CONNECTION_UPDATE'],
                },
                // AJUSTE SE NECESSARIO: em algumas versoes (v1) o webhook e configurado por
                // um endpoint separado (/webhook/set/{instance}) em vez de dentro do
                // /instance/create. Se a instancia for criada mas o webhook nao "pegar",
                // chame POST {EVOLUTION_API_URL}/webhook/set/{instance} manualmente com o
                // mesmo corpo do campo "webhook" acima.
            }),
        });
        console.log(`[evolution] Instancia "${EVOLUTION_INSTANCE}" criada.`);
    } catch (e) {
        // Idempotente: se a instancia ja existe, a API normalmente responde 403/409 com uma
        // mensagem mencionando isso — ignora e segue. Qualquer outro erro, propaga.
        const msg = (e && e.message || '').toLowerCase();
        if (msg.includes('already') || msg.includes('exist') || msg.includes('409') || msg.includes('403')) {
            console.log(`[evolution] Instancia "${EVOLUTION_INSTANCE}" ja existia — seguindo.`);
        } else {
            throw e;
        }
    }
}

/** Busca o QR/pairing code atual chamando /instance/connect/{instance}. */
async function buscarQrAtual() {
    // AJUSTE SE NECESSARIO: o campo com a imagem do QR varia por versao — tentamos os mais
    // comuns (base64, code, qrcode.base64) antes de desistir.
    const resp = await evoFetch(`/instance/connect/${EVOLUTION_INSTANCE}`, { method: 'GET' });
    const qrBase64 = resp?.base64 || resp?.code || resp?.qrcode?.base64 || null;
    const pairingCode = resp?.pairingCode || resp?.pairing_code || null;
    return { qrBase64, pairingCode };
}

/** Consulta o estado de conexao atual (usado no boot e como reforco, alem do webhook). */
async function consultarEstadoConexao() {
    try {
        const resp = await evoFetch(`/instance/connectionState/${EVOLUTION_INSTANCE}`, { method: 'GET' });
        // AJUSTE SE NECESSARIO: forma comum e { instance: { state: 'open'|'close'|'connecting' } }
        return resp?.instance?.state || resp?.state || null;
    } catch {
        return null;
    }
}

// ── Controle de processamento por cliente (telefone) — identico ao whatsapp.js ──
// (mesma logica de acumulo/fila/anti-concorrencia do modulo Baileys original — nao depende
// de qual biblioteca conecta ao WhatsApp por baixo, entao foi só copiada.)
const _acumulador = new Map();
const _processando = new Map();
const _filaPendente = new Map();
const DELAY_ACUMULACAO = 5000;
const _presenca = new Map();
const EXTENSAO_DIGITANDO = 3000;
const LIMITE_MAX_ESPERA = 25000;

function delayDigitacao(texto) {
    const base = Math.min(8000, Math.max(1500, (texto || '').length * 60));
    const variacao = Math.floor(Math.random() * 1000);
    return new Promise(resolve => setTimeout(resolve, base + variacao));
}

async function enviarPresenca(numero, presence) {
    try {
        // AJUSTE SE NECESSARIO: endpoint/campos de presenca variam por versao. Isto e
        // "melhor esforco" — se falhar (404/erro), o bot continua normalmente, so perde o
        // efeito visual de "digitando..." no WhatsApp do cliente.
        await evoFetch(`/chat/sendPresence/${EVOLUTION_INSTANCE}`, {
            method: 'POST',
            body: JSON.stringify({ number: numero, presence, delay: 1200 }),
        });
    } catch { /* best-effort, ignora falha */ }
}

async function processarMensagemUsuario(phone, texto, numeroConfiavel) {
    try {
        enviarPresenca(phone, 'composing').catch(() => {});
        const resposta = await _mensagemHandler(phone, texto, numeroConfiavel);
        await delayDigitacao(resposta);
        await enviarMensagem(phone, resposta);
        console.log(`[bot-ia] Resposta enviada para ${phone}`);
    } catch (err) {
        console.error('[bot-ia] Erro:', err.message);
        try { await enviarMensagem(phone, 'Desculpe, tive um problema. Tente novamente.'); } catch { /* ok */ }
    } finally {
        _processando.set(phone, false);
        const pendente = _filaPendente.get(phone);
        if (pendente) {
            _filaPendente.delete(phone);
            _processando.set(phone, true);
            setTimeout(() => processarMensagemUsuario(phone, pendente.texto, pendente.numeroConfiavel), 100);
        }
    }
}

function agendarProcessamento(phone, numeroConfiavel) {
    const ac = _acumulador.get(phone);
    if (!ac) return;
    if (_presenca.get(phone) === 'composing') {
        const inicio = ac.inicioEspera || Date.now();
        ac.inicioEspera = inicio;
        if (Date.now() - inicio < LIMITE_MAX_ESPERA) {
            ac.timer = setTimeout(() => agendarProcessamento(phone, numeroConfiavel), EXTENSAO_DIGITANDO);
            return;
        }
        console.log(`[bot-ia] Cliente ${phone} ainda "digitando" apos ${LIMITE_MAX_ESPERA / 1000}s — processando mesmo assim (limite de seguranca).`);
    }
    const textoJunto = ac.textos.join('\n');
    _acumulador.delete(phone);
    console.log(`[bot-ia] Mensagem de ${phone}: ${textoJunto.substring(0, 120)}`);
    if (_processando.get(phone)) {
        _filaPendente.set(phone, { texto: textoJunto, numeroConfiavel });
        return;
    }
    _processando.set(phone, true);
    processarMensagemUsuario(phone, textoJunto, numeroConfiavel);
}

// ── Página HTML do QR (igual a original, so troca a fonte do QR) ────────────
function paginaQR(chaveAtual) {
    const sufixoChave = chaveAtual ? `?chave=${encodeURIComponent(chaveAtual)}` : '';
    const st = estado;
    const statusMsg = {
        initializing: '⏳ Iniciando conexão...',
        qr: '📱 Escaneie o QR Code abaixo',
        ready: '✅ WhatsApp conectado e enviando lembretes!',
        disconnected: '⚠️ Desconectado. Reconectando...',
        auth_failure: '❌ Sessão encerrada. Clique em "Gerar novo QR".',
    };
    // A Evolution normalmente já devolve o QR pronto em base64 (data:image/png;base64,...).
    // Se por algum motivo vier só a string crua (não um data URI), cai pro qrserver.com como
    // fallback, igual a versão Baileys fazia.
    const qrSrc = st.qr
        ? (st.qr.startsWith('data:') ? st.qr : `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(st.qr)}`)
        : null;
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Bot — Barbearia (Evolution API)</title>
  ${st.status !== 'ready' ? `<script>
    setInterval(function() {
      fetch('/status${sufixoChave}').then(function(r){return r.json();}).then(function(st){
        if (st.qr !== ${JSON.stringify(st.qr)} || st.status !== ${JSON.stringify(st.status)}) location.reload();
      }).catch(function(){});
    }, 3000);
  </script>` : ''}
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:sans-serif;background:#0e0e0e;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
    .card{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:16px;padding:40px 32px;max-width:400px;width:100%;text-align:center}
    h1{font-size:18px;color:#25d366;margin-bottom:4px}
    .sub{color:#666;font-size:12px;margin-bottom:24px}
    .status{font-size:16px;margin:16px 0 8px}
    .qr{border-radius:12px;margin:12px 0}
    .spinner{width:48px;height:48px;border:4px solid #333;border-top-color:#25d366;border-radius:50%;animation:spin 1s linear infinite;margin:20px auto}
    @keyframes spin{to{transform:rotate(360deg)}}
    .hint{color:#555;font-size:12px;margin-top:12px}
    .btn{margin-top:16px;padding:12px 24px;background:#25d366;color:#000;font-weight:bold;border:none;border-radius:8px;cursor:pointer;font-size:14px;width:100%}
    .connected{font-size:56px;margin:12px 0}
    .badge{display:inline-block;padding:4px 10px;border-radius:20px;font-size:11px;margin-bottom:16px}
    .badge.ok{background:#25d36622;color:#25d366;border:1px solid #25d36644}
    .badge.err{background:#ef444422;color:#ef4444;border:1px solid #ef444444}
    .badge.warn{background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b44}
  </style>
</head>
<body>
<div class="card">
  <h1>💬 Bot WhatsApp — Barbearia</h1>
  <p class="sub">Via Evolution API · instância "${EVOLUTION_INSTANCE}"</p>

  ${st.status === 'ready' ? `
    <div class="connected">✅</div>
    <span class="badge ok">Conectado</span>
    <div class="status">Enviando lembretes automaticamente</div>
    <p class="hint">Esta janela pode ser fechada. O bot continua rodando.</p>
  ` : st.pairingCode ? `
    <span class="badge warn">Código de pareamento</span>
    <div class="status">Digite este código no celular</div>
    <div style="font-size:32px;letter-spacing:4px;font-weight:bold;color:#25d366;margin:20px 0;">${st.pairingCode}</div>
    <p class="hint">WhatsApp → Menu (⋮) → Dispositivos conectados → Conectar dispositivo → Conectar com número de telefone</p>
  ` : qrSrc ? `
    <span class="badge warn">Aguardando leitura</span>
    <div class="status">${statusMsg[st.status] || ''}</div>
    <p class="hint">WhatsApp → Menu (⋮) → Dispositivos conectados → Conectar dispositivo</p>
    <img src="${qrSrc}" width="280" height="280" class="qr" alt="QR Code">
    <p class="hint">A página atualiza sozinha quando o QR mudar.</p>
  ` : `
    <div class="spinner"></div>
    <div class="status">${statusMsg[st.status] ?? 'Aguarde...'}</div>
    <p class="hint">A página atualiza automaticamente...</p>
  `}
  <form method="POST" action="/reconnect${sufixoChave}" style="margin-top:20px;border-top:1px solid #2a2a2a;padding-top:16px;">
    <button class="btn" type="submit">📲 Gerar novo QR Code</button>
  </form>
  <p class="hint" style="margin-top:20px;color:#333">Atualizado: ${new Date(st.updatedAt).toLocaleTimeString('pt-BR')}</p>
</div>
</body>
</html>`;
}

// ── Servidor HTTP (QR + status + webhook da Evolution) ──────────────────────
function iniciarServidor() {
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: false }));

    const PAINEL_SECRET = process.env.PAINEL_SECRET;
    function checarSenhaPainel(req, res, next) {
        if (!PAINEL_SECRET) return next();
        if (req.query['chave'] === PAINEL_SECRET) return next();
        res.status(401).send('Acesso negado. Use ?chave=SEU_PAINEL_SECRET na URL.');
    }

    app.get('/', checarSenhaPainel, (req, res) => res.send(paginaQR(PAINEL_SECRET ? req.query['chave'] : null)));
    app.get('/qr', checarSenhaPainel, (req, res) => res.send(paginaQR(PAINEL_SECRET ? req.query['chave'] : null)));
    app.get('/status', checarSenhaPainel, (_req, res) => res.json(estado));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/logs', checarSenhaPainel, (_req, res) => res.send((0, logger_1.paginaLogs)()));

    app.all('/cron/run', (req, res) => {
        const secret = process.env.CRON_SECRET;
        if (secret && req.query['secret'] !== secret) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        res.json({ ok: true, message: 'Ciclo de lembretes iniciado', ts: new Date().toISOString() });
        if (_cronHandler) _cronHandler().catch(console.error);
        else console.warn('[cron/run] Handler não registrado ainda');
    });

    app.post('/reconnect', checarSenhaPainel, (req, res) => {
        const destino = PAINEL_SECRET && req.query['chave'] ? `/?chave=${encodeURIComponent(String(req.query['chave']))}` : '/';
        res.redirect(destino);
        setTimeout(() => reinicializar().catch(console.error), 500);
    });

    // ── Webhook: a Evolution API faz POST aqui a cada evento ────────────────
    // A rota tem que bater com o que voce configurou em EVOLUTION_WEBHOOK_URL.
    app.post('/webhook/evolution', async (req, res) => {
        res.json({ ok: true }); // responde rapido, processa depois — evita a Evolution reenviar por timeout
        try {
            await tratarWebhookEvolution(req.body);
        } catch (e) {
            console.error('[evolution] Erro ao tratar webhook:', e && e.message);
        }
    });

    app.listen(PORT, () => {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`  🌐 Painel QR disponível em: http://localhost:${PORT}`);
        console.log(`  🔗 Webhook esperado em: ${EVOLUTION_WEBHOOK_URL || '(EVOLUTION_WEBHOOK_URL não definida!)'}`);
        console.log(`${'─'.repeat(50)}\n`);
    });
}

// ── Processamento dos eventos recebidos via webhook ──────────────────────────
async function tratarWebhookEvolution(body) {
    if (!body) return;
    if (EVOLUTION_DEBUG_WEBHOOK) {
        console.log('[evolution] Payload recebido (debug):', JSON.stringify(body).slice(0, 500));
    }
    // AJUSTE SE NECESSARIO: nomes de evento variam entre versoes ("MESSAGES_UPSERT" vs
    // "messages.upsert"). Normaliza pra minusculo/pontuado antes de comparar, pra cobrir os
    // dois formatos sem duplicar logica.
    const eventoNorm = String(body.event || '').toLowerCase().replace(/_/g, '.');
    const data = body.data;
    if (!data) return;

    if (eventoNorm.includes('qrcode')) {
        const qr = data.qrcode?.base64 || data.base64 || data.qrcode || data.code || null;
        if (qr) {
            setEstado('qr', { qr });
            console.log('[evolution] QR pronto — acesse o painel para escanear');
        }
        return;
    }

    if (eventoNorm.includes('connection')) {
        const novoEstado = data.state || data.status || null; // 'open' | 'connecting' | 'close'
        if (novoEstado === 'open') {
            _ready = true;
            const primeiraConexao = !_everConnected;
            _everConnected = true;
            setEstado('ready', { qr: null, pairingCode: null });
            console.log('[evolution] ✅ Conectado e pronto para enviar!');
            if (primeiraConexao && _onConectado) {
                const cb = _onConectado;
                _onConectado = null;
                setTimeout(() => cb(), 3000);
            }
        } else if (novoEstado === 'close') {
            _ready = false;
            console.warn('[evolution] Conexão fechada pela Evolution API.');
            setEstado('disconnected');
            // Nao tenta reconectar manualmente aqui — isso e responsabilidade do PROPRIO
            // servidor Evolution API (ele reconecta sozinho ao WhatsApp por baixo). O bot so
            // reflete o estado. Se ficar parado por muito tempo, use o botao "Gerar novo QR".
        } else if (novoEstado === 'connecting') {
            setEstado('initializing');
        }
        return;
    }

    if (eventoNorm.includes('messages.upsert')) {
        // Alguns eventos vem como array em data.messages[], outros como um unico objeto em
        // data (com data.key/data.message direto). Normaliza pra sempre iterar uma lista.
        const mensagens = Array.isArray(data.messages) ? data.messages : (data.key ? [data] : []);
        if (!global._botMsgIds) global._botMsgIds = new Set();
        for (const msg of mensagens) {
            await tratarMensagemRecebida(msg);
        }
    }
}

async function tratarMensagemRecebida(msg) {
    if (!msg || !msg.key || !_mensagemHandler) return;
    if (msg.key.fromMe) return; // ignora mensagens enviadas pelo proprio bot/numero
    const jid = msg.key.remoteJid || '';
    if (jid.endsWith('@g.us')) return; // ignora grupos
    if (msg.key.id) {
        if (global._botMsgIds.has(msg.key.id)) return;
        global._botMsgIds.add(msg.key.id);
        if (global._botMsgIds.size > 500) global._botMsgIds.delete(global._botMsgIds.values().next().value);
    }
    const ehLid = jid.endsWith('@lid');
    const phone = jid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '');
    if (!phone) return;
    const numeroConfiavel = !ehLid;

    if (msg.message?.audioMessage || msg.message?.pttMessage) {
        try { await enviarMensagem(phone, 'Oi! Por enquanto só consigo entender mensagens de texto. Pode me escrever o que precisa? 😊'); } catch { /* ok */ }
        return;
    }
    const texto = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.buttonsResponseMessage?.selectedButtonId
        || '';
    if (!texto.trim()) return;

    _presenca.delete(phone);
    const ac = _acumulador.get(phone);
    if (ac) {
        clearTimeout(ac.timer);
        ac.textos.push(texto.trim());
    } else {
        _acumulador.set(phone, { textos: [texto.trim()] });
    }
    const atual = _acumulador.get(phone);
    atual.timer = setTimeout(() => agendarProcessamento(phone, numeroConfiavel), DELAY_ACUMULACAO);
}

/**
 * Keepalive: pinga o próprio /health a cada 4 minutos.
 * Impede que o processo seja morto por inatividade na Hostinger.
 */
function iniciarKeepalive() {
    const INTERVALO = 4 * 60 * 1000;
    setInterval(() => {
        const req = http_1.get(`http://localhost:${PORT}/health`, (res) => { res.resume(); });
        req.on('error', (err) => console.warn('[keepalive] Ping falhou:', err.message));
        req.end();
    }, INTERVALO);
    console.log('[keepalive] Iniciado — processo será mantido ativo com ping a cada 4 minutos');
}

/**
 * Envia uma mensagem WhatsApp via Evolution API.
 * O numero pode vir so com digitos (DDI+DDD+numero) — a Evolution normaliza internamente
 * na maioria das versoes, mas mantemos a mesma limpeza de digitos da versao Baileys por
 * consistencia e para reduzir chance de erro 400 por formato.
 */
async function enviarMensagem(fone, texto) {
    if (!_ready) throw new Error('WhatsApp não está conectado');
    const digits = String(fone).replace(/\D/g, '');
    const numero = digits.startsWith('55') ? digits : `55${digits}`;
    await evoFetch(`/message/sendText/${EVOLUTION_INSTANCE}`, {
        method: 'POST',
        body: JSON.stringify({ number: numero, text: texto }),
    });
}

async function reinicializar() {
    _ready = false;
    _everConnected = false;
    setEstado('initializing', { qr: null, pairingCode: null });
    try {
        await evoFetch(`/instance/logout/${EVOLUTION_INSTANCE}`, { method: 'DELETE' });
    } catch { /* ok, pode nao existir ainda */ }
    await conectar();
}

async function conectar() {
    checarConfigObrigatoria();
    setEstado('initializing');
    console.log('[evolution] Conectando à Evolution API...');
    await garantirInstanciaCriada();

    // Estado inicial: tenta puxar via REST (o webhook so avisa de eventos NOVOS a partir de
    // agora — se o bot reiniciar enquanto ja estava conectado, precisa perguntar o estado
    // atual pra nao ficar preso em "initializing" para sempre).
    const estadoAtual = await consultarEstadoConexao();
    if (estadoAtual === 'open') {
        _ready = true;
        _everConnected = true;
        setEstado('ready', { qr: null, pairingCode: null });
        console.log('[evolution] ✅ Já estava conectado.');
        if (_onConectado) {
            const cb = _onConectado;
            _onConectado = null;
            setTimeout(() => cb(), 3000);
        }
    } else {
        try {
            const { qrBase64, pairingCode } = await buscarQrAtual();
            if (qrBase64) setEstado('qr', { qr: qrBase64, pairingCode });
        } catch (e) {
            console.warn('[evolution] Não foi possível buscar QR inicial (normal se a instância acabou de ser criada — aguardando webhook):', e.message);
        }
    }

    // Reforco: alem do webhook (que deveria manter tudo atualizado em tempo real), consulta
    // o estado a cada 30s como rede de seguranca — cobre o caso do webhook nao chegar por
    // algum problema de rede/config entre os dois servidores.
    if (_pollTimer) clearInterval(_pollTimer);
    _pollTimer = setInterval(async () => {
        if (_ready) return; // so precisa reforcar enquanto NAO esta pronto
        const st = await consultarEstadoConexao();
        if (st === 'open' && !_ready) {
            _ready = true;
            const primeiraConexao = !_everConnected;
            _everConnected = true;
            setEstado('ready', { qr: null, pairingCode: null });
            console.log('[evolution] ✅ Conectado (detectado via polling de reforço).');
            if (primeiraConexao && _onConectado) {
                const cb = _onConectado;
                _onConectado = null;
                setTimeout(() => cb(), 3000);
            }
        }
    }, 30000);
}
