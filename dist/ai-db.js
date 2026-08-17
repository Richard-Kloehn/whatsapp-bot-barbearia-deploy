"use strict";
/**
 * Ferramentas de banco de dados para o assistente IA.
 * Reutiliza o pool mysql2 do database.js existente.
 */
const { getPool } = require('./database');
const { randomBytes } = require('crypto');

// ── Trava de concorrencia por barbeiro ────────────────────────────────────────
// PROBLEMA: criarAgendamento/criarAgendamentoMultiplo primeiro fazem um SELECT para
// checar conflito de horario e SO DEPOIS fazem o INSERT. Entre esse SELECT e esse INSERT
// existe uma janela onde duas chamadas concorrentes (ex: dois clientes diferentes tentando
// marcar com o MESMO barbeiro quase ao mesmo tempo, ou uma reconexao do WhatsApp que
// disparou processamento duplicado) podem AMBAS ler "sem conflito" e AMBAS inserirem,
// resultando em dois agendamentos sobrepostos pro mesmo barbeiro (double-booking). Como
// o processo roda em Node (single-thread, mas com I/O assincrono intercalado), uma trava
// em memoria por barbeiro_id e suficiente para serializar exatamente esse trecho critico
// (checagem + insercao) dentro deste processo, fechando a janela de corrida. Isso NAO
// substitui uma constraint UNIQUE no banco (recomendado como defesa adicional caso outro
// processo/serviço grave na mesma tabela), mas cobre o caso real deste bot.
const _filaPorBarbeiro = new Map(); // barbeiroId -> Promise (fila de execucao)
function comTravaBarbeiro(barbeiroId, tarefa) {
    const anterior = _filaPorBarbeiro.get(barbeiroId) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(tarefa);
    // Guarda a promise atual na fila; erros nao travam as proximas execucoes (catch acima
    // so protege o ENCADEAMENTO — o erro real da tarefa ainda propaga pra quem chamou via `atual`)
    _filaPorBarbeiro.set(barbeiroId, atual.catch(() => {}));
    return atual;
}

// Remove tudo que não é dígito e o código do país (55), mantendo só DDD + número
function normalizarTelefone(fone) {
    const digits = (fone || '').replace(/\D/g, '');
    if (digits.length > 11 && digits.startsWith('55')) {
        return digits.slice(2);
    }
    return digits;
}

// Formata o nome do cliente em Title Case (primeira letra de cada palavra maiuscula),
// preservando conectores comuns em portugues (de/da/do/das/dos/e) em minuscula, exceto
// quando sao a primeira palavra. Aplicado SEMPRE antes de gravar no banco — evita que o
// mesmo cliente vire varios cadastros diferentes so por causa de maiusculas/minusculas
// digitadas de forma diferente a cada vez ("richard kloehn", "Richard KLOEHN", etc).
const CONECTORES_NOME = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);
function normalizarNome(nome) {
    const limpo = String(nome || '').trim().replace(/\s+/g, ' ');
    if (!limpo) return limpo;
    return limpo
        .toLowerCase()
        .split(' ')
        .map((palavra, i) => {
            if (i > 0 && CONECTORES_NOME.has(palavra)) return palavra;
            return palavra.charAt(0).toUpperCase() + palavra.slice(1);
        })
        .join(' ');
}

// Nome do dia da semana calculado no servidor (fuso de Brasília) — nunca deixar
// o modelo de IA calcular isso sozinho, pois ele erra com frequência.
const NOMES_DIA_SEMANA = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado'];
function nomeDiaSemanaPorData(data) {
    // data: string 'YYYY-MM-DD'
    const dia = new Date(`${data}T12:00:00-03:00`).getDay();
    return NOMES_DIA_SEMANA[dia];
}
function nomeDiaSemanaPorDate(date) {
    // date: Date (instante UTC) — converte para o dia civil em Brasília antes de calcular
    const dataBR = new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    return nomeDiaSemanaPorData(dataBR);
}

// Formata data (dd/mm) e hora (HH:MM) em Brasilia a partir de um Date (instante UTC).
// NUNCA deixar o modelo de IA ler dataHora bruto (ISO/UTC) e extrair os digitos sozinho —
// ele erra por nao converter o fuso, causando defasagem de 3h no horario exibido.
function dataHoraFormatadaBrasilia(date) {
    const partes = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(new Date(date));
    const mapa = {};
    for (const p of partes) mapa[p.type] = p.value;
    const hora = mapa.hour === '24' ? '00' : mapa.hour;
    return { data: `${mapa.day}/${mapa.month}`, hora: `${hora}:${mapa.minute}` };
}

function parseIntervalo(start, end) {
    if (!start || !end) return null;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    return [sh * 60 + sm, eh * 60 + em];
}

// Gera slots de tempo disponíveis (mesma lógica do site) — bloqueia almoço e lanche
function generateTimeSlots(start, end, duration, lunchStart, lunchEnd, snackStart, snackEnd, step = 15) {
    const slots = [];
    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMin = startH * 60 + startM;
    const endMin = endH * 60 + endM;

    const intervalos = [parseIntervalo(lunchStart, lunchEnd), parseIntervalo(snackStart, snackEnd)]
        .filter(Boolean)
        .sort((a, b) => a[0] - b[0]);

    // A grade de oferta precisa continuar em 15 minutos para permitir encaixes reais como
    // 11:15 apos um atendimento de 45min. A sobreposicao e bloqueada depois, comparando o
    // intervalo completo do servico com os agendamentos existentes; portanto o step NAO deve
    // ser a duracao do servico, senao horarios validos entre multiplos de 30/45min somem.
    const stepToUse = step;
    let current = startMin;
    while (current + duration <= endMin) {
        const bloqueado = intervalos.find(
            ([iniMin, fimMin]) => (current >= iniMin && current < fimMin) || (current < iniMin && current + duration > iniMin)
        );
        if (bloqueado) { current = bloqueado[1]; continue; }
        const h = Math.floor(current / 60).toString().padStart(2, '0');
        const m = (current % 60).toString().padStart(2, '0');
        slots.push(`${h}:${m}`);
        current += stepToUse;
    }
    return slots;
}

// Lista TODOS os servicos ativos da barbearia, independente de qual barbeiro os realiza
// ou se tem alguem trabalhando naquele dia — usado SO para responder "quais servicos voces
// tem" (o catalogo/cardapio geral da barbearia). NAO usar para validar compatibilidade
// barbeiro x servico (isso continua sendo listarBarbeirosServicos, que so mostra o que
// algum barbeiro de verdade realiza — usada nas travas de "esse barbeiro nao faz esse
// servico" e na auto-atribuicao de barbeiro unico).
async function listarTodosServicosAtivos() {
    const pool = getPool();
    const [rows] = await pool.execute(`
        SELECT id, nome, duracao, preco, preco_variavel
        FROM servicos
        WHERE ativo = 1
        ORDER BY nome ASC
    `);
    return rows.map(r => ({
        id: r.id, nome: r.nome, duracao: r.duracao,
        preco: r.preco, precoVariavel: !!r.preco_variavel
    }));
}

