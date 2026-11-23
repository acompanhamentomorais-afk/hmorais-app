/* H Morais Lançamentos · app do celular (PWA) ligado ao Painel Financeiro.
 * - Funciona sem internet: os dados ficam no celular (IndexedDB) e o que for lançado entra numa fila,
 *   enviada sozinha quando a internet volta. Cada envio tem um código: reenviar não duplica no painel.
 * - Login Google: o painel confere o login e a lista de e-mails autorizados (nada disso fica aqui).
 */
'use strict';
const APP_VERSAO = '11';
const CFG = window.HM_CONFIG || {};

/* ================================================================== */
/* Utilidades                                                           */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = c => (c < 0 ? '-' : '') + 'R$ ' + (Math.abs(c) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const centsDe = t => { const d = String(t).replace(/\D/g, ''); return d ? parseInt(d.slice(-11), 10) : 0; };
const MES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const agoraLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const dataHoraBR = s => { const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/); return m ? `${m[3]}/${m[2]}/${m[1]} ${m[4]}` : s; };
const hojeISO = () => agoraLocal().slice(0, 10);
const dataBR = d => d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4);
const reduz = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
const idPers = idApp => 'PA' + String(idApp).replace(/[^A-Za-z0-9]/g, '').slice(0, 24).toUpperCase();   // mesmo ID que o painel grava
const ehCredito = nome => /cr[ée]dito/i.test(nome || '');
const CHEV = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 9l6 6 6-6"/></svg>';

