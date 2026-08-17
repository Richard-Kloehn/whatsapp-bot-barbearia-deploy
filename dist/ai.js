"use strict";
/**
 * Integração com IA para agendamentos via WhatsApp — via OpenRouter (chave unica que
 * gerencia varios provedores). Arquitetura de dois modelos:
 *  - ENTENDIMENTO (extrair o que o cliente quis dizer): modelo configurado em
 *    OPENROUTER_MODEL_CLASSIFICACAO (ou o mesmo do principal, se nao vier separado).
 *  - RESPOSTA FINAL (escrever a mensagem para o cliente, orquestrar as ferramentas): modelo
 *    configurado em OPENROUTER_MODEL.
 * O SDK da OpenAI e compativel com a OpenRouter (so troca a baseURL) — um cliente so serve
 * para os dois modelos, cada chamada especificando o slug do modelo desejado.
 */
const { OpenAI } = require('openai');
const { getSession, saveSession } = require('./ai-sessions');
const db = require('./ai-db');

function lerEnvObrigatoria(nome) {
    const valor = String(process.env[nome] || '').trim();
    if (!valor) {
        throw new Error(`[config] Variavel obrigatoria ausente: ${nome}. Defina essa variavel no .env ou no ambiente de execucao antes de iniciar o bot.`);
    }
    return valor;
}

const client = new OpenAI({
    apiKey: lerEnvObrigatoria('OPENROUTER_API_KEY'),
    baseURL: 'https://openrouter.ai/api/v1',
    // (fix) Sem timeout/maxRetries explicitos, o SDK usa o padrao (timeout bem longo,
    // poucas retentativas) — uma chamada lenta podia ficar "pendurada" por minutos antes
    // de falhar, e erros de rede/gateway (5xx, timeout, conexao) nao eram reforcados com
    // retentativa automatica da PROPRIA biblioteca. Isso e ALEM do retry que ja existe em
    // codigo (extrairEstadoDaConversa, identificarPessoasDoGrupo) — cobre a camada de
    // transporte (rede/gateway), enquanto o retry em codigo cobre falhas de conteudo
    // (resposta sem tool_call, JSON cortado etc). As duas camadas juntas dao bem mais
    // resiliencia contra a instabilidade da OpenRouter observada nos logs.
    timeout: 30 * 1000,
    maxRetries: 2,
    defaultHeaders: {
        // Opcionais, recomendados pela OpenRouter para identificar a origem das chamadas
        // nos relatorios de uso — nao sao obrigatorios para o funcionamento.
        'HTTP-Referer': process.env.SITE_URL || 'https://navalhasbcindaial.com.br',
        'X-Title': "Navalha's Barber Club Bot",
    },
});

// Modelo PRINCIPAL — conversa com o cliente, decide quais ferramentas chamar e escreve a
// resposta final. A configuracao vem OBRIGATORIAMENTE de OPENROUTER_MODEL; o processo falha na
// inicializacao se a variavel nao existir, para nunca cair silenciosamente num fallback antigo.
const MODEL = lerEnvObrigatoria('OPENROUTER_MODEL');
// Modelo de ENTENDIMENTO — usado nas extracoes/classificacoes internas (o que o cliente pediu,
// quantas pessoas, qual servico, cancelar ou manter). Se OPENROUTER_MODEL_CLASSIFICACAO nao
// vier separado, reaproveita exatamente o mesmo modelo principal configurado em MODEL.
const MODEL_CLASSIFICACAO = String(process.env.OPENROUTER_MODEL_CLASSIFICACAO || MODEL).trim();

// Chamada generica ao modelo de ENTENDIMENTO para tarefas de extracao estruturada e
// classificacao. Usa "tool calling" forcado em vez de response_format json_schema — em
// gateways multi-provedor como a OpenRouter, chamada de ferramenta e o mecanismo de saida
// estruturada que funciona de forma mais confiavel e uniforme entre provedores diferentes
// (Claude incluido), enquanto o suporte a json_schema estrito varia por provedor.
async function chamarClassificador(systemPrompt, userText, maxTokens, nomeFerramenta, schema) {
    const resp = await client.chat.completions.create({
        model: MODEL_CLASSIFICACAO,
        max_tokens: maxTokens,
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userText || '(vazio)' },
        ],
        tools: [{ type: 'function', function: { name: nomeFerramenta, description: 'Retorna o resultado estruturado pedido nas instrucoes do sistema.', parameters: schema } }],
        tool_choice: { type: 'function', function: { name: nomeFerramenta } },
    });
    const toolCall = resp.choices[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
        // (diagnostico) Antes o erro generico nao dizia POR QUE faltou o tool_call — podia ser
        // finish_reason:"length" (cortado pelo max_tokens antes de terminar), o modelo decidindo
        // responder com texto solto em vez de chamar a ferramenta, ou outro motivo. Loga o
        // finish_reason e um trecho do conteudo para diagnosticar sem precisar reproduzir o bug.
        const finishReason = resp.choices[0]?.finish_reason || '?';
        const conteudoBruto = (resp.choices[0]?.message?.content || '').toString().slice(0, 200);
        throw new Error(`Classificador nao retornou tool_call (finish_reason=${finishReason}, ferramenta=${nomeFerramenta}, conteudo="${conteudoBruto}")`);
    }
    return JSON.parse(toolCall.function.arguments);
}

// EXTRACAO UNICA E DEDICADA: quando um pedido envolve varias pessoas, capturar "quem e
// quem" (o papel/relacao que o cliente usou, tipo "filho", "marido") e o servico de cada
// uma A CADA TURNO (misturado com o resto do que o classificador principal precisa decidir)
// se mostrou fragil — a informacao dada la atras na conversa (ex: "pro marido cabelo e
// barba") se perdia quando o fluxo avancava pro proximo agendamento, fazendo o bot perguntar
// o servico de novo, ou pedir "nome e telefone" de forma generica o suficiente pro cliente
// responder com o proprio nome dele em vez do nome de quem sera realmente atendido. Esta
// chamada tem UM UNICO trabalho, roda quando o pedido multi-pessoa e identificado, e o
// resultado fica guardado deterministicamente — nao depende de acertar de novo depois.
async function identificarPessoasDoGrupo(textoConversa, catalogoServicos, catalogoBarbeiros, totalAgendamentos) {
    const catalogoTexto = Array.from(catalogoServicos.entries()).map(([id, nome]) => `${id} = ${nome}`).join('\n');
    const catalogoBarbeirosTexto = Array.from(catalogoBarbeiros.entries()).map(([id, nome]) => `${id} = ${nome}`).join('\n') || '(nenhum ainda)';
    const systemPromptGrupo = `O cliente esta agendando para ${totalAgendamentos} pessoas ao todo. Releia a transcricao com atencao e, na ORDEM em que cada pessoa foi mencionada PELA PRIMEIRA VEZ na conversa, identifique: (1) o "papel" dela — a palavra ou expressao exata que o CLIENTE usou pra se referir a essa pessoa (ex: "filho", "marido", "minha esposa", "eu", "eu mesmo" se o cliente estiver agendando pra ele proprio) — use a palavra do cliente, nao invente um nome; (2) os servico_ids dela, SE ja tiverem sido mencionados claramente (deixe vazio [] se ainda nao foi dito qual servico e dessa pessoa especificamente); (3) o periodo dela, somente se estiver explicitamente associado a ela (manha, tarde ou noite), senao null. NUNCA use um periodo de outra pessoa como periodo desta pessoa; (4) o horario EXATO dela, no formato "HH:MM", SOMENTE se um horario numerico especifico foi explicitamente associado a essa pessoa (ex: "as 10", "10h", "14:30", "barba a 11 para mim" = 11:00 para a pessoa "mim"), senao null. O horario pode aparecer ANTES ou DEPOIS da mencao da pessoa na frase (ex: "corte para meu filho as 10 e barba a 11 para mim" → filho:10:00, mim:11:00). NUNCA use um horario de outra pessoa como horario desta pessoa, e nunca confunda o horario de uma pessoa com o periodo/horario de outra so por estarem na mesma frase. (5) o barbeiro_id dela, do CATALOGO DE BARBEIROS abaixo, SOMENTE se um barbeiro especifico foi explicitamente pedido PARA ESSA PESSOA (ex: "corte e barba para meu marido... com o fabricio" = barbeiro_id do Fabricio para o marido), senao null. NUNCA use o barbeiro de outra pessoa como barbeiro desta pessoa, mesmo que so uma pessoa da frase tenha barbeiro citado. A ordem das pessoas na frase pode ser qualquer uma, e a frase pode nao repetir "para" antes de cada pessoa (ex: "filho corte de cabelo de manha e marido barba a tarde" tem 2 pessoas: filho->[corte], periodo manha; marido->[barba], periodo tarde — o "e" dentro do pedido de UMA pessoa lista servicos dela, nao separa pessoas). TOLERANCIA A ERROS DE DIGITACAO: identifique pelo significado. Se o numero de pessoas identificadas for diferente de ${totalAgendamentos}, retorne mesmo assim as que conseguir identificar com clareza.\n\nCATALOGO DE SERVICOS (id = nome):\n${catalogoTexto}\n\nCATALOGO DE BARBEIROS (id = nome):\n${catalogoBarbeirosTexto}`;
    const schemaGrupo = {
        type: 'object',
        properties: {
            pessoas: {
                type: 'array',
                items: { type: 'object', properties: { papel: { type: 'string' }, servico_ids: { type: 'array', items: { type: 'number' } }, periodo: { type: ['string', 'null'], enum: ['manha', 'tarde', 'noite', null] }, horario: { type: ['string', 'null'] }, barbeiro_id: { type: ['number', 'null'] } }, required: ['papel', 'servico_ids', 'periodo', 'horario', 'barbeiro_id'] },
            },
        },
        required: ['pessoas'],
    };

    // (fix) Retry unico: essa chamada e critica para o resto do fluxo de multi-agendamento
    // funcionar (papel/servico/periodo/horario/barbeiro de cada pessoa dependem dela), mas
    // ja foi observada falhando repetidas vezes na mesma conversa por instabilidade
    // momentanea da API (rede, timeout) — sem nenhuma tentativa nova, o grupo inteiro ficava
    // "cego" pro resto da conversa (pessoasPlano permanecia [] pra sempre), fazendo o bot
    // esquecer servico/horario/barbeiro ja informados e perguntar tudo de novo. Uma segunda
    // tentativa imediata resolve a maioria dos casos transitorios sem custo perceptivel.
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
            // (fix) 300 -> 450: com o campo barbeiro_id adicionado por pessoa, o JSON de
            // saida ficou maior (principalmente com 3+ pessoas no grupo) — 300 tokens podia
            // cortar a resposta no meio (mesmo padrao de "JSON cortado" ja visto e corrigido
            // no classificador principal), o que fazia essa chamada falhar sem necessidade.
            const resp = await chamarClassificador(systemPromptGrupo, textoConversa, 450, 'pessoas_do_grupo', schemaGrupo);
            const idsValidos = new Set(catalogoServicos.keys());
            const lista = Array.isArray(resp.pessoas) ? resp.pessoas : [];
            return lista.map(p => ({
                papel: typeof p?.papel === 'string' && p.papel.trim() ? p.papel.trim() : 'cliente',
                servico_ids: Array.isArray(p?.servico_ids) ? p.servico_ids.map(Number).filter(id => !Number.isNaN(id) && idsValidos.has(id)) : [],
                periodo: ['manha', 'tarde', 'noite'].includes(p?.periodo) ? p.periodo : null,
                // (fix) horario especifico da pessoa, ja capturado na identificacao do grupo —
                // ver uso em processarMensagemWhatsApp/restaurarContextoProximaPessoaGrupo, que
                // restaura esse valor em estado.horarioEscolhido quando chega a vez dessa pessoa,
                // em vez de depender do classificador principal re-adivinhar isso a cada turno.
                horario: (typeof p?.horario === 'string' && /^\d{1,2}:\d{2}$/.test(p.horario.trim()))
                    ? p.horario.trim().padStart(5, '0')
                    : null,
                // barbeiro especifico ja pedido para essa pessoa (ex: "com o Fabricio" para o
                // marido) — evita mostrar/consultar disponibilidade de TODOS os barbeiros quando
                // o cliente ja escolheu um so para essa pessoa do grupo.
                barbeiro_id: Number.isFinite(Number(p?.barbeiro_id)) && catalogoBarbeiros.has(Number(p.barbeiro_id))
                    ? Number(p.barbeiro_id)
                    : null,
            }));
        } catch (e) {
            console.log(`[ai] Falha ao identificar pessoas do grupo (tentativa ${tentativa}/2):`, e && e.message);
            if (tentativa === 2) return [];
        }
    }
    return [];
}

// Converte um 'papel' capturado na primeira pessoa para a segunda pessoa,
// para que a conversa com o cliente use 'seu filho', 'sua esposa', 'você', etc.
function toSecondPersonPapel(papel) {
    if (!papel || typeof papel !== 'string') return papel;
    let p = papel.trim();
    p = p.replace(/\bmeus\b/gi, 'seus');
    p = p.replace(/\bminhas\b/gi, 'suas');
    p = p.replace(/\bmeu\b/gi, 'seu');
    p = p.replace(/\bminha\b/gi, 'sua');
    p = p.replace(/\beu mesmo\b/gi, 'você mesmo');
    p = p.replace(/\beu mesma\b/gi, 'você mesma');
    p = p.replace(/\beu\b/gi, 'você');
    // (fix) faltava esta regra — "mim" (ex: cliente disse "...e um para mim") nao virava
    // "você", e a pergunta saia literalmente "prefere para mim?" em vez de "para você?".
    p = p.replace(/\bmim\b/gi, 'você');
    return p;
}


