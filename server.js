/**
 * Rasmar V1 — servidor próprio (roda num servidor na nuvem, no lugar do
 * Google Apps Script). Fala exatamente o mesmo "idioma" que o Code.gs já
 * falava — leitura via JSONP (?callback=...) e escrita via formulário
 * (payload=...) — então o index.html e o dashboard.html NÃO precisam de
 * nenhuma mudança. Só troque a URL configurada em "Configurar sincronização"
 * pra apontar pra esse servidor, em vez da URL do Apps Script.
 *
 * Como rodar:
 *   1. Instale o Node.js na máquina/servidor (https://nodejs.org).
 *   2. Coloque este arquivo numa pasta.
 *   3. No terminal, dentro dessa pasta: node server.js
 *   4. Vai aparecer "Rasmar server rodando na porta 3000" (ou a porta que
 *      você configurar). A URL de sincronização pro Rasmar é:
 *      http://SEU-ENDERECO:3000/  (o endereço do servidor onde isso roda)
 *
 * Os dados ficam guardados no arquivo "dados.json", nessa mesma pasta —
 * faça backup dele de vez em quando (é só um arquivo, dá pra copiar).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORTA = process.env.PORT || 3000;
const ARQUIVO_DB = path.join(__dirname, 'dados.json');
const PASTA_BACKUPS = path.join(__dirname, 'backups');
const DIAS_PARA_MANTER_BACKUP = 30;

function estadoPadrao(){
  return {
    projetos: [], proximoNumeroPedido: 1, salvoEm: null, usuarios: [], logs: [], movimentos: [],
    // sugestão de horário comercial — o admin pode mudar isso a qualquer
    // hora pela tela de Administração; usado só pra calcular "tempo útil"
    // no dashboard (não trava nem impede bipar fora desse horário).
    configuracaoHorario: { inicio: '08:00', fim: '17:00', almocoInicio: '12:00', almocoFim: '13:00' },
    // etapas/processos da produção — o admin pode adicionar mais setores e
    // escolher a posição de cada um; os 5 aqui são os padrões de fábrica.
    estacoes: [
      { id: 'cnc', label: 'CNC', type: 'peca', field: 'cnc_em' },
      { id: 'coladeira', label: 'Coladeira', type: 'peca', field: 'coladeira_em' },
      { id: 'limpeza', label: 'Limpeza e Separação', type: 'peca', field: 'limpeza_em' },
      { id: 'pre', label: 'Pré Montagem', type: 'modulo', completaField: 'preCompleta', completaEmField: 'preCompletaEm' },
      { id: 'final', label: 'Montagem Final', type: 'modulo', completaField: 'finalCompleta', completaEmField: 'finalCompletaEm' }
    ],
    // nome da marcenaria que está usando esse app — aparece no rodapé e
    // no cabeçalho; editável pelo admin na Administração.
    nomeMarcenaria: ''
  };
}

function lerDB(){
  try {
    const conteudo = fs.readFileSync(ARQUIVO_DB, 'utf8');
    const dados = JSON.parse(conteudo);
    return Object.assign(estadoPadrao(), dados);
  } catch (err) {
    return estadoPadrao();
  }
}

// escreve em arquivo temporário e só depois renomeia — assim, se o processo
// for interrompido no meio, o arquivo original nunca fica corrompido/parcial.
function salvarDB(db){
  const tmp = ARQUIVO_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, ARQUIVO_DB);
}

// fila simples que serializa toda leitura+escrita — evita que duas
// gravações ao mesmo tempo (dois computadores salvando junto) se
// atropelem, do mesmo jeito que o LockService fazia no Apps Script.
let filaOperacoes = Promise.resolve();
function comTrava(fn){
  const resultado = filaOperacoes.then(fn, fn);
  filaOperacoes = resultado.then(() => {}, () => {});
  return resultado;
}

// gera o horário no fuso de Brasília (GMT-3), independente do fuso do
// sistema operacional do servidor — servidores na nuvem (ex: Google Cloud)
// costumam vir configurados em UTC por padrão, o que fazia os horários
// aparecerem errados (3 horas à frente) em todo o app.
function timestampLocal(){
  const d = new Date();
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  }).formatToParts(d);
  const obter = tipo => partes.find(p => p.type === tipo).value;
  return obter('year') + '-' + obter('month') + '-' + obter('day') +
    'T' + obter('hour') + ':' + obter('minute') + ':' + obter('second');
}

function dataHojeBrasilia(){
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}
function horaAgoraBrasilia(){
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
}

// ---------- backups (automático diário às 23:59 + manual sob demanda) ----------
function criarArquivoBackup(motivo){
  if (!fs.existsSync(PASTA_BACKUPS)) fs.mkdirSync(PASTA_BACKUPS, { recursive: true });
  const db = lerDB();
  const sufixo = motivo === 'manual' ? ('-manual-' + Date.now()) : '';
  const nomeArquivo = 'backup-' + dataHojeBrasilia() + sufixo + '.json';
  fs.writeFileSync(path.join(PASTA_BACKUPS, nomeArquivo), JSON.stringify(db));
  return nomeArquivo;
}

function limparBackupsAntigos(){
  if (!fs.existsSync(PASTA_BACKUPS)) return;
  const limite = Date.now() - DIAS_PARA_MANTER_BACKUP * 24 * 60 * 60 * 1000;
  fs.readdirSync(PASTA_BACKUPS).forEach(nome => {
    const caminho = path.join(PASTA_BACKUPS, nome);
    try {
      if (fs.statSync(caminho).mtimeMs < limite) fs.unlinkSync(caminho);
    } catch (e) { /* ignora se o arquivo já sumiu */ }
  });
}

