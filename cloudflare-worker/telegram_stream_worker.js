/**
 * Cloudflare Worker: Ultra-Fast Telegram Video & HLS Chunk Stream Accelerator
 * Target Domain: live.betadda.workers.dev
 *
 * Capabilities:
 * - Edge Cache API (caches.default) stores video chunks on Cloudflare CDN
 * - Serves cached video segments in < 15ms globally (Singapore, Mumbai, Delhi, Frankfurt, etc.)
 * - Automatic background prefetching of next chunks (msg+1, msg+2) into Edge Cache
 * - Full HTTP 206 Partial Content & Range request support
 * - Unrestricted CORS for HLS players, ExoPlayer, and Telegram Mini Apps
 */

// UPSTREAM BACKEND ORIGIN (Hugging Face space or custom VPS)
const ORIGIN_URL = "https://cineflix-ott.duckdns.org";

export default {
  async fetch(request, env, ctx) {
    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, User-Agent",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const msgId = url.searchParams.get("msg") || url.searchParams.get("id");

    // Rewrite request URL to point to backend origin
    const targetUrl = new URL(url.pathname + url.search, ORIGIN_URL);

    // 2. If this is not a Telegram stream chunk request, proxy directly
    if (!url.pathname.includes("/tg/stream") || !msgId) {
      return fetch(targetUrl.toString(), {
        method: request.method,
        headers: request.headers,
      });
    }

    const cache = caches.default;
    // Normalized cache key (ignore Range for base caching)
    const cacheKeyUrl = new URL(url.pathname + "?msg=" + msgId, url.origin);
    const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });

    const rangeHeader = request.headers.get("Range");

    // 3. Check Cloudflare Edge Cache
    let cachedResponse = await cache.match(cacheKey);

    if (cachedResponse) {
      // --- CACHE HIT (< 15ms) ---
      const cloned = new Response(cachedResponse.body, cachedResponse);
      cloned.headers.set("CF-Cache-Status", "HIT");
      cloned.headers.set("X-Edge-Cache", "HIT");
      cloned.headers.set("Access-Control-Allow-Origin", "*");

      // If client sent Range request and cached response is full 200 OK
      if (rangeHeader && cloned.status === 200) {
        return sliceRangeResponse(cloned, rangeHeader);
      }

      return cloned;
    }

    // --- CACHE MISS: Fetch from Backend Origin ---
    const originHeaders = new Headers(request.headers);
    originHeaders.set("User-Agent", "CineFlix-CF-Worker/2.0");
    originHeaders.set("Accept-Encoding", "identity"); // Ensure raw video bytes

    const originRes = await fetch(targetUrl.toString(), {
      method: request.method,
      headers: originHeaders,
    });

    if (!originRes.ok && originRes.status !== 206) {
      return originRes;
    }

    // Build optimized CDN Response
    const responseHeaders = new Headers(originRes.headers);

    // Ensure proper MPEG-2 TS MIME Type for HLS video segments
    const currentCt = responseHeaders.get("Content-Type") || "";
    if (currentCt.includes("linguist") || currentCt.includes("text/vnd") || !currentCt) {
      responseHeaders.set("Content-Type", "video/mp2t");
    }

    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Headers", "Range, If-Range, Content-Type, Accept, User-Agent");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag, X-Cache");
    responseHeaders.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
    responseHeaders.set("CDN-Cache-Control", "max-age=31536000, immutable");
    responseHeaders.set("CF-Cache-Status", "MISS");
    responseHeaders.set("X-Edge-Cache", "MISS");

    const edgeResponse = new Response(originRes.body, {
      status: originRes.status,
      statusText: originRes.statusText,
      headers: responseHeaders,
    });

    // 4. Asynchronously Store in Cloudflare Edge Cache (if full 200 response or single chunk)
    if (originRes.status === 200 && request.method === "GET") {
      ctx.waitUntil(cache.put(cacheKey, edgeResponse.clone()));
    }

    // 5. Predictive Background Pre-fetching of upcoming segments
    const currentNum = parseInt(msgId, 10);
    if (!isNaN(currentNum) && currentNum > 0) {
      ctx.waitUntil(preloadNextSegments(cache, url.origin, currentNum + 1));
    }

    return edgeResponse;
  },
};

/**
 * Background preloader: fetches next HLS segments into Cloudflare Edge Cache
 */
async function preloadNextSegments(cache, workerOrigin, nextMsgId) {
  try {
    for (let i = 0; i < 2; i++) {
      const targetId = nextMsgId + i;
      const prefetchUrl = `${ORIGIN_URL}/api/tg/stream?msg=${targetId}`;
      const cacheKey = new Request(`${workerOrigin}/api/tg/stream?msg=${targetId}`, { method: "GET" });

      const existing = await cache.match(cacheKey);
      if (existing) continue;

      const res = await fetch(prefetchUrl, {
        headers: { "User-Agent": "CineFlix-Preloader/2.0" },
      });

      if (res.ok) {
        const prefetchHeaders = new Headers(res.headers);
        prefetchHeaders.set("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
        prefetchHeaders.set("Access-Control-Allow-Origin", "*");

        const prefetchRes = new Response(res.body, {
          status: 200,
          headers: prefetchHeaders,
        });

        await cache.put(cacheKey, prefetchRes);
      }
    }
  } catch (err) {
    // Ignore prefetch errors in background
  }
}

/**
 * Slices a full 200 response into 206 Partial Content when Range header is provided
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
