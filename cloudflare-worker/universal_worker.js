/**
 * CineFlix / MovieBox Universal Cloudflare Worker (100% Ultra-Fast Edge & Multi-Prefetch Fixed)
 * - Cloudflare Edge CDN Caching (caches.default) for Telegram Chunks & Segments (< 15ms)
 * - Automatic Multi-Chunk Background Pre-Fetching (next, next2, next3, next4, next5)
 * - Zero-Freeze Fast-Forward & Seeking (Always caches full chunk on edge + instant 206 slice)
 * - Auto-proxies CineFlix OTT Mini App (/player & /exoplayer) to VPS/HuggingFace
 * - Auto-proxies CineFlix Login (/auth/login) to VPS
 * - Auto-proxies /play (MX Player, VLC, Web Hub) to VPS
 * - Auto-proxies /id (MovieBox HLS & Segments) to VPS
 * - Streams Telegram MTProto via VPS (/api/tg/stream) with HTTP 206 Range & Edge Cache
 * - Live Sports M3U8 Manifest Rewriter & Chunk Relay
 */

const ADMIN_PIN = "shrq63938";
const APP_SECRET_KEY = "s211";

// Permanent VPS Backend URL (DuckDNS / VPS / HuggingFace)
const VPS_BASE_URL = "https://cineflix-ott.duckdns.org";