function listarArquivosBackup(){
  if (!fs.existsSync(PASTA_BACKUPS)) return [];
  return fs.readdirSync(PASTA_BACKUPS)
    .filter(nome => nome.endsWith('.json'))
    .map(nome => {
      const stat = fs.statSync(path.join(PASTA_BACKUPS, nome));
      return { nome, criadoEm: stat.mtime.toISOString(), tamanhoBytes: stat.size };
    })
    .sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
}

// confere a cada 30 segundos se são 23:59 no horário de Brasília — se for,
// e ainda não fez o backup de hoje, faz agora. Roda pra sempre enquanto o
// servidor estiver de pé, sem depender de nenhum agendador externo (cron).
let ultimaDataComBackupAutomatico = null;
setInterval(() => {
  const hoje = dataHojeBrasilia();
  if (horaAgoraBrasilia() === '23:59' && ultimaDataComBackupAutomatico !== hoje){
    ultimaDataComBackupAutomatico = hoje;
    try {
      criarArquivoBackup('automatico');
      limparBackupsAntigos();
      console.log('Backup automático diário criado: ' + hoje);
    } catch (e) {
      console.error('Falha ao criar o backup automático: ' + e.message);
    }
  }
}, 30000);

// mesmo contador de chamadas hoje que o Code.gs tem — aqui é ainda mais
// simples, já que o servidor é só nosso mesmo (mas mantém o mesmo formato
// de resposta, então o front-end não precisa saber com qual dos dois está
// falando).
function incrementarContador(db){
  const hoje = timestampLocal().slice(0, 10);
  if (db.contadorData !== hoje){
    db.contadorChamadas = 0;
    db.contadorData = hoje;
  }
  db.contadorChamadas = (db.contadorChamadas || 0) + 1;
  return db.contadorChamadas;
}

function filtrarPeriodo(lista, de, ate){
  return (lista || []).filter(item => {
    const data = String(item.em || '').slice(0, 10);
    if (de && data < de) return false;
    if (ate && data > ate) return false;
    return true;
  });
}

function anexarNovosPorId(lista, novos){
  lista = lista || [];
  if (!Array.isArray(novos) || !novos.length) return lista;
  const idsExistentes = new Set(lista.map(x => x.id));
  novos.forEach(item => { if (item && item.id && !idsExistentes.has(item.id)) lista.push(item); });
  return lista;
}

