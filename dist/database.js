"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPool = getPool;
exports.buscarPendentes = buscarPendentes;
exports.marcarEnviando = marcarEnviando;
exports.reverterMarcacao = reverterMarcacao;
exports.getNomeBarbearia = getNomeBarbearia;
exports.fecharConexao = fecharConexao;
/**
 * Conexão com o banco de dados MariaDB/MySQL.
 * Lê diretamente da tabela de agendamentos do site principal.
 *
 * Estratégia de conexão:
 * 1. Se DB_SOCKET estiver definido → usa Unix socket (mais confiável em hospedagem compartilhada)
 * 2. Se encontrar socket automático nos caminhos comuns → usa socket
 * 3. Caso contrário → usa TCP (host/port)
 */
const promise_1 = __importDefault(require("mysql2/promise"));
const fs_1 = __importDefault(require("fs"));
// Caminhos de socket mais comuns em hospedagem compartilhada Linux
const SOCKET_PATHS = [
    '/var/lib/mysql/mysql.sock',
    '/var/run/mysqld/mysqld.sock',
    '/tmp/mysql.sock',
    '/tmp/mysqld.sock',
    '/var/lib/mysqld/mysqld.sock',
];
function detectarSocket() {
    if (process.env.DB_SOCKET)
        return process.env.DB_SOCKET;
    for (const p of SOCKET_PATHS) {
        try {
            if (fs_1.default.existsSync(p)) {
                console.log(`[database] Socket encontrado: ${p}`);
                return p;
            }
        }
        catch { /* continua */ }
    }
    return undefined;
}
let pool = null;
function getPool() {
    if (!pool) {
        const socketPath = detectarSocket();
        if (socketPath) {
            console.log(`[database] Conectando via socket: ${socketPath}`);
            pool = promise_1.default.createPool({
                socketPath,
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME,
                connectionLimit: 3,
                waitForConnections: true,
                timezone: 'local',
                // DECIMAL do MySQL vem como Number (nao string) — necessario para somas de precos
                // funcionarem caso a coluna servicos.preco seja migrada de DOUBLE para DECIMAL
                decimalNumbers: true,
            });
        }
        else {
            console.log(`[database] Conectando via TCP: ${process.env.DB_HOST ?? 'localhost'}:${process.env.DB_PORT ?? 3306}`);
            pool = promise_1.default.createPool({
                host: process.env.DB_HOST ?? 'localhost',
                port: Number(process.env.DB_PORT ?? 3306),
                user: process.env.DB_USER,
                password: process.env.DB_PASSWORD,
                database: process.env.DB_NAME,
                connectionLimit: 3,
                waitForConnections: true,
                timezone: 'local',
                // DECIMAL do MySQL vem como Number (nao string) — necessario para somas de precos
                // funcionarem caso a coluna servicos.preco seja migrada de DOUBLE para DECIMAL
                decimalNumbers: true,
            });
        }
    }
    return pool;
}
/**
 * Busca agendamentos que precisam de lembrete.
 * Janela: agora até +24h — pega tudo que ainda não recebeu lembrete
 * e está dentro das próximas 24 horas.
 * Ordenado pelo mais próximo primeiro para priorizar urgentes.
 * Reenvios evitados pela flag lembrete_enviado (marcada antes do envio).
 *
 * IMPORTANTE: os limites da janela DEVEM ser objetos Date (nao strings pre-formatadas).
 * O pool usa `timezone: 'local'`, entao o driver mysql2 converte Date <-> DATETIME usando
 * a mesma convencao em toda insercao/consulta (ver criarAgendamento em ai-db.js, que tambem
 * insere via objeto Date). Comparar com Date objects garante que o limite da janela seja
 * calculado na MESMA base que os valores gravados na coluna, independente de qual fuso
 * o driver realmente usa internamente — usar uma string Brasilia pre-formatada aqui quebraria
 * essa consistencia e faria a janela ficar deslocada.
 */
async function buscarPendentes() {
    const agora = new Date();
    const fim = new Date(agora.getTime() + 24 * 60 * 60 * 1000);
    const [rows] = await getPool().execute(`
    SELECT
      a.id,
      a.nome_cliente,
      a.telefone,
      a.data_hora,
      b.nome  AS barbeiro_nome,
      s.nome  AS servico_nome,
      s.preco AS servico_preco,
      s.duracao AS servico_duracao
    FROM agendamentos a
    JOIN barbeiros b ON b.id = a.barbeiro_id
    JOIN servicos  s ON s.id = a.servico_id
    WHERE
      a.data_hora       BETWEEN ? AND ?
      AND a.lembrete_enviado = 0
      AND a.sem_lembrete     = 0
      AND a.status          != 'cancelado'
      AND a.telefone        IS NOT NULL
      AND a.telefone        != ''
    ORDER BY a.data_hora ASC
  `, [agora, fim]);
    // (v3.32.3) Agrupa por MESMO CLIENTE (telefone) + MESMO DIA — um cliente com corte de
    // cabelo E sobrancelha marcados pra o mesmo dia (ex: um combo criado como 2 linhas
    // separadas no banco) recebia DOIS lembretes distintos. Junta num so, combinando os
    // nomes dos servicos, e mantem o horario do PRIMEIRO agendamento do dia (o mais cedo).
    const grupos = new Map();
    for (const r of rows) {
        const diaChave = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(r.data_hora));
        const chave = `${r.telefone}|${diaChave}`;
        if (!grupos.has(chave)) {
            grupos.set(chave, { ...r, ids: [r.id], servicos: [r.servico_nome] });
        }
        else {
            const g = grupos.get(chave);
            g.ids.push(r.id);
            g.servicos.push(r.servico_nome);
            // mantem os dados (horario/barbeiro) do agendamento MAIS CEDO do dia
            if (new Date(r.data_hora) < new Date(g.data_hora)) {
                g.data_hora = r.data_hora;
                g.barbeiro_nome = r.barbeiro_nome;
            }
        }
    }
    return [...grupos.values()].map(g => ({ ...g, servico_nome: g.servicos.join(' + ') }));
}
/** Marca o lembrete como enviado (ANTES de enviar, para evitar duplicatas). Aceita 1 id ou array de ids (lembrete agrupado). */
async function marcarEnviando(idOuIds) {
    const ids = Array.isArray(idOuIds) ? idOuIds : [idOuIds];
    if (ids.length === 0) return;
    await getPool().execute(`UPDATE agendamentos SET lembrete_enviado = 1, lembrete_enviado_em = NOW() WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}
/** Reverte a marcação se o envio falhar definitivamente. Aceita 1 id ou array de ids (lembrete agrupado). */
async function reverterMarcacao(idOuIds) {
    const ids = Array.isArray(idOuIds) ? idOuIds : [idOuIds];
    if (ids.length === 0) return;
    await getPool().execute(`UPDATE agendamentos SET lembrete_enviado = 0, lembrete_enviado_em = NULL WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
}
/** Busca o nome da barbearia nas configurações */
async function getNomeBarbearia() {
    try {
        const [rows] = await getPool().execute('SELECT nome_barbearia FROM configuracao_barbearia LIMIT 1');
        return rows[0]?.nome_barbearia || (process.env.NOME_BARBEARIA ?? 'Barbearia');
    }
    catch {
        return process.env.NOME_BARBEARIA ?? 'Barbearia';
    }
}
async function fecharConexao() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}