let inMemoryChannels = {};
let inMemoryMovies = {};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return handleCors();
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const vpsHost = (env && env.VPS_HOST_URL ? String(env.VPS_HOST_URL) : VPS_BASE_URL).replace(/\/+$/, "");

    try {
      // 1. Health Check
      if (path === "/health" || path === "/api/health") {
        return jsonResponse({ status: "healthy", timestamp: Date.now(), service: "CineFlix Cloudflare Edge Worker" });
      }

      // 2. Forward CineFlix OTT Mini App Player (/player, /exoplayer, styles.css, player.js)
      if (
        path.startsWith("/player") ||
        path.startsWith("/exoplayer") ||
        path === "/styles.css" ||
        path === "/player.js"
      ) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      // 3. Forward CineFlix Authentication & Supabase Login (/auth/login, /auth/logout)
      if (path.startsWith("/auth")) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
      }

      // 4. Forward Universal Player Hub (/play/mx, /play/vlc, /play/hub, /play/playlist.m3u)
      if (path.startsWith("/play")) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      // 5. Forward MovieBox HLS & Direct Streams (/id/:id/...)
      if (path.startsWith("/id/")) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      // 6. Telegram Stream via VPS / GramJS with Edge Caching & Multi-Segment Prefetching (/api/tg/stream)
      if (path === "/api/tg/stream") {
        return await serveEdgeAcceleratedTelegramStream(request, env, ctx, url, vpsHost);
      }

      // 7. Admin Authentication Login
      if (path === "/api/admin/login" && request.method === "POST") {
        const body = await request.json().catch(() => ({}));
        const pin = (body.pin || body.password || "").trim();
        if (pin === ADMIN_PIN || pin === APP_SECRET_KEY) {
          return jsonResponse({ success: true, token: APP_SECRET_KEY, message: "Admin authenticated" });
        }
        return jsonResponse({ success: false, error: "Invalid Admin PIN" }, 401);
      }

      // 8. Live Channels List & Update
      if (path === "/api/live/channels") {
        if (Object.keys(inMemoryChannels).length > 0) {
          return jsonResponse({ success: true, channels: inMemoryChannels });
        }
        // Fallback to VPS backend channels list
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      if (path === "/api/live/update" && request.method === "POST") {
        const authError = verifyAdminAuth(request);
        if (authError) return authError;
        const body = await request.json().catch(() => ({}));
        const { id, upstreamUrl, referer, title } = body;
        if (!id || !upstreamUrl) return jsonResponse({ error: "Missing id or upstreamUrl" }, 400);
        inMemoryChannels[id.toLowerCase()] = {
          id: id.toLowerCase(),
          title: title || id.toUpperCase(),
          upstreamUrl: upstreamUrl.trim(),
          referer: referer || "https://sportslive.wine/",
          updatedAt: Date.now()
        };
        return jsonResponse({ success: true, channel: inMemoryChannels[id.toLowerCase()] });
      }

      // 9. Movie Overrides List & Update
      if (path === "/api/movie/list") {
        if (Object.keys(inMemoryMovies).length > 0) {
          return jsonResponse({ success: true, movies: inMemoryMovies });
        }
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });
      }

      if (path === "/api/movie/update" && request.method === "POST") {
        const authError = verifyAdminAuth(request);
        if (authError) return authError;
        const body = await request.json().catch(() => ({}));
        const { id, upstreamUrl, referer, title } = body;
        if (!id || !upstreamUrl) return jsonResponse({ error: "Missing id or upstreamUrl" }, 400);
        inMemoryMovies[id.toLowerCase()] = {
          id: id.toLowerCase(),
          title: title || id,
          upstreamUrl: upstreamUrl.trim(),
          referer: referer || "https://sportslive.wine/",
          updatedAt: Date.now()
        };
        return jsonResponse({ success: true, movie: inMemoryMovies[id.toLowerCase()] });
      }

      // 10. Universal Stream Resolver API
      if (path.startsWith("/api/resolve/")) {
        const rawId = path.replace("/api/resolve/", "").trim().toLowerCase();
        const custom = inMemoryMovies[rawId];
        if (custom && custom.upstreamUrl) {
          const isDirect = isDirectVideo(custom.upstreamUrl);
          return jsonResponse({
            success: true,
            provider: "custom",
            streamUrl: custom.upstreamUrl,
            referer: custom.referer,
            format: isDirect ? "DIRECT" : (custom.upstreamUrl.includes(".mpd") ? "DASH" : "HLS")
          });
        }

        // Forward to VPS Resolver Backend
        const targetUrl = `${vpsHost}${path}${url.search}`;
        const vpsRes = await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
        });

        // Rewrite VPS URLs to Cloudflare Worker domain so streaming goes through CDN
        if (vpsRes.ok) {
          const vpsData = await vpsRes.json().catch(() => null);
          if (vpsData && vpsData.success && vpsData.streamUrl) {
            const workerOrigin = url.origin;
            vpsData.streamUrl = vpsData.streamUrl.replace(/https?:\/\/cineflix-ott\.duckdns\.org/g, workerOrigin);
            if (vpsData.proxyUrl) {
              vpsData.proxyUrl = vpsData.proxyUrl.replace(/https?:\/\/cineflix-ott\.duckdns\.org/g, workerOrigin);
            }
            return jsonResponse(vpsData);
          }
        }
        return vpsRes;
      }

      // 11. Live Stream Proxy & Sub-Playlists
      if (path === "/api/live/proxy.m3u8" || path === "/api/live/sub.m3u8") {
        const targetUrl = extractTargetUrl(request.url);
        const ref = url.searchParams.get("ref") || url.searchParams.get("referer") || "";
        if (!targetUrl) return new Response("Missing 'url' query parameter", { status: 400 });
        return await serveManifestProxy(request, targetUrl, ref);
      }

      // 12. Named Live Channel Route (/api/live/:id)
      if (path.startsWith("/api/live/")) {
        const chanId = path.replace("/api/live/", "").replace(".m3u8", "").trim().toLowerCase();
        if (chanId !== "chunk" && chanId !== "channels" && chanId !== "update" && chanId !== "scrape-now") {
          const chan = inMemoryChannels[chanId];
          if (chan && chan.upstreamUrl) {
            return await serveManifestProxy(request, chan.upstreamUrl, chan.referer);
          }
          // Forward to VPS live channel handler (preserves 302 redirect for load balancing)
          const targetUrl = `${vpsHost}${path}${url.search}`;
          return await fetch(targetUrl, {
            method: request.method,
            headers: request.headers,
            redirect: "manual"
          });
        }
      }

      // 13. Dynamic Movie HLS Proxy
      if (path === "/api/movie/proxy.m3u8") {
        const targetUrl = extractTargetUrl(request.url);
        const ref = url.searchParams.get("ref") || "";
        if (!targetUrl) return new Response("Missing 'url' query parameter", { status: 400 });

        if (isDirectVideo(targetUrl)) {
          const host = url.origin;
          const chunkUrl = `${host}/api/live/chunk?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(ref)}`;
          const m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:7200.000,Movie Stream\n${chunkUrl}\n#EXT-X-ENDLIST\n`;
          return new Response(m3u8, {
            headers: {
              "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "*",
              "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            }
          });
        }
        return await serveManifestProxy(request, targetUrl, ref);
      }

      // 14. High-Speed Progressive Video Stream & Binary Chunk Proxy (Range 206 Support)
      if (path === "/api/live/chunk" || path === "/api/movie/stream") {
        const targetUrl = extractTargetUrl(request.url);
        const ref = url.searchParams.get("ref") || "";
        if (!targetUrl) return new Response("Missing 'url' parameter", { status: 400 });
        return await serveChunkRelay(request, targetUrl, ref);
      }

      // 15. Forward all other API calls to VPS Backend
      if (path.startsWith("/api/")) {
        const targetUrl = `${vpsHost}${path}${url.search}`;
        return await fetch(targetUrl, {
          method: request.method,
          headers: request.headers,
          body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        });
      }

      return new Response("Endpoint Not Found", { status: 404 });
    } catch (err) {
      return new Response(`Worker Error: ${err.message}`, { status: 500 });
    }
  }
};