function tratarGet(url, res){
  const acao = url.searchParams.get('acao');
  const callback = url.searchParams.get('callback');
  const de = url.searchParams.get('de');
  const ate = url.searchParams.get('ate');
  const db = lerDB();
  const chamadasHoje = incrementarContador(db);
  salvarDB(db);

  let resultado;
  if (acao === 'logs'){
    resultado = { logs: filtrarPeriodo(db.logs, de, ate) };
  } else if (acao === 'movimentos'){
    resultado = { movimentos: filtrarPeriodo(db.movimentos, de, ate) };
  } else if (acao === 'backup'){
    resultado = {
      projetos: db.projetos, proximoNumeroPedido: db.proximoNumeroPedido,
      usuarios: db.usuarios, logs: db.logs, movimentos: db.movimentos,
      configuracaoHorario: db.configuracaoHorario, estacoes: db.estacoes, nomeMarcenaria: db.nomeMarcenaria, nomeMarcenaria: db.nomeMarcenaria,
      geradoEm: timestampLocal()
    };
  } else if (acao === 'listarBackups'){
    resultado = { backups: listarArquivosBackup() };
  } else {
    resultado = { projetos: db.projetos, proximoNumeroPedido: db.proximoNumeroPedido, usuarios: db.usuarios, salvoEm: db.salvoEm, configuracaoHorario: db.configuracaoHorario, estacoes: db.estacoes, nomeMarcenaria: db.nomeMarcenaria };
  }
  resultado.chamadasHoje = chamadasHoje;
  const json = JSON.stringify(resultado);
  if (callback){
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.end(callback + '(' + json + ');');
  } else {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(json);
  }
}

