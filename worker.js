// ─────────────────────────────────────────────────────────────────────────
// Tesla Theater · YouTube extractor (Cloudflare Worker)
//
// Why this exists:
//   The browser-only canvas pipeline relies on getting a direct MP4 URL.
//   In 2026 every public Piped/Invidious instance is dead or rate-limited,
//   so the only resilient option is a tiny server-side helper that hits
//   YouTube's mobile player API directly and returns the playable URL.
//
// Deploy in 2 minutes:
//   1. https://workers.cloudflare.com → "Create Worker" → "Edit Code"
//   2. Replace the default scaffold with this entire file → Deploy
//   3. Copy the worker URL (e.g. https://yt-proxy.YOURNAME.workers.dev/)
//   4. In index.html set:  const CUSTOM_BACKEND = 'https://yt-proxy.YOURNAME.workers.dev/';
//   5. git push, done. Free tier covers 100k requests/day.
//
// Endpoint:
//   GET /?id=VIDEOID
//   →  { kind: 'mp4'|'hls', url: '...', title, itag, expiresAt }
// ─────────────────────────────────────────────────────────────────────────

const CLIENTS = [
  // IOS client returns combined audio+video formats with no n-cipher.
  // Most reliable for our use case.
  {
    name: 'IOS',
    body: {
      context: {
        client: {
          clientName: 'IOS',
          clientVersion: '19.45.4',
          deviceMake: 'Apple',
          deviceModel: 'iPhone16,2',
          osName: 'iPhone',
          osVersion: '18.1.0.22B83',
          hl: 'en', gl: 'US',
        },
      },
    },
  },
  // ANDROID_TESTSUITE returns combined formats for many videos as a fallback.
  {
    name: 'ANDROID_TESTSUITE',
    body: {
      context: {
        client: {
          clientName: 'ANDROID_TESTSUITE',
          clientVersion: '1.9',
          androidSdkVersion: 30,
          hl: 'en', gl: 'US',
        },
      },
    },
  },
];

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    const url = new URL(request.url);
    const videoId = url.searchParams.get('id');
    if (!videoId || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
      return cors(json({ error: 'invalid or missing ?id' }, 400));
    }

    let lastReason = null;
    for (const client of CLIENTS) {
      try {
        const data = await callPlayerApi(videoId, client.body);
        const status = data?.playabilityStatus?.status;
        if (status && status !== 'OK') { lastReason = `${client.name}:${status}`; continue; }

        const formats = data?.streamingData?.formats || [];
        const mp4 =
          formats.find(f => f.itag === 22) ||
          formats.find(f => f.itag === 18) ||
          formats.find(f => (f.mimeType || '').includes('video/mp4')) ||
          formats[0];

        if (mp4?.url) {
          return cors(json({
            kind: 'mp4',
            url: mp4.url,
            itag: mp4.itag,
            quality: mp4.qualityLabel,
            mime: mp4.mimeType,
            client: client.name,
            title: data.videoDetails?.title,
            durationSec: Number(data.videoDetails?.lengthSeconds) || null,
            expiresInSec: data.streamingData?.expiresInSeconds,
          }));
        }

        const hls = data?.streamingData?.hlsManifestUrl;
        if (hls) {
          return cors(json({
            kind: 'hls',
            url: hls,
            client: client.name,
            title: data.videoDetails?.title,
          }));
        }

        lastReason = `${client.name}:no-formats`;
      } catch (e) {
        lastReason = `${client.name}:${e.message}`;
      }
    }

    return cors(json({ error: 'no playable stream', lastReason }, 502));
  },
};

async function callPlayerApi(videoId, baseBody) {
  const body = {
    ...baseBody,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
  };
  const res = await fetch(
    'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.ios.youtube/19.45.4 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X)',
        'X-YouTube-Client-Name': '5',
        'X-YouTube-Client-Version': '19.45.4',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Cache-Control', 'public, max-age=300');
  return new Response(res.body, { status: res.status, headers: h });
}