function extractTargetUrl(requestUrl) {
  try {
    const urlObj = new URL(requestUrl);
    return urlObj.searchParams.get("url") || "";
  } catch (_) {
    return "";
  }
}

/**
 * High-Speed Telegram Video & HLS Chunk Accelerator with Cloudflare Edge Cache
 */
async function serveEdgeAcceleratedTelegramStream(request, env, ctx, workerUrl, vpsHost) {
  try {
    const msgId = workerUrl.searchParams.get("msg") || workerUrl.searchParams.get("id");

    if (!msgId) {
      return new Response("Missing 'msg' parameter", {
        status: 400,
        headers: corsHeaders()
      });
    }

    if (!/^\d+$/.test(msgId)) {
      return new Response("Invalid message ID", {
        status: 400,
        headers: corsHeaders()
      });
    }

    let baseStreamUrl = (env && env.VPS_STREAM_URL ? String(env.VPS_STREAM_URL) : `${vpsHost}/api/tg/stream`).trim();
    if (!baseStreamUrl.includes("/api/tg/stream")) {
      baseStreamUrl = `${baseStreamUrl.replace(/\/+$/, "")}/api/tg/stream`;
    }

    const target = new URL(baseStreamUrl);
    target.searchParams.set("msg", msgId);

    const channel = workerUrl.searchParams.get("channel") || workerUrl.searchParams.get("chat_id");
    if (channel) {
      target.searchParams.set("channel", channel);
    }

    const cache = caches.default;
    const cacheKeyUrl = new URL(workerUrl.pathname + "?msg=" + msgId + (channel ? `&channel=${channel}` : ""), workerUrl.origin);
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
    const rangeHeader = request.headers.get("Range");

    // 1. Check Cloudflare Global Edge Cache (< 15ms Response)
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const cloned = new Response(cachedResponse.body, cachedResponse);
      cloned.headers.set("CF-Cache-Status", "HIT");
      cloned.headers.set("X-Edge-Cache", "HIT");
      cloned.headers.set("Access-Control-Allow-Origin", "*");

      if (request.method === "HEAD") {
        return new Response(null, { status: 200, headers: cloned.headers });
      }

      if (rangeHeader && cloned.status === 200) {
        return sliceRangeResponse(cloned, rangeHeader);
      }
      return cloned;
    }

    // 2. Fetch FULL Segment from Backend (Do not forward Range so we get full 200 OK to cache)
    const upstreamHeaders = new Headers();
    const ifRange = request.headers.get("If-Range");
    if (ifRange) upstreamHeaders.set("If-Range", ifRange);
    upstreamHeaders.set("User-Agent", "CineFlix-Worker-Edge/2.0");
    upstreamHeaders.set("Accept-Encoding", "identity");

    const upstream = await fetch(target.toString(), {
      method: "GET",
      headers: upstreamHeaders,
      redirect: "follow"
    });

    if (!upstream.ok && upstream.status !== 206) {
      return upstream;
    }

    const responseHeaders = new Headers(upstream.headers);

    // Normalize Video TS MIME Type (fixes Telegram default text/vnd.trolltech.linguist)
    const ct = responseHeaders.get("Content-Type") || "";
    if (ct.includes("linguist") || ct.includes("text/vnd") || !ct) {
      responseHeaders.set("Content-Type", "video/mp2t");
    }

    responseHeaders.set("Accept-Ranges", "bytes");
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, If-Range, Content-Type, Accept, User-Agent");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag, X-Edge-Cache");
    responseHeaders.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    responseHeaders.set("CDN-Cache-Control", "max-age=31536000, immutable");
    responseHeaders.set("CF-Cache-Status", "MISS");
    responseHeaders.set("X-Edge-Cache", "MISS");
    responseHeaders.set("X-CineFlix-Buffer-Mode", "prefetch-5");

    const edgeResponse = new Response(upstream.body, {
      status: 200,
      statusText: "OK",
      headers: responseHeaders
    });

    // 3. Cache Full Segment in Cloudflare Edge Cache
    if (request.method === "GET" && ctx) {
      ctx.waitUntil(cache.put(cacheKey, edgeResponse.clone()));
    }

    // 4. Background Prefetch upcoming actual Telegram segments (up to 5 in parallel)
    if (ctx) {
      const nextIds = [
        workerUrl.searchParams.get("next"),
        workerUrl.searchParams.get("next2"),
        workerUrl.searchParams.get("next3"),
        workerUrl.searchParams.get("next4"),
        workerUrl.searchParams.get("next5")
      ].filter((id) => id && /^\d+$/.test(id) && id !== msgId);

      if (nextIds.length > 0) {
        ctx.waitUntil(
          preloadTelegramMessages(
            cache,
            workerUrl.origin,
            target.origin,
            nextIds,
            channel
          )
        );
      }
    }

    if (request.method === "HEAD") {
      return new Response(null, { status: 200, headers: responseHeaders });
    }

    // 5. If client sent a Range header on this first request, slice from full body
    if (rangeHeader) {
      return sliceRangeResponse(edgeResponse, rangeHeader);
    }

    return edgeResponse;
  } catch (err) {
    return new Response(
      `VPS Telegram stream error: ${err?.message || String(err)}`,
      {
        status: 502,
        headers: corsHeaders()
      }
    );
  }
}