async function listarBarbeirosServicos() {
    const pool = getPool();
    // So considera barbeiros que realmente tem ALGUM horario de trabalho cadastrado —
    // um barbeiro com servicos vinculados mas sem nenhuma linha em horarios_barbeiro
    // nao pode ser agendado de verdade e NAO deve aparecer como opcao para o cliente.
    const [rows] = await pool.execute(`
        SELECT b.id AS barbeiro_id, b.nome AS barbeiro_nome,
               s.id AS servico_id, s.nome AS servico_nome,
               s.duracao, s.preco, s.preco_variavel
        FROM barbeiros b
        JOIN barbeiro_servico bs ON bs.barbeiro_id = b.id
        JOIN servicos s ON s.id = bs.servico_id
        WHERE b.ativo = 1 AND s.ativo = 1
          AND EXISTS (SELECT 1 FROM horarios_barbeiro h WHERE h.barbeiro_id = b.id AND h.ativo = 1)
        ORDER BY b.ordem ASC, s.nome ASC
    `);
    const barbeirosMap = new Map();
    for (const row of rows) {
        if (!barbeirosMap.has(row.barbeiro_id)) {
            barbeirosMap.set(row.barbeiro_id, { id: row.barbeiro_id, nome: row.barbeiro_nome, servicos: [] });
        }
        barbeirosMap.get(row.barbeiro_id).servicos.push({
            id: row.servico_id, nome: row.servico_nome,
            duracao: row.duracao, preco: row.preco, precoVariavel: !!row.preco_variavel
        });
    }
    return Array.from(barbeirosMap.values());
}

// Calcula os horarios livres de um barbeiro numa data, para um bloco de
// "duracaoMinutos" contiguos (usado tanto para 1 servico quanto para a soma
// de varios servicos agendados em sequencia com o mesmo barbeiro).
// agendamentosPendentes: array opcional de agendamentos ainda nao salvos no banco
// (usado em multi-agendamento para bloquear horarios ja escolhidos mas ainda nao persistidos)
async function calcularHorariosLivres(data, barbeiroId, duracaoMinutos, agendamentosPendentes = []) {
    const pool = getPool();
    const dateStart = new Date(`${data}T00:00:00-03:00`);
    const dateEnd   = new Date(`${data}T23:59:59-03:00`);
    const diaSemana = new Date(`${data}T12:00:00-03:00`).getDay();

    const [diasInd] = await pool.execute(
        'SELECT motivo FROM dias_indisponiveis WHERE data BETWEEN ? AND ? LIMIT 1',
        [dateStart, dateEnd]
    );
    if (diasInd.length > 0) return { horarios: [], motivo: diasInd[0].motivo || 'Data indisponível' };

    const [especiais] = await pool.execute(
        `SELECT horario_abertura, horario_fechamento, intervalo_almoco_inicio, intervalo_almoco_fim
         FROM horarios_especiais
         WHERE data BETWEEN ? AND ? AND (barbeiro_id = ? OR barbeiro_id IS NULL)
         ORDER BY barbeiro_id DESC LIMIT 1`,
        [dateStart, dateEnd, barbeiroId]
    );
    const [horarios] = await pool.execute(
        `SELECT horario_inicio, horario_fim, intervalo_almoco_inicio, intervalo_almoco_fim, intervalo_lanche_inicio, intervalo_lanche_fim
         FROM horarios_barbeiro WHERE barbeiro_id = ? AND dia_semana = ? AND ativo = 1 LIMIT 1`,
        [barbeiroId, diaSemana]
    );

    let horarioInicio, horarioFim, almocoInicio, almocoFim, lancheInicio, lancheFim;
    if (especiais.length > 0) {
        const e = especiais[0];
        horarioInicio = e.horario_abertura || '09:00';
        horarioFim    = e.horario_fechamento || '18:00';
        almocoInicio  = e.intervalo_almoco_inicio;
        almocoFim     = e.intervalo_almoco_fim;
    } else if (horarios.length > 0) {
        const h = horarios[0];
        horarioInicio = h.horario_inicio;
        horarioFim    = h.horario_fim;
        almocoInicio  = h.intervalo_almoco_inicio;
        almocoFim     = h.intervalo_almoco_fim;
        lancheInicio  = h.intervalo_lanche_inicio;
        lancheFim     = h.intervalo_lanche_fim;
    } else {
        return { horarios: [], motivo: 'Barbeiro não trabalha neste dia' };
    }

    const allSlots = generateTimeSlots(horarioInicio, horarioFim, duracaoMinutos, almocoInicio, almocoFim, lancheInicio, lancheFim);

    const [agendamentos] = await pool.execute(
        `SELECT a.data_hora, s.duracao FROM agendamentos a JOIN servicos s ON s.id = a.servico_id
         WHERE a.barbeiro_id = ? AND a.data_hora BETWEEN ? AND ? AND a.status != 'cancelado'`,
        [barbeiroId, dateStart, dateEnd]
    );

    const occupiedSlots = new Set();
    
    // Bloqueia horários de agendamentos já salvos no banco
    for (const ag of agendamentos) {
        const dt = new Date(ag.data_hora);
        // Usa Intl.DateTimeFormat (mesmo padrao de dataHoraFormatadaBrasilia) em vez de
        // subtracao manual de -3h — mais robusto se o fuso do servidor nao for UTC.
        const { hora: horaFmt } = dataHoraFormatadaBrasilia(dt);
        const [brtH, brtM] = horaFmt.split(':').map(Number);
        const slotStr = horaFmt;
        const slotStartMin = brtH * 60 + brtM;
        const endMin = slotStartMin + ag.duracao;
        for (const s of allSlots) {
            const [sh, sm] = s.split(':').map(Number);
            const sMin = sh * 60 + sm;
            // Conflito real de intervalo: o slot e bloqueado se o servico executado nele
            // sobrepoe o agendamento existente em qualquer trecho (nao apenas se comeca dentro dele)
            if (sMin < endMin && sMin + duracaoMinutos > slotStartMin) occupiedSlots.add(s);
        }
        occupiedSlots.add(slotStr);
    }
    
    // Bloqueia horários de agendamentos pendentes (ainda não salvos)
    // Usado em multi-agendamento para considerar escolhas anteriores do grupo
    for (const pendente of agendamentosPendentes) {
        // Só considera pendentes do mesmo barbeiro e mesma data
        if (pendente.barbeiro_id !== barbeiroId || pendente.data !== data) continue;
        
        const [pH, pM] = pendente.hora.split(':').map(Number);
        const pSlotStr = pendente.hora;
        const pStartMin = pH * 60 + pM;
        const pEndMin = pStartMin + pendente.duracao;
        
        for (const s of allSlots) {
            const [sh, sm] = s.split(':').map(Number);
            const sMin = sh * 60 + sm;
            if (sMin < pEndMin && sMin + duracaoMinutos > pStartMin) occupiedSlots.add(s);
        }
        occupiedSlots.add(pSlotStr);
    }

    const now = new Date();
    const todayBRT = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const isToday = todayBRT.toISOString().slice(0, 10) === data;

    const available = allSlots.filter(slot => {
        if (occupiedSlots.has(slot)) return false;
        if (isToday) {
            if (new Date(`${data}T${slot}:00-03:00`) <= now) return false;
        }
        return true;
    });

    return { horarios: available };
}

