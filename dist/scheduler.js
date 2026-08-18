"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.executarCiclo = executarCiclo;
exports.iniciarScheduler = iniciarScheduler;
/**
 * Agendador de lembretes.
 *
 * Roda a cada 15 minutos e envia mensagens WhatsApp para os clientes
 * com agendamento entre 23h e 25h a partir de agora (janela deslizante).
 *
 * Anti-ban:
 * - Delay aleatório de 10–20s entre cada mensagem
 * - Só envia no horário comercial (HORA_INICIO – HORA_FIM)
 * - Máximo de 20 mensagens por ciclo
 * - Marca o agendamento ANTES de enviar (evita duplicatas mesmo com falha)
 * - 3 tentativas com backoff exponencial antes de reverter
 */
const node_cron_1 = __importDefault(require("node-cron"));
const database_1 = require("./database");
const message_1 = require("./message");
// (fix) Mesma selecao de provedor usada em index.js — antes este arquivo importava
// "./whatsapp" (Baileys) direto, entao no modo WHATSAPP_PROVIDER=evolution o isReady()
// aqui checava um modulo Baileys que nunca era conectado, e o cron de lembretes nunca
// disparava (sempre "WhatsApp nao esta conectado").
const WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
const whatsapp_1 = WHATSAPP_PROVIDER === 'evolution' ? require("./whatsapp-evolution") : require("./whatsapp");
const HORA_INICIO = Number(process.env.HORA_INICIO ?? 8);
const HORA_FIM = Number(process.env.HORA_FIM ?? 21);
const MAX_POR_CICLO = 20;
const MAX_TENTATIVAS = 3;
function dentroDHorarioComercial() {
    // Usa o timezone do Brasil independente do servidor
    const horaBrasil = Number(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    return horaBrasil >= HORA_INICIO && horaBrasil < HORA_FIM;
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
function delayAleatorio() {
    // 10–20 segundos entre mensagens
    const ms = 10000 + Math.floor(Math.random() * 10000);
    console.log(`[scheduler] Aguardando ${(ms / 1000).toFixed(1)}s antes do próximo envio...`);
    return delay(ms);
}
async function enviarComRetry(id, fone, texto) {
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        try {
            await (0, whatsapp_1.enviarMensagem)(fone, texto);
            return true;
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[scheduler] Tentativa ${tentativa}/${MAX_TENTATIVAS} falhou para #${id}: ${msg}`);
            if (tentativa < MAX_TENTATIVAS) {
                // Backoff exponencial: 5s, 10s
                await delay(5000 * tentativa);
            }
        }
    }
    return false;
}
// TRAVA DE REENTRANCIA: o ciclo pode ser disparado por TRES fontes diferentes — o cron
// interno (a cada 15min), o endpoint /cron/run (acionado externamente pelo cPanel da
// Hostinger, tambem a cada 15min) e o callback de "conectar" (ciclo imediato ao WhatsApp
// conectar). Se duas dessas fontes dispararem quase ao mesmo tempo (ex: o cron externo
// atrasar e coincidir com o interno, ou uma reconexao do WhatsApp acontecer no mesmo
// instante do cron), duas execucoes de executarCiclo() rodariam em paralelo: ambas fariam
// buscarPendentes() ANTES de qualquer uma marcar os agendamentos como enviados, lendo o
// MESMO lote de pendentes e enviando o MESMO lembrete duas vezes para o cliente. Esta trava
// garante no maximo UM ciclo em execucao por vez neste processo.
let _cicloEmExecucao = false;
async function executarCiclo() {
    if (_cicloEmExecucao) {
        console.log('[scheduler] Ciclo anterior ainda em execução — pulando esta chamada (evita lembretes duplicados).');
        return;
    }
    _cicloEmExecucao = true;
    try {
        await executarCicloInterno();
    } finally {
        _cicloEmExecucao = false;
    }
}
async function executarCicloInterno() {
    // (v3.32.5) Interruptor temporario a pedido do usuario: LEMBRETES_ATIVOS=false no .env
    // desliga o envio de lembretes sem precisar mexer em mais nada — so trocar de volta
    // para true (ou remover a variavel) quando quiser reativar.
    if (process.env.LEMBRETES_ATIVOS === 'false') {
        console.log('[scheduler] Lembretes desativados (LEMBRETES_ATIVOS=false no .env) — ciclo pulado.');
        return;
    }
    if (!(0, whatsapp_1.isReady)()) {
        console.log('[scheduler] WhatsApp não está conectado — ciclo pulado.');
        return;
    }
    if (!dentroDHorarioComercial()) {
        console.log(`[scheduler] Fora do horário comercial (${HORA_INICIO}h–${HORA_FIM}h) — ciclo pulado.`);
        return;
    }
    let nomeBarbearia;
    try {
        nomeBarbearia = await (0, database_1.getNomeBarbearia)();
    }
    catch (err) {
        console.error('[scheduler] Erro ao obter nome da barbearia:', err);
        nomeBarbearia = process.env.NOME_BARBEARIA ?? 'Barbearia';
    }
    let pendentes;
    try {
        pendentes = await (0, database_1.buscarPendentes)();
    }
    catch (err) {
        console.error('[scheduler] Erro ao buscar agendamentos:', err);
        return;
    }
    if (pendentes.length === 0) {
        console.log('[scheduler] Nenhum lembrete pendente.');
        return;
    }
    const lote = pendentes.slice(0, MAX_POR_CICLO);
    console.log(`[scheduler] ${lote.length} lembrete(s) a enviar (de ${pendentes.length} pendentes).`);
    let enviados = 0;
    let falhas = 0;
    for (let i = 0; i < lote.length; i++) {
        const ag = lote[i];
        const idsLog = ag.ids.join(',');
        // Marca ANTES de enviar — evita duplicata mesmo se o processo cair (marca TODOS os
        // ids do grupo, ja que um lembrete agora pode cobrir varios servicos do mesmo dia)
        try {
            await (0, database_1.marcarEnviando)(ag.ids);
        }
        catch (err) {
            console.error(`[scheduler] Erro ao marcar agendamento(s) #${idsLog}:`, err);
            continue;
        }
        const texto = (0, message_1.buildReminderMessage)(ag, nomeBarbearia);
        const ok = await enviarComRetry(idsLog, ag.telefone, texto);
        if (ok) {
            console.log(`[scheduler] ✅ Lembrete enviado para ${ag.nome_cliente} (${ag.telefone}) — agendamento(s) #${idsLog}`);
            enviados++;
        }
        else {
            console.error(`[scheduler] ❌ Falha definitiva para agendamento(s) #${idsLog}. Revertendo marcação.`);
            try {
                await (0, database_1.reverterMarcacao)(ag.ids);
            }
            catch (err) {
                console.error(`[scheduler] Erro ao reverter marcação #${idsLog}:`, err);
            }
            falhas++;
        }
        // Delay entre mensagens (exceto após a última)
        if (i < lote.length - 1) {
            await delayAleatorio();
        }
    }
    console.log(`[scheduler] Ciclo concluído: ${enviados} enviado(s), ${falhas} falha(s).`);
}
/** Inicia o cron — roda a cada 15 minutos */
function iniciarScheduler() {
    console.log('[scheduler] Iniciando cron (a cada 15 minutos)...');
    // Cron: 0, 15, 30, 45 de cada hora
    node_cron_1.default.schedule('0,15,30,45 * * * *', () => {
        const horaBrasil = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        console.log(`[scheduler] Ciclo cron — ${horaBrasil} (horário de Brasília)`);
        executarCiclo().catch(console.error);
    });
}
