const https = require('https');

const SB_URL = 'https://jhisyhfuoqrzdwlwdrjv.supabase.co';

// ── helpers ──────────────────────────────────────────────────────────────────

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
  // Lisbon time (UTC+1 summer, UTC+0 winter) — use Europe/Lisbon
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Lisbon' });
}

// ── main handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Allow manual trigger via GET, and cron via Vercel
  const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  if (!SB_KEY || !CLAUDE_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  try {
    const today = todayStr();

    // ── 1. Fetch data from Supabase ─────────────────────────────────────────

    const [games, betsData, players, summaries, curiosidades] = await Promise.all([
      sbFetch('/rest/v1/games?select=*&order=dt.asc', 'GET', null, SB_KEY),
      sbFetch('/rest/v1/bets?select=*', 'GET', null, SB_KEY),
      sbFetch('/rest/v1/jogadores?select=nome,equipa', 'GET', null, SB_KEY),
      sbFetch('/rest/v1/summaries?select=*&order=date.desc&limit=3', 'GET', null, SB_KEY),
      sbFetch(`/rest/v1/curiosidades?select=*&date=eq.${today}`, 'GET', null, SB_KEY),
    ]);

    // ── 2. Build context ────────────────────────────────────────────────────

    // Games with results
    const gamesWithResult = games.filter(g => g.result);
    const gamesToday = games.filter(g => g.dt === today);
    const gamesNext3 = games.filter(g => g.dt >= today && !g.result).slice(0, 6);

    // Leaderboard
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
      gamesWithResult.forEach(g => {
        if (betsByGame[g.id] && betsByGame[g.id][name] === g.result) {
          scores[name] += fasePts(g.fase);
        }
      });
    });

    const TEAMS = { Andrade: [], José: [], Leal: [] };
    players.forEach(p => { if (TEAMS[p.equipa]) TEAMS[p.equipa].push(p.nome); });
    const teamScores = {};
    Object.keys(TEAMS).forEach(t => {
      const members = TEAMS[t];
      teamScores[t] = members.length
        ? Math.round(members.reduce((s, n) => s + (scores[n] || 0), 0) / members.length * 10) / 10
        : 0;
    });

    const leaderboard = playerNames
      .sort((a, b) => (scores[b] || 0) - (scores[a] || 0))
      .map((n, i) => `${i + 1}. ${n} — ${scores[n] || 0} pts`)
      .join('\n');

    const teamboard = Object.entries(teamScores)
      .sort((a, b) => b[1] - a[1])
      .map(([t, s], i) => `${i + 1}. Equipa ${t} — ${s} pts (média)`)
      .join('\n');

    const todayGamesText = gamesToday.length
      ? gamesToday.map(g => `${g.home} vs ${g.away} (${g.fase})`).join(', ')
      : 'Sem jogos hoje';

    const nextGamesText = gamesNext3.length
      ? gamesNext3.map(g => `${g.dt}: ${g.home} vs ${g.away}`).join('\n')
      : 'Sem jogos próximos';

    const lastResults = gamesWithResult.slice(-5)
      .map(g => `${g.home} vs ${g.away}: ${g.result}`)
      .join('\n') || 'Sem resultados ainda';

    const curiosidadeHoje = curiosidades[0]
      ? curiosidades[0].texto.replace(/<[^>]+>/g, '').substring(0, 200)
      : null;

    const recentSummaries = summaries.length
      ? summaries.map(s => `[${s.date}] ${s.texto.replace(/<[^>]+>/g, '').substring(0, 100)}`).join('\n')
      : 'Primeiro resumo do torneio';

    // ── 3. Build prompt ─────────────────────────────────────────────────────

    const prompt = `És o cronista oficial do Mundial 2026 Kimporta, a liga de apostas da família Andrade/José/Leal. Escreves diariamente um ponto de situação curto, vivo e com personalidade — como se fosse uma mensagem de WhatsApp de um amigo apaixonado por futebol.

DATA DE HOJE: ${today}

JOGOS HOJE:
${todayGamesText}

PRÓXIMOS JOGOS:
${nextGamesText}

ÚLTIMOS RESULTADOS:
${lastResults}

CLASSIFICAÇÃO INDIVIDUAL:
${leaderboard}

CLASSIFICAÇÃO POR EQUIPAS:
${teamboard}

CURIOSIDADE DO DIA:
${curiosidadeHoje || '(sem curiosidade para hoje)'}

RESUMOS RECENTES (para não repetir):
${recentSummaries}

Escreve um ponto de situação para hoje. Regras:
- Máximo 4 parágrafos curtos
- Tom: animado, familiar, com piada ocasional — como se conhecesses toda a gente
- Menciona quem está a liderar, quem está a recuperar, quem precisa de ajuda
- Se houver jogos hoje, cria expectativa
- Podes usar emojis com moderação (2-3 no máximo)
- Escreve em português de Portugal
- NÃO uses markdown (sem **, sem #, sem listas com -)
- Responde APENAS com o texto do ponto de situação, sem introdução nem explicação`;

    // ── 4. Call Claude ──────────────────────────────────────────────────────

    const claudeRes = await claudeFetch(prompt, CLAUDE_KEY);

    if (!claudeRes.content || !claudeRes.content[0]) {
      throw new Error('Claude returned no content: ' + JSON.stringify(claudeRes));
    }

    const summaryText = 'draft:' + claudeRes.content[0].text.trim();

    // ── 5. Save to Supabase ─────────────────────────────────────────────────

    await sbFetch('/rest/v1/summaries', 'POST', {
      date: today,
      texto: summaryText,
    }, SB_KEY);

    // Also upsert (in case it already exists)
    await sbFetch(
      `/rest/v1/summaries?date=eq.${today}`,
      'PATCH',
      { texto: summaryText },
      SB_KEY
    );

    return res.status(200).json({
      ok: true,
      date: today,
      preview: summaryText.substring(0, 120) + '...',
    });

  } catch (err) {
    console.error('daily-summary error:', err);
    return res.status(500).json({ error: err.message });
  }
};