async function verificarDisponibilidade(data, barbeiroId, servicoId, agendamentosPendentes = []) {
    const pool = getPool();
    const [servicos] = await pool.execute(
        'SELECT id, nome, duracao, preco, preco_variavel FROM servicos WHERE id = ? LIMIT 1', [servicoId]
    );
    if (servicos.length === 0) return { horarios: [], erro: 'Serviço não encontrado' };
    const servico = servicos[0];

    const resultado = await calcularHorariosLivres(data, barbeiroId, servico.duracao, agendamentosPendentes);
    if (resultado.motivo) return resultado;

    return { horarios: resultado.horarios, servico: { id: servico.id, nome: servico.nome, duracao: servico.duracao, preco: servico.preco, precoVariavel: !!servico.preco_variavel } };
}

// Verifica disponibilidade para VARIOS servicos agendados em sequencia com o MESMO
// barbeiro (ex: corte + limpeza nasal) — retorna UM UNICO horario de inicio para o
// bloco combinado, em vez de listas separadas por servico.
async function verificarDisponibilidadeCombinada(data, barbeiroId, servicoIds, agendamentosPendentes = []) {
    const pool = getPool();
    const placeholders = servicoIds.map(() => '?').join(',');
    const [servicos] = await pool.execute(
        `SELECT id, nome, duracao, preco, preco_variavel FROM servicos WHERE id IN (${placeholders})`, servicoIds
    );
    if (servicos.length !== servicoIds.length) return { horarios: [], erro: 'Um ou mais serviços não encontrados' };

    const duracaoTotal = servicos.reduce((soma, s) => soma + s.duracao, 0);
    const precoTotal = servicos.reduce((soma, s) => soma + Number(s.preco), 0);
    // Se QUALQUER servico do combo tiver preco variavel (ex: depende do tamanho do cabelo),
    // o total combinado tambem e "a partir de" — nunca soma um valor fixo com um estimado
    // como se o resultado fosse um preco final exato.
    const precoVariavelTotal = servicos.some(s => !!s.preco_variavel);

    const resultado = await calcularHorariosLivres(data, barbeiroId, duracaoTotal, agendamentosPendentes);
    if (resultado.motivo) return resultado;

    return {
        horarios: resultado.horarios,
        servicos: servicos.map(s => ({ id: s.id, nome: s.nome, duracao: s.duracao, preco: s.preco, precoVariavel: !!s.preco_variavel })),
        duracaoTotal, precoTotal, precoVariavelTotal,
    };
}

/**
 * Verifica disponibilidade de TODOS os barbeiros ativos para TODOS os seus servicos numa data.
 * Retorna um objeto indexado por barbeiro, evitando N chamadas separadas de verificar_disponibilidade.
 * agendamentosPendentes: array opcional de agendamentos ainda nao salvos (usado em multi-agendamento)
 * barbeiroId: opcional — se informado, filtra o resultado para SOMENTE esse barbeiro (usado quando
 * o cliente ja especificou um barbeiro para o agendamento, evitando mostrar/consultar os demais).
 */
async function verificarDisponibilidadeTodos(data, servicoIds, agendamentosPendentes = [], barbeiroId = null) {
    let barbeiros = await listarBarbeirosServicos();
    if (barbeiroId) {
        const idFiltro = Number(barbeiroId);
        const filtrados = barbeiros.filter(b => Number(b.id) === idFiltro);
        // Se o ID nao corresponde a nenhum barbeiro real, NAO retorna lista vazia silenciosamente —
        // mantem a lista completa para o modelo perceber que o barbeiro nao existe e avisar o cliente
        // (mesma logica ja usada no restante do sistema: barbeiro inexistente != "sem horario").
        if (filtrados.length > 0) barbeiros = filtrados;
    }
    const resultado = [];
    const idsFiltro = Array.isArray(servicoIds) ? servicoIds.map(Number).filter(n => Number.isFinite(n)) : [];
    const multiplos = idsFiltro.length > 1;

    // Servico especifico pedido: SO entram barbeiros que o REALIZAM. Se ninguem
    // realiza, o erro e explicito — NUNCA horarios de outro servico no lugar.
    if (idsFiltro.length > 0) {
        const quemFaz = barbeiros.filter(b => idsFiltro.every(id => b.servicos.some(s => Number(s.id) === id)));
        if (quemFaz.length === 0) {
            return { erro: 'Nenhum barbeiro da equipe realiza esse(s) servico(s) em conjunto — mas ANTES de informar isso ao cliente, chame listar_barbeiros_servicos e confira com cuidado se os servicos combinados aqui realmente correspondem ao que o cliente pediu (nomes parecidos podem ter sido confundidos, ex: "limpeza nasal" com outro servico do catalogo). Se os nomes baterem mesmo, informe o cliente com naturalidade e apresente quais servicos cada barbeiro realiza, SEM listar horarios.' };
        }
    }

    for (const b of barbeiros) {
        if (multiplos) {
            // So entra na lista o barbeiro que oferece TODOS os servicos pedidos —
            // e mostra UM UNICO horario combinado (soma das duracoes), nao listas separadas.
            const idsBarbeiro = new Set(b.servicos.map(s => Number(s.id)));
            if (!idsFiltro.every(id => idsBarbeiro.has(id))) continue;
            const disp = await verificarDisponibilidadeCombinada(data, b.id, servicoIds, agendamentosPendentes);
            if (disp.horarios && disp.horarios.length > 0) {
                resultado.push({
                    barbeiro_id: b.id, barbeiro_nome: b.nome,
                    servicos: [{
                        servico_nome: disp.servicos.map(s => s.nome).join(' + '),
                        duracao: disp.duracaoTotal, preco: disp.precoTotal, precoVariavel: disp.precoVariavelTotal,
                        horarios: disp.horarios,
                    }],
                });
            }
            continue;
        }
        const servicosDisp = [];
        // BUG CORRIGIDO: com UM unico servico pedido, o filtro era ignorado e TODOS os
        // servicos de todos os barbeiros voltavam (causa do "selagem com barbeiro que
        // nao faz selagem"). Agora um servico especifico lista APENAS ele, e apenas
        // nos barbeiros que o realizam.
        const servicosParaListar = idsFiltro.length === 1
            ? b.servicos.filter(s => Number(s.id) === idsFiltro[0])
            : b.servicos;
        for (const s of servicosParaListar) {
            const disp = await verificarDisponibilidade(data, b.id, s.id, agendamentosPendentes);
            if (disp.horarios && disp.horarios.length > 0) {
                servicosDisp.push({ servico_id: s.id, servico_nome: s.nome, duracao: s.duracao, preco: s.preco, precoVariavel: s.precoVariavel, horarios: disp.horarios });
            }
        }
        if (servicosDisp.length > 0) {
            resultado.push({ barbeiro_id: b.id, barbeiro_nome: b.nome, servicos: servicosDisp });
        }
    }
    return resultado.length > 0 ? resultado : { horarios: [], motivo: 'Nenhum horario disponivel nesta data' };
}