/**
 * Background preloader: fetches upcoming segments into Cloudflare Global CDN
 */
async function preloadTelegramMessages(cache, workerOrigin, vpsOrigin, messageIds, channel) {
  try {
    const ids = [...new Set(messageIds)].slice(0, 5);

    await Promise.all(
      ids.map(async (messageId) => {
        const cacheKey = new Request(
          `${workerOrigin}/api/tg/stream?msg=${messageId}${channel ? `&channel=${encodeURIComponent(channel)}` : ""}`,
          { method: "GET" }
        );

        if (await cache.match(cacheKey)) return;

        const target = new URL(`${vpsOrigin}/api/tg/stream`);
        target.searchParams.set("msg", messageId);
        if (channel) target.searchParams.set("channel", channel);

        const res = await fetch(target.toString(), {
          method: "GET",
          headers: {
            "User-Agent": "CineFlix-Edge-Prefetch/4.0",
            "Accept": "*/*",
            "Accept-Encoding": "identity"
          },
          redirect: "follow"
        });

        if (!res.ok) return;

        const headers = new Headers(res.headers);
        headers.set("Content-Type", "video/mp2t");
        headers.set("Accept-Ranges", "bytes");
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
        headers.set("CDN-Cache-Control", "max-age=31536000, immutable");
        headers.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag");

        await cache.put(
          cacheKey,
          new Response(res.body, {
            status: 200,
            statusText: "OK",
            headers
          })
        );
      })
    );
  } catch (_) {}
}

/**
 * Slices 200 response into 206 Partial Content when Range is requested on cached body
 */
