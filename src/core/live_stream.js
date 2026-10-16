const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

// Store dynamic channel stream mappings (persisted across restarts)
const CHANNELS_FILE = path.join(__dirname, "../../data/channels.json");
const dataDir = path.join(__dirname, "../../data");
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Seed Channels for Willow, Sony, Star Sports & DD Sports
const SEED_CHANNELS = {
  "star1": {
    id: "star1",
    title: "Star Sports 1 HD",
    upstreamUrl: "http://51.75.127.199:3141/starsports2/index.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36"
  },
  "starhindi": {
    id: "starhindi",
    title: "Star Sports 1 Hindi HD",
    upstreamUrl: "http://51.75.127.199:3141/starsportskhel/index.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36"
  },
  "ddsports": {
    id: "ddsports",
    title: "DD Sports 1.0 HD (Cricket)",
    upstreamUrl: "https://mumbai-edge.smartplaytv.in/DDSportsHD/index.m3u8",
    referer: "https://sportslive.wine/",
    userAgent: "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36"
  }
};

function loadChannels() {
  try {
    if (fs.existsSync(CHANNELS_FILE)) {
      const data = fs.readFileSync(CHANNELS_FILE, "utf8");
      const parsed = JSON.parse(data);
      return { ...SEED_CHANNELS, ...parsed };
    }
  } catch (e) {
    console.warn("⚠️ [LiveStream] Could not read channels.json:", e.message);
  }
  return { ...SEED_CHANNELS };
}

function saveChannels(channels) {
  try {
    fs.writeFileSync(CHANNELS_FILE, JSON.stringify(channels, null, 2), "utf8");
  } catch (e) {
    console.warn("⚠️ [LiveStream] Could not save channels.json:", e.message);
  }
}

let channels = loadChannels();

// Token & Dynamic Stream Cache: key -> { streamUrl, referer, expiresAt }
const streamTokenCache = new Map();

class LiveStreamProxy {
  static getChannels() {
    return channels;
  }

  static getChannel(id) {
    if (!id) return null;
    return channels[id.toLowerCase()] || null;
  }

  static updateChannel(id, upstreamUrl, referer = "", title = "") {
    const cleanId = id.toLowerCase().trim();
    const existing = channels[cleanId] || {};
    channels[cleanId] = {
      id: cleanId,
      title: title || existing.title || cleanId.toUpperCase(),
      upstreamUrl: upstreamUrl.trim(),
      referer: referer.trim() || existing.referer || "https://sportslive.wine/",
      userAgent: existing.userAgent || "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36",
      updatedAt: Date.now()
    };
    saveChannels(channels);
    console.log(`[LiveStream] Updated channel '${cleanId}' -> ${upstreamUrl}`);
    return channels[cleanId];
  }