/* ---------- guardar no celular (IndexedDB; sem ele, só na memória) ---------- */
const BD = (() => {
  let db = null, mem = {};
  const abrir = () => new Promise(res => {
    try { const r = indexedDB.open('hmorais-app', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { db = r.result; res(); }; r.onerror = () => res(); }
    catch (e) { res(); }
  });
  const pronto = abrir();
  return {
    async get(k) { await pronto; if (!db) return mem[k]; return new Promise(res => { try { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(mem[k]); } catch (e) { res(mem[k]); } }); },
    async set(k, v) { mem[k] = v; await pronto; if (!db) return; return new Promise(res => { try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => res(); } catch (e) { res(); } }); },
    async del(k) { delete mem[k]; await pronto; if (!db) return; return new Promise(res => { try { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').delete(k); t.oncomplete = () => res(); t.onerror = () => res(); } catch (e) { res(); } }); }
  };
})();

/* ================================================================== */
/* Estado                                                               */
/*  sessao: {token, exp, email, nome}  · dados: o que o painel mandou (planos, listas, lançamentos, personal)
 *  fila: envios pendentes, na ordem  · recusados: lançamentos que o painel não aceitou (para corrigir)        */
const ST = { sessao: null, dados: null, fila: [], recusados: [], aba: 'novo', filtro: { mes: '', quem: 'todos', q: '', plano: '', forma: '' }, online: navigator.onLine, erroLogin: '' };
let R = null;                 // rascunho do formulário
let enviando = false, atualizando = false, gis = false, renovando = null;
const guardar = (...ks) => Promise.all(ks.map(k => BD.set(k, k === 'rascunho' ? R : ST[k])));

const eu = () => (ST.sessao ? ST.sessao.email : '');
const planos = () => ((ST.dados && ST.dados.planos) || []);
const planoPorId = id => planos().find(p => p.id === id);
const lista = k => ((ST.dados && ST.dados.listas && ST.dados.listas[k]) || []);
const opcao = (k, id) => lista(k).find(x => x.id === id);
const nomeOpcao = (k, id) => (opcao(k, id) || {}).valor || '';
const naLista = (k, planoId) => !!planoId && lista(k).some(x => x.ativo && x.planoId === planoId);
const extrasDe = planoId => ({ viagem: naLista('plano_reembolsavel', planoId) || naLista('plano_farid', planoId), farid: naLista('plano_farid', planoId), fazenda: naLista('plano_fazenda', planoId) });
const formaNome = id => nomeOpcao('forma', id);
const veTodos = () => !(ST.dados && ST.dados.usuario && ST.dados.usuario.todos === false);
const ehAdmin = () => !!(ST.dados && ST.dados.usuario && ST.dados.usuario.admin);
const temPersonal = () => !!(ST.dados && ST.dados.usuario && ST.dados.usuario.personal && ST.dados.personal);

/** O que aparece na tela: o que veio do painel + o que ainda está na fila (e os recusados, para corrigir). */
function vista() {
  const d = ST.dados || {};
  let lanc = (d.lancamentos || []).map(l => Object.assign({}, l));
  const pers = d.personal ? { locais: d.personal.locais || [], lanc: (d.personal.lanc || []).map(x => Object.assign({}, x)) } : null;
  const comoLanc = (op, marca) => {
    const x = op.dados, antes = lanc.find(l => l.id === x.id) || {};
    return Object.assign({}, antes, {
      id: x.id, data: x.data, usuario: antes.usuario || (ST.dados && ST.dados.usuario && ST.dados.usuario.nome) || '', dono: antes.dono || eu(), valor: x.valor, desc: x.desc, estabId: x.estabId || '', formaId: x.formaId,
      parcelas: x.parcelas || 1, obs: x.obs || '', fotoId: x.tirarFoto ? '' : antes.fotoId, miniatura: op.miniatura || (x.tirarFoto ? '' : antes.miniatura),
      partes: x.partes.map(p => Object.assign({ plano: (planoPorId(p.planoId) || {}).nome || '' }, p)), status: marca.status, erro: marca.erro || '', envio: op.envio
    });
  };
  const aplica = (op, marca) => {
    if (op.tipo === 'salvar') { const l = comoLanc(op, marca), i = lanc.findIndex(x => x.id === l.id); if (i >= 0) lanc[i] = l; else lanc.unshift(l); }
    else if (op.tipo === 'excluir') lanc = lanc.filter(x => x.id !== op.dados.id);
    else if (op.tipo === 'personal' && pers) {
      if (op.dados.acao === 'cancelar') { const x = pers.lanc.find(y => y.id === op.dados.id); if (x) { x.cancelado = true; x.fila = true; } }
      else if (!pers.lanc.some(y => y.id === idPers(op.dados.idApp))) pers.lanc.push({ id: idPers(op.dados.idApp), data: op.dados.data, localId: op.dados.localId, tipo: op.dados.tipo, qtd: op.dados.qtd, cancelado: false, fila: true, criadoEm: '9' });
    }
  };
  ST.recusados.forEach(op => aplica(op, { status: 'erro', erro: op.erro }));
  ST.fila.forEach(op => aplica(op, { status: 'fila' }));
  return { lanc, pers };
}

/* ================================================================== */
/* Conversa com o painel                                                */
function erroDe(msg, o) { const e = new Error(msg); Object.assign(e, o || {}); return e; }
async function api(acao, dados) {
  if (!CFG.API_URL) throw erroDe('O app ainda não foi configurado (falta o endereço do painel em config.js).', { config: true });
  if (!tokenValido()) throw erroDe('Entre de novo para enviar.', { login: true });
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90000);
  let r;
  try {
    // texto simples: o navegador não precisa perguntar antes (sem "preflight"), que o Apps Script não responde
    r = await fetch(CFG.API_URL, { method: 'POST', body: JSON.stringify({ acao, token: ST.sessao.token, dados: dados || {} }), headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl.signal, credentials: 'omit' });
  } catch (e) { throw erroDe('Sem conexão com o painel.', { rede: true }); }
  finally { clearTimeout(t); }
  let j; try { j = await r.json(); } catch (e) { throw erroDe('O painel não respondeu direito. Tenta de novo em instantes.', { rede: true }); }
  if (!j.ok) {
    // sessão do app derrubada ou vencida: volta a pedir o login Google
    if (j.login && ST.sessao && ST.sessao.tipo === 'app') { ST.sessao.token = ''; ST.sessao.exp = 0; ST.sessao.tipo = ''; guardar('sessao'); pintaTopo(); }
    throw erroDe(j.erro || 'Erro no painel.', { login: !!j.login, conflito: !!j.conflito });
  }
  if (ST.sessao && ST.sessao.tipo === 'app') {         // cada uso renova os 30 dias (no painel e aqui)
    const novo = Math.floor(Date.now() / 1000) + 30 * 86400; if (novo - ST.sessao.exp > 3600) { ST.sessao.exp = novo; guardar('sessao'); }
  }
  return j.dados;
}

/** Busca tudo de novo no painel (ao abrir, ao voltar para o app e depois de enviar a fila). */
async function atualizar(silencioso) {
  if (atualizando || !ST.online || !tokenValido()) return;
  atualizando = true; if (!ST.dados) tela();
  try {
    const d = await api('inicio');
    ST.dados = d; ST.erroLogin = '';
    if (d.usuario && ST.sessao) ST.sessao.nome = d.usuario.nome;
    await guardar('dados', 'sessao');
    if (ST.sessao && ST.sessao.tipo !== 'app') criarSessao();
  } catch (e) {
    if (e.login) { if (/não tem acesso/.test(e.message)) return sairDeVez(e.message); pedirLogin(); }
    else if (!ST.dados) erroInicio(e.message);
    else if (!silencioso && !e.rede) aviso(e.message, true);
  } finally { atualizando = false; tela(); }
}

/** Primeira abertura sem conseguir falar com o painel: mostra o motivo e "Tentar de novo" (em vez de ficar carregando). */
function erroInicio(msg) { ST.erroInicio = msg; }
/** Logado, mas ainda sem os dados do painel no celular: mostra o que está acontecendo (nunca fica só girando). */
function telaSemDados() {
  const caixa = (tit, txt, botoes) => `<div class="cartao" style="text-align:center;gap:12px"><b style="color:var(--navy);font-size:16px">${tit}</b><span class="mini" role="alert">${txt}</span>${botoes}</div>`;
  const sair = '<button type="button" class="btn sec" id="semSair">Sair e entrar com outra conta</button>';
  if (atualizando) $('#corpo').innerHTML = `<div class="carregando" style="gap:14px;display:grid;justify-items:center"><i></i><span class="mini" style="text-align:center">Buscando seus dados no painel…<br>Na primeira vez pode levar até 1 minuto.</span></div>`;
  else if (!ST.online) $('#corpo').innerHTML = caixa('Sem internet', 'Conecte o celular à internet para carregar os dados pela primeira vez. Depois o app funciona sem internet.', '<button type="button" class="btn pri" id="tentar">Tentar de novo</button>');
  else if (!tokenValido()) {
    $('#corpo').innerHTML = caixa('Entre de novo', `O login de ${esc(eu())} venceu ou este aparelho foi desconectado. Entre de novo para carregar os dados.`, '<div class="gbox" id="gbtn3" style="display:grid;place-items:center;min-height:44px"></div>' + sair);
    try { google.accounts.id.renderButton($('#gbtn3'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', locale: 'pt-BR' }); } catch (e) { $('#gbtn3').textContent = 'Carregando o login do Google…'; }
    renovarLogin();
  }
  else $('#corpo').innerHTML = caixa('Não consegui abrir os dados do painel', esc(ST.erroInicio || 'Toque em "Tentar de novo".'), '<button type="button" class="btn pri" id="tentar">Tentar de novo</button>' + sair);
  const t = $('#tentar'); if (t) t.onclick = () => { ST.erroInicio = ''; atualizar(); };
  const s = $('#semSair'); if (s) s.onclick = () => { if (ST.fila.length) return aviso(`Há ${ST.fila.length} envio(s) guardado(s) no celular. Entre com ${eu()} para enviar antes de sair.`, true); sairDeVez(''); };
}

/** Envia a fila, um por vez, na ordem em que foi lançada. */
async function enviarFila() {
  if (enviando || !ST.online || !ST.fila.length) return;
  if (!tokenValido()) { pedirLogin(); return; }
  enviando = true; pintaTopo();
  let enviados = 0, parou = false;
  try {
    while (ST.fila.length) {
      const op = ST.fila[0];
      op.tentou = true; await guardar('fila');
      let r;
      try { r = await api(op.tipo === 'excluir' ? 'excluir' : op.tipo, prepararEnvio(op)); }
      catch (e) {
        if (e.rede || e.config) { parou = true; break; }
        if (e.login) { parou = true; pedirLogin(); break; }
        ST.fila.shift();                                                     // o painel não aceitou: sai da fila
        if (e.conflito) { aviso(e.message, true); }
        else if (op.tipo === 'salvar') { ST.recusados = ST.recusados.filter(x => x.dados.id !== op.dados.id).concat([Object.assign({}, op, { erro: e.message })]); aviso('Um lançamento não foi aceito pelo painel. Veja em Lançamentos.', true); }
        else aviso(e.message, true);
        await guardar('fila', 'recusados');
        continue;
      }
      ST.fila.shift(); enviados++;
      aplicarResposta(op, r);
      ST.recusados = ST.recusados.filter(x => !(op.tipo === 'salvar' && x.dados.id === op.dados.id));
      await guardar('fila', 'dados', 'recusados');
      pintaTopo();
    }
  } finally { enviando = false; }
  if (enviados && !ST.fila.length) aviso(enviados === 1 ? 'Enviado para o painel' : `${enviados} lançamentos enviados para o painel`);
  if (!parou) await atualizar(true); else tela();
}
/** Dados do envio. Alteração feita na fila depois de um lançamento novo usa a versão que o painel acabou de devolver. */
function prepararEnvio(op) {
  if (op.tipo !== 'salvar') return op.dados;
  const d = Object.assign({}, op.dados);
  if (op.seguir) { const l = ((ST.dados && ST.dados.lancamentos) || []).find(x => x.id === d.id); d.versao = l ? l.versao : undefined; }
  return d;
}
function aplicarResposta(op, r) {
  const D = ST.dados || (ST.dados = { lancamentos: [] });
  if (op.tipo === 'salvar' && r.lancamento) {
    const i = D.lancamentos.findIndex(x => x.id === r.lancamento.id);
    if (i >= 0) D.lancamentos[i] = r.lancamento; else D.lancamentos.unshift(r.lancamento);
  } else if (op.tipo === 'excluir') D.lancamentos = D.lancamentos.filter(x => x.id !== op.dados.id);
  else if (op.tipo === 'personal' && r.personal) D.personal = r.personal;
}
async function enfileirar(op) {
  op.envio = op.envio || uuid(); op.criado = Date.now();
  if (op.tipo === 'salvar') op.dados.envio = op.envio;
  ST.fila.push(op); await guardar('fila');
  tela(); enviarFila();
}

/* ================================================================== */
/* Login Google                                                         */
const lerToken = t => { try { return JSON.parse(decodeURIComponent(escape(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))))); } catch (e) { return {}; } };
const tokenValido = () => !!(ST.sessao && ST.sessao.token && ST.sessao.exp * 1000 > Date.now() + 60000);

window.gisPronto = function () {
  if (!CFG.CLIENT_ID || !window.google || !google.accounts) return;
  google.accounts.id.initialize({ client_id: CFG.CLIENT_ID, callback: r => entrou(r.credential), auto_select: true, cancel_on_tap_outside: false, itp_support: true, use_fedcm_for_prompt: true });
  gis = true;
  if (!ST.sessao) telaLogin();
  else { if (!ST.dados) tela(); if (!tokenValido() && ST.online) renovarLogin(); }
};
/** Sessão do Google dura 1 hora: renova sozinho (sem tocar em nada, se o Google deixar). */
function renovarLogin() {
  if (!gis || renovando) return;
  renovando = setTimeout(() => { renovando = null; pintaTopo(); }, 10000);
  try { google.accounts.id.prompt(); } catch (e) { }
}
async function entrou(cred) {
  const p = lerToken(cred), email = String(p.email || '').toLowerCase();
  if (!email) return;
  if (ST.sessao && ST.sessao.email !== email) {
    if (ST.fila.length) { aviso(`Há ${ST.fila.length} envio(s) de ${ST.sessao.email} guardados neste celular. Entre com essa conta para enviar.`, true); return; }
    ST.dados = null; ST.recusados = []; R = null; await guardar('dados', 'recusados', 'rascunho');
  }
  clearTimeout(renovando); renovando = null;
  ST.sessao = { token: cred, exp: p.exp || 0, email, nome: (ST.sessao && ST.sessao.email === email && ST.sessao.nome) || p.given_name || p.name || '' };
  ST.erroLogin = '';
  await guardar('sessao');
  await criarSessao();
  document.querySelectorAll('.login').forEach(x => x.remove()); fecharFolha(true);
  if (!ST.dados) $('#corpo').innerHTML = '<div class="carregando"><i></i></div>';
  await atualizar();
  enviarFila();
}
/** Depois do login Google, pede ao painel a sessão do app (30 dias sem pedir o Google de novo; cada uso renova). */
async function criarSessao() {
  if (!ST.sessao || ST.sessao.tipo === 'app' || !tokenValido() || !ST.online) return;
  try {
    const r = await api('sessao', { aparelho: nomeAparelho() });
    ST.sessao = Object.assign({}, ST.sessao, { token: r.sessao, tipo: 'app', exp: Math.floor(Date.now() / 1000) + (r.dias || 30) * 86400 });
    await guardar('sessao'); pintaTopo();
  } catch (e) { /* sem sessão agora: segue com o login Google (1 hora) e tenta de novo na próxima atualização */ }
}
function nomeAparelho() {
  const u = navigator.userAgent || '';
  const so = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Mac OS/.test(u) ? 'Mac' : 'Celular';
  const nav = /SamsungBrowser/.test(u) ? 'Samsung Internet' : /EdgA?\//.test(u) ? 'Edge' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /Safari/.test(u) ? 'Safari' : 'navegador';
  return so + ' · ' + nav + (matchMedia('(display-mode: standalone)').matches ? ' (app instalado)' : '');
}
/** Precisa entrar de novo: sem dados guardados, tela de login; com dados, o app continua e o topo avisa. */
function pedirLogin() { if (!ST.dados) telaLogin(); else { renovarLogin(); pintaTopo(); } }
async function sairDeVez(msg) {
  ST.sessao = null; ST.dados = null; ST.recusados = []; ST.erroLogin = msg || ''; R = null;
  try { if (gis) google.accounts.id.disableAutoSelect(); } catch (e) { }
  await Promise.all([BD.del('sessao'), BD.del('dados'), BD.del('recusados'), BD.del('rascunho')]);
  tela();
}
function telaLogin() {
  let l = $('.login');
  if (!l) { l = document.createElement('div'); l.className = 'login'; $('#app').appendChild(l); }
  const motivo = !CFG.CLIENT_ID || !CFG.API_URL ? 'O app ainda não foi configurado: preencha o arquivo config.js (veja o guia de publicação).'
    : !ST.online ? 'Sem internet. Conecte para entrar pela primeira vez; depois o app funciona sem internet.'
      : !gis ? 'Carregando o login do Google…' : '';
  l.innerHTML = `<div class="marca" aria-hidden="true">H</div><h2>H Morais</h2><p>Lançamentos de despesas, ligados ao Painel Financeiro.</p>
    ${ST.erroLogin ? `<div class="erro" role="alert">${esc(ST.erroLogin)}</div>` : ''}
    ${motivo ? `<p style="font-size:13px">${esc(motivo)}</p>` : '<div class="gbox" id="gbtn"></div>'}
    <p style="font-size:12px">Só os e-mails autorizados entram.</p>`;
  if (!motivo) try { google.accounts.id.renderButton(l.querySelector('#gbtn'), { theme: 'outline', size: 'large', shape: 'pill', text: 'signin_with', locale: 'pt-BR' }); google.accounts.id.prompt(); } catch (e) { }
}
function folhaLogin() {
  const f = abrirFolha(`<div class="folha-cab"><h3>Entrar de novo</h3></div><div class="folha-corpo det">
    <span class="mini">Seu login venceu (30 dias sem usar o app) ou este aparelho foi desconectado no painel. Entre de novo para enviar o que está guardado no celular e ver os lançamentos mais novos.</span>
    <div class="gbox" id="gbtn2" style="display:grid;place-items:center;min-height:44px"></div></div>`);
  try { google.accounts.id.renderButton(f.querySelector('#gbtn2'), { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'continue_with', locale: 'pt-BR' }); } catch (e) { f.querySelector('#gbtn2').textContent = 'Sem internet agora.'; }
}

/* ================================================================== */
/* Telas                                                                */
function pintaTopo() {
  const net = $('#net'), fila = ST.fila.length, precisaLogin = ST.sessao && !tokenValido() && ST.online && !renovando;
  net.className = 'net' + (!ST.online ? ' off' : '') + (enviando ? ' env' : '') + (precisaLogin ? ' entrar' : '');
  net.querySelector('span').textContent = enviando ? 'Enviando…' : !ST.online ? (fila ? `Sem internet · ${fila}` : 'Sem internet') : precisaLogin ? (fila ? `Entrar para enviar · ${fila}` : 'Entrar de novo') : fila ? `Na fila · ${fila}` : 'Conectado';
  net.onclick = precisaLogin ? folhaLogin : null;
  const bol = $('#bolinha'), n = fila + ST.recusados.length; bol.hidden = !n; bol.textContent = n;
}
function tela() {
  pintaTopo();
  if (!ST.sessao) { telaLogin(); return; }
  document.querySelectorAll('.login').forEach(x => x.remove());
  if (!ST.dados) { telaSemDados(); return; }
  // (index.html antigo sem alguma aba não pode travar o app)
  const ap = $('#abaPers'), ar = $('#abaRel');
  if (ap) ap.hidden = !temPersonal(); if (ST.aba === 'pers' && !(ap && temPersonal())) ST.aba = 'novo';
  if (ar) ar.hidden = !(temRelatorios() || temRdv()); if (ST.aba === 'rel' && !(ar && (temRelatorios() || temRdv()))) ST.aba = 'novo';
  document.querySelectorAll('[data-aba]').forEach(b => b.setAttribute('aria-current', b.dataset.aba === ST.aba ? 'page' : 'false'));
  $('#titulo').firstChild.textContent = ST.aba === 'novo' ? (R && R.id ? 'Editar lançamento' : 'Novo lançamento') : ST.aba === 'lista' ? 'Lançamentos' : ST.aba === 'pers' ? 'Personal' : ST.aba === 'rel' ? 'RDV' : 'Conta';
  $('#quem').textContent = ST.dados.usuario ? ST.dados.usuario.nome : '';
  if (ST.aba === 'novo') telaNovo(); else if (ST.aba === 'lista') telaLista(); else if (ST.aba === 'pers') telaPers(); else if (ST.aba === 'rel') telaRel(); else telaConta();
}
const faixaTeste = () => ST.dados.modoTeste ? '<div class="faixa" role="note"><span><b>Modo teste.</b> O que for lançado aqui fica no app e no painel, mas ainda não entra na conciliação nem na DRE.</span></div>' : '';

/* ---------- formulário de lançamento ---------- */
const novoRascunho = () => ({ id: null, versao: null, data: agoraLocal(), valor: 0, desc: '', estabId: '', formaId: '', parcelas: 1, obs: '', foto: null, miniatura: null, fotoId: '', tirarFoto: false, dividir: false, partes: [parteVazia()] });
const parteVazia = () => ({ planoId: '', valor: 0, viagemId: '', unidadeId: '', verba: false, valorVerba: 0, fazendaId: '' });
const somaPartes = () => R.partes.reduce((a, p) => a + (p.valor || 0), 0);
const salvaRascunho = () => { guardar('rascunho'); };
const planoNome = id => (planoPorId(id) || {}).nome || '';

function chipsDe(k, i, campo, atual) {
  return lista(k).filter(x => x.ativo || x.id === atual).map(x => `<button type="button" class="chip" data-x="${i}|${campo}|${esc(x.id)}" aria-pressed="${x.id === atual}">${esc(x.valor)}</button>`).join('');
}
function telaNovo() {
  if (!R) R = novoRascunho();
  const resto = R.valor - somaPartes(), forma = formaNome(R.formaId);
  const partesHtml = R.partes.map((p, i) => {
    const ex = extrasDe(p.planoId);
    return `<div class="parte${R.dividir ? ' dividida' : ''}">
      <div class="parte-cab">${R.dividir ? `<span class="n">${i + 1}</span>` : ''}<button type="button" class="sel" data-plano="${i}" aria-haspopup="dialog"><span class="${p.planoId ? '' : 'vazio'}">${esc(planoNome(p.planoId) || 'Escolher plano de contas')}</span>${CHEV}</button>
        ${R.dividir && R.partes.length > 1 ? `<button type="button" class="ic" data-tirar="${i}" aria-label="Tirar a parte ${i + 1}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>` : ''}</div>
      ${R.dividir ? `<div class="parte-valor"><input inputmode="numeric" data-pval="${i}" value="${brl(p.valor || 0)}" aria-label="Valor da parte ${i + 1}"></div>` : ''}
      ${ex.viagem ? `<div class="reemb"><span class="tag">Reembolsável</span>
        <div class="campo"><span class="rot">Tipo de despesa de viagem *</span><div class="chips">${chipsDe('tipo_viagem', i, 'viagemId', p.viagemId)}</div></div>
        ${ex.farid ? `<div class="campo"><span class="rot">Unidade Farid *</span><div class="chips">${chipsDe('unidade_farid', i, 'unidadeId', p.unidadeId)}</div></div>
        <div class="campo"><span class="rot">Verba diretor</span><div class="chips">${['Não', 'Sim'].map(v => `<button type="button" class="chip" data-x="${i}|verba|${v}" aria-pressed="${(p.verba ? 'Sim' : 'Não') === v}">${v}</button>`).join('')}</div>
          ${p.verba ? `<div class="campo verba"><label class="rot" for="verba${i}">Valor da verba diretor</label><input inputmode="numeric" class="busca" id="verba${i}" data-verba="${i}" value="${brl(p.valorVerba || 0)}" aria-describedby="verbaMsg${i}"><span class="verba-msg" id="verbaMsg${i}"></span></div>` : ''}</div>` : ''}</div>` : ''}
      ${ex.fazenda ? `<div class="reemb"><div class="campo"><span class="rot">Tipo de despesa da fazenda</span><div class="chips">${chipsDe('tipo_fazenda', i, 'fazendaId', p.fazendaId)}</div></div></div>` : ''}
    </div>`;
  }).join('');
  const foto = R.miniatura ? `<img src="${R.miniatura}" alt="Foto do comprovante">` : R.fotoId && !R.tirarFoto ? '<span class="tag">Comprovante salvo</span>' : '';
  const temFoto = R.miniatura || (R.fotoId && !R.tirarFoto);
  const descs = [...new Set(vista().lanc.filter(l => l.dono === eu()).map(l => l.desc))].slice(0, 60);
  $('#corpo').innerHTML = `${faixaTeste()}
  <div class="cartao">
    <div class="valor-box"><span class="rot">Valor total</span><input class="valor-in" id="valor" inputmode="numeric" value="${brl(R.valor)}" aria-label="Valor total"></div>
    <div class="campo"><label class="rot" for="desc">Descrição</label><input type="text" id="desc" value="${esc(R.desc)}" placeholder="Ex.: Supermercado, almoço com cliente" list="descs" autocomplete="off" maxlength="200"><datalist id="descs">${descs.map(d => `<option value="${esc(d)}">`).join('')}</datalist></div>
    <div class="campo"><span class="rot">${R.dividir ? 'Planos de contas' : 'Plano de contas'}</span>
      <div class="partes">${partesHtml}</div>
      ${R.dividir ? `<div class="resto ${resto === 0 ? 'ok' : resto < 0 ? 'neg' : ''}" role="status"><span>${resto === 0 ? 'Distribuído ✓' : resto > 0 ? 'Falta distribuir ' + brl(resto) : 'Passou do total em ' + brl(-resto)}</span><button type="button" id="ajusta" ${resto === 0 ? 'hidden' : ''}>Ajustar última parte</button></div>
        ${R.partes.length < 10 ? `<button type="button" class="btn sec" id="addParte"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M12 5v14M5 12h14"/></svg>Adicionar parte</button>` : ''}
        <button type="button" class="btn" id="juntar" style="color:var(--muted);min-height:36px">Voltar para um plano só</button>`
      : `<button type="button" class="btn ouro" id="dividir"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v7M12 10l-6 6v5M12 10l6 6v5"/></svg>Dividir em planos</button>`}
    </div>
  </div>
  <div class="cartao">
    <div class="campo"><span class="rot">Forma de pagamento</span><button type="button" class="sel" id="forma" aria-haspopup="dialog"><span class="${forma ? '' : 'vazio'}">${esc(forma || 'Escolher')}</span>${CHEV}</button></div>
    ${ehCredito(forma) ? `<div class="campo"><span class="rot">Parcelas</span><div class="passo"><button type="button" id="pmenos" aria-label="Menos parcelas">−</button><b id="parcTxt">${txtParc()}</b><button type="button" id="pmais" aria-label="Mais parcelas">+</button></div></div>` : ''}
    <div class="campo"><span class="rot">Estabelecimento</span><button type="button" class="sel" id="estab" aria-haspopup="dialog"><span class="${R.estabId ? '' : 'vazio'}">${esc(nomeOpcao('estabelecimento', R.estabId) || 'Escolher (opcional)')}</span>${CHEV}</button></div>
    <div class="campo"><label class="rot" for="data">Data e hora</label><input type="datetime-local" id="data" value="${esc(R.data)}"></div>
    <div class="campo"><span class="rot">Comprovante</span><div class="foto">${foto}
      <label class="btn sec" for="fotoCam"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>Câmera</label>
      <label class="btn sec" for="fotoIn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M21 16l-5-5-8 8"/></svg>Galeria</label>
      ${temFoto ? '<button type="button" class="ic" id="tiraFoto" aria-label="Remover a foto"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg></button>' : ''}
      <input type="file" id="fotoCam" accept="image/*" capture="environment" hidden><input type="file" id="fotoIn" accept="image/*" hidden></div></div>
    <div class="campo"><label class="rot" for="obs">Observação</label><textarea id="obs" placeholder="Opcional" maxlength="500">${esc(R.obs)}</textarea></div>
  </div>
  <div style="display:flex;flex-direction:column;gap:8px;margin-top:14px">
    ${R.id && R.dono && R.dono !== eu() ? `<div class="faixa" role="note"><span>Alterando como <b>administrador</b> o lançamento de <b>${esc(R.donoNome || '')}</b>. Ele continua sendo de ${esc(R.donoNome || '')}; o histórico registra a sua alteração.</span></div>` : ''}
    <button type="button" class="btn pri" id="salvar">${R.id ? 'Salvar alterações' : 'Salvar lançamento'}</button>
    ${R.id ? `<button type="button" class="btn sec" id="cancelarEd">Cancelar edição</button>` : ''}
    <span class="mini" id="erro" role="alert" style="text-align:center;color:var(--neg);font-weight:700"></span>
  </div>`;
  ligarNovo();
}
/** Campo de dinheiro: os dígitos entram pela direita (como na maquininha). Ao tocar no campo, o que se digita começa do zero. */
function dinheiro(el, set) {
  let novo = true, c = centsDe(el.value);
  const pinta = () => { el.value = brl(c); set(c); try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { } };
  el.onfocus = () => { novo = true; c = centsDe(el.value); setTimeout(() => { if (document.activeElement === el && novo) el.select(); }); };
  el.addEventListener('beforeinput', e => {
    const t = e.inputType;
    if (t === 'insertText' && e.data && /^\d+$/.test(e.data)) { e.preventDefault(); c = Math.min(99999999999, (novo ? 0 : c) * Math.pow(10, e.data.length) + parseInt(e.data, 10)); novo = false; pinta(); }
    else if (t === 'deleteContentBackward' || t === 'deleteContentForward') { e.preventDefault(); c = novo ? 0 : Math.floor(c / 10); novo = false; pinta(); }
    else if (t === 'insertText') e.preventDefault();
  });
  el.oninput = () => { c = centsDe(el.value); novo = false; pinta(); };   // colar, ou teclado que não avisa antes
}
function ligarNovo() {
  const ref = () => { salvaRascunho(); tela(); };
  dinheiro($('#valor'), c => { R.valor = c; if (!R.dividir) R.partes[0].valor = c; salvaRascunho(); atualizarResto(); });
  $('#desc').oninput = e => { R.desc = e.target.value; salvaRascunho(); };
  $('#obs').oninput = e => { R.obs = e.target.value; salvaRascunho(); };
  $('#data').onchange = e => { R.data = e.target.value; salvaRascunho(); };
  document.querySelectorAll('[data-plano]').forEach(b => b.onclick = async () => {
    const i = +b.dataset.plano;
    const v = await escolher('Plano de contas', itensPlanos(), R.partes[i].planoId, { recentes: recentes() });
    if (v == null) return;
    Object.assign(R.partes[i], { planoId: v, viagemId: '', unidadeId: '', verba: false, valorVerba: 0, fazendaId: '' }); ref();
  });
  document.querySelectorAll('[data-pval]').forEach(el => dinheiro(el, c => { R.partes[+el.dataset.pval].valor = c; salvaRascunho(); atualizarResto(); }));
  document.querySelectorAll('[data-x]').forEach(b => b.onclick = () => {
    const [i, k, v] = b.dataset.x.split('|'), p = R.partes[+i];
    if (k === 'verba') { p.verba = v === 'Sim'; if (!p.verba) p.valorVerba = 0; }
    else p[k] = p[k] === v ? '' : v;
    ref();
  });
  document.querySelectorAll('[data-verba]').forEach(el => dinheiro(el, c => { R.partes[+el.dataset.verba].valorVerba = c; salvaRascunho(); checarVerba(); }));
  checarVerba();
  document.querySelectorAll('[data-tirar]').forEach(b => b.onclick = () => { R.partes.splice(+b.dataset.tirar, 1); ref(); });
  const dv = $('#dividir'); if (dv) dv.onclick = () => { R.dividir = true; R.partes[0].valor = R.valor; R.partes.push(parteVazia()); ref(); setTimeout(() => { const ins = document.querySelectorAll('[data-pval]'); if (ins[0]) ins[0].focus(); }, 50); };
  const ad = $('#addParte'); if (ad) ad.onclick = () => { R.partes.push(Object.assign(parteVazia(), { valor: Math.max(0, R.valor - somaPartes()) })); ref(); };
  const ju = $('#juntar'); if (ju) ju.onclick = () => { R.dividir = false; R.partes = [Object.assign(R.partes.find(p => p.planoId) || R.partes[0], { valor: R.valor })]; ref(); };
  const aj = $('#ajusta'); if (aj) aj.onclick = () => { if (R.valor === somaPartes()) return; const ult = R.partes[R.partes.length - 1]; ult.valor = Math.max(0, ult.valor + (R.valor - somaPartes())); ref(); };
  $('#forma').onclick = async () => { const v = await escolher('Forma de pagamento', itensLista('forma', R.formaId), R.formaId); if (v == null) return; R.formaId = v; if (!ehCredito(formaNome(v))) R.parcelas = 1; ref(); };
  $('#estab').onclick = async () => { const v = await escolher('Estabelecimento', itensLista('estabelecimento', R.estabId, true), R.estabId, { limpar: 'Sem estabelecimento' }); if (v == null) return; R.estabId = v; ref(); };
  const pm = $('#pmenos'), pM = $('#pmais');
  if (pm) { pm.onclick = () => { R.parcelas = Math.max(1, R.parcelas - 1); ref(); }; pM.onclick = () => { R.parcelas = Math.min(24, R.parcelas + 1); ref(); }; }
  const pegaFoto = async e => { const f = e.target.files[0]; if (!f) return; try { const r = await prepararFoto(f); R.foto = r.foto; R.miniatura = r.mini; R.tirarFoto = false; ref(); } catch (er) { $('#erro').textContent = 'Não consegui abrir essa foto.'; } };
  $('#fotoIn').onchange = pegaFoto; $('#fotoCam').onchange = pegaFoto;
  const tf = $('#tiraFoto'); if (tf) tf.onclick = () => { R.foto = null; R.miniatura = null; R.tirarFoto = !!R.fotoId; ref(); };
  const ce = $('#cancelarEd'); if (ce) ce.onclick = () => { R = novoRascunho(); salvaRascunho(); ST.aba = 'lista'; tela(); };
  $('#salvar').onclick = salvar;
}
/** Foto do comprovante: reduzida no próprio celular (até 1600 px) e uma miniatura para mostrar. */
function prepararFoto(arq) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(arq), img = new Image();
    img.onload = () => {
      const faz = max => { const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', max > 400 ? 0.72 : 0.7); };
      try { res({ foto: faz(1600), mini: faz(320) }); } catch (e) { rej(e); } finally { URL.revokeObjectURL(url); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('foto')); };
    img.src = url;
  });
}
const valorDaParte = i => R.dividir ? (R.partes[i].valor || 0) : R.valor;
/** Verba diretor: o valor não pode passar do que está alocado no plano da Unidade Farid. */
function checarVerba() {
  document.querySelectorAll('[data-verba]').forEach(el => {
    const i = +el.dataset.verba, v = R.partes[i].valorVerba || 0, max = valorDaParte(i), msg = $('#verbaMsg' + i), passou = v > max, nome = planoNome(R.partes[i].planoId);
    el.setAttribute('aria-invalid', passou); msg.className = 'verba-msg' + (passou ? ' erro' : '');
    msg.textContent = passou ? `Passou do valor em ${nome} (${brl(max)}). Diminua para até ${brl(max)}.` : `Até ${brl(max)}: o valor em ${nome}.`;
  });
}
const txtParc = () => R.parcelas === 1 ? 'À vista' : R.parcelas + '× de ' + brl(Math.round(R.valor / R.parcelas));
function atualizarResto() {
  const pt = $('#parcTxt'); if (pt) pt.textContent = txtParc(); checarVerba();
  if (!R.dividir) return; const r = $('.resto'), resto = R.valor - somaPartes(); if (!r) return;
  r.className = 'resto ' + (resto === 0 ? 'ok' : resto < 0 ? 'neg' : '');
  r.querySelector('span').textContent = resto === 0 ? 'Distribuído ✓' : resto > 0 ? 'Falta distribuir ' + brl(resto) : 'Passou do total em ' + brl(-resto);
  const aj = $('#ajusta'); if (aj) aj.hidden = resto === 0;
}
const recentes = () => { const c = {}; vista().lanc.filter(l => l.dono === eu()).slice(0, 80).forEach(l => l.partes.forEach(p => { if (planoPorId(p.planoId) && planoPorId(p.planoId).ativo) c[p.planoId] = (c[p.planoId] || 0) + 1; })); return Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]); };
function itensPlanos(incluir) {
  return planos().filter(p => p.ativo || p.id === incluir).map(p => ({ v: p.id, t: p.nome, tag: extrasDe(p.id).viagem ? 'reembolsável' : p.tipo === 'receita' ? 'receita' : '' }))
    .sort((a, b) => a.t.localeCompare(b.t, 'pt-BR'));
}
const itensLista = (k, atual, ordenar) => { const l = lista(k).filter(x => x.ativo || x.id === atual).map(x => ({ v: x.id, t: x.valor })); return ordenar ? l.sort((a, b) => a.t.localeCompare(b.t, 'pt-BR')) : l; };

async function salvar() {
  const erro = m => { $('#erro').textContent = m; };
  if (!R.valor) return erro('Informe o valor.');
  if (!R.desc.trim()) return erro('Informe a descrição.');
  if (R.partes.some(p => !p.planoId)) return erro(R.dividir ? 'Escolha o plano de cada parte.' : 'Escolha o plano de contas.');
  if (new Set(R.partes.map(p => p.planoId)).size !== R.partes.length) return erro('Cada parte precisa de um plano diferente.');
  if (R.dividir && R.partes.some(p => !p.valor)) return erro('Informe o valor de cada parte.');
  if (R.dividir && somaPartes() !== R.valor) return erro('A soma das partes precisa fechar o total de ' + brl(R.valor) + '.');
  const vb = R.partes.findIndex((p, i) => extrasDe(p.planoId).farid && p.verba && (!p.valorVerba || p.valorVerba > valorDaParte(i)));
  const semTipo = R.partes.findIndex(p => extrasDe(p.planoId).viagem && !p.viagemId);
  if (semTipo >= 0) return erro(R.dividir ? `Escolha o tipo de despesa de viagem em ${planoNome(R.partes[semTipo].planoId)}.` : 'Escolha o tipo de despesa de viagem.');
  const semUni = R.partes.findIndex(p => extrasDe(p.planoId).farid && !p.unidadeId);
  if (semUni >= 0) return erro('Escolha a Unidade Farid.');
  if (vb >= 0) { const p = R.partes[vb]; return erro(!p.valorVerba ? 'Informe o valor da verba diretor.' : `A verba diretor (${brl(p.valorVerba)}) não pode passar do valor em ${planoNome(p.planoId)} (${brl(valorDaParte(vb))}).`); }
  if (!R.formaId) return erro('Escolha a forma de pagamento.');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(R.data)) return erro('Informe a data e a hora.');
  const id = R.id || uuid();
  const partes = (R.dividir ? R.partes : [Object.assign({}, R.partes[0], { valor: R.valor })]).map(p => {
    const ex = extrasDe(p.planoId);
    return { planoId: p.planoId, valor: p.valor, viagemId: ex.viagem ? p.viagemId : '', unidadeId: ex.farid ? p.unidadeId : '', verba: ex.farid && p.verba, valorVerba: ex.farid && p.verba ? p.valorVerba : 0, fazendaId: ex.fazenda ? p.fazendaId : '' };
  });
  const dados = { id, data: R.data, valor: R.valor, desc: R.desc.trim(), estabId: R.estabId, formaId: R.formaId, parcelas: ehCredito(formaNome(R.formaId)) ? R.parcelas : 1, obs: R.obs.trim(), partes };
  if (R.foto) dados.foto = R.foto; else if (R.tirarFoto) dados.tirarFoto = true;
  // versão: a que o painel tinha quando a edição começou; se o lançamento ainda está na fila, a que o painel devolver
  const naFila = ST.fila.some(o => o.tipo === 'salvar' && o.dados.id === id);
  const op = { tipo: 'salvar', dados, miniatura: R.miniatura || '' };
  if (R.id && naFila) op.seguir = true; else if (R.id && R.versao) dados.versao = R.versao;
  ST.recusados = ST.recusados.filter(x => x.dados.id !== id);
  const editando = !!R.id, semNet = !ST.online || !tokenValido();
  R = novoRascunho(); await guardar('rascunho', 'recusados');
  animSalvo(semNet, editando);
  await enfileirar(op);
}
function animSalvo(off, ed) {
  const teste = ST.dados && ST.dados.modoTeste;
  const el = document.createElement('div'); el.className = 'salvo'; el.setAttribute('role', 'status');
  el.innerHTML = `<div class="c"><svg viewBox="0 0 120 90" aria-hidden="true">
    <rect x="22" y="34" width="76" height="50" rx="10" fill="${off ? '#FFF3DF' : '#E7F5EC'}" stroke="${off ? '#A86200' : '#1E7F4F'}" stroke-width="2"/>
    <g class="moeda"><rect x="42" y="18" width="36" height="20" rx="4" fill="#E9B23A" stroke="#8A5506"/></g>
    <g class="moeda m2"><rect x="36" y="4" width="36" height="20" rx="4" fill="#F6D06A" stroke="#8A5506"/></g>
    <g class="okc"><circle cx="96" cy="30" r="13" fill="${off ? '#A86200' : '#1E7F4F'}"/>${off ? '<path d="M96 23v8M96 35v1" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' : '<path d="M90 30l4 4 8-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'}</g></svg>
    <b>${off ? 'Guardado no celular' : ed ? 'Alterações salvas' : 'Lançamento salvo'}</b><span>${off ? 'Será enviado sozinho quando a conexão voltar.' : teste ? 'Enviando para o painel (modo teste: fora da conciliação).' : 'Enviando para o painel.'}</span></div>`;
  $('#app').appendChild(el); setTimeout(() => el.remove(), reduz() ? 900 : 1700);
}

/* ---------- lista e consulta ---------- */
const mesesDe = ls => [...new Set(ls.map(l => l.data.slice(0, 7)).concat([hojeISO().slice(0, 7)]))].sort().reverse();
function filtrados(ls) {
  const F = ST.filtro, q = F.q.trim().toLowerCase();
  return ls.filter(l => l.data.slice(0, 7) === F.mes && ((veTodos() && F.quem === 'todos') || l.dono === eu()) && (!F.plano || l.partes.some(p => p.planoId === F.plano)) && (!F.forma || l.formaId === F.forma)
    && (!q || [l.desc, nomeOpcao('estabelecimento', l.estabId), l.partes.map(p => planoNome(p.planoId) || p.plano).join(' '), l.obs, formaNome(l.formaId)].join(' ').toLowerCase().includes(q)))
    .sort((a, b) => b.data.localeCompare(a.data));
}
const valorFiltrado = l => ST.filtro.plano ? l.partes.filter(p => p.planoId === ST.filtro.plano).reduce((a, p) => a + p.valor, 0) : l.valor;
const etiqueta = l => l.status === 'fila' ? '<span class="st fila">Aguardando envio</span>' : l.status === 'erro' ? '<span class="st erro">Não aceito</span>' : l.status === 'ok' ? '<span class="st ok">Na fatura ✓</span>' : '<span class="st esp">Aguardando fatura</span>';
function telaLista() {
  const F = ST.filtro, V = vista(), meses = mesesDe(V.lanc);
  if (!meses.includes(F.mes)) F.mes = meses[0];
  const ls = filtrados(V.lanc), tot = ls.reduce((a, l) => a + valorFiltrado(l), 0), recus = V.lanc.filter(l => l.status === 'erro');
  const porDia = {}; ls.forEach(l => { (porDia[l.data.slice(0, 10)] = porDia[l.data.slice(0, 10)] || []).push(l); });
  const nomeDia = d => new Date(d + 'T12:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' }).replace('.', '');
  const fNome = formaNome(F.forma);
  $('#corpo').innerHTML = `
  ${recus.length ? `<div class="faixa erro" role="alert"><span><b>${recus.length} lançamento${recus.length === 1 ? '' : 's'} não aceito${recus.length === 1 ? '' : 's'} pelo painel.</b> Toque para corrigir.</span><button type="button" data-ver="${esc(recus[0].id)}">Ver</button></div>` : ''}
  <div class="filtros">
    <div class="meses" role="group" aria-label="Mês">${meses.map(m => `<button type="button" class="chip" data-mes="${m}" aria-pressed="${m === F.mes}">${MES[+m.slice(5) - 1].replace(/^./, c => c.toUpperCase())} ${m.slice(0, 4)}</button>`).join('')}</div>
    <input type="search" class="busca" id="q" placeholder="Buscar descrição, plano ou estabelecimento" value="${esc(F.q)}" aria-label="Buscar">
    <div class="chips">
      ${veTodos() ? `<div class="seg" style="flex:1"><button type="button" data-quem="todos" aria-pressed="${F.quem === 'todos'}">Todos</button><button type="button" data-quem="meus" aria-pressed="${F.quem === 'meus'}">Meus</button></div>` : ''}
      <button type="button" class="chip" id="fPlano" aria-pressed="${!!F.plano}">${esc(planoNome(F.plano) || 'Plano')} ▾</button>
      <button type="button" class="chip" id="fForma" aria-pressed="${!!F.forma}">${esc(fNome ? fNome.replace('Cartão de Crédito ', '').replace(/[()]/g, '') : 'Pagamento')} ▾</button>
    </div>
  </div>
  <div class="resumo"><div><small>${ls.length} lançamento${ls.length === 1 ? '' : 's'}${F.plano ? ' · só a parte de ' + esc(planoNome(F.plano)) : ''}</small><b>${brl(tot)}</b></div>${ls.length ? `<button type="button" class="pp-btn" id="porPlano" aria-haspopup="dialog"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Por plano</button>` : `<small>${ST.online ? (veTodos() ? 'Lançamentos do app' : 'Seus lançamentos') : 'Cópia salva no celular'}</small>`}</div>
  ${Object.keys(porDia).length ? Object.entries(porDia).map(([d, l]) => `<div class="dia"><span>${nomeDia(d)}</span><span>${brl(l.reduce((a, x) => a + valorFiltrado(x), 0))}</span></div>${l.map(x => `
    <button type="button" class="item" data-ver="${esc(x.id)}"><span class="av ${x.dono === eu() ? '' : 'g'}" title="${esc(x.usuario)}">${esc((x.usuario || '?')[0])}</span>
      <span class="txt"><b>${esc(x.desc)}</b><small>${esc(x.partes.map(p => planoNome(p.planoId) || p.plano).join(' + '))}${x.partes.length > 1 ? ' · dividida' : ''}</small><small>${esc(formaNome(x.formaId))}${x.parcelas > 1 ? ' · ' + x.parcelas + '×' : ''}</small></span>
      <span class="dir"><b>${brl(valorFiltrado(x))}</b><br>${etiqueta(x)}</span></button>`).join('')}`).join('')
    : '<div class="vazio">Nenhum lançamento com esses filtros.</div>'}`;
  document.querySelectorAll('[data-mes]').forEach(b => b.onclick = () => { F.mes = b.dataset.mes; tela(); });
  document.querySelectorAll('[data-quem]').forEach(b => b.onclick = () => { F.quem = b.dataset.quem; tela(); });
  $('#q').oninput = e => { F.q = e.target.value; tela(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); };
  $('#fPlano').onclick = async () => { const v = await escolher('Filtrar por plano', itensPlanos(F.plano), F.plano, { limpar: 'Todos os planos' }); if (v == null) return; F.plano = v; tela(); };
  $('#fForma').onclick = async () => { const v = await escolher('Filtrar por pagamento', itensLista('forma', F.forma), F.forma, { limpar: 'Todas as formas' }); if (v == null) return; F.forma = v; tela(); };
  document.querySelectorAll('[data-ver]').forEach(b => b.onclick = () => detalhe(vista().lanc.find(l => l.id === b.dataset.ver)));
  const pp = $('#porPlano'); if (pp) pp.onclick = folhaPorPlano;
}
const fotos = {};   // fotos já baixadas nesta abertura
function detalhe(l) {
  if (!l) return;
  const meu = l.dono === eu(), pode = meu || ehAdmin(), d = new Date(l.data);
  const extras = p => [p.viagemId && ['Despesa de viagem', nomeOpcao('tipo_viagem', p.viagemId)], p.unidadeId && ['Unidade Farid', nomeOpcao('unidade_farid', p.unidadeId)],
    p.unidadeId && ['Verba diretor', p.verba ? 'Sim · ' + brl(p.valorVerba) : 'Não'], p.fazendaId && ['Tipo fazenda', nomeOpcao('tipo_fazenda', p.fazendaId)]].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('');
  const tag = l.status === 'fila' ? '<span class="tag" style="background:var(--warn-bg);color:var(--warn)">Aguardando envio · guardado no celular</span>'
    : l.status === 'erro' ? `<div class="faixa erro" role="alert"><span><b>Não aceito pelo painel:</b> ${esc(l.erro)}</span></div>`
      : l.status === 'ok' ? '<span class="tag" style="background:var(--ok-bg);color:var(--ok)">Encontrado na fatura/extrato</span>' : '<span class="tag" style="background:var(--soft);color:var(--muted)">Aguardando a fatura/extrato chegar no painel</span>';
  const f = abrirFolha(`<div class="folha-cab"><h3>${esc(l.desc)}<span>${brl(l.valor)}</span></h3></div><div class="folha-corpo det">
    ${tag}
    <dl><dt>Data</dt><dd>${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</dd><dt>Lançado por</dt><dd>${esc(l.usuario)}</dd>${l.alteradoPor ? `<dt>Alterado por</dt><dd>${esc(l.alteradoPor)}</dd>` : ''}
      <dt>Pagamento</dt><dd>${esc(formaNome(l.formaId))}${l.parcelas > 1 ? ' · ' + l.parcelas + '×' : ''}</dd>${l.estabId ? `<dt>Estabelecimento</dt><dd>${esc(nomeOpcao('estabelecimento', l.estabId))}</dd>` : ''}${l.obs ? `<dt>Observação</dt><dd>${esc(l.obs)}</dd>` : ''}</dl>
    <div class="cartao" style="padding:12px"><span class="rot">${l.partes.length > 1 ? 'Dividida em ' + l.partes.length + ' planos' : 'Plano de contas'}</span>
      ${l.partes.map(p => `<dl><dt style="color:var(--navy);font-weight:800">${esc(planoNome(p.planoId) || p.plano)}</dt><dd>${brl(p.valor)}</dd>${extras(p)}</dl>`).join('<hr style="border:0;border-top:1px dashed var(--line);margin:4px 0">')}</div>
    <div id="fotoDet">${l.miniatura ? `<img src="${l.miniatura}" alt="Comprovante" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">` : l.fotoId ? (fotos[l.id] ? `<img src="${fotos[l.id]}" alt="Comprovante" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">` : '<button type="button" class="btn sec" id="verFoto" style="width:100%">Ver comprovante</button>') : ''}</div>
    ${l.status !== 'fila' && l.status !== 'erro' ? `<button type="button" class="btn sec" id="verHist" style="width:100%">Histórico de alterações</button><div id="hist" aria-live="polite"></div>` : ''}
    ${!meu && pode && l.status !== 'erro' ? '<span class="mini" style="text-align:center">Você é administrador: pode alterar este lançamento. Ele continua sendo de ' + esc(l.usuario) + '.</span>' : ''}
    ${pode ? `<div class="acoes"><button type="button" class="btn sec" id="ed">${l.status === 'erro' ? 'Corrigir' : 'Editar'}</button><button type="button" class="btn neg" id="ex">${l.status === 'erro' ? 'Descartar' : 'Excluir'}</button></div>` : `<span class="mini" style="text-align:center">Lançado por ${esc(l.usuario)}: só quem lançou pode alterar.</span>`}
  </div>`);
  const vf = f.querySelector('#verFoto');
  if (vf) vf.onclick = async () => {
    vf.textContent = 'Carregando…'; vf.disabled = true;
    try { const r = await api('foto', { id: l.id }); fotos[l.id] = r.foto; f.querySelector('#fotoDet').innerHTML = `<img src="${r.foto}" alt="Comprovante" style="max-width:100%;border-radius:12px;border:1px solid var(--line)">`; }
    catch (e) { vf.disabled = false; vf.textContent = e.rede ? 'Sem internet: tente depois' : e.login ? 'Entre de novo para ver' : e.message; }
  };
  const vh = f.querySelector('#verHist');
  if (vh) vh.onclick = async () => {
    const box = f.querySelector('#hist'); vh.disabled = true; vh.textContent = 'Carregando o histórico…';
    try {
      const r = await api('historico', { id: l.id });
      vh.remove();
      box.innerHTML = r.historico.length ? `<div class="cartao" style="padding:12px"><span class="rot">Histórico de alterações</span><ol class="hist">${r.historico.map(h => `<li>
        <span class="hq">${esc(dataHoraBR(h.quando))} · <b>${esc(h.quem)}</b></span>
        <span class="hc">${esc(h.campo)}${h.antes !== '' ? `: <s>${esc(h.antes)}</s> → ${esc(h.depois)}` : `: ${esc(h.depois)}`}</span></li>`).join('')}</ol></div>`
        : '<span class="mini">Nenhuma alteração registrada.</span>';
    } catch (e) { vh.disabled = false; vh.textContent = e.rede ? 'Sem internet: tente depois' : e.login ? 'Entre de novo para ver' : e.message; }
  };
  if (!pode) return;
  f.querySelector('#ed').onclick = () => {
    fecharFolha();
    R = { id: l.id, dono: l.dono, donoNome: l.usuario, versao: l.status === 'fila' || l.status === 'erro' ? (ST.dados.lancamentos.find(x => x.id === l.id) || {}).versao || null : l.versao, data: l.data, valor: l.valor, desc: l.desc, estabId: l.estabId, formaId: l.formaId, parcelas: l.parcelas, obs: l.obs,
      foto: null, miniatura: l.miniatura || null, fotoId: l.fotoId || '', tirarFoto: false, dividir: l.partes.length > 1, partes: l.partes.map(p => Object.assign(parteVazia(), p)) };
    // foto nova ainda na fila: continua indo junto
    const op = ST.fila.concat(ST.recusados).filter(o => o.tipo === 'salvar' && o.dados.id === l.id).pop(); if (op && op.dados.foto) R.foto = op.dados.foto;
    salvaRascunho(); ST.aba = 'novo'; tela(); $('#corpo').scrollTop = 0;
  };
  f.querySelector('#ex').onclick = async () => {
    const b = f.querySelector('#ex'); if (!b.dataset.c) { b.dataset.c = 1; b.textContent = l.status === 'erro' ? 'Toque de novo para descartar' : 'Toque de novo para excluir'; return; }
    fecharFolha();
    await excluir(l);
  };
}
async function excluir(l) {
  const noPainel = ((ST.dados && ST.dados.lancamentos) || []).some(x => x.id === l.id), tentou = ST.fila.some(o => o.tipo === 'salvar' && o.dados.id === l.id && o.tentou);
  ST.recusados = ST.recusados.filter(x => x.dados.id !== l.id);
  // nunca chegou ao painel: só tira do celular
  ST.fila = ST.fila.filter(o => !(o.tipo === 'salvar' && o.dados.id === l.id && !o.tentou));
  await guardar('fila', 'recusados');
  if (noPainel || tentou) { aviso('Lançamento excluído'); await enfileirar({ tipo: 'excluir', dados: { id: l.id } }); }
  else { aviso(l.status === 'erro' ? 'Lançamento descartado' : 'Lançamento excluído'); tela(); }
}

/* ---------- Personal: aulas feitas e compra de aulas ---------- */
function resumoLocal(P, id) {
  const ls = P.lanc.filter(l => l.localId === id && !l.cancelado);
  const comp = ls.filter(l => l.tipo === 'compra').reduce((a, l) => a + l.qtd, 0), feitas = ls.filter(l => l.tipo === 'aula').reduce((a, l) => a + l.qtd, 0);
  const ult = ls.filter(l => l.tipo === 'aula').map(l => l.data).sort().pop() || ''; return { comp, feitas, saldo: comp - feitas, ult };
}
function telaPers() {
  const P = vista().pers, mes = hojeISO().slice(0, 7), ano = mes.slice(0, 4), locais = P.locais.filter(l => l.ativo);
  const ativos = P.lanc.filter(l => !l.cancelado && l.tipo === 'aula');
  const disp = locais.reduce((a, l) => a + resumoLocal(P, l.id).saldo, 0), noMes = ativos.filter(l => l.data.slice(0, 7) === mes).reduce((a, l) => a + l.qtd, 0), noAno = ativos.filter(l => l.data.slice(0, 4) === ano).reduce((a, l) => a + l.qtd, 0);
  const sit = s => s < 0 ? `<span class="st" style="background:var(--neg-bg);color:var(--neg)">Devendo ${-s}</span>` : s === 0 ? '<span class="st fila">Sem saldo</span>' : s <= 2 ? '<span class="st fila">Acabando</span>' : '<span class="st ok">Em dia</span>';
  const hist = P.lanc.slice().sort((a, b) => b.data.localeCompare(a.data) || String(b.criadoEm).localeCompare(String(a.criadoEm))).slice(0, 15);
  $('#corpo').innerHTML = `
  <div class="resumo"><div><small>Aulas disponíveis</small><b>${disp}</b></div><div style="text-align:right"><small>No mês · no ano</small><b style="font-size:17px">${noMes} · ${noAno}</b></div></div>
  ${locais.length ? locais.map(l => { const r = resumoLocal(P, l.id); return `<div class="cartao" style="margin-top:12px">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><div><b style="font-size:16px;color:var(--navy)">${esc(l.nome)}</b><div class="mini">${r.comp} compradas · ${r.feitas} feitas${r.ult ? ' · última ' + dataBR(r.ult) : ''}</div></div>
      <div style="text-align:right"><b style="font-family:var(--f-display);font-size:26px;color:${r.saldo < 0 ? 'var(--neg)' : 'var(--navy)'}">${r.saldo}</b><div>${sit(r.saldo)}</div></div></div>
    <div class="linha2"><button type="button" class="btn sec" data-paula="${esc(l.id)}">− Aula feita</button><button type="button" class="btn ouro" data-pcompra="${esc(l.id)}">+ Comprar</button></div></div>`; }).join('')
    : '<div class="vazio">Nenhum local cadastrado. Cadastre os locais no painel (Acompanhamento Personal).</div>'}
  ${hist.length ? '<div class="dia" style="margin-top:18px"><span>Últimos lançamentos</span></div>' : ''}
  ${hist.map(h => { const loc = (P.locais.find(x => x.id === h.localId) || {}).nome || ''; const canc = h.cancelado;
    return `<div class="item" style="cursor:default${canc ? ';opacity:.55' : ''}"><span class="av" style="background:${h.tipo === 'compra' ? 'var(--gold-soft)' : 'var(--soft)'}">${h.tipo === 'compra' ? '+' : '−'}</span>
      <span class="txt"><b style="${canc ? 'text-decoration:line-through' : ''}">${h.tipo === 'compra' ? `Compra de ${h.qtd} aula${h.qtd === 1 ? '' : 's'}` : `${h.qtd} aula${h.qtd === 1 ? '' : 's'} feita${h.qtd === 1 ? '' : 's'}`}</b><small>${esc(loc)} · ${dataBR(h.data)}</small></span>
      <span class="dir">${h.fila ? '<span class="st fila">Aguardando envio</span>' : canc ? '<span class="st esp">Cancelado</span>' : `<button type="button" class="chip" data-pcanc="${esc(h.id)}" style="font-size:12px">Cancelar</button>`}</span></div>`; }).join('')}
  <p class="mini" style="text-align:center;margin-top:10px">Lançamento errado é cancelado: sai do saldo e continua no histórico.</p>`;
  document.querySelectorAll('[data-paula]').forEach(b => b.onclick = () => formPers(b.dataset.paula, 'aula'));
  document.querySelectorAll('[data-pcompra]').forEach(b => b.onclick = () => formPers(b.dataset.pcompra, 'compra'));
  document.querySelectorAll('[data-pcanc]').forEach(b => b.onclick = async () => {
    if (!b.dataset.c) { b.dataset.c = 1; b.textContent = 'Confirmar?'; b.style.background = 'var(--neg-bg)'; b.style.color = 'var(--neg)'; return; }
    const id = b.dataset.pcanc;
    // ainda não enviado: só tira da fila
    const i = ST.fila.findIndex(o => o.tipo === 'personal' && !o.dados.acao && idPers(o.dados.idApp) === id && !o.tentou);
    if (i >= 0) { ST.fila.splice(i, 1); await guardar('fila'); aviso('Lançamento cancelado'); tela(); return; }
    aviso('Lançamento cancelado e mantido no histórico');
    await enfileirar({ tipo: 'personal', dados: { acao: 'cancelar', id } });
  });
}
function formPers(localId, tipo) {
  const P = vista().pers, loc = P.locais.find(l => l.id === localId), r = resumoLocal(P, localId); let qtd = tipo === 'compra' ? 10 : 1;
  const f = abrirFolha(`<div class="folha-cab"><h3>${tipo === 'compra' ? 'Comprar aulas' : 'Aula feita'}<span class="mini">${esc(loc.nome)}</span></h3></div>
    <div class="folha-corpo det">
      <span class="mini">Saldo agora: <b>${r.saldo}</b> aula${Math.abs(r.saldo) === 1 ? '' : 's'}</span>
      <div class="campo"><label class="rot" for="pdata">Data</label><input type="date" id="pdata" class="busca" value="${hojeISO()}" max="${hojeISO()}"></div>
      <div class="campo"><span class="rot">Quantidade</span><div class="passo"><button type="button" id="pqMenos" aria-label="Menos">−</button><b id="pqtd">${qtd}</b><button type="button" id="pqMais" aria-label="Mais">+</button></div>
        ${tipo === 'compra' ? `<div class="chips">${[5, 10, 12, 20].map(n => `<button type="button" class="chip" data-pn="${n}">${n} aulas</button>`).join('')}</div>` : ''}</div>
      <span class="mini" id="pdepois"></span>
      <span class="mini" id="perro" role="alert" style="color:var(--neg);font-weight:700"></span>
      <button type="button" class="btn pri" id="pok">${tipo === 'compra' ? 'Registrar compra' : 'Registrar aula'}</button>
    </div>`);
  const depois = () => { const s = r.saldo + (tipo === 'compra' ? qtd : -qtd); f.querySelector('#pdepois').innerHTML = `Saldo depois: <b style="color:${s < 0 ? 'var(--neg)' : 'var(--navy)'}">${s}</b>${s < 0 ? ' · vai ficar devendo' : ''}`; f.querySelector('#pqtd').textContent = qtd; };
  depois();
  f.querySelector('#pqMenos').onclick = () => { qtd = Math.max(1, qtd - 1); depois(); };
  f.querySelector('#pqMais').onclick = () => { qtd = Math.min(200, qtd + 1); depois(); };
  f.querySelectorAll('[data-pn]').forEach(b => b.onclick = () => { qtd = +b.dataset.pn; depois(); });
  const ok = f.querySelector('#pok');
  ok.onclick = async () => {
    const data = f.querySelector('#pdata').value;
    if (!data || data > hojeISO()) return f.querySelector('#perro').textContent = 'A data não pode ser depois de hoje.';
    if (tipo === 'aula' && r.saldo - qtd < 0 && !ok.dataset.c) { ok.dataset.c = 1; ok.textContent = 'Sem saldo: registrar mesmo assim'; ok.style.background = 'var(--warn)'; f.querySelector('#perro').textContent = `${loc.nome} ficará devendo ${qtd - r.saldo} aula${qtd - r.saldo === 1 ? '' : 's'}.`; return; }
    folhaFim = null; fecharFolha(true);
    animSalvoPers(tipo, qtd, loc.nome, !ST.online || !tokenValido());
    await enfileirar({ tipo: 'personal', dados: { idApp: uuid(), localId, tipo, qtd, data } });
  };
}
function animSalvoPers(tipo, qtd, local, off) {
  const el = document.createElement('div'); el.className = 'salvo'; el.setAttribute('role', 'status');
  el.innerHTML = `<div class="c"><svg viewBox="0 0 120 90" aria-hidden="true">
    <g class="moeda"><rect x="20" y="40" width="14" height="30" rx="3" fill="#0B1F4D"/><rect x="86" y="40" width="14" height="30" rx="3" fill="#0B1F4D"/><rect x="34" y="51" width="52" height="8" rx="4" fill="#C9962E"/><rect x="12" y="46" width="8" height="18" rx="2" fill="#173172"/><rect x="100" y="46" width="8" height="18" rx="2" fill="#173172"/></g>
    <g class="okc"><circle cx="96" cy="24" r="13" fill="${off ? '#A86200' : '#1E7F4F'}"/>${off ? '<path d="M96 17v8M96 29v1" stroke="#fff" stroke-width="3" stroke-linecap="round"/>' : '<path d="M90 24l4 4 8-8" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'}</g></svg>
    <b>${tipo === 'compra' ? `${qtd} aula${qtd === 1 ? '' : 's'} comprada${qtd === 1 ? '' : 's'}` : 'Aula registrada'}</b><span>${esc(local)}${off ? ' · guardado no celular, sobe quando a internet voltar' : ' · enviando para o painel'}</span></div>`;
  $('#app').appendChild(el); setTimeout(() => el.remove(), reduz() ? 900 : 1600);
}

/* ---------- Gastos por plano (gráfico de ranking do mês, aba Lançamentos) ---------- */
const PP = { modo: 'brl', todos: false };
/** Soma por plano dos lançamentos que estão na tela (mês, Todos/Meus, busca e forma; o filtro de plano é ignorado). Compra dividida: cada parte no seu plano. */
function gastosPorPlano() {
  const F = ST.filtro, guarda = F.plano; F.plano = '';
  const ls = filtrados(vista().lanc); F.plano = guarda;
  const g = {};
  ls.forEach(l => l.partes.forEach(p => { const k = p.planoId || p.plano; const x = g[k] = g[k] || { id: p.planoId, nome: planoNome(p.planoId) || p.plano || 'Sem plano', valor: 0, ids: new Set() }; x.valor += p.valor || 0; x.ids.add(l.id); }));
  const lista = Object.values(g).map(x => ({ id: x.id, nome: x.nome, valor: x.valor, n: x.ids.size })).sort((a, b) => b.valor - a.valor || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { lista, total: lista.reduce((a, x) => a + x.valor, 0), nLanc: ls.length };
}
const pctTxt = (v, t) => (t ? v / t * 100 : 0).toFixed(1).replace('.', ',') + '%';
const brlInt = c => 'R$ ' + Math.round(c / 100).toLocaleString('pt-BR');
function folhaPorPlano() {
  const D = gastosPorPlano(), F = ST.filtro, mesTxt = MES[+F.mes.slice(5) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + F.mes.slice(0, 4);
  const filtrosTxt = [veTodos() ? (F.quem === 'todos' ? 'Todos' : 'Meus') : 'Seus lançamentos', F.forma ? formaNome(F.forma) : '', F.q.trim() ? '“' + F.q.trim() + '”' : ''].filter(Boolean).join(' · ');
  const f = abrirFolha(`<div class="folha-cab pp-cab"><h3>Gastos por plano<small>${esc(mesTxt)} · ${esc(filtrosTxt)}</small></h3>
      <div class="seg pp-seg" role="group" aria-label="Mostrar valores em"><button type="button" data-ppm="brl" aria-pressed="${PP.modo === 'brl'}">R$</button><button type="button" data-ppm="pct" aria-pressed="${PP.modo === 'pct'}">%</button></div></div>
    <div class="folha-corpo pp-corpo" id="ppCorpo"></div>`);
  const pinta = () => {
    const max = D.lista.length ? D.lista[0].valor : 1, vis = PP.todos ? D.lista : D.lista.slice(0, 8);
    f.querySelector('#ppCorpo').innerHTML = `<div class="pp-hero"><b>${brl(D.total)}</b><span>${D.lista.length} plano${D.lista.length === 1 ? '' : 's'}<br>${D.nLanc} lançamento${D.nLanc === 1 ? '' : 's'}</span></div>
      ${vis.map((x, i) => `<button type="button" class="pp-linha${i < 3 ? ' top' : ''}" aria-expanded="false" data-ppi="${i}">
        <span class="pp-l1"><b>${esc(x.nome)}</b><span>${PP.modo === 'pct' ? pctTxt(x.valor, D.total) : brl(x.valor)}<em>${PP.modo === 'pct' ? brlInt(x.valor) : pctTxt(x.valor, D.total)}</em></span></span>
        <span class="pp-trilho" aria-hidden="true"><i style="width:${Math.max(1.5, x.valor / max * 100)}%;animation-delay:${reduz() ? 0 : i * 40}ms"></i></span>
        <span class="pp-det"><span>${x.n} lançamento${x.n === 1 ? '' : 's'} · média ${brl(Math.round(x.valor / x.n))}</span>${x.id ? `<span class="pp-ver" data-ppver="${esc(x.id)}">Ver lançamentos ›</span>` : ''}</span></button>`).join('')}
      ${!PP.todos && D.lista.length > 8 ? `<button type="button" class="pp-mais" id="ppMais">Ver mais ${D.lista.length - 8} plano${D.lista.length - 8 === 1 ? '' : 's'}</button>` : ''}
      <p class="mini" style="text-align:center;margin:12px 0 0">Compra dividida entra em cada plano só com a sua parte.</p>`;
    f.querySelectorAll('.pp-linha').forEach(b => b.onclick = e => {
      const ver = e.target.closest('[data-ppver]');
      if (ver) { ST.filtro.plano = ver.dataset.ppver; folhaFim = null; fecharFolha(); tela(); $('#corpo').scrollTop = 0; return; }
      const ab = b.getAttribute('aria-expanded') === 'true'; f.querySelectorAll('.pp-linha').forEach(x => x.setAttribute('aria-expanded', 'false')); b.setAttribute('aria-expanded', String(!ab));
    });
    const m = f.querySelector('#ppMais'); if (m) m.onclick = () => { PP.todos = true; pinta(); };
  };
  f.querySelectorAll('[data-ppm]').forEach(b => b.onclick = () => { PP.modo = b.dataset.ppm; f.querySelectorAll('[data-ppm]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); pinta(); });
  PP.todos = false; pinta();
}

/* ---------- Relatórios Farid (despesas de viagem por unidade e verba diretor) ---------- */
const MESC = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const temRelatorios = () => !!(ST.dados && ST.dados.relatorios);
const temRdv = () => !!(ST.dados && ST.dados.rdv);
/* ---------- Aba RDV: filtro de ano e mês, um ícone por relatório (Farid, Aneethun ES, Aneethun BH, UniTudo) ---------- */
/* Farid: quem tem relatórios (um PDF e um reembolso por unidade). Aneethun/UniTudo: administradores (modelo clássico). */
const RL = { mes: '', sel: null, tela: null };
const brl0 = c => 'R$ ' + String(Math.round(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const ddmm = iso => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const ddmmaaaa = iso => ddmm(iso) + '/' + iso.slice(0, 4);
const nomeMes = m => MES[+m.slice(5) - 1].replace(/^./, c => c.toUpperCase()) + ' ' + m.slice(0, 4);
const plural = (n, s, p) => n + ' ' + (n === 1 ? s : p);
function unidadesDoMes(mes) {
  const g = {};
  ST.dados.relatorios.despesas.filter(x => x.data.slice(0, 7) === mes).forEach(x => { const k = x.unidadeId || ''; (g[k] = g[k] || { id: k, nome: x.unidade || 'Sem unidade', l: [] }).l.push(x); });
  return Object.values(g).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
}
const ICONES_RDV = { farid: ['F', '#E8EEFB', '#173172'], aneethun_es: ['ES', 'var(--gold-soft)', '#7A5410'], aneethun_bh: ['BH', 'var(--gold-soft)', '#7A5410'], unitudo: ['U', 'var(--ok-bg)', 'var(--ok)'] };
/** Relatórios que esta pessoa vê, na ordem da tela. */
function gruposRdvApp() {
  const out = [];
  if (temRelatorios()) out.push({ chave: 'farid', titulo: 'Farid', achado: true });
  if (temRdv()) ST.dados.rdv.grupos.forEach(g => out.push(g));
  return out;
}
const despesasGrupo = ch => ch === 'farid' ? ST.dados.relatorios.despesas : ST.dados.rdv.despesas.filter(x => x.grupo === ch);
const reembolsoDe = (ch, mes, uid) => (ST.dados.reembolsos || []).find(r => r.grupo === ch && r.mes === mes && (ch !== 'farid' || r.unidadeId === uid)) || null;
/** O que se reembolsa no mês: Farid = cada unidade; os outros = um só. {id, nome, l, total, rec} */
function itensRdv(g, mes) {
  const its = g.chave === 'farid' ? unidadesDoMes(mes) : (() => { const l = despesasGrupo(g.chave).filter(x => x.data.slice(0, 7) === mes); return l.length ? [{ id: '', nome: g.titulo, l }] : []; })();
  its.forEach(u => { u.total = u.l.reduce((a, x) => a + x.valor, 0); u.rec = g.chave === 'farid' && !u.id ? null : reembolsoDe(g.chave, mes, u.id); });
  return its;
}
const aReceber = its => its.filter(u => !u.rec).reduce((a, u) => a + u.total, 0);
function mesesComDespesa() { const s = new Set(); gruposRdvApp().forEach(g => despesasGrupo(g.chave).forEach(x => s.add(x.data.slice(0, 7)))); return s; }

function telaRel() {
  const hoje = hojeISO().slice(0, 7), comD = mesesComDespesa();
  if (!/^\d{4}-\d{2}$/.test(RL.mes) || RL.mes > hoje) RL.mes = comD.has(hoje) || !comD.size ? hoje : [...comD].filter(m => m <= hoje).sort().pop() || hoje;
  const g = RL.tela && gruposRdvApp().find(x => x.chave === RL.tela);
  if (g) return g.chave === 'farid' ? telaRdvFarid(g) : telaRdvGrupo(g);
  RL.tela = null; telaRdvInicio(hoje, comD);
}
function telaRdvInicio(hoje, comD) {
  const gs = gruposRdvApp(), ano = RL.mes.slice(0, 4);
  const anos = [...new Set([...comD].map(m => m.slice(0, 4)).concat([hoje.slice(0, 4), ano]))].filter(a => a <= hoje.slice(0, 4)).sort();
  const tudoRecebido = m => { const its = gs.flatMap(x => itensRdv(x, m)); return its.length && its.every(u => u.rec); };
  let todos = 0; [...comD].forEach(m => gs.forEach(x => { todos += aReceber(itensRdv(x, m)); }));
  const doMes = gs.map(x => ({ g: x, its: itensRdv(x, RL.mes) })), pend = doMes.reduce((a, x) => a + aReceber(x.its), 0);
  const naFila = ST.fila.filter(o => o.tipo === 'salvar').length;
  $('#corpo').innerHTML = `
  ${naFila ? `<div class="faixa" role="note"><span><b>${plural(naFila, 'lançamento', 'lançamentos')} ainda no celular.</b> Só entram no RDV depois de enviados.</span></div>` : ''}
  <p class="rdv-rot">Ano</p>
  <div class="rdv-anos" role="group" aria-label="Ano">${anos.map(a => `<button type="button" class="chip" data-rano="${a}" aria-pressed="${a === ano}">${a}</button>`).join('')}</div>
  <p class="rdv-rot">Mês</p>
  <div class="rdv-meses" role="group" aria-label="Mês">${MESC.map((n, i) => { const m = ano + '-' + String(i + 1).padStart(2, '0'), fut = m > hoje, ok = !fut && tudoRecebido(m);
    return `<button type="button" data-rmes="${m}" aria-pressed="${m === RL.mes}" ${fut ? 'disabled' : ''} ${ok ? 'title="Tudo recebido"' : ''}>${n}${ok ? '<i aria-label="tudo recebido"></i>' : ''}</button>`; }).join('')}</div>
  <div class="rdv-grade">${doMes.map(({ g, its }) => { const ic = ICONES_RDV[g.chave] || ['•', 'var(--soft)', 'var(--navy)'], tot = its.reduce((a, u) => a + u.total, 0), rec = its.filter(u => u.rec);
    const info = !g.achado ? `<span style="color:var(--warn)">Plano “${esc(g.plano)}” não existe no painel</span>`
      : !its.length ? 'Nenhuma despesa<br>neste mês'
      : g.chave === 'farid' ? `${plural(its.length, 'unidade', 'unidades')} · ${brl(tot)}<br>${rec.length} de ${its.length} recebida${its.length === 1 ? '' : 's'}`
      : `${plural(its[0].l.length, 'despesa', 'despesas')}<br>${brl(tot)}`;
    const pill = !its.length ? '' : rec.length === its.length ? `<span class="pill ok">Recebido${its.length === 1 ? ' ' + ddmm(its[0].rec.data) : ''}</span>` : '<span class="pill warn">A receber</span>';
    return `<button type="button" class="rdv-tile" data-rvg="${esc(g.chave)}"><span class="rdv-ic" style="background:${ic[1]};color:${ic[2]}" aria-hidden="true">${ic[0]}</span><b>${esc(g.titulo)}</b><small>${info}</small>${pill}</button>`; }).join('')}</div>
  <div class="cartao" style="margin-top:12px"><div class="rdv-total"><span><b>A receber em ${MESC[+RL.mes.slice(5) - 1]}/${ano}</b><small>Todos os meses: ${brl(todos)}</small></span><b class="${pend ? 'warn' : 'ok'}">${brl(pend)}</b></div></div>
  <p class="mini" style="text-align:center">Gerar PDF e marcar recebido precisam de internet.</p>`;
  document.querySelectorAll('[data-rano]').forEach(b => b.onclick = () => { const m = b.dataset.rano + RL.mes.slice(4); RL.mes = m > hoje ? hoje : m; tela(); });
  document.querySelectorAll('[data-rmes]').forEach(b => b.onclick = () => { RL.mes = b.dataset.rmes; tela(); });
  document.querySelectorAll('[data-rvg]').forEach(b => b.onclick = () => { RL.tela = b.dataset.rvg; tela(); $('#corpo').scrollTop = 0; });
}
/** Cabeçalho das telas de cada relatório: título no topo, voltar para os ícones. */
function topoRdv(g) {
  $('#titulo').firstChild.textContent = g.titulo; $('#quem').textContent = 'RDV · ' + nomeMes(RL.mes);
  return `<button type="button" class="rdv-volta" id="rVolta"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>RDV · ${esc(nomeMes(RL.mes))}</button>`;
}
const ligarVolta = () => { $('#rVolta').onclick = () => { RL.tela = null; tela(); $('#corpo').scrollTop = 0; }; };
function cartaoItem(u, gerar, receber, extra) {
  const r = u.rec, dif = r ? r.valor - u.total : 0;
  return `<div class="rdv-un">
    <div class="l1"><b>${esc(u.nome)}</b>${r ? `<span class="pill ok">Recebido ${ddmm(r.data)}</span>` : receber ? '<span class="pill warn">A receber</span>' : ''}</div>
    <small>${plural(u.l.length, 'despesa', 'despesas')} · ${brl(u.total)}${r ? ` · caiu ${brl(r.valor)}${dif ? ` <span style="color:var(--warn)">(${dif < 0 ? 'faltaram' : 'sobraram'} ${brl(Math.abs(dif))})</span>` : ''}` : ''}${extra || ''}</small>
    <div class="bt"><button type="button" class="btn sec" data-rpdf="${gerar}">Gerar PDF</button>${receber ? `<button type="button" class="btn ${r ? 'sec' : 'pri verde'}" data-rrec="${receber}">${r ? 'Alterar' : '✓ Recebi'}</button>` : ''}</div>
  </div>`;
}
function telaRdvFarid(g) {
  const R0 = ST.dados.relatorios, us = itensRdv(g, RL.mes), ano = RL.mes.slice(0, 4);
  const tot = us.reduce((a, u) => a + u.total, 0), rec = us.filter(u => u.rec), recV = rec.reduce((a, u) => a + u.rec.valor, 0);
  const daVerba = R0.despesas.filter(x => x.verba > 0 && x.data.slice(0, 4) === ano), deb = daVerba.reduce((a, x) => a + x.verba, 0), cred = R0.cfg.credito * 12, noMes = daVerba.filter(x => x.data.slice(0, 7) === RL.mes);
  $('#corpo').innerHTML = `${topoRdv(g)}
  ${us.length ? `<div class="cartao rdv-res"><span><b>Resumo do mês</b><small>${plural(us.length, 'unidade', 'unidades')} · ${rec.length} recebida${rec.length === 1 ? '' : 's'}</small></span><span class="v">Total <b>${brl(tot)}</b>${rec.length ? `<em>Recebido ${brl(recV)}</em>` : ''}</span></div>
    ${us.map((u, i) => { const sem = u.l.filter(x => !x.tipo).length;
      return cartaoItem(u, i, u.id ? String(i) : '', `${sem ? `<br><span style="color:var(--warn)">${sem} sem tipo (vai em “Outro”)</span>` : ''}${!u.id ? '<br><span style="color:var(--warn)">Corrija a unidade destes lançamentos para marcar o recebimento</span>' : ''}`); }).join('')}
    ${us.length > 1 ? `<button type="button" class="btn sec" id="rTodos" style="width:100%;margin-top:10px">Gerar todos (${us.length} PDFs)</button>` : ''}`
    : '<div class="cartao"><div class="mini" style="text-align:center;padding:10px">Nenhuma despesa Farid neste mês.</div></div>'}
  <div class="cartao" style="margin-top:12px">
    <div class="tit"><span class="ico"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18M7 15h4"/></svg></span><span><b>Verba diretor ${ano}</b><small>Investimentos c/ Time · acumulado do ano</small></span></div>
    <div class="saldo3"><div><small>Crédito</small><b>${brl0(cred)}</b></div><div><small>Débito</small><b>${brl0(deb)}</b></div><div class="${cred - deb >= 0 ? 'ok' : 'neg'}"><small>Saldo</small><b>${brl0(cred - deb)}</b></div></div>
    <span class="mini">${MESC[+RL.mes.slice(5) - 1]}/${ano}: ${noMes.length} despesa${noMes.length === 1 ? '' : 's'} com verba · ${brl(noMes.reduce((a, x) => a + x.verba, 0))}</span>
    <button type="button" class="btn pri" id="rVerba"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>Gerar PDF da verba ${ano}</button>
  </div>
  <button type="button" class="btn sec" id="rDados" style="width:100%;margin-top:12px">Dados do relatório</button>
  <p class="mini" style="text-align:center">O PDF fica guardado no Drive (8.1.5 - Relatórios Farid).</p>`;
  ligarVolta();
  document.querySelectorAll('[data-rpdf]').forEach(b => b.onclick = () => folhaGerar(us[+b.dataset.rpdf]));
  document.querySelectorAll('[data-rrec]').forEach(b => b.onclick = () => { const u = us[+b.dataset.rrec]; folhaRecebi(g, u, 'Farid · ' + u.nome); });
  const t = $('#rTodos'); if (t) t.onclick = () => gerarTodos(us);
  $('#rVerba').onclick = () => gerarPdf({ tipo: 'verba', ano }, $('#rVerba'));
  $('#rDados').onclick = folhaDadosRel;
}
function telaRdvGrupo(g) {
  const its = itensRdv(g, RL.mes), u = its[0];
  $('#corpo').innerHTML = `${topoRdv(g)}
  ${!g.achado ? `<div class="faixa" role="note"><span><b>O plano “${esc(g.plano)}” não existe no painel.</b> Crie com esse nome no painel para os lançamentos entrarem aqui.</span></div>` : ''}
  ${u ? `${cartaoItem(u, 0, '0', '')}
    <div class="cartao" style="margin-top:12px;gap:0">${u.l.map(x => `<div class="rdv-lin"><span>${esc(x.desc) || '—'}<small>${ddmm(x.data)}${x.estab ? ' · ' + esc(x.estab) : ''}</small></span><b>${brl(x.valor)}</b></div>`).join('')}
      <div class="rdv-lin tot"><span>Total do mês</span><b>${brl(u.total)}</b></div></div>`
    : '<div class="cartao"><div class="mini" style="text-align:center;padding:10px">Nenhuma despesa neste mês.</div></div>'}
  <p class="mini" style="text-align:center">${esc(g.empresa || '')} · o PDF fica guardado no Drive (8.1.6 - RDV Aneethun e UniTudo).</p>`;
  ligarVolta();
  const p = document.querySelector('[data-rpdf]'); if (p) p.onclick = () => folhaRdvSimples(g, u);
  const r = document.querySelector('[data-rrec]'); if (r) r.onclick = () => folhaRecebi(g, u, g.titulo);
}
function folhaRdvSimples(g, u) {
  const f = abrirFolha(`<div class="folha-cab"><h3>RDV ${esc(g.titulo)}<span class="mini">${MES[+RL.mes.slice(5) - 1]}/${RL.mes.slice(0, 4)}</span></h3></div><div class="folha-corpo det">
    <span class="mini">${plural(u.l.length, 'despesa', 'despesas')} · total ${brl(u.total)} · ${esc(g.empresa)}</span>
    <div class="campo"><label class="rot" for="rvAd">Adiantamento recebido</label><input class="busca" id="rvAd" inputmode="numeric" value="${brl(0)}"></div>
    <span class="mini" id="rvErro" role="alert" style="color:var(--neg);font-weight:700"></span>
    <button type="button" class="btn pri" id="rvOk">Gerar PDF</button></div>`);
  let ad = 0; dinheiro(f.querySelector('#rvAd'), c => { ad = c; });
  f.querySelector('#rvOk').onclick = () => gerarPdf({ tipo: 'simples', grupo: g.chave, mes: RL.mes, adiantamento: ad }, f.querySelector('#rvOk'), f.querySelector('#rvErro'));
}
/** "Recebi o dinheiro": data e valor que caiu na conta (começa no total do RDV). Alterar ou desfazer depois. */
function folhaRecebi(g, u, rotulo) {
  const r = u.rec, mes = RL.mes;
  const f = abrirFolha(`<div class="folha-cab"><h3>Recebi o dinheiro</h3></div><div class="folha-corpo det">
    <span class="mini">${esc(rotulo)} · ${esc(nomeMes(mes))}<br>Total do RDV: ${brl(u.total)}</span>
    <div class="campo"><label class="rot" for="rbData">Data do recebimento</label><input class="busca" id="rbData" type="date" max="${hojeISO()}" value="${r ? r.data : hojeISO()}"></div>
    <div class="campo"><label class="rot" for="rbValor">Valor que caiu na conta</label><input class="busca rdv-valor" id="rbValor" inputmode="numeric" value="${brl(r ? r.valor : u.total)}"></div>
    <div class="resto" id="rbDif" hidden></div>
    <span class="mini" id="rbErro" role="alert" style="color:var(--neg);font-weight:700"></span>
    <button type="button" class="btn pri verde" id="rbOk">${r ? 'Salvar alteração' : 'Confirmar recebimento'}</button>
    ${r ? '<button type="button" class="btn sec" id="rbDesf">Desfazer recebimento</button>' : ''}</div>`);
  let valor = r ? r.valor : u.total;
  const dif = () => { const d = valor - u.total, el = f.querySelector('#rbDif'); el.hidden = !d || !valor; el.textContent = d < 0 ? `Faltaram ${brl(-d)} em relação ao total do RDV` : `Veio ${brl(d)} a mais que o total do RDV`; };
  dinheiro(f.querySelector('#rbValor'), c => { valor = c; dif(); }); dif();
  const enviar = async (dados, botao) => {
    const erro = f.querySelector('#rbErro');
    if (!ST.online) return erro.textContent = 'Sem internet: marcar o recebimento precisa de conexão.';
    if (!tokenValido()) { fecharFolha(true); return folhaLogin(); }
    const txt = botao.textContent; botao.disabled = true; botao.textContent = 'Salvando…'; erro.textContent = '';
    try { const res = await api('reembolso', Object.assign({ grupo: g.chave, mes, unidadeId: u.id }, dados)); ST.dados.reembolsos = res.reembolsos; await guardar('dados'); fecharFolha(); aviso(dados.desfazer ? 'Recebimento desfeito' : 'Recebimento guardado'); tela(); }
    catch (e) { erro.textContent = e.login ? 'Entre de novo para salvar.' : e.message; botao.disabled = false; botao.textContent = txt; }
  };
  f.querySelector('#rbOk').onclick = () => {
    const data = f.querySelector('#rbData').value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return f.querySelector('#rbErro').textContent = 'Informe a data do recebimento.';
    if (!(valor > 0)) return f.querySelector('#rbErro').textContent = 'Informe o valor que caiu na conta.';
    enviar({ data, valor }, f.querySelector('#rbOk'));
  };
  const d = f.querySelector('#rbDesf'); if (d) d.onclick = () => enviar({ desfazer: true }, d);
}
function folhaGerar(u) {
  const f = abrirFolha(`<div class="folha-cab"><h3>Gerar PDF<span class="mini">${esc(u.nome)} · ${MES[+RL.mes.slice(5) - 1]}/${RL.mes.slice(0, 4)}</span></h3></div><div class="folha-corpo det">
    <span class="mini">${u.l.length} despesa${u.l.length === 1 ? '' : 's'} · total ${brl(u.l.reduce((a, x) => a + x.valor, 0))}</span>
    <div class="campo"><label class="rot" for="rAd">Adiantamento recebido</label><input class="busca" id="rAd" inputmode="numeric" value="${brl(0)}"></div>
    <span class="mini" id="rErro" role="alert" style="color:var(--neg);font-weight:700"></span>
    <button type="button" class="btn pri" id="rOk">Gerar PDF</button></div>`);
  let ad = 0; dinheiro(f.querySelector('#rAd'), c => { ad = c; });
  f.querySelector('#rOk').onclick = () => gerarPdf({ tipo: 'viagem', mes: RL.mes, unidadeId: u.id, adiantamento: ad }, f.querySelector('#rOk'), f.querySelector('#rErro'));
}
async function gerarTodos(us) {
  const b = $('#rTodos'); if (!ST.online) return aviso('Sem internet: gerar o PDF precisa de conexão.', true);
  const prontos = [];
  for (let i = 0; i < us.length; i++) {
    b.disabled = true; b.textContent = `Gerando ${i + 1} de ${us.length}…`;
    try { prontos.push(await api('relatorio', { tipo: 'viagem', mes: RL.mes, unidadeId: us[i].id, adiantamento: 0 })); }
    catch (e) { b.disabled = false; b.textContent = `Gerar todos (${us.length} PDFs)`; return aviso(e.login ? 'Entre de novo para gerar.' : e.message, true); }
  }
  b.disabled = false; b.textContent = `Gerar todos (${us.length} PDFs)`;
  folhaPdfs(prontos);
}
async function gerarPdf(dados, botao, erroEl) {
  if (!ST.online) { const m = 'Sem internet: gerar o PDF precisa de conexão.'; return erroEl ? erroEl.textContent = m : aviso(m, true); }
  if (!tokenValido()) { fecharFolha(true); return folhaLogin(); }
  const txt = botao.textContent; botao.disabled = true; botao.textContent = 'Gerando o PDF…';
  try { const r = await api('relatorio', dados); folhaFim = null; fecharFolha(true); folhaPdfs([r]); }
  catch (e) { if (erroEl) erroEl.textContent = e.message; else aviso(e.message, true); }
  finally { botao.disabled = false; botao.textContent = txt; }
}
const pdfArquivo = r => { const bin = atob(r.pdf), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new File([u8], r.nome, { type: 'application/pdf' }); };
/** PDF pronto: compartilhar (WhatsApp, e-mail…) ou abrir/baixar. */
function folhaPdfs(lista) {
  const arqs = lista.map(pdfArquivo), urls = arqs.map(a => URL.createObjectURL(a));
  const podeComp = !!(navigator.canShare && navigator.canShare({ files: arqs }));
  const f = abrirFolha(`<div class="folha-cab"><h3>${lista.length === 1 ? 'PDF pronto' : lista.length + ' PDFs prontos'}</h3></div><div class="folha-corpo det">
    <span class="tag" style="background:var(--ok-bg);color:var(--ok)">Cópia guardada no Drive</span>
    ${lista.map((r, i) => `<div class="unid" style="cursor:default"><span class="t"><b style="font-size:13.5px">${esc(r.nome)}</b></span><a class="btn sec" style="min-height:36px;padding:0 12px" href="${urls[i]}" download="${esc(r.nome)}" target="_blank" rel="noopener">Abrir</a></div>`).join('')}
    ${podeComp ? `<button type="button" class="btn pri" id="rComp"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>Compartilhar</button>` : ''}
  </div>`);
  const c = f.querySelector('#rComp'); if (c) c.onclick = () => navigator.share({ files: arqs, title: lista.length === 1 ? lista[0].nome : 'Relatórios Farid' }).catch(() => { });
}
function folhaDadosRel() {
  const c = ST.dados.relatorios.cfg, campo = (k, r) => `<div class="campo"><label class="rot" for="rc_${k}">${r}</label><input class="busca" id="rc_${k}" value="${esc(c[k])}" maxlength="120"></div>`;
  const f = abrirFolha(`<div class="folha-cab"><h3>Dados do relatório</h3></div><div class="folha-corpo det">
    <span class="mini">Valem para todos que geram os relatórios. Ficam guardados no painel.</span>
    ${campo('nome', 'Nome')}${campo('cargo', 'Cargo')}${campo('depto', 'Departamento')}${campo('origem', 'Origem/Destino')}${campo('motivo', 'Motivo')}${campo('cidade', 'Cidade (assinatura)')}
    <div class="campo"><label class="rot" for="rc_credito">Crédito mensal da verba</label><input class="busca" id="rc_credito" inputmode="numeric" value="${brl(c.credito)}"></div>
    <span class="mini" id="rbErro" role="alert" style="color:var(--neg);font-weight:700"></span>
    <button type="button" class="btn pri" id="rcOk">Salvar</button></div>`);
  let cred = c.credito; dinheiro(f.querySelector('#rc_credito'), v => { cred = v; });
  f.querySelector('#rcOk').onclick = async () => {
    const b = f.querySelector('#rcOk'), d = { credito: cred }; ['nome', 'cargo', 'depto', 'origem', 'motivo', 'cidade'].forEach(k => { d[k] = f.querySelector('#rc_' + k).value.trim(); });
    if (Object.values(d).some(v => v === '')) return f.querySelector('#rbErro').textContent = 'Preencha todos os campos.';
    if (!ST.online || !tokenValido()) return f.querySelector('#rbErro').textContent = !ST.online ? 'Sem internet: salvar precisa de conexão.' : 'Entre de novo para salvar.';
    b.disabled = true; b.textContent = 'Salvando…';
    try { const r = await api('relatorio_cfg', d); ST.dados.relatorios.cfg = r.cfg; await guardar('dados'); fecharFolha(); aviso('Dados do relatório salvos'); tela(); }
    catch (e) { f.querySelector('#rbErro').textContent = e.message; b.disabled = false; b.textContent = 'Salvar'; }
  };
}

/* ---------- conta ---------- */
function telaConta() {
  const n = ST.fila.length, u = ST.dados.usuario || {};
  $('#corpo').innerHTML = `${faixaTeste()}<div class="cartao"><span class="rot">Conectado como</span><b style="font-size:17px;color:var(--navy)">${esc(u.nome)}</b><span class="mini">${esc(eu())}</span>${ST.sessao && ST.sessao.tipo === 'app' ? `<span class="mini">Conectado neste aparelho. Só pede o login de novo se ficar 30 dias sem usar o app (até ${new Date(ST.sessao.exp * 1000).toLocaleDateString('pt-BR')}, renova a cada uso).</span>` : ''}</div>
  <div class="cartao"><span class="rot">Sincronização</span><span>${n ? `<b>${n}</b> envio${n === 1 ? '' : 's'} guardado${n === 1 ? '' : 's'} no celular${ST.online ? '' : ', aguardando internet'}.` : 'Tudo enviado para o painel.'}</span>
    ${ST.recusados.length ? `<span style="color:var(--neg);font-weight:700">${ST.recusados.length} não aceito${ST.recusados.length === 1 ? '' : 's'} pelo painel: veja em Lançamentos.</span>` : ''}
    <span class="mini">Atualizado em ${esc(String(ST.dados.agora || '').replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}:\d{2}).*/, '$3/$2/$1 às $4'))}. Planos de contas e listas vêm do painel: o que mudar lá aparece aqui na próxima atualização.</span>
    <button type="button" class="btn sec" id="atualizarJa" ${ST.online ? '' : 'disabled'}>Atualizar agora</button></div>
  <div class="cartao"><span class="rot">Instalar no celular</span><span class="mini">No Android: menu do Chrome → Instalar app. No iPhone (Safari): Compartilhar → Adicionar à Tela de Início.</span></div>
  <button type="button" class="btn sec" id="sair" style="width:100%;margin-top:12px">Sair</button>
  <p class="mini" style="text-align:center">App versão ${APP_VERSAO}</p>`;
  $('#atualizarJa').onclick = async () => { if (!tokenValido()) return folhaLogin(); await enviarFila(); await atualizar(); aviso('Atualizado'); };
  $('#sair').onclick = async () => {
    const b = $('#sair');
    if (ST.fila.length) { aviso(`Ainda há ${ST.fila.length} envio(s) guardado(s) no celular. Conecte à internet para enviar antes de sair.`, true); return; }
    if (!b.dataset.c) { b.dataset.c = 1; b.textContent = 'Toque de novo para sair'; return; }
    if (ST.online && tokenValido()) { b.textContent = 'Saindo…'; try { await api('sair'); } catch (e) { } }
    await sairDeVez('');
  };
}

/* ---------- listas de escolha (folha que sobe de baixo) ---------- */
let folhaFim = null;
function abrirFolha(html) {
  fecharFolha(true);
  const v = document.createElement('div'); v.className = 'veu'; const f = document.createElement('div'); f.className = 'folha'; f.setAttribute('role', 'dialog'); f.setAttribute('aria-modal', 'true'); f.innerHTML = html;
  $('#app').append(v, f); requestAnimationFrame(() => { v.classList.add('on'); f.classList.add('on'); }); v.onclick = () => fecharFolha();
  f.tabIndex = -1; setTimeout(() => { if (!f.contains(document.activeElement)) f.focus({ preventScroll: true }); }, 280);
  return f;
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('.folha')) { e.preventDefault(); fecharFolha(); } });
function fecharFolha(ja) {
  const f = $('.folha'), v = $('.veu'); if (!f) return; if (folhaFim) { const r = folhaFim; folhaFim = null; r(null); }
  if (ja || reduz()) { f.remove(); v && v.remove(); return; } f.classList.remove('on'); v && v.classList.remove('on'); setTimeout(() => { f.remove(); v && v.remove(); }, 260);
}
/** itens: [{v: id, t: texto, tag}] · devolve o id escolhido ('' = limpar; null = fechou sem escolher). */
function escolher(titulo, itens, atual, op = {}) {
  return new Promise(res => {
    const f = abrirFolha(`<div class="folha-cab"><h3>${esc(titulo)}</h3>${itens.length > 8 ? '<input type="search" class="busca" id="fq" placeholder="Pesquisar" aria-label="Pesquisar">' : ''}</div><div class="folha-corpo" role="listbox" aria-label="${esc(titulo)}"></div>`);
    folhaFim = res;
    const corpo = f.querySelector('.folha-corpo'), q = f.querySelector('#fq'), porId = {}; itens.forEach(x => porId[x.v] = x);
    const linha = x => `<button type="button" class="opc" data-v="${esc(x.v)}" role="option" aria-selected="${x.v === atual}">${esc(x.t)}${x.tag ? `<small>${esc(x.tag)}</small>` : ''}</button>`;
    const pinta = () => {
      const t = (q && q.value || '').trim().toLowerCase(), vis = itens.filter(x => !t || x.t.toLowerCase().includes(t)), rec = (op.recentes || []).filter(v => !t && porId[v]).map(v => porId[v]);
      corpo.innerHTML = (op.limpar && !t ? `<button type="button" class="opc" data-v="" role="option" aria-selected="${!atual}"><i style="font-style:normal;color:var(--muted)">${esc(op.limpar)}</i></button>` : '')
        + (rec.length ? `<div class="grupo">Mais usados por você</div>${rec.map(linha).join('')}<div class="grupo">Todos</div>` : '')
        + (vis.map(linha).join('') || `<div class="vazio">Nada com “${esc(t)}”.</div>`);
      corpo.querySelectorAll('[data-v]').forEach(b => b.onclick = () => { folhaFim = null; res(b.dataset.v); fecharFolha(); });
    };
    pinta();
    if (q) { q.oninput = pinta; setTimeout(() => q.focus({ preventScroll: true }), 280); }
    else { const a = corpo.querySelector('[aria-selected="true"]') || corpo.querySelector('[data-v]'); a && setTimeout(() => a.focus(), 280); }
  });
}
function aviso(msg, alerta) {
  const a = $('#aviso'); a.className = 'aviso on' + (alerta ? ' off' : '');
  a.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true">${alerta ? '<path d="M12 8v5M12 16v1"/><circle cx="12" cy="12" r="9"/>' : '<path d="M5 12l5 5 9-10"/>'}</svg><span>${esc(msg)}</span>`;
  clearTimeout(aviso.t); aviso.t = setTimeout(() => a.classList.remove('on'), alerta ? 4500 : 2600);
}

/* ================================================================== */
/* Início                                                               */
document.querySelectorAll('[data-aba]').forEach(b => b.onclick = () => { if (b.dataset.aba === 'rel') RL.tela = null; ST.aba = b.dataset.aba; fecharFolha(true); tela(); $('#corpo').scrollTop = 0; });
window.addEventListener('online', () => { ST.online = true; tela(); if (!tokenValido()) renovarLogin(); enviarFila(); atualizar(true); });
window.addEventListener('offline', () => { ST.online = false; tela(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ST.sessao) { if (ST.online && !tokenValido()) renovarLogin(); enviarFila(); atualizar(true); } });
setInterval(() => { if (ST.fila.length && ST.online && !enviando) enviarFila(); }, 30000);

(async function iniciar() {
  const [sessao, dados, fila, recusados, rascunho] = await Promise.all(['sessao', 'dados', 'fila', 'recusados', 'rascunho'].map(k => BD.get(k)));
  ST.sessao = sessao || null; ST.dados = dados || null; ST.fila = fila || []; ST.recusados = recusados || []; R = rascunho || null;
  ST.fila.forEach(o => { if (o.tentou === undefined) o.tentou = false; });
  if (ST.sessao && !ST.dados && ST.online && tokenValido()) $('#corpo').innerHTML = '<div class="carregando"><i></i></div>';
  tela();
  if (gis && ST.sessao && !tokenValido()) renovarLogin();
  if (tokenValido()) { await enviarFila(); if (!ST.fila.length) atualizar(true); }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // versão nova do app publicada: o celular troca sozinho (o rascunho e a fila ficam guardados)
    const tinha = !!navigator.serviceWorker.controller; let recarregou = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (!tinha || recarregou) return; recarregou = true; if (!$('.folha') && !enviando) location.reload(); });
    navigator.serviceWorker.register('sw.js').catch(() => { });
  }
})();
