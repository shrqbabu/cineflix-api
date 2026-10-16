const http = require("http");
const https = require("https");
const { URL } = require("url");

// 60-second in-memory cache for resolved stream URLs: channelId -> { streamUrl, referer, expiresAt }
const streamCache = new Map();

// Built-in fallback channels in case Supabase is offline or not configured
const FALLBACK_EMBED_URLS = {
  webcricp01: "https://web.finalspot.top/hembedplayer/webcricp01/1/850/480",
  webcricn02: "https://web.finalspot.top/hembedplayer/webcricn02/1/850/480",
  willow1: "https://web.finalspot.top/hembedplayer/willow1/1/850/480",
  webcricskysports: "https://web.finalspot.top/hembedplayer/webcricskysports/1/850/480",
  csstream1: "https://1freecdn.xyz/hembedplayer/csstream1/1/960/540",
  csstream2: "https://1freecdn.xyz/hembedplayer/csstream2/1/960/540"
};

/**
 * Determine public self-hosted origin (ensures no internal 127.0.0.1:3000 leaks)
 */
function getSelfOrigin(req) {
  let host = req.headers["x-forwarded-host"] || req.get("host") || "";
  let proto = req.headers["x-forwarded-proto"] || "https";

  if (!host || host.includes("127.0.0.1") || host.includes("localhost") || host.includes(":3000") || host.includes(":7860")) {
    host = "shariqbabu-cineflix-ott.hf.space";
    proto = "https";
  }

  return `${proto}://${host}`;
}

/**
 * Native Node.js HTTP/HTTPS fetch with Vidict TLS bypass & IPv4 enforcement
 */
function nativeFetch(targetUrl, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(targetUrl);
      const client = u.protocol === "https:" ? https : http;
      const isMyTurn = u.hostname.includes("myturn1.top");

      const options = {
        method: "GET",
        headers: {
          ...headers,
          Host: u.host,
          Connection: "close"
        },
        rejectUnauthorized: false,
        checkServerIdentity: () => undefined,
        servername: isMyTurn ? undefined : u.hostname,
        family: 4
      };

      const req = client.request(u, options, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      });

      req.on("error", reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Remove dummy verification character inserted by WebCric / 1freecdn scripts
 */
function enableVideo(pk, is1FreeCdn = false) {
  if (is1FreeCdn) {
    // 1freecdn newmips.js removes character at index 54
    return pk.substring(0, 54) + pk.substring(55);
  }
  // finalspot newucaster.js removes character at index 53
  return pk.substring(0, 53) + pk.substring(54);
}

/**
 * Query Supabase for channel's embed URL (cdn_url)
 */
async function getChannelEmbedUrl(channelId) {
  const supaUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  if (supaUrl && supaKey && !supaUrl.includes("placeholder")) {
    try {
      const url = `${supaUrl}/rest/v1/live_channels?id=eq.${encodeURIComponent(channelId)}&select=id,cdn_url,stream_url,referer&limit=1`;
      const res = await nativeFetch(url, {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        Accept: "application/json"
      }, 5000);

      if (res.statusCode === 200) {
        const data = JSON.parse(res.body);
        if (Array.isArray(data) && data.length > 0) {
          const row = data[0];
          const embedUrl = row.cdn_url || (row.stream_url && (row.stream_url.includes("embed") || row.stream_url.includes("hembedplayer")) ? row.stream_url : "");
          if (embedUrl) {
            return { embedUrl, referer: row.referer || "" };
          }
        }
      }
    } catch (err) {
      console.warn(`[HlsExtractor] Supabase channel lookup notice: ${err.message}`);
    }
  }

  // Fallback map
  const fallback = FALLBACK_EMBED_URLS[channelId.toLowerCase()];
  if (fallback) {
    return { embedUrl: fallback, referer: "" };
  }

  // If channelId is already an HTTP URL, use it directly
  if (channelId.startsWith("http://") || channelId.startsWith("https://")) {
    return { embedUrl: channelId, referer: "" };
  }

  return null;
}

/**
 * Auto-toggle channel status in Supabase (200 OK -> true, Error/404/409 -> false)
 */
async function updateSupabaseChannelStatus(channelId, isActive) {
  const supaUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supaKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

  if (!supaUrl || !supaKey || supaUrl.includes("placeholder")) return;

  try {
    const patchUrl = `${supaUrl}/rest/v1/live_channels?id=eq.${encodeURIComponent(channelId)}`;
    const u = new URL(patchUrl);
    const client = u.protocol === "https:" ? https : http;
    const bodyStr = JSON.stringify({ is_active: isActive });

    const req = client.request(u, {
      method: "PATCH",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal"
      },
      family: 4
    });
    req.on("error", () => {});
    req.write(bodyStr);
    req.end();
  } catch (_) {}
}