  /**
   * Auto-Token & Stream Resolver
   * Checks if an upstream URL is active, or resolves a fresh dynamic stream token if expired
   */
  static async resolveActiveStream(targetUrl, referer = "") {
    const cacheKey = targetUrl;
    const cached = streamTokenCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached;
    }

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept": "*/*",
    };
    if (referer) headers["Referer"] = referer;

    try {
      const testRes = await fetch(targetUrl, {
        headers,
        signal: AbortSignal.timeout(4000),
      });

      if (testRes.ok) {
        const streamInfo = { streamUrl: targetUrl, referer, expiresAt: Date.now() + 10 * 60 * 1000 };
        streamTokenCache.set(cacheKey, streamInfo);
        return streamInfo;
      }
    } catch (_) {}

    return { streamUrl: targetUrl, referer, expiresAt: Date.now() + 60 * 1000 };
  }

  /**
   * Fetches upstream live manifest and rewrites chunk & sub-playlist URLs
   * into permanent proxy URLs pointing to this server.
   */
  static async serveManifest(req, res, channelId, dynamicUrl = "", dynamicReferer = "") {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    req.on("close", () => {
      clearTimeout(timeoutId);
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    try {
      let targetUrl = dynamicUrl;
      let referer = dynamicReferer;
      let userAgent = "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36";

      if (!targetUrl) {
        const chan = LiveStreamProxy.getChannel(channelId);
        if (chan && chan.upstreamUrl) {
          targetUrl = chan.upstreamUrl;
          referer = chan.referer;
          userAgent = chan.userAgent || userAgent;
        } else {
          // If not in local file, query Supabase public.live_channels dynamically
          const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
          const supabaseKey = (process.env.SUPABASE_ANON_KEY || "").trim();
          if (supabaseUrl && supabaseKey && !supabaseUrl.includes("placeholder")) {
            try {
              const supaRes = await fetch(`${supabaseUrl}/rest/v1/live_channels?id=eq.${encodeURIComponent(channelId)}&is_active=eq.true&limit=1`, {
                headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
                signal: AbortSignal.timeout(4000)
              });
              if (supaRes.ok) {
                const rows = await supaRes.json();
                if (Array.isArray(rows) && rows.length > 0) {
                  targetUrl = rows[0].stream_url;
                  referer = rows[0].referer || referer;
                }
              }
            } catch (_) {}
          }
        }
      }

      if (!targetUrl) {
        clearTimeout(timeoutId);
        return res.status(404).send(`Channel '${channelId}' is not active or not configured.`);
      }

      const activeStream = await LiveStreamProxy.resolveActiveStream(targetUrl, referer);
      targetUrl = activeStream.streamUrl;
      referer = activeStream.referer;

      const headers = {
        "User-Agent": userAgent,
        "Accept": "*/*",
      };
      if (referer) {
        headers["Referer"] = referer;
      }

      const upstream = await fetch(targetUrl, {
        headers,
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!upstream.ok) {
        return res.status(upstream.status).send(`Upstream server returned HTTP ${upstream.status}`);
      }

      const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
      const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);

      // Direct binary video file (MP4/MKV)
      if (contentType.startsWith("video/") || contentLength > 5 * 1024 * 1024) {
        const hostOrigin = LiveStreamProxy.getHostOrigin(req);
        const chunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(referer)}`;
        let m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:7200.000,Direct Stream\n${chunkUrl}\n#EXT-X-ENDLIST\n`;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Headers", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        return res.send(m3u8);
      }

      const manifestText = await upstream.text();
      const hostOrigin = LiveStreamProxy.getHostOrigin(req);
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
      let parentQuery = "";
      try {
        parentQuery = new URL(targetUrl).search;
      } catch (_) {}

      const lines = manifestText.split("\n");
      const rewrittenLines = [];

      for (let line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("#")) {
          if (trimmed.includes('URI="')) {
            const rewrittenTag = trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
              const absoluteUri = LiveStreamProxy.resolveUrl(uri, baseUrl, parentQuery);
              const proxyChunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
              return `URI="${proxyChunkUrl}"`;
            });
            rewrittenLines.push(rewrittenTag);
          } else {
            rewrittenLines.push(line);
          }
        } else {
          const absoluteUri = LiveStreamProxy.resolveUrl(trimmed, baseUrl, parentQuery);
          let proxyUrl = "";

          if (absoluteUri.includes(".m3u8")) {
            proxyUrl = `${hostOrigin}/api/live/sub.m3u8?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          } else {
            proxyUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          }
          rewrittenLines.push(proxyUrl);
        }
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      return res.send(rewrittenLines.join("\n"));
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError" || controller.signal.aborted) {
        return;
      }
      console.error("[LiveStream Proxy Error]:", err.message);
      if (!res.headersSent) {
        return res.status(500).send(`Live proxy error: ${err.message}`);
      }
    }
  }

  /**
   * Proxies individual video TS / M4S chunks with full HTTP 206 Partial Content support
   */
  static async serveChunk(req, res) {
    const chunkUrl = req.query.url;
    const referer = req.query.ref || req.query.referer || "";
    if (!chunkUrl) {
      return res.status(400).send("Missing chunk 'url' parameter.");
    }

    try {
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "*/*",
      };
      if (referer) {
        headers["Referer"] = referer;
      }
      if (req.headers.range) {
        headers["Range"] = req.headers.range;
      }

      const upstream = await fetch(chunkUrl, { headers, signal: AbortSignal.timeout(15000) });
      const statusCode = upstream.status;

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type");

      const ct = upstream.headers.get("content-type") || "video/mp2t";
      res.setHeader("Content-Type", ct.includes("linguist") || ct.includes("text/vnd") ? "video/mp2t" : ct);

      if (upstream.headers.get("content-range")) {
        res.setHeader("Content-Range", upstream.headers.get("content-range"));
      }
      if (upstream.headers.get("content-length")) {
        res.setHeader("Content-Length", upstream.headers.get("content-length"));
      }
      if (upstream.headers.get("accept-ranges")) {
        res.setHeader("Accept-Ranges", upstream.headers.get("accept-ranges"));
      }
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");

      res.status(statusCode);

      if (upstream.body) {
        const nodeStream = Readable.fromWeb(upstream.body);
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).send(`Chunk proxy error: ${err.message}`);
      }
    }
  }

  static getHostOrigin(req) {
    const envHost = (
      process.env.EXOPLAYER_URL ||
      process.env.MINIAPP_URL ||
      process.env.WEBAPP_URL ||
      process.env.BASE_HOST_URL ||
      process.env.HOST_URL ||
      ""
    ).trim().replace(/^[=\s"']+/, "").replace(/[/"'\s]+$/, "");

    if (envHost && !envHost.includes("127.0.0.1") && !envHost.includes("localhost")) {
      let clean = envHost.startsWith("http://") || envHost.startsWith("https://") ? envHost : `https://${envHost}`;
      clean = clean.replace(/\/player$/, "").replace(/\/exoplayer$/, "");
      return clean.replace(/^http:\/\//i, "https://");
    }

    const proto = req.headers["x-forwarded-proto"] || "https";
    let host = req.headers["x-forwarded-host"] || req.headers["host"] || req.get("host") || "";
    if (!host || host.includes("127.0.0.1") || host.includes("localhost")) {
      host = "cineflix-ott.duckdns.org";
    }
    return `${proto}://${host}`;
  }

  static resolveUrl(relativeUrl, baseUrl, parentQuery = "") {
    let resolved = "";
    if (relativeUrl.startsWith("http://") || relativeUrl.startsWith("https://")) {
      resolved = relativeUrl;
    } else {
      try {
        resolved = new URL(relativeUrl, baseUrl).href;
      } catch (_) {
        resolved = baseUrl + relativeUrl;
      }
    }
    if (parentQuery && !resolved.includes("?")) {
      resolved += parentQuery.startsWith("?") ? parentQuery : "?" + parentQuery;
    }
    return resolved;
  }

  /**
   * Resolves channel's clean stream URL and referer (from memory or Supabase)
   */
  static async resolveChannelSource(channelId) {
    if (!channelId) return null;
    let targetUrl = "";
    let referer = "";

    const chan = LiveStreamProxy.getChannel(channelId);
    if (chan && chan.upstreamUrl) {
      targetUrl = chan.upstreamUrl;
      referer = chan.referer;
    } else {
      const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
      const supabaseKey = (process.env.SUPABASE_ANON_KEY || "").trim();
      if (supabaseUrl && supabaseKey && !supabaseUrl.includes("placeholder")) {
        try {
          const supaRes = await fetch(`${supabaseUrl}/rest/v1/live_channels?id=eq.${encodeURIComponent(channelId)}&is_active=eq.true&limit=1`, {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
            signal: AbortSignal.timeout(4000)
          });
          if (supaRes.ok) {
            const rows = await supaRes.json();
            if (Array.isArray(rows) && rows.length > 0) {
              targetUrl = rows[0].stream_url;
              referer = rows[0].referer || referer;
            }
          }
        } catch (_) {}
      }
    }

    if (targetUrl) {
      const activeStream = await LiveStreamProxy.resolveActiveStream(targetUrl, referer);
      return { streamUrl: activeStream.streamUrl, referer: activeStream.referer };
    }
    return null;
  }
}

module.exports = {
  LiveStreamProxy
};