function aplicarPost(corpo){
  const db = lerDB();
  const chamadasHoje = incrementarContador(db);

  if (corpo.acao === 'apagarLogs'){
    const antes = (db.logs || []).length;
    db.logs = (db.logs || []).filter(l => {
      const data = String(l.em || '').slice(0, 10);
      const dentro = (!corpo.de || data >= corpo.de) && (!corpo.ate || data <= corpo.ate);
      return !dentro;
    });
    salvarDB(db);
    return { ok: true, apagadas: antes - db.logs.length, chamadasHoje };
  }
  if (corpo.acao === 'apagarMovimentos'){
    db.movimentos = (db.movimentos || []).filter(m => {
      const data = String(m.em || '').slice(0, 10);
      const dentro = (!corpo.de || data >= corpo.de) && (!corpo.ate || data <= corpo.ate);
      return !dentro;
    });
    salvarDB(db);
    return { ok: true, chamadasHoje };
  }
  if (corpo.acao === 'apagarMovimentosPorId'){
    // apaga só os movimentos com os ids indicados — usado pra excluir um
    // registro específico de parada/setup (início + fim), sem mexer no
    // resto do histórico daquele período.
    const ids = new Set(Array.isArray(corpo.ids) ? corpo.ids : []);
    if (!ids.size) return { ok: false, erro: 'nenhum id informado', chamadasHoje };
    db.movimentos = (db.movimentos || []).filter(m => !ids.has(m.id));
    salvarDB(db);
    return { ok: true, chamadasHoje };
  }
  if (corpo.acao === 'criarBackupManual'){
    const nomeArquivo = criarArquivoBackup('manual');
    return { ok: true, nomeArquivo, chamadasHoje };
  }
  if (corpo.acao === 'restaurarBackup'){
    // ação bem destrutiva (substitui TUDO) — só executa com a confirmação
    // explícita, pra evitar restaurar sem querer por engano.
    if (!corpo.confirmarRestaurar){
      return { ok: false, erro: 'confirmação obrigatória pra restaurar um backup', chamadasHoje };
    }
    const b = corpo.backup || {};
    // faz um backup de segurança do estado ATUAL antes de sobrescrever —
    // assim, mesmo uma restauração errada dá pra desfazer depois.
    try { criarArquivoBackup('antes-de-restaurar'); } catch (e) { /* segue mesmo se falhar */ }
    const novoDb = {
      projetos: Array.isArray(b.projetos) ? b.projetos : [],
      proximoNumeroPedido: b.proximoNumeroPedido || 1,
      usuarios: Array.isArray(b.usuarios) ? b.usuarios : [],
      logs: Array.isArray(b.logs) ? b.logs : [],
      movimentos: Array.isArray(b.movimentos) ? b.movimentos : [],
      configuracaoHorario: (b.configuracaoHorario && typeof b.configuracaoHorario === 'object') ? b.configuracaoHorario : estadoPadrao().configuracaoHorario,
      estacoes: (Array.isArray(b.estacoes) && b.estacoes.length) ? b.estacoes : estadoPadrao().estacoes,
      nomeMarcenaria: (typeof b.nomeMarcenaria === 'string') ? b.nomeMarcenaria : '',
      salvoEm: timestampLocal()
    };
    salvarDB(novoDb);
    return { ok: true, salvoEm: novoDb.salvoEm, chamadasHoje };
  }

  // mesma proteção que o Code.gs tem: nunca aceita "projetos" vazio sem
  // confirmação explícita (evita apagar tudo por uma corrida/erro local).
  const projetosVazioSuspeito = Array.isArray(corpo.projetos) && corpo.projetos.length === 0 && (db.projetos || []).length > 0 && !corpo.confirmarZerarTudo;
  if (!projetosVazioSuspeito){
    db.projetos = corpo.projetos || [];
    db.proximoNumeroPedido = corpo.proximoNumeroPedido || db.proximoNumeroPedido || 1;
  }
  db.salvoEm = timestampLocal();

  if (Array.isArray(corpo.usuarios)){
    const usuariosVazioSuspeito = corpo.usuarios.length === 0 && (db.usuarios || []).length > 0 && !corpo.confirmarZerarUsuarios;
    if (!usuariosVazioSuspeito) db.usuarios = corpo.usuarios;
  }

  if (corpo.configuracaoHorario && typeof corpo.configuracaoHorario === 'object'){
    db.configuracaoHorario = corpo.configuracaoHorario;
  }
  if (Array.isArray(corpo.estacoes) && corpo.estacoes.length){
    db.estacoes = corpo.estacoes;
  }
  if (typeof corpo.nomeMarcenaria === 'string'){
    db.nomeMarcenaria = corpo.nomeMarcenaria;
  }

  db.logs = anexarNovosPorId(db.logs, corpo.logsNovos);
  db.movimentos = anexarNovosPorId(db.movimentos, corpo.movimentosNovos);

  salvarDB(db);
  return { ok: true, salvoEm: db.salvoEm, chamadasHoje };
}

const server = http.createServer((req, res) => {
  // CORS liberado — como esse servidor é nosso, não tem as restrições que
  // o Apps Script tinha (por isso o index.html também funcionaria aqui
  // com fetch() comum, mas mantemos compatível com JSONP/formulário pra
  // não precisar mudar nada no front-end).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS'){ res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET'){
    comTrava(async () => tratarGet(url, res)).catch(err => {
      res.statusCode = 500; res.end('erro: ' + err.message);
    });
    return;
  }

  if (req.method === 'POST'){
    let corpoTexto = '';
    req.on('data', chunk => { corpoTexto += chunk; });
    req.on('end', () => {
      comTrava(async () => {
        const params = new URLSearchParams(corpoTexto);
        const payloadTexto = params.get('payload') || corpoTexto;
        const corpo = JSON.parse(payloadTexto);
        return aplicarPost(corpo);
      }).then(resultado => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(resultado));
      }).catch(err => {
        res.statusCode = 500;
        res.end(JSON.stringify({ ok: false, erro: String(err.message || err) }));
      });
    });
    return;
  }

  res.statusCode = 404;
  res.end('não encontrado');
});

server.listen(PORTA, () => {
  console.log('Rasmar server rodando na porta ' + PORTA);
  console.log('Arquivo de dados: ' + ARQUIVO_DB);
});