// Calcula os limites (segunda 00:00 BRT ate domingo 23:59:59 BRT) da semana que contem
// a data informada — usado para avisar o cliente so sobre agendamentos NA MESMA SEMANA
// do novo agendamento (nao qualquer agendamento futuro, que seria ruido desnecessario).
function limitesSemanaBRT(date) {
    const diaBR = new Date(date).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const dow = new Date(`${diaBR}T12:00:00-03:00`).getDay(); // 0=domingo..6=sabado
    const deltaParaSegunda = dow === 0 ? -6 : 1 - dow;
    const segunda = new Date(`${diaBR}T00:00:00-03:00`);
    segunda.setUTCDate(segunda.getUTCDate() + deltaParaSegunda);
    const domingoFim = new Date(segunda.getTime() + 7 * 24 * 60 * 60 * 1000 - 1000);
    return [segunda, domingoFim];
}

function criarAgendamento(nomeCru, telefone, data, hora, barbeiroId, servicoId, idsExcluirAviso = []) {
    // Serializa por barbeiro: fecha a janela de corrida entre a checagem de conflito e a
    // insercao (ver comentario de comTravaBarbeiro acima).
    return comTravaBarbeiro(barbeiroId, () => criarAgendamentoImpl(nomeCru, telefone, data, hora, barbeiroId, servicoId, idsExcluirAviso));
}
async function criarAgendamentoImpl(nomeCru, telefone, data, hora, barbeiroId, servicoId, idsExcluirAviso = []) {
    const pool = getPool();
    const nome = normalizarNome(nomeCru);
    const dataHora   = new Date(`${data}T${hora}:00-03:00`);
    const foneDigits = normalizarTelefone(telefone);

    if (dataHora < new Date()) return { erro: 'Horário já passou' };

    const [servicoNovoRows] = await pool.execute('SELECT duracao FROM servicos WHERE id = ? LIMIT 1', [servicoId]);
    if (servicoNovoRows.length === 0) return { erro: 'Serviço não encontrado' };

    // ULTIMA CAMADA DE DEFESA: confere no banco se esse barbeiro REALMENTE realiza esse
    // servico, mesmo que todas as camadas anteriores (estado, classificadores) ja devam
    // ter garantido isso — nunca grava um agendamento incompativel so por confiar na
    // aplicacao. Sem isso, um agendamento errado fica salvo silenciosamente no banco.
    const [compatRows] = await pool.execute(
        'SELECT 1 FROM barbeiro_servico WHERE barbeiro_id = ? AND servico_id = ? LIMIT 1',
        [barbeiroId, servicoId]
    );
    if (compatRows.length === 0) {
        return { erro: 'Este barbeiro não realiza este serviço. Verifique novamente quais barbeiros atendem esse serviço antes de tentar criar o agendamento.' };
    }

    const dataHoraFim = new Date(dataHora.getTime() + servicoNovoRows[0].duracao * 60000);

    // Verifica SOBREPOSICAO real de horario (nao apenas o mesmo instante exato) —
    // um agendamento de 30min as 10:45 tambem bloqueia um novo de 30min as 10:30,
    // pois os intervalos se cruzam mesmo com horarios de inicio diferentes.
    const diaInicio = new Date(`${data}T00:00:00-03:00`);
    const diaFim    = new Date(`${data}T23:59:59-03:00`);
    const [existentes] = await pool.execute(
        `SELECT a.id, a.data_hora, a.nome_cliente, a.telefone, s.duracao, s.nome AS servico_nome
         FROM agendamentos a JOIN servicos s ON s.id = a.servico_id
         WHERE a.barbeiro_id = ? AND a.data_hora BETWEEN ? AND ? AND a.status != 'cancelado'`,
        [barbeiroId, diaInicio, diaFim]
    );
    const conflito = existentes.find(ag => {
        const inicioExistente = new Date(ag.data_hora);
        const fimExistente = new Date(inicioExistente.getTime() + ag.duracao * 60000);
        return dataHora < fimExistente && inicioExistente < dataHoraFim;
    });
    if (conflito) {
        // (fix) So e um "DUPLICADO" seguro (mesmo agendamento tentando ser criado 2x por
        // engano) quando o horario de INICIO bate EXATAMENTE com o existente. Antes, esta
        // checagem so olhava nome+telefone do cliente — em agendamento MULTIPLO (ex: pai
        // marcando pra ele e pro filho com o MESMO contato), isso classificava errado uma
        // COLISAO REAL de horario (ex: filho as 18:30 sobrepondo o pai as 18:15-18:45,
        // servico de 30min) como se fosse so um reenvio duplicado do MESMO agendamento —
        // e instruia o modelo a "confirmar normalmente", fazendo o bot mandar uma mensagem
        // de confirmacao para um agendamento que NUNCA foi salvo no banco. Agora so entra
        // nesse caminho seguro quando e literalmente o mesmo instante; caso contrario (mesmo
        // cliente, mas overlap com um horario DIFERENTE) e um conflito de agenda de verdade
        // — o barbeiro nao pode atender duas pessoas ao mesmo tempo, mesmo que seja pai e
        // filho no mesmo contato — e precisa de outro horario para essa pessoa.
        const mesmoInstante = dataHora.getTime() === new Date(conflito.data_hora).getTime();
        const mesmoCliente = conflito.telefone === foneDigits &&
            conflito.nome_cliente.trim().toLowerCase() === nome.trim().toLowerCase();
        if (mesmoCliente && mesmoInstante) {
            const { data: dataFmt, hora: horaFmt } = dataHoraFormatadaBrasilia(conflito.data_hora);
            return { erro: `DUPLICADO: este cliente JA TEM um agendamento confirmado (id ${conflito.id}) nesse exato horario (${dataFmt} as ${horaFmt}, ${conflito.servico_nome}) com este barbeiro — provavelmente ja foi criado momentos atras nesta mesma conversa. NAO tente criar de novo, NAO diga ao cliente que o horario esta ocupado (nao esta ocupado por outra pessoa, e o proprio agendamento dele). Apenas confirme normalmente usando os dados desse agendamento existente.` };
        }
        if (mesmoCliente) {
            const { hora: horaFmtExistente } = dataHoraFormatadaBrasilia(conflito.data_hora);
            return { erro: `CONFLITA: este horario conflita (sobrepoe) com outro agendamento (id ${conflito.id}, as ${horaFmtExistente}, ${conflito.duracao}min) que este MESMO cliente/contato acabou de marcar para OUTRA pessoa do grupo (ex: filho/marido) com este mesmo barbeiro. Um barbeiro nao pode atender duas pessoas ao mesmo tempo, mesmo sendo o mesmo contato. Este agendamento NAO foi criado. E OBRIGATORIO escolher outro horario para ESTA pessoa que nao sobreponha o horario ja marcado (${horaFmtExistente} + ${conflito.duracao}min) — consulte a disponibilidade real de novo antes de sugerir um novo horario, NAO adivinhe.` };
        }
        return { erro: 'Esse horário conflita com outro agendamento já existente. Escolha outro horário.' };
    }

    // Verifica se o cliente já tem outro agendamento confirmado no futuro,
    // para avisá-lo (sem bloquear a criação do novo agendamento)
    const [semanaInicioAviso, semanaFimAviso] = limitesSemanaBRT(dataHora);
    const [pendentesRaw] = await pool.execute(
        `SELECT a.id, a.data_hora, b.nome AS barbeiro, s.nome AS servico
         FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
         WHERE a.telefone = ? AND a.status = 'confirmado' AND a.data_hora >= NOW()
           AND a.data_hora BETWEEN ? AND ?
         ORDER BY a.data_hora ASC LIMIT 10`,
        [foneDigits, semanaInicioAviso, semanaFimAviso]
    );
    // (fix) Exclui agendamentos que acabaram de ser criados momentos atras NESTA MESMA rodada
    // (ex: agendando pai + filho na mesma mensagem) — sem isso, o agendamento do PRIMEIRO da
    // rodada aparecia como se fosse "um outro agendamento ja existente" ao criar o do segundo,
    // quando na verdade e o mesmo pedido, so que de outra pessoa do grupo.
    const idsExcluirSet = new Set((idsExcluirAviso || []).map(Number));
    const pendentes = pendentesRaw.filter(p => !idsExcluirSet.has(Number(p.id)));
    const agendamentosExistentes = pendentes.map(p => ({
        ...dataHoraFormatadaBrasilia(p.data_hora), diaSemana: nomeDiaSemanaPorDate(p.data_hora), barbeiro: p.barbeiro, servico: p.servico,
    }));

    // Identifica o cliente pelo NOME COMPLETO (nao pelo telefone) — se o telefone informado
    // agora for diferente do que estava salvo, ATUALIZA para o novo (o cliente pode ter
    // trocado de numero; o cadastro sempre reflete o telefone mais recente informado por ele).
    const [clienteExist] = await pool.execute(
        'SELECT id, telefone FROM clientes WHERE nome_completo = ? LIMIT 1', [nome.trim()]
    );
    let clienteId = null;
    if (clienteExist.length > 0) {
        clienteId = clienteExist[0].id;
        await pool.execute(
            'UPDATE clientes SET telefone = ?, total_agendamentos = total_agendamentos + 1, ultimo_agendamento = ? WHERE id = ?',
            [foneDigits, dataHora, clienteId]
        );
    } else {
        const [res] = await pool.execute(
            'INSERT INTO clientes (nome_completo, telefone, total_agendamentos, ultimo_agendamento, data_cadastro) VALUES (?, ?, 1, ?, NOW())',
            [nome.trim(), foneDigits, dataHora]
        );
        clienteId = res.insertId;
    }

    const token = randomBytes(24).toString('hex');
    const [result] = await pool.execute(
        `INSERT INTO agendamentos (nome_cliente, telefone, data_hora, barbeiro_id, servico_id, cliente_id, token_confirmacao, status, data_criacao)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmado', NOW())`,
        [nome.trim(), foneDigits, dataHora, barbeiroId, servicoId, clienteId, token]
    );

    const [det] = await pool.execute(
        `SELECT b.nome AS barbeiro, s.nome AS servico, s.preco, s.preco_variavel
         FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
         WHERE a.id = ?`, [result.insertId]
    );

    return {
        id: result.insertId, nomeCliente: nome.trim(),
        ...dataHoraFormatadaBrasilia(dataHora), diaSemana: nomeDiaSemanaPorDate(dataHora),
        barbeiro: det[0].barbeiro, servico: det[0].servico, preco: det[0].preco, precoVariavel: !!det[0].preco_variavel,
        ...(agendamentosExistentes.length > 0 ? { avisoAgendamentosExistentes: agendamentosExistentes } : {}),
    };
}

