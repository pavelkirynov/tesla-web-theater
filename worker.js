// ─────────────────────────────────────────────────────────────────────────
// Tesla Theater · YouTube extractor (Cloudflare Worker)
//
// Deploy in 2 minutes:
//   1. https://workers.cloudflare.com → "Create Worker" → "Edit Code"
//   2. Replace the default scaffold with this entire file → Deploy
//   3. Copy the worker URL (e.g. https://yt-proxy.YOURNAME.workers.dev/)
//   4. In index.html set:  const CUSTOM_BACKEND = 'https://yt-proxy.YOURNAME.workers.dev/';
//   5. git push, done. Free tier covers 100k requests/day.
//
// Endpoints:
//   GET /?id=VIDEOID            → {kind:'mp4'|'hls', url, itag, title, client}
//   GET /?id=VIDEOID&debug=1    → full diagnostic with every client's reason
//
// Bot-detection workaround:
//   YouTube returns UNPLAYABLE for many requests originating from Cloudflare
//   datacenter IPs. We mitigate by (1) fetching a visitorData token from
//   sw.js_data first and threading it into context.client.visitorData +
//   X-Goog-Visitor-Id, and (2) trying several Innertube clients in priority
//   order — TVHTML5_SIMPLY_EMBEDDED_PLAYER and WEB_EMBEDDED_PLAYER tend to
//   slip through when the IOS/ANDROID clients are blocked.
// ─────────────────────────────────────────────────────────────────────────

const UA_TV   = 'Mozilla/5.0 (PlayStation; PlayStation 4/12.00) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';
const UA_IOS  = 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)';
const UA_AND  = 'com.google.android.youtube/19.44.38 (Linux; U; Android 14; SM-S928B) gzip';
const UA_WEB  = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const CLIENTS = [
  // TVHTML5 historically the most resistant to bot detection — used for
  // age-restricted bypass in yt-dlp.
  { name: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', cname: '85', ua: UA_TV, ctx: {
      clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0',
      platform: 'TV', clientScreen: 'EMBED',
      osName: 'Tizen', osVersion: '6.5', hl: 'en', gl: 'US',
  }, embedded: true },
  // Embedded web client — same trick as the iframe embed but server-side
  { name: 'WEB_EMBEDDED_PLAYER', cname: '56', ua: UA_WEB, ctx: {
      clientName: 'WEB_EMBEDDED_PLAYER', clientVersion: '1.20241201.01.00',
      clientScreen: 'EMBED', hl: 'en', gl: 'US',
  }, embedded: true },
  // IOS — combined audio+video MP4, no n-cipher
  { name: 'IOS', cname: '5', ua: UA_IOS, ctx: {
      clientName: 'IOS', clientVersion: '19.45.4',
      deviceMake: 'Apple', deviceModel: 'iPhone16,2',
      osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
  } },
  // ANDROID — sometimes succeeds where IOS fails
  { name: 'ANDROID', cname: '3', ua: UA_AND, ctx: {
      clientName: 'ANDROID', clientVersion: '19.44.38',
      androidSdkVersion: 34, hl: 'en', gl: 'US',
  } },
  // MWEB — last-ditch mobile web
  { name: 'MWEB', cname: '2', ua: UA_WEB, ctx: {
      clientName: 'MWEB', clientVersion: '2.20241201.01.00',
      hl: 'en', gl: 'US',
  } },
];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const videoId = url.searchParams.get('id');
    const debug = url.searchParams.get('debug') === '1';
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return cors(json({ error: 'invalid or missing ?id' }, 400));
    }

    const visitorData = await fetchVisitorData().catch(e => null);
    const attempts = [];
    for (const client of CLIENTS) {
      const r = await tryClient(videoId, client, visitorData);
      attempts.push({ client: client.name, ...r, ok: r.ok });
      if (r.ok) {
        const payload = { ...r.data, visitorData: !!visitorData };
        if (debug) payload._attempts = attempts;
        return cors(json(payload));
      }
    }

    return cors(json({
      error: 'no playable stream from any client',
      visitorData: !!visitorData,
      attempts,
    }, 502));
  },
};

async function fetchVisitorData() {
  const res = await fetch('https://www.youtube.com/sw.js_data', {
    headers: { 'User-Agent': UA_WEB, 'Accept-Language': 'en-US,en' },
  });
  if (!res.ok) return null;
  const text = await res.text();
  const m = text.match(/"visitorData":"([^"]+)"/) || text.match(/\\"visitorData\\":\\"([^"\\]+)\\"/);
  return m ? m[1] : null;
}

async function tryClient(videoId, client, visitorData) {
  const ctx = { ...client.ctx };
  if (visitorData) ctx.visitorData = visitorData;
  const body = {
    context: {
      client: ctx,
      ...(client.embedded ? { thirdParty: { embedUrl: 'https://www.youtube.com' } } : {}),
    },
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': client.ua,
        'X-YouTube-Client-Name': client.cname,
        'X-YouTube-Client-Version': ctx.clientVersion,
        ...(visitorData ? { 'X-Goog-Visitor-Id': visitorData } : {}),
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { reason: `fetch threw: ${e.message}`, ms: Date.now() - t0 };
  }
  const ms = Date.now() - t0;
  if (!res.ok) return { reason: `HTTP ${res.status}`, ms };

  let data;
  try { data = await res.json(); }
  catch (e) { return { reason: `JSON parse: ${e.message}`, ms }; }

  const ps = data?.playabilityStatus;
  if (ps && ps.status !== 'OK') {
    return { reason: `${ps.status}: ${(ps.reason || '').slice(0, 120)}`, ms };
  }

  const formats = data?.streamingData?.formats || [];
  const mp4 =
    formats.find(f => f.itag === 22) ||
    formats.find(f => f.itag === 18) ||
    formats.find(f => (f.mimeType || '').includes('video/mp4'));

  if (mp4?.url) {
    return {
      ok: true, ms,
      data: {
        kind: 'mp4',
        url: mp4.url,
        itag: mp4.itag,
        quality: mp4.qualityLabel,
        mime: mp4.mimeType,
        client: client.name,
        title: data.videoDetails?.title,
        durationSec: Number(data.videoDetails?.lengthSeconds) || null,
        expiresInSec: data.streamingData?.expiresInSeconds,
      },
    };
  }

  const hls = data?.streamingData?.hlsManifestUrl;
  if (hls) {
    return {
      ok: true, ms,
      data: { kind: 'hls', url: hls, client: client.name,
              title: data.videoDetails?.title },
    };
  }

  // No combined formats but adaptive may exist — note for diagnostics
  const adaptive = (data?.streamingData?.adaptiveFormats || []).length;
  return { reason: `no combined formats (adaptive=${adaptive})`, ms };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Cache-Control', 'public, max-age=120');
  return new Response(res.body, { status: res.status, headers: h });
}