const TOOLS = [
    {
        type: 'function',
        function: {
            name: 'listar_barbeiros_servicos',
            description: 'Lista todos os barbeiros ativos e seus serviços com preço e duração.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    },
    {
        type: 'function',
        function: {
            name: 'verificar_disponibilidade_todos',
            description: 'Verifica horários disponíveis de barbeiros e serviços em uma data. Use SEMPRE este ao invés de verificar_disponibilidade quando quiser mostrar opções ao cliente — evita múltiplas chamadas. Se o cliente quiser MAIS DE UM servico DIFERENTE com o MESMO barbeiro em sequencia, PARA UMA UNICA PESSOA (ex: "corte e limpeza nasal" para ele mesmo), preencha servico_ids com os IDs de TODOS os servicos pedidos — o retorno tera UM UNICO horario de inicio para o bloco combinado (soma das duracoes), em vez de listas separadas por servico. NUNCA repita o mesmo ID varias vezes em servico_ids para representar VARIAS PESSOAS querendo o mesmo servico (ex: "corte pra mim e corte pro meu pai" NAO e servico_ids:[1,1] — isso tenta montar um combo de 60min impossivel). Quando ha MULTIPLAS PESSOAS, cada uma com seu proprio servico, chame esta ferramenta com o(s) ID(s) UNICO(S) dos servicos distintos pedidos (ex: so [1] se todos querem so corte), para ver a disponibilidade de cada barbeiro — cada pessoa depois escolhe seu proprio horario/barbeiro dessa mesma lista. Se o cliente JA especificou um barbeiro especifico para ESTE agendamento (ex: "com o Fabricio", "quero com a Felipe"), preencha barbeiro_id — o retorno tera SOMENTE aquele barbeiro, sem misturar horarios de outros que o cliente nao pediu.',
            parameters: {
                type: 'object',
                properties: {
                    data: { type: 'string', description: 'Data no formato YYYY-MM-DD (ex: 2026-06-10)' },
                    servico_ids: { type: 'array', items: { type: 'number' }, description: 'Preencha com 2+ IDs DIFERENTES quando UMA UNICA pessoa quiser varios servicos combinados com o mesmo barbeiro numa unica sequencia. NUNCA repita o mesmo ID para representar pessoas diferentes. Deixe vazio/omita para ver todos os servicos separadamente.' },
                    barbeiro_id: { type: ['number', 'null'], description: 'ID do barbeiro, SOMENTE se o cliente ja pediu um barbeiro especifico para este agendamento. Deixe null/omita se o cliente ainda nao escolheu barbeiro (nesse caso mostra todos).' }
                },
                required: ['data']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'verificar_disponibilidade',
            description: 'Verifica horários disponíveis para UM barbeiro e serviço específico. Use apenas quando o cliente já escolheu barbeiro e serviço e você precisa confirmar um horário específico.',
            parameters: {
                type: 'object',
                properties: {
                    data:        { type: 'string', description: 'Data no formato YYYY-MM-DD (ex: 2026-06-10)' },
                    barbeiro_id: { type: 'number', description: 'ID do barbeiro' },
                    servico_id:  { type: 'number', description: 'ID do serviço' }
                },
                required: ['data', 'barbeiro_id', 'servico_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_proximo_horario',
            description: 'Busca a PROXIMA data com horarios livres a partir de HOJE (ou de data_minima, se informado — varre os proximos dias automaticamente ate achar), opcionalmente de um barbeiro especifico e/ou de um combo de servicos. Use SEMPRE que o cliente perguntar pelo proximo horario disponivel, primeira vaga, ou \"quando tem horario\", SEM citar uma data especifica — NUNCA responda essa pergunta consultando apenas uma unica data, pois a primeira vaga pode ser em outro dia.',
            parameters: {
                type: 'object',
                properties: {
                    barbeiro_id: { type: 'number', description: 'ID do barbeiro, se o cliente pediu um especifico' },
                    servico_ids: { type: 'array', items: { type: 'number' }, description: 'IDs do(s) servico(s) desejado(s), se ja conhecidos' },
                    data_minima: { type: ['string', 'null'], description: 'YYYY-MM-DD — preencha SEMPRE que o cliente pedir horarios "depois de X", "a partir de segunda", "essa semana nao posso", etc. A busca comeca dessa data em diante, em vez de hoje. Deixe null/omita se o cliente so quer o proximo horario disponivel sem restricao de data minima.' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'criar_agendamento',
            description: 'Cria o agendamento. Use SOMENTE após confirmar todos os detalhes. O telefone é OBRIGATÓRIO e deve ser informado pelo próprio cliente (com DDD) — sempre pergunte ao cliente. Se o cliente quiser MAIS DE UM servico com o MESMO barbeiro em sequencia (ex: "corte e limpeza nasal"), preencha servico_ids com TODOS os IDs numa UNICA chamada — NUNCA chame esta ferramenta varias vezes em sequencia para isso: os horarios sequenciais e a gravacao de cada servico separado no banco sao calculados automaticamente pelo sistema, e chamar varias vezes causa erros.',
            parameters: {
                type: 'object',
                properties: {
                    nome:        { type: 'string', description: 'Nome completo do cliente' },
                    telefone:    { type: 'string', description: 'Telefone do cliente com DDD, informado pelo próprio cliente na conversa — obrigatório' },
                    data:        { type: 'string', description: 'Data YYYY-MM-DD' },
                    hora:        { type: 'string', description: 'Horário HH:MM (ex: 14:00) do INICIO do primeiro servico' },
                    barbeiro_id: { type: 'number', description: 'ID do barbeiro' },
                    servico_id:  { type: 'number', description: 'ID do serviço (use quando for APENAS UM servico)' },
                    servico_ids: { type: 'array', items: { type: 'number' }, description: 'Lista de IDs quando o cliente quiser 2+ servicos combinados numa unica vinda (ex: corte + limpeza nasal). Use ISSO em vez de servico_id nesse caso — NUNCA chame a ferramenta 2x.' }
                },
                required: ['nome', 'telefone', 'data', 'hora', 'barbeiro_id']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_agendamento',
            description: 'Busca agendamentos futuros do cliente pelo telefone E pelo nome. OBRIGATORIO informar tambem o nome (pelo menos o primeiro nome) porque varios clientes (ex: pais agendando para filhos) podem usar o mesmo telefone — buscar so pelo telefone pode retornar o agendamento da pessoa errada.',
            parameters: {
                type: 'object',
                properties: {
                    telefone: { type: 'string', description: 'Telefone do cliente' },
                    nome: { type: 'string', description: 'Nome (pelo menos o primeiro nome) do cliente cujo agendamento esta sendo buscado' }
                },
                required: ['telefone', 'nome']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_info_barbearia',
            description: 'Busca informacoes da barbearia: horario de funcionamento, dias, endereco, telefone, redes sociais (instagram, facebook, tiktok). Use quando o cliente perguntar sobre horarios, localizacao, contato ou redes sociais. Pode receber uma data opcional para verificar se a barbearia estara fechada naquele dia.',
            parameters: {
                type: 'object',
                properties: {
                    data: { type: 'string', description: 'Data opcional no formato YYYY-MM-DD para verificar se a barbearia estara fechada naquele dia especifico' }
                },
                required: []
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'cancelar_agendamento',
            description: 'Cancela um ou mais agendamentos futuros do cliente. Confirme com o cliente antes. Se o cliente quiser cancelar MAIS DE UM agendamento (ex: "os dois", "todos", "cancela os dois"), faca UMA UNICA chamada com agendamento_ids contendo todos os IDs REAIS (do mapeamento fornecido pelo sistema) — NUNCA chame esta ferramenta varias vezes em sequencia para cancelar varios agendamentos, pois isso causa erro. OBRIGATORIO informar tambem o nome (pelo menos o primeiro nome), pois varios clientes (ex: pais agendando para filhos) podem usar o mesmo telefone.',
            parameters: {
                type: 'object',
                properties: {
                    telefone:        { type: 'string', description: 'Telefone do cliente' },
                    nome:            { type: 'string', description: 'Nome (pelo menos o primeiro nome) do cliente cujo agendamento esta sendo cancelado' },
                    agendamento_id:  { type: 'number', description: 'ID REAL de UM agendamento (use quando for cancelar apenas um)' },
                    agendamento_ids: { type: 'array', items: { type: 'number' }, description: 'Lista de IDs REAIS quando o cliente quiser cancelar MAIS DE UM agendamento numa unica chamada' }
                },
                required: ['telefone', 'nome']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'buscar_respostas_bot',
            description: 'Busca perguntas e respostas cadastradas manualmente para a barbearia. Use SOMENTE quando o cliente fizer uma pergunta que voce nao consegue responder com as outras ferramentas (ex: duvidas sobre servicos especificos, procedimentos, produtos, promocoes, etc). Retorna todas as entradas ativas — interprete semanticamente qual melhor corresponde a duvida do cliente e use a resposta correspondente.',
            parameters: { type: 'object', properties: {}, required: [] }
        }
    }
];

function saudacaoPorHorario() {
    const hora = Number(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: 'numeric', hour12: false }));
    if (hora >= 5 && hora < 12) return 'Bom dia';
    if (hora >= 12 && hora < 18) return 'Boa tarde';
    return 'Boa noite';
}

const STATIC_PROMPT = `Voce e a assistente virtual da Navalha's Barber Club, responsavel por agendar horarios pelo WhatsApp.

Sua funcao:
- Agendar, consultar, cancelar e reagendar horarios
- Responder duvidas sobre a barbearia: horario de funcionamento, endereco, telefone, redes sociais — sempre buscando no banco com buscar_info_barbearia, nunca inventando informacoes
- Ser objetiva, profissional e resolver tudo no menor numero de mensagens possivel
- Sempre confirmar os detalhes antes de criar um agendamento

================================================================
REGRA ABSOLUTA — PROIBIDO INVENTAR QUALQUER INFORMACAO
================================================================
Voce NAO possui nenhum conhecimento proprio sobre esta barbearia.
ZERO. NENHUM.

Antes de responder QUALQUER coisa sobre a barbearia, voce OBRIGATORIAMENTE deve chamar a ferramenta correspondente. Sem excecao. Sem excecao mesmo que a resposta pareca "obvia". Sem excecao mesmo que ja tenha visto a informacao nesta conversa.

MAPA OBRIGATORIO — o que chamar antes de cada tipo de resposta:
- Servicos, precos, barbeiros disponíveis → listar_barbeiros_servicos
- Horarios livres em qualquer data → verificar_disponibilidade_todos\n- Proximo horario disponivel / primeira vaga / "quando tem horario" (SEM data citada) → buscar_proximo_horario

REGRA — "LOGO EM SEGUIDA" / PROXIMO HORARIO PARA A PROXIMA PESSOA: quando, dentro de um
fluxo de multiplas pessoas, o cliente disser algo como "logo em seguida", "assim que
terminar o meu", "em seguida do meu" (sem citar um numero de horario exato), isso significa
que ele quer o PRIMEIRO horario disponivel que atenda esse filtro — trate isso como uma
ESCOLHA implicita do primeiro horario da lista filtrada, NAO como um pedido para o cliente
escolher de novo. Nesse caso, apresente esse primeiro horario diretamente como a escolha
("Combinado, [horario] para o seu pai") e avance para pedir nome/telefone dele — NAO
pergunte "qual horario prefere" quando o cliente ja deixou claro que quer o mais cedo possivel.

REGRAS CRITICAS DE DATA E CATALOGO:
- Se o cliente pedir agendamento SEM informar a data, PERGUNTE qual dia ele deseja — NUNCA assuma que e para hoje e NUNCA responda "nao ha horarios hoje" se o cliente nao pediu hoje.
- Se o cliente pedir um servico que NAO existe no catalogo da barbearia (ex: um tratamento que nao fazemos), informe com simpatia que nao oferecemos esse servico e apresente os servicos disponiveis (consultando listar_barbeiros_servicos se ainda nao souber a lista) — NAO consulte disponibilidade nem pergunte data de um servico inexistente.
- Horario de funcionamento, endereco, telefone, redes sociais → buscar_info_barbearia
- Duvidas nao cobertas acima → buscar_respostas_bot

EXEMPLOS DE RESPOSTAS ABSOLUTAMENTE PROIBIDAS (nunca faca isso):
❌ "Ja e noite, a barbearia provavelmente esta fechada"
❌ "Hoje e sexta e deve estar encerrando"
❌ "Nao ha horarios disponiveis neste horario"
❌ "A barbearia funciona de segunda a sabado"
❌ "O servico de corte custa R$ 45,00"
❌ Qualquer afirmacao sobre a barbearia sem ter chamado a ferramenta NESTA mensagem
❌ Dizer que um periodo (manha/tarde/noite) nao tem horarios baseando-se numa lista de OUTRO periodo ja exibida na conversa
❌ Dizer que um barbeiro especifico NAO tem um horario sem ter verificado os dados REAIS daquele barbeiro especifico retornados pela ferramenta — nunca deduza, estime ou "ache" que um barbeiro nao tem disponibilidade

ATENCAO ESPECIAL: quando o cliente perguntar por outro periodo ("e de manha?", "a tarde tem algum?", "e a noite?"), outra data, um horario especifico ("depois das 17h", "a partir das 15h", "antes das 19h", "as 15h"), ou mudar de barbeiro/servico, isso e uma NOVA pergunta de disponibilidade — OBRIGATORIO chamar verificar_disponibilidade_todos NOVAMENTE antes de responder, MESMO que voce ja tenha os dados daquele dia em mensagens anteriores desta conversa. NUNCA reaproveite um resultado antigo da ferramenta para responder um novo filtro — os dados antigos podem ja ter mudado (novos agendamentos), e alem disso o SISTEMA so aplica a combinacao de multiplos servicos e o filtro de horario/periodo quando a ferramenta e chamada NA MESMA resposta; reaproveitar dados antigos pula essa etapa e produz respostas erradas (horario nao filtrado, servicos nao combinados, servico errado). As listas que voce ja exibiu na conversa estavam FILTRADAS por um periodo especifico e NAO dizem nada sobre os demais periodos.

⚠️ ISSO E O MAIS IMPORTANTE DE TODO ESTE DOCUMENTO ⚠️
NUNCA, EM NENHUMA HIPOTESE, assuma, deduza, estime ou "ache" qualquer informacao sobre a barbearia — servico, preco, barbeiro, horario disponivel ou ocupado, dia de funcionamento, endereco, qualquer coisa. Se voce nao tem 100% de certeza porque uma ferramenta retornou esse dado exato NESTA conversa, voce NAO SABE a resposta — e chamar a ferramenta e a UNICA forma de saber. Isso vale mesmo quando voce "acha que lembra" de algo que apareceu antes na conversa: dados de disponibilidade mudam a cada consulta (outros clientes podem ter agendado nesse meio tempo), entao releia sempre os dados EXATOS que a ferramenta retornou NESTA mensagem antes de afirmar qualquer coisa sobre eles — nunca responda de memoria ou por dedução propria.
Se voce responder sem chamar a ferramenta, ou responder baseado em suposicao propria em vez dos dados exatos retornados, voce esta inventando — e isso e inaceitavel.
================================================================

ESTILO DE COMUNICACAO (siga rigorosamente):
- Va direto ao ponto. Sem enrolacao, sem frases de preenchimento, sem repetir o que o cliente ja disse
- Cada mensagem sua deve avancar a conversa — nunca faca uma pergunta que ja pode ser respondida com informacao que voce ja tem ou pode buscar
- Antecipe-se: se o cliente disser algo como "quero marcar para amanha", ja busque e apresente DE UMA VEZ os barbeiros, servicos e horarios disponiveis para amanha — nao pergunte "qual barbeiro?" e depois "qual horario?" em mensagens separadas
- So peca dados do cliente (nome completo e telefone com DDD) quando todo o resto (data, barbeiro, servico, horario) ja estiver definido. E peca TUDO que falta numa UNICA mensagem (ex: "Qual seu nome completo e telefone com DDD?") — NUNCA em mensagens separadas, uma pedindo o nome e depois outra pedindo o telefone
- NUNCA use simbolos de formatacao como *, **, _, ou markdown de qualquer tipo. Escreva em texto corrido simples — esses simbolos aparecem quebrados para o cliente
- Listas devem ser objetivas, com quebras de linha simples (sem marcadores como * ou -, use travessao "-" apenas se necessario ou apenas numeracao "1.", "2.")
- Use emojis com moderacao (no maximo 1 por mensagem corrida, quando fizer sentido) — EXCETO nos formatos padronizados abaixo (disponibilidade e confirmacao), que tem seus proprios emojis fixos
- Mensagens curtas: no maximo 4-5 linhas, exceto os formatos padronizados abaixo
- EXCECAO ao tom direto: ao responder duvidas institucionais (endereco, horario de funcionamento, telefone, redes sociais), nao despeje os dados secos. Responda como uma secretaria simpatica, em frases completas e acolhedoras. Exemplo: "Nosso endereco e [endereco]. Nosso horario de atendimento e [horario]. Aguardamos voce!" Combine endereco e horario na mesma resposta quando fizer sentido, e finalize com um convite caloroso (ex: "Aguardamos voce!", "Sera um prazer atender voce!")
- Da mesma forma, ao listar horarios disponiveis ou confirmar agendamentos/cancelamentos, nao seja seca — use os formatos padronizados abaixo, que ja tem um tom acolhedor embutido

FORMATO PADRAO para apresentar disponibilidade (use SEMPRE que mostrar horarios livres — para 1 servico, para combo de multiplos servicos, para 1 barbeiro ou varios, SEM excecao):
O dia da semana da data consultada vem pronto na instrucao do sistema logo apos a chamada de verificar_disponibilidade_todos — use SEMPRE esse valor, nunca calcule por conta propria.
Use uma breve frase de abertura simpatica, depois liste cada barbeiro/servico com os emojis 👤 e 🕐 EXATAMENTE como no exemplo, agrupando os horarios livres numa unica linha separados por virgula. SEMPRE inclua o valor (e a duracao) na mesma linha do 👤, entre parenteses — os dados de preco/duracao ja vem no retorno da ferramenta (campo "preco"/"precoTotal" e "duracao"/"duracaoTotal"), nunca omita isso mesmo que o cliente nao pergunte o valor. NUNCA use lista com marcadores tipo "•", "-" ou numeracao para horarios — sempre a linha unica "🕐 Horarios: ...".

IMPORTANTE: Em multi-agendamento (mais de uma pessoa), apos a frase de abertura e ANTES de listar os barbeiros/horarios, adicione UMA linha explicativa indicando para quem e o agendamento. Exemplo: "Abaixo os horarios disponiveis para o agendamento do seu filho", "Horarios disponiveis para o agendamento do seu tio", etc. Use o papel/relacao da pessoa que foi informado pelo cliente.

Exemplo (1 servico, agendamento simples):

Temos disponibilidade para o dia 10/06 (quarta)! 😊

👤 Fabricio — Corte Masculino (R$ 45,00 - 30 min)
🕐 Horarios: 09:00, 09:30, 10:00, 10:30, 11:00, 13:00, 13:30

👤 Lucas — Barba (R$ 35,00 - 20 min)
🕐 Horarios: 14:00, 14:30, 15:00

Qual horario prefere?

Exemplo (multi-agendamento — note a linha adicional explicativa):

Temos disponibilidade para quinta, 06/08, a tarde! 😊
Abaixo os horarios disponiveis para o agendamento do seu filho:

👤 Fabricio — Corte de Cabelo (R$ 45,00 - 30 min)
🕐 Horarios: 14:15, 14:45, 15:15

Qual horario e barbeiro prefere para seu filho?

Exemplo (combo de multiplos servicos com o MESMO barbeiro — use os nomes dos servicos unidos por " + " na mesma linha do 👤, com o VALOR TOTAL do combo entre parenteses, nunca liste os servicos ou valores separadamente):

👤 Fabricio — Corte de Cabelo + Sobrancelha (navalha) — R$ 60,00 (45 min)
🕐 Horarios: 08:30, 09:15, 10:00, 10:45

Qual horario prefere?

(Se houver muitos horarios, pode agrupar por periodo — manha/tarde — mas cada periodo continua usando a linha "🕐 Horarios: ..." no mesmo formato, nunca marcadores. Adapte os emojis e nomes aos dados reais retornados pela ferramenta.)

REGRA ABSOLUTA SOBRE DATA E HORARIO: NUNCA calcule, deduza ou converta data, horario ou dia da semana por conta propria — voce erra isso com frequencia (inclusive fuso horario). Todas as ferramentas de agendamento (criar_agendamento, buscar_agendamento, cancelar_agendamento) retornam campos prontos: "diaSemana", "data" (dd/mm) e "hora" (HH:MM), ja no fuso correto de Brasilia. Use SEMPRE e SOMENTE esses valores exatos ao montar "[dia da semana, dd/mm]" e "[hh:mm]" nos formatos abaixo — nunca leia ou interprete outros campos de data/hora (como timestamps ISO) que porventura apareçam no retorno. Se os campos nao vierem no retorno da ferramenta, omita a informacao em vez de calcular.

FORMATO PADRAO de confirmacao de agendamento criado (siga EXATAMENTE esta estrutura, emojis e quebras de linha). SEMPRE inclua a linha "🙋 Cliente: [nomeCliente]" usando o valor EXATO retornado pela ferramenta — isso e OBRIGATORIO em TODO agendamento (mesmo quando so ha 1 cliente na conversa), e ainda mais importante quando ha mais de uma pessoa sendo agendada, para nao haver duvida de qual confirmacao e de quem:

Para agendamento de UM servico:
✅ Agendamento confirmado

🙋 Cliente: [nomeCliente]
📅 Data: [dia da semana, dd/mm]
🕐 Horario: [hh:mm]
👤 Barbeiro: [nome do barbeiro]
✂️ Servico: [nome do servico]
💰 Valor: R$ [valor]

🔔 Vamos te enviar um lembrete 24h antes do horario!

Navalha's Barber Club aguarda voce! 💈

Para agendamento de MULTIPLOS servicos (use esta variante e NUNCA mande confirmacoes separadas):
✅ Agendamento confirmado

🙋 Cliente: [nomeCliente]
📅 Data: [dia da semana, dd/mm]
🕐 Horario: [hh:mm do primeiro servico]
👤 Barbeiro: [nome do barbeiro]
✂️ Servicos: [servico 1] + [servico 2] (+ outros se houver)
💰 Valor total: R$ [soma dos valores]

🔔 Vamos te enviar um lembrete 24h antes do horario!

Navalha's Barber Club aguarda voce! 💈

Se voce criou agendamentos para MAIS DE UMA PESSOA na mesma conversa (uma chamada de criar_agendamento por pessoa), mostre uma confirmacao completa (com o formato acima, incluindo a linha do lembrete 24h) para CADA pessoa, uma apos a outra, na mesma mensagem — cada uma com o "🙋 Cliente:" correspondente, nunca omita nem junte as confirmacoes.

Se o retorno da ferramenta trouxer "precoVariavel": true (servico de preco variavel, ex: Platinado/Selagem/Luzes — o valor depende do comprimento/tipo do cabelo), na linha "💰 Valor:" escreva "A partir de R$ [valor]" em vez de so "R$ [valor]", e pode incluir uma frase curta explicando que o valor final e definido no dia do atendimento.

FORMATO PADRAO de aviso de agendamento(s) existente(s) — ha DUAS variantes, NUNCA misture as duas:

VARIANTE A — usada no PASSO 4.5 (informativo — NAO e uma pergunta, o agendamento sera confirmado na MESMA mensagem logo em seguida):
Voce ja tem agendamento marcado:
📅 [dia da semana, dd/mm] 🕐 [hh:mm] ✂️ [servico] 👤 [barbeiro]
(repita a linha acima para cada agendamento existente, sem numeracao se for so 1; use numeracao "1.", "2." se houver mais de 1)

Se quiser cancelar algum deles, e so falar.

VARIANTE B — usada DEPOIS que criar_agendamento ja retornou "id" com sucesso E o campo "avisoAgendamentosExistentes" (o novo agendamento JA FOI CRIADO — nunca pergunte se o cliente "deseja agendar", pois isso ja aconteceu; a unica pergunta valida e sobre os agendamentos ANTIGOS):
Mostre primeiro o FORMATO PADRAO de confirmacao de agendamento criado normalmente. Em seguida, na MESMA mensagem, acrescente:

Voce tambem ja tinha estes agendamentos marcados:
📅 [dia da semana, dd/mm] 🕐 [hh:mm] ✂️ [servico] 👤 [barbeiro]
(repita para cada item de avisoAgendamentosExistentes)

Se quiser cancelar algum deles, e so falar.

FORMATO PADRAO de confirmacao de cancelamento (siga EXATAMENTE esta estrutura, emojis e quebras de linha). SEMPRE inclua a linha "🙋 Cliente: [nomeCliente]" usando o valor EXATO retornado pela ferramenta:
✅ Agendamento cancelado com sucesso!

🙋 Cliente: [nomeCliente]
📅 Data: [dia da semana, dd/mm]
🕐 Horario: [hh:mm]
✂️ Servico: [nome do servico]

Se quiser remarcar, e so chamar! 💈

Se cancelar_agendamento cancelou MAIS DE UM agendamento (retorno com "multiplos": true e varios itens em "cancelados"), repita o bloco acima (Data/Horario/Servico) para CADA agendamento cancelado, um apos o outro, antes da frase final "Se quiser remarcar, e so chamar! 💈" (que aparece so uma vez no final). Use "✅ Agendamentos cancelados com sucesso!" no plural quando forem varios.

FORMATO PADRAO de confirmacao de reagendamento (siga EXATAMENTE esta estrutura):
✅ Horario reagendado com sucesso!

📅 Nova data: [dia da semana, dd/mm]
🕐 Novo horario: [hh:mm]
👤 Barbeiro: [nome do barbeiro]
✂️ Servico: [nome do servico]
💰 Valor: R$ [valor]

🔔 Vamos te enviar um lembrete 24h antes do novo horario!

Navalha's Barber Club aguarda voce! 💈

Fluxo para REAGENDAR (quando o cliente disser "quero mudar meu horario", "remarcar", "trocar o horario" ou similar):
1. Chame buscar_agendamento para localizar o agendamento atual do cliente
2. Se encontrar, mostre o agendamento atual e pergunte para qual nova data e horario deseja mudar. Se o cliente JA informou um horario especifico (ex: "as 14h", "14 horas", "para as 14:00") junto com a escolha de qual agendamento reagendar, NAO pergunte o periodo (manha/tarde/noite) de novo — o horario informado ja resolve isso, va direto ao PASSO 3. So pergunte "Prefere de manha, tarde ou noite?" se o cliente realmente NAO tiver citado nenhum horario/periodo ainda.
3. SERVICO: se o cliente NAO especificar um servico diferente para o novo horario, USE AUTOMATICAMENTE O MESMO SERVICO do agendamento que esta sendo reagendado — NUNCA pergunte de novo qual servico ele quer, a menos que ele peca explicitamente para trocar. Chame verificar_disponibilidade_todos para a nova data com esse servico.
   - Priorize mostrar/oferecer horarios do MESMO barbeiro do agendamento original.
   - Se o MESMO barbeiro NAO tiver nenhum horario disponivel no periodo/horario pedido, ofereca automaticamente os horarios de OUTROS barbeiros que atendem o mesmo servico nesse dia (deixando claro que seria com outro barbeiro), em vez de simplesmente dizer que nao ha disponibilidade.
   - Se o cliente pedir para mudar tambem o barbeiro ou o servico, use a nova escolha dele normalmente.
4. Quando o cliente confirmar a nova data e horario, execute em sequencia SEM informar o cliente dos passos internos:
   a. Crie o novo agendamento com criar_agendamento, usando o mesmo servico e barbeiro do agendamento original (a menos que o cliente tenha pedido outro)
   b. Cancele o agendamento ANTIGO (o que esta sendo reagendado) com cancelar_agendamento — isso e OBRIGATORIO, uma remarcacao NUNCA deve deixar o agendamento antigo ainda marcado
   c. Verifique os retornos: se criar_agendamento retornar "id", use o FORMATO PADRAO de reagendamento. Se retornar "erro", informe o cliente e NAO cancele o agendamento antigo
5. O cliente so ve uma unica mensagem final com o FORMATO PADRAO de reagendamento — nunca exponha os passos internos de criar e cancelar. O reagendamento SO esta completo depois que o agendamento antigo tiver sido cancelado — nunca finalize a conversa com o antigo e o novo marcados ao mesmo tempo.

Fluxo para agendar — siga EXATAMENTE esta ordem, passo a passo, sem pular nem inverter etapas:

================================================================
FLUXO DE AGENDAMENTO — REGRA ABSOLUTA DE ORDEM
================================================================
Siga EXATAMENTE esta sequencia. NUNCA pule ou inverta etapas.

PASSO 1 — VERIFICAR SE A DATA TEM HORARIOS:
Quando o cliente mencionar uma data, chame verificar_disponibilidade_todos.
- Lista vazia ou fechado → informe e sugira outra data
- Tem horarios → va ao PASSO 2 IMEDIATAMENTE. NAO exiba nada dos resultados ainda.

PASSO 2 — GARANTIR SERVICO E PERIODO (obrigatorio antes de qualquer exibicao de horarios):
Antes de mostrar horarios, voce precisa saber DUAS coisas: o SERVICO desejado e o PERIODO (manha, tarde ou noite).
- Se o cliente NAO informou o servico → pergunte qual servico deseja (se ele nao conhecer os servicos, chame listar_barbeiros_servicos e liste apenas os nomes e precos, SEM horarios). Se os barbeiros oferecem os MESMOS servicos (catalogo identico, que e o caso normal), mostre a lista de servicos UMA UNICA VEZ (sem repetir por barbeiro) — NUNCA repita a mesma listagem de servicos para cada barbeiro separadamente, isso e redundante e confuso. So separe por barbeiro se os catalogos realmente forem diferentes entre eles. Apresente a lista retornada por listar_barbeiros_servicos de forma DIRETA e SIMPLES — NUNCA peca desculpas nem comente espontaneamente sobre algum servico do catalogo "nao ter barbeiro disponivel" ou "faltar informacao" a menos que o CLIENTE tenha perguntado especificamente por aquele servico. O catalogo mostrado e o cardapio geral da barbearia — ele nao precisa ser justificado ou explicado, so apresentado.
- Se o cliente NAO informou o periodo nem um horario especifico → pergunte "Prefere de manha, tarde ou noite?"
- Pergunte o que estiver faltando numa UNICA mensagem curta. Se nada estiver faltando, va direto ao PASSO 3.
NUNCA pergunte se o cliente tem preferencia de barbeiro. Se ele nao citar um barbeiro, mostre os horarios de TODOS os barbeiros que atendem o servico.
Se o cliente ja citou um horario especifico (ex: "quero as 15h"), NAO pergunte o periodo — o horario ja define o periodo.
DEFINICAO DE PERIODOS (use sempre ao filtrar horarios): manha = horarios ate 11:59; tarde = horarios de 13:00 ate 17:59; noite = horarios a partir das 18:00 (inclusive).

PASSO 3 — MOSTRAR HORARIOS FILTRADOS:
Com servico E periodo definidos, filtre o resultado do PASSO 1 e mostre APENAS os horarios do periodo e servico escolhidos, usando o FORMATO PADRAO de disponibilidade.
- Se o cliente citou um barbeiro especifico → mostre apenas os horarios daquele barbeiro
- Se NAO citou barbeiro → mostre os horarios de TODOS os barbeiros que atendem o servico, agrupados por barbeiro
- Se o cliente pediu MAIS DE UM servico com o mesmo barbeiro (ex: "corte e limpeza nasal", "barba e sobrancelha"): NUNCA mostre listas de horarios separadas por servico. Primeiro chame listar_barbeiros_servicos (se ainda nao souber os IDs), depois chame verificar_disponibilidade_todos NOVAMENTE preenchendo servico_ids com os IDs de TODOS os servicos pedidos — o retorno tera UM horario combinado por barbeiro (bloco unico, duracao somada). Mostre esse horario UNICO, nunca duas listas lado a lado.
A pergunta de fechamento da mensagem depende de quantos barbeiros aparecem na lista exibida:
- Apenas UM barbeiro na lista → termine com "Qual horario prefere?"
- MAIS DE UM barbeiro na lista → termine com "Qual horario e barbeiro prefere?"
NUNCA pergunte novamente sobre servico ou periodo neste passo — ja foram definidos no PASSO 2.

REGRA — O CLIENTE JA DISSE UM HORARIO EXATO PARA ESTE AGENDAMENTO (vale tanto para agendamento simples quanto para CADA pessoa de um multi-agendamento — ex: "corte pro meu filho as 10 e barba as 11 pra mim" tem um horario exato PARA CADA UMA das duas pessoas): quando o campo "horario escolhido" ja aparecer preenchido no ESTADO abaixo para o agendamento atual, NAO mostre a lista completa de horarios livres nem pergunte "qual horario prefere" sem antes checar esse horario exato contra os dados reais retornados por verificar_disponibilidade_todos:
- Se esse horario exato estiver disponivel com APENAS UM barbeiro (e o cliente NAO especificou qual barbeiro quer) → NAO pergunte nada, va direto ao PASSO 4 com esse barbeiro e esse horario ja definidos, como se o cliente ja tivesse escolhido — igual ao comportamento da regra "LOGO EM SEGUIDA" no inicio deste documento.
- Se esse horario exato estiver disponivel com MAIS DE UM barbeiro (e o cliente NAO especificou qual barbeiro quer) → pergunte APENAS qual barbeiro ele prefere; o horario ja esta definido, NUNCA pergunte o horario de novo. Exemplo: "Nesse horario (11:00) temos o Felipe e o Bryan disponiveis. Qual prefere?"
- Se o cliente JA especificou o barbeiro tambem, e esse barbeiro tem esse horario exato disponivel → va direto ao PASSO 4, sem perguntar nada.
- Se esse horario exato NAO estiver disponivel (nem para o barbeiro pedido, nem para nenhum outro que atenda o servico, conforme os dados retornados pela ferramenta NESTA mensagem) → informe isso EXPLICITAMENTE citando o horario pedido, e SO ENTAO mostre os horarios realmente livres daquele(s) barbeiro(s) para o servico no dia, começando a mensagem com esta abertura (adapte servico/pessoa/dia/hora aos dados reais): "Para [o servico] [de quem — ex: "na segunda", "do seu filho na segunda"], [dia da semana], [dd/mm], o horario das [HH:MM] nao esta disponivel. O [nome do barbeiro] tem est(e/es) horario(s) [pela manha/a tarde/a noite, se fizer sentido agrupar por periodo]:" e em seguida a linha padrao "🕐 Horarios: ...". Exemplo real: "Para sua barba na segunda, 10/08, o horario das 11:00 nao esta disponivel. O Felipe tem este horario:" seguido de "🕐 Horarios: 10:00". NUNCA volte a perguntar "qual horario prefere" de forma seca sem antes citar explicitamente que o horario pedido nao estava disponivel — o cliente precisa entender que a lista mostrada e uma ALTERNATIVA ao horario que ele pediu, nao a resposta normal a uma pergunta em aberto.
================================================================

PASSO 4 — COLETAR DADOS DO CLIENTE:
Quando o cliente escolher barbeiro e horario, peca "nome completo (nome e sobrenome)" e o telefone com DDD numa UNICA mensagem (ex: "Qual seu nome completo e telefone com DDD?").
VALIDACAO OBRIGATORIA ANTES DE PROSSEGUIR: quando o cliente responder, verifique se o nome tem PELO MENOS DUAS palavras (nome e sobrenome). Se tiver apenas uma palavra, NAO avance — peca o sobrenome numa nova mensagem e AGUARDE a resposta. So va para o PASSO 4.5 depois de ter nome completo E telefone.
ATENCAO — AGENDAMENTO PARA OUTRA PESSOA: se for UM unico agendamento para outra pessoa, o campo "nome" desse agendamento DEVE ser o nome completo de quem vai ser atendido — NUNCA reaproveite ou repita o nome do proprio cliente (que esta digitando) por engano.

ATENCAO — AGENDAMENTO PARA MAIS DE UMA PESSOA NA MESMA CONVERSA (ex: cliente pede um servico para ele mesmo E outro servico diferente "para o meu pai"/"para minha esposa" na mesma mensagem ou conversa): cada pessoa e um AGENDAMENTO COMPLETAMENTE SEPARADO E INDEPENDENTE — NUNCA junte os servicos de pessoas diferentes num unico servico_ids/combo. Isso e ERRO GRAVE (ex: "corte e sobrancelha para mim, corte e barba para meu pai" NAO e um combo de 4 servicos para 1 pessoa — sao DOIS agendamentos de 2 servicos cada, um para cada pessoa). Ao chamar criar_agendamento (ou usar servico_ids para combo), faca UMA chamada POR PESSOA, cada uma com APENAS os servico_ids QUE ELA vai fazer. NESSE CENARIO, peca o contato UMA UNICA VEZ para registrar o lote todo, usando a frase: "Informe seu nome completo e telefone para registrar os agendamentos". Depois de receber esse contato, reaproveite-o para os demais agendamentos do grupo e NAO volte a pedir nome/telefone a cada pessoa.

PASSO 4.5 — VERIFICAR AGENDAMENTOS EXISTENTES (obrigatorio, ANTES de confirmar ou criar):
Assim que tiver nome completo E telefone, chame buscar_agendamento com esse telefone E o nome (pelo menos o primeiro nome) ANTES de mostrar qualquer resumo de confirmacao — informar so o telefone NAO basta, pois pais podem agendar para filhos usando o mesmo numero, e buscar so por telefone pode trazer o agendamento da pessoa errada.
- Se retornar agendamento(s) existente(s), NAO pergunte se o cliente deseja manter ou cancelar — isso so gera ambiguidade e risco de cancelar por engano. Em vez disso, na MESMA mensagem: primeiro informe os agendamentos existentes usando a VARIANTE A (curta, com emojis, terminando em "Se quiser cancelar algum deles, e so falar."), e IMEDIATAMENTE EM SEGUIDA, na mesma mensagem, continue normalmente para a confirmacao final do NOVO agendamento (PASSO 5) — NAO espere resposta do cliente antes de prosseguir.
- Se nao houver nenhum, NUNCA mencione isso ao cliente (nao diga "voce nao tem agendamentos marcados" ou qualquer variacao) — siga direto e silenciosamente para a confirmacao final abaixo, como se essa verificacao nao tivesse acontecido.
CANCELAMENTO SO ACONTECE SE O CLIENTE PEDIR EXPLICITAMENTE (em qualquer momento da conversa, nao so logo apos o aviso do PASSO 4.5): frases como "manter", "pode deixar", "ta bom assim", "so isso mesmo" significam que o cliente NAO quer cancelar nada — NUNCA chame cancelar_agendamento nesses casos. So chame cancelar_agendamento quando o cliente pedir para cancelar/desmarcar de forma clara e inequivoca. CANCELAR E IRREVERSIVEL — se a mensagem do cliente puder ser lida de mais de um jeito (ex: "nao cancela e agenda esse", que pode significar tanto "nao, cancele, e agenda esse" quanto "nao cancele, e agenda esse tambem"), NAO decida sozinho: pergunte de volta para confirmar explicitamente, por exemplo "Só para confirmar: você quer que eu cancele o agendamento das 14:30, ou prefere manter os dois?" — e so chame cancelar_agendamento depois de uma resposta inequivoca.

PASSO 5 — CRIAR O AGENDAMENTO:
Para UM servico: chame criar_agendamento com servico_id e verifique o retorno:
- Retornou "id" → use o FORMATO PADRAO de confirmacao para um servico
- Retornou "erro" → informe o problema ao cliente e NUNCA mostre confirmacao
Para MULTIPLOS servicos (ex: corte + limpeza nasal): chame criar_agendamento UMA UNICA VEZ com servico_ids contendo TODOS os IDs — NUNCA chame a ferramenta varias vezes em sequencia para isso, o sistema calcula os horarios sequenciais e grava cada servico automaticamente. Verifique o retorno:
- Retornou "ids" (array) → use o FORMATO PADRAO de confirmacao de multiplos servicos, com servicoCombinado e precoTotal do retorno
- Retornou "erro" → informe o problema ao cliente e NUNCA mostre confirmacao
Note que o aviso de agendamentos existentes ja foi dado no PASSO 4.5 — nao repita esse aviso apos criar, a menos que o retorno de criar_agendamento traga um "avisoAgendamentosExistentes" diferente do que ja foi informado.

================================================================
FLUXO PARA CANCELAR (quando o cliente disser "quero cancelar", "cancelar meu horario" ou similar, SEM ja ter especificado exatamente qual agendamento por data/horario):
================================================================
1. Se o telefone ou o nome (pelo menos o primeiro nome) ainda nao foram informados nesta conversa, peca antes de continuar.
2. Chame buscar_agendamento com o telefone E o nome — NUNCA busque so pelo telefone, pois o mesmo numero pode ter agendamentos de outra pessoa (ex: filho agendado pelos pais).
3. Se retornar 0 agendamentos, informe que nao ha agendamento futuro encontrado para esse telefone.
4. Se retornar 1 ou mais agendamentos, SEMPRE liste todos (data, horario, servico, barbeiro) numerados e pergunte qual o cliente deseja cancelar — mesmo se houver apenas 1, confirme qual é antes de cancelar. NUNCA cancele sem antes mostrar ao cliente qual agendamento sera cancelado e obter confirmacao/escolha dele.
5. So chame cancelar_agendamento DEPOIS que o cliente confirmar ou escolher qual.
Excecao: se o cliente ja descreveu claramente qual agendamento quer cancelar na propria mensagem inicial (ex: "cancelar meu horario de terca as 15h"), pode pular a listagem e confirmar cancelamento diretamente com base nessa descricao.
================================================================

Regras IMPORTANTES:
- Os UNICOS barbeiros que existem sao os que aparecem no retorno de listar_barbeiros_servicos ou verificar_disponibilidade_todos. Se o cliente mencionar um nome de barbeiro que NAO aparece em nenhum desses retornos, isso significa que esse barbeiro NAO EXISTE na barbearia — informe isso claramente (ex: "Nao temos um barbeiro com esse nome. Nossos barbeiros sao: [liste os nomes reais]") em vez de dizer que ele "esta sem horarios disponiveis" (essa frase da a entender erroneamente que o barbeiro existe mas so nao tem vaga)
- Quando o cliente fizer uma pergunta que voce nao consegue responder com as ferramentas de agendamento ou buscar_info_barbearia, SEMPRE chame buscar_respostas_bot antes de dizer que nao pode ajudar — pode haver uma resposta cadastrada que corresponda a duvida dele. So diga que nao pode ajudar se buscar_respostas_bot tambem nao retornar nada relevante
- Voce so responde sobre agendamentos, cancelamentos, informacoes da barbearia e assuntos cadastrados em buscar_respostas_bot. Se mesmo apos consultar buscar_respostas_bot nao houver resposta, ai sim redirecione educadamente (ex: "So consigo ajudar com agendamentos e informacoes da Navalha's Barber Club. Posso marcar um horario para voce?")
- Ao responder com base em buscar_respostas_bot, NAO oferea automaticamente para agendar esse item como servico — as respostas dessa tabela sao informacoes gerais e podem nao ser servicos agenDAveis. Apenas responda a duvida e aguarde o cliente continuar
- NUNCA invente informacoes da barbearia — sempre use buscar_info_barbearia para buscar endereco, telefone, horarios e redes sociais
- NUNCA crie agendamento sem confirmar nome, data, horario, barbeiro e servico
- CRITICO — BARBEIRO ERRADO NA CRIACAO: ao chamar criar_agendamento para MULTIPLAS PESSOAS na mesma conversa, cada pessoa pode ter pedido um barbeiro DIFERENTE (ex: "eu com o felipe as 14:15, e meu filho as 14:30 com o bryan") — antes de cada chamada de criar_agendamento, releia a mensagem do cliente e confirme qual barbeiro_id corresponde especificamente AQUELA pessoa (nome + telefone) que voce esta criando agora. NUNCA assuma ou adivinhe QUAL barbeiro usar quando isso ainda nao foi confirmado explicitamente pelo cliente — em especial, NUNCA reaproveite o barbeiro de OUTRO agendamento da conversa (ex: do proprio cliente) para um NOVO agendamento (ex: de um filho/familiar) sem o cliente ter dito explicitamente que quer o mesmo barbeiro. Se voce ja ofereceu mais de um barbeiro para um horario (ex: "posso agendar com o Felipe ou o Bryan") e o cliente responder so confirmando o horario sem escolher o barbeiro (ex: "pode ser 18h"), pergunte qual dos barbeiros oferecidos ele prefere ANTES de chamar criar_agendamento — nunca escolha por conta propria
- Se voce ja informou nesta conversa que um horario especifico esta disponivel (com base em dados reais da ferramenta) e o cliente confirmar esse mesmo horario logo em seguida, NAO diga que esse horario "ja esta ocupado" a menos que criar_agendamento realmente retorne erro de conflito — isso seria contradizer uma informacao que voce mesmo acabou de confirmar como verdadeira
- NUNCA chame verificar_disponibilidade ou verificar_disponibilidade_todos de novo para um servico/barbeiro/horario que voce JA mostrou como disponivel nas ultimas mensagens e o cliente apenas confirmou (ex: cliente escolheu "pode ser 14:30" depois de voce ja ter mostrado esse horario disponivel) — re-verificar arrisca voce escolher o servico_id ERRADO (ja aconteceu: confundiu "Limpeza nasal" com "Degrade navalhado" porque chamou a ferramenta de novo sem necessidade). Nesses casos, va DIRETO para criar_agendamento usando o MESMO servico/barbeiro/horario ja confirmados momentos antes na conversa
- Ao chamar criar_agendamento, o servico_id(s) DEVE ser exatamente o servico que o cliente pediu na mensagem mais recente sobre este agendamento especifico — NUNCA junte servicos de pedidos anteriores ja concluidos (de outro agendamento, de outra pessoa, ou de uma tentativa abandonada) com o pedido atual
- NUNCA diga que a barbearia esta fechada, que o horario ja passou, que "provavelmente esta encerrado" ou qualquer variacao disso com base na sua propria percepcao do horario — isso e PROIBIDO mesmo que seja noite, fim de semana ou feriado. SEMPRE chame verificar_disponibilidade_todos PRIMEIRO e so informe indisponibilidade se a ferramenta retornar lista vazia. Exemplo PROIBIDO: "ja e noite de sexta e a barbearia provavelmente esta fechada" — isso nunca deve acontecer sem ter chamado a ferramenta
- Se nao houver horarios para o servico pedido na data pedida, ja sugira a proxima data com horarios livres para aquele servico, sem fazer o cliente perguntar
- Se o cliente pedir um HORARIO ESPECIFICO (ex: "quero as 15h") e esse horario NAO estiver disponivel (confirmado pela ferramenta), mostre TODOS os horarios livres retornados pela ferramenta para aquele barbeiro naquele dia (manha e tarde, agrupados se for uma lista longa) — NUNCA mostre apenas 3 ou 4 "horarios mais proximos" e omita o resto, o cliente pode preferir um horario mais tarde do dia que nao esta perto do horario pedido. Se o barbeiro pedido nao tiver NENHUM horario livre naquele dia, ofereca os horarios de OUTROS barbeiros disponiveis nesse mesmo dia/horario. Em qualquer um dos casos, avise tambem que a barbearia atende por ordem de chegada — o cliente pode comparecer sem agendamento e aguardar. Exemplo: "Esse horario ja esta ocupado. Mas o Fabricio tem estes outros horarios livres hoje: 09:15, 09:30, 09:45, 10:00, 10:15, ... (lista completa). E se preferir, a barbearia tambem atende por ordem de chegada — e so chegar e aguardar a vez!"
- Se o cliente perguntar depois "so tem ate tal horario?" ou algo parecido questionando se a lista esta completa, SEMPRE responda com a lista COMPLETA de horarios livres daquele dia (manha e tarde) — nunca uma lista parcial nem so a parte que ele perguntou.
- Responda SEMPRE em portugues do Brasil, em tom profissional e cordial
- Ao confirmar um agendamento criado com sucesso, use SEMPRE, palavra por palavra e emoji por emoji, o FORMATO PADRAO de confirmacao de agendamento acima — nunca substitua por uma frase corrida tipo "Seu agendamento foi confirmado!"
- Ao confirmar um cancelamento, use SEMPRE, palavra por palavra e emoji por emoji, o FORMATO PADRAO de confirmacao de cancelamento acima
- Sempre que o cliente cumprimentar (ex: "oi", "ola", "bom dia", "boa tarde") em QUALQUER momento da conversa, responda cumprimentando de volta com a saudacao adequada ao horario antes de responder qualquer outra coisa
- Quando o cliente quiser agendar e ja souber o servico e a data mas nao tiver informado preferencia de periodo, SEMPRE pergunte antes: "Voce prefere de manha, tarde ou noite?" — e so entao busque e apresente os horarios do periodo escolhido. Se ele ja disser o periodo (ex: "de manha", "a tarde", "a noite"), va direto aos horarios sem perguntar novamente
- Quando o cliente agendar mais de um servico, NUNCA mande confirmacoes separadas — use sempre o FORMATO PADRAO de multiplos servicos com os servicos combinados e o valor total somado
- Em MULTI-AGENDAMENTO com mais de uma pessoa, use UM UNICO contato de agente para registrar todos os atendimentos do grupo. NAO peça "nome completo de cada pessoa" nem solicite nomes separados por pessoa. Se ainda faltar escolher horarios para o grupo, nao peça nome/telefone; isso so deve ser pedido depois que todos os horarios do grupo tiverem sido escolhidos.
- Quando o cliente pedir para agendar algo "logo apos" ou "em seguida" a outro agendamento (seu ou de outra pessoa, ex: filho), calcule o horario de TERMINO desse agendamento de referencia (horario de inicio + duracao do servico, ambos ja conhecidos na conversa ou retornados pela ferramenta) — esse horario de termino E o horario que atende ao pedido "logo apos". Verifique se esse horario exato esta disponivel (com qualquer barbeiro, a menos que o cliente peca o mesmo barbeiro especificamente) usando os dados ja retornados por verificar_disponibilidade_todos. Se esse horario exato estiver na lista de disponiveis, ofereca-o diretamente como a opcao que atende ao pedido — NUNCA diga "nao temos disponibilidade logo apos" e em seguida ofereca esse MESMO horario como se fosse uma alternativa separada; isso e contraditorio e confunde o cliente.`;

function buildSystemPrompt(primeiraMensagem, numeroConfiavel, blocoEstado) {
    const hoje = new Date().toLocaleDateString('pt-BR', {
        weekday: 'long', day: '2-digit', month: 'long', year: 'numeric',
        timeZone: 'America/Sao_Paulo'
    });
    const saudacao = saudacaoPorHorario();
    const instrucaoAbertura = primeiraMensagem
        ? `ESTA E A PRIMEIRA MENSAGEM DESTA CONVERSA — sua resposta DEVE comecar EXATAMENTE com esta frase, sem alterar nenhuma palavra, nenhum emoji, nenhuma pontuacao:
"${saudacao}! Seja bem-vindo ao Navalha's Barber Club. 💈 Como podemos ajudar?

Para agendamentos e cancelamentos, visite nosso site navalhasbcindaial.com.br ou, se preferir, podemos seguir por aqui."
PROIBIDO usar qualquer variacao como "Como posso ajudar?", "Como posso te ajudar?", "Como posso ajudar voce hoje?" ou qualquer outra. Somente a saudacao (Bom dia/Boa tarde/Boa noite) muda conforme o horario — o restante da frase e fixo e exato.
Se o cliente ja tiver dito o que precisa nesta primeira mensagem, apos a frase de abertura ja atenda o pedido na mesma mensagem. Se so tiver mandado uma saudacao, apenas a frase acima basta.`
        : `Esta NAO e a primeira mensagem da conversa — NAO repita a saudacao de abertura nem o "bem-vindo". Va direto ao que o cliente pediu.`;
    const instrucaoTelefone = `TELEFONE DO CLIENTE: o telefone DEVE sempre ser informado pelo proprio cliente na conversa — NUNCA use um numero capturado automaticamente. Antes de usar criar_agendamento, buscar_agendamento ou cancelar_agendamento, voce DEVE ter o telefone (com DDD) informado pelo cliente e preenche-lo no campo "telefone" da ferramenta — nao deixe esse campo vazio. Ao agendar, peca o telefone JUNTO com o nome, na MESMA mensagem (ex: "Qual seu nome completo e telefone com DDD?") — nunca em mensagens separadas. Ao cancelar ou consultar agendamentos, peca o telefone antes de chamar a ferramenta, caso o cliente ainda nao tenha informado nesta conversa.`;

    return `${STATIC_PROMPT}

Contexto desta conversa:
- Hoje e ${hoje} (horario de Brasilia)
- Saudacao adequada para o horario atual: "${saudacao}"
- ${instrucaoAbertura}
- ${instrucaoTelefone}

${blocoEstado}

LEMBRETE OBRIGATORIO (releia antes de cada resposta): NUNCA responda sobre disponibilidade, servicos, horarios, precos ou qualquer dado da barbearia sem antes chamar a ferramenta correspondente. Chame a ferramenta PRIMEIRO, depois responda. Sem excecao.`;
}

// Antes de CRIAR o agendamento, confere (com um classificador dedicado, dado o catalogo
// real de servicos do barbeiro) quais servicos o cliente realmente pediu na conversa —
// nunca confia cegamente nos servico_id(s) que o modelo principal escolheu sozinho, pois
// ele pode confundir servicos parecidos (ex: escolher "Barba" quando o cliente pediu
// "Limpeza nasal"). Retorna a lista de IDs corrigida, ou a original se nao for possivel validar.

async function confirmarServicoIds(barbeiroId, idsPropostos, textoConversa, nomeCliente) {
    try {
        const catalogo = await db.listarBarbeirosServicos();
        // Coercao para Number em toda comparacao de ID — o modelo (via JSON) ou o input do
        // tool-call podem entregar o ID como string ("12" em vez de 12), o que quebraria
        // silenciosamente comparacoes estritas (===) e o Set/Map.has(), fazendo o sistema
        // achar que "nenhum servico foi confirmado" mesmo quando o cliente foi claro.
        const barbeiroIdNum = Number(barbeiroId);
        const barbeiro = catalogo.find(b => Number(b.id) === barbeiroIdNum);
        if (!barbeiro) return idsPropostos;
        const catalogoTexto = barbeiro.servicos.map(s => `${s.id} = ${s.nome}`).join('\n');
        // Quando ha mais de uma pessoa sendo agendada na mesma conversa, o nome desta chamada
        // especifica de criar_agendamento diz para QUEM sao os servicos — sem isso o classificador
        // pode juntar servicos de pessoas diferentes (ex: "corte pra mim, corte e barba pro meu
        // pai" virando um combo errado de varios servicos para uma pessoa so).
        const contextoPessoa = nomeCliente
            ? `\n\nIMPORTANTE: esta chamada e para o agendamento de "${nomeCliente}" especificamente. Se a conversa mencionar servicos para OUTRAS pessoas alem dela, IGNORE os servicos dessas outras pessoas — inclua APENAS os servicos que "${nomeCliente}" mesma vai fazer.`
            : '';

        const resp = await chamarClassificador(
            `Com base na transcricao da conversa, identifique quais servicos do catalogo abaixo o cliente pediu para agendar AGORA (a tentativa de agendamento MAIS RECENTE, ja confirmada por ele). TOLERANCIA A ERROS DE DIGITACAO: o cliente pode escrever o nome do servico com erro de digitacao ou ortografia (ex: "nazal" por "nasal") — identifique pelo SIGNIFICADO, comparando com os nomes do catalogo mesmo sem grafia identica.\n\nMUITO IMPORTANTE: baseie-se APENAS nas mensagens do CLIENTE para decidir o que ele pediu. As mensagens do Atendente na transcricao podem listar VARIOS ou TODOS os servicos do catalogo (ex: ao mostrar opcoes disponiveis) — isso NAO significa que o cliente pediu todos eles. O cliente normalmente pede 1 ou 2 servicos por vez; se voce estiver prestes a incluir mais de 3 IDs, revise com cuidado se o CLIENTE (nao o Atendente) realmente mencionou cada um deles. Priorize SEMPRE o pedido de servico mais RECENTE da conversa — se o cliente pediu um servico A antes e depois pediu claramente um servico B diferente (nova tentativa, novo agendamento), use APENAS B; NUNCA combine A e B automaticamente so porque ambos aparecem na transcricao, a menos que o cliente tenha pedido os dois JUNTOS explicitamente na mesma frase (ex: "corte e barba").${contextoPessoa}\n\nCATALOGO (id = nome):\n${catalogoTexto}`,
            textoConversa,
            60,
            'servicos_pedidos',
            {
                type: 'object',
                properties: { servico_ids: { type: 'array', items: { type: 'number' } } },
                required: ['servico_ids'],
            }
        );
        const json = resp;
        const idsValidos = new Set(barbeiro.servicos.map(s => Number(s.id)));
        let idsConfirmados = Array.isArray(json.servico_ids)
            ? json.servico_ids.map(Number).filter(id => !Number.isNaN(id) && idsValidos.has(id))
            : [];
        // Trava de seguranca: um cliente nao pede mais de ~4 servicos de uma vez na pratica.
        // Se o classificador "alucinar" e retornar uma lista muito maior que a proposta original
        // (ja visto acontecer quando a transcricao contem uma listagem grande de catalogo feita
        // pelo proprio Atendente), descarta o resultado do classificador e usa o original —
        // e mais seguro pedir confirmacao de novo do que criar um combo absurdo por engano.
        const LIMITE_SERVICOS_POR_PESSOA = 4;
        if (idsConfirmados.length > LIMITE_SERVICOS_POR_PESSOA || idsConfirmados.length > idsPropostos.length + 2) {
            idsConfirmados = idsPropostos;
        }
        return idsConfirmados.length > 0 ? idsConfirmados : idsPropostos;
    } catch {
        return idsPropostos;
    }
}

// Classificador dedicado (IA, nao regex fixo) para entender se a ULTIMA mensagem do cliente
// pede para MANTER os agendamentos existentes ou para CANCELAR algum — clientes escrevem isso
// de formas muito variadas ("manten", "pode deixar", "ta bom assim", "nao precisa mexer",
// "cancela o das 14h"), entao um regex fixo nunca cobre tudo. O CODIGO continua sendo quem
// decide bloquear ou nao — a IA so classifica a intencao, nunca decide sozinha se cancela.
async function classificarIntencaoCancelamento(ultimaFalaAtendente, ultimaFalaCliente) {
    try {
        // Inclui a PERGUNTA do atendente (se houver) — sem isso, uma resposta curta como "1"
        // parece ambigua isolada, mas e uma escolha clara quando o atendente acabou de listar
        // agendamentos numerados e perguntar qual cancelar.
        const contexto = ultimaFalaAtendente ? `${ultimaFalaAtendente}\n${ultimaFalaCliente}` : ultimaFalaCliente;
        if (/\breagend|\bremarc|\btroc(ar|a)\s+(meu\s+)?hor[aá]rio|\bmud(ar|a)\s+(meu\s+)?hor[aá]rio/i.test(contexto)) {
            return 'cancelar';
        }
        const resp = await chamarClassificador(
            'Classifique a intencao do cliente em relacao a agendamento(s) EXISTENTE(s) ja mencionados na conversa. Considere a PERGUNTA do Atendente (se fornecida) para interpretar corretamente respostas curtas/numericas do Cliente — se o Atendente perguntou algo como "qual agendamento deseja cancelar?" com uma lista numerada, o Cliente responder so o numero de uma opcao (ex: "1", "2") conta como CANCELAR aquele item.\n"manter" = o cliente quer MANTER/preservar o(s) agendamento(s) existente(s), sem cancelar nada (ex: "pode manter", "manten os dois", "deixa como esta", "nao precisa mexer em nada", "ta bom assim", "so isso mesmo", "so quero adicionar o novo").\n"cancelar" = o cliente pede explicitamente para CANCELAR, desmarcar ou remover algum agendamento existente — inclui escolher um item de uma lista numerada quando a pergunta anterior era sobre qual cancelar.\n"indefinido" = a mensagem nao fala claramente sobre manter nem cancelar nada, e nao ha pergunta anterior do atendente que explique uma escolha isolada (ex: um numero) como cancelamento.',
            contexto,
            30,
            'intencao_cancelamento',
            {
                type: 'object',
                properties: { intencao: { type: 'string', enum: ['manter', 'cancelar', 'indefinido'] } },
                required: ['intencao'],
            }
        );
        const json = resp;
        return ['manter', 'cancelar', 'indefinido'].includes(json.intencao) ? json.intencao : 'indefinido';
    } catch {
        return 'indefinido';
    }
}

async function executarTool(name, input, phone, numeroConfiavel, textoConversa, estado) {
    try {
        // O telefone deve SEMPRE ser informado pelo cliente — nunca usamos o numero
        // capturado do WhatsApp (pode vir errado ou pertencer a outra pessoa)
        const precisaTelefoneExplicito = ['criar_agendamento', 'buscar_agendamento', 'cancelar_agendamento'].includes(name);
        if (precisaTelefoneExplicito && !input.telefone) {
            return JSON.stringify({ erro: 'Telefone nao informado. Pergunte o numero (com DDD) ao cliente e preencha o campo telefone. NAO confirme nenhuma acao antes disso.' });
        }
        // O nome tambem e SEMPRE obrigatorio para buscar/cancelar: o mesmo telefone pode ter
        // agendamentos de mais de uma pessoa (ex: pais agendando para filhos), entao buscar so
        // pelo telefone pode retornar/afetar o agendamento da pessoa errada.
        if ((name === 'buscar_agendamento' || name === 'cancelar_agendamento') && !(input.nome || '').trim()) {
            return JSON.stringify({ erro: 'Nome nao informado. Pergunte pelo menos o primeiro nome do cliente e preencha o campo nome antes de buscar/cancelar — o telefone sozinho pode pertencer a mais de uma pessoa (ex: pais e filhos).' });
        }
        // Validacao minima de formato: telefone brasileiro tem 10 ou 11 digitos (DDD + numero).
        // Normaliza primeiro (remove codigo do pais 55) antes de validar o comprimento,
        // pois o cliente pode informar o numero com DDI (ex: 5511999999999 = valido).
        if (precisaTelefoneExplicito) {
            let digitos = (input.telefone || '').replace(/\D/g, '');
            if (digitos.length > 11 && digitos.startsWith('55')) digitos = digitos.slice(2);
            if (digitos.length < 10 || digitos.length > 11) {
                return JSON.stringify({ erro: 'Telefone invalido. Deve ter DDD + numero (10 ou 11 digitos, ex: 47991557386). Peca o telefone correto ao cliente.' });
            }
        }
        const telefoneEfetivo = input.telefone;
        // Data no passado nunca vira "sem horarios" — vira instrucao clara de pedir outra data
        if ((name === 'verificar_disponibilidade' || name === 'verificar_disponibilidade_todos') && input && input.data) {
            const hojeISO = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
            if (String(input.data) < hojeISO) {
                return JSON.stringify({ erro: `A data ${input.data} ja passou (hoje e ${hojeISO}). Pergunte ao cliente uma data valida, sem listar horarios.` });
            }
        }
        switch (name) {
            case 'listar_barbeiros_servicos':
                // Retorna o CATALOGO COMPLETO da barbearia (todos os servicos ativos), nao so
                // os que algum barbeiro disponivel hoje realiza — quando o cliente pergunta
                // "quais servicos voces tem", a resposta e o cardapio geral, independente de
                // quem esta trabalhando naquele dia especifico. A validacao de compatibilidade
                // barbeiro x servico (ex: "Fabricio nao faz Selagem") continua usando
                // listarBarbeirosServicos internamente em outros pontos do codigo — nao mudou.
                return JSON.stringify(await db.listarTodosServicosAtivos());
            case 'verificar_disponibilidade_todos': {
                // Remove IDs duplicados em codigo — o modelo ja tentou usar servico_ids:[1,1] para
                // representar "2 pessoas querendo o mesmo servico" (em vez de 1 pessoa com 2 servicos
                // diferentes), o que monta um combo de duracao dobrada impossivel e retorna vazio.
                const idsUnicos = Array.isArray(input.servico_ids) ? [...new Set(input.servico_ids)] : input.servico_ids;
                
                // Em multi-agendamento, passa agendamentos pendentes (ja escolhidos mas nao salvos)
                // para bloquear horarios conflitantes ao exibir disponibilidade para proximas pessoas
                let agendamentosPendentes = [];
                if (estado.multiAgendamento && estado.selecoesGrupo.length > 0) {
                    const catalogoServicos = await db.listarTodosServicosAtivos();
                    const mapaDuracoes = new Map(catalogoServicos.map(s => [Number(s.id), s.duracao]));
                    
                    agendamentosPendentes = estado.selecoesGrupo.map(sel => {
                        const duracaoTotal = sel.servico_ids.reduce((soma, id) => soma + (mapaDuracoes.get(Number(id)) || 0), 0);
                        return {
                            barbeiro_id: sel.barbeiro_id,
                            data: sel.data,
                            hora: sel.hora,
                            duracao: duracaoTotal
                        };
                    });
                }
                
                return JSON.stringify(await db.verificarDisponibilidadeTodos(input.data, idsUnicos, agendamentosPendentes, input.barbeiro_id || null));
            }
            case 'buscar_proximo_horario': {
                const idsProx = Array.isArray(input.servico_ids) && input.servico_ids.length > 0 ? [...new Set(input.servico_ids)] : undefined;
                // (fix) Respeita o periodo/horario que o cliente ja pediu na conversa (ex: "a noite")
                // — sem isso, a proxima data sugerida podia ter vaga so de manha/tarde.
                const filtroPeriodoProx = (estado.periodo || estado.horarioMinimo || estado.horarioMaximo)
                    ? { periodo: estado.periodo || null, horarioMinimo: estado.horarioMinimo || null, horarioMaximo: estado.horarioMaximo || null }
                    : null;
                return JSON.stringify(await db.buscarProximoHorario(input.barbeiro_id || null, idsProx, 21, input.data_minima || null, filtroPeriodoProx));
            }
            case 'buscar_info_barbearia':
                return JSON.stringify(await db.buscarInfoBarbearia(input.data || null));
            case 'verificar_disponibilidade': {
                // Compatibilidade barbeiro x servico validada em codigo
                const catCompat = await db.listarBarbeirosServicos();
                const bCompat = catCompat.find(x => Number(x.id) === Number(input.barbeiro_id));
                if (bCompat && !bCompat.servicos.some(s => Number(s.id) === Number(input.servico_id))) {
                    const quemFaz = catCompat.filter(x => x.servicos.some(s => Number(s.id) === Number(input.servico_id))).map(x => x.nome);
                    return JSON.stringify({ erro: `O barbeiro ${bCompat.nome} NAO realiza esse servico. ${quemFaz.length > 0 ? 'Quem realiza: ' + quemFaz.join(', ') + '. Ofereca esses barbeiros ao cliente.' : 'Nenhum barbeiro realiza esse servico — informe o cliente.'}` });
                }
                
                // Em multi-agendamento, passa agendamentos pendentes
                let agendamentosPendentes = [];
                if (estado.multiAgendamento && estado.selecoesGrupo.length > 0) {
                    const catalogoServicos = await db.listarTodosServicosAtivos();
                    const mapaDuracoes = new Map(catalogoServicos.map(s => [Number(s.id), s.duracao]));
                    
                    agendamentosPendentes = estado.selecoesGrupo.map(sel => {
                        const duracaoTotal = sel.servico_ids.reduce((soma, id) => soma + (mapaDuracoes.get(Number(id)) || 0), 0);
                        return {
                            barbeiro_id: sel.barbeiro_id,
                            data: sel.data,
                            hora: sel.hora,
                            duracao: duracaoTotal
                        };
                    });
                }
                
                return JSON.stringify(await db.verificarDisponibilidade(input.data, input.barbeiro_id, input.servico_id, agendamentosPendentes));
            }
            case 'criar_agendamento': {
                // Validacao no codigo: o banco exige nome completo — nunca confiar so no prompt
                const nomeLimpo = (input.nome || '').trim();
                if (nomeLimpo.split(/\s+/).length < 2) {
                    return JSON.stringify({ erro: 'Nome incompleto. E OBRIGATORIO nome e sobrenome. O agendamento NAO foi criado. Peca o sobrenome ao cliente e tente novamente. NAO mostre confirmacao. NAO diga "ocorreu um erro" ou qualquer variacao de erro/falha ao cliente — apenas informe de forma natural e simpatica que precisa do nome completo, com sobrenome, para continuar.' });
                }
                const idsPropostos = Array.isArray(input.servico_ids) && input.servico_ids.length > 0
                    ? input.servico_ids
                    : (input.servico_id ? [input.servico_id] : []);
                // Se os IDs ja vieram FORCADOS do estado validado (trava no ponto onde a
                // ferramenta e chamada), NAO manda outro classificador re-adivinhar por cima —
                // isso reintroduziria o mesmo risco que a trava existe para eliminar (o
                // classificador re-lendo a conversa do zero e confundindo o combo certo com um
                // item PARECIDO do catalogo). So usa confirmarServicoIds como rede de seguranca
                // quando o estado NAO tinha servico definido (fallback raro).
                // (fix) BUG: em multiAgendamento, essa comparacao usava estado.servico_ids — um
                // campo GENERICO de "servico atual" que fica desatualizado assim que todas as
                // pessoas do grupo ja escolheram horario (ele pode ficar com o servico da
                // ULTIMA pessoa registrada, nao da pessoa deste agendamento especifico). Como
                // idsPropostos (JA vindo corretamente de estado.selecoesGrupo via a trava
                // anterior) quase nunca batia com esse campo desatualizado, idsVieramDoEstado
                // dava falso NEGATIVO e acionava confirmarServicoIds — um classificador de IA
                // que releu a conversa toda e, sem forma de distinguir "filho" de "marido"
                // (ambos agendados com o mesmo nome/telefone do responsavel), juntou os servicos
                // das duas pessoas num agendamento so (ex: Corte de Cabelo + Sobrancelha).
                // Agora tambem aceita como confiavel quando os IDs batem com a selecao JA
                // validada do grupo (estado.selecoesGrupo[agendamentosCompletos]), que e a fonte
                // de verdade correta em fluxo multi-pessoa.
                const selecaoPendenteAtualParaIds = obterSelecaoPendenteAtual(estado);
                const idsBatemComSelecaoDoGrupo = estado.multiAgendamento && selecaoPendenteAtualParaIds &&
                    JSON.stringify([...idsPropostos].sort()) === JSON.stringify([...selecaoPendenteAtualParaIds.servico_ids].sort());
                const idsVieramDoEstado = idsBatemComSelecaoDoGrupo || (estado.servico_ids.length > 0 &&
                    JSON.stringify([...idsPropostos].sort()) === JSON.stringify([...estado.servico_ids].sort()));
                const idsConfirmados = (!idsVieramDoEstado && idsPropostos.length > 0 && textoConversa)
                    ? await confirmarServicoIds(input.barbeiro_id, idsPropostos, textoConversa, nomeLimpo)
                    : idsPropostos;

                const idsExcluirAviso = Array.isArray(estado._idsExcluirAvisoNestaRodada) ? estado._idsExcluirAvisoNestaRodada : [];
                if (idsConfirmados.length > 1) {
                    return JSON.stringify(await db.criarAgendamentoMultiplo(
                        nomeLimpo, telefoneEfetivo, input.data, input.hora, input.barbeiro_id, idsConfirmados, idsExcluirAviso
                    ));
                }
                return JSON.stringify(await db.criarAgendamento(
                    nomeLimpo, telefoneEfetivo, input.data, input.hora, input.barbeiro_id, idsConfirmados[0], idsExcluirAviso
                ));
            }
            case 'buscar_agendamento': {
                // Guarda de defesa em profundidade: mesmo se a trava do fluxo principal
                // nao pegar (ex: o modelo chamou por conta propria fora de forcarTool),
                // o codigo aqui tambem recusa buscar sem nome — o mesmo telefone pode ser
                // de mais de uma pessoa da familia.
                if (!input.nome) {
                    return JSON.stringify({ erro: 'Nome completo nao informado. E OBRIGATORIO pedir o nome completo do cliente antes de buscar agendamentos — o mesmo telefone pode pertencer a mais de uma pessoa da familia (pai e filho, por exemplo). Peca o nome completo ao cliente.' });
                }
                return JSON.stringify(await db.buscarAgendamento(telefoneEfetivo, input.nome));
            }
            case 'cancelar_agendamento': {
                if (estado.reagendamentoEmAndamento && estado.reagendamentoAlvo && !estado._novoReagendamentoCriadoNestaRodada) {
                    return JSON.stringify({ erro: 'BLOQUEADO: no reagendamento, crie primeiro o novo horario usando o mesmo servico e barbeiro do agendamento selecionado; somente depois cancele o agendamento antigo.' });
                }
                // TRAVA DETERMINISTICA: o CODIGO decide se bloqueia, nao o modelo principal.
                // Cancelamento e IRREVERSIVEL, entao a regra e "nega por padrao": so libera
                // quando o classificador tem CERTEZA de que a ULTIMA mensagem do cliente pede
                // explicitamente para cancelar. Qualquer coisa que nao seja claramente "cancelar"
                // (inclusive "indefinido" — ex: cliente so informou nome/telefone) bloqueia —
                // o modelo principal ja cancelou agendamentos por engano mais de uma vez
                // interpretando silencio ou ambiguidade como permissao.
                const cancelamentoInternoDeReagendamento = estado.reagendamentoEmAndamento &&
                    ((Array.isArray(input.agendamento_ids) && input.agendamento_ids.length > 0) || !!input.agendamento_id);
                if (textoConversa && !cancelamentoInternoDeReagendamento) {
                    // Agrupa por TURNO completo (nao por linha) — mensagens do atendente com
                    // varias linhas (ex: lista numerada de agendamentos) precisam ficar juntas,
                    // senao a pergunta real ("qual deseja cancelar?") fica fora do contexto.
                    const turnosConversa = [];
                    for (const linha of textoConversa.split('\n')) {
                        const m = linha.match(/^(Cliente|Atendente): (.*)$/);
                        if (m) {
                            turnosConversa.push({ quem: m[1], texto: linha });
                        } else if (turnosConversa.length > 0) {
                            turnosConversa[turnosConversa.length - 1].texto += '\n' + linha;
                        }
                    }
                    let idxUltimoCliente = -1;
                    for (let i = turnosConversa.length - 1; i >= 0; i--) {
                        if (turnosConversa[i].quem === 'Cliente') { idxUltimoCliente = i; break; }
                    }
                    const ultimaFalaCliente = idxUltimoCliente >= 0 ? turnosConversa[idxUltimoCliente].texto : '';
                    // Pega a fala do Atendente imediatamente ANTES dessa ultima fala do cliente,
                    // para dar contexto a respostas curtas/numericas (ver classificarIntencaoCancelamento)
                    let ultimaFalaAtendente = '';
                    for (let i = idxUltimoCliente - 1; i >= 0; i--) {
                        if (turnosConversa[i].quem === 'Atendente') { ultimaFalaAtendente = turnosConversa[i].texto; break; }
                    }
                    if (ultimaFalaCliente) {
                        const intencao = await classificarIntencaoCancelamento(ultimaFalaAtendente, ultimaFalaCliente);
                        if (intencao !== 'cancelar') {
                            return JSON.stringify({ erro: 'BLOQUEADO: a ultima mensagem do cliente NAO pede claramente para cancelar (pode ser sobre manter, ou nao ter relacao nenhuma com cancelamento, ex: apenas informando nome/telefone). Cancelamento e IRREVERSIVEL, entao E PROIBIDO cancelar sem um pedido explicito e inequivoco. Se o cliente quer manter tudo e so criar o novo agendamento, chame APENAS criar_agendamento, sem chamar cancelar_agendamento. Se realmente precisar cancelar, pergunte de volta para confirmar antes.' });
                        }
                    }
                }
                const ids = Array.isArray(input.agendamento_ids) && input.agendamento_ids.length > 0
                    ? input.agendamento_ids
                    : (input.agendamento_id ? [input.agendamento_id] : [null]);
                // (fix Bug #6) TRAVA DETERMINISTICA: sem ID explicito, db.cancelarAgendamento cai
                // no padrao de cancelar o agendamento mais proximo no tempo — que pode NAO ser o
                // que o cliente escolheu quando ele tem 2+ agendamentos. Ate aqui nada no CODIGO
                // obrigava a IA a informar qual ID cancelar, so havia instrucao em texto pedindo
                // pra sempre confirmar (que o modelo principal pode ignorar). Bloqueia em codigo,
                // no mesmo padrao das outras travas deterministicas deste arquivo, sempre que
                // faltar ID E houver mais de um agendamento conhecido nesta conversa — exceto no
                // cancelamento interno automatico de um reagendamento, que ja resolve seu proprio
                // alvo separadamente (reagendamentoAlvo.id) antes de chegar aqui.
                const nenhumIdInformado = ids.length === 1 && ids[0] == null;
                if (nenhumIdInformado && !cancelamentoInternoDeReagendamento &&
                    Array.isArray(estado.mapaAgendamentos) && estado.mapaAgendamentos.length > 1) {
                    return JSON.stringify({ erro: 'BLOQUEADO: o cliente tem mais de um agendamento e nenhum ID foi informado nesta chamada. E OBRIGATORIO identificar EXATAMENTE qual agendamento cancelar antes de chamar esta ferramenta de novo — use o mapeamento de IDs REAIS ja fornecido no ESTADO (NUNCA a posicao da lista) em agendamento_id/agendamento_ids. Se ainda nao ficou claro qual o cliente quer cancelar, pergunte a ele antes de tentar de novo.' });
                }
                if (ids.length === 1) {
                    return JSON.stringify(await db.cancelarAgendamento(telefoneEfetivo, ids[0], input.nome));
                }
                const resultados = [];
                for (const id of ids) {
                    resultados.push(await db.cancelarAgendamento(telefoneEfetivo, id, input.nome));
                }
                const cancelados = resultados.filter(r => r.cancelado === true);
                const comErro = resultados.filter(r => r.cancelado !== true);
                return JSON.stringify({ multiplos: true, cancelados, comErro });
            }
            case 'buscar_respostas_bot':
                return JSON.stringify(await db.buscarRespostasBot());
            default:
                return JSON.stringify({ erro: 'Ferramenta desconhecida' });
        }
    } catch (err) {
        console.error(`[ai] Erro na tool "${name}":`, err.message);
        return JSON.stringify({ erro: err.message });
    }
}

// ===================================================================================
// ESTADO DA CONVERSA MANTIDO PELO CODIGO (nao pela IA)
// A cada mensagem, UM UNICO classificador extrai filtros/nome/telefone e a consulta
// necessaria; o codigo valida contra o catalogo real, mescla no estado da sessao e
// injeta um bloco [ESTADO] no system prompt. IDs e preferencias sobrevivem entre turnos
// sem depender de a IA "lembrar" — elimina a classe inteira de IDs adivinhados.
// ===================================================================================

function estadoInicial() {
    return {
        data: null,
        // Controle multi-agendamento SIMPLIFICADO (apenas contadores)
        multiAgendamento: false,       // true se cliente pediu mais de 1 agendamento
        totalAgendamentos: 1,          // quantos agendamentos ao todo (minimo 1)
        agendamentosCompletos: 0,      // quantos ja foram criados com sucesso
        // (fix) default TRUE: o cliente NAO deve precisar confirmar a quantidade de
        // agendamentos que ele mesmo acabou de pedir (ex: "corte pro filho e sobrancelha
        // pro marido" ja deixa claro que sao 2) — isso so vira false no caso excepcional de
        // quantidade suspeita/alta demais (possivel alucinacao do classificador, ver abaixo).
        _totalConfirmado: true,        // evita repetir confirmação do total
        // Estado do agendamento ATUAL (foco único - um por vez)
        ultimoAgendamentoConfirmado: null, // memoria deterministica para comandos como "o mesmo"
        reagendamentoEmAndamento: false,
        reagendamentoAlvo: null,
        pessoasPlano: [],      // [{papel, servico_ids}] capturado 1x quando ha multi-agendamento — evita perder o servico/quem-e-quem de cada pessoa ao avancar para a proxima
        selecoesGrupo: [],     // [{data, hora, barbeiro_id, servico_ids, papel}] escolhas do grupo antes de pedir contato e gravar tudo
        periodo: null, horarioMinimo: null, horarioMaximo: null, horarioEscolhido: null,
        // (fix) periodoGrupo: guarda o periodo combinado para TODO O GRUPO (ex: "amanha a
        // tarde para os dois") separado do "periodo" normal — que e sobrescrito com null
        // toda vez que a IA extrai um horario ESPECIFICO da mensagem atual (ex: "felipe 14"),
        // mesmo quando essa mensagem so escolhe o horario da pessoa atual e nao tem nada a
        // ver com mudar o periodo combinado do grupo. Sem isso, o bot esquecia o periodo ao
        // avancar pra proxima pessoa do lote e perguntava "manha, tarde ou noite?" de novo.
        periodoGrupo: null,
        // (fix v4.2.6) barbeiroGrupo: mesma ideia do periodoGrupo acima, mas para o
        // barbeiro. Quando o cliente pede o mesmo barbeiro para TODO o grupo numa unica
        // frase (ex: "corte pro filho e barba pro marido, com o bryan"), esse barbeiro
        // se aplicava so a pessoa ATUAL — ao avancar pra proxima pessoa do grupo,
        // estado.barbeiro_id era zerado (correto, pra nao herdar um barbeiro incompativel
        // por engano) mas NADA restaurava a preferencia do cliente, entao a proxima pessoa
        // acabava vendo TODOS os barbeiros de novo, como se o cliente nao tivesse pedido
        // ninguem especifico. Guarda aqui o barbeiro combinado pra restaurar (se ele
        // tambem atender o servico da proxima pessoa) ao avancar.
        barbeiroGrupo: null,
        barbeiro_id: null, servico_ids: [],
        nome: null, telefone: null,
        contatoSolicitado: false, // true depois que o bot pediu o contato UNA VEZ para um multi-agendamento
        mapaAgendamentos: null,       // agendamentos futuros ja localizados (IDs REAIS)
        criadosNestaConversa: []      // resumo dos agendamentos criados nesta sessao
    };
}

function obterIndicePessoaAtual(estado) {
    const selecionados = Array.isArray(estado.selecoesGrupo) ? estado.selecoesGrupo.length : 0;
    if (estado.multiAgendamento && selecionados > estado.agendamentosCompletos) return selecionados;
    return estado.agendamentosCompletos;
}

function obterSelecaoPendenteAtual(estado) {
    return Array.isArray(estado.selecoesGrupo) ? (estado.selecoesGrupo[estado.agendamentosCompletos] || null) : null;
}

function normalizarHorarioHHMM(valor, periodo) {
    if (typeof valor !== 'string') return null;
    const v = valor.trim();
    if (/^\d{2}:\d{2}$/.test(v)) return v;
    const m = v.match(/^(\d{1,2})(?::(\d{2}))?$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = m[2] != null ? Number(m[2]) : 0;
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    // (fix Bug #5) "2", "5" etc sem minutos, em periodo "tarde" ou "noite": converte de
    // 12h para 24h (ex: "felipe 2" + periodo tarde = 14:00). ANTES essa conversao so
    // cobria o periodo "noite", entao um horario de TARDE como esse virava 02:00 (2 da
    // manha) por engano. h===12 fica como esta (meio-dia ja e a hora cheia certa em
    // qualquer formato) — somar 12 nesse caso geraria "24:00", um horario invalido.
    if (m[2] == null && h >= 1 && h <= 11 && (periodo === 'tarde' || periodo === 'noite')) {
        return `${String(h + 12).padStart(2, '0')}:00`;
    }
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function proximaDataISO(dataISO) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dataISO || ''))) return null;
    const d = new Date(`${dataISO}T12:00:00-03:00`);
    if (Number.isNaN(d.getTime())) return null;
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
}

function barbeiroIdPorNome(nomeBarbeiro, catalogoBarbeiros) {
    const alvo = String(nomeBarbeiro || '').trim().toLowerCase();
    if (!alvo) return null;
    for (const [id, nome] of catalogoBarbeiros.entries()) {
        if (String(nome).trim().toLowerCase() === alvo) return Number(id);
    }
    return null;
}

function servicoIdsPorNome(nomeServico, catalogoServicos) {
    const alvo = String(nomeServico || '').trim().toLowerCase();
    if (!alvo) return [];
    const ids = [];
    for (const [id, nome] of catalogoServicos.entries()) {
        if (String(nome).trim().toLowerCase() === alvo) ids.push(Number(id));
    }
    return ids;
}

function mensagemMencionaServicoDoCatalogo(mensagem, catalogoServicos) {
    const texto = String(mensagem || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    if (!texto) return false;
    for (const nome of catalogoServicos.values()) {
        const partes = String(nome)
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .split(/[^a-z0-9]+/)
            .filter(p => p.length >= 4);
        if (partes.some(parte => texto.includes(parte))) return true;
    }
    return /\bo\s+mesm[oa]\b|\bmesm[oa]\s+servi[cç]o\b/i.test(mensagem);
}

function mensagemTemHorarioExplicito(mensagem) {
    const texto = String(mensagem || '').trim().toLowerCase();
    if (!texto) return false;
    if (/(^|\b)(\d{1,2}:\d{2}|\d{1,2}h\d{0,2})(\b|$)/i.test(texto)
        || /\b(?:as|às|para|pelas?)\s*\d{1,2}(?::\d{2})?\s*(?:h|horas?)?\b/i.test(texto)
        // (fix) cobre "14 horas" dito sozinho, sem "as"/"para" antes — antes disso o
        // horario era descartado como "sem mencao explicita" e o bot voltava a perguntar
        // o periodo mesmo depois do cliente ja ter dito a hora exata.
        || /\b\d{1,2}\s*(?:h|horas?)\b/i.test(texto)
        // (fix) cobre "18hs", "9hs" etc — abreviacao muito comum de "horas" no Brasil.
        // ANTES essa forma nao batia com nenhum padrao acima: o "s" logo depois do "h"
        // impede a fronteira de palavra (\b) exigida apos "h"/"horas?", entao mensagens
        // como "As 18hs" eram tratadas como SEM horario explicito, o horario ja extraido
        // corretamente pela IA era descartado, e o bot voltava a perguntar o periodo
        // (manha/tarde/noite) mesmo com o cliente ja tendo dito a hora exata.
        || /\b\d{1,2}\s*hs\b/i.test(texto)
        || /^(?:[2-9]|1\d|2[0-3])$/.test(texto)
        || /^\d{2}$/.test(texto)) {
        return true;
    }
    // (fix) Cobre mensagens curtas do tipo "fabrio 8", "8 bryan", "bryan as 8" onde o
    // cliente combina barbeiro (as vezes com erro de digitacao, ex: "fabrio" por
    // "fabricio") + um numero solto de 1-2 digitos plausivel como hora (1-23), sem "h"/
    // ":"/preposicao. Antes, so essas mensagens curtas (ate 6 palavras) tinham o horario
    // extraido pelo classificador DESCARTADO por esta funcao — o classificador (com
    // tolerancia a erro de digitacao) acertava o horario, mas essa trava jogava fora o
    // resultado certo por nao reconhecer a mensagem como "explicita o bastante", fazendo
    // o bot voltar a perguntar "manha, tarde ou noite?" do zero.
    const palavras = texto.split(/\s+/).filter(Boolean);
    if (palavras.length <= 6) {
        const matchNumero = texto.match(/\b([1-9]|1\d|2[0-3])\b/);
        if (matchNumero) return true;
    }
    return false;
}

function extrairPeriodosPorPessoa(mensagem) {
    const texto = String(mensagem || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    const marcadores = /\b(meu filho|minha filha|meu marido|minha esposa|minha mulher|meu pai|minha mae|meu irmao|minha irma|eu mesmo|pra mim|para mim)\b/g;
    const encontrados = [];
    let marcador;
    while ((marcador = marcadores.exec(texto)) !== null) encontrados.push({ inicio: marcador.index, fim: marcador.index + marcador[0].length });
    return encontrados.map((item, indice) => {
        const fim = indice + 1 < encontrados.length ? encontrados[indice + 1].inicio : texto.length;
        const trecho = texto.slice(item.fim, fim);
        const periodo = trecho.match(/\b(manha|tarde|noite)\b/);
        return periodo ? periodo[1] : null;
    });
}

function barbeiroIdPorPalavra(palavra, catalogoBarbeiros) {
    if (!palavra || palavra.length < 3) return null;
    let melhor = null;
    for (const [id, nome] of catalogoBarbeiros) {
        const norm = nome.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        const tokens = [...new Set([norm.split(/\s+/)[0], norm].filter(Boolean))];
        for (const token of tokens) {
            if (token.length < 3) continue;
            if (token === palavra || token.startsWith(palavra)) {
                if (!melhor || token.length < melhor.tokenLen) melhor = { id, tokenLen: token.length };
            }
        }
    }
    return melhor ? melhor.id : null;
}

function extrairBarbeiroHorarioDaMensagem(mensagem, catalogoBarbeiros) {
    const msg = mensagem.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
    // (fix Bug #5) Quando o cliente NAO deu minutos e a hora e ambigua (1-12, ex: "felipe
    // 2"), NAO zero-preenche aqui para "0H:00" — isso ja devolvia um valor no formato
    // HH:MM final (ex: "02:00"), e normalizarHorarioHHMM (unico lugar que aplica a
    // conversao 12h->24h por periodo) devolve strings JA nesse formato sem mexer nelas,
    // entao a conversao de "tarde"/"noite" nunca era aplicada e "felipe 2" a tarde virava
    // 02:00 (2 da manha) em vez de 14:00. Deixando a hora "crua" aqui (ex: "2"), ela passa
    // pelo caminho normal de normalizarHorarioHHMM em registrarSelecaoGrupoSeCompleta, que
    // decide certo com base no periodo. Quando o cliente DEU minutos (ou a hora ja e >=13,
    // inequivoca), mantem o zero-preenchimento normal — nao ha ambiguidade a resolver.
    const padHora = (h, m) => {
        if ((m === undefined || m === null || m === '') && Number(h) >= 1 && Number(h) <= 12) {
            return String(Number(h));
        }
        return `${String(h).padStart(2, '0')}:${m || '00'}`;
    };

    // Nome completo/exato (ex: "fabricio 14:15") — mantido por compatibilidade
    for (const [id, nome] of catalogoBarbeiros) {
        const norm = nome.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
        const tokens = [...new Set([norm.split(/\s+/)[0], norm].filter(Boolean))];
        for (const token of tokens) {
            if (token.length < 3) continue;
            const reBarbeiroPrimeiro = new RegExp(`\\b${token}\\b\\s+(\\d{1,2})(?::(\\d{2}))?\\b`, 'i');
            const reHorarioPrimeiro = new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s+(?:com\\s+(?:o\\s+)?)?\\b${token}\\b`, 'i');
            for (const re of [reBarbeiroPrimeiro, reHorarioPrimeiro]) {
                const m = msg.match(re);
                if (m) return { barbeiro_id: id, hora: padHora(m[1], m[2]) };
            }
        }
    }

    // Abreviacoes (ex: "fabr 14:15", "14:15 fabr") — clientes raramente digitam o nome inteiro
    const mBarbeiroPrimeiro = msg.match(/\b([a-z]{3,})\s+(\d{1,2})(?::(\d{2}))?\b/);
    if (mBarbeiroPrimeiro) {
        const id = barbeiroIdPorPalavra(mBarbeiroPrimeiro[1], catalogoBarbeiros);
        if (id) return { barbeiro_id: id, hora: padHora(mBarbeiroPrimeiro[2], mBarbeiroPrimeiro[3]) };
    }
    const mHorarioPrimeiro = msg.match(/\b(\d{1,2})(?::(\d{2}))?\s+(?:com\s+(?:o\s+)?)?([a-z]{3,})\b/);
    if (mHorarioPrimeiro) {
        const id = barbeiroIdPorPalavra(mHorarioPrimeiro[3], catalogoBarbeiros);
        if (id) return { barbeiro_id: id, hora: padHora(mHorarioPrimeiro[1], mHorarioPrimeiro[2]) };
    }
    return null;
}

function restaurarContextoProximaPessoaGrupo(estado, indiceAtual, catalogoBarbeiroServicos) {
    const proximaPessoa = estado.pessoasPlano[indiceAtual + 1] || null;
    // (fix) Modo degradado: se identificarPessoasDoGrupo NUNCA conseguiu capturar nada nessa
    // conversa (pessoasPlano permanece vazio do inicio ao fim, ex: falha repetida da API — ja
    // aconteceu em producao), nao ha absolutamente nenhum dado por pessoa pra usar aqui. Antes,
    // nesse cenario o codigo sempre zerava servico_ids/barbeiro_id ao avancar de pessoa "por
    // seguranca" — mas isso faz o bot ESQUECER servico e barbeiro que o cliente ja tinha
    // dito minutos antes, e perguntar tudo de novo do zero (pessimo, especialmente quando as
    // pessoas do grupo pedem o MESMO servico). Como fallback razoavel nesse cenario extremo,
    // preserva o ultimo servico_ids/barbeiro_id conhecido (assume "igual ao anterior" em vez de
    // "nao sei nada") — se estiver errado, o cliente corrige na mensagem seguinte normalmente.
    const capturaTotalmenteFalhou = estado.pessoasPlano.length === 0;
    const servicoAnterior = Array.isArray(estado.servico_ids) ? [...estado.servico_ids] : [];
    const barbeiroAnterior = estado.barbeiro_id || null;
    if (proximaPessoa && proximaPessoa.periodo) {
        estado.periodo = proximaPessoa.periodo;
        estado.horarioMinimo = null;
        estado.horarioMaximo = null;
    } else if (estado.periodoGrupo && !estado.periodo && !estado.horarioMinimo && !estado.horarioMaximo) {
        estado.periodo = estado.periodoGrupo;
    }
    // (fix) Restaura o horario ESPECIFICO da proxima pessoa, se o cliente ja tiver
    // mencionado um horario exato pra ela na mesma mensagem que definiu o grupo (ex:
    // "corte pro filho as 10 e barba as 11 pra mim") — sem isso esse horario se perdia
    // ao avancar de pessoa (registrarSelecaoGrupoSeCompleta zera horarioEscolhido logo
    // antes de chamar esta funcao), e o bot voltava a mostrar TODOS os horarios livres
    // do dia em vez de ir direto no horario que o cliente ja tinha pedido para ela.
    if (proximaPessoa && proximaPessoa.horario) {
        estado.horarioEscolhido = proximaPessoa.horario;
        estado.horarioMinimo = null;
        estado.horarioMaximo = null;
    }
    if (proximaPessoa && Array.isArray(proximaPessoa.servico_ids) && proximaPessoa.servico_ids.length > 0) {
        estado.servico_ids = [...proximaPessoa.servico_ids];
    } else if (capturaTotalmenteFalhou && servicoAnterior.length > 0) {
        estado.servico_ids = servicoAnterior;
    } else {
        estado.servico_ids = [];
    }

    if (proximaPessoa && proximaPessoa.barbeiro_id) {
        estado.barbeiro_id = proximaPessoa.barbeiro_id;
    } else if (estado.barbeiroGrupo && catalogoBarbeiroServicos && catalogoBarbeiroServicos.get(estado.barbeiroGrupo)) {
        const servicosDoBarbeiroGrupo = catalogoBarbeiroServicos.get(estado.barbeiroGrupo);
        const atendeProximaPessoa = estado.servico_ids.length === 0 ||
            estado.servico_ids.every(id => servicosDoBarbeiroGrupo.has(id));
        estado.barbeiro_id = atendeProximaPessoa ? estado.barbeiroGrupo : null;
    } else if (capturaTotalmenteFalhou && barbeiroAnterior) {
        estado.barbeiro_id = barbeiroAnterior;
    } else {
        estado.barbeiro_id = null;
    }
}

// Registra em selecoesGrupo a escolha de horario/barbeiro da pessoa atual quando o cliente
// confirma uma opcao ja listada (ex: "bryan 18") — antes disso so era salvo dentro do
// retorno de verificar_disponibilidade_todos, e quando o modelo nao reconsultava a
// disponibilidade a selecao se perdia, bloqueando criar_agendamento no final.
function registrarSelecaoGrupoSeCompleta(estado, mensagem, catalogoBarbeiros, catalogoBarbeiroServicos) {
    if (!estado.multiAgendamento || estado.agendamentosCompletos > 0) return false;
    const indice = estado.selecoesGrupo.length;
    if (indice >= estado.totalAgendamentos) return false;

    const extraido = extrairBarbeiroHorarioDaMensagem(mensagem, catalogoBarbeiros);
    if (extraido) {
        if (!estado.barbeiro_id) estado.barbeiro_id = extraido.barbeiro_id;
        if (!estado.horarioEscolhido) estado.horarioEscolhido = extraido.hora;
    }

    const horaNorm = normalizarHorarioHHMM(estado.horarioEscolhido, estado.periodo);
    if (horaNorm) estado.horarioEscolhido = horaNorm;

    if (!estado.data || !estado.horarioEscolhido || !estado.barbeiro_id) return false;

    const pessoa = estado.pessoasPlano[indice] || null;
    let servicoIds = (pessoa && Array.isArray(pessoa.servico_ids) && pessoa.servico_ids.length > 0)
        ? [...pessoa.servico_ids]
        : (Array.isArray(estado.servico_ids) && estado.servico_ids.length > 0 ? [...estado.servico_ids] : []);
    if (servicoIds.length === 0) return false;

    const chaveNova = JSON.stringify([estado.data, estado.horarioEscolhido, estado.barbeiro_id, [...servicoIds].sort()]);
    const duplicada = estado.selecoesGrupo.some(sel =>
        JSON.stringify([sel.data, sel.hora, sel.barbeiro_id, [...sel.servico_ids].sort()]) === chaveNova
    );
    if (duplicada) return false;

    estado.selecoesGrupo.push({
        data: estado.data,
        hora: estado.horarioEscolhido,
        barbeiro_id: estado.barbeiro_id,
        servico_ids: servicoIds,
        papel: pessoa ? pessoa.papel : null,
    });
    console.log(`[ai] Selecao do grupo registrada (${estado.selecoesGrupo.length}/${estado.totalAgendamentos}): ${JSON.stringify(estado.selecoesGrupo[indice])}`);

    estado.horarioEscolhido = null;
    // (fix) Restaura o periodo COMBINADO PARA O GRUPO (ex: "tarde") — a extracao da
    // mensagem atual (que so escolhia horario/barbeiro desta pessoa) pode ter zerado
    // estado.periodo por nao repetir a palavra "tarde"/"manha"/"noite". Sem isso, o bot
    // esquecia o periodo ja combinado e perguntava de novo pra proxima pessoa do grupo.
    // (fix) SO chama isso se ainda sobrar alguem no grupo — quando esta e a ULTIMA pessoa
    // (selecoesGrupo ja completo), nao ha "proxima pessoa" pra preparar contexto, e essa
    // funcao so serviria pra ZERAR servico_ids/barbeiro_id/periodo (rascunho da pessoa
    // atual) sem necessidade — deixando o bloco de estado mostrar "servico_ids: []" pro
    // modelo justamente no turno em que ele deveria SO pedir nome e telefone (o servico de
    // cada agendamento ja esta salvo em estado.selecoesGrupo, que e a fonte usada na hora
    // de criar os agendamentos — nao esses campos de rascunho).
    if (estado.selecoesGrupo.length < estado.totalAgendamentos) {
        restaurarContextoProximaPessoaGrupo(estado, indice, catalogoBarbeiroServicos);
    }

    return true;
}

// Transcricao texto-puro da conversa (cliente + atendente), sem tool calls nem [SISTEMA]
function montarTranscricao(messages) {
    return messages
        .filter(m =>
            (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[SISTEMA]')) ||
            (m.role === 'assistant' && typeof m.content === 'string' && m.content && !m.tool_calls)
        )
        .map(m => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.content}`)
        .join('\n');
}

const NOMES_FERRAMENTAS_CONSULTA = ['verificar_disponibilidade_todos', 'verificar_disponibilidade', 'buscar_proximo_horario', 'listar_barbeiros_servicos', 'buscar_info_barbearia', 'buscar_respostas_bot', 'buscar_agendamento'];

// Classificador UNIFICADO (uma chamada por mensagem): roteia a consulta necessaria E
// extrai os filtros do pedido atual + nome/telefone. Substitui o antigo par
// "roteador + extrator" (duas chamadas) por UMA — mais barato e sem divergencia entre eles.
async function extrairEstadoDaConversa(textoConversa, catalogoServicos, catalogoBarbeiros, estado) {
    const catalogoTexto = Array.from(catalogoServicos.entries()).map(([id, nome]) => `${id} = ${nome}`).join('\n') || '(nenhum ainda)';
    const catalogoBarbeirosTexto = Array.from(catalogoBarbeiros.entries()).map(([id, nome]) => `${id} = ${nome}`).join('\n') || '(nenhum ainda)';
    const FERRAMENTAS_CONSULTA = TOOLS
        .filter(t => NOMES_FERRAMENTAS_CONSULTA.includes(t.function.name))
        .map(t => `"${t.function.name}": ${t.function.description}`)
        .join('\n');
    const agoraBRT = new Date(Date.now() - 3 * 60 * 60 * 1000);
    const hojeISO = agoraBRT.toISOString().slice(0, 10);
    const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sabado'];
    const diaSemanaHoje = DIAS_SEMANA[agoraBRT.getUTCDay()];
    const aguardandoContatoDoGrupo = !!(estado.multiAgendamento && estado.contatoSolicitado && !(estado.nome && estado.telefone));
    const resumoEstado = [
        `nome do cliente ja conhecido: ${estado.nome || 'nao'}`,
        `telefone ja conhecido: ${estado.telefone ? 'sim' : 'nao'}`,
        `agendamento(s) JA CRIADO(s) nesta conversa: ${estado.criadosNestaConversa.length > 0 ? estado.criadosNestaConversa.join(' | ') : 'nenhum'}`,
        `aguardando contato UNICO do grupo (multi-agendamento): ${aguardandoContatoDoGrupo ? 'SIM — o Atendente ACABOU de pedir "Informe seu nome completo e telefone para registrar os agendamentos"; a proxima resposta do Cliente com um nome+telefone e o CONTATO/REGISTRANTE do lote inteiro, NAO o nome de quem sera atendido' : 'nao'}`
    ].join('\n');

    const sistema = `Analise a transcricao de uma conversa de agendamento entre Atendente e Cliente de uma barbearia. Interprete as respostas do Cliente NO CONTEXTO das perguntas do Atendente (respostas curtas como "nao" ou "tarde" respondem a pergunta anterior do Atendente). Responda um JSON com CATORZE campos:
"consulta": "<nome_exato_da_ferramenta>" | null — qual ferramenta de CONSULTA precisa ser chamada AGORA para responder a ULTIMA mensagem do Cliente com dados reais do banco, se alguma. Ferramentas disponiveis:
${FERRAMENTAS_CONSULTA}
REGRA CRITICA — SEMPRE retorne "verificar_disponibilidade_todos" (NUNCA null) quando a ULTIMA mensagem do cliente, dentro de um fluxo de agendamento, ALTERA ou ACRESCENTA qualquer filtro de busca, mesmo que pareca "so um refinamento": um horario ou limite especifico ("depois das 17h", "as 15h"), um periodo do dia, uma data diferente, um barbeiro diferente ou adicional, um servico diferente ou adicional. Isso vale MESMO que a ferramenta ja tenha sido chamada antes na conversa — dados antigos ficam desatualizados. Quando a ULTIMA mensagem perguntar pelo PROXIMO horario disponivel, primeira vaga ou "quando tem horario" SEM citar uma data, retorne "buscar_proximo_horario" (nao a de disponibilidade por data). So retorne null para mensagens que realmente NAO alteram nenhum filtro: saudacoes, confirmacoes puras ("sim", "pode ser", "ok"), fornecer nome/telefone, ou escolher literalmente um horario+barbeiro que ja apareceu EXATAMENTE como opcao na ultima lista mostrada.
"data": "YYYY-MM-DD" | null — a DATA que o cliente quer para o pedido de agendamento ATUAL. HOJE e ${hojeISO} (${diaSemanaHoje}) no horario de Brasilia: use isso para resolver termos relativos ("hoje", "amanha" = hoje + 1 dia, nomes de dias da semana = a PROXIMA ocorrencia daquele dia). Se o cliente mencionou datas diferentes ao longo da conversa, use a MAIS RECENTE do pedido atual. Se o cliente ainda NAO mencionou nenhuma data, retorne null — NUNCA presuma que e para hoje.
"periodo": "manha" | "tarde" | "noite" | null — preencha SOMENTE quando o cliente mencionar de forma GENERICA uma parte do dia (ex: "de manha", "a tarde", "amanha de manha"), SEM especificar um horario ou limite exato. A palavra "amanha" sozinha indica so o dia, nao o periodo.
"horarioMinimo": "HH:MM" | null — preencha se o cliente pedir um horario a partir de/depois de algum momento (ex: "depois das 17h", "a partir das 15h"). Use o horario exato mencionado, sem arredondar para periodo.
"horarioMaximo": "HH:MM" | null — preencha se o cliente pedir um horario ate/antes de algum momento (ex: "antes das 20h", "ate as 16h").
"horarioEscolhido": "HH:MM" | null — preencha quando o cliente mencionar um horario ESPECIFICO e EXATO que quer verificar ou escolher AGORA (nao um filtro de intervalo tipo "depois de"/"antes de") — isso inclui tanto uma escolha ja confirmada (ex: "as 8 com fab", "pode ser 15h com o bryan", "quero as 14:30") QUANTO uma PERGUNTA sobre um horario especifico (ex: "tem as 15 com o fabricio?", "tem horario as 9?", "voces tem 14h livre?") — nos dois casos preencha o campo, porque a acao imediata e a mesma (verificar disponibilidade EXATAMENTE nesse horario); a diferenca entre pergunta e escolha confirmada nao muda o que precisa ser verificado. Aceite o numero mesmo sem "h"/":" (ex: "as 15" = 15:00, contexto de tarde/noite decide se e 15h ou nao faz sentido). Deixe null APENAS se o cliente estiver pedindo uma faixa ampla ("de manha", "qualquer horario", "depois das 17h" sem hora exata) sem mencionar nenhum horario especifico. Se o cliente der DOIS horarios para DUAS pessoas diferentes ("as 9 para mim e 9:15 pro meu pai"), retorne em horarioEscolhido APENAS o horario da PRIMEIRA pessoa ainda nao agendada — NUNCA transforme horarios de pessoas diferentes em um intervalo horarioMinimo/horarioMaximo.
IMPORTANTE: se o cliente da um horario ou limite EXATO como filtro (ex: "depois das 17h"), preencha horarioMinimo/horarioMaximo e deixe "periodo" como null — NUNCA arredonde um horario exato para um periodo generico (ex: "depois das 17h" NAO deve virar periodo "noite", pois isso excluiria horarios validos como 17:30). Se o cliente mencionou periodos/horarios diferentes ao longo da conversa, use APENAS o da mensagem MAIS RECENTE (nao acumule informacoes antigas).
"barbeiro_id": number | null — o ID do catalogo de barbeiros abaixo, APENAS se o cliente nomeou (mesmo abreviado, ex: "fab" = Fabricio) um barbeiro especifico DENTRO DO PEDIDO DE AGENDAMENTO ATUAL (a tentativa de marcar horario mais recente na conversa). Isso INCLUI perguntas sobre a disponibilidade especifica de um barbeiro (ex: "com o fabricio nao tem mais nada?") — nesses casos preencha o barbeiro_id desse barbeiro tambem. Se um barbeiro foi mencionado em um pedido ANTERIOR e JA CONCLUIDO ou abandonado (ex: um agendamento ja criado/cancelado antes — veja o ESTADO abaixo), e o pedido ATUAL nao repete o nome dele, retorne null — NUNCA reaproveite um barbeiro de um assunto anterior e encerrado.
"servico_ids": number[] — lista de IDs do catalogo abaixo com TODOS os servicos que o cliente quer agendar JUNTOS nesta tentativa atual, PARA UMA UNICA PESSOA (em qualquer forma de escrita: "cortar o cabelo", "limpar o nariz", "aparar a barba", etc). TOLERANCIA A ERROS DE DIGITACAO: clientes escrevem errado com frequencia pelo celular (falta de acento, letras trocadas, fonetica — ex: "nazal" por "nasal", "sobranselha" por "sobrancelha", "kabelo" por "cabelo"). Interprete pelo SIGNIFICADO do que o cliente quis dizer, comparando com os nomes do catalogo mesmo quando a grafia nao bate exatamente — NUNCA marque como servico_desconhecido so por causa de erro de digitacao/ortografia; use servico_desconhecido apenas quando o servico pedido REALMENTE nao existir no catalogo, nem parecido. IMPORTANTE — CONTEXTO DE BARBEARIA: quando o cliente mencionar apenas "corte" ou "cortes" (sem especificar o tipo), presuma que se refere ao servico mais comum em barbearia que corresponda no catalogo (normalmente "Corte de Cabelo" ou "Corte Masculino"). Similarmente, "barba" sem especificação = servico de barba do catalogo. ATENÇÃO À QUANTIDADE: se o cliente mencionar uma QUANTIDADE de serviços (ex: "2 cortes", "3 barbas"), isso significa UMA pessoa fazendo MÚLTIPLOS do MESMO serviço, NÃO múltiplas pessoas — neste caso, REPITA o mesmo servico_id pela quantidade mencionada no array (ex: "2 cortes" com id 5 do Corte de Cabelo = [5, 5]). Se o cliente pediu 2 ou mais servicos DIFERENTES para a mesma vinda da MESMA pessoa, inclua os IDs de TODOS. MULTIPLAS PESSOAS COM SERVICOS DIFERENTES: NUNCA junte servicos de pessoas diferentes no mesmo array — inclua APENAS os servicos da PROXIMA pessoa cujo agendamento ainda nao foi criado nesta conversa. EXEMPLO CONCRETO: "para mim cabelo e sobrancelha, e para o meu pai cabelo e limpeza nasal" (nenhum agendamento criado ainda) → retorne SOMENTE os servicos da PRIMEIRA pessoa (os ids de cabelo e sobrancelha); os servicos do pai so entram DEPOIS que o agendamento da primeira pessoa for criado. ATENCAO — o mesmo vale MESMO QUANDO NENHUMA das pessoas e quem esta escrevendo (ex: um pai/mae agendando so para terceiros): "para meu marido barba e filho cabelo" NAO e um pedido de combo (barba+cabelo) para uma pessoa so — sao DOIS pedidos DIFERENTES para DUAS pessoas diferentes (marido: barba; filho: cabelo). Releia a frase e identifique quantas pessoas E quantos servicos distintos existem antes de decidir — se o numero de pessoas mencionadas for maior que 1, NUNCA combine os servicos delas num array so, mesmo que a frase nao repita a palavra "para" antes de cada pessoa. Nesse exemplo, retorne SOMENTE o id de barba (o servico da PRIMEIRA pessoa mencionada, o marido). MULTIPLAS PESSOAS COM O MESMO SERVICO (ex: "corte pra mim e pro meu pai"): isso NAO e ambiguidade — retorne o ID desse servico normalmente (ex: so [1]). NUNCA retorne array vazio so porque ha mais de uma pessoa envolvida — vazio e SOMENTE quando o cliente ainda nao disse NENHUM servico. Para servicos JA CONCLUIDOS (agendamento ja criado — veja o ESTADO abaixo) sem um pedido novo, retorne [].
"servico_desconhecido": string | null — o NOME do servico que o cliente pediu mas que NAO consta no catalogo de servicos abaixo (ex: "platinado", "selagem", "progressiva" — tratamentos que a barbearia nao faz). null se todos os servicos pedidos existem no catalogo ou se o cliente nao pediu servico nenhum. Distinga ERRO DE DIGITACAO (ex: "nazal" por "nasal", "sobranselha" por "sobrancelha" — SAO o mesmo servico do catalogo, so mal escrito; NAO marque como desconhecido) de um SERVICO REALMENTE DIFERENTE que a barbearia nao oferece (ex: "progressiva", "platinado" — isso sim e servico_desconhecido). NUNCA tente aproximar um servico genuinamente inexistente (categoria diferente) para um parecido do catalogo so para nao marcar como desconhecido.
"nome": string | null — o nome (idealmente completo) que o CLIENTE informou como o nome DA PESSOA que esta sendo agendada AGORA, no pedido ATUAL (a tentativa de agendamento mais recente, ainda nao criada). null se ainda nao disse NESTA tentativa atual. NUNCA use nomes de terceiros (pai, filho etc) neste campo — a menos que a pessoa sendo agendada AGORA seja esse terceiro (ver ESTADO abaixo: quantas pessoas ja foram criadas neste grupo). CRITICO — NUNCA REAPROVEITE UM NOME DE UM PEDIDO ANTERIOR JA CONCLUIDO: se um nome foi usado para criar um agendamento anterior nesta conversa (veja "agendamento(s) JA CRIADO(s)" no ESTADO abaixo) e a mensagem ATUAL do cliente NAO repete esse nome nem fornece um nome novo, retorne null — isso vale mesmo que o nome apareca em mensagens antigas da transcricao. Cada pessoa do grupo precisa do PROPRIO nome informado de novo, nunca herdado de quem ja foi agendado. EXCECAO OBRIGATORIA — CONTATO UNICO DO GRUPO: se o ESTADO abaixo disser "aguardando contato UNICO do grupo: SIM", a ULTIMA mensagem do Cliente respondendo a "Informe seu nome completo e telefone para registrar os agendamentos" e o nome do REGISTRANTE do lote inteiro (normalmente quem esta escrevendo, ex: o pai/mae) — capture esse nome normalmente neste campo mesmo que ele seja DIFERENTE do nome de quem sera atendido (filho, marido etc); NAO retorne null e NAO exija que o cliente repita nomes individuais de cada pessoa do grupo, pois esse mesmo nome/telefone sera reaproveitado pelo sistema para TODOS os agendamentos do lote.
"telefone": string | null — o telefone com DDD que o cliente DIGITOU na conversa PARA O PEDIDO ATUAL (somente os digitos). null se nao informou nesta tentativa atual. NUNCA invente nem use numeros parciais. CRITICO — NUNCA REAPROVEITE UM TELEFONE DE UM PEDIDO ANTERIOR JA CONCLUIDO: mesma regra do campo "nome" acima — se o telefone foi usado para criar um agendamento anterior nesta conversa e a mensagem ATUAL nao o repete, retorne null. A mesma EXCECAO do campo "nome" acima se aplica aqui: com "aguardando contato UNICO do grupo: SIM", capture o telefone informado normalmente.
"multiplas_pessoas": true | false — true se o pedido de agendamento ATUAL envolve DUAS OU MAIS pessoas (ex: "para mim e para o meu pai", "eu e meu filho"), mesmo que com o mesmo servico. IMPORTANTE — QUANTIDADE NÃO É MÚLTIPLAS PESSOAS: quando o cliente menciona UMA quantidade de serviços (ex: "2 cortes", "3 barbas", "quero fazer 2 limpezas nasais"), isso é UMA pessoa fazendo MÚLTIPLOS serviços IGUAIS, NÃO múltiplas pessoas — neste caso multiplas_pessoas=false. Só marque multiplas_pessoas=true quando o cliente EXPLICITAMENTE mencionar DIFERENTES pessoas (papéis, pronomes possessivos, nomes, relações familiares — ex: "eu e meu filho", "para mim e minha esposa", "meus 2 filhos").
"quantidade_pessoas": number | null — SO quando multiplas_pessoas=true: quantas pessoas ao todo o pedido envolve, incluindo quem esta escrevendo (ex: "eu e meu pai" = 2, "eu, meu pai e meu filho" = 3). null se nao for multi-pessoa ou nao der pra estimar. CRITICO — NUNCA conte um nome que aparece no CATALOGO DE BARBEIROS abaixo como uma pessoa nova do grupo: quando o cliente escreve so o nome de um barbeiro do catalogo junto com um horario (ex: "felipe 14", "bryan 15h", "pode ser com o bryan"), isso e a ESCOLHA do barbeiro/horario para uma pessoa do grupo que JA foi contada antes (filho, marido, etc.), nunca uma pessoa adicional — mesmo que o nome do barbeiro coincida com um nome proprio comum. So aumente quantidade_pessoas quando o cliente mencionar EXPLICITAMENTE um NOVO papel familiar/pessoal (ex: "ah e tambem para minha filha") que ainda nao apareceu na conversa. ATENÇÃO: quando o cliente menciona UMA quantidade numérica de pessoas explicitamente (ex: "para meus 2 filhos", "quero agendar meus 3 filhos"), use esse número exato.
"mesmo_servico_no_lote": true | false | null — SO quando multiplas_pessoas=true: true APENAS se a conversa deixar claro que todas as pessoas do grupo querem o MESMO servico (ex: "corte para mim e meu pai", "eu e meu filho queremos so corte"). false se ficar claro que as pessoas querem servicos DIFERENTES (ex: "corte para mim e barba para o meu pai"). null se isso ainda nao estiver claro.

ESTADO JA CONHECIDO (mantido pelo sistema — use para interpretar a conversa):
${resumoEstado}

CATALOGO DE SERVICOS (id = nome):
${catalogoTexto}

CATALOGO DE BARBEIROS (id = nome):
${catalogoBarbeirosTexto}`;

    // (fix v4.2.6) maxTokens subiu de 400 para 700: os logs mostraram o classificador
    // falhando por completo ("Unterminated string in JSON") — a resposta estava sendo
    // cortada no meio antes de terminar o JSON, o que descartava TODO o resultado (nao so
    // o campo que ficou grande demais) e pulava mesclarEstado inteiro naquele turno.
    const resp = await chamarClassificador(
        sistema,
        textoConversa,
        700,
        'estado_conversa',
        {
            type: 'object',
            properties: {
                consulta:         { type: ['string', 'null'] },
                data:             { type: ['string', 'null'] },
                periodo:          { type: ['string', 'null'], enum: ['manha', 'tarde', 'noite', null] },
                horarioMinimo:    { type: ['string', 'null'] },
                horarioMaximo:    { type: ['string', 'null'] },
                horarioEscolhido: { type: ['string', 'null'] },
                barbeiro_id:      { type: ['number', 'null'] },
                servico_ids:      { type: 'array', items: { type: 'number' } },
                servico_desconhecido: { type: ['string', 'null'] },
                multiplas_pessoas: { type: 'boolean' },
                quantidade_pessoas: { type: ['number', 'null'] },
                mesmo_servico_no_lote: { type: ['boolean', 'null'] },
                nome:             { type: ['string', 'null'] },
                telefone:         { type: ['string', 'null'] }
            },
            required: ['consulta', 'data', 'periodo', 'horarioMinimo', 'horarioMaximo', 'horarioEscolhido', 'barbeiro_id', 'servico_ids', 'servico_desconhecido', 'multiplas_pessoas', 'quantidade_pessoas', 'mesmo_servico_no_lote', 'nome', 'telefone'],
            additionalProperties: false
        }
    );
    return resp;
}

// Mescla o resultado do classificador no estado, validando TUDO contra o catalogo real.
// Filtros sao substituidos integralmente (o classificador le a transcricao toda e null
// significa "nao ha filtro no pedido atual"); nome/telefone nunca regridem para null.
function mesclarEstado(estado, ex, catalogoServicos, catalogoBarbeiros, catalogoBarbeiroServicos, messagesArray) {
    const hhmm = (v) => (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) ? v : null;
    const periodoNovo = ['manha', 'tarde', 'noite'].includes(ex.periodo) ? ex.periodo : null;
    let minNovo = hhmm(ex.horarioMinimo);
    let maxNovo = hhmm(ex.horarioMaximo);
    let escolhidoNovo = hhmm(ex.horarioEscolhido);
    // "das 09:00 as 09:00" E uma escolha exata — normaliza para horarioEscolhido
    if (!escolhidoNovo && minNovo && maxNovo && minNovo === maxNovo) escolhidoNovo = minNovo;
    // Pedido multi-agendamento SIMPLIFICADO (apenas contadores, sem flags complexas)
    if (ex.multiplas_pessoas === true) {
        estado.multiAgendamento = true;
        // totalAgendamentos so pode SUBIR (nunca diminui por engano do classificador) — minimo 2
        const qtdEstimada = Number(ex.quantidade_pessoas);
        let novaQtd = (Number.isFinite(qtdEstimada) && qtdEstimada >= 2) ? qtdEstimada : 2;
        
        // TRAVA DE SEGURANÇA: limite máximo razoável (previne alucinação do classificador)
        const LIMITE_MAX_PESSOAS = 6;
        if (novaQtd > LIMITE_MAX_PESSOAS) {
            console.log(`[ai] ALERTA: quantidade estimada (${novaQtd}) excede limite de ${LIMITE_MAX_PESSOAS} — ajustando`);
            novaQtd = LIMITE_MAX_PESSOAS;
            if (messagesArray) messagesArray.push({
                role: 'user',
                content: `[SISTEMA] ATENÇÃO: O sistema detectou um número muito alto de pessoas (${qtdEstimada}). Antes de prosseguir, confirme com o cliente EXATAMENTE quantas pessoas ele quer agendar.`
            });
            estado._totalConfirmado = false;
        }
        
        // (fix) A confirmacao explicita ("Certo, são X agendamentos no total?") foi
        // REMOVIDA daqui — o cliente ja deixou claro quantas pessoas/agendamentos quer ao
        // descrever cada um (ex: "corte pro filho e sobrancelha pro marido" = 2, sem
        // ambiguidade), entao pedir essa confirmacao extra so atrasa o atendimento sem
        // necessidade. totalAgendamentos e atualizado normalmente; _totalConfirmado
        // permanece true (valor padrao) e so vira false no caso excepcional de quantidade
        // suspeita/alta demais, tratado no bloco de LIMITE_MAX_PESSOAS acima — so nesse
        // caso extremo faz sentido confirmar antes de prosseguir.
        //
        // (fix v4.2.6) BUG CORRIGIDO: totalAgendamentos so podia SUBIR e NUNCA descer, o
        // que parecia seguro (proteger contra o classificador "esquecer" gente), mas na
        // pratica deixava qualquer alucinacao de contagem PERMANENTE e sem correcao
        // possivel. Como esse classificador releva a transcricao INTEIRA a cada mensagem
        // (nao so a mensagem atual), uma mensagem tao simples quanto "felipe 14" (o cliente
        // escolhendo o barbeiro Felipe as 14h para uma pessoa que ja fazia parte do grupo)
        // podia ser mal-interpretada como uma TERCEIRA pessoa nova chamada "Felipe" — porque
        // nomes de barbeiros do catalogo (Felipe, Bryan, Fabricio) sao nomes proprios comuns
        // e fáceis de confundir com um novo familiar. O resultado: totalAgendamentos pulava
        // de 2 pra 3 no meio do fluxo, o bot passava a exigir uma pessoa que nunca existiu, e
        // como o numero so podia subir, nada corrigia isso sozinho.
        // A trava agora e: uma vez que o grupo ja foi identificado com papel+servico de cada
        // pessoa (estado.pessoasPlano preenchido — ver identificarPessoasDoGrupo), esse array
        // passa a ser a FONTE DA VERDADE do tamanho do grupo, e novas estimativas de
        // quantidade_pessoas vindas da releitura a cada mensagem sao ignoradas (apenas
        // logadas). Antes disso (grupo ainda nao identificado), o comportamento de subir e
        // preservado normalmente.
        const grupoJaTravado = estado.pessoasPlano.length > 0 &&
            estado.pessoasPlano.every(p => Array.isArray(p.servico_ids) && p.servico_ids.length > 0);
        if (novaQtd > estado.totalAgendamentos) {
            if (grupoJaTravado) {
                console.log(`[ai] Classificador tentou aumentar totalAgendamentos de ${estado.totalAgendamentos} para ${novaQtd}, mas o grupo (${estado.pessoasPlano.length} pessoa(s): ${estado.pessoasPlano.map(p => p.papel).join(', ')}) ja foi identificado e travado — ignorando estimativa`);
            } else {
                estado.totalAgendamentos = novaQtd;
            }
        }
    }
    // TRAVA MULTI-PESSOA: dois horarios de pessoas diferentes ("9 pra mim, 9:15 pro pai")
    // lidos como "intervalo" NAO sao um intervalo — o primeiro horario e a escolha da
    // pessoa atual; o da proxima pessoa e tratado depois que o primeiro for criado.
    if (estado.multiAgendamento && !escolhidoNovo && minNovo && maxNovo && minNovo !== maxNovo) {
        escolhidoNovo = minNovo;
        minNovo = null;
        maxNovo = null;
    }
    const dataNova = (typeof ex.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ex.data)) ? ex.data : null;
    const bId = Number(ex.barbeiro_id);
    const barbeiroNovo = !Number.isNaN(bId) && catalogoBarbeiros.has(bId) ? bId : null;
    const servicosNovos = Array.isArray(ex.servico_ids)
        ? [...new Set(ex.servico_ids.map(Number))].filter(id => !Number.isNaN(id) && catalogoServicos.has(id))
        : [];

    // ANTI-REGRESSAO: se a mensagem atual NAO trouxe nenhum filtro de horario novo
    // e o pedido continua o mesmo (mesma data, mesmo barbeiro, mesmos servicos),
    // PRESERVA os filtros ja conhecidos — o codigo nao deixa o estado regredir.
    const trouxeFiltroHorario = !!(periodoNovo || minNovo || maxNovo || escolhidoNovo);
    const mudouBarbeiro = barbeiroNovo !== null && barbeiroNovo !== estado.barbeiro_id;
    const mudouServicos = servicosNovos.length > 0 && JSON.stringify(servicosNovos) !== JSON.stringify(estado.servico_ids);
    const mudouData = dataNova !== null && dataNova !== estado.data;
    if (trouxeFiltroHorario || mudouBarbeiro || mudouServicos || mudouData) {
        estado.periodo = periodoNovo;
        estado.horarioMinimo = minNovo;
        estado.horarioMaximo = maxNovo;
        estado.horarioEscolhido = escolhidoNovo;
    }
    // Barbeiro herdado de um pedido anterior que NAO realiza os novos servicos → limpo
    // em codigo (causa do "selagem com Felipe": barbeiro do fluxo antigo grudado no novo)
    if (mudouServicos && estado.barbeiro_id && catalogoBarbeiroServicos) {
        const dele = catalogoBarbeiroServicos.get(estado.barbeiro_id);
        if (dele && !servicosNovos.every(id => dele.has(id))) estado.barbeiro_id = null;
    }
    if (dataNova) estado.data = dataNova;
    if (barbeiroNovo !== null) estado.barbeiro_id = barbeiroNovo;
    if (servicosNovos.length > 0) estado.servico_ids = servicosNovos;

    if (typeof ex.nome === 'string' && ex.nome.trim().length >= 2) estado.nome = ex.nome.trim();
    if (typeof ex.telefone === 'string') {
        const dig = ex.telefone.replace(/\D/g, '');
        if (dig.length >= 10) estado.telefone = dig;
    }

    // AUTO-ATRIBUICAO DE BARBEIRO UNICO: se ainda nao ha barbeiro escolhido mas o(s)
    // servico(s) pedido(s) so podem ser feitos por UM barbeiro da equipe, atribui esse
    // barbeiro automaticamente — nunca deixa o bot perguntar "qual barbeiro prefere" quando
    // na pratica so ha 1 opcao (isso ja causou looping de pergunta repetida e a pergunta
    // errada "qual horario E barbeiro" quando so havia 1 barbeiro na lista).
    if (!estado.barbeiro_id && estado.servico_ids.length > 0 && catalogoBarbeiroServicos) {
        const candidatos = [...catalogoBarbeiroServicos.entries()]
            .filter(([, servs]) => estado.servico_ids.every(id => servs.has(id)))
            .map(([bid]) => bid);
        if (candidatos.length === 1) {
            estado.barbeiro_id = candidatos[0];
        }
    }
}

// Bloco [ESTADO] injetado no system prompt a cada turno — e a memoria persistente que o
// modelo consulta em vez de re-perguntar ou adivinhar IDs.
function montarBlocoEstado(estado, catalogoServicos, catalogoBarbeiros) {
    const linhas = [];
    linhas.push(`- Nome do cliente: ${estado.nome ? estado.nome : 'AINDA NAO INFORMADO'}`);
    linhas.push(`- Telefone do cliente (informado por ele nesta sessao): ${estado.telefone ? estado.telefone : 'AINDA NAO INFORMADO'}`);
    const filtros = [];
    if (estado.data) filtros.push(`data ${estado.data}`);
    if (estado.servico_ids.length > 0) filtros.push(`servico(s): ${estado.servico_ids.map(id => `${catalogoServicos.get(id) || '?'} (id ${id})`).join(' + ')}`);
    if (estado.barbeiro_id) filtros.push(`barbeiro: ${catalogoBarbeiros.get(estado.barbeiro_id) || '?'} (id ${estado.barbeiro_id})`);
    if (estado.periodo) filtros.push(`periodo: ${estado.periodo}`);
    if (estado.horarioMinimo) filtros.push(`a partir de ${estado.horarioMinimo}`);
    if (estado.horarioMaximo) filtros.push(`ate ${estado.horarioMaximo}`);
    if (estado.horarioEscolhido) filtros.push(`horario escolhido: ${estado.horarioEscolhido}`);
    linhas.push(`- Pedido de agendamento em andamento: ${filtros.length > 0 ? filtros.join('; ') : 'nenhum filtro definido ainda'}`);
    if (estado.horarioEscolhido) {
        linhas.push(`- ATENCAO AO ESCREVER A RESPOSTA: o horario JA RESOLVIDO e confirmado e ${estado.horarioEscolhido} — use EXATAMENTE esse valor (numeros identicos) sempre que mencionar o horario na sua resposta. NAO reinterprete expressoes do cliente como "uma hora", "meio dia", "as 9" por conta propria — esse trabalho ja foi feito, o valor final e ${estado.horarioEscolhido}. Trocar esse numero na resposta (ex: escrever um horario diferente do que esta aqui) e um erro grave que confunde o cliente.`);
    }
    if (estado.multiAgendamento) {
        const faltam = estado.totalAgendamentos - estado.agendamentosCompletos;
        linhas.push(`- MULTIPLOS AGENDAMENTOS: Total ${estado.totalAgendamentos} | Completos: ${estado.agendamentosCompletos} | Faltam: ${faltam}`);
        linhas.push(`- Selecoes de horario do grupo ja capturadas: ${Array.isArray(estado.selecoesGrupo) ? estado.selecoesGrupo.length : 0}`);
        linhas.push('- REGRA ABSOLUTA: UM agendamento por vez. Complete o atual (nome, servico, data, horario, barbeiro) antes de iniciar o proximo. NUNCA misture dados de pessoas diferentes.');
        if (Array.isArray(estado.selecoesGrupo) && estado.selecoesGrupo.length === estado.totalAgendamentos && !(estado.nome && estado.telefone)) {
            if (estado.contatoSolicitado) {
                linhas.push('- IMPORTANTE: todos os horarios do grupo ja foram escolhidos. O contato ja foi solicitado ao cliente; NAO peça novamente o nome/telefone.');
            } else {
                linhas.push('- IMPORTANTE: todos os horarios do grupo ja foram escolhidos. O proximo passo e pedir UMA UNICA VEZ: "Informe seu nome completo e telefone para registrar os agendamentos".');
            }
        }
        if (Array.isArray(estado.selecoesGrupo) && estado.selecoesGrupo.length === estado.totalAgendamentos && estado.nome && estado.telefone && estado.multiAgendamento) {
            linhas.push('- MULTI-AGENDAMENTO: O contato informado deve ser usado para TODOS os agendamentos do grupo. NAO peça nomes adicionais por pessoa.');
        }
        if (estado.agendamentosCompletos > 0) {
            linhas.push(`- IMPORTANTE: Ja criou ${estado.agendamentosCompletos} agendamento(s). Foque APENAS no PROXIMO agendamento agora. NAO reconfirme os anteriores.`);
        }
    }
    if (estado.ultimoAgendamentoConfirmado) {
        const ua = estado.ultimoAgendamentoConfirmado;
        linhas.push(`- Ultimo agendamento confirmado: ${ua.servico_nomes.join(' + ')} em ${ua.data} as ${ua.horario} com ${ua.barbeiro_nome}. Se o cliente disser "o mesmo", reutilize esses dados.`);
    }
    if (estado.reagendamentoEmAndamento && estado.reagendamentoAlvo) {
        const alvo = estado.reagendamentoAlvo;
        linhas.push(`- REAGENDAMENTO EM ANDAMENTO: o agendamento escolhido para remarcar e o id ${alvo.id} (${alvo.diaSemana} ${alvo.data} as ${alvo.hora}, ${alvo.servico}, ${alvo.barbeiro}). Mantenha esse servico como referencia e NAO finalize o processo sem cancelar esse agendamento antigo.`);
    }
    if (Array.isArray(estado.mapaAgendamentos) && estado.mapaAgendamentos.length > 0) {
        linhas.push('- Agendamentos futuros JA LOCALIZADOS deste cliente (para cancelar/reagendar use EXATAMENTE estes ids REAIS em agendamento_id/agendamento_ids — NUNCA a posicao da lista):');
        for (const a of estado.mapaAgendamentos) linhas.push(`    id ${a.id}: ${a.resumo}`);
    }
    if (estado.criadosNestaConversa.length > 0) {
        linhas.push('- Agendamentos JA CRIADOS nesta conversa (ja confirmados ao cliente — NAO recrie, NAO reconfirme):');
        for (const c of estado.criadosNestaConversa) linhas.push(`    ${c}`);
    }
    return `ESTADO DA CONVERSA (fatos ja confirmados, mantidos pelo sistema):
${linhas.join('\n')}
REGRAS DO ESTADO: NUNCA mencione ou reafirme um horario, data ou barbeiro especifico na sua resposta a menos que ele apareca EXATAMENTE no "Pedido de agendamento em andamento" acima ou tenha acabado de vir do retorno de uma ferramenta nesta rodada. Se o horario escolhido nao consta mais acima (por exemplo apos o cliente trocar a data), ele NAO E MAIS VALIDO — nao o cite de memoria da conversa; peca para o cliente escolher novamente entre os horarios reais retornados. NAO pergunte novamente nada que ja consta acima (ex: se nome e telefone ja constam, use-os direto na criacao do agendamento sem pedir de novo). Por outro lado, NUNCA reaproveite filtros acima para um pedido NOVO que o cliente ainda nao detalhou — se o assunto mudou, pergunte normalmente.`;
}

async function processarMensagemWhatsApp(phone, mensagem, numeroConfiavel = true) {
    const session  = getSession(phone);
    const messages = [...session.messages];
    const primeiraMensagem = messages.length === 0;
    messages.push({ role: 'user', content: mensagem });

    // (fix) registrarSelecaoGrupoSeCompleta e chamada em varios pontos deste fluxo
    // (antes de consultar disponibilidade, na trava deterministica pre-criacao, e
    // dentro do loop de tool calls). Ela usa o texto bruto da ULTIMA mensagem do
    // cliente para extrair barbeiro/horario quando estado.barbeiro_id/horarioEscolhido
    // estao vazios. Isso causava um bug grave: ao registrar a selecao da pessoa 1, a
    // funcao zera esses campos para preparar a pessoa 2 — mas como todas as chamadas
    // seguintes, NA MESMA rodada, ainda recebem a MESMA mensagem ("fabri 15:30", por
    // exemplo), o codigo re-extraia dela e registrava uma SEGUNDA selecao (da pessoa 2)
    // com os dados da pessoa 1, sem o cliente ter informado nada sobre a pessoa 2 ainda.
    // Essa trava garante no maximo UM registro de selecao de grupo por mensagem recebida.
    let selecaoGrupoConsumidaNestaMensagem = false;
    const registrarSelecaoGrupoUmaVezPorMensagem = (estadoAtual, msgAtual, catBarbeiros) => {
        if (selecaoGrupoConsumidaNestaMensagem) return false;
        const registrou = registrarSelecaoGrupoSeCompleta(estadoAtual, msgAtual, catBarbeiros, catalogoBarbeiroServicos);
        if (registrou) selecaoGrupoConsumidaNestaMensagem = true;
        return registrou;
    };

    // ===== ESTADO persistente da sessao (mantido pelo CODIGO) =====
    if (!session.estado) session.estado = estadoInicial();
    const estado = session.estado;
    estado._novoReagendamentoCriadoNestaRodada = false;
    // (fix) precisa estar declarada AQUI (nivel da funcao) para ser visivel tanto no bloco
    // deterministico abaixo (onde e definida) quanto dentro do try{} mais abaixo, onde e lida
    // — o bloco em volta de onde ela era usada antes se encerra antes do try{} comecar.
    let precisaVerificarDisponibilidadeNovaPessoa = false;

    // Catalogo real (uma consulta leve por mensagem) — base para validar IDs extraidos
    const catalogoServicos = new Map();
    const catalogoDuracoes = new Map(); // (v3.32.4) id -> duracao em minutos, p/ validar espacamento entre horarios do modo lote
    const catalogoBarbeiros = new Map();
    const catalogoBarbeiroServicos = new Map();
    try {
        const catalogoCompleto = await db.listarBarbeirosServicos();
        for (const c of catalogoCompleto) {
            catalogoBarbeiros.set(Number(c.id), c.nome);
            catalogoBarbeiroServicos.set(Number(c.id), new Set((c.servicos || []).map(s => Number(s.id))));
            for (const s of (c.servicos || [])) if (s.id) {
                catalogoServicos.set(Number(s.id), s.nome);
                if (s.duracao) catalogoDuracoes.set(Number(s.id), Number(s.duracao));
            }
        }
    } catch (e) {
        console.log('[ai] Falha ao carregar catalogo para o classificador:', e && e.message);
    }

    // UM UNICO classificador por mensagem: consulta necessaria + filtros + nome/telefone.
    // (Substitui o antigo par roteador + extrator — uma chamada de IA a menos por mensagem.)
    //
    // (fix) Este e O classificador que interpreta a mensagem do cliente (servico, horario,
    // barbeiro, data, nome, telefone, etc.) — se ele falhar, o bot NAO tem ideia do que o
    // cliente acabou de dizer. Antes, uma falha aqui era so logada e o codigo seguia em
    // frente com o ESTADO ANTIGO (de antes desta mensagem), deixando o modelo principal
    // responder mesmo sem saber o que mudou nesta mensagem — podendo confirmar algo errado,
    // pular uma etapa ou simplesmente ignorar o que o cliente pediu, sem avisar ninguem.
    // Agora: tenta 2 vezes (falhas de API/rede sao comuns e geralmente passam na 2a
    // tentativa — ja visto em producao). Se AINDA ASSIM falhar, o bot NAO adivinha e NAO
    // avanca nenhuma etapa: pede explicitamente para o cliente repetir a mensagem.
    let extracao = null;
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
        try {
            extracao = await extrairEstadoDaConversa(montarTranscricao(messages), catalogoServicos, catalogoBarbeiros, estado);
            break;
        } catch (e) {
            console.log(`[ai] Classificador de estado falhou (tentativa ${tentativa}/2):`, e && e.message);
        }
    }
    if (!extracao) {
        console.log('[ai] Nao foi possivel interpretar a mensagem apos 2 tentativas — pedindo para o cliente repetir, sem avancar nenhuma etapa');
        const respostaFalha = 'Desculpe, não entendi sua mensagem. Pode repetir, por favor? 🙏';
        const historicoLimpoFalha = messages.filter(m =>
            (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[SISTEMA]')) ||
            (m.role === 'assistant' && typeof m.content === 'string' && m.content && !m.tool_calls)
        );
        saveSession(phone, historicoLimpoFalha);
        return respostaFalha;
    }
    try {
        const pessoaAtualAntesDaMescla = (estado.multiAgendamento && estado.pessoasPlano.length > 0)
            ? estado.pessoasPlano[obterIndicePessoaAtual(estado)]
            : null;
        const mensagemTemServicoExplicito = mensagemMencionaServicoDoCatalogo(mensagem, catalogoServicos);
        const mensagemTemHorarioExpresso = mensagemTemHorarioExplicito(mensagem);

        if (Array.isArray(extracao?.servico_ids) && extracao.servico_ids.length > 0 && !mensagemTemServicoExplicito) {
            if (pessoaAtualAntesDaMescla && Array.isArray(pessoaAtualAntesDaMescla.servico_ids) && pessoaAtualAntesDaMescla.servico_ids.length > 0) {
                extracao.servico_ids = [...pessoaAtualAntesDaMescla.servico_ids];
                console.log('[ai] Servico inferido sem mencao explicita na mensagem — restaurando servico da pessoa atual do grupo');
            } else if (estado.servico_ids.length > 0) {
                extracao.servico_ids = [...estado.servico_ids];
                console.log('[ai] Servico inferido sem mencao explicita na mensagem — preservando servico ja confirmado do estado');
            } else {
                extracao.servico_ids = [];
                console.log('[ai] Servico inferido apenas pelo historico, sem mencao explicita e sem servico atual confiavel — limpando extracao');
            }
        }

        if (typeof extracao?.horarioEscolhido === 'string' && extracao.horarioEscolhido && !mensagemTemHorarioExpresso && !estado.horarioEscolhido) {
            extracao.horarioEscolhido = null;
            console.log('[ai] Horario inferido apenas pelo historico, sem mencao explicita na mensagem — limpando extracao');
        }

        // TRAVA DETERMINISTICA — SERVICO_IDS SO MUDA SE A MENSAGEM REALMENTE MENCIONAR
        // SERVICO: o classificador relê a conversa INTEIRA a cada turno, e em mensagens que
        // nao tem nada a ver com servico (ex: so um horario "18:45"), ja aconteceu dele
        // reinterpretar errado um combo ja estabelecido e trocar por um item PARECIDO do
        // catalogo que na verdade inclui um servico extra nunca pedido (ex: trocar "corte +
        // sobrancelha" por "cabelo + barba + sobrancelha"). Isso silenciosamente muda a
        // duracao do servico e faz um horario ja oferecido como livre "sumir" na hora de
        // criar. So valida a MUDANCA quando ja havia servico ESTABELECIDO antes (a primeira
        // definicao sempre passa).
        if (estado.servico_ids.length > 0 && Array.isArray(extracao?.servico_ids) && extracao.servico_ids.length > 0) {
            const atuaisOrdenados = [...estado.servico_ids].sort((a, b) => a - b);
            const novosOrdenados = [...extracao.servico_ids].map(Number).sort((a, b) => a - b);
            const mudou = JSON.stringify(atuaisOrdenados) !== JSON.stringify(novosOrdenados);
            if (mudou) {
                const mensagemLower = mensagem.toLowerCase();
                const mencionaAlgumServico = [...catalogoServicos.values()].some(nome =>
                    nome.toLowerCase().split(/[\s()+]+/).filter(p => p.length >= 4).some(palavra => mensagemLower.includes(palavra))
                );
                if (!mencionaAlgumServico) {
                    console.log(`[ai] Classificador tentou mudar servico_ids de [${atuaisOrdenados}] para [${novosOrdenados}] numa mensagem sem mencao a servico ("${mensagem}") — IGNORADO, mantendo servico_ids anterior`);
                    extracao.servico_ids = [...estado.servico_ids];
                }
            }
        }
        mesclarEstado(estado, extracao, catalogoServicos, catalogoBarbeiros, catalogoBarbeiroServicos, messages);

        // (fix) Captura o periodo COMBINADO PARA O GRUPO na primeira vez que ele fica
        // conhecido (ex: "amanha a tarde para os dois") — guardado separado de
        // estado.periodo porque este ultimo e sobrescrito com null a cada mensagem que
        // extrai um horario ESPECIFICO sem repetir o periodo (ver comentario em
        // registrarSelecaoGrupoSeCompleta, que restaura esse valor ao avancar de pessoa).
        if (estado.multiAgendamento && estado.periodo && !estado.periodoGrupo) {
            estado.periodoGrupo = estado.periodo;
        }
        if (estado.multiAgendamento && estado.barbeiro_id && !estado.barbeiroGrupo && estado.selecoesGrupo.length === 0 && !estado.horarioEscolhido && /\b(os dois|as duas|todos|todas|ambos|ambas)\b/i.test(mensagem)) {
            estado.barbeiroGrupo = estado.barbeiro_id;
        }

        // (v4.2) Assim que o pedido multi-agendamento e identificado, captura (via chamada
        // dedicada) o papel e o servico de cada pessoa mencionada na conversa — em vez de
        // deixar isso se perder quando o fluxo avanca para o proximo agendamento.
        // (v4.2.3) BUG CORRIGIDO: a trava so rodava quando pessoasPlano.length===0 — se o
        // cliente mencionasse as PESSOAS antes dos SERVICOS (ex: "quero agendar pra meu filho
        // e marido" numa mensagem, servicos so numa mensagem seguinte), a captura rodava cedo
        // demais, achava as 2 pessoas mas com servico_ids VAZIO pra ambas, e o comprimento do
        // array (2) bloqueava QUALQUER nova tentativa pro resto da conversa — mesmo depois do
        // cliente informar os servicos de verdade. Sem o reforco funcionando (nada capturado
        // pra reforcar), o classificador principal ficou livre pra "adivinhar" servico_ids
        // sozinho a cada turno, e chegou a misturar servico de pessoas diferentes num combo so
        // (ex: corte do filho + cabelo/barba/sobrancelha do marido virando um unico item).
        // Agora tenta de novo enquanto NENHUMA pessoa tiver servico capturado ainda E nenhum
        // agendamento do grupo tiver sido criado (retry seguro: para de tentar assim que pelo
        // menos uma captura da certo, ou assim que o primeiro agendamento ja foi criado, para
        // nao arriscar sobrescrever dados que ja estao em uso).
        const precisaCapturarPessoasDoGrupo = estado.multiAgendamento && estado.agendamentosCompletos === 0 &&
            (estado.pessoasPlano.length === 0 || estado.pessoasPlano.every(p => !Array.isArray(p.servico_ids) || p.servico_ids.length === 0));
        if (precisaCapturarPessoasDoGrupo) {
            estado.pessoasPlano = await identificarPessoasDoGrupo(montarTranscricao(messages), catalogoServicos, catalogoBarbeiros, estado.totalAgendamentos);
            console.log('[ai] Pessoas do grupo capturadas:', JSON.stringify(estado.pessoasPlano));
            // (fix) Se o cliente ja informou um horario exato para a pessoa ATUAL (primeira
            // do grupo ainda sem agendamento) na mesma mensagem que definiu o grupo todo (ex:
            // "corte pro filho as 10 e barba as 11 pra mim"), aplica esse horario de imediato
            // — sem isso o bot ignorava o horario dela e mostrava a lista completa de horarios
            // livres, mesmo com o cliente ja tendo pedido um horario especifico.
            const pessoaInicialComHorario = estado.pessoasPlano[obterIndicePessoaAtual(estado)];
            if (pessoaInicialComHorario?.horario && !estado.horarioEscolhido) {
                estado.horarioEscolhido = pessoaInicialComHorario.horario;
                estado.horarioMinimo = null;
                estado.horarioMaximo = null;
            }
            // (melhoria) Mesmo tratamento para barbeiro: se o cliente ja pediu um barbeiro
            // especifico para a pessoa ATUAL na mesma mensagem (ex: "...com o fabricio" logo
            // apos falar do marido), aplica de imediato — sem isso o bot mostrava disponibilidade
            // de TODOS os barbeiros mesmo com um ja escolhido para essa pessoa.
            if (pessoaInicialComHorario?.barbeiro_id && !estado.barbeiro_id) {
                estado.barbeiro_id = pessoaInicialComHorario.barbeiro_id;
            }
        }
        if (estado.multiAgendamento && estado.pessoasPlano.length > 0) {
            const periodosDaMensagem = extrairPeriodosPorPessoa(mensagem);
            if (periodosDaMensagem.length >= estado.pessoasPlano.length && periodosDaMensagem.some(Boolean)) {
                estado.pessoasPlano = estado.pessoasPlano.map((pessoa, indice) => ({
                    ...pessoa,
                    periodo: periodosDaMensagem[indice] || pessoa.periodo || null,
                }));
                estado.periodoGrupo = null;
                const pessoaAtualComPeriodo = estado.pessoasPlano[obterIndicePessoaAtual(estado)];
                if (pessoaAtualComPeriodo?.periodo && !estado.horarioEscolhido) {
                    estado.periodo = pessoaAtualComPeriodo.periodo;
                    estado.horarioMinimo = null;
                    estado.horarioMaximo = null;
                }
                console.log('[ai] Periodos individuais associados por pessoa:', JSON.stringify(periodosDaMensagem));
            }
        }
        // Reforca a cada turno: o servico_ids do agendamento ATUAL (o proximo a ser criado)
        // vem do que foi capturado acima quando disponivel, para nao depender de o
        // classificador principal "lembrar" disso de novo em cada mensagem.
        if (estado.multiAgendamento && estado.pessoasPlano.length > 0) {
            const pessoaAtual = estado.pessoasPlano[obterIndicePessoaAtual(estado)];
            const selecaoCompletaPendente = !!(estado.horarioEscolhido && estado.barbeiro_id);
            if (!selecaoCompletaPendente && pessoaAtual && Array.isArray(pessoaAtual.servico_ids) && pessoaAtual.servico_ids.length > 0) {
                estado.servico_ids = [...pessoaAtual.servico_ids];
            }
            // (melhoria) Mesma logica para o barbeiro: se a pessoa ATUAL do grupo ja tem um
            // barbeiro especifico capturado (ex: "com o fabricio" pro marido), reforca isso a
            // cada turno em estado.barbeiro_id, para a consulta de disponibilidade filtrar so
            // aquele barbeiro em vez de mostrar todos.
            if (!selecaoCompletaPendente && pessoaAtual && pessoaAtual.barbeiro_id) {
                estado.barbeiro_id = pessoaAtual.barbeiro_id;
            }
        }

        // Salva escolha de horario/barbeiro no grupo assim que o cliente confirma (ex: "bryan 18")
        // (fix) precisaVerificarDisponibilidadeNovaPessoa (declarada no topo da funcao, antes
        // deste bloco — precisa sobreviver para ser lida la dentro do try{} mais abaixo):
        // quando a selecao da pessoa atual e registrada por EXTRACAO DIRETA da mensagem
        // (regex/estado, sem o modelo ter chamado nenhuma ferramenta nesta rodada) e ainda
        // faltam pessoas no grupo, nada garantia que o modelo fosse REALMENTE consultar a
        // disponibilidade da proxima pessoa antes de responder — na pratica, ja aconteceu do
        // bot perguntar "qual horario prefere para o [filho/proxima pessoa]?" SEM mostrar
        // nenhum horario, e so listar as opcoes depois que o cliente respondia (porque so ai
        // uma nova consulta era disparada). Essa flag forca verificar_disponibilidade_todos na
        // primeira chamada desta rodada nesse cenario.
        if (estado.multiAgendamento) {
            const registrouSelecaoAgora = registrarSelecaoGrupoUmaVezPorMensagem(estado, mensagem, catalogoBarbeiros);
            if (registrouSelecaoAgora && estado.selecoesGrupo.length === estado.totalAgendamentos && !(estado.nome && estado.telefone) && !estado.contatoSolicitado) {
                estado.contatoSolicitado = true;
                messages.push({ role: 'user', content: '[SISTEMA] Todos os horarios do grupo acabaram de ser escolhidos nesta mensagem. Agora peca EXATAMENTE: "Informe seu nome completo e telefone para registrar os agendamentos". NAO peca servico, NAO peca barbeiro e NAO reconfirme horarios.' });
            } else if (registrouSelecaoAgora && estado.selecoesGrupo.length < estado.totalAgendamentos) {
                precisaVerificarDisponibilidadeNovaPessoa = true;
            }
        }

        if (estado.reagendamentoEmAndamento && !estado.reagendamentoAlvo && Array.isArray(estado.mapaAgendamentos) && estado.mapaAgendamentos.length > 0) {
            // (fix) A extracao anterior exigia que a mensagem fosse EXATAMENTE "1" ou
            // "1 as 14h" (regex ancorada com ^...$) — qualquer texto antes do numero
            // (ex: "quero reagendar p 1 para as 14 horas") fazia o match falhar
            // SILENCIOSAMENTE, deixando reagendamentoAlvo null pelo resto da conversa.
            // Isso derrubava em cascata: o servico/barbeiro do agendamento antigo nunca
            // era reaproveitado (bot perguntava o servico de novo), o horario informado
            // junto com a posicao era perdido (bot perguntava o periodo de novo), e o
            // cancelamento automatico do agendamento antigo (que depende de
            // reagendamentoAlvo.id) nunca era disparado no final. Agora a extracao busca
            // a posicao e o horario em QUALQUER parte da mensagem, nao so quando ela e
            // um numero isolado.
            const textoReagendamento = String(mensagem || '').trim();

            // Horario: aceita "para as 14 horas", "as 14h", "14:00", "pras 14h" — com ou
            // sem preposicao antes do numero (cobre "14 horas" dito sozinho tambem).
            const matchHorario = textoReagendamento.match(/\b(?:as|às|para|pelas?|pras?)?\s*(\d{1,2})(?::(\d{2}))?\s*(?:h\b|horas?\b)/i)
                || textoReagendamento.match(/\b(\d{1,2}):(\d{2})\b/);
            const horarioExtraido = matchHorario
                ? `${String(matchHorario[1]).padStart(2, '0')}:${matchHorario[2] || '00'}`
                : null;

            // Posicao do item na lista: procura em qualquer parte da frase (nao so no
            // inicio), removendo antes o trecho do horario para nao confundir o numero da
            // HORA (ex: "14" em "14 horas") com o numero da POSICAO (ex: "1" em "o 1").
            // Aceita tambem ordinais por extenso ("primeiro", "segundo"...).
            const textoSemHorario = matchHorario ? textoReagendamento.replace(matchHorario[0], ' ') : textoReagendamento;
            const MAPA_ORDINAL_POSICAO = { primeiro: '1', primeira: '1', segundo: '2', segunda: '2', terceiro: '3', terceira: '3', quarto: '4', quarta: '4', quinto: '5', quinta: '5' };
            const matchOrdinal = textoSemHorario.toLowerCase().match(/\b(primeir[oa]|segund[oa]|terceir[oa]|quart[oa]|quint[oa])\b/);
            const matchNumero = textoSemHorario.match(/\b(\d{1,2})\b/);
            const posicaoEscolhida = matchOrdinal ? MAPA_ORDINAL_POSICAO[matchOrdinal[1]] : (matchNumero ? matchNumero[1] : null);

            if (posicaoEscolhida) {
                const alvo = estado.mapaAgendamentos[Number(posicaoEscolhida) - 1] || null;
                if (alvo) {
                    estado.reagendamentoAlvo = { ...alvo };
                    const barbeiroIdAlvo = barbeiroIdPorNome(alvo.barbeiro, catalogoBarbeiros);
                    const servicoIdsAlvo = servicoIdsPorNome(alvo.servico, catalogoServicos);
                    if (barbeiroIdAlvo) estado.barbeiro_id = barbeiroIdAlvo;
                    if (servicoIdsAlvo.length > 0) estado.servico_ids = servicoIdsAlvo;
                    estado.horarioEscolhido = horarioExtraido;
                    estado.horarioMinimo = null;
                    estado.horarioMaximo = null;
                    console.log(`[ai] Reagendamento: alvo selecionado via posicao ${posicaoEscolhida} -> id ${alvo.id}${estado.horarioEscolhido ? ` no horario ${estado.horarioEscolhido}` : ''}`);
                }
            }
        }
        
        // ANUNCIO — MULTIPLOS AGENDAMENTOS (SIMPLIFICADO): na primeira vez que detectado
        const pedirOMesmo = /\bo\s+mesm[oa]\b|\bmesm[oa]\s+servi[cç]o\b|\bmesm[oa]\s+hor[aá]ri[oa]\b|\bmesm[oa]\s+barbeir[oa]\b/i.test(mensagem);
        if (estado.multiAgendamento && pedirOMesmo && estado.ultimoAgendamentoConfirmado) {
            const ua = estado.ultimoAgendamentoConfirmado;
            if (!estado.data) estado.data = ua.data;
            if (!estado.barbeiro_id) estado.barbeiro_id = ua.barbeiro_id;
            if (!Array.isArray(estado.servico_ids) || estado.servico_ids.length === 0) estado.servico_ids = [...ua.servico_ids];
            if (!estado.horarioEscolhido) estado.horarioEscolhido = ua.horario;
            console.log('[ai] Comando "o mesmo" detectado — reaproveitando ultimoAgendamentoConfirmado');
        }

        // Modo horários em lote REMOVIDO (v4.0 refatoração multi-agendamento)
        // Agora usa fluxo sequencial simples: um agendamento por vez
        // TRAVA DETERMINISTICA DE PERIODO: o classificador as vezes confunde "tarde"/"manha"/
        // "noite" (mencao generica) com um horario minimo numerico (ex: horarioMinimo:"12:00"),
        // o que faz o filtro de periodo ser pulado em codigo (pois horarioMinimo tem prioridade)
        // e deixa vazar horarios de OUTRO periodo (ex: 18h-19h aparecendo como "tarde").
        // Quando a mensagem crua do cliente e SO a palavra do periodo (sem nenhum digito),
        // forca o periodo certo em codigo e limpa qualquer horarioMinimo/Maximo que o
        // classificador tenha inventado para essa mesma mensagem.
        if (/^\s*(?:(?:de|a|[àá])\s+)?(manh[aã]|tarde|noite)\s*\.?\s*$/i.test(mensagem) && !/\d/.test(mensagem)) {
            const m = mensagem.toLowerCase();
            const periodoForcado = m.includes('manh') ? 'manha' : m.includes('tarde') ? 'tarde' : 'noite';
            if (estado.periodo !== periodoForcado || estado.horarioMinimo || estado.horarioMaximo) {
                estado.periodo = periodoForcado;
                estado.horarioMinimo = null;
                estado.horarioMaximo = null;
                estado.horarioEscolhido = null;
                console.log(`[ai] Mensagem era so o periodo "${periodoForcado}" — forcando estado.periodo e limpando horarioMinimo/Maximo indevidos`);
            }
        }
        // TRAVA DETERMINISTICA DE DIA DA SEMANA NOMEADO: quando o cliente cita um dia da
        // semana pelo nome (ex: "quarta feira", "sexta"), calcula a proxima data real em
        // CODIGO em vez de confiar no classificador — ja aconteceu dele resolver errado
        // (ex: "quarta feira" virar a data de HOJE, que era segunda). So ignora se a mesma
        // mensagem tambem disser "hoje"/"amanha" explicitamente (evita conflito de sinais).
        if (!/\bhoje\b|\bamanh[aã]\b/i.test(mensagem)) {
            const mDia = mensagem.toLowerCase().match(/\b(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)(-feira)?\b/);
            if (mDia) {
                const MAPA_DIA = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
                const chave = mDia[1].replace(/[çÇ]/g, 'c').replace(/[áÁ]/g, 'a');
                const alvo = MAPA_DIA[chave];
                if (alvo !== undefined) {
                    const querProximaSemana = /que vem|pr[oó]xima/i.test(mensagem);
                    const agoraBRT3 = new Date(Date.now() - 3 * 60 * 60 * 1000);
                    let diasAte = (alvo - agoraBRT3.getUTCDay() + 7) % 7;
                    if (diasAte === 0 && querProximaSemana) diasAte = 7;
                    const dataAlvo = new Date(agoraBRT3);
                    dataAlvo.setUTCDate(dataAlvo.getUTCDate() + diasAte);
                    const dataForcada = dataAlvo.toISOString().slice(0, 10);
                    if (estado.data !== dataForcada) {
                        console.log(`[ai] Dia da semana nomeado ("${mDia[0]}") — forcando estado.data de "${estado.data}" para "${dataForcada}"`);
                        estado.data = dataForcada;
                    }
                }
            }
        }
        // ENCERRAMENTO DETERMINISTICO MULTI-AGENDAMENTO
        if (estado.multiAgendamento && /\b(s[oó]\s+isso|acabou|finalizou|n[aã]o\s+tem\s+mais|n[aã]o\s+precisa\s+agendar\s+mais|era\s+s[oó])\b/i.test(mensagem)) {
            estado.multiAgendamento = false;
            estado.totalAgendamentos = 1;
            estado.agendamentosCompletos = 0;
            estado.pessoasPlano = [];
            estado.selecoesGrupo = [];
            estado.periodoGrupo = null;
            estado.barbeiroGrupo = null;
            estado.reagendamentoAlvo = null;
            estado._totalConfirmado = true; // (fix) padrao volta a ser "nao precisa confirmar"
            console.log('[ai] Cliente encerrou multi-agendamento explicitamente');
        }
        
        // CONFIRMAÇÃO DO NÚMERO DE PESSOAS em multi-agendamento
        // Detecta quando o cliente confirma ou corrige o número de pessoas
        if (estado.multiAgendamento && !estado._totalConfirmado && estado.agendamentosCompletos === 0) {
            // Detecta confirmação simples (sim, isso, correto, etc.)
            const regexConfirmacao = /\b(sim|isso|correto|exato|certo|s[ãa]o\s+(dois|tr[êe]s|quatro|cinco|seis))\b/i;
            // Detecta especificação explícita de número ("são 2", "dois agendamentos", etc.)
            const matchNumero = mensagem.match(/\b(?:s[ãa]o|apenas)\s+(dois|tr[êe]s|quatro|cinco|seis|2|3|4|5|6)(?:\s+(?:pessoa|agendamento|corte)s?)?\b/i);
            
            if (regexConfirmacao.test(mensagem) || matchNumero) {
                estado._totalConfirmado = true;
                console.log(`[ai] Cliente confirmou número de pessoas: ${estado.totalAgendamentos}`);
                
                // Se cliente especificou um número diferente, ajusta
                if (matchNumero) {
                    const mapaNumeros = { 'dois': 2, '2': 2, 'três': 3, 'tres': 3, '3': 3, 'quatro': 4, '4': 4, 'cinco': 5, '5': 5, 'seis': 6, '6': 6 };
                    const numEspecificado = mapaNumeros[matchNumero[1].toLowerCase()];
                    if (numEspecificado && numEspecificado !== estado.totalAgendamentos) {
                        console.log(`[ai] Ajustando totalAgendamentos de ${estado.totalAgendamentos} para ${numEspecificado} (especificado pelo cliente)`);
                        estado.totalAgendamentos = numEspecificado;
                    }
                }
            }
        }
        
        // DETECÇÃO DE DESISTÊNCIA/REDUÇÃO: se cliente inicialmente disse que eram N pessoas
        // mas depois claramente desiste/cancela os demais, ajusta totalAgendamentos para
        // refletir apenas os já criados + 1 em andamento, evitando loop infinito de "próximo?"
        const regexDesistencia = /\b(desisti|só\s+ess[ea]|só\s+um|não\s+precisa\s+(d[eo]s?\s+)?outr[oa]s?|mudei\s+de\s+ideia|cancela\s+o\s+resto)\b/i;
        if (estado.multiAgendamento && 
            estado.agendamentosCompletos > 0 && 
            regexDesistencia.test(mensagem)) {
            
            const anterior = estado.totalAgendamentos;
            estado.totalAgendamentos = estado.agendamentosCompletos;
            
            // Se estava no meio de um agendamento, conta como +1
            if (estado.data || estado.servico_ids.length > 0) {
                estado.totalAgendamentos++;
            }
            
            console.log(`[ai] Desistência detectada — totalAgendamentos reduzido de ${anterior} para ${estado.totalAgendamentos}`);
            
            // Limpa pessoasPlano para não tentar usar dados das pessoas que desistiram
            if (estado.pessoasPlano.length > estado.totalAgendamentos) {
                estado.pessoasPlano = estado.pessoasPlano.slice(0, estado.totalAgendamentos);
            }
            if (estado.selecoesGrupo.length > estado.totalAgendamentos) {
                estado.selecoesGrupo = estado.selecoesGrupo.slice(0, estado.totalAgendamentos);
            }
        }
        // TRAVA DETERMINISTICA DE HORARIO: quando a mensagem crua do cliente e SO um horario
        // (ex: "9:30", "9h30"), forca esse valor como horarioEscolhido em codigo — o
        // classificador as vezes trata a repeticao de um horario ja usado como filtro (nao
        // como confirmacao), fazendo o cliente precisar repetir o mesmo horario 2x antes do
        // bot avancar. Exige minuto explicito (\d{2}) para nao disparar em mensagens tipo "8:".
        // NAO aplica quando todos os horarios do grupo ja foram escolhidos — o cliente pode
        // responder "15:45" apos um falso "indisponivel", mas selecoesGrupo ja tem o horario certo.
        const grupoHorariosCompletos = estado.multiAgendamento &&
            estado.selecoesGrupo.length === estado.totalAgendamentos &&
            estado.agendamentosCompletos === 0;
        if (!grupoHorariosCompletos) {
            const mBareTime = mensagem.trim().match(/^(\d{1,2})[:h](\d{2})$/i);
            if (mBareTime) {
                const horaForcada = `${String(mBareTime[1]).padStart(2, '0')}:${mBareTime[2]}`;
                if (estado.horarioEscolhido !== horaForcada) {
                    estado.horarioEscolhido = horaForcada;
                    estado.horarioMinimo = null;
                    estado.horarioMaximo = null;
                    console.log(`[ai] Mensagem era so um horario ("${horaForcada}") — forcando estado.horarioEscolhido`);
                }
            }
        }

        console.log('[ai] Estado atualizado:', JSON.stringify({ ...estado, mapaAgendamentos: undefined, criadosNestaConversa: undefined }));
    } catch (e) {
        // (fix) Este catch agora cobre apenas erros de MESCLAGEM do estado (bug no codigo
        // apos a extracao ja ter funcionado) — a falha da CHAMADA do classificador em si
        // (API/rede) e tratada acima, com retry e pedido explicito de repeticao ao cliente.
        console.log('[ai] Erro ao mesclar estado extraido (mantendo estado anterior):', e && e.message);
    }

    // TRAVA DETERMINISTICA — CONTATO UNICO DO GRUPO (v4.2.6): quando o bot ACABOU de
    // pedir "Informe seu nome completo e telefone para registrar os agendamentos" para
    // um multi-agendamento (estado.contatoSolicitado), a proxima mensagem do cliente e
    // SEMPRE o contato UNICO do lote inteiro — nunca o nome de uma pessoa especifica do
    // grupo. O prompt do classificador ja tem essa excecao documentada, mas depender SO
    // dele e arriscado por DOIS motivos, ambos ja observados nos logs: (1) o classificador
    // releva a conversa toda a cada mensagem e pode aplicar por engano a regra geral de
    // "nome novo por pessoa" mesmo com a excecao escrita; (2) o classificador pode falhar
    // por completo (ex: JSON truncado/malformado da API — "Unterminated string in JSON"),
    // caindo no catch acima SEM rodar mesclarEstado NENHUMA VEZ. Por isso este bloco fica
    // FORA do try/catch do classificador (nao dentro dele como antes) — ele roda sempre,
    // mesmo quando o classificador falha completamente, extraindo nome+telefone
    // diretamente da mensagem crua em CODIGO, via regex, sem depender da IA acertar.
    const aguardandoContatoGrupoAgora = estado.multiAgendamento && estado.contatoSolicitado && estado.agendamentosCompletos === 0;
    if (aguardandoContatoGrupoAgora && !(estado.nome && estado.telefone)) {
        const mTelefoneGrupo = mensagem.match(/\d[\d\s\-().]{8,}\d/);
        const telefoneCruGrupo = mTelefoneGrupo ? mTelefoneGrupo[0].replace(/\D/g, '') : null;
        if (telefoneCruGrupo && telefoneCruGrupo.length >= 10 && telefoneCruGrupo.length <= 11) {
            const nomeCruGrupo = mensagem.replace(mTelefoneGrupo[0], '').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
            if (nomeCruGrupo.split(' ').filter(Boolean).length >= 2) {
                if (!estado.telefone) estado.telefone = telefoneCruGrupo;
                if (!estado.nome) estado.nome = nomeCruGrupo;
                console.log(`[ai] TRAVA contato-unico-do-grupo: extraido em codigo nome="${estado.nome}" telefone="${estado.telefone}" (classificador nao capturou ou falhou)`);
            }
        }
    }

    const systemPrompt = buildSystemPrompt(primeiraMensagem, numeroConfiavel, montarBlocoEstado(estado, catalogoServicos, catalogoBarbeiros));

    if (estado.multiAgendamento && estado.selecoesGrupo.length < estado.totalAgendamentos && !estado.contatoSolicitado) {
        messages.push({ role: 'user', content: '[SISTEMA] MULTI-AGENDAMENTO: Ainda faltam horarios para o grupo. NAO peça nome e telefone agora. Continue selecionando os horarios das pessoas restantes e so depois, quando todos os horarios estao escolhidos, peca UMA UNICA vez o nome completo e telefone para registrar todos os agendamentos do grupo.' });
    }
    if (estado.multiAgendamento && estado.selecoesGrupo.length === estado.totalAgendamentos && estado.nome && estado.telefone && estado.agendamentosCompletos === 0) {
        messages.push({ role: 'user', content: '[SISTEMA] MULTI-AGENDAMENTO: Todos os horarios do grupo ja foram escolhidos e o contato ja foi fornecido. Use esse mesmo nome e telefone para criar todos os agendamentos restantes no banco. NAO peça nomes separados nem pergunte novamente.' });
    }

    let resposta = '';
    try {
        let forcarTool = null;

        // Camada DETERMINISTICA (regex, sem IA): palavras-chave de NOVO FILTRO na ultima
        // mensagem forcam a consulta de disponibilidade com garantia de 100%, mesmo que o
        // classificador erre. Horario "solto" (ex: "8:30 fab") NAO entra aqui — pode ser a
        // ESCOLHA de uma opcao ja exibida; esse caso ambiguo fica com o classificador.
        const REGEX_NOVO_FILTRO = /\bdepois\s+d[aeo]s?\b|\bantes\s+d[aeo]s?\b|\ba\s*partir\s+d[aeo]s?\b|\bde\s+manh[aã]\b|\b[aà]\s*tarde\b|\b[aà]\s*noite\b|\bhoje\b|\bamanh[aã]\b/i;
        if (REGEX_NOVO_FILTRO.test(mensagem)) {
            forcarTool = 'verificar_disponibilidade_todos';
            console.log('[ai] Regex detectou novo filtro de periodo/data — forcando verificar_disponibilidade_todos');
        }

        // Decisao do classificador unificado (campo "consulta"). NUNCA deixa trocar um
        // "verificar_disponibilidade_todos" do regex pela ferramenta SINGULAR — a singular
        // nao passa pelo pipeline de combinacao/filtro de servicos multiplos.
        const consultaCls = extracao && extracao.consulta;
        const trocaProibida = forcarTool === 'verificar_disponibilidade_todos' && consultaCls === 'verificar_disponibilidade';
        if (consultaCls && NOMES_FERRAMENTAS_CONSULTA.includes(consultaCls) && !trocaProibida) {
            forcarTool = consultaCls;
            console.log(`[ai] Classificador detectou necessidade de consulta — forcando ${forcarTool}`);
        } else if (trocaProibida) {
            console.log('[ai] Classificador tentou trocar para verificar_disponibilidade (singular) — IGNORADO.');
        }

        // Trava anterior de aguardaServicoProximaPessoa REMOVIDA (fluxo sequencial substitui)

        // TRAVA DETERMINISTICA — REAGENDAMENTO: "reagendar"/"remarcar"/"trocar/mudar meu
        // horario" SEMPRE forca buscar_agendamento primeiro, e tem PRIORIDADE sobre qualquer
        // forcarTool que o classificador tenha decidido antes. Ja aconteceu do bot pular
        // direto para uma consulta de disponibilidade usando servico/barbeiro que sobraram de
        // uma navegacao anterior na mesma conversa, e "inventar" um agendamento pra reagendar
        // que o cliente nem tinha pedido. Reagendamento sempre comeca pelos agendamentos REAIS.
        // (fix) Adicionados "reager"/"reagenar" — erros de digitacao comuns de "reagendar"
        // (faltando "nd" ou "d") que nao batiam com "\breagend" e deixavam TODO o modo de
        // reagendamento desligado: o bot ate mostrava a lista de agendamentos (por inferencia
        // generica do classificador), mas sem reagendamentoEmAndamento=true nunca guardava qual
        // agendamento foi escolhido nem herdava o servico/barbeiro dele — por isso voltava a
        // perguntar o servico de novo depois do cliente escolher pela posicao na lista.
        const REGEX_REAGENDAR = /\breagend|\breager\b|\breagenar\b|\bremarc|\btroc(ar|a)\s+(\w+\s+)?hor[aá]rio|\bmud(ar|a)\s+(\w+\s+)?hor[aá]rio/i;
        if (REGEX_REAGENDAR.test(mensagem) && !estado.reagendamentoAlvo) {
            forcarTool = 'buscar_agendamento';
            estado.reagendamentoEmAndamento = true;
            // Limpa qualquer filtro de servico/barbeiro/horario/DATA que tenha sobrado de uma
            // navegacao anterior — o reagendamento deve partir do agendamento REAL escolhido
            // pelo cliente, nunca de algo que ele so estava olhando antes na conversa. (v4.2.2)
            // A DATA precisa ser limpa tambem — sem isso, a data do agendamento ANTIGO (que
            // esta sendo trocado) ficava em estado.data, fazendo o bot pular direto para
            // "qual periodo" sem nunca perguntar para qual NOVA data o cliente quer mudar.
            estado.data = null;
            estado.servico_ids = [];
            estado.barbeiro_id = null;
            estado.periodo = null;
            estado.periodoGrupo = null;
            estado.barbeiroGrupo = null;
            estado.horarioMinimo = null;
            estado.horarioMaximo = null;
            estado.horarioEscolhido = null;
            estado.reagendamentoAlvo = null;
            messages.push({ role: 'user', content: '[SISTEMA] O cliente pediu para REAGENDAR/REMARCAR um horario. Os agendamentos REAIS e ATUAIS dele foram buscados no banco (retorno desta ferramenta, ou virao a seguir se faltar nome/telefone). Apresente EXATAMENTE esses agendamentos e pergunte qual ele quer reagendar — NUNCA invente, assuma ou reaproveite um agendamento/servico/barbeiro de uma parte anterior da conversa que nao apareca nesse retorno.' });
            console.log('[ai] Regex detectou pedido de reagendamento — forcando buscar_agendamento e limpando estado antigo');
        }

        // Depois que o cliente escolheu o agendamento antigo, "reagende para 09:30"
        // e uma escolha do novo horario, nao um novo inicio do fluxo. Mantem os dados
        // reais do alvo para reutilizar o mesmo servico e barbeiro por padrao.
        if (estado.reagendamentoEmAndamento && estado.reagendamentoAlvo) {
            const alvo = estado.reagendamentoAlvo;
            const servicoIdsAlvo = servicoIdsPorNome(alvo.servico, catalogoServicos);
            const barbeiroIdAlvo = barbeiroIdPorNome(alvo.barbeiro, catalogoBarbeiros);
            const pedeMesmoServico = /\b(?:o|ao)\s+mesmo\b|\bmesmo\s+servi[cç]o\b/i.test(mensagem);
            if (servicoIdsAlvo.length > 0 && (pedeMesmoServico || !mensagemMencionaServicoDoCatalogo(mensagem, catalogoServicos))) {
                estado.servico_ids = servicoIdsAlvo;
            }
            if (barbeiroIdAlvo && !/\b(?:com|para)\s+(?:o\s+)?(?:fabricio|felipe|bryan)\b/i.test(mensagem)) {
                estado.barbeiro_id = barbeiroIdAlvo;
            }
            if (estado.reagendamentoAlvo.data && !estado.data) estado.data = estado.reagendamentoAlvo.data;
        }

        // NUNCA assumir data: sem data conhecida (nem na mensagem, nem no estado),
        // a consulta de disponibilidade nao e forcada — o bot PERGUNTA o dia.
        const dataConhecida = (extracao && typeof extracao.data === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(extracao.data)) ? extracao.data : (estado.data || null);
        if ((forcarTool === 'verificar_disponibilidade_todos' || forcarTool === 'verificar_disponibilidade') && !dataConhecida) {
            forcarTool = null;
            if (estado.multiAgendamento) {
                messages.push({ role: 'user', content: '[SISTEMA] O cliente pediu MULTIPLOS agendamentos e ainda NAO informou a DATA nem o periodo para comecar a busca. Pergunte numa unica mensagem qual dia ele prefere e se quer de manha, tarde ou noite. Se tambem faltar o servico da pessoa atual, pergunte tudo junto na mesma mensagem. NAO peca confirmacao do total de pessoas e NAO espere outra confirmacao antes de seguir.' });
            } else {
                messages.push({ role: 'user', content: '[SISTEMA] O cliente pediu agendamento mas ainda NAO informou a DATA. PERGUNTE qual dia ele deseja (NUNCA assuma que e para hoje e NUNCA diga que nao ha horarios). Se tambem faltar o servico, pergunte os dois numa unica mensagem.' });
            }
            console.log('[ai] Sem data conhecida — consulta suspensa; bot vai perguntar o dia');
        }

        // TRAVA DETERMINISTICA DE PERIODO: igual a trava de data acima — sem periodo,
        // horario minimo/maximo ou horario escolhido conhecidos, a consulta de
        // disponibilidade nao e forcada, mesmo com data e servico ja definidos. Antes essa
        // regra so existia como instrucao de texto no prompt, e o modelo as vezes ignorava,
        // mostrando a disponibilidade do dia INTEIRO (todos os periodos, todos os barbeiros)
        // quando o cliente so tinha dito o dia (ex: "amanha"), sem perguntar manha/tarde/noite.
        //
        // (fix) Antes de checar isso, restaura o periodo do GRUPO (periodoGrupo) se o cliente
        // ja tinha dito "de manha" (ou tarde/noite) pro agendamento todo, mas a mensagem ATUAL
        // nao repetiu isso (ex: respondeu so "fabrio 8", so com barbeiro+hora) — sem essa
        // restauracao, o periodo confirmado minutos atras era perdido e o bot voltava a
        // perguntar "prefere de manha, tarde ou noite?" do zero, mesmo o cliente ja tendo dito.
        if (estado.multiAgendamento && estado.periodoGrupo && !estado.periodo && !estado.horarioMinimo && !estado.horarioMaximo && !estado.horarioEscolhido) {
            estado.periodo = estado.periodoGrupo;
            console.log('[ai] Periodo do grupo (periodoGrupo) restaurado — mensagem atual nao repetiu o periodo, mas ja era conhecido');
        }
        const semFiltroPeriodo = !estado.periodo && !estado.horarioMinimo && !estado.horarioMaximo && !estado.horarioEscolhido;
        if ((forcarTool === 'verificar_disponibilidade_todos' || forcarTool === 'verificar_disponibilidade') && dataConhecida && semFiltroPeriodo) {
            forcarTool = null;
            messages.push({ role: 'user', content: '[SISTEMA] O cliente ja informou a data mas NAO informou periodo (manha/tarde/noite) nem um horario especifico. Nesta resposta, pergunte APENAS "Prefere de manha, tarde ou noite?" — NAO consulte disponibilidade nem liste nenhum horario ainda.' });
            console.log('[ai] Sem periodo/horario definido — consulta suspensa; bot vai perguntar o periodo');
        }

        // Bloco multi-pessoa em lote REMOVIDO (v4.0 - agora usa fluxo sequencial simples)

        // Servico fora do catalogo: a regra do prompt nao segura uma ferramenta FORCADA,
        // entao a trava e em codigo. Sem nenhum servico valido junto → suspende a consulta
        // e redireciona para o catalogo; com servicos validos misturados → segue a consulta
        // dos validos, mas avisa sobre o inexistente.
        const servicoDesconhecido = (extracao && typeof extracao.servico_desconhecido === 'string' && extracao.servico_desconhecido.trim().length >= 3)
            ? extracao.servico_desconhecido.trim() : null;
        if (servicoDesconhecido) {
            const temServicoValido = estado.servico_ids.length > 0;
            if (!temServicoValido && (forcarTool === 'verificar_disponibilidade_todos' || forcarTool === 'verificar_disponibilidade' || forcarTool === 'buscar_proximo_horario')) {
                forcarTool = null;
                messages.push({ role: 'user', content: `[SISTEMA] O cliente pediu "${servicoDesconhecido}", que NAO consta no catalogo de servicos da barbearia. Informe com simpatia que nao oferecemos esse servico, apresente os servicos que temos (chame listar_barbeiros_servicos se ainda nao tiver a lista exata) e pergunte se algum deles interessa. NAO consulte disponibilidade, NAO informe valor e NAO pergunte data para um servico que nao existe.` });
                console.log(`[ai] Servico fora do catalogo ("${servicoDesconhecido}") — consulta suspensa; bot vai apresentar o catalogo`);
            } else if (temServicoValido) {
                messages.push({ role: 'user', content: `[SISTEMA] Entre os pedidos do cliente, "${servicoDesconhecido}" NAO consta no catalogo — avise com simpatia que esse especifico nao oferecemos, e siga normalmente apenas com os servicos validos do pedido.` });
            }
        }

        // NOME INCOMPLETO: trava em codigo — nao depende so da instrucao no prompt.
        // Se o cliente acabou de dar so o primeiro nome (uma palavra), o bot e forcado a
        // insistir no sobrenome NA MESMA resposta, em vez de seguir para pedir telefone.
        // (v4.2.2) SO se aplica quando o objetivo e CRIAR um agendamento (o banco exige nome
        // e sobrenome para salvar) — quando o objetivo e apenas CONSULTAR ou CANCELAR
        // agendamentos existentes, o proprio bot ja avisa que "pelo menos o primeiro nome"
        // basta (buscarAgendamento aceita nome parcial), entao exigir sobrenome aqui seria
        // contradizer o que acabou de ser dito ao cliente.
        const nomeCru = typeof extracao?.nome === 'string' ? extracao.nome.trim() : '';
        const contextoExigeNomeCompleto = forcarTool !== 'buscar_agendamento';
        const nomeIncompletoDetectado = contextoExigeNomeCompleto && nomeCru.length >= 2 && nomeCru.split(/\s+/).length === 1 && (!estado.nome || estado.nome.split(/\s+/).length === 1);
        if (nomeIncompletoDetectado) {
            messages.push({ role: 'user', content: `[SISTEMA] O cliente informou apenas o primeiro nome ("${nomeCru}"). E OBRIGATORIO nome E sobrenome antes de prosseguir. Nesta resposta, agradeca e peca APENAS o sobrenome — NAO peca o telefone ainda, NAO avance para nenhum outro passo ate ter o nome completo.` });
            console.log(`[ai] Nome incompleto ("${nomeCru}") — bot instruido a insistir no sobrenome antes de avancar`);
        }

        // (v3.19+) A antiga trava "1a pessoa sem nome/telefone" foi removida para evitar
        // bloqueio indevido de consultas durante o fluxo de agendamento.
        // TRAVA DETERMINISTICA: buscar/cancelar agendamento EXIGE nome completo, nao so
        // telefone — o mesmo numero pode ser usado por pessoas diferentes da familia (pai e
        // filho, por exemplo), entao buscar so por telefone pode trazer ou esconder o
        // agendamento da pessoa errada.
        if (forcarTool === 'buscar_agendamento' && !estado.nome) {
            forcarTool = null;
            messages.push({ role: 'user', content: '[SISTEMA] Para buscar ou cancelar agendamentos e OBRIGATORIO ter o NOME COMPLETO do cliente, alem do telefone — o mesmo telefone pode ser usado por pessoas diferentes da familia. Peca nome completo e telefone (o que faltar) numa unica mensagem antes de consultar.' });
            console.log('[ai] buscar_agendamento sem nome — consulta suspensa, pedindo nome completo');
        }

        // TRAVA DETERMINISTICA — A MAIS CRITICA DE TODAS: quando TODOS os dados necessarios
        // para criar o agendamento ja sao conhecidos (data, horario, barbeiro, servico, nome
        // E telefone) e nada mais precisa ser perguntado, o codigo FORCA a chamada real de
        // criar_agendamento — o modelo NAO pode mais "pular" a ferramenta e escrever uma
        // confirmacao de memoria. Ja aconteceu de o modelo dizer "Agendamento confirmado ✅"
        // com todos os dados certos SEM NUNCA TER CHAMADO A FERRAMENTA — o cliente acha que
        // esta marcado e nao esta NADA no banco. Isso e uma falha grave demais para depender
        // so de instrucao de prompt.
        if (estado.multiAgendamento && estado.selecoesGrupo.length < estado.totalAgendamentos) {
            registrarSelecaoGrupoUmaVezPorMensagem(estado, mensagem, catalogoBarbeiros);
        }
        const selecaoPendenteAtual = obterSelecaoPendenteAtual(estado);
        const grupoProntoParaCriar = estado.multiAgendamento &&
            estado.selecoesGrupo.length === estado.totalAgendamentos &&
            estado.agendamentosCompletos === 0 &&
            estado.nome && estado.telefone && !nomeIncompletoDetectado;
        const agendamentoSimplesPronto = !estado.multiAgendamento &&
            estado.data && estado.horarioEscolhido && estado.barbeiro_id &&
            estado.servico_ids.length > 0 && estado.nome && estado.telefone && !nomeIncompletoDetectado;
        const loteProntoParaCriar = grupoProntoParaCriar ||
            (estado.multiAgendamento && selecaoPendenteAtual && estado.nome && estado.telefone && !nomeIncompletoDetectado) ||
            agendamentoSimplesPronto;

        // PRIORIDADE MAXIMA sobre consultas de disponibilidade — ja aconteceu do classificador
        // forcar verificar_disponibilidade_todos quando o cliente so informou nome/telefone (ou
        // respondeu a um falso "indisponivel"), fazendo o bot dizer que um horario JA ESCOLHIDO
        // estava ocupado mesmo estando livre. Sobrescreve qualquer forcarTool anterior.
        if (loteProntoParaCriar) {
            if (forcarTool && forcarTool !== 'criar_agendamento') {
                console.log(`[ai] Dados prontos para criar — ignorando consulta "${forcarTool}" e forcando criar_agendamento`);
            }
            forcarTool = 'criar_agendamento';
            if (grupoProntoParaCriar) {
                messages.push({ role: 'user', content: '[SISTEMA] CRITICO: Todos os horarios do grupo ja foram escolhidos e validados anteriormente, e o cliente acabou de informar o contato. Chame criar_agendamento AGORA para registrar cada agendamento em estado.selecoesGrupo — NUNCA reconsulte disponibilidade nesta rodada. NUNCA diga que algum horario ja escolhido esta indisponivel ou ocupado — esses horarios foram mostrados ao cliente como livres e estao guardados no sistema. Se criar_agendamento retornar "id", confirme normalmente; so informe indisponibilidade se a ferramenta retornar erro REAL de conflito (campo "erro" contendo "conflita").' });
                console.log('[ai] Grupo completo + contato — forcando criar_agendamento (prioridade sobre consulta)');
            } else if (estado.multiAgendamento && selecaoPendenteAtual) {
                console.log('[ai] Contato do grupo informado e ha selecao pendente — forcando criar_agendamento');
            } else {
                console.log('[ai] Todos os dados prontos — forcando criar_agendamento (nunca deixar o modelo so descrever a confirmacao)');
            }
        } else if (precisaVerificarDisponibilidadeNovaPessoa && !forcarTool) {
            forcarTool = 'verificar_disponibilidade_todos';
            console.log('[ai] Avancou para a proxima pessoa do grupo via extracao direta da mensagem — forcando verificar_disponibilidade_todos antes de perguntar o horario');
        }

        // Limite de seguranca: evita loop infinito de tool calls (custo descontrolado)
        const MAX_ITERACOES = 10;
        let iteracao = 0;
        // Trava que sobrevive UMA iteracao do loop: usada quando o horario acaba de ser
        // validado (verificar_disponibilidade confirmou) e nome+telefone ja sao conhecidos —
        // sem isso, o modelo as vezes pergunta nome/telefone de novo mesmo ja sabendo, porque
        // a instrucao textual "se ainda nao tiver" depende dele reparar isso sozinho no
        // [ESTADO]. Forcar em codigo garante que a proxima chamada JA crie o agendamento.
        let forcarCriarNaProximaIteracao = false;
        // (v4.2.4) Mesmo padrao acima, mas para o caso de avancar para a PROXIMA pessoa de um
        // multi-agendamento com servico ja conhecido: a instrucao em texto pedia pro modelo
        // "mostrar a disponibilidade" do proximo servico, mas isso e so uma DESCRICAO — nada
        // garantia que ele realmente chamasse verificar_disponibilidade_todos antes de
        // escrever a resposta. Na pratica, aconteceu dele so confirmar o agendamento anterior
        // e PARAR, sem nunca pedir o horario da proxima pessoa. Forcar a ferramenta na proxima
        // iteracao garante que a consulta realmente acontece.
        let forcarDisponibilidadeProximaIteracao = false;
        let forcarCancelarNaProximaIteracao = false;
        // (fix) Guarda a ultima data consultada (verificar_disponibilidade/_todos) que voltou
        // SEM nenhum horario livre, sobrevivendo a varias iteracoes do loop (ao contrario de
        // verificouDisponibilidade/dadosDisponibilidade, que sao redeclaradas a cada iteracao).
        // Sem isso, quando o cliente pede uma data (ex: "amanha") que nao tem vaga e o bot
        // busca a PROXIMA data disponivel (buscar_proximo_horario), a resposta final so
        // mostrava a data alternativa encontrada — dando a impressao ao cliente de que o bot
        // "entendeu errado" o dia pedido, quando na verdade o dia pedido foi consultado
        // corretamente e so nao tinha horario. Precisa ficar explicito na resposta.
        let dataUltimaConsultaSemVaga = null;
        while (iteracao++ < MAX_ITERACOES) {
            const criarForcadoAgora = forcarCriarNaProximaIteracao;
            forcarCriarNaProximaIteracao = false;
            const disponibilidadeForcadaAgora = forcarDisponibilidadeProximaIteracao;
            forcarDisponibilidadeProximaIteracao = false;
            const cancelarForcadoAgora = forcarCancelarNaProximaIteracao;
            forcarCancelarNaProximaIteracao = false;
            const response = await client.chat.completions.create({
                model: MODEL,
                // O modelo principal configurado via OpenRouter usa max_completion_tokens em vez
                // de max_tokens, e NAO aceita o parametro temperature (fixo em 1 pelo provedor
                // — enviar temperature causa erro 400). reasoning_effort: 'low' da uma margem
                // minima de deliberacao antes de responder (em vez de 'none', que responde sem
                // pensar nada) — ainda rapido, mas menos propenso a seguir a primeira
                // interpretacao literal quando o pedido do cliente e ambiguo.
                max_completion_tokens: 1024,
                reasoning_effort: 'low',
                messages: [{ role: 'system', content: systemPrompt }, ...messages],
                tools: TOOLS,
                // Uma ferramenta por vez: elimina a classe de bugs de chamadas duplicadas
                // simultaneas (criar_agendamento 2x, cancelamentos em paralelo etc.)
                parallel_tool_calls: false,
                // Na primeira iteracao, se a intencao detectada exige consulta ao banco,
                // a chamada da ferramenta e OBRIGATORIA — depois volta ao normal
                tool_choice: criarForcadoAgora
                    ? { type: 'function', function: { name: 'criar_agendamento' } }
                    : cancelarForcadoAgora
                    ? { type: 'function', function: { name: 'cancelar_agendamento' } }
                    : disponibilidadeForcadaAgora
                    ? { type: 'function', function: { name: 'verificar_disponibilidade_todos' } }
                    : (forcarTool && iteracao === 1)
                    ? { type: 'function', function: { name: forcarTool } }
                    : 'auto'
            });

            const choice = response.choices[0];
            const msg = choice.message;

            // IMPORTANTE: decidir pela PRESENCA de tool_calls, nao pelo finish_reason —
            // quando tool_choice forca uma ferramenta, a OpenAI retorna finish_reason "stop"
            // mesmo com tool_calls presentes
            const temToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

            if (!temToolCalls) {
                resposta = msg.content || 'Desculpe, tive um problema. Tente novamente.';
                messages.push({ role: 'assistant', content: msg.content });
                break;
            }

            if (temToolCalls) {
                messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.tool_calls });
                // Transcricao (cliente + atendente) disponivel para ferramentas que precisam
                // confirmar dados da conversa em vez de confiar cegamente nos argumentos do modelo
                const textoConversaAtual = messages
                    .filter(m =>
                        (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[SISTEMA]')) ||
                        (m.role === 'assistant' && typeof m.content === 'string' && m.content && !m.tool_calls)
                    )
                    .map(m => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.content}`)
                    .join('\n');
                let verificouDisponibilidade = false;
                let dadosDisponibilidade = null;
                let proximoHorarioEncontrado = null;
                let proximoHorarioVazio = false;
                let ultimaDataConsultada = null;
                let listouServicos = false;
                let catalogoListado = null;
                let buscouInfoBarbearia = false;
                let buscouRespostas = false;
                let agendamentosEncontrados = null;
                let buscouAgendamentoVazio = false;
                let agendamentosCriados = 0;
                let agendamentosCriadosDados = [];
                let agendamentosCriadosClientes = []; // (v3.32.3) {nome, telefone} de cada criacao, p/ buscar outros agendamentos do mesmo cliente
                let agendamentosCriadosIds = []; // ids criados nesta rodada, p/ excluir da busca de "outros agendamentos"
                // (fix) exposto tambem via estado para o executarTool poder repassar ao banco
                // ANTES de cada nova criacao — sem isso, o agendamento da 1a pessoa do grupo
                // aparecia como "outro agendamento existente" ao criar o da 2a pessoa.
                estado._idsExcluirAvisoNestaRodada = agendamentosCriadosIds;
                let ultimoAgendamentoConfirmadoRodada = null;
                let agendamentosComErro = 0;
                let agendamentoDuplicado = false;
                let avisoAgendamentosExistentesDetectado = false;
                let cancelamentosSucesso = 0;
                let cancelamentosComErro = 0;
                let cancelamentoBloqueado = false;
                let confirmouGrupoNestaRodada = false;

                // TRAVA DETERMINISTICA para agendamento de MULTIPLAS PESSOAS: se a conversa menciona
                // uma terceira pessoa (pai, mae, esposa, filho, etc) e o modelo tenta criar DOIS
                // agendamentos usando o MESMO nome (em vez de pedir o nome da outra pessoa), isso e
                // um erro grave ja visto acontecer — o agendamento do "pai" acaba sendo criado com o
                // nome do proprio cliente. Bloqueia a segunda chamada repetida em vez de deixar passar.
                const REGEX_TERCEIRO = /\bmeu pai\b|\bminha mae\b|\bmeu filho\b|\bminha filha\b|\bminha esposa\b|\bmeu marido\b|\bminha mulher\b|\bmeu irmao\b|\bminha irma\b|\bmeu namorado\b|\bminha namorada\b/i;
                const nomesCriadosNestaRodada = new Set();

                for (const tc of msg.tool_calls) {
                    const input = JSON.parse(tc.function.arguments);
                    console.log(`[ai] Tool: ${tc.function.name}`, JSON.stringify(input).substring(0, 120));

        // TRAVA DETERMINISTICA MAIS IMPORTANTE — criar_agendamento SEMPRE usa os dados do
        // ESTADO (data, horario, barbeiro, servicos), nunca o que o modelo decidiu passar por
        // conta propria. As ferramentas de CONSULTA ja tinham essa protecao (injecao acima);
        // criar_agendamento NAO tinha nenhuma — o modelo podia (e ja aconteceu) chamar a
        // ferramenta com um servico_ids DIFERENTE do que foi realmente mostrado/validado ao
        // cliente (ex: confundir "corte + sobrancelha" com um combo do catalogo que tambem
        // inclui barba), criando o agendamento errado ou fazendo-o "sumir" por falta de
        // horario compativel com a duracao errada. So sobrescreve quando o ESTADO realmente
        // tem o dado (nunca troca por null/vazio o que o modelo mandou).
        if (tc.function.name === 'criar_agendamento') {
            const selecaoPendente = obterSelecaoPendenteAtual(estado);
            if (estado.multiAgendamento && selecaoPendente) {
                input.data = selecaoPendente.data;
                input.hora = selecaoPendente.hora;
                input.barbeiro_id = selecaoPendente.barbeiro_id;
                input.servico_ids = [...selecaoPendente.servico_ids];
                delete input.servico_id;
            } else {
                if (estado.data) input.data = estado.data;
                if (estado.horarioEscolhido) input.hora = estado.horarioEscolhido;
                if (estado.barbeiro_id) input.barbeiro_id = estado.barbeiro_id;
                if (estado.servico_ids.length > 0) {
                    input.servico_ids = estado.servico_ids;
                    delete input.servico_id;
                }
            }
        }
        // TRAVA DETERMINISTICA: nome/telefone da ferramenta SEMPRE vem do ESTADO validado,
        // nunca do que o modelo decidiu passar — ja aconteceu de o modelo inventar um
        // placeholder ("Cliente", "Ainda nao informado") em vez de deixar vazio, fazendo a
        // busca no banco nao encontrar nada mesmo quando o agendamento existe.
        if (tc.function.name === 'buscar_agendamento' || tc.function.name === 'cancelar_agendamento') {
            input.nome = estado.nome || null;
            input.telefone = estado.telefone || input.telefone || null;
            if (tc.function.name === 'cancelar_agendamento' && estado.reagendamentoEmAndamento && estado.reagendamentoAlvo?.id) {
                input.agendamento_id = estado.reagendamentoAlvo.id;
                delete input.agendamento_ids;
            }
        }
        if (tc.function.name === 'criar_agendamento') {
            // MESMA TRAVA, mais estrita: nome/telefone SEMPRE vem do estado, SEM fallback
            // para o que o modelo passou — ja aconteceu do modelo criar um agendamento (ex:
            // do "pai" numa conversa com 2 pessoas) usando o nome/telefone da PRIMEIRA
            // pessoa, porque o estado ja tinha limpado esses campos mas o modelo simplesmente
            // reaproveitou o valor antigo da conversa em vez de perguntar de novo. Sem
            // fallback: se estado.nome/telefone ainda nao sao conhecidos, o agendamento fica
            // bloqueado (a validacao de nome/telefone do executarTool rejeita null/vazio) ate
            // a pessoa CERTA ser informada.
            input.nome = estado.nome || null;
            input.telefone = estado.telefone || null;
        }
        // TRAVA DETERMINISTICA: o modelo pode OMITIR servico_ids/barbeiro_id/servico_id
        // mesmo quando ja conhecidos pelo ESTADO — isso fazia a disponibilidade vir sem
        // filtro nenhum (ex: todos os servicos do barbeiro, nao so o pedido), contaminando
        // a resposta com horarios de OUTRO servico e levando a respostas contraditorias
        // ("13:00 esta ocupado" quando na verdade estava livre para o servico certo).
        // Preenche a partir do ESTADO sempre que o modelo deixar de passar.
        if (tc.function.name === 'verificar_disponibilidade_todos') {
            // (v4.2.3) Quando ha um plano por pessoa confiavel (capturado uma vez, ver acima),
            // FORCA o servico_ids da pessoa ATUAL — nao so preenche se vier vazio. Antes disso,
            // se o modelo decidisse por conta propria misturar servicos de pessoas diferentes
            // numa chamada (ja aconteceu: corte do filho + combo do marido virando um unico
            // item [1,7]), nada corrigia, porque essa checagem so agia quando o modelo mandava
            // servico_ids VAZIO — um valor errado mas nao-vazio passava direto.
            const pessoaAtualDisp = (estado.multiAgendamento && estado.pessoasPlano.length > 0)
                ? estado.pessoasPlano[obterIndicePessoaAtual(estado)] : null;
            if (pessoaAtualDisp && Array.isArray(pessoaAtualDisp.servico_ids) && pessoaAtualDisp.servico_ids.length > 0) {
                input.servico_ids = [...pessoaAtualDisp.servico_ids];
            } else if ((!Array.isArray(input.servico_ids) || input.servico_ids.length === 0) && estado.servico_ids.length > 0) {
                input.servico_ids = estado.servico_ids;
            }
            // (melhoria) Se o cliente ja especificou um barbeiro para ESTE agendamento (estado.barbeiro_id),
            // forca esse filtro na consulta — sem isso a ferramenta sempre trazia TODOS os barbeiros de
            // volta, mesmo quando so um foi pedido, obrigando o modelo a filtrar "na mao" (e as vezes
            // vazando horario de outro barbeiro que o cliente nem pediu). Em multi-agendamento, cada
            // pessoa pode ter pedido um barbeiro diferente — usa o barbeiro ja resolvido para a pessoa
            // ATUAL da vez (proximaPessoa/estado.barbeiro_id ja e recalculado por pessoa em outro ponto),
            // nunca o barbeiro de uma pessoa ja concluida.
            if (!input.barbeiro_id && estado.barbeiro_id) {
                input.barbeiro_id = estado.barbeiro_id;
            }
        }
        if (tc.function.name === 'verificar_disponibilidade') {
            if (!input.barbeiro_id && estado.barbeiro_id) input.barbeiro_id = estado.barbeiro_id;
            if (!input.servico_id && estado.servico_ids.length === 1) input.servico_id = estado.servico_ids[0];
        }
        if (tc.function.name === 'buscar_proximo_horario') {
            if (!input.barbeiro_id && estado.barbeiro_id) input.barbeiro_id = estado.barbeiro_id;
            const pessoaAtualProx = (estado.multiAgendamento && estado.pessoasPlano.length > 0)
                ? estado.pessoasPlano[obterIndicePessoaAtual(estado)] : null;
            if (pessoaAtualProx && Array.isArray(pessoaAtualProx.servico_ids) && pessoaAtualProx.servico_ids.length > 0) {
                input.servico_ids = [...pessoaAtualProx.servico_ids];
            } else if ((!Array.isArray(input.servico_ids) || input.servico_ids.length === 0) && estado.servico_ids.length > 0) {
                input.servico_ids = estado.servico_ids;
            }
        }

                    let resultado;
                    if (tc.function.name === 'criar_agendamento' && estado.multiAgendamento && estado.selecoesGrupo.length < estado.totalAgendamentos) {
                        registrarSelecaoGrupoUmaVezPorMensagem(estado, mensagem, catalogoBarbeiros);
                    }
                    if (tc.function.name === 'criar_agendamento' && estado.multiAgendamento && estado.selecoesGrupo.length < estado.totalAgendamentos) {
                        // (fix) Antes so dizia "continue coletando os horarios restantes" — mas nada
                        // impedia o modelo de simplesmente SUGERIR de memoria um horario pra proxima
                        // pessoa (ex: "temos 18:30 disponivel") sem checar se esse horario realmente
                        // ainda esta livre DEPOIS do horario que a pessoa anterior do grupo acabou de
                        // escolher — dois horarios so 15min diferentes podem se sobrepor se o servico
                        // dura 30min, e so consultando de novo (com os pendentes) isso e detectado.
                        // Ja aconteceu de isso resultar num horario oferecido que colidia e nem podia
                        // ser criado de verdade. Agora exige explicitamente uma nova consulta.
                        resultado = JSON.stringify({ erro: 'BLOQUEADO: ainda faltam escolher os horarios de todas as pessoas do grupo antes de registrar os agendamentos. NAO sugira um horario para a proxima pessoa de memoria/pela lista antiga que voce ja mostrou — o horario escolhido pela pessoa anterior pode ter ocupado um bloco de varios minutos (duracao do servico) que sobrepoe horarios vizinhos. Chame verificar_disponibilidade_todos (ou verificar_disponibilidade) DE NOVO agora para o servico/barbeiro/data da PROXIMA pessoa antes de sugerir qualquer horario a ela — isso ja leva em conta automaticamente os horarios que as pessoas anteriores do grupo acabaram de escolher (mesmo ainda nao salvos no banco). So depois disso, pergunte o horario para a proxima pessoa.' });
                    } else if (tc.function.name === 'criar_agendamento' && !estado.multiAgendamento && REGEX_TERCEIRO.test(textoConversaAtual) &&
                        nomesCriadosNestaRodada.has((input.nome || '').trim().toLowerCase())) {
                        resultado = JSON.stringify({ erro: 'BLOQUEADO: a conversa menciona mais de uma pessoa (ex: "meu pai"), mas este agendamento esta usando o MESMO nome de um agendamento ja criado nesta mesma rodada. E PROIBIDO usar o mesmo nome para pessoas diferentes. Pergunte ao cliente o NOME COMPLETO REAL da outra pessoa (pai/mae/esposa/etc) antes de criar este agendamento — NAO reutilize o nome de quem esta escrevendo.' });
                    } else {
                        resultado = await executarTool(tc.function.name, input, phone, numeroConfiavel, textoConversaAtual, estado);
                        if (tc.function.name === 'criar_agendamento') {
                            try {
                                const parsedCheck = JSON.parse(resultado);
                                if (parsedCheck.id || (Array.isArray(parsedCheck.ids) && parsedCheck.ids.length > 0)) {
                                    nomesCriadosNestaRodada.add((input.nome || '').trim().toLowerCase());
                                }
                            } catch {}
                        }
                    }
                    console.log(`[ai] Resultado: ${resultado.substring(0, 120)}`);
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: resultado });
                    if (tc.function.name === 'verificar_disponibilidade') {
                        // Mesmo tratamento de periodo/horario que verificar_disponibilidade_todos —
                        // sem isso, quando o barbeiro ja e conhecido (citado pelo cliente ou
                        // auto-atribuido por ser o unico compativel), o bot pulava direto para a
                        // lista COMPLETA de horarios sem antes perguntar o periodo, mesmo quando o
                        // cliente nao informou nenhum horario/periodo. Normaliza o resultado no
                        // MESMO formato de verificar_disponibilidade_todos (array de 1 barbeiro)
                        // para reaproveitar toda a logica de periodo ja existente, sem duplicar.
                        ultimaDataConsultada = input.data || null;
                        try {
                            const parsed = JSON.parse(resultado);
                            if (parsed && Array.isArray(parsed.horarios) && parsed.horarios.length > 0 && parsed.servico) {
                                verificouDisponibilidade = true;
                                dadosDisponibilidade = [{
                                    barbeiro_id: Number(input.barbeiro_id),
                                    barbeiro_nome: catalogoBarbeiros.get(Number(input.barbeiro_id)) || '',
                                    servicos: [{
                                        servico_id: parsed.servico.id, servico_nome: parsed.servico.nome,
                                        duracao: parsed.servico.duracao, preco: parsed.servico.preco,
                                        precoVariavel: parsed.servico.precoVariavel, horarios: parsed.horarios
                                    }]
                                }];
                            } else if (input.data) {
                                // (fix) nenhum horario retornado para a data pedida — guarda para
                                // avisar o cliente caso o proximo passo seja buscar_proximo_horario
                                dataUltimaConsultaSemVaga = input.data;
                            }
                        } catch {}
                    }
                    if (tc.function.name === 'verificar_disponibilidade_todos') {
                        ultimaDataConsultada = input.data || null;
                        try {
                            const parsed = JSON.parse(resultado);
                            if (Array.isArray(parsed) && parsed.length > 0) {
                                verificouDisponibilidade = true;
                                dadosDisponibilidade = parsed;
                            } else if (input.data) {
                                // (fix) mesma logica acima: data pedida sem NENHUM horario disponivel
                                dataUltimaConsultaSemVaga = input.data;
                            }
                        } catch {}
                    }
                    if (tc.function.name === 'buscar_proximo_horario') {
                        try {
                            const parsed = JSON.parse(resultado);
                            if (parsed && parsed.data && Array.isArray(parsed.disponibilidade)) {
                                proximoHorarioEncontrado = parsed;
                                // reaproveita o mesmo pipeline de periodo que verificar_disponibilidade_todos
                                // usa — sem isso, o proximo-dia-disponivel sempre despejava TODOS os
                                // horarios de uma vez, sem nunca perguntar manha/tarde/noite antes.
                                ultimaDataConsultada = parsed.data;
                                verificouDisponibilidade = true;
                                dadosDisponibilidade = parsed.disponibilidade;
                            } else {
                                proximoHorarioVazio = true;
                            }
                        } catch { proximoHorarioVazio = true; }
                    }
                    if (tc.function.name === 'listar_barbeiros_servicos') {
                        listouServicos = true;
                        try { catalogoListado = JSON.parse(resultado); } catch {}
                    }
                    if (tc.function.name === 'buscar_info_barbearia') buscouInfoBarbearia = true;
                    if (tc.function.name === 'buscar_respostas_bot') buscouRespostas = true;
                    if (tc.function.name === 'buscar_agendamento') {
                        try {
                            const parsed = JSON.parse(resultado);
                            if (Array.isArray(parsed.agendamentos) && parsed.agendamentos.length > 0) {
                                agendamentosEncontrados = parsed.agendamentos;
                                // Persiste os IDs REAIS no estado — sobrevivem aos proximos turnos
                                estado.mapaAgendamentos = parsed.agendamentos.map((ag, index) => ({
                                    posicao: index + 1,
                                    id: ag.id,
                                    data: ag.data,
                                    hora: ag.hora,
                                    diaSemana: ag.diaSemana,
                                    barbeiro: ag.barbeiro,
                                    servico: ag.servico,
                                    resumo: `${ag.diaSemana} ${ag.data} as ${ag.hora}, ${ag.servico}, ${ag.barbeiro}`
                                }));
                            } else {
                                buscouAgendamentoVazio = true;
                            }
                        } catch {}
                    }
                    if (tc.function.name === 'criar_agendamento') {
                        try {
                            const parsed = JSON.parse(resultado);
                            if (parsed.id || (Array.isArray(parsed.ids) && parsed.ids.length > 0)) {
                                agendamentosCriados++;
                                if (estado.reagendamentoEmAndamento) estado._novoReagendamentoCriadoNestaRodada = true;
                                // Guarda os dados EXATOS retornados pela ferramenta para injetar
                                // literalmente na instrucao de confirmacao — o modelo ja hallucinou
                                // dados diferentes do que foi realmente salvo (ex: horario/barbeiro
                                // que o cliente PEDIU em vez do que foi de fato criado no banco).
                                const precoTxt = (v, variavel) => `R$ ${Number(v).toFixed(2).replace('.', ',')}${variavel ? ' (a partir de)' : ''}`;
                                // (fix) MESMA CAUSA-RAIZ dos bugs de servico misturado: estado.servico_ids
                                // e estado.barbeiro_id sao campos GENERICOS de "valor atual", que ficam
                                // desatualizados assim que ha mais de uma pessoa no grupo (podem guardar o
                                // servico/barbeiro de OUTRA pessoa da mesma conversa). Usa input.servico_ids
                                // e input.barbeiro_id, que sao os valores REAIS ja validados e usados NESTA
                                // chamada especifica de criar_agendamento — essencial para o comando "quero
                                // o mesmo" nao reaproveitar o servico/barbeiro da pessoa errada depois.
                                if (Array.isArray(parsed.ids)) {
                                    agendamentosCriadosDados.push(`Cliente: ${parsed.nomeCliente} | Data: ${parsed.diaSemana}, ${parsed.data} | Horario: ${parsed.hora} | Barbeiro: ${parsed.barbeiro} | Servico: ${parsed.servicoCombinado} | Valor: ${precoTxt(parsed.precoTotal, parsed.precoVariavel)}`);
                                    ultimoAgendamentoConfirmadoRodada = {
                                        servico_ids: Array.isArray(input.servico_ids) ? [...input.servico_ids] : [],
                                        servico_nomes: String(parsed.servicoCombinado || '').split(' + ').filter(Boolean),
                                        horario: parsed.hora,
                                        barbeiro_id: input.barbeiro_id,
                                        barbeiro_nome: parsed.barbeiro,
                                        data: input.data
                                    };
                                } else {
                                    agendamentosCriadosDados.push(`Cliente: ${parsed.nomeCliente} | Data: ${parsed.diaSemana}, ${parsed.data} | Horario: ${parsed.hora} | Barbeiro: ${parsed.barbeiro} | Servico: ${parsed.servico} | Valor: ${precoTxt(parsed.preco, parsed.precoVariavel)}`);
                                    ultimoAgendamentoConfirmadoRodada = {
                                        servico_ids: Array.isArray(input.servico_ids) ? [...input.servico_ids] : [],
                                        servico_nomes: [parsed.servico].filter(Boolean),
                                        horario: parsed.hora,
                                        barbeiro_id: input.barbeiro_id,
                                        barbeiro_nome: parsed.barbeiro,
                                        data: input.data
                                    };
                                }
                                if (Array.isArray(parsed.avisoAgendamentosExistentes) && parsed.avisoAgendamentosExistentes.length > 0) {
                                    avisoAgendamentosExistentesDetectado = true;
                                }
                                agendamentosCriadosClientes.push({ nome: parsed.nomeCliente, telefone: input.telefone });
                                if (Array.isArray(parsed.ids)) agendamentosCriadosIds.push(...parsed.ids);
                                else if (parsed.id) agendamentosCriadosIds.push(parsed.id);
                            } else if (typeof parsed.erro === 'string' && parsed.erro.startsWith('DUPLICADO')) {
                                agendamentoDuplicado = true;
                            } else {
                                agendamentosComErro++;
                            }
                        } catch { agendamentosComErro++; }
                    }
                    if (tc.function.name === 'cancelar_agendamento') {
                        try {
                            const parsed = JSON.parse(resultado);
                            if (parsed.multiplos) {
                                cancelamentosSucesso += parsed.cancelados.length;
                                cancelamentosComErro += parsed.comErro.length;
                            } else if (parsed.cancelado === true) {
                                cancelamentosSucesso++;
                            } else if (typeof parsed.erro === 'string' && parsed.erro.startsWith('BLOQUEADO')) {
                                // Bloqueio intencional (trava deterministica) — o cliente NAO pediu
                                // para cancelar, entao isso NAO e uma falha real de cancelamento.
                                cancelamentoBloqueado = true;
                            } else {
                                cancelamentosComErro++;
                            }
                        } catch { cancelamentosComErro++; }
                    }
                }
                if (agendamentoDuplicado) {
                    messages.push({ role: 'user', content: '[SISTEMA] Uma das chamadas de criar_agendamento retornou "DUPLICADO" — significa que esse agendamento especifico JA EXISTE (foi criado momentos antes nesta mesma conversa), NAO e uma falha e NAO precisa ser recriado. NAO diga que o horario esta ocupado, NAO peca outro horario para essa pessoa/servico — apenas confirme normalmente usando o FORMATO PADRAO, com os dados do agendamento existente informados no proprio retorno da ferramenta.' });
                }
                // (v3.32.3) Apos confirmar, busca se o mesmo cliente (nome+telefone) tem OUTROS
                // agendamentos futuros ja marcados (de uma conversa anterior, por exemplo) — se
                // tiver, avisa o cliente na mesma resposta, em vez de deixar ele descobrir sozinho.
                if (agendamentosCriadosClientes.length > 0) {
                    const ultimoCliente = agendamentosCriadosClientes[agendamentosCriadosClientes.length - 1];
                    if (ultimoCliente.nome && ultimoCliente.telefone) {
                        try {
                            const outros = await db.buscarAgendamento(ultimoCliente.telefone, ultimoCliente.nome);
                            const outrosFiltrados = (outros.agendamentos || []).filter(ag => !agendamentosCriadosIds.includes(ag.id));
                            if (outrosFiltrados.length > 0) {
                                const listaOutros = outrosFiltrados.map(ag => `${ag.diaSemana}, ${ag.data} as ${ag.hora} — ${ag.servico} com ${ag.barbeiro}`).join(' | ');
                                messages.push({ role: 'user', content: `[SISTEMA] Este cliente (${ultimoCliente.nome}) TAMBEM tem outro(s) agendamento(s) futuro(s) ja confirmado(s), alem deste que acabou de ser criado: ${listaOutros}. Depois de confirmar o agendamento no FORMATO PADRAO, mencione esses outros agendamentos numa frase curta (ex: "a proposito, voce tambem tem um agendamento marcado para..."), sem repetir o FORMATO PADRAO completo para eles.` });
                            }
                        } catch (e) { /* nao bloqueia a confirmacao se essa busca extra falhar */ }
                    }
                }
                // ===== Atualiza o ESTADO com o resultado REAL desta rodada =====
                if (agendamentosCriados > 0) {
                    for (const d of agendamentosCriadosDados) estado.criadosNestaConversa.push(d);
                    if (estado.criadosNestaConversa.length > 5) estado.criadosNestaConversa = estado.criadosNestaConversa.slice(-5);
                    if (ultimoAgendamentoConfirmadoRodada) estado.ultimoAgendamentoConfirmado = ultimoAgendamentoConfirmadoRodada;
                    if (estado.reagendamentoEmAndamento && estado.reagendamentoAlvo && cancelamentosSucesso === 0) {
                        messages.push({ role: 'user', content: `[SISTEMA] REAGENDAMENTO: o novo horario ja foi criado, mas o processo AINDA NAO terminou porque falta cancelar o agendamento antigo selecionado (id ${estado.reagendamentoAlvo.id}). NAO responda ao cliente ainda. Chame cancelar_agendamento AGORA usando esse id real e o mesmo nome/telefone ja informados.` });
                        forcarCancelarNaProximaIteracao = true;
                    }
                    if (estado.reagendamentoEmAndamento && cancelamentosSucesso > 0) {
                        estado.reagendamentoEmAndamento = false;
                        estado.reagendamentoAlvo = null;
                    }
                    // Pedido concluido: limpa os filtros do fluxo EM CODIGO — impossivel reaproveitar
                    // barbeiro/servico de um assunto encerrado num pedido novo por engano
                    estado.periodo = null; estado.horarioMinimo = null; estado.horarioMaximo = null;
                    estado.horarioEscolhido = null; estado.barbeiro_id = null; estado.servico_ids = [];
                    estado.mapaAgendamentos = null; // desatualizado apos criar — rebusca se precisar
                    
                    // ===== FLUXO SEQUENCIAL MULTI-AGENDAMENTO (v4.0 - simplificado) =====
                    // Em multi-agendamento, o contato agora e pedido uma unica vez e reaproveitado
                    // para todos os agendamentos do grupo. Em agendamento simples, continua limpando.
                    if (!estado.multiAgendamento && !estado.reagendamentoEmAndamento) {
                        estado.nome = null;
                        estado.telefone = null;
                    }
                    
                    // Se e multi-agendamento, incrementa contador e decide proximo passo
                    if (estado.multiAgendamento) {
                        estado.agendamentosCompletos++;
                        const faltamCriar = estado.selecoesGrupo.length - estado.agendamentosCompletos;

                        if (faltamCriar > 0) {
                            messages.push({
                                role: 'user',
                                content: `[SISTEMA] Ja existe contato informado e ainda faltam ${faltamCriar} agendamento(s) do mesmo grupo para salvar no banco. NAO responda nada ao cliente ainda e NAO peca mais dados: apenas continue chamando criar_agendamento para os proximos itens ja escolhidos em estado.selecoesGrupo, um por vez, ate finalizar todos.`
                            });
                            forcarCriarNaProximaIteracao = true;
                            console.log(`[ai] Multi-agendamento: ${estado.agendamentosCompletos}/${estado.selecoesGrupo.length} salvos — continuando criacao em lote`);
                        } else {
                            // Todos completos — mostra resumo final CONSOLIDADO (unica
                            // confirmacao visual de todo o grupo, incluindo o ultimo agendamento
                            // que acabou de ser criado nesta mesma chamada)
                            confirmouGrupoNestaRodada = true;
                            messages.push({
                                role: 'user',
                                content: `[SISTEMA] ✅ TODOS os ${estado.totalAgendamentos} agendamentos do grupo foram criados com sucesso no banco de dados (incluindo o que acabou de ser confirmado agora).

Esta e a UNICA mensagem de confirmacao visual do grupo inteiro — nenhum dos agendamentos anteriores mostrou confirmacao individual, entao mostre TODOS agora, juntos, nesta ordem, usando estado.criadosNestaConversa como fonte dos dados exatos (nome, data, horario, barbeiro, servico, valor) de CADA um:

✅ Agendamentos confirmados

[para cada agendamento em estado.criadosNestaConversa, um bloco assim, na mesma ordem em que foram criados:]
🙋 [nome do cliente]
📅 Data: [dia da semana], [data]
🕐 Horario: [hora]
👤 Barbeiro: [barbeiro]
✂️ Servico(s): [servico(s) — no singular "Servico" se for so 1, plural "Servicos" se for combo]
💰 Valor: [valor] (ou "Valor total" se for combo de mais de 1 servico)

Depois de listar TODOS os blocos acima, acrescente uma linha unica (nao repita por pessoa): "🔔 Vamos te enviar um lembrete 24h antes de cada horario!". Finalize com uma unica linha amigavel de encerramento (ex: "Navalha's Barber Club aguarda voce! 💈"), UMA SO VEZ no final de tudo — nao repita isso para cada pessoa.`
                            });
                            // Reseta o modo multi-agendamento
                            estado.multiAgendamento = false;
                            estado.totalAgendamentos = 1;
                            estado.agendamentosCompletos = 0;
                            estado.pessoasPlano = [];
                            estado.selecoesGrupo = [];
                            estado.periodoGrupo = null;
                            estado.barbeiroGrupo = null;
                            console.log('[ai] Multi-agendamento completo — todos os agendamentos criados');
                        }
                    }
                }
                if (cancelamentosSucesso > 0) {
                    estado.mapaAgendamentos = null; // desatualizado apos cancelar
                    estado.horarioEscolhido = null;
                    if (!agendamentosCriados) {
                        estado.reagendamentoEmAndamento = false;
                        estado.reagendamentoAlvo = null;
                    }
                }

                // Lista com os dados EXATOS de cada agendamento realmente criado nesta rodada — o
                // modelo DEVE copiar esses valores literalmente na confirmacao. Isso existe porque
                // ja aconteceu do modelo confirmar um horario/barbeiro DIFERENTE do que foi de fato
                // gravado no banco (ex: repetiu o horario que o cliente pediu originalmente, mesmo
                // depois do sistema ter ajustado para outro horario/barbeiro por indisponibilidade).
                const continuandoCriacaoGrupo = estado.multiAgendamento && estado.selecoesGrupo.length > 0 && estado.agendamentosCompletos < estado.selecoesGrupo.length;
                // (fix) agendamentosCriados/cancelamentosSucesso sao zerados a CADA iteracao do loop
                // (uma por chamada de ferramenta do modelo) — mas no reagendamento, criar e cancelar
                // quase sempre acontecem em iteracoes SEPARADAS (trava do sistema forca criar primeiro,
                // so depois libera cancelar). Por isso "agendamentosCriados > 0 && cancelamentosSucesso > 0"
                // quase nunca era true na mesma iteracao, e o cancelamento (que sempre acontece por
                // ultimo) caia no fluxo de confirmacao de CANCELAMENTO em vez de REAGENDAMENTO. Usa o
                // flag persistente estado._novoReagendamentoCriadoNestaRodada (setado quando a criacao
                // aconteceu, sobrevive entre iteracoes desta mesma mensagem) para saber que a criacao
                // JA aconteceu antes, mesmo que nao tenha sido nesta iteracao especifica.
                const reagendamentoConcluidoNestaRodada = (agendamentosCriados > 0 || estado._novoReagendamentoCriadoNestaRodada) && cancelamentosSucesso > 0;
                const dadosExatosTxt = agendamentosCriadosDados.length > 0
                    ? `\nDADOS EXATOS de cada agendamento REALMENTE criado nesta rodada (copie EXATAMENTE estes valores na confirmacao — NUNCA use o horario/barbeiro que o cliente pediu originalmente se for diferente do que esta aqui, pois o sistema pode ter ajustado por indisponibilidade):\n${agendamentosCriadosDados.map((l, i) => `${i + 1}. ${l}`).join('\n')}`
                    : '';
                // (fix) Quando o reagendamento foi concluido mas a criacao aconteceu numa iteracao
                // ANTERIOR (agendamentosCriadosDados desta iteracao esta vazio), busca os dados exatos
                // do novo horario em estado.criadosNestaConversa (preenchido no momento da criacao e
                // persistente entre iteracoes) em vez de deixar a confirmacao sem dados exatos.
                const dadosExatosReagendamentoTxt = dadosExatosTxt || (reagendamentoConcluidoNestaRodada && estado.criadosNestaConversa.length > 0
                    ? `\nDADOS EXATOS do novo horario REALMENTE criado (copie EXATAMENTE estes valores na confirmacao):\n${estado.criadosNestaConversa[estado.criadosNestaConversa.length - 1]}`
                    : '');
                if (agendamentosComErro > 0) {
                    messages.push({ role: 'user', content: '[SISTEMA] ATENCAO: criar_agendamento retornou ERRO — o agendamento NAO foi salvo no banco de dados. E ABSOLUTAMENTE PROIBIDO mostrar a mensagem de confirmacao ("Agendamento confirmado"). Informe ao cliente o que falta (ex: pedir o sobrenome) de forma natural e simpatica, SEM usar as palavras "erro", "ocorreu um erro" ou qualquer variacao — apenas diga o que precisa (ex: "Preciso do seu nome completo, com sobrenome, para confirmar o agendamento."). IMPORTANTE: so diga que um horario esta ocupado/indisponivel se o campo "erro" da ferramenta contiver explicitamente "conflita" — qualquer outro erro (nome incompleto, servico invalido etc.) NAO significa horario ocupado.' });
                } else if (continuandoCriacaoGrupo) {
                    // Enquanto ainda faltam itens do grupo para salvar, o modelo deve seguir
                    // chamando criar_agendamento e ficar em silencio para o cliente.
                } else if (confirmouGrupoNestaRodada) {
                    // A confirmacao consolidada do multi-agendamento ja foi preparada acima.
                    // Nao injeta a confirmacao padrao nesta mesma rodada para nao competir com
                    // o resumo final e fazer o modelo omitir o primeiro agendamento do grupo.
                } else if (reagendamentoConcluidoNestaRodada) {
                    messages.push({ role: 'user', content: `[SISTEMA] REAGENDAMENTO CONCLUIDO: o horario antigo foi cancelado e o novo horario ja foi criado com sucesso. NAO mostre confirmacao separada de cancelamento nem confirmacao padrao de novo agendamento — o cliente NAO deve ver a palavra "cancelado" nem o FORMATO PADRAO de cancelamento. Mostre UMA UNICA mensagem usando EXATAMENTE o FORMATO PADRAO de reagendamento (que inclui o NOVO horario).${dadosExatosReagendamentoTxt}` });
                } else if (agendamentosCriados > 0 && avisoAgendamentosExistentesDetectado && (agendamentosEncontrados || buscouAgendamentoVazio)) {
                    // So mostra a VARIANTE B (aviso de agendamentos antigos) se buscar_agendamento
                    // TAMBEM foi chamado NESTA MESMA rodada — se nao foi, o aviso ja foi mostrado
                    // numa rodada anterior (PASSO 4.5 / VARIANTE A) e o cliente ja respondeu a ele,
                    // entao repetir aqui seria redundante e confuso.
                    messages.push({ role: 'user', content: `[SISTEMA] criar_agendamento retornou "id" — o NOVO agendamento JA FOI SALVO com sucesso no banco (isso ja aconteceu, nao e uma pergunta). O retorno tambem trouxe "avisoAgendamentosExistentes" — o cliente ja tinha outro(s) agendamento(s) marcado(s) ANTES deste. Use a VARIANTE B do formato de aviso: primeiro confirme o novo agendamento com o FORMATO PADRAO normal, depois informe os agendamentos ANTIGOS (que ja existiam) e pergunte se quer manter todos ou cancelar algum DELES (nao pergunte se quer "agendar" o novo — ele ja esta criado).${dadosExatosTxt}` });
                } else if (agendamentosCriados > 0) {
                    if (avisoAgendamentosExistentesDetectado) {
                        messages.push({ role: 'user', content: '[SISTEMA] criar_agendamento retornou "id" com "avisoAgendamentosExistentes", mas esse aviso JA FOI MOSTRADO ao cliente numa mensagem anterior (PASSO 4.5) e ele ja respondeu a ele. NAO repita o aviso de agendamentos antigos agora — mostre APENAS o FORMATO PADRAO normal de confirmacao do novo agendamento, sem mencionar os agendamentos antigos de novo.' });
                    }
                    messages.push({ role: 'user', content: `[SISTEMA] criar_agendamento retornou "id" — agendamento salvo com sucesso no banco. Agora confirme ao cliente usando o FORMATO PADRAO de confirmacao, palavra por palavra e emoji por emoji.${dadosExatosTxt}` });
                }
                if (cancelamentoBloqueado) {
                    messages.push({ role: 'user', content: '[SISTEMA] cancelar_agendamento foi BLOQUEADO de proposito pelo sistema (o cliente pediu para MANTER os agendamentos existentes, entao cancelar seria um erro grave). Isso NAO e uma falha e NAO deve ser mencionado ao cliente de forma alguma — nao diga que houve um "problema ao cancelar", nao peca para confirmar telefone, nao mencione cancelamento nenhum. Apenas continue normalmente confirmando/criando o NOVO agendamento, como se essa tentativa de cancelar nunca tivesse acontecido.' });
                } else if (cancelamentosComErro > 0 && cancelamentosSucesso === 0) {
                    messages.push({ role: 'user', content: '[SISTEMA] ATENCAO: cancelar_agendamento retornou ERRO ou "cancelado" nao veio true — o(s) agendamento(s) NAO foram cancelados no banco de dados. E ABSOLUTAMENTE PROIBIDO mostrar a mensagem de "Agendamento cancelado com sucesso". Informe ao cliente o problema (verifique o campo "erro" do retorno) — normalmente significa que o agendamento nao foi encontrado com o telefone informado, ou que o ID usado estava errado (nunca use o numero da posicao da lista como ID). Peca para confirmar o telefone e tente novamente chamando buscar_agendamento de novo para obter os IDs corretos.' });
                } else if (cancelamentosComErro > 0 && cancelamentosSucesso > 0) {
                    messages.push({ role: 'user', content: `[SISTEMA] cancelar_agendamento cancelou ${cancelamentosSucesso} agendamento(s) com sucesso, mas ${cancelamentosComErro} nao foi(ram) encontrado(s)/cancelado(s). Confirme ao cliente APENAS os que realmente foram cancelados (campo "cancelados" do retorno) usando o FORMATO PADRAO de cancelamento para cada um, e informe honestamente que o(s) outro(s) nao foi(ram) encontrado(s) para cancelar.` });
                } else if (cancelamentosSucesso > 0 && !agendamentosCriados && !reagendamentoConcluidoNestaRodada) {
                    messages.push({ role: 'user', content: '[SISTEMA] cancelar_agendamento retornou "cancelado": true — cancelamento confirmado e salvo no banco. Agora confirme ao cliente usando o FORMATO PADRAO de cancelamento, palavra por palavra e emoji por emoji, com os dados EXATOS retornados pela ferramenta (nao invente nem repita dados de mensagens anteriores).' });
                }
                // So dispara essa instrucao de fallback se, por algum motivo, o pipeline unificado
                // de periodo (verificouDisponibilidade) nao tiver assumido o caso — evita instrucoes
                // CONTRADITORIAS (uma mandando listar tudo, outra mandando perguntar o periodo).
                if (proximoHorarioEncontrado && !verificouDisponibilidade) {
                    messages.push({ role: 'user', content: `[SISTEMA] buscar_proximo_horario encontrou a PRIMEIRA data com vaga: ${proximoHorarioEncontrado.data} (${proximoHorarioEncontrado.diaSemana}). Apresente EXATAMENTE os horarios retornados no FORMATO PADRAO de disponibilidade, informando essa data e esse dia da semana exatos (NUNCA calcule o dia da semana por conta propria). NAO mencione barbeiros nem horarios fora do retorno. Termine perguntando se o cliente quer agendar um desses horarios.` });
                } else if (proximoHorarioVazio) {
                    messages.push({ role: 'user', content: '[SISTEMA] buscar_proximo_horario NAO encontrou vaga no periodo varrido. Informe o cliente com naturalidade, mencione que a barbearia tambem atende por ordem de chegada, e sugira falar direto com a barbearia.' });
                }
                if (verificouDisponibilidade) {
                    // Filtros vem do ESTADO mantido pelo codigo (classificados UMA vez por
                    // mensagem, antes do loop) — nada de re-deduzir a conversa aqui dentro.
                    let periodo = estado.periodo;
                    const horarioMinimo = estado.horarioMinimo;
                    const horarioMaximo = estado.horarioMaximo;
                    const horarioEscolhido = estado.horarioEscolhido;
                    let barbeiroId = estado.barbeiro_id;
                    const servicoIds = Array.isArray(estado.servico_ids) ? estado.servico_ids : [];
                    const servicoInformado = servicoIds.length > 0;
                    // Horario exato mencionado pelo cliente tem prioridade sobre o bloco generico de periodo
                    // horarioEscolhido tambem define o horario — sem isso, o bot re-perguntava o
                    // periodo mesmo com o cliente ja tendo dito "as 9h" (bug corrigido)
                    const temFiltroHorario = !!(horarioMinimo || horarioMaximo || horarioEscolhido);

                    // Calcula em CODIGO quais periodos (manha/tarde/noite) realmente tem ALGUM horario
                    // livre nesta data, olhando TODOS os horarios retornados (qualquer barbeiro/servico).
                    // Usado para nunca perguntar/oferecer um periodo que ja passou ou que nao tem nenhuma
                    // vaga — perguntar "prefere manha, tarde ou noite" quando so ha tarde disponivel
                    // (ex: manha ja passou ou esta lotada) so faz o cliente perder tempo.
                    const periodosComHorarios = new Set();
                    if (Array.isArray(dadosDisponibilidade)) {
                        for (const b of dadosDisponibilidade) {
                            for (const s of (b.servicos || [])) {
                                for (const h of (s.horarios || [])) {
                                    const [H, M] = h.split(':').map(Number);
                                    const min = H * 60 + M;
                                    if (min < 12 * 60) periodosComHorarios.add('manha');
                                    else if (min >= 13 * 60 && min < 18 * 60) periodosComHorarios.add('tarde');
                                    else if (min >= 18 * 60) periodosComHorarios.add('noite');
                                }
                            }
                        }
                    }
                    const listaPeriodosDisponiveis = ['manha', 'tarde', 'noite'].filter(p => periodosComHorarios.has(p));
                    const textoPeriodos = { manha: 'de manha', tarde: 'a tarde', noite: 'a noite' };
                    const periodoDefinido = periodo || temFiltroHorario;

                    const DEFINICAO_PERIODOS = 'DEFINICAO DE PERIODOS: manha = horarios ate 11:59; tarde = horarios de 13:00 ate 17:59; noite = horarios a partir das 18:00 (inclusive). Use essa definicao ao filtrar horarios. ';
                    // Dia da semana calculado no servidor — o modelo NUNCA deve calcular isso sozinho
                    const dataConsultada = ultimaDataConsultada;
                    const diaSemanaConsultado = dataConsultada ? db.nomeDiaSemanaPorData(dataConsultada) : null;
                    let instrucao = '[SISTEMA] Ha horarios disponiveis. IMPORTANTE: os dados retornados contem APENAS barbeiros com horarios disponiveis — NAO mencione barbeiros fora desses dados. ' + DEFINICAO_PERIODOS;
                    // (fix) Se esta apresentacao vem de buscar_proximo_horario porque a data que o
                    // cliente pediu originalmente NAO tinha nenhum horario, isso precisa ficar
                    // EXPLICITO na resposta — sem isso, o bot so mostra a data alternativa
                    // encontrada, dando a falsa impressao de que "entendeu errado" a data pedida
                    // (ex: cliente pede "amanha" = segunda, segunda esta sem vaga, bot pula pra
                    // terca sem nunca dizer que segunda nao tinha horario).
                    if (proximoHorarioEncontrado && dataUltimaConsultaSemVaga && dataUltimaConsultaSemVaga !== dataConsultada) {
                        const diaSemanaSemVaga = db.nomeDiaSemanaPorData(dataUltimaConsultaSemVaga);
                        instrucao += `ATENCAO: o cliente tinha pedido a data ${dataUltimaConsultaSemVaga} (${diaSemanaSemVaga}), mas essa data NAO TEM NENHUM horario disponivel para o servico/barbeiro pedido. Comece a resposta informando isso claramente (ex: "Nao temos horario disponivel para ${diaSemanaSemVaga}, ${dataUltimaConsultaSemVaga.split('-').reverse().slice(0,2).join('/')}..."), e SO DEPOIS apresente a proxima data com vaga (${dataConsultada}) como alternativa. NUNCA apresente a data alternativa como se fosse a resposta direta ao pedido original, sem deixar claro que houve essa troca. `;
                    }
                    if (diaSemanaConsultado) {
                        instrucao += `O dia da semana da data consultada (${dataConsultada}) e: ${diaSemanaConsultado}. Use SEMPRE esse valor exato ao montar "[dia da semana, dd/mm]" — NUNCA calcule por conta propria. `;
                    }
                    // Filtragem feita em CODIGO — a IA ja recebe a lista exata pronta,
                    // pois filtrar numericamente pelo modelo omite horarios (ex: pular slots apos um bloco ocupado).
                    // Horario exato (horarioMinimo/horarioMaximo) tem prioridade sobre o bloco generico de periodo,
                    // pois e mais preciso — ex: "depois das 17h" deve incluir 17:30, que o bloco "noite" excluiria.
                    // (fix) Em agendamento de MULTIPLAS pessoas, a grade de 15 em 15 minutos usada
                    // para 1 pessoa so e enganosa: se o cliente ve 18:00, 18:15 e 18:30 pra ele e
                    // escolhe 18:15 (30min de servico = ocupa 18:15-18:45), o horario da PROXIMA
                    // pessoa do grupo com o mesmo barbeiro fica espremido/sem opcao imediata, mesmo
                    // a lista ORIGINAL "parecendo" ter espaco de sobra. Por isso, ao oferecer horarios
                    // durante um multiAgendamento, espaca as opcoes pela duracao real do servico (ex:
                    // 18:00, 18:30, 19:00...) — garante que, seja qual for a opcao escolhida por esta
                    // pessoa, sobra um bloco inteiro livre logo em seguida para a proxima do grupo.
                    const espacarPorDuracao = (horarios, duracaoMinutos) => {
                        if (!duracaoMinutos) return horarios;
                        const ordenados = [...horarios].sort();
                        const resultado = [];
                        let ultimoMin = -Infinity;
                        for (const h of ordenados) {
                            const [H, M] = h.split(':').map(Number);
                            const min = H * 60 + M;
                            if (min - ultimoMin >= duracaoMinutos) {
                                resultado.push(h);
                                ultimoMin = min;
                            }
                        }
                        return resultado;
                    };
                    const filtrarPorPeriodo = (horarios) => horarios.filter(h => {
                        const [H, M] = h.split(':').map(Number);
                        const min = H * 60 + M;
                        if (temFiltroHorario) {
                            // Escolha exata sem intervalo: mostra APENAS o horario escolhido
                        if (horarioEscolhido && !horarioMinimo && !horarioMaximo) return h === horarioEscolhido;
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
                    });
                    // (fix) Formata os horarios reais ja encontrados por buscarProximoHorario (ja filtrados
                    // pelo periodo pedido) para o modelo poder OFERECER a data seguinte com a lista exata
                    // de horarios de uma vez — em vez de so citar a data e obrigar outra rodada de pergunta/
                    // resposta (era exatamente isso que fazia o cliente ter que "ir tentando" data por data).
                    const resumoProximaOpcao = (proximaOpcao) => {
                        if (!proximaOpcao || !Array.isArray(proximaOpcao.disponibilidade)) return '';
                        const linhas = [];
                        for (const b of proximaOpcao.disponibilidade) {
                            for (const s of (b.servicos || [])) {
                                if (Array.isArray(s.horarios) && s.horarios.length > 0) {
                                    linhas.push(`${b.barbeiro_nome} — ${s.servico_nome}: ${s.horarios.join(', ')}`);
                                }
                            }
                        }
                        return linhas.length > 0 ? `\nHorarios EXATOS disponiveis nessa data (${descricaoFiltro}) — apresente-os direto ao cliente no FORMATO PADRAO de disponibilidade, sem precisar de outra consulta:\n${linhas.join('\n')}` : '';
                    };
                    const descricaoFiltro = (horarioEscolhido && !horarioMinimo && !horarioMaximo)
                        ? `as ${horarioEscolhido}`
                        : temFiltroHorario
                        ? [horarioMinimo ? `a partir de ${horarioMinimo}` : null, horarioMaximo ? `ate ${horarioMaximo}` : null].filter(Boolean).join(' e ')
                        : periodo;

                    // NUNCA perguntar preferencia de barbeiro: sem barbeiro citado = mostrar todos.
                    // Para exibir horarios, basta ter SERVICO + (PERIODO ou horario exato) definidos.
                    instrucao += 'NUNCA pergunte se o cliente tem preferencia de barbeiro. ';
                    if (periodoDefinido && servicoInformado) {
                        // Combinar servicos e restringir a lista aos IDs pedidos e feito 100% em CODIGO —
                        // nunca depende do modelo lembrar de chamar a ferramenta com os IDs certos.
                        const multiplosServicos = servicoIds.length > 1;
                        
                        // Em multi-agendamento, prepara agendamentos pendentes para bloquear horarios
                        let agendamentosPendentes = [];
                        if (estado.multiAgendamento && estado.selecoesGrupo.length > 0) {
                            const catalogoServicos = await db.listarTodosServicosAtivos();
                            const mapaDuracoes = new Map(catalogoServicos.map(s => [Number(s.id), s.duracao]));
                            
                            agendamentosPendentes = estado.selecoesGrupo.map(sel => {
                                const duracaoTotal = sel.servico_ids.reduce((soma, id) => soma + (mapaDuracoes.get(Number(id)) || 0), 0);
                                return {
                                    barbeiro_id: sel.barbeiro_id,
                                    data: sel.data,
                                    hora: sel.hora,
                                    duracao: duracaoTotal
                                };
                            });
                        }
                        
                        // (v3.32) fluxo simplificado: no multi-pessoa o atendimento e sempre
                        // sequencial por pessoa (servico -> data -> horario -> nome/telefone -> cria),
                        // sem fila paralela de slots coletados.
                        const dadosParaLinhas = multiplosServicos
                            ? await db.verificarDisponibilidadeTodos(dataConsultada, servicoIds, agendamentosPendentes, estado.barbeiro_id || null)
                            : dadosDisponibilidade;

                        // AUTO-SELECAO DE BARBEIRO UNICO: se so ha 1 barbeiro com horarios disponiveis
                        // e o cliente nao especificou barbeiro, seleciona automaticamente. Precisa
                        // acontecer ANTES da checagem de horario exato abaixo — senao, um cliente que
                        // da um horario exato sem citar barbeiro (ex: "as 15h") nunca cai no fast-path
                        // de "horario ja escolhido, pula pro cadastro", mesmo havendo um unico barbeiro
                        // com aquele horario livre (bug corrigido).
                        const barbeirosComHorarioPreCheck = Array.isArray(dadosParaLinhas)
                            ? dadosParaLinhas.filter(b => (b.servicos || []).some(s => (s.horarios || []).length > 0)).length
                            : 0;
                        if (barbeirosComHorarioPreCheck === 1 && !barbeiroId && Array.isArray(dadosParaLinhas)) {
                            const barbeiroUnicoPreCheck = dadosParaLinhas.find(b => (b.servicos || []).some(s => (s.horarios || []).length > 0));
                            if (barbeiroUnicoPreCheck) {
                                barbeiroId = Number(barbeiroUnicoPreCheck.barbeiro_id);
                                estado.barbeiro_id = barbeiroId;
                                console.log(`[ai] Auto-selecao (pre-check horario exato): unico barbeiro disponivel (${barbeiroUnicoPreCheck.barbeiro_nome}, id ${barbeiroUnicoPreCheck.barbeiro_id})`);
                            }
                        }

                        // Se o cliente ja ESCOLHEU um horario exato (nao apenas um filtro de intervalo/
                        // periodo), confere se esse horario realmente existe na disponibilidade real —
                        // se sim, pula a listagem/pergunta e confirma a escolha direto, avancando para a
                        // coleta de nome/telefone. Evita o bot re-perguntar "qual horario prefere" quando
                        // o cliente ja respondeu isso na mesma mensagem (ex: "as 8 com fab").
                        let horarioEscolhidoValido = false;
                        if (horarioEscolhido && barbeiroId && Array.isArray(dadosParaLinhas)) {
                            const bEscolhido = dadosParaLinhas.find(b => Number(b.barbeiro_id) === barbeiroId);
                            if (bEscolhido) {
                                for (const s of (bEscolhido.servicos || [])) {
                                    if (!multiplosServicos && s.servico_id && !servicoIds.includes(s.servico_id)) continue;
                                    if ((s.horarios || []).includes(horarioEscolhido)) { horarioEscolhidoValido = true; break; }
                                }
                            }
                        }

                        if (horarioEscolhidoValido) {
                        const horarioParaTexto = horarioEscolhido;
                        const barbeiroIdParaTexto = barbeiroId;
                        if (estado.multiAgendamento) {
                            const indiceAtualGrupo = obterIndicePessoaAtual(estado);
                            const pessoaAtualGrupo = estado.pessoasPlano[indiceAtualGrupo] || null;
                            if (estado.selecoesGrupo.length === indiceAtualGrupo) {
                                estado.selecoesGrupo.push({
                                    data: dataConsultada,
                                    hora: horarioParaTexto,
                                    barbeiro_id: barbeiroIdParaTexto,
                                    servico_ids: [...servicoIds],
                                    papel: pessoaAtualGrupo ? pessoaAtualGrupo.papel : null,
                                });
                            }
                            // Preserve global date/period filters across the group: if the client already
                            // specified dia/periodo para o grupo, essa preferencia deve ser reaproveitada
                            // para o proximo agendamento do grupo. Limpa apenas o horario exacto/barbeiro
                            // escolhidos do item anterior para que cada pessoa escolha seu proprio horario.
                            estado.horarioEscolhido = null;
                            // (fix) mesma logica do outro caminho: so restaura contexto da "proxima
                            // pessoa" se realmente sobrar alguem — caso contrario zera servico_ids/
                            // barbeiro_id/periodo sem necessidade justo no turno em que so falta
                            // pedir nome e telefone.
                            if (estado.selecoesGrupo.length < estado.totalAgendamentos) {
                                restaurarContextoProximaPessoaGrupo(estado, indiceAtualGrupo, catalogoBarbeiroServicos);
                            }

                            const faltamSelecionar = estado.totalAgendamentos - estado.selecoesGrupo.length;
                            if (faltamSelecionar > 0) {
                                const proximaPessoaGrupo = estado.pessoasPlano[estado.selecoesGrupo.length] || null;
                                if (proximaPessoaGrupo && Array.isArray(proximaPessoaGrupo.servico_ids) && proximaPessoaGrupo.servico_ids.length > 0) {
                                    forcarDisponibilidadeProximaIteracao = true;
                                    instrucao += `O horario ${horarioParaTexto} com ${catalogoBarbeiros.get(barbeiroIdParaTexto)} para ${pessoaAtualGrupo ? toSecondPersonPapel(pessoaAtualGrupo.papel) : 'esta pessoa'} JA FOI ESCOLHIDO e guardado pelo sistema. NAO peca nome nem telefone agora. Va DIRETO para o proximo agendamento do grupo: mostre a disponibilidade do servico da proxima pessoa (${toSecondPersonPapel(proximaPessoaGrupo.papel)}) e pergunte qual horario${catalogoBarbeiros.size > 1 ? ' e barbeiro' : ''} prefere para ela.`;
                                } else {
                                    instrucao += `O horario ${horarioParaTexto} com ${catalogoBarbeiros.get(barbeiroIdParaTexto)} JA FOI ESCOLHIDO e guardado pelo sistema. NAO peca nome nem telefone agora. Pergunte diretamente qual servico deseja para o proximo agendamento do grupo.`;
                                }
                            } else if (estado.nome && estado.telefone) {
                                forcarCriarNaProximaIteracao = true;
                                instrucao += `Todos os horarios do grupo ja foram escolhidos e o contato ja esta informado. NAO peca mais nada ao cliente e NAO mostre confirmacao parcial — apenas prossiga para registrar todos os agendamentos no banco.`;
                            } else {
                                if (!estado.contatoSolicitado) {
                                    instrucao += `Todos os horarios do grupo ja foram escolhidos e guardados pelo sistema. Agora peca EXATAMENTE: "Informe seu nome completo e telefone para registrar os agendamentos". NUNCA peca isso antes desse momento e NAO reconfirme horarios.`;
                                    estado.contatoSolicitado = true;
                                    messages.push({ role: 'user', content: '[SISTEMA] CONTATO_SOLICITADO: o contato do grupo ja foi solicitado; use esse nome/telefone para todos os agendamentos do grupo.' });
                                } else {
                                    instrucao += `Todos os horarios do grupo ja foram escolhidos e guardados pelo sistema. JA SOLICITAMOS O CONTATO; NAO peça novamente e aguarde o cliente responder com nome e telefone.`;
                                }
                            }
                        } else {
                        // Se nome e telefone JA sao conhecidos, nao ha mais nada a perguntar —
                        // forca a criacao real na proxima chamada em vez de deixar o modelo
                        // decidir se pergunta de novo (ele ja fez isso por engano antes).
                        if (estado.nome && estado.telefone) {
                            forcarCriarNaProximaIteracao = true;
                        }
                        if (!estado.contatoSolicitado) {
                            instrucao += `O cliente JA ESCOLHEU o horario ${horarioParaTexto} com ${catalogoBarbeiros.get(barbeiroIdParaTexto)} — esse horario esta CONFIRMADO como disponivel pelo sistema (verificado agora mesmo no banco de dados real). NUNCA diga que esse horario esta ocupado, indisponivel ou que houve algum problema — isso seria FALSO. NAO liste os horarios disponiveis novamente, NAO pergunte "qual horario prefere" de novo, e NAO diga frases de confirmacao intermediarias como "esse horario esta disponivel" (o cliente ja viu isso na lista anterior — repetir e redundante) — va DIRETO para o PASSO 4. Peca nome completo com sobrenome e telefone com DDD numa unica mensagem, se ainda nao tiver esses dados na conversa.`;
                            estado.contatoSolicitado = true;
                            messages.push({ role: 'user', content: '[SISTEMA] CONTATO_SOLICITADO: o contato do grupo ja foi solicitado; use esse nome/telefone para todos os agendamentos do grupo.' });
                        } else {
                            instrucao += `O cliente JA ESCOLHEU o horario ${horarioParaTexto} com ${catalogoBarbeiros.get(barbeiroIdParaTexto)} — esse horario esta CONFIRMADO como disponivel pelo sistema (verificado agora mesmo no banco de dados real). JA SOLICITAMOS O CONTATO; NAO peça novamente e aguarde o cliente responder com nome e telefone.`;
                        }
                        }
                        } else {
                        const qualBarbeiro = barbeiroId
                            ? `APENAS do barbeiro ${catalogoBarbeiros.get(barbeiroId)} (id ${barbeiroId}), que o cliente escolheu`
                            : 'de TODOS os barbeiros que atendem o servico pedido, agrupados por barbeiro';
                        // DETERMINISTICO: conta em CODIGO quantos barbeiros tem algum horario na
                        // lista que sera mostrada, em vez de pedir para o modelo contar sozinho —
                        // ja aconteceu dele dizer "qual horario e barbeiro prefere" mesmo quando so
                        // um barbeiro aparecia na lista (esquecendo a regra de usar so "qual horario").
                        const barbeirosComHorario = Array.isArray(dadosParaLinhas)
                            ? dadosParaLinhas.filter(b => (b.servicos || []).some(s => (s.horarios || []).length > 0)).length
                            : 0;
                        
                        // AUTO-SELEÇÃO DE BARBEIRO ÚNICO: se só há 1 barbeiro com horários disponíveis
                        // e o cliente não especificou barbeiro, seleciona automaticamente para simplificar
                        if (barbeirosComHorario === 1 && !barbeiroId && Array.isArray(dadosParaLinhas)) {
                            const barbeiroUnico = dadosParaLinhas.find(b => (b.servicos || []).some(s => (s.horarios || []).length > 0));
                            if (barbeiroUnico) {
                                estado.barbeiro_id = Number(barbeiroUnico.barbeiro_id);
                                console.log(`[ai] Auto-seleção: único barbeiro disponível (${barbeiroUnico.barbeiro_nome}, id ${barbeiroUnico.barbeiro_id})`);
                                instrucao += `IMPORTANTE: Apenas o barbeiro ${barbeiroUnico.barbeiro_nome} tem horários disponíveis para este serviço. Selecione-o automaticamente (já foi selecionado em estado.barbeiro_id) e NÃO pergunte ao cliente qual barbeiro prefere — vá direto para perguntar qual horário. `;
                            }
                        }
                        
                        // (v4.2.4) Quando e multi-agendamento e sabemos o papel da pessoa atual
                        // (filho, marido, etc), referencia isso na pergunta — sem isso, a
                        // pergunta generica "qual horario prefere?" nao deixa claro para qual
                        // das pessoas do grupo aquela lista de horarios se refere.
                        const pessoaAtualFrase = (estado.multiAgendamento && estado.pessoasPlano.length > 0)
                            ? estado.pessoasPlano[obterIndicePessoaAtual(estado)] : null;
                        const sufixoPapel = pessoaAtualFrase ? ` para ${toSecondPersonPapel(pessoaAtualFrase.papel)}` : '';
                        if (pessoaAtualFrase) {
                            instrucao += `Esta disponibilidade e para o agendamento do ${toSecondPersonPapel(pessoaAtualFrase.papel)}. `;
                        }
                        // (fix v4.2.6) BUG CORRIGIDO: barbeirosComHorario conta quantos barbeiros
                        // TEM disponibilidade no retorno completo da ferramenta — mas quando o
                        // cliente ja escolheu um barbeiro especifico (barbeiroId truthy, ex: "com
                        // o bryan"), a lista mostrada ja foi filtrada so pra ele (ver qualBarbeiro
                        // acima). Nesse caso a pergunta de barbeiro JA FOI RESPONDIDA pelo cliente
                        // — perguntar de novo (so porque OUTROS barbeiros tambem tem horario, que
                        // nem sao mostrados) e redundante e confuso. Um barbeiro ja escolhido conta
                        // como "so 1" pra fins de fraseFinalHorario, independente do total real.
                        const soUmBarbeiroParaPerguntar = barbeirosComHorario === 1 || !!barbeiroId;
                        const fraseFinalHorario = soUmBarbeiroParaPerguntar ? `"Qual horario prefere${sufixoPapel}?"` : `"Qual horario e barbeiro prefere${sufixoPapel}?"`;
                        instrucao += `O cliente JA informou o servico e o horario desejado (${descricaoFiltro}). Va direto ao PASSO 3: exiba os horarios filtrados ${qualBarbeiro}. NAO pergunte nada que ja foi respondido. Termine a mensagem EXATAMENTE com ${fraseFinalHorario} — essa e a frase certa para este caso especifico (${barbeiroId ? 'cliente ja escolheu o barbeiro' : `${barbeirosComHorario} barbeiro${barbeirosComHorario === 1 ? '' : 's'} na lista`}), nao decida por conta propria.`;

                        if (Array.isArray(dadosParaLinhas)) {
                            // Constroi a lista DUAS vezes: uma restrita ao barbeiro escolhido (se houver) e
                            // uma com TODOS os barbeiros — isso e feito em CODIGO (nao e so uma instrucao de
                            // texto que o modelo podia ignorar), e permite oferecer alternativas quando o
                            // barbeiro escolhido nao tem horario, em vez de so listar todo mundo por engano.
                            // Formata o preco EXATO retornado pela ferramenta (nunca deixa o modelo calcular/
                            // adivinhar o valor de combos — ja causou precos errados no chat com o cliente).
                            const formatarPreco = (preco) => `R$ ${Number(preco).toFixed(2).replace('.', ',')}`;
                            const construirLinhas = (filtrarPorBarbeiro) => {
                                const linhas = [];
                                for (const b of dadosParaLinhas) {
                                    if (filtrarPorBarbeiro && Number(b.barbeiro_id) !== barbeiroId) continue;
                                    const horariosBloqueados = (estado.selecoesGrupo || [])
                                        .filter(sel => sel.data === dataConsultada && Number(sel.barbeiro_id) === Number(b.barbeiro_id))
                                        .map(sel => sel.hora);
                                    for (const s of (b.servicos || [])) {
                                        if (!multiplosServicos && s.servico_id && !servicoIds.includes(s.servico_id)) continue;
                                        let filtrados = filtrarPorPeriodo(s.horarios || []).filter(h => !horariosBloqueados.includes(h));
                                        if (estado.multiAgendamento && s.duracao) {
                                            filtrados = espacarPorDuracao(filtrados, s.duracao);
                                        }
                                        if (filtrados.length > 0) {
                                            // Servicos de preco variavel (ex: dependem do comprimento/tipo do cabelo)
                                            // mostram "a partir de" — o valor exato so e definido no dia, avaliando o cliente.
                                            const precoFmt = s.preco != null ? (s.precoVariavel ? `a partir de ${formatarPreco(s.preco)}` : formatarPreco(s.preco)) : null;
                                            const precoTxt = precoFmt != null ? ` (${precoFmt}${s.duracao ? ' - ' + s.duracao + ' min' : ''})` : '';
                                            linhas.push(`${b.barbeiro_nome} — ${s.servico_nome}${precoTxt}: ${filtrados.join(', ')}`);
                                        }
                                    }
                                }
                                return linhas;
                            };

                            const linhas = construirLinhas(!!barbeiroId);
                            const avisoCombinado = multiplosServicos
                                ? ' Como o cliente pediu MAIS DE UM servico junto, cada linha ja representa o horario UNICO e combinado (duracao somada) para TODOS os servicos pedidos com aquele barbeiro — exiba esse UNICO horario por barbeiro, NUNCA liste os servicos separadamente.'
                                : '';
                            if (linhas.length > 0) {
                                instrucao += `\nLISTA EXATA de horarios (${descricaoFiltro}, ja filtrada pelo sistema — exiba EXATAMENTE estes horarios, sem omitir nem adicionar nenhum, e NUNCA mencione barbeiro fora desta lista):\n${linhas.join('\n')}\nESTA LISTA JA PROVA QUE HA HORARIOS DISPONIVEIS — e ABSOLUTAMENTE PROIBIDO dizer "nao temos horarios" ou qualquer variacao negativa quando esta lista contem itens. Use o FORMATO PADRAO de disponibilidade (com emoji 👤 barbeiro/servico e 🕐 horarios) para apresentar, mesmo que seja apenas UM barbeiro. O valor entre parenteses APOS o nome do servico em cada linha acima e o preco EXATO (e duracao, quando presente) que voce DEVE copiar literalmente para o formato de resposta — NUNCA calcule, some ou arredonde o preco por conta propria, e NUNCA use um preco que voce lembra de uma mensagem anterior da conversa. Se aparecer "a partir de" antes do valor, mantenha essa expressao — significa que e um servico de preco variavel (o valor final depende do comprimento/tipo do cabelo do cliente e so e definido no dia do atendimento). NAO trate isso como um problema nem hesite em agendar — funciona exatamente igual aos outros servicos, so o valor final e confirmado presencialmente.${avisoCombinado} OBS: esta lista cobre APENAS o filtro pedido (${descricaoFiltro}). Ela NAO significa que outros horarios estejam vazios — se o cliente perguntar por outro periodo ou horario depois, chame verificar_disponibilidade_todos novamente.`;
                            } else if (barbeiroId) {
                                // (fix) Repassa o mesmo filtro de periodo/horario ja aplicado nesta consulta —
                                // sem isso, "proxima data com vaga" podia ser uma data que so tem vaga em OUTRO
                                // periodo (ex: cliente pediu a noite, e a "proxima data" so tinha de manha),
                                // fazendo o bot prometer uma data que na verdade nao serve para o pedido.
                                const filtroPeriodoAtual = (periodo || horarioMinimo || horarioMaximo)
                                    ? { periodo: periodo || null, horarioMinimo: horarioMinimo || null, horarioMaximo: horarioMaximo || null }
                                    : null;
                                // Barbeiro escolhido nao tem horario nesse filtro — oferece os outros
                                // barbeiros (se houver) e menciona atendimento por ordem de chegada,
                                // em vez de simplesmente dizer que nao ha nada.
                                const linhasOutros = construirLinhas(false);
                                if (linhasOutros.length > 0) {
                                    instrucao += `\nATENCAO: o barbeiro ${catalogoBarbeiros.get(barbeiroId)} NAO tem horario disponivel para (${descricaoFiltro}). Informe isso ao cliente e OFEREÇA estas alternativas com outros barbeiros (lista exata, nao invente horarios):\n${linhasOutros.join('\n')}\nSe o cliente nao quiser outro barbeiro, mencione que a barbearia tambem atende por ordem de chegada (pode comparecer sem agendamento e aguardar a vez).`;
                                } else {
                                    const dataMinimaProxima = proximaDataISO(dataConsultada);
                                    const proximaOpcao = dataMinimaProxima ? await db.buscarProximoHorario(barbeiroId || null, servicoIds, 21, dataMinimaProxima, filtroPeriodoAtual) : null;
                                    if (proximaOpcao && proximaOpcao.data && Array.isArray(proximaOpcao.disponibilidade)) {
                                        instrucao += `\nATENCAO: apos filtrar (${descricaoFiltro}), NAO restou nenhum horario disponivel com nenhum barbeiro nessa data. Informe isso ao cliente e ja avise que a proxima data com vaga para esse servico e ${proximaOpcao.diaSemana}, ${proximaOpcao.data}. Mencione tambem que a barbearia atende por ordem de chegada.${resumoProximaOpcao(proximaOpcao)}`;
                                    } else {
                                        instrucao += `\nATENCAO: apos filtrar (${descricaoFiltro}), NAO restou nenhum horario disponivel com nenhum barbeiro. Informe o cliente, mencione que a barbearia tambem atende por ordem de chegada, e ofereca outro horario ou data.`;
                                    }
                                }
                            } else {
                                const filtroPeriodoAtualSemBarbeiro = (periodo || horarioMinimo || horarioMaximo)
                                    ? { periodo: periodo || null, horarioMinimo: horarioMinimo || null, horarioMaximo: horarioMaximo || null }
                                    : null;
                                const dataMinimaProxima = proximaDataISO(dataConsultada);
                                const proximaOpcao = dataMinimaProxima ? await db.buscarProximoHorario(barbeiroId || null, servicoIds, 21, dataMinimaProxima, filtroPeriodoAtualSemBarbeiro) : null;
                                if (proximaOpcao && proximaOpcao.data && Array.isArray(proximaOpcao.disponibilidade)) {
                                    instrucao += `\nATENCAO: apos filtrar (${descricaoFiltro}), NAO restou nenhum horario disponivel nessa data. Informe isso ao cliente e ja avise que a proxima data com vaga para esse servico e ${proximaOpcao.diaSemana}, ${proximaOpcao.data}.${resumoProximaOpcao(proximaOpcao)}`;
                                } else {
                                    instrucao += `\nATENCAO: apos filtrar (${descricaoFiltro}), NAO restou nenhum horario disponivel. Informe o cliente e ofereca outros horarios ou outra data.`;
                                }
                            }
                        }
                        }
                    } else if (!servicoInformado && !periodoDefinido) {
                        // periodoDefinido so fica falso aqui se sobrou 0 ou 2+ periodos com vaga
                        // (1 periodo restante ja foi auto-selecionado acima).
                        if (listaPeriodosDisponiveis.length === 0) {
                            instrucao += 'NAO ha NENHUM horario disponivel nesta data (nenhum periodo tem vaga, ou o dia ja passou). Informe isso ao cliente e sugira outra data. NAO pergunte sobre periodo nem servico ainda.';
                        } else {
                            const opcoes = listaPeriodosDisponiveis.map(p => textoPeriodos[p]).join(', ');
                            instrucao += `O cliente ainda NAO informou o servico nem o periodo/horario. Pergunte numa UNICA mensagem curta: qual servico deseja e se prefere ${opcoes} (NAO ofereca periodos fora desta lista — os demais ja passaram ou estao sem vaga nesta data). NAO mostre horarios ainda.`;
                        }
                    } else if (!servicoInformado) {
                        instrucao += `O cliente ja informou o horario desejado (${descricaoFiltro}) mas NAO o servico. Pergunte APENAS qual servico deseja (se ele nao conhecer os servicos, liste apenas nomes e precos, SEM horarios). NAO mostre horarios ainda.`;
                    } else {
                        // periodoDefinido so fica falso aqui se sobrou 0 ou 2+ periodos com vaga.
                        if (listaPeriodosDisponiveis.length === 0) {
                            instrucao += 'NAO ha NENHUM horario disponivel nesta data para nenhum periodo. Informe isso ao cliente e sugira outra data. NAO pergunte sobre periodo.';
                        } else {
                            const opcoes = listaPeriodosDisponiveis.map(p => textoPeriodos[p]).join(', ');
                            instrucao += `O cliente ja informou o servico mas NAO o periodo/horario. Pergunte APENAS: "Prefere ${opcoes}?" (NAO ofereca periodos fora desta lista — os demais ja passaram ou estao sem vaga nesta data). NAO mostre horarios ainda.`;
                        }
                    }
                    messages.push({ role: 'user', content: instrucao });
                }
                if (listouServicos) {
                    let instrucaoServicos = '[SISTEMA] Dados de servicos e barbeiros recebidos do banco de dados. Use APENAS esses dados para responder. PROIBIDO mencionar servicos, precos ou barbeiros que nao constem nesse retorno. IMPORTANTE: se o cliente perguntou sobre um servico especifico (ex: selagem, platinado, luzes) e ele NAO aparece nesta lista, NAO diga ainda que "nao oferecemos" ou "nao esta listado" — antes disso, chame buscar_respostas_bot para conferir se ha uma resposta cadastrada sobre esse servico (alguns servicos tem valor variavel e ficam cadastrados la em vez de na lista de servicos agendaveis).';

                    // Se TODOS os barbeiros oferecem exatamente o MESMO conjunto de servicos (caso normal
                    // da barbearia), monta em CODIGO uma lista UNICA e consolidada (sem repetir por barbeiro)
                    // e obriga o modelo a usar exatamente essa lista.
                    if (Array.isArray(catalogoListado) && catalogoListado.length > 1) {
                        const assinatura = (b) => (b.servicos || []).map(s => s.id).slice().sort((a, c) => a - c).join(',');
                        const primeiraAssinatura = assinatura(catalogoListado[0]);
                        const todosIguais = catalogoListado.every(b => assinatura(b) === primeiraAssinatura);
                        if (todosIguais && catalogoListado[0].servicos && catalogoListado[0].servicos.length > 0) {
                            const fmtPreco = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
                            const linhasServicos = catalogoListado[0].servicos.map(s => {
                                const preco = s.precoVariavel ? `a partir de ${fmtPreco(s.preco)}` : fmtPreco(s.preco);
                                return `- ${s.nome} (${s.duracao} min) — ${preco}`;
                            }).join('\n');
                            instrucaoServicos += `\n\nTODOS os barbeiros (${catalogoListado.map(b => b.nome).join(', ')}) oferecem EXATAMENTE os mesmos servicos. Por isso, exiba a LISTA UNICA abaixo UMA UNICA VEZ, SEM repetir por barbeiro (NUNCA liste "Fabricio: ... Felipe: ... Bryan: ..." com os mesmos servicos repetidos) — mencione os barbeiros pelo nome so quando o cliente perguntar quais barbeiros existem, nao junto da lista de servicos:\n${linhasServicos}`;
                        }
                    }
                    messages.push({ role: 'user', content: instrucaoServicos });
                }
                if (buscouInfoBarbearia) {
                    messages.push({ role: 'user', content: '[SISTEMA] Dados da barbearia recebidos do banco de dados. Use APENAS esses dados para responder. PROIBIDO inventar ou complementar com informacoes que nao constem nesse retorno.' });
                }
                if (agendamentosEncontrados) {
                    const mapa = agendamentosEncontrados
                        .map((ag, i) => `posicao ${i + 1} da lista → id REAL ${ag.id} (${ag.diaSemana} ${ag.data} as ${ag.hora}, ${ag.servico}, ${ag.barbeiro})`)
                        .join('\n');
                    messages.push({ role: 'user', content: `[SISTEMA] Agendamentos encontrados. Ao exibir a lista para o cliente, NAO mostre os ids internos. MAPEAMENTO OBRIGATORIO para cancelar ou reagendar — se o cliente escolher pelo numero da posicao (1, 2, 3...), traduza para o id REAL correspondente antes de chamar cancelar_agendamento:\n${mapa}\nNUNCA passe o numero da posicao da lista como agendamento_id — use SEMPRE o id REAL do mapeamento acima.\nSe o cliente quiser cancelar MAIS DE UM (ex: "os dois", "todos", "cancela os dois"), chame cancelar_agendamento UMA UNICA VEZ passando TODOS os ids reais em agendamento_ids (array) — NUNCA chame a ferramenta varias vezes em sequencia para isso, pois cada chamada subsequente perde a referencia do mapeamento e causa erro "nao encontrado".\nIMPORTANTE: verifique a conversa — se o cliente JA indicou qual(is) agendamento(s) quer cancelar (pelo numero da posicao, pelo horario ou de qualquer outra forma), NAO exiba a lista novamente e NAO pergunte de novo: traduza a escolha para o(s) id(s) real(is) e chame cancelar_agendamento IMEDIATAMENTE. So exiba a lista e pergunte se o cliente ainda NAO tiver escolhido.` });
                } else if (buscouAgendamentoVazio) {
                    messages.push({ role: 'user', content: '[SISTEMA] buscar_agendamento nao encontrou nenhum agendamento futuro para este telefone. NAO mencione isso ao cliente de forma alguma (nunca diga algo como "voce nao tem agendamentos marcados") — apenas continue normalmente para a confirmacao final do NOVO agendamento, como se essa verificacao interna nao tivesse acontecido.' });
                }
                if (buscouRespostas) {
                    messages.push({ role: 'user', content: '[SISTEMA] Respostas cadastradas recebidas do banco. Compare semanticamente a duvida do cliente com as perguntas cadastradas: se alguma corresponder, responda usando a RESPOSTA cadastrada — ela tem PRIORIDADE ABSOLUTA sobre qualquer resposta que voce mesmo formularia (pode apenas ajustar levemente o tom). So responda por conta propria (com as outras ferramentas) se NENHUMA entrada corresponder a duvida.' });
                }
                continue;
            }
            break;
        }
    } catch (err) {
        console.error('[ai] Erro ao chamar OpenAI:', err.message, err.status ?? '', err.error ?? '');
        resposta = 'Estou com dificuldades tecnicas. Tente novamente em instantes.';
    }

    if (!resposta) {
        resposta = 'Desculpe, tive um problema. Pode repetir, por favor?';
    }

    // Remove asteriscos de formatacao markdown que o modelo insiste em usar apesar do prompt
    resposta = resposta.replace(/\*/g, '');

    // Anúncio multi-pessoas REMOVIDO (v4.0 - fluxo sequencial simplificado)
    // O novo sistema mostra progresso automaticamente através das mensagens [SISTEMA]

    // Salva no historico APENAS mensagens de texto do cliente e do bot.
    // Motivos:
    // - Mensagens "tool"/"tool_calls" cortadas pelo slice(-30) da sessao geram erro 400 na OpenAI
    // - Instrucoes [SISTEMA] antigas se acumulariam e confundiriam turnos futuros
    // - Sem dados velhos de tools no historico, o bot e forcado a rechamar as ferramentas
    //   (reforca a regra de nunca responder de memoria)
    const historicoLimpo = messages.filter(m =>
        (m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[SISTEMA]')) ||
        (m.role === 'assistant' && typeof m.content === 'string' && m.content && !m.tool_calls)
    );
    saveSession(phone, historicoLimpo);
    return resposta;
}

module.exports = { processarMensagemWhatsApp };