/**
 * Extract active stream URL from embed player page HTML
 */
async function resolveEmbedStream(channelId) {
  const cleanId = channelId.toLowerCase().trim();
  const cached = streamCache.get(cleanId);
  if (cached && Date.now() < cached.expiresAt) {
    return cached;
  }

  const channelInfo = await getChannelEmbedUrl(cleanId);
  if (!channelInfo || !channelInfo.embedUrl) {
    throw new Error(`No embed URL configured for channel '${cleanId}'`);
  }

  const { embedUrl, referer: dbReferer } = channelInfo;
  const is1FreeCdn = embedUrl.includes("1freecdn");
  const referer = dbReferer || (is1FreeCdn ? "https://webcric.is/" : "https://webcric.im/");

  // If embedUrl is already a direct M3U8 or MPD stream, return it immediately without embed parsing
  if (embedUrl.includes(".m3u8") || embedUrl.includes(".mpd")) {
    const resolved = {
      streamUrl: embedUrl,
      referer: dbReferer || "",
      expiresAt: Date.now() + 60000
    };
    streamCache.set(cleanId, resolved);
    return resolved;
  }

  const res = await nativeFetch(embedUrl, {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: referer
  }, 10000);

  if (res.statusCode !== 200) {
    updateSupabaseChannelStatus(cleanId, false);
    throw new Error(`Embed page returned HTTP ${res.statusCode}`);
  }

  const html = res.body;
  const hlsBaseMatch = html.match(/hlsUrl\s*=\s*["']([^"']*)["']\s*\+\s*ea(?:\s*\+\s*["']|["'])([^"']*)["']/i);
  const pkMatch = html.match(/var\s+pk\s*=\s*["']([^"']+)["']/i);
  const eaMatch = html.match(/ea\s*=\s*["']([^"']+)["']/i);

  if (!hlsBaseMatch || !pkMatch || !eaMatch) {
    // Channel offline when no match is live
    updateSupabaseChannelStatus(cleanId, false);
    throw new Error(`Channel '${cleanId}' is currently offline (no active stream broadcast)`);
  }

  const cleanPk = enableVideo(pkMatch[1], is1FreeCdn);
  let fullUrl = hlsBaseMatch[1] + eaMatch[1] + hlsBaseMatch[2] + cleanPk;

  // 1freecdn runs on HTTP port 8088
  if (is1FreeCdn) {
    if (fullUrl.startsWith("https://")) {
      fullUrl = "http://" + fullUrl.substring(8);
    }
    if (!fullUrl.includes(":8088")) {
      fullUrl = fullUrl.replace(/(http:\/\/[^\/:]+)/, "$1:8088");
    }
  }

  const resolved = {
    streamUrl: fullUrl,
    referer,
    expiresAt: Date.now() + 60000 // Cache token for 60 seconds
  };

  streamCache.set(cleanId, resolved);
  return resolved;
}

/**
 * Rewrites any M3U8 manifest lines to route through self-hosted resource endpoint
 */
function rewriteManifest(manifestText, baseUrl, parentQuery, channelId, referer, selfOrigin) {
  const lines = manifestText.split("\n");
  const rewrittenLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        const rewrittenTag = trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
          const absoluteUri = uri.startsWith("http") ? uri : (baseUrl + uri + (uri.includes("?") ? "" : parentQuery));
          const proxyUri = `${selfOrigin}/hls/${encodeURIComponent(channelId)}/resource?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          return `URI="${proxyUri}"`;
        });
        rewrittenLines.push(rewrittenTag);
      } else {
        rewrittenLines.push(trimmed);
      }
    } else {
      // Chunk or Sub-playlist line
      const absoluteUrl = trimmed.startsWith("http") ? trimmed : (baseUrl + trimmed + (trimmed.includes("?") ? "" : parentQuery));
      const proxyUrl = `${selfOrigin}/hls/${encodeURIComponent(channelId)}/resource?url=${encodeURIComponent(absoluteUrl)}&ref=${encodeURIComponent(referer)}`;
      rewrittenLines.push(proxyUrl);
    }
  }

  return rewrittenLines.join("\n") + "\n";
}

/**
 * Handle GET /hls/:id/playlist and /hls/:id/playlist.m3u8
 */
async function handlePlaylist(req, res) {
  const channelId = req.params.id;
  if (!channelId) {
    return res.status(400).send("Missing channel ID");
  }

  try {
    const { streamUrl, referer } = await resolveEmbedStream(channelId);

    const upstreamRes = await nativeFetch(streamUrl, {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Referer: referer
    }, 12000);

    if (upstreamRes.statusCode !== 200) {
      streamCache.delete(channelId.toLowerCase());
      updateSupabaseChannelStatus(channelId, false);
      return res.status(upstreamRes.statusCode).send(`Upstream stream returned HTTP ${upstreamRes.statusCode}`);
    }

    // Mark channel active in Supabase upon successful 200 OK stream manifest
    updateSupabaseChannelStatus(channelId, true);

    const manifestText = upstreamRes.body;
    const selfOrigin = getSelfOrigin(req);
    const baseUrl = streamUrl.substring(0, streamUrl.lastIndexOf("/") + 1);

    let parentQuery = "";
    try {
      parentQuery = new URL(streamUrl).search;
    } catch (_) {}

    const rewrittenManifest = rewriteManifest(manifestText, baseUrl, parentQuery, channelId, referer, selfOrigin);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.status(200).send(rewrittenManifest);
  } catch (err) {
    updateSupabaseChannelStatus(channelId, false);
    return res.status(502).send(`HLS Extraction Error: ${err.message}`);
  }
}

/**
 * Handle GET /hls/:id/resource (serves sub-playlists and video chunks directly via self-hosted server)
 */
function handleResource(req, res) {
  const channelId = req.params.id || "live";
  const targetUrl = req.query.url;
  const referer = req.query.ref || req.query.referer || "";

  if (!targetUrl) {
    return res.status(400).send("Missing 'url' query parameter");
  }

  try {
    const u = new URL(targetUrl);
    const client = u.protocol === "https:" ? https : http;
    const isMyTurn = u.hostname.includes("myturn1.top");

    const reqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      Host: u.host,
      Connection: "close"
    };

    if (referer) reqHeaders["Referer"] = referer;
    if (req.headers["range"]) reqHeaders["Range"] = req.headers["range"];

    const options = {
      method: "GET",
      headers: reqHeaders,
      rejectUnauthorized: false,
      checkServerIdentity: () => undefined,
      servername: isMyTurn ? undefined : u.hostname,
      family: 4
    };

    const upstreamReq = client.request(u, options, (upstreamRes) => {
      const ct = (upstreamRes.headers["content-type"] || "").toLowerCase();
      const isM3u8 = ct.includes("mpegurl") || targetUrl.includes(".m3u8");

      if (isM3u8 && upstreamRes.statusCode === 200) {
        // Sub-playlist received: rewrite its internal chunk URLs as well
        const chunks = [];
        upstreamRes.on("data", (c) => chunks.push(c));
        upstreamRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          const selfOrigin = getSelfOrigin(req);
          const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
          let parentQuery = "";
          try { parentQuery = new URL(targetUrl).search; } catch (_) {}

          const rewritten = rewriteManifest(body, baseUrl, parentQuery, channelId, referer, selfOrigin);

          res.status(200);
          res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Headers", "*");
          res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          return res.send(rewritten);
        });
        return;
      }

      // Binary video chunk (.ts): pipe directly
      res.status(upstreamRes.statusCode);

      for (const [key, val] of Object.entries(upstreamRes.headers)) {
        if (key.toLowerCase() !== "content-security-policy") {
          res.setHeader(key, val);
        }
      }

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

      upstreamRes.pipe(res);
    });

    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).send(`Chunk Relay Error: ${err.message}`);
      }
    });

    upstreamReq.setTimeout(25000, () => {
      upstreamReq.destroy();
      if (!res.headersSent) {
        res.status(504).send("Chunk request timed out");
      }
    });

    upstreamReq.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(400).send(`Invalid URL: ${err.message}`);
    }
  }
}

module.exports = {
  resolveEmbedStream,
  handlePlaylist,
  handleResource,
  nativeFetch
};
