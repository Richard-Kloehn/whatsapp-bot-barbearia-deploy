"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildReminderMessage = buildReminderMessage;
const DIAS = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
// IMPORTANTE: o servidor roda em UTC mas os horarios de agendamento sao de Brasilia —
// getDate/getDay/getHours nativos pegam o fuso do servidor, causando defasagem de 3h.
// Sempre extrair os componentes de data/hora via timeZone explicito.
function partesBrasilia(d) {
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        weekday: 'short'
    }).formatToParts(d);
    const mapa = {};
    for (const p of partes) mapa[p.type] = p.value;
    const diaSemanaMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        dia: mapa.day,
        mes: Number(mapa.month) - 1,
        hora: mapa.hour === '24' ? '00' : mapa.hour,
        minuto: mapa.minute,
        diaSemana: diaSemanaMap[mapa.weekday]
    };
}
function formatarData(d) {
    const p = partesBrasilia(d);
    return `${p.dia}/${MESES[p.mes]}`;
}
function formatarHora(d) {
    const p = partesBrasilia(d);
    return `${p.hora}:${p.minuto}`;
}
/** Capitaliza cada palavra do nome */
function capitalizarNome(nome) {
    return nome
        .toLowerCase()
        .split(' ')
        .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
        .join(' ');
}
/** Saudação de acordo com o horário de Brasília */
function saudacao() {
    const hora = Number(new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        hour: 'numeric',
        hour12: false,
    }));
    if (hora >= 5 && hora < 12)
        return 'Bom dia';
    if (hora >= 12 && hora < 18)
        return 'Boa tarde';
    return 'Boa noite';
}
/**
 * Monta a mensagem de lembrete no formato definido pelo cliente.
 */
function buildReminderMessage(ag, nomeBarbearia) {
    const nomeCompleto = capitalizarNome(ag.nome_cliente);
    const primeiroNome = nomeCompleto.split(' ')[0];
    const dataHora = new Date(ag.data_hora);
    const p = partesBrasilia(dataHora);
    const diaSemana = DIAS[p.diaSemana];
    const data = formatarData(dataHora);
    const hora = formatarHora(dataHora);
    return [
        `${saudacao()}, ${primeiroNome}! ✂️`,
        '',
        `✅ *Confirmação de Agendamento*`,
        '',
        `📅 *Data:* ${diaSemana}, ${data}`,
        `🕐 *Horário:* ${hora}`,
        `✂️ *Serviço:* ${ag.servico_nome}`,
        `👤 *Barbeiro:* ${ag.barbeiro_nome}`,
        '',
        `❌ Caso precise cancelar, e so responder *cancelar* aqui mesmo nesta conversa.`,
        '',
        `*${nomeBarbearia}* aguarda você! 💈`,
    ].join('\n');
}
