// Complete worker with:
// - CORS preflight handling (OPTIONS)
// - Input validation (videoId regex: /^[a-zA-Z0-9_-]{11}$/)
// - RapidAPI call to youtube-mp36.p.rapidapi.com
// - Structured error responses with correct HTTP status codes
// - Rate limit detection (check apiRes.status === 429)
// - Retry logic: if status === 'processing', poll up to 5 times with 2s delay

export default {
  async fetch(request, env) {
    // CORS headers — Allow-Origin will be updated post-deploy
    const corsHeaders = {
      'Access-Control-Allow-Origin': 'https://luanchequetto.github.io',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    }

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders })
    }

    // Only accept POST /convert
    const url = new URL(request.url)
    if (request.method !== 'POST' || url.pathname !== '/convert') {
      return Response.json({ error: 'Not found' }, { status: 404, headers: corsHeaders })
    }

    let body
    try { body = await request.json() }
    catch { return Response.json({ error: 'Invalid JSON' }, { status: 400, headers: corsHeaders }) }

    const { videoId } = body

    // Validate videoId
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return Response.json({ error: 'Invalid videoId' }, { status: 400, headers: corsHeaders })
    }

    // Poll RapidAPI (may return status: 'processing' initially)
    const MAX_ATTEMPTS = 5
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const apiRes = await fetch(
        `https://youtube-mp36.p.rapidapi.com/dl?id=${videoId}`,
        {
          headers: {
            'X-RapidAPI-Key': env.RAPIDAPI_KEY,
            'X-RapidAPI-Host': 'youtube-mp36.p.rapidapi.com',
          },
        }
      )

      if (apiRes.status === 429) {
        return Response.json(
          { error: 'Rate limit reached', resetAt: new Date(Date.now() + 86400000).toISOString() },
          { status: 429, headers: corsHeaders }
        )
      }

      if (!apiRes.ok) {
        return Response.json({ error: 'Conversion service unavailable' }, { status: 502, headers: corsHeaders })
      }

      const data = await apiRes.json()

      if (data.status === 'ok') {
        return Response.json({
          downloadUrl: data.link,
          title: data.title,
          duration: data.duration,
        }, { headers: corsHeaders })
      }

      if (data.status === 'fail') {
        return Response.json({ error: 'Conversion failed', detail: data.msg }, { status: 502, headers: corsHeaders })
      }

      // status === 'processing': wait and retry
      if (attempt < MAX_ATTEMPTS - 1) {
        await new Promise(r => setTimeout(r, 2000))
      }
    }

    return Response.json({ error: 'Conversion timed out' }, { status: 504, headers: corsHeaders })
  }
}
