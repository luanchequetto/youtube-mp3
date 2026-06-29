# YouTube to MP3 Converter

Converte vídeos do YouTube para MP3 via browser. Stack: frontend estático + Cloudflare Worker + RapidAPI.

## Deploy rápido

### 1. Worker (Cloudflare)
```bash
cd worker
npm install -g wrangler
wrangler login
wrangler secret put RAPIDAPI_KEY   # cole sua chave RapidAPI aqui
wrangler deploy
# anote a URL gerada: https://youtube-mp3-worker.SEU-SUBDOMAIN.workers.dev
```

### 2. Atualizar URLs
- Em `frontend/app.js`: substitua `WORKER_URL` pela URL do worker
- Em `worker/index.js`: substitua `'*'` em Access-Control-Allow-Origin pela URL do GitHub Pages

### 3. Frontend (GitHub Pages)
```bash
gh repo create youtube-mp3 --public --source=. --push
# Ative GitHub Pages: Settings > Pages > Source: main / root
```

## Estrutura
```
frontend/   index.html + style.css + app.js (SPA vanilla JS)
worker/     index.js (Cloudflare Worker proxy) + wrangler.toml
```

## Limites (plano free)
- RapidAPI: 500 req/mês
- Cloudflare Workers: 100k req/dia
- Vídeos até ~2h
