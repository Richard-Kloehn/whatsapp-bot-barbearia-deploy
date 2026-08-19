"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
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
 * Conexão WhatsApp via Baileys.
 *
 * Sessão persistida em arquivo (.wwebjs_auth/baileys/).
 * QR Code acessível via página HTML na porta configurada.
 *
 * Anti-ban:
 * - Delay aleatório entre mensagens (10–20s)
 * - Só envia no horário comercial
 * - Reconexão automática em quedas de rede
 * - Não gera novo QR automaticamente após expirar (aguarda ação manual)
 */
const baileys_1 = __importStar(require("@whiskeysockets/baileys"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const http_1 = __importDefault(require("http"));
const express_1 = __importDefault(require("express"));
const logger_1 = require("./logger");
const AUTH_DIR = path_1.default.join(process.cwd(), '.wwebjs_auth', 'baileys');
const PORT = Number(process.env.PORT ?? 3002);
let estado = { status: 'initializing', qr: null, pairingCode: null, updatedAt: new Date().toISOString() };
let _pairingRequested = false;
let sock = null;
let _ready = false;
let _falhasReconexaoConsecutivas = 0; // (auto-recuperacao) zera ao conectar, conta no loop de reconexao generico
let _everConnected = false;
let _qrShown = false;
let _onConectado = null;
let _cronHandler = null;
let _mensagemHandler = null;
function registrarHandlerMensagem(fn) { _mensagemHandler = fn; }
/** Registra o handler chamado pelo endpoint /cron/run */
function registrarHandlerCron(fn) {
    _cronHandler = fn;
}
/** Registra callback chamado na primeira conexão bem-sucedida */
function aoConectar(cb) {
    _onConectado = cb;
}
const silentLogger = {
    level: 'silent',
    trace: () => { }, debug: () => { }, info: () => { },
    warn: () => { }, error: () => { }, fatal: () => { },
    child: function () { return this; },
};
/**
 * Aguarda um tempo proporcional ao tamanho da resposta, simulando digitação humana.
 * Evita respostas instantâneas demais, que são um dos sinais usados para detectar bots.
 * ~60ms por caractere, com piso de 1.5s e teto de 8s, mais uma variação aleatória.
 */
function delayDigitacao(texto) {
    const base = Math.min(8000, Math.max(1500, (texto || '').length * 60));
    const variacao = Math.floor(Math.random() * 1000);
    return new Promise(resolve => setTimeout(resolve, base + variacao));
}
function setEstado(status, qr) {
    estado = { status, qr: qr ?? null, pairingCode: estado.pairingCode ?? null, updatedAt: new Date().toISOString() };
    console.log(`[whatsapp] Status: ${status}`);
}
function isReady() { return _ready; }
function getEstado() { return estado; }

// ── Controle de processamento por cliente (telefone) ─────────────────────────
// CORRECAO CRITICA: estas estruturas ficavam declaradas DENTRO de conectar(), entao toda
// vez que o bot reconectava (ex: erros "Bad MAC", quedas de rede — o que podia acontecer
// varias vezes por minuto) elas eram recriadas do zero. Isso destruia a garantia de "so
// processa uma mensagem por vez por cliente": uma chamada de processarMensagemUsuario()
// iniciada ANTES de uma reconexao continuava rodando (e possivelmente ainda demorando,
// aguardando resposta da IA) usando o Map _processando ANTIGO, enquanto uma mensagem nova
// do MESMO cliente chegada DEPOIS da reconexao era tratada pelo Map _processando NOVO (vazio)
// e processada em paralelo — duas execucoes concorrentes mexendo no mesmo estado de conversa
// ao mesmo tempo (corrupcao de estado por concorrencia). Motivo do fix: declarar essas
// estruturas UMA UNICA VEZ no escopo do modulo, para que sobrevivam a qualquer numero de
// reconexoes durante a vida do processo.
// _acumulador: { timer, textos[], jid, numeroConfiavel } — aguarda DELAY_ACUMULACAO antes de processar, juntando mensagens enviadas em sequencia rapida
// _processando: garante que so 1 lote por telefone seja processado por vez
// _filaPendente: se chegar novo lote enquanto processa, guarda o mais recente
const _acumulador = new Map();
const _processando = new Map();
const _filaPendente = new Map();
const DELAY_ACUMULACAO = 5000; // ms para aguardar mais mensagens antes de processar
// (v3.32.5) Detecta se o cliente ainda esta digitando (evento de presenca do WhatsApp) —
// se estiver, adia o processamento em vez de responder no meio da digitacao dele. Nem
// todo contato compartilha presenca (depende da privacidade dele), entao isso e um
// reforco best-effort por cima do timer normal de 5s, nunca uma dependencia — se a
// presenca nunca chegar, o comportamento cai de volta pro timer de sempre.
const _presenca = new Map(); // phone -> 'composing' | 'available' | 'paused' | outro
const EXTENSAO_DIGITANDO = 3000; // ms de espera extra quando detecta "composing"
const LIMITE_MAX_ESPERA = 25000; // nunca adia mais que isso no total, por seguranca

async function processarMensagemUsuario(phone, jid, texto, numeroConfiavel) {
    try {
        if (sock) await sock.sendPresenceUpdate('composing', jid);
        const resposta = await _mensagemHandler(phone, texto, numeroConfiavel);
        await delayDigitacao(resposta);
        if (sock) await sock.sendMessage(jid, { text: resposta });
        console.log(`\n${'─'.repeat(80)}`);
        console.log(`[bot-ia] 👤 CLIENTE (${phone}): ${texto.substring(0, 150)}${texto.length > 150 ? '...' : ''}`);
        console.log(`[bot-ia] 🤖 BOT RESPONDEU: ${resposta.substring(0, 150)}${resposta.length > 150 ? '...' : ''}`);
        console.log(`${'─'.repeat(80)}\n`);
    } catch (err) {
        console.error('[bot-ia] Erro:', err.message);
        try { if (sock) await sock.sendMessage(jid, { text: 'Desculpe, tive um problema. Tente novamente.' }); } catch { /* ok */ }
    } finally {
        _processando.set(phone, false);
        const pendente = _filaPendente.get(phone);
        if (pendente) {
            _filaPendente.delete(phone);
            _processando.set(phone, true);
            setTimeout(() => processarMensagemUsuario(phone, pendente.jid, pendente.texto, pendente.numeroConfiavel), 100);
        }
    }
}

function agendarProcessamento(phone, jid, numeroConfiavel) {
    const ac = _acumulador.get(phone);
    // (v3.32.5) Se o cliente ainda esta digitando (presenca "composing"), adia mais um
    // pouco em vez de processar agora — ate um limite maximo, pra nao esperar pra sempre
    // se a presenca ficar presa ou nao for mais atualizada.
    if (_presenca.get(phone) === 'composing') {
        const inicio = ac.inicioEspera || Date.now();
        ac.inicioEspera = inicio;
        if (Date.now() - inicio < LIMITE_MAX_ESPERA) {
            ac.timer = setTimeout(() => agendarProcessamento(phone, jid, numeroConfiavel), EXTENSAO_DIGITANDO);
            return;
        }
        console.log(`[bot-ia] Cliente ${phone} ainda "digitando" apos ${LIMITE_MAX_ESPERA / 1000}s — processando mesmo assim (limite de seguranca).`);
    }
    const textoJunto = ac.textos.join('\n');
    _acumulador.delete(phone);
    console.log(`[bot-ia] ⏳ Processando mensagem de ${phone} (${textoJunto.length} caracteres)...`);
    if (_processando.get(phone)) {
        _filaPendente.set(phone, { jid, texto: textoJunto, numeroConfiavel });
        return;
    }
    _processando.set(phone, true);
    processarMensagemUsuario(phone, jid, textoJunto, numeroConfiavel);
}
// ── Página HTML do QR ────────────────────────────────────────────────────────
function paginaQR(chaveAtual) {
    const sufixoChave = chaveAtual ? `?chave=${encodeURIComponent(chaveAtual)}` : '';
    const st = estado;
    const statusMsg = {
        initializing: '⏳ Iniciando conexão...',
        qr: '📱 Escaneie o QR Code abaixo',
        ready: '✅ WhatsApp conectado e enviando lembretes!',
        disconnected: '⚠️ Desconectado. Reconectando em 30s...',
        auth_failure: '❌ Sessão encerrada. Clique em "Gerar novo QR".',
        qr_timeout: '⏳ QR expirou. Clique em "Gerar novo QR".',
    };
    const qrUrl = st.qr
        ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=10&data=${encodeURIComponent(st.qr)}`
        : null;
    const precisaBotao = st.status === 'qr_timeout' || st.status === 'auth_failure';
    const autoRefresh = st.status !== 'ready' && st.status !== 'qr_timeout' && st.status !== 'auth_failure';
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>WhatsApp Bot — Barbearia</title>
  ${autoRefresh ? `<script>
    setInterval(function() {
      var input = document.getElementById('pairPhone');
      if (input && (document.activeElement === input || input.value)) return; // não recarrega enquanto o usuário digita
      fetch('/status${sufixoChave}').then(function(r){return r.json();}).then(function(st){
        if (st.qr !== ${JSON.stringify(qrUrl ? st.qr : null)} || st.status !== ${JSON.stringify(st.status)} || st.pairingCode !== ${JSON.stringify(st.pairingCode)}) {
          location.reload();
        }
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
    .btn:hover{background:#1da851}
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
  <p class="sub">Lembretes automáticos 24h antes dos agendamentos</p>

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
    <p class="hint">O código expira em alguns minutos.</p>
    <form method="POST" action="/reconnect${sufixoChave}" style="margin-top:20px;border-top:1px solid #2a2a2a;padding-top:16px;">
      <button class="btn" type="submit">📲 Voltar para QR Code</button>
    </form>
  ` : qrUrl ? `
    <span class="badge warn">Aguardando leitura</span>
    <div class="status">${statusMsg[st.status]}</div>
    <p class="hint">WhatsApp → Menu (⋮) → Dispositivos conectados → Conectar dispositivo</p>
    <img src="${qrUrl}" width="280" height="280" class="qr" alt="QR Code">
    <p class="hint">O QR expira em ~20s. A página atualiza sozinha.</p>
    <form method="POST" action="/pair${sufixoChave}" style="margin-top:20px;border-top:1px solid #2a2a2a;padding-top:16px;">
      <p class="hint" style="margin-bottom:8px;">Só tem o celular? Conecte por código:</p>
      <input type="tel" id="pairPhone" name="phone" placeholder="5511999999999" required
        style="width:100%;padding:10px;border-radius:8px;border:1px solid #333;background:#0e0e0e;color:#fff;text-align:center;margin-bottom:8px;font-size:16px;">
      <button class="btn" type="submit">🔢 Gerar código de pareamento</button>
    </form>
  ` : precisaBotao ? `
    <span class="badge err">${statusMsg[st.status]}</span>
    <form method="POST" action="/reconnect${sufixoChave}">
      <button class="btn" type="submit">📲 Gerar novo QR Code</button>
    </form>
    <p class="hint">Clique para gerar um novo QR e escanear novamente.</p>
  ` : `
    <div class="spinner"></div>
    <div class="status">${statusMsg[st.status] ?? 'Aguarde...'}</div>
    <p class="hint">A página atualiza automaticamente...</p>
  `}

  <p class="hint" style="margin-top:20px;color:#333">Atualizado: ${new Date(st.updatedAt).toLocaleTimeString('pt-BR')}</p>
</div>
</body>
</html>`;
}
// ── Servidor HTTP (QR + status) ───────────────────────────────────────────────
function iniciarServidor() {
    const app = (0, express_1.default)();
    app.use(express_1.default.urlencoded({ extended: false }));
    // PROTECAO OPCIONAL DO PAINEL: sem isso, qualquer pessoa que descubra a URL do painel
    // (/, /qr) pode escanear o QR Code e ASSUMIR a sessao do WhatsApp da barbearia, ou ler
    // telefones de clientes em /logs — nenhuma dessas rotas pedia senha antes. Se a variavel
    // PAINEL_SECRET estiver definida no .env, essas rotas passam a exigir "?chave=SEU_TOKEN"
    // na URL. Sem PAINEL_SECRET definido, o comportamento antigo (sem senha) e mantido, para
    // nao quebrar quem ja usa o painel sem essa variavel configurada — mas e FORTEMENTE
    // recomendado configurar PAINEL_SECRET em producao.
    const PAINEL_SECRET = process.env.PAINEL_SECRET;
    function checarSenhaPainel(req, res, next) {
        if (!PAINEL_SECRET) return next(); // sem variavel configurada, comportamento antigo
        if (req.query['chave'] === PAINEL_SECRET) return next();
        res.status(401).send('Acesso negado. Use ?chave=SEU_PAINEL_SECRET na URL.');
    }
    app.get('/', checarSenhaPainel, (req, res) => res.send(paginaQR(PAINEL_SECRET ? req.query['chave'] : null)));
    app.get('/qr', checarSenhaPainel, (req, res) => res.send(paginaQR(PAINEL_SECRET ? req.query['chave'] : null)));
    app.get('/status', checarSenhaPainel, (_req, res) => res.json(estado));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    app.get('/logs', checarSenhaPainel, (_req, res) => res.send((0, logger_1.paginaLogs)()));
    // Endpoint para cron externo (Hostinger cPanel → chame a cada 15 min)
    // GET ou POST /cron/run?secret=SEU_TOKEN
    app.all('/cron/run', (req, res) => {
        const secret = process.env.CRON_SECRET;
        if (secret && req.query['secret'] !== secret) {
            res.status(403).json({ error: 'Forbidden' });
            return;
        }
        res.json({ ok: true, message: 'Ciclo de lembretes iniciado', ts: new Date().toISOString() });
        if (_cronHandler) {
            _cronHandler().catch(console.error);
        }
        else {
            console.warn('[cron/run] Handler não registrado ainda');
        }
    });
    // Botão "Gerar novo QR" → reinicia conexão
    app.post('/reconnect', checarSenhaPainel, (req, res) => {
        const destino = PAINEL_SECRET && req.query['chave'] ? `/?chave=${encodeURIComponent(String(req.query['chave']))}` : '/';
        res.redirect(destino);
        setTimeout(() => reinicializar().catch(console.error), 500);
    });
    // Conectar via código de pareamento (para quem só tem o celular)
    app.post('/pair', checarSenhaPainel, async (req, res) => {
        const destino = PAINEL_SECRET && req.query['chave'] ? `/?chave=${encodeURIComponent(String(req.query['chave']))}` : '/';
        const phone = String(req.body?.phone ?? '').replace(/\D/g, '');
        if (!phone) {
            res.redirect(destino);
            return;
        }
        try {
            if (!sock) throw new Error('Conexão ainda não iniciada');
            const code = await sock.requestPairingCode(phone);
            estado = { ...estado, pairingCode: code };
            console.log(`[whatsapp] Código de pareamento gerado para ${phone}: ${code}`);
        }
        catch (err) {
            console.error('[whatsapp] Erro ao gerar código de pareamento:', err.message);
        }
        res.redirect(destino);
    });
    app.listen(PORT, () => {
        console.log(`\n${'─'.repeat(50)}`);
        console.log(`  🌐 Painel QR disponível em: http://localhost:${PORT}`);
        console.log(`${'─'.repeat(50)}\n`);
    });
}
// ── Conexão Baileys ──────────────────────────────────────────────────────────
async function reinicializar() {
    _ready = false;
    _everConnected = false;
    _qrShown = false;
    if (sock) {
        try {
            sock.end(undefined);
        }
        catch { /* ok */ }
        sock = null;
    }
    try {
        fs_1.default.rmSync(AUTH_DIR, { recursive: true, force: true });
    }
    catch { /* ok */ }
    await conectar();
}
async function conectar() {
    estado = { ...estado, pairingCode: null };
    setEstado('initializing');
    console.log('[whatsapp] Iniciando conexão...');
    fs_1.default.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await (0, baileys_1.useMultiFileAuthState)(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try {
        const r = await (0, baileys_1.fetchLatestBaileysVersion)();
        version = r.version;
        console.log(`[whatsapp] Versão WA Web: ${version.join('.')}`);
    }
    catch {
        console.warn('[whatsapp] Usando versão padrão');
    }
    sock = (0, baileys_1.default)({
        version,
        auth: state,
        browser: baileys_1.Browsers.ubuntu('Chrome'),
        logger: silentLogger,
        getMessage: async () => undefined,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
        if (qr) {
            _qrShown = true;
            setEstado('qr', qr);
            console.log('[whatsapp] QR pronto — acesse o painel para escanear');
        }
        if (connection === 'connecting')
            setEstado('initializing');
        if (connection === 'open') {
            _ready = true;
            _everConnected = true;
            _falhasReconexaoConsecutivas = 0;
            estado = { ...estado, pairingCode: null };
            setEstado('ready');
            console.log('[whatsapp] ✅ Conectado e pronto para enviar!');
            // Dispara ciclo imediato de lembretes ao conectar
            if (_onConectado) {
                const cb = _onConectado;
                _onConectado = null; // executa só uma vez por conexão
                setTimeout(() => cb(), 3000);
            }
        }
        if (connection === 'close') {
            _ready = false;
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === baileys_1.DisconnectReason.loggedOut;
            if (loggedOut) {
                console.warn('[whatsapp] Sessão encerrada pelo celular.');
                setEstado('auth_failure');
                try {
                    fs_1.default.rmSync(AUTH_DIR, { recursive: true, force: true });
                }
                catch { /* ok */ }
                sock = null;
                // Aguarda ação manual no painel
            }
            else if (code === baileys_1.DisconnectReason.restartRequired || code === 515) {
                console.log('[whatsapp] Reinício do Baileys — reconectando...');
                sock = null;
                setTimeout(() => conectar(), 2000);
            }
            else if (!_everConnected && _qrShown) {
                console.warn('[whatsapp] QR expirou sem ser escaneado.');
                setEstado('qr_timeout');
                sock = null;
                // Aguarda botão no painel
            }
            else {
                _falhasReconexaoConsecutivas++;
                // Auto-recuperacao: alguns erros de sessao invalida (ex: codigo 428, "Connection
                // Closed") nao sao classificados como "loggedOut" pelo Baileys, entao o codigo
                // nunca limpava a sessao sozinho — ficava tentando reconectar com credenciais
                // quebradas para sempre, sem nunca voltar a pedir QR code. Depois de algumas
                // falhas seguidas sem NUNCA ter conectado de novo, assume que a sessao esta
                // corrompida e limpa ela mesma, forcando um QR code novo — sem precisar entrar
                // no servidor manualmente para apagar a pasta.
                if (_falhasReconexaoConsecutivas >= 3) {
                    console.warn(`[whatsapp] ${_falhasReconexaoConsecutivas} falhas de reconexao seguidas — sessao provavelmente corrompida, limpando e pedindo QR novo.`);
                    try {
                        fs_1.default.rmSync(AUTH_DIR, { recursive: true, force: true });
                    }
                    catch { /* ok */ }
                    _falhasReconexaoConsecutivas = 0;
                    sock = null;
                    setTimeout(() => conectar(), 2000);
                }
                else {
                    console.warn(`[whatsapp] Desconectado (${code}). Reconectando em 30s...`);
                    setEstado('disconnected');
                    sock = null;
                    setTimeout(() => conectar(), 30000);
                }
            }
        }
    });

    // Acumulador de mensagens: as estruturas de controle (_acumulador, _processando,
    // _filaPendente, _presenca) e as funcoes que as usam agora vivem no ESCOPO DO MODULO
    // (fora de conectar()) — ver bloco logo acima de isReady()/getEstado() — para garantir
    // que sobrevivam a qualquer numero de reconexoes durante a vida do processo. Aqui dentro
    // de conectar() ficam SOMENTE os listeners do socket atual, que precisam ser religados
    // a cada nova conexao porque `sock` e um objeto novo a cada chamada.
    // (v3.32.5) Escuta presenca ("digitando...") dos contatos — usado por agendarProcessamento
    // para adiar a resposta enquanto o cliente ainda esta escrevendo. Nem todo contato expõe
    // isso (depende da privacidade dele no WhatsApp) — quando nao expõe, simplesmente nunca
    // atualiza esse mapa, e o comportamento cai de volta pro timer normal de 5s.
    sock.ev.on('presence.update', ({ id, presences }) => {
        const phone = id ? id.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '') : '';
        if (!phone) return;
        const presencaContato = presences?.[id]?.lastKnownPresence;
        if (presencaContato) _presenca.set(phone, presencaContato);
    });

    sock.ev.on('messages.upsert', async ({ messages: msgs, type }) => {
        if (type !== 'notify' || !_mensagemHandler) return;
        if (!global._botMsgIds) global._botMsgIds = new Set();
        for (const msg of msgs) {
            if (msg.key.fromMe || !msg.message) continue;
            if (msg.key.remoteJid && msg.key.remoteJid.endsWith('@g.us')) continue;
            if (msg.key.id && global._botMsgIds.has(msg.key.id)) continue;
            if (msg.key.id) {
                global._botMsgIds.add(msg.key.id);
                if (global._botMsgIds.size > 500) {
                    global._botMsgIds.delete(global._botMsgIds.values().next().value);
                }
            }
            const jid = msg.key.remoteJid;
            const ehLid = !!jid && jid.endsWith('@lid');
            const phone = jid ? jid.replace('@s.whatsapp.net', '').replace('@lid', '').replace(/\D/g, '') : '';
            if (!phone) continue;
            const numeroConfiavel = !ehLid;
            if (msg.message.audioMessage || msg.message.pttMessage) {
                try { if (sock) await sock.sendMessage(jid, { text: 'Oi! Por enquanto só consigo entender mensagens de texto. Pode me escrever o que precisa? 😊' }); } catch { }
                continue;
            }
            const texto = msg.message.conversation
                || msg.message.extendedTextMessage?.text
                || msg.message.buttonsResponseMessage?.selectedButtonId
                || '';
            if (!texto.trim()) continue;
            // Chegou uma mensagem de verdade — ele parou de digitar ESSA, mesmo que o evento
            // de presenca "paused" nao tenha chegado a tempo. Evita ficar preso em
            // "composing" para sempre por falta desse evento.
            _presenca.delete(phone);
            // Acumula mensagens do mesmo usuario: cancela timer anterior e reinicia
            const ac = _acumulador.get(phone);
            if (ac) {
                clearTimeout(ac.timer);
                ac.textos.push(texto.trim());
            } else {
                _acumulador.set(phone, { textos: [texto.trim()], jid, numeroConfiavel });
            }
            const atual = _acumulador.get(phone);
            atual.timer = setTimeout(() => agendarProcessamento(phone, jid, numeroConfiavel), DELAY_ACUMULACAO);
        }
    });
}
/**
 * Keepalive: pinga o próprio /health a cada 4 minutos.
 * Impede que o processo seja morto por inatividade na Hostinger.
 */
function iniciarKeepalive() {
    const INTERVALO = 4 * 60 * 1000; // 4 minutos
    // (fix) Falhas consecutivas SO no keepalive (sem nenhum outro sintoma) sao normalmente
    // inofensivas (um blip de rede isolado) — mas varias seguidas no mesmo periodo podem
    // indicar que o proprio processo esta sob estresse (memoria/CPU no plano compartilhado),
    // o que tambem costuma coincidir com quedas de conexao do WhatsApp. Conta falhas
    // consecutivas para diferenciar "1 blip isolado" (nao preocupante) de "processo com
    // problema" (vale investigar no painel da Hostinger).
    let falhasConsecutivas = 0;
    setInterval(() => {
        const req = http_1.default.get(`http://localhost:${PORT}/health`, { timeout: 8000 }, (res) => {
            res.resume(); // descarta o corpo — só quer manter o processo vivo
            if (falhasConsecutivas > 0) {
                console.log(`[keepalive] Voltou a responder apos ${falhasConsecutivas} falha(s) consecutiva(s).`);
            }
            falhasConsecutivas = 0;
        });
        req.on('timeout', () => req.destroy(new Error('timeout apos 8s')));
        req.on('error', (err) => {
            falhasConsecutivas++;
            // (fix) err.message vinha vazio para alguns tipos de erro de socket (ex: alguns
            // ECONNRESET) — err.code costuma ter o motivo real (ECONNREFUSED, ETIMEDOUT etc)
            // mesmo quando err.message nao tem nada util, entao mostra os dois.
            const motivo = err.code || err.message || String(err);
            console.warn(`[keepalive] Ping falhou (${falhasConsecutivas}x seguida(s)): ${motivo}`);
            if (falhasConsecutivas === 5) {
                console.warn('[keepalive] 5 falhas consecutivas — se isso persistir, vale checar uso de memoria/CPU do processo no painel da Hostinger (processo sob estresse tambem costuma coincidir com quedas de conexao do WhatsApp).');
            }
        });
        req.end();
    }, INTERVALO);
    console.log('[keepalive] Iniciado — processo será mantido ativo com ping a cada 4 minutos');
}
/**
 * Resolve o JID real do número no WhatsApp usando onWhatsApp().
 *
 * Problema brasileiro: a migração de 8→9 dígitos fez com que alguns números
 * estejam cadastrados no WhatsApp com ou sem o dígito 9 após o DDD.
 * Ex.: banco tem "47991557386" (11 dígitos) mas WA tem "4791557386" (10 dígitos), ou vice-versa.
 *
 * Estratégia:
 *  1. Tenta o número exatamente como está no banco
 *  2. Se não encontrar, tenta a variante (add/remove o 9 após o DDD)
 *  3. Se onWhatsApp() falhar por qualquer motivo, usa o JID construído como fallback
 */
async function resolverJID(fone) {
    const digits = fone.replace(/\D/g, '');
    const withCountry = digits.startsWith('55') ? digits : `55${digits}`;
    // Variante brasileira: 13 dígitos (55+DDD+9+8) ↔ 12 dígitos (55+DDD+8)
    let alternativa = '';
    if (withCountry.length === 13) {
        // remove o '9' na posição 4 (após o DDD de 2 dígitos)
        alternativa = withCountry.slice(0, 4) + withCountry.slice(5);
    }
    else if (withCountry.length === 12) {
        // insere '9' na posição 4
        alternativa = withCountry.slice(0, 4) + '9' + withCountry.slice(4);
    }
    if (sock) {
        for (const num of [withCountry, alternativa].filter(Boolean)) {
            try {
                const resultados = await sock.onWhatsApp(num);
                if (resultados && resultados.length > 0 && resultados[0].exists) {
                    console.log(`[whatsapp] JID resolvido via onWhatsApp: ${resultados[0].jid}`);
                    return resultados[0].jid;
                }
            }
            catch {
                // continua para o próximo candidato
            }
        }
        console.warn(`[whatsapp] onWhatsApp não encontrou ${withCountry} — usando JID construído`);
    }
    // Fallback: monta o JID direto (compatível com números já verificados)
    return `${withCountry}@s.whatsapp.net`;
}
/**
 * Envia uma mensagem WhatsApp.
 * Resolve o JID real via onWhatsApp() antes de enviar.
 * Lança erro se não estiver conectado.
 */
async function enviarMensagem(fone, texto) {
    if (!_ready || !sock)
        throw new Error('WhatsApp não está conectado');
    const jid = await resolverJID(fone);
    await sock.sendMessage(jid, { text: texto });
}
