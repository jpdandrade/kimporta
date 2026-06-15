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
    const summaryPrompt = `És o João, o organizador do Mundial 2026 Kimporta — uma liga de apostas entre amigos e família. Escreves diariamente um resumo curto para partilhar com o grupo.

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

Exemplos reais do teu estilo (adapta ao contexto do Mundial, não do Euro):

Exemplo 1:
"Já só faltam 3 grandes jogos! Temos que aproveitar!
Nesta jornada, Cristina e Eva não acertaram nenhuma previsão, mas não desanimem!
Andrades e Leais tiveram uma média de jornada idêntica, com os Josés ligeiramente atrás.
Na classificação geral, Ana mantém-se no cume desta montanha. Guilherme e Gonçalo completam o pódio.
Manuel está cá em baixo a relaxar, mas com o seu último lugar a ser posto em risco pela Cristina!"

Exemplo 2:
"Vocês viram isto? Realmente a história do jogo escreve-se mesmo até ao último segundo! 2 dias seguidos assim!
Guilherme e Lala seguem destacados na frente da jornada. Vamos ver o que o dia de amanhã nos traz."

Exemplo 3:
"Sim, companheiros, o espetáculo está de volta!
Apenas Cristina e Ana acertaram em ambos os resultados. João está na cauda do campeonato com 32.5%. Como tem menos que 33.3%, isso quer dizer que, pelas probabilidades, se fizesse tudo à sorte, supostamente teria um resultado melhor do que a tentar... Mais valia ser só organizador..."

Exemplo 4:
"Isto agora é sempre a andar.
Nesta jornada, quem se destacou pela positiva foram as matriarcas dos Josés e dos Leais, Maria José e Ana. Curiosamente, quem ficou no fundo foram os patriarcas das mesmas famílias: Manuel e Jorge.
Houve então uma cambalhota na classificação geral! Ana ultrapassa tudo a todo o gás e isola-se na liderança. Manuel vai desfrutando da vista na cauda do pelotão."

Regras:
- NÃO uses as palavras "família" ou "malta"
- Se houver algo interessante no Mundial hoje ou amanhã, menciona brevemente
- Descreve de forma resumida como correu a jornada aos apostadores (quem acertou, quem falhou, com ironia carinhosa)
- Descreve a classificação actual de forma resumida — quem lidera, quem está na cauda
- Máximo 4 parágrafos curtos
- Tom: descontraído, com humor e ironia suave, como se conhecesses toda a gente pelo nome
- 2-3 emojis no máximo, bem colocados
- Escreve em português de Portugal
- NÃO uses markdown (sem **, sem #, sem listas com -)
- Responde APENAS com o texto, sem introdução nem explicação`;

    const curiosidadePrompt = `És o João, o organizador do Mundial 2026 Kimporta. Escreves uma curiosidade diária sobre futebol para partilhar com o grupo.

DATA DE HOJE: ${today}
JOGOS DE HOJE: ${todayGamesText}
JOGOS RECENTES/PRÓXIMOS: ${nextGamesText}

Exemplos reais do teu estilo:

Exemplo 1:
"Já houve 19 empates neste euro! O máximo desde que o torneio existe. O record anterior era do euro 2016 e 2020 ex aequo, com 16 empates cada."

Exemplo 2:
"No euro 2004, bateu-se o record de marcador mais jovem da história do torneio por 2 vezes. Primeiro o inglês Wayne Rooney marcou com 18 anos e 237 dias. Passados 4 dias, o suíço Johan Vonlanthen marcou com 18 anos e 141 dias. Record que se mantém até hoje."

Exemplo 3:
"Com o golo de hoje, Luka Modric tornou-se o jogador mais velho a marcar em europeus, com 38 anos e 289 dias. Este record pertencia ao avançado austríaco Ivica Vastic, que tinha marcado à Polónia, em 2008, com 38 anos e 257 dias."

Exemplo 4:
"A Dinamarca protagonizou um dos contos de fadas mais memoráveis da história do torneio. Inicialmente não se apurou para o Euro 92, mas foram chamados a apenas 10 dias do início para substituir a Jugoslávia, desqualificada devido à guerra civil. Nada disto foi impedimento para serem campeões europeus!"

Regras:
- Começa com um título curto e apelativo (máximo 8 palavras)
- 2-4 frases com um facto concreto, número ou história humana
- Pode ser sobre jogos de hoje, história de Mundiais anteriores, recordes, histórias de jogadores ou selecções
- Tom: curioso, interessante, acessível — como contas a um amigo
- Escreve em português de Portugal
- USA Chéquia em vez de República Checa
- Responde APENAS com o formato: TITULO|TEXTO (separados por pipe |)
- O TITULO não deve ter HTML
- O TEXTO pode ter <strong> para negrito e <em> para itálico`;

    const summaryRes = await claudeFetch(summaryPrompt, CLAUDE_KEY);
    if (!summaryRes.content || !summaryRes.content[0]) throw new Error('Claude no content (summary): ' + JSON.stringify(summaryRes));
    const summaryText = 'draft:' + summaryRes.content[0].text.trim();

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