async function sliceRangeResponse(response, rangeHeader) {
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) return response;

  const arrayBuffer = await response.arrayBuffer();
  const totalSize = arrayBuffer.byteLength;

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

  if (start >= totalSize || end >= totalSize || start > end) {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${totalSize}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const sliced = arrayBuffer.slice(start, end + 1);
  const headers = new Headers(response.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${totalSize}`);
  headers.set("Content-Length", String(sliced.byteLength));
  headers.set("Accept-Ranges", "bytes");

  return new Response(sliced, {
    status: 206,
    statusText: "Partial Content",
    headers,
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, User-Agent",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type"
  };
}

async function serveManifestProxy(request, targetUrl, referer) {
  const reqUrl = new URL(request.url);
  const hostOrigin = reqUrl.origin;

  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
  };
  if (referer) headers["Referer"] = referer;

  const upstream = await fetch(targetUrl, { headers });
  if (!upstream.ok) {
    return new Response(`Upstream Error: HTTP ${upstream.status}`, { status: upstream.status });
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const contentLength = parseInt(upstream.headers.get("content-length") || "0", 10);

  if (contentType.startsWith("video/") || contentLength > 5 * 1024 * 1024) {
    const chunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(targetUrl)}&ref=${encodeURIComponent(referer)}`;
    const m3u8 = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7200\n#EXT-X-MEDIA-SEQUENCE:1\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:7200.000,Direct Stream\n${chunkUrl}\n#EXT-X-ENDLIST\n`;
    return new Response(m3u8, {
      headers: {
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
      }
    });
  }

  const manifestText = await upstream.text();
  const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
  let parentQuery = "";
  try {
    parentQuery = new URL(targetUrl).search;
  } catch (_) {}

  const lines = manifestText.split("\n");
  const rewritten = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("#")) {
      if (trimmed.includes('URI="')) {
        const rewrittenTag = trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
          const absoluteUri = resolveUrl(uri, baseUrl, parentQuery);
          const proxyChunkUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
          return `URI="${proxyChunkUrl}"`;
        });
        rewritten.push(rewrittenTag);
      } else {
        rewritten.push(line);
      }
    } else {
      const absoluteUri = resolveUrl(trimmed, baseUrl, parentQuery);
      let proxyUrl = "";
      if (absoluteUri.includes(".m3u8")) {
        proxyUrl = `${hostOrigin}/api/live/sub.m3u8?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
      } else {
        proxyUrl = `${hostOrigin}/api/live/chunk?url=${encodeURIComponent(absoluteUri)}&ref=${encodeURIComponent(referer)}`;
      }
      rewritten.push(proxyUrl);
    }
  }

  return new Response(rewritten.join("\n"), {
    headers: {
      "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    }
  });
}

async function serveChunkRelay(request, chunkUrl, referer) {
  const rangeHeader = request.headers.get("range");

  const upstreamHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "*/*",
  };

  if (referer) upstreamHeaders["Referer"] = referer;
  if (rangeHeader) upstreamHeaders["Range"] = rangeHeader;

  const upstream = await fetch(chunkUrl, { headers: upstreamHeaders });
  const totalLength = parseInt(upstream.headers.get("content-length") || "0", 10);
  const contentType = upstream.headers.get("content-type") || "video/mp2t";

  if (upstream.status === 206) {
    const responseHeaders = new Headers(upstream.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type");
    responseHeaders.set("Accept-Ranges", "bytes");
    return new Response(upstream.body, { status: 206, headers: responseHeaders });
  }

  if (rangeHeader && totalLength > 0) {
    const parts = rangeHeader.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10) || 0;
    const hasExplicitEnd = parts[1] && parts[1].trim() !== "";
    const end = hasExplicitEnd ? parseInt(parts[1], 10) : totalLength - 1;

    if (start > 0 || hasExplicitEnd) {
      let bytesRead = 0;
      const { readable, writable } = new TransformStream({
        transform(chunk, controller) {
          const chunkStart = bytesRead;
          const chunkEnd = bytesRead + chunk.length - 1;
          bytesRead += chunk.length;

          if (chunkEnd < start) return;
          if (hasExplicitEnd && chunkStart > end) {
            controller.terminate();
            return;
          }

          const sliceFrom = Math.max(0, start - chunkStart);
          const sliceTo = hasExplicitEnd ? Math.min(chunk.length, end - chunkStart + 1) : chunk.length;
          controller.enqueue(chunk.slice(sliceFrom, sliceTo));

          if (hasExplicitEnd && bytesRead > end) {
            controller.terminate();
          }
        }
      });

      upstream.body.pipeTo(writable).catch(() => {});

      return new Response(readable, {
        status: 206,
        headers: {
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${totalLength}`,
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type",
          "Cache-Control": "public, max-age=120",
        }
      });
    }
  }

  const responseHeaders = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    const k = key.toLowerCase();
    if (!["content-encoding", "transfer-encoding", "access-control-allow-origin"].includes(k)) {
      responseHeaders.set(key, value);
    }
  }
  responseHeaders.set("Access-Control-Allow-Origin", "*");
  responseHeaders.set("Access-Control-Allow-Headers", "*");
  responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type");
  responseHeaders.set("Accept-Ranges", "bytes");

  return new Response(upstream.body, {
    status: 200,
    headers: responseHeaders
  });
}

function isDirectVideo(url = "") {
  const lower = url.toLowerCase();
  return (
    lower.includes(".mp4") ||
    lower.includes(".mkv") ||
    lower.includes(".webm") ||
    lower.includes("video-downloads.googleusercontent.com") ||
    lower.includes("pixeldrain.com/api/file") ||
    lower.includes("dl1.highxhd.com") ||
    (!lower.includes(".m3u8") && !lower.includes(".mpd"))
  );
}

function resolveUrl(relativeUrl, baseUrl, parentQuery = "") {
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

function verifyAdminAuth(request) {
  const pin = request.headers.get("x-admin-pin") || request.headers.get("x-app-key");
  if (pin !== ADMIN_PIN && pin !== APP_SECRET_KEY) {
    return jsonResponse({ error: "Unauthorized: Admin PIN Required" }, 401);
  }
  return null;
}

function handleCors() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS, HEAD",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    }
  });
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
    }
  });
}
