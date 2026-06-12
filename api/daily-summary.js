const https = require('https');

const SB_URL = 'https://jhisyhfuoqrzdwlwdrjv.supabase.co';

function sbFetch(path, method, body, serviceKey) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const url = new URL(SB_URL + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: {
        'apikey': serviceKey,
        'Authorization': 'Bearer ' + serviceKey,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=minimal' : '',
      },
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function claudeFetch(prompt, apiKey) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(raw); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function todayStr() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Lisbon' });
}

function tomorrowStr() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

module.exports = async function handler(req, res) {
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SB_KEY || !CLAUDE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  try {
    const today = todayStr();
    const tomorrow = tomorrowStr();

    // ── 1. Fetch data ────────────────────────────────────────────────────────
    const [games, betsData, players] = await Promise.all([
      sbFetch('/rest/v1/games?select=*&order=dt.asc', 'GET', null, SB_KEY),
      sbFetch('/rest/v1/bets?select=*', 'GET', null, SB_KEY),
      sbFetch('/rest/v1/jogadores?select=nome,equipa', 'GET', null, SB_KEY),
    ]);

    // ── 2. Build context ─────────────────────────────────────────────────────
    const GRUPO_FASES = ['Fase de Grupos · Jornada 1', 'Fase de Grupos · Jornada 2', 'Fase de Grupos · Jornada 3'];
    const fasePts = (fase) => GRUPO_FASES.includes(fase) ? 1 : 2;

    const betsByGame = {};
    betsData.forEach(b => {
      if (!betsByGame[b.game_id]) betsByGame[b.game_id] = {};
      betsByGame[b.game_id][b.player] = b.opt;
    });

    const playerNames = players.map(p => p.nome);
    const scores = {};
    playerNames.forEach(name => {
      scores[name] = 0;
      games.filter(g => g.result).forEach(g => {
        if (betsByGame[g.id] && betsByGame[g.id][name] === g.result) scores[name] += fasePts(g.fase);
      });
    });

    const TEAMS = { Andrade: [], José: [], Leal: [] };
    players.forEach(p => { if (TEAMS[p.equipa]) TEAMS[p.equipa].push(p.nome); });
    const teamScores = {};
    Object.keys(TEAMS).forEach(t => {
      const members = TEAMS[t];
      let totalPts = 0, totalBets = 0;
      games.filter(g => g.result).forEach(g => {
        members.forEach(p => {
          if (betsByGame[g.id] && betsByGame[g.id][p]) {
            totalBets++;
            if (betsByGame[g.id][p] === g.result) totalPts += fasePts(g.fase);
          }
        });
      });
      teamScores[t] = totalBets > 0 ? Math.round(totalPts / totalBets * 100) / 100 : 0;
    });

    const leaderboard = playerNames
      .sort((a, b) => (scores[b] || 0) - (scores[a] || 0))
      .map((n, i) => `${i + 1}. ${n} — ${scores[n] || 0} pts`)
      .join('\n');

    const teamboard = Object.entries(teamScores)
      .sort((a, b) => b[1] - a[1])
      .map(([t, s], i) => `${i + 1}. Equipa ${t} — ${s} pts (média)`)
      .join('\n');

    const gamesToday = games.filter(g => g.dt === today);
    const gamesYesterday = games.filter(g => {
      const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Lisbon' }));
      d.setDate(d.getDate() - 1);
      return g.dt === d.toISOString().slice(0, 10);
    });
    const gamesNext = games.filter(g => g.dt >= today && !g.result).slice(0, 8);
    const recentResults = games.filter(g => g.result).slice(-6)
      .map(g => `${g.home} vs ${g.away}: ${g.result === '1' ? g.home + ' venceu' : g.result === '2' ? g.away + ' venceu' : 'Empate'}`)
      .join('\n') || 'Sem resultados ainda';

    const todayGamesText = gamesToday.length
      ? gamesToday.map(g => `${g.home} vs ${g.away} (${g.fase})`).join('\n')
      : 'Sem jogos hoje';

    const nextGamesText = gamesNext.length
      ? gamesNext.map(g => `${g.dt}: ${g.home} vs ${g.away}`).join('\n')
      : 'Sem jogos próximos';

    // ── 3. Generate PONTO DE SITUAÇÃO ────────────────────────────────────────
    const summaryPrompt = `És o João, o organizador do Mundial 2026 Kimporta — a liga de apostas da família Andrade/José/Leal. Escreves diariamente uma mensagem para o grupo de WhatsApp da família, no teu estilo habitual: descontraído, com humor, piadas internas, referências pessoais e alguma ironia suave. Conheces toda a gente pelo nome.

DATA DE HOJE: ${today}

JOGOS HOJE:
${todayGamesText}

PRÓXIMOS JOGOS:
${nextGamesText}

ÚLTIMOS RESULTADOS:
${recentResults}

CLASSIFICAÇÃO INDIVIDUAL:
${leaderboard}

CLASSIFICAÇÃO POR EQUIPAS:
${teamboard}

Exemplos do teu estilo de escrita (do Euro 2024):
- "Ao fim do segundo dia, ainda há invictos, mas também já há estragos feitos! Vamos ver o que o dia de amanhã nos traz."
- "Mais um dia atípico neste europeu. João, Maria João e Eva conseguiram falhar as 3 previsões. Parabéns!"
- "A julgar pelas apostas de hoje, até foi um dia de resultados surpreendentes. É bom sinal, quer dizer que o campeonato está vivo 🙂"
- "Costuma-se dizer que o futebol são 11 contra 11 e no final ganha a Alemanha. Mas a verdade é que hoje também foi capaz de vencer contra 10 🇩🇪"

Regras:
- Máximo 4 parágrafos curtos
- Menciona quem está a liderar, quem está a sofrer, com ironia carinhosa
- Se houver jogos hoje, cria expectativa
- Podes inventar alcunhas ou comentários divertidos sobre os jogadores da família
- 2-3 emojis no máximo, bem colocados
- Escreve em português de Portugal
- NÃO uses markdown (sem **, sem #, sem listas com -)
- Responde APENAS com o texto, sem introdução nem explicação`;

    const summaryRes = await claudeFetch(summaryPrompt, CLAUDE_KEY);
    if (!summaryRes.content || !summaryRes.content[0]) throw new Error('Claude no content (summary): ' + JSON.stringify(summaryRes));
    const summaryText = 'draft:' + summaryRes.content[0].text.trim();

    // ── 4. Generate CURIOSIDADE DO DIA ───────────────────────────────────────
    const allTeams = [...new Set([
      ...gamesToday.map(g => [g.home, g.away]).flat(),
      ...gamesYesterday.map(g => [g.home, g.away]).flat(),
      ...gamesNext.slice(0, 4).map(g => [g.home, g.away]).flat(),
    ])].join(', ');

    const curiosidadePrompt = `És o editor de conteúdo do Mundial 2026 Kimporta. Escreves uma curiosidade diária sobre o futebol para uma família portuguesa.

DATA DE HOJE: ${today}

JOGOS DE HOJE: ${todayGamesText}
JOGOS RECENTES/PRÓXIMOS: ${nextGamesText}
EQUIPAS RELEVANTES HOJE: ${allTeams || 'nenhuma em especial'}

Escreve UMA curiosidade sobre futebol para hoje. Pode ser:
- Sobre uma das equipas ou jogadores em destaque hoje
- Sobre um facto histórico de um Mundial anterior
- Uma estatística surpreendente do futebol mundial
- Uma história humana inspiradora ligada ao futebol
- Um facto curioso sobre uma das cidades/estádios do Mundial 2026

Regras:
- Começa com um título curto e apelativo (máximo 8 palavras)
- Depois 3-4 frases de desenvolvimento
- Tom: curioso, interessante, acessível para toda a família
- Escreve em português de Portugal
- USA República Checa = Chéquia
- Responde APENAS com o formato: TITULO|TEXTO (separados por pipe |)
- O TITULO não deve ter HTML
- O TEXTO pode ter <strong> para negrito e <em> para itálico`;

    const curiosidadeRes = await claudeFetch(curiosidadePrompt, CLAUDE_KEY);
    if (!curiosidadeRes.content || !curiosidadeRes.content[0]) throw new Error('Claude no content (curiosidade): ' + JSON.stringify(curiosidadeRes));

    const rawCurio = curiosidadeRes.content[0].text.trim();
    const pipeIdx = rawCurio.indexOf('|');
    let curiosidadeText;
    if (pipeIdx > -1) {
      const title = rawCurio.slice(0, pipeIdx).trim();
      const body = rawCurio.slice(pipeIdx + 1).trim();
      curiosidadeText = 'draft:<strong>' + title + '</strong><br><br>' + body;
    } else {
      curiosidadeText = 'draft:' + rawCurio;
    }

    // ── 5. Save both to Supabase ─────────────────────────────────────────────
    await Promise.all([
      sbFetch(`/rest/v1/summaries?date=eq.${today}`, 'DELETE', null, SB_KEY).then(() =>
        sbFetch('/rest/v1/summaries', 'POST', { date: today, texto: summaryText }, SB_KEY)
      ),
      sbFetch(`/rest/v1/curiosidades?date=eq.${today}`, 'DELETE', null, SB_KEY).then(() =>
        sbFetch('/rest/v1/curiosidades', 'POST', { date: today, texto: curiosidadeText }, SB_KEY)
      ),
    ]);

    return res.status(200).json({
      ok: true,
      date: today,
      summary_preview: summaryText.slice(6, 120) + '...',
      curiosidade_preview: curiosidadeText.slice(6, 120) + '...',
    });

  } catch (err) {
    console.error('daily-summary error:', err);
    return res.status(500).json({ error: err.message });
  }
};