// Cria VARIOS agendamentos em sequencia (mesmo barbeiro, servicos consecutivos) numa
// UNICA operacao atomica — usado quando o cliente pede combos como "corte + limpeza nasal"
// que nao existem como um servico so na tabela `servicos`. Grava uma linha por servico no
// banco (cada um com seu proprio horario calculado), mas retorna um resultado UNICO e
// combinado para o cliente ver como se fosse um agendamento so.
function criarAgendamentoMultiplo(nomeCru, telefone, data, hora, barbeiroId, servicoIds, idsExcluirAviso = []) {
    // Mesma trava por barbeiro que criarAgendamento — ver comentario de comTravaBarbeiro acima.
    return comTravaBarbeiro(barbeiroId, () => criarAgendamentoMultiploImpl(nomeCru, telefone, data, hora, barbeiroId, servicoIds, idsExcluirAviso));
}
async function criarAgendamentoMultiploImpl(nomeCru, telefone, data, hora, barbeiroId, servicoIds, idsExcluirAviso = []) {
    const nome = normalizarNome(nomeCru);
    const pool = getPool();
    const foneDigits = normalizarTelefone(telefone);
    const dataHoraInicio = new Date(`${data}T${hora}:00-03:00`);
    if (dataHoraInicio < new Date()) return { erro: 'Horário já passou' };

    const placeholders = servicoIds.map(() => '?').join(',');
    const [servicosRows] = await pool.execute(
        `SELECT id, nome, duracao, preco, preco_variavel FROM servicos WHERE id IN (${placeholders})`, servicoIds
    );
    if (servicosRows.length !== servicoIds.length) return { erro: 'Um ou mais serviços não encontrados' };

    // ULTIMA CAMADA DE DEFESA: confere no banco se esse barbeiro realiza TODOS os servicos
    // pedidos (ver comentario equivalente em criarAgendamento).
    const [compatRowsMulti] = await pool.execute(
        `SELECT servico_id FROM barbeiro_servico WHERE barbeiro_id = ? AND servico_id IN (${placeholders})`,
        [barbeiroId, ...servicoIds]
    );
    if (compatRowsMulti.length !== servicoIds.length) {
        return { erro: 'Este barbeiro não realiza um ou mais dos serviços pedidos. Verifique novamente quais barbeiros atendem esses serviços antes de tentar criar o agendamento.' };
    }

    // Mantem a ordem pedida pelo cliente (servicoIds), nao a ordem de retorno do SQL
    const servicosPorId = new Map(servicosRows.map(s => [s.id, s]));
    const servicosOrdenados = servicoIds.map(id => servicosPorId.get(id));

    // Calcula o horario sequencial de cada servico (um logo apos o outro)
    let cursor = dataHoraInicio;
    const agendamentosPlanejados = servicosOrdenados.map(s => {
        const inicio = cursor;
        const fim = new Date(inicio.getTime() + s.duracao * 60000);
        cursor = fim;
        return { servico: s, inicio, fim };
    });
    const dataHoraFimTotal = cursor;

    const diaInicio = new Date(`${data}T00:00:00-03:00`);
    const diaFim    = new Date(`${data}T23:59:59-03:00`);
    const [existentes] = await pool.execute(
        `SELECT a.data_hora, s.duracao FROM agendamentos a JOIN servicos s ON s.id = a.servico_id
         WHERE a.barbeiro_id = ? AND a.data_hora BETWEEN ? AND ? AND a.status != 'cancelado'`,
        [barbeiroId, diaInicio, diaFim]
    );
    const temConflito = existentes.some(ag => {
        const inicioExistente = new Date(ag.data_hora);
        const fimExistente = new Date(inicioExistente.getTime() + ag.duracao * 60000);
        return dataHoraInicio < fimExistente && inicioExistente < dataHoraFimTotal;
    });
    if (temConflito) return { erro: 'Esse horário conflita com outro agendamento já existente. Escolha outro horário.' };

    const [semanaInicioAviso, semanaFimAviso] = limitesSemanaBRT(dataHoraInicio);
    const [pendentesRaw] = await pool.execute(
        `SELECT a.id, a.data_hora, b.nome AS barbeiro, s.nome AS servico
         FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
         WHERE a.telefone = ? AND a.status = 'confirmado' AND a.data_hora >= NOW()
           AND a.data_hora BETWEEN ? AND ?
         ORDER BY a.data_hora ASC LIMIT 10`,
        [foneDigits, semanaInicioAviso, semanaFimAviso]
    );
    // (fix) mesma exclusao de agendamentos recem-criados nesta rodada — ver comentario
    // equivalente em criarAgendamentoImpl.
    const idsExcluirSet = new Set((idsExcluirAviso || []).map(Number));
    const pendentes = pendentesRaw.filter(p => !idsExcluirSet.has(Number(p.id)));
    const agendamentosExistentes = pendentes.map(p => ({
        ...dataHoraFormatadaBrasilia(p.data_hora), diaSemana: nomeDiaSemanaPorDate(p.data_hora), barbeiro: p.barbeiro, servico: p.servico,
    }));

    const conn = await pool.getConnection();
    try {
        await conn.beginTransaction();

        // Identifica o cliente pela combinacao TELEFONE + NOME (nao so telefone) — o mesmo
        // numero pode ser usado para agendar pessoas diferentes (ex: pais e filhos).
        // Mesma logica: identifica pelo NOME, sempre atualiza o telefone para o mais recente.
        const [clienteExist] = await conn.execute('SELECT id, telefone FROM clientes WHERE nome_completo = ? LIMIT 1', [nome.trim()]);
        let clienteId;
        if (clienteExist.length > 0) {
            clienteId = clienteExist[0].id;
            await conn.execute(
                'UPDATE clientes SET telefone = ?, total_agendamentos = total_agendamentos + ?, ultimo_agendamento = ? WHERE id = ?',
                [foneDigits, agendamentosPlanejados.length, dataHoraFimTotal, clienteId]
            );
        } else {
            const [res] = await conn.execute(
                'INSERT INTO clientes (nome_completo, telefone, total_agendamentos, ultimo_agendamento, data_cadastro) VALUES (?, ?, ?, ?, NOW())',
                [nome.trim(), foneDigits, agendamentosPlanejados.length, dataHoraFimTotal]
            );
            clienteId = res.insertId;
        }

        const idsCriados = [];
        for (const ag of agendamentosPlanejados) {
            const token = randomBytes(24).toString('hex');
            const [result] = await conn.execute(
                `INSERT INTO agendamentos (nome_cliente, telefone, data_hora, barbeiro_id, servico_id, cliente_id, token_confirmacao, status, data_criacao)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmado', NOW())`,
                [nome.trim(), foneDigits, ag.inicio, barbeiroId, ag.servico.id, clienteId, token]
            );
            idsCriados.push(result.insertId);
        }

        const [barbeiroRows] = await conn.execute('SELECT nome FROM barbeiros WHERE id = ? LIMIT 1', [barbeiroId]);

        await conn.commit();

        const precoTotal = servicosOrdenados.reduce((soma, s) => soma + Number(s.preco), 0);
        const precoVariavelTotal = servicosOrdenados.some(s => !!s.preco_variavel);
        return {
            ids: idsCriados, nomeCliente: nome.trim(),
            ...dataHoraFormatadaBrasilia(dataHoraInicio), diaSemana: nomeDiaSemanaPorDate(dataHoraInicio),
            barbeiro: barbeiroRows[0]?.nome, servicos: servicosOrdenados.map(s => ({ nome: s.nome, preco: s.preco, precoVariavel: !!s.preco_variavel })),
            servicoCombinado: servicosOrdenados.map(s => s.nome).join(' + '), precoTotal, precoVariavel: precoVariavelTotal,
            ...(agendamentosExistentes.length > 0 ? { avisoAgendamentosExistentes: agendamentosExistentes } : {}),
        };
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function buscarAgendamento(telefone, nome) {
    const pool = getPool();
    const foneDigits = normalizarTelefone(telefone);
    const primeiroNome = (nome || '').trim().split(/\s+/)[0] || '';
    let query = `SELECT a.id, a.data_hora, b.nome AS barbeiro, s.nome AS servico, s.preco, a.status
         FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
         WHERE a.telefone = ? AND a.status = 'confirmado' AND a.data_hora >= NOW()
         AND a.data_hora <= DATE_ADD(NOW(), INTERVAL 30 DAY)`;
    const params = [foneDigits];
    if (primeiroNome) {
        query += ` AND a.nome_cliente LIKE ?`;
        params.push(`${primeiroNome}%`);
    }
    query += ` ORDER BY a.data_hora ASC LIMIT 10`;
    const [rows] = await pool.execute(query, params);
    if (rows.length === 0) return { agendamentos: [], mensagem: 'Nenhum agendamento futuro encontrado' };
    return { agendamentos: rows.map(ag => ({ id: ag.id, ...dataHoraFormatadaBrasilia(ag.data_hora), diaSemana: nomeDiaSemanaPorDate(ag.data_hora), barbeiro: ag.barbeiro, servico: ag.servico, preco: ag.preco, status: ag.status })) };
}

async function cancelarAgendamento(telefone, agendamentoId, nome) {
    const pool = getPool();
    const foneDigits = normalizarTelefone(telefone);
    const primeiroNome = (nome || '').trim().split(/\s+/)[0] || '';
    let query, params;
    if (agendamentoId) {
        query = `SELECT a.id, a.data_hora, a.nome_cliente AS nomeCliente, b.nome AS barbeiro, s.nome AS servico
                 FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
                 WHERE a.id = ? AND a.telefone = ? AND a.status = 'confirmado' AND a.data_hora >= NOW()
                 AND a.data_hora <= DATE_ADD(NOW(), INTERVAL 30 DAY)`;
        params = [agendamentoId, foneDigits];
        if (primeiroNome) { query += ` AND a.nome_cliente LIKE ?`; params.push(`${primeiroNome}%`); }
        query += ` LIMIT 1`;
    } else {
        query = `SELECT a.id, a.data_hora, a.nome_cliente AS nomeCliente, b.nome AS barbeiro, s.nome AS servico
                 FROM agendamentos a JOIN barbeiros b ON b.id = a.barbeiro_id JOIN servicos s ON s.id = a.servico_id
                 WHERE a.telefone = ? AND a.status = 'confirmado' AND a.data_hora >= NOW()
                 AND a.data_hora <= DATE_ADD(NOW(), INTERVAL 30 DAY)`;
        params = [foneDigits];
        if (primeiroNome) { query += ` AND a.nome_cliente LIKE ?`; params.push(`${primeiroNome}%`); }
        query += ` ORDER BY a.data_hora ASC LIMIT 1`;
    }
    const [rows] = await pool.execute(query, params);
    if (rows.length === 0) return { erro: 'Nenhum agendamento encontrado para cancelar' };
    const ag = rows[0];
    await pool.execute("UPDATE agendamentos SET status = 'cancelado' WHERE id = ?", [ag.id]);
    return { cancelado: true, id: ag.id, nomeCliente: ag.nomeCliente, ...dataHoraFormatadaBrasilia(ag.data_hora), diaSemana: nomeDiaSemanaPorDate(ag.data_hora), barbeiro: ag.barbeiro, servico: ag.servico };
}

const DIAS_SEMANA = ['Domingo', 'Segunda-feira', 'Terca-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sabado'];

/**
 * Busca todas as informacoes publicas da barbearia:
 * horario de funcionamento, dias, endereco, contato, redes sociais.
 * Tambem verifica se uma data especifica (YYYY-MM-DD) esta indisponivel (feriado/folga).
 */
async function buscarInfoBarbearia(data) {
    const pool = getPool();
    const resultado = {};

    // 1. Configuracoes gerais (horario, dias)
    try {
        const [rows] = await pool.execute('SELECT horario_abertura, horario_fechamento, intervalo_almoco_inicio, intervalo_almoco_fim, dias_funcionamento FROM configuracao_barbearia LIMIT 1');
        if (rows.length > 0) {
            const c = rows[0];
            const dias = (c.dias_funcionamento || '1,2,3,4,5,6').split(',').map(d => DIAS_SEMANA[Number(d.trim())]).filter(Boolean);
            resultado.horario_abertura = c.horario_abertura || '09:00';
            resultado.horario_fechamento = c.horario_fechamento || '18:00';
            if (c.intervalo_almoco_inicio && c.intervalo_almoco_fim) {
                resultado.intervalo_almoco = `${c.intervalo_almoco_inicio} - ${c.intervalo_almoco_fim}`;
            }
            resultado.dias_funcionamento = dias.join(', ');
        }
    } catch { /* usa defaults abaixo */ }

    // 2. Contato, redes sociais e horarios de funcionamento (chave/valor)
    const CHAVES = ['telefone', 'whatsapp', 'email', 'instagram', 'facebook', 'tiktok', 'endereco', 'bairro', 'cidade', 'cep', 'google_maps',
                    'horario_semana', 'horario_sabado', 'horario_domingo', 'horario_feriado'];
    try {
        const placeholders = CHAVES.map(() => '?').join(',');
        const [rows] = await pool.execute(`SELECT chave, valor FROM configuracao_geral WHERE chave IN (${placeholders})`, CHAVES);
        for (const row of rows) {
            if (row.valor) resultado[row.chave] = row.valor;
        }
        // Os horarios detalhados da configuracao_geral sao a fonte da verdade —
        // remove os campos genericos da tabela antiga para nao contradizer
        if (resultado.horario_semana || resultado.horario_sabado || resultado.horario_domingo) {
            delete resultado.horario_abertura;
            delete resultado.horario_fechamento;
            delete resultado.dias_funcionamento;
            delete resultado.intervalo_almoco;
        }
    } catch { /* ignora se tabela nao existir ainda */ }

    // 3. Se uma data foi informada, verifica se esta fechado naquele dia
    if (data) {
        try {
            const dateStart = new Date(`${data}T00:00:00-03:00`);
            const dateEnd   = new Date(`${data}T23:59:59-03:00`);
            const [rows] = await pool.execute('SELECT motivo FROM dias_indisponiveis WHERE data BETWEEN ? AND ? LIMIT 1', [dateStart, dateEnd]);
            if (rows.length > 0) {
                resultado.fechado_nesta_data = rows[0].motivo || 'Fechado nesta data';
            } else {
                // Verifica se algum barbeiro atende nesse dia da semana (fonte da verdade: horarios_barbeiro)
                const diaSemana = new Date(`${data}T12:00:00-03:00`).getDay();
                const [barbRows] = await pool.execute(
                    'SELECT COUNT(*) AS total FROM horarios_barbeiro WHERE dia_semana = ? AND ativo = 1',
                    [diaSemana]
                );
                const algumBarbeiroAtende = (barbRows[0]?.total || 0) > 0;
                if (!algumBarbeiroAtende) resultado.fechado_nesta_data = 'Barbearia nao funciona neste dia da semana';
            }
        } catch { /* ignora */ }
    }

    return resultado;
}

/**
 * Retorna todas as respostas cadastradas e ativas na tabela respostas_bot.
 * A IA deve interpretar semanticamente qual entrada melhor corresponde
 * a duvida do cliente e usar a resposta correspondente.
 */
async function buscarRespostasBot() {
    try {
        const pool = getPool();
        const [rows] = await pool.execute(
            'SELECT id, pergunta, resposta FROM respostas_bot WHERE ativo = 1 ORDER BY id ASC'
        );
        return rows;
    } catch {
        // Tabela ainda nao criada ou erro de acesso — retorna vazio sem travar o bot
        return [];
    }
}

/**
 * Busca a PROXIMA data (a partir de hoje) com horario livre, opcionalmente
 * restrita a um barbeiro e/ou combo de servicos. Usada quando o cliente pergunta
 * "qual o proximo horario disponivel?" sem citar uma data especifica.
 * Horarios passados de hoje ja sao filtrados por calcularHorariosLivres.
 */
// (fix) filtroPeriodo opcional: { periodo: 'manha'|'tarde'|'noite'|null, horarioMinimo, horarioMaximo }.
// Sem isso, a funcao considerava um dia como "tem vaga" mesmo quando a unica vaga real era
// de manha, mas o cliente tinha pedido especificamente a noite — fazendo o bot sugerir uma
// "proxima data com vaga" que, ao ser conferida de verdade (com o filtro de periodo aplicado),
// nao tinha NENHUM horario no periodo pedido, dando a impressao de "adivinhacao" ao cliente.
function horarioNoFiltro(hhmm, filtroPeriodo) {
    if (!filtroPeriodo) return true;
    const { periodo, horarioMinimo, horarioMaximo } = filtroPeriodo;
    const [H, M] = hhmm.split(':').map(Number);
    const min = H * 60 + M;
    if (horarioMinimo || horarioMaximo) {
        if (horarioMinimo) {
            const [hMin, mMin] = horarioMinimo.split(':').map(Number);
            if (min < hMin * 60 + mMin) return false;
        }
        if (horarioMaximo) {
            const [hMax, mMax] = horarioMaximo.split(':').map(Number);
            if (min > hMax * 60 + mMax) return false;
        }
        return true;
    }
    if (periodo === 'manha') return min < 12 * 60;
    if (periodo === 'tarde') return min >= 13 * 60 && min < 18 * 60;
    if (periodo === 'noite') return min >= 18 * 60;
    return true;
}
async function buscarProximoHorario(barbeiroId, servicoIds, maxDias = 21, dataMinima = null, filtroPeriodo = null) {
    // Compatibilidade barbeiro x servico validada ANTES de varrer os dias
    const idsPedidos = Array.isArray(servicoIds) ? servicoIds.map(Number).filter(n => Number.isFinite(n)) : [];
    if (barbeiroId || idsPedidos.length > 0) {
        const cat = await listarBarbeirosServicos();
        if (barbeiroId && idsPedidos.length > 0) {
            const b = cat.find(x => Number(x.id) === Number(barbeiroId));
            if (b) {
                const dele = new Set(b.servicos.map(s => Number(s.id)));
                if (!idsPedidos.every(id => dele.has(id))) {
                    const quemFaz = cat.filter(x => idsPedidos.every(id => x.servicos.some(s => Number(s.id) === id))).map(x => x.nome);
                    return { erro: `O barbeiro ${b.nome} NAO realiza o(s) servico(s) solicitado(s). ${quemFaz.length > 0 ? 'Quem realiza: ' + quemFaz.join(', ') + '. Ofereca esses barbeiros ao cliente — NUNCA liste horarios do barbeiro que nao realiza o servico.' : 'Nenhum barbeiro da equipe realiza esse(s) servico(s) — informe o cliente com naturalidade.'}` };
                }
            }
        } else if (idsPedidos.length > 0) {
            const quemFaz = cat.filter(x => idsPedidos.every(id => x.servicos.some(s => Number(s.id) === id)));
            if (quemFaz.length === 0) return { erro: 'Nenhum barbeiro da equipe realiza esse(s) servico(s). Informe o cliente com naturalidade e apresente os servicos disponiveis.' };
        }
    }
    const agoraBRT = new Date(Date.now() - 3 * 60 * 60 * 1000);
    // (v4.2.2) Se o cliente pediu "depois do dia X" / "so a partir de segunda", a busca deve
    // COMECAR dali, nao de hoje — sem isso, a ferramenta sempre devolvia o primeiro horario
    // livre a partir de AGORA, ignorando completamente esse pedido (o cliente dizia "nao
    // posso essa semana" e o bot insistia oferecendo horarios da mesma semana).
    let inicioBusca = agoraBRT;
    if (dataMinima) {
        const dataMinimaObj = new Date(`${dataMinima}T00:00:00-03:00`);
        if (!Number.isNaN(dataMinimaObj.getTime()) && dataMinimaObj > agoraBRT) inicioBusca = dataMinimaObj;
    }
    const diasEntreHojeEInicio = Math.max(0, Math.floor((inicioBusca.getTime() - agoraBRT.getTime()) / (24 * 60 * 60 * 1000)));
    for (let i = 0; i <= maxDias; i++) {
        const d = new Date(inicioBusca.getTime() + i * 24 * 60 * 60 * 1000);
        const data = d.toISOString().slice(0, 10);
        let disponibilidade = await verificarDisponibilidadeTodos(data, servicoIds);
        if (!Array.isArray(disponibilidade)) continue; // dia fechado ou sem vagas
        if (barbeiroId) {
            disponibilidade = disponibilidade.filter(b => Number(b.barbeiro_id) === Number(barbeiroId));
        }
        // (fix) Quando ha filtro de periodo/horario, so conta como "tem vaga" se sobrar pelo
        // menos 1 horario DENTRO desse filtro — antes, qualquer horario do dia (mesmo de manha,
        // quando o cliente pediu a noite) fazia essa data ser oferecida como "proxima com vaga".
        const temHorario = disponibilidade.some(b => (b.servicos || []).some(s =>
            (s.horarios || []).some(h => horarioNoFiltro(h, filtroPeriodo))
        ));
        if (temHorario) {
            if (filtroPeriodo) {
                disponibilidade = disponibilidade.map(b => ({
                    ...b,
                    servicos: (b.servicos || []).map(s => ({
                        ...s,
                        horarios: (s.horarios || []).filter(h => horarioNoFiltro(h, filtroPeriodo))
                    })).filter(s => (s.horarios || []).length > 0)
                })).filter(b => (b.servicos || []).length > 0);
            }
            return { data, diaSemana: nomeDiaSemanaPorData(data), diasAPartirDeHoje: diasEntreHojeEInicio + i, disponibilidade };
        }
    }
    return { erro: `Nenhum horario disponivel nos proximos ${maxDias} dias${dataMinima ? ` a partir de ${dataMinima}` : ''}${barbeiroId ? ' com este barbeiro' : ''}${filtroPeriodo && filtroPeriodo.periodo ? ` no periodo pedido (${filtroPeriodo.periodo})` : ''}. Informe isso ao cliente e sugira entrar em contato direto com a barbearia.` };
}

module.exports = { listarBarbeirosServicos, listarTodosServicosAtivos, verificarDisponibilidade, verificarDisponibilidadeTodos, buscarProximoHorario, buscarInfoBarbearia, buscarRespostasBot, criarAgendamento, criarAgendamentoMultiplo, buscarAgendamento, cancelarAgendamento, nomeDiaSemanaPorData };
