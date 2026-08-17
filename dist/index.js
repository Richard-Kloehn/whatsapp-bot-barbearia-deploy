"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Ponto de entrada principal do bot de lembretes WhatsApp.
 *
 * 1. Carrega variáveis de ambiente
 * 2. Inicia servidor HTTP (página QR + status)
 * 3. Conecta ao WhatsApp via Baileys
 * 4. Inicia o agendador de lembretes
 * 5. Gerencia desligamento gracioso
 */
require("dotenv/config");
require("./logger"); // deve ser o primeiro import — intercepta console antes de tudo
// (fix) Escolhe o modulo de conexao WhatsApp pelo .env: WHATSAPP_PROVIDER=evolution usa a
// Evolution API (REST + webhook); qualquer outro valor (ou ausente) mantem o comportamento
// original via Baileys embutido no processo. Os dois modulos expoem a MESMA interface
// (registrarHandlerMensagem, conectar, enviarMensagem, etc.), entao o resto do arquivo nao
// precisa saber qual dos dois esta em uso.
const WHATSAPP_PROVIDER = String(process.env.WHATSAPP_PROVIDER || 'baileys').trim().toLowerCase();
const whatsapp_1 = WHATSAPP_PROVIDER === 'evolution' ? require("./whatsapp-evolution") : require("./whatsapp");
console.log(`[main] Provedor de WhatsApp: ${WHATSAPP_PROVIDER === 'evolution' ? 'Evolution API' : 'Baileys (embutido)'}`);
const scheduler_1 = require("./scheduler");
const database_1 = require("./database");
async function main() {
    console.log('═'.repeat(52));
    console.log('  🪒  Bot de Lembretes WhatsApp — Barbearia');
    console.log('═'.repeat(52));
    console.log();
    // 1. Servidor HTTP (QR + status)
    (0, whatsapp_1.iniciarServidor)();
    // 2. Ciclo imediato ao conectar (sem esperar o cron de 15 min)
    (0, whatsapp_1.aoConectar)(() => {
        console.log('[main] WhatsApp conectado — executando ciclo imediato de lembretes...');
        (0, scheduler_1.executarCiclo)().catch(console.error);
    });
    // 3. Conexão WhatsApp
    await (0, whatsapp_1.conectar)();
    // 4. Agendador de lembretes (cron a cada 15 min)
    (0, scheduler_1.iniciarScheduler)();
    // 5. Registra handler para o endpoint /cron/run (acionado pelo cPanel da Hostinger)
    (0, whatsapp_1.registrarHandlerCron)(scheduler_1.executarCiclo);

    // 6. IA: handler para mensagens recebidas dos clientes
    const ai_1 = require("./ai");
    (0, whatsapp_1.registrarHandlerMensagem)(ai_1.processarMensagemWhatsApp);
    // 7. Keepalive: pinga o próprio /health a cada 4 min para não ser morto por inatividade
    (0, whatsapp_1.iniciarKeepalive)();
    console.log('\n[main] Bot iniciado. Aguardando conexão WhatsApp...\n');
}
// ── Desligamento gracioso ────────────────────────────────────────────────────
async function shutdown(sinal) {
    console.log(`\n[main] Recebido ${sinal}. Encerrando...`);
    try {
        await (0, database_1.fecharConexao)();
        console.log('[main] Banco de dados fechado.');
    }
    catch (err) {
        console.error('[main] Erro ao fechar banco:', err);
    }
    process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('[main] Exceção não capturada:', err);
    // Não encerra — deixa o processo vivo para reconectar
});
process.on('unhandledRejection', (reason) => {
    console.error('[main] Rejeição não tratada:', reason);
});
main().catch((err) => {
    console.error('[main] Erro fatal na inicialização:', err);
    process.exit(1);
});
