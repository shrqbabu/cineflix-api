const { TelegramClient, Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const bigInt = require("big-integer");

/**
 * Ultra-Fast Telegram Video & HLS Chunk Streaming Engine
 *
 * Features:
 * - Multi-tier in-memory LRU segment caching (serves hot chunks in < 1ms)
 * - Parallel Multi-Part MTProto Chunk Downloader (100-200ms full 2MB chunk download)
 * - In-flight request deduplication (prevents redundant MTProto downloads)
 * - Single-step seek fast-recovery (instant seeking without queue starvation)
 * - Channel and message metadata caching (0ms entity lookups)
 * - Edge CDN cache headers (Cloudflare immutable caching)
 * - Full HTTP 206 Partial Content (Range) & HTTP 200 support
 */
class TelegramStreamEngine {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.initPromise = null;
    this.isListenerRegistered = false;

    // Cache stores
    this.channelCache = new Map();
    this.metaCache = new Map();
    this.segmentBufferCache = new Map(); // msgId -> { buffer, mimeType, fileSize, timestamp }
    this.inFlightRequests = new Map();   // msgId -> Promise<{ buffer, mimeType, fileSize }>

    // Max 300MB LRU memory cache for fast segment playback & seeking
    this.maxCacheBytes = 300 * 1024 * 1024;
    this.currentCacheBytes = 0;

    // Concurrency control for background prefetching
    this.activePrefetches = 0;
    this.maxConcurrentPrefetches = 2;
  }

  // ============================================================
  // TIMEOUT HELPER
  // ============================================================
  async withTimeout(promise, ms, name = "Operation") {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${name} timeout after ${ms}ms`));
      }, ms);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }
  }

  // ============================================================
  // INIT TELEGRAM CLIENT
  // ============================================================
  async init() {
    if (this.isReady && this.client) {
      return this.client;
    }

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = (async () => {
      const apiId = parseInt(process.env.TG_API_ID || "0", 10);
      const apiHash = (process.env.TG_API_HASH || "").trim();
      const botToken = (process.env.TG_BOT_TOKEN || "").trim();
      const sessionString = (process.env.TG_SESSION || "").trim();

      if (!apiId || !apiHash || !botToken) {
        console.error("❌ [TelegramStream] Missing TG_API_ID / TG_API_HASH / TG_BOT_TOKEN");
        throw new Error("Telegram credentials not configured in .env");
      }

      console.log("🔌 [TelegramStream] Connecting to Telegram Datacenter...");

      const stringSession = new StringSession(sessionString);
      this.client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        useWSS: false,
        timeout: 15000,
        autoReconnect: true,
      });

      await this.withTimeout(
        this.client.start({
          botAuthToken: botToken,
        }),
        35000,
        "Telegram client login"
      );

      // Warm entity cache by loading recent dialogs
      try {
        await this.client.getDialogs({ limit: 50 });
      } catch (_) {}

      this.isReady = true;
      console.log("🚀 [TelegramStream] Connected to Telegram successfully! Fast streaming ready.");

      this.setupBotListener();
      return this.client;
    })();

    try {
      return await this.initPromise;
    } catch (err) {
      this.isReady = false;
      this.client = null;
      this.initPromise = null;
      console.error("❌ [TelegramStream] Init failed:", err.message);
      throw err;
    }
  }

  // ============================================================
  // BOT LISTENER (AUTO-REPLIES WITH PLAYABLE URLS)
  // ============================================================
  setupBotListener() {
    if (this.isListenerRegistered || !this.client) {
      return;
    }

    this.isListenerRegistered = true;

    this.client.addEventHandler(
      async (event) => {
        try {
          const message = event.message;
          if (!message) return;

          const text = (message.text || message.message || "").trim();

          let hostUrl = (
            process.env.EXOPLAYER_URL ||
            process.env.MINIAPP_URL ||
            process.env.WEBAPP_URL ||
            process.env.BASE_HOST_URL ||
            process.env.HOST_URL ||
            "https://cineflix-ott.duckdns.org"
          ).trim().replace(/^[=\s"']+/, "").replace(/[/"'\s]+$/, "");

          if (!hostUrl.startsWith("http://") && !hostUrl.startsWith("https://")) {
            hostUrl = `https://${hostUrl}`;
          }

          const media = message.media?.document || message.media?.video;

          if (media) {
            const msgId = message.id;
            const doc = message.media?.document;
            let rawFileName = "Telegram_Video";

            if (Array.isArray(doc?.attributes)) {
              const fileAttr = doc.attributes.find((a) => a.fileName);
              if (fileAttr && fileAttr.fileName) {
                rawFileName = fileAttr.fileName;
              }
            } else if (typeof message.message === "string" && message.message.trim()) {
              rawFileName = message.message.trim().split("\n")[0];
            }

            const cleanTitle = String(rawFileName)
              .replace(/[^a-zA-Z0-9.\-_]/g, "_")
              .replace(/_+/g, "_")
              .trim();

            const encodedTitle = encodeURIComponent(cleanTitle);
            const directUrl = `${hostUrl}/api/tg/stream?msg=${msgId}`;
            const hlsUrl = `${hostUrl}/api/movie/proxy.m3u8?url=` + encodeURIComponent(directUrl);
            const playerUrl = `${hostUrl}/player?url=${encodeURIComponent(directUrl)}&title=${encodedTitle}&type=mp4`;

            const replyText =
              `🎬 **CineFlix Video Stream Ready!** 🍿\n\n` +
              `📁 **File:** \`${cleanTitle}\`\n\n` +
              `▶️ **Watch in Player:**\n${playerUrl}\n\n` +
              `⚡ **Direct Stream (Fast-Forward Supported):**\n\`${directUrl}\`\n\n` +
              `📡 **HLS M3U8 Playlist:**\n\`${hlsUrl}\`\n\n` +
              `📋 **Message ID:** \`${msgId}\``;

            await message.reply({ message: replyText });
            return;
          }

          if (text.startsWith("http://") || text.startsWith("https://")) {
            const cleanTextUrl = text.trim();
            const hlsUrl = `${hostUrl}/api/movie/proxy.m3u8?url=` + encodeURIComponent(cleanTextUrl);
            const streamUrl = `${hostUrl}/api/movie/stream?url=` + encodeURIComponent(cleanTextUrl);
            const playerUrl = `${hostUrl}/player?url=${encodeURIComponent(cleanTextUrl)}&title=Direct_Stream&type=m3u8`;

            const replyText =
              `🎬 **Stream Link Generated!** 🍿\n\n` +
              `▶️ **Watch in Player:**\n${playerUrl}\n\n` +
              `📡 **HLS M3U8 Playlist:**\n\`${hlsUrl}\`\n\n` +
              `⚡ **Direct Stream:**\n\`${streamUrl}\``;

            await message.reply({ message: replyText });
            return;
          }

          if (text === "/start" || text === "/help") {
            await message.reply({
              message:
                `👋 **Welcome to CineFlix Stream Generator Bot!**\n\n` +
                `Send me any **Video File (.mp4 / .mkv)** or any **Direct Video Link**.\n\n` +
                `I will generate a ready-to-play **M3U8 HLS & Direct Stream URL**.`
            });
          }
        } catch (err) {
          console.error("⚠️ [Telegram Bot Event Error]:", err.message);
        }
      },
      new NewMessage({})
    );

    console.log("🤖 [TelegramStream] Bot listener active!");
  }

  // ============================================================
  // CHANNEL PARSER & RESOLVER
  // ============================================================
  parseChannel(channelInput) {
    let raw = (channelInput || process.env.TG_CHANNEL_USERNAME || process.env.TG_CHANNEL_ID || "").trim();
    if (!raw) return "";
    if (raw.startsWith("@")) return raw;
    if (raw.startsWith("#")) raw = raw.slice(1).trim();

    if (/^-?\d+$/.test(raw)) {
      if (raw.startsWith("-100")) return raw;
      if (raw.startsWith("-")) return `-100${raw.slice(1)}`;
      return `-100${raw}`;
    }
    return raw;
  }

  async resolveChannel(client, channelInput) {
    const channel = this.parseChannel(channelInput);
    if (!channel) {
      throw new Error("Telegram channel not specified and TG_CHANNEL_ID not set");
    }

    if (this.channelCache.has(channel)) {
      return this.channelCache.get(channel);
    }

    // 1. Try standard getInputEntity
    try {
      const entity = await this.withTimeout(
        client.getInputEntity(channel),
        8000,
        "Telegram channel resolution"
      );
      if (entity) {
        this.channelCache.set(channel, entity);
        return entity;
      }
    } catch (err) {
      console.warn(`⚠️ [TelegramStream] getInputEntity fallback for ${channel}:`, err.message);
    }

    // 2. Try username lookup if TG_CHANNEL_USERNAME is set
    const fallbackUsername = (process.env.TG_CHANNEL_USERNAME || "").trim();
    if (fallbackUsername && fallbackUsername !== channel) {
      try {
        const uEntity = await client.getInputEntity(fallbackUsername.startsWith("@") ? fallbackUsername : `@${fallbackUsername}`);
        if (uEntity) {
          this.channelCache.set(channel, uEntity);
          return uEntity;
        }
      } catch (_) {}
    }

    // 3. Try bigInt resolution if numeric channel id
    if (typeof channel === "string" && /^-?\d+$/.test(channel)) {
      const cleanNum = channel.replace(/^-100/, "").replace(/^-/, "");
      try {
        const entity = await client.getInputEntity(bigInt(cleanNum));
        if (entity) {
          this.channelCache.set(channel, entity);
          return entity;
        }
      } catch (_) {}

      try {
        const entity = await client.getInputEntity(bigInt(channel));
        if (entity) {
          this.channelCache.set(channel, entity);
          return entity;
        }
      } catch (_) {}

      try {
        const entity = await client.getEntity(bigInt(cleanNum));
        if (entity) {
          this.channelCache.set(channel, entity);
          return entity;
        }
      } catch (_) {}
    }

    // 4. Try getEntity
    try {
      const entity = await this.withTimeout(
        client.getEntity(channel),
        8000,
        "Telegram getEntity"
      );
      if (entity) {
        this.channelCache.set(channel, entity);
        return entity;
      }
    } catch (err) {
      console.warn(`⚠️ [TelegramStream] getEntity fallback for ${channel}:`, err.message);
    }

    // 5. Search in getDialogs
    try {
      const dialogs = await client.getDialogs({ limit: 100 });
      const cleanNum = String(channel).replace(/^-100/, "").replace(/^-/, "");
      for (const d of dialogs) {
        const dId = String(d.id || "").replace(/^-100/, "").replace(/^-/, "");
        if (dId === cleanNum || String(d.id) === String(channel)) {
          const entity = d.inputEntity || d.entity;
          if (entity) {
            this.channelCache.set(channel, entity);
            return entity;
          }
        }
      }
    } catch (_) {}

    // 6. MTProto Direct InputPeerChannel / InputChannel fallback
    if (typeof channel === "string" && /^-?\d+$/.test(channel)) {
      const cleanNum = channel.replace(/^-100/, "").replace(/^-/, "");
      const accessHash = process.env.TG_CHANNEL_ACCESS_HASH || "0";
      const directInputPeer = new Api.InputPeerChannel({
        channelId: bigInt(cleanNum),
        accessHash: bigInt(accessHash),
      });
      this.channelCache.set(channel, directInputPeer);
      console.log(`🔌 [TelegramStream] Using direct InputPeerChannel for #${cleanNum}`);
      return directInputPeer;
    }

    throw new Error(`Unable to resolve Telegram channel: ${channel}`);
  }

  // ============================================================
  // MESSAGE METADATA & BATCH PREFETCHER
  // ============================================================
  async getMessageMeta(client, channel, msgId) {
    const cacheKey = `${channel.id || channel}_${msgId}`;
    if (this.metaCache.has(cacheKey)) {
      return this.metaCache.get(cacheKey);
    }

    // Lookup current message + next 3 messages in ONE batch MTProto query
    const targetIds = [msgId, msgId + 1, msgId + 2, msgId + 3];
    try {
      const messages = await this.withTimeout(
        client.getMessages(channel, { ids: targetIds }),
        12000,
        `Telegram batch message lookup #${msgId}`
      );

      for (const m of (messages || [])) {
        if (!m || !m.id) continue;
        const media = m.media?.document || m.media?.photo || m.media;
        const doc = m.media?.document || (media?.className === "Document" ? media : null);
        const fileSize = Number(doc?.size || media?.size || 0);

        let mimeType = doc?.mimeType || media?.mimeType || "video/mp2t";
        if (
          !mimeType ||
          mimeType === "application/octet-stream" ||
          mimeType.includes("linguist") ||
          mimeType.includes("text/vnd") ||
          mimeType.includes("text/plain")
        ) {
          mimeType = "video/mp2t";
        }

        let fileLocation;
        let targetDcId = 5;

        if (doc) {
          fileLocation = new Api.InputDocumentFileLocation({
            id: doc.id,
            accessHash: doc.accessHash,
            fileReference: doc.fileReference,
            thumbSize: "",
          });
          targetDcId = doc.dcId || 5;
        } else if (m.media?.photo) {
          const photo = m.media.photo;
          fileLocation = new Api.InputPhotoFileLocation({
            id: photo.id,
            accessHash: photo.accessHash,
            fileReference: photo.fileReference,
            thumbSize: "",
          });
          targetDcId = photo.dcId || 5;
        } else {
          fileLocation = media;
          targetDcId = media?.dcId || 5;
        }

        const meta = {
          msg: m,
          media,
          document: doc,
          fileSize,
          mimeType,
          targetDcId,
          fileLocation,
        };

        this.metaCache.set(`${channel.id || channel}_${m.id}`, meta);
      }
    } catch (err) {
      console.warn(`⚠️ [TelegramStream] Batch lookup note for #${msgId}:`, err.message);
    }

    return this.metaCache.get(cacheKey) || null;
  }

  // ============================================================
  // LRU SEGMENT BUFFER CACHE MANAGEMENT
  // ============================================================
  setCachedSegment(msgId, buffer, mimeType) {
    const size = buffer.length;
    if (size > 50 * 1024 * 1024) return; // Do not store giant multi-GB movies in RAM chunk cache

    // Evict oldest segments if cache is full
    while (this.currentCacheBytes + size > this.maxCacheBytes && this.segmentBufferCache.size > 0) {
      const firstKey = this.segmentBufferCache.keys().next().value;
      const oldItem = this.segmentBufferCache.get(firstKey);
      if (oldItem) {
        this.currentCacheBytes -= oldItem.buffer.length;
      }
      this.segmentBufferCache.delete(firstKey);
    }

    this.segmentBufferCache.set(String(msgId), {
      buffer,
      mimeType,
      fileSize: size,
      timestamp: Date.now(),
    });
    this.currentCacheBytes += size;
  }

  // ============================================================
  // PARALLEL MULTI-PART MTPROTO CHUNK DOWNLOADER (100-200ms)
  // ============================================================
  async downloadDirectChunks(client, meta) {
    const fileLocation = meta.fileLocation || meta.document || meta.media;
    const targetDcId = meta.targetDcId || 5;
    const fileSize = meta.fileSize || 0;

    const sender = await client.getSender(targetDcId);
    const CHUNK_SIZE = 512 * 1024;
    const numChunks = Math.max(1, Math.ceil(fileSize / CHUNK_SIZE));

    // Concurrently download 512KB parts over MTProto socket
    const partBuffers = new Array(numChunks);
    const partIndices = Array.from({ length: numChunks }, (_, i) => i);

    await Promise.all(
      partIndices.map(async (i) => {
        const offset = bigInt(i * CHUNK_SIZE);
        const res = await sender.send(
          new Api.upload.GetFile({
            location: fileLocation,
            offset: offset,
            limit: CHUNK_SIZE,
          })
        );
        partBuffers[i] = res && res.bytes ? res.bytes : Buffer.alloc(0);
      })
    );

    return Buffer.concat(partBuffers);
  }

  // ============================================================
  // FAST CHUNK FETCHER WITH DEDUPLICATION & PREFETCH
  // ============================================================
  async fetchSegmentBuffer(client, channel, msgId, meta) {
    const cacheKey = String(msgId);
    const cached = this.segmentBufferCache.get(cacheKey);
    if (cached) {
      // Move to end of Map for LRU freshness
      this.segmentBufferCache.delete(cacheKey);
      this.segmentBufferCache.set(cacheKey, cached);
      return { ...cached, fromCache: true };
    }

    // Deduplicate in-flight requests for the same segment
    if (this.inFlightRequests.has(cacheKey)) {
      return await this.inFlightRequests.get(cacheKey);
    }

    const fetchPromise = (async () => {
      try {
        let buf;
        // For segments <= 15MB (typical HLS chunks are 1-3MB), use multi-part parallel downloader
        if (meta.fileSize && meta.fileSize <= 15 * 1024 * 1024) {
          try {
            buf = await this.withTimeout(
              this.downloadDirectChunks(client, meta),
              15000,
              `Parallel chunk download #${msgId}`
            );
          } catch (parallelErr) {
            console.warn(`⚠️ [TelegramStream] Parallel chunk fallback for #${msgId}:`, parallelErr.message);
            // Fallback to iterDownload
            const chunks = [];
            const iter = client.iterDownload({
              file: meta.fileLocation || meta.document || meta.media,
              dcId: meta.targetDcId,
              chunkSize: 512 * 1024,
              requestSize: 512 * 1024,
            });
            for await (const chunk of iter) {
              chunks.push(chunk);
            }
            buf = Buffer.concat(chunks);
          }
        } else {
          // Large single files
          const chunks = [];
          const iter = client.iterDownload({
            file: meta.fileLocation || meta.document || meta.media,
            dcId: meta.targetDcId,
            chunkSize: 512 * 1024,
            requestSize: 512 * 1024,
          });
          for await (const chunk of iter) {
            chunks.push(chunk);
          }
          buf = Buffer.concat(chunks);
        }

        if (buf && Buffer.isBuffer(buf) && buf.length > 0) {
          this.setCachedSegment(msgId, buf, meta.mimeType);

          // Background prefetch ONLY next segment
          this.triggerBackgroundPrefetch(client, channel, msgId + 1);

          return {
            buffer: buf,
            mimeType: meta.mimeType,
            fileSize: buf.length,
            timestamp: Date.now(),
            fromCache: false,
          };
        }
        throw new Error("Empty buffer received from Telegram");
      } finally {
        this.inFlightRequests.delete(cacheKey);
      }
    })();

    this.inFlightRequests.set(cacheKey, fetchPromise);
    return await fetchPromise;
  }

  // ============================================================
  // BACKGROUND PREFETCHER (THROTTLED TO AVOID SEEK STARVATION)
  // ============================================================
  triggerBackgroundPrefetch(client, channel, nextMsgId) {
    const nextKey = String(nextMsgId);
    if (this.segmentBufferCache.has(nextKey) || this.inFlightRequests.has(nextKey)) {
      return;
    }

    if (this.activePrefetches >= this.maxConcurrentPrefetches) {
      return;
    }

    this.activePrefetches++;

    setImmediate(async () => {
      try {
        const meta = await this.getMessageMeta(client, channel, nextMsgId);
        if (meta && meta.fileSize && meta.fileSize <= 15 * 1024 * 1024) {
          await this.fetchSegmentBuffer(client, channel, nextMsgId, meta);
        }
      } catch (err) {
        // Silently skip prefetch errors
      } finally {
        this.activePrefetches = Math.max(0, this.activePrefetches - 1);
      }
    });
  }

  // ============================================================
  // RANGE PARSER
  // ============================================================
  parseRange(rangeHeader, fileSize) {
    if (!rangeHeader || !fileSize || fileSize <= 0) {
      return {
        start: 0,
        end: fileSize > 0 ? fileSize - 1 : 0,
        statusCode: 200,
      };
    }

    const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
    if (!match) {
      return { error: "Invalid Range header" };
    }

    const startText = match[1];
    const endText = match[2];
    let start;
    let end;

    if (!startText && endText) {
      const suffixLength = Number(endText);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
        return { error: "Invalid suffix range" };
      }
      start = Math.max(0, fileSize - suffixLength);
      end = fileSize - 1;
    } else if (startText && !endText) {
      start = Number(startText);
      end = fileSize - 1;
    } else if (startText && endText) {
      start = Number(startText);
      end = Number(endText);
    } else {
      return { error: "Invalid Range header" };
    }

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      return { error: "Range exceeds safe integer limit" };
    }

    if (start < 0 || end < 0 || start >= fileSize || start > end) {
      return { error: "Requested Range Not Satisfiable" };
    }

    end = Math.min(end, fileSize - 1);
    return {
      start,
      end,
      statusCode: 206,
    };
  }

  // ============================================================
  // MAIN STREAM MEDIA HANDLER
  // ============================================================
  async streamMedia(req, res, messageId, channelInput = "") {
    const msgId = Number.parseInt(messageId, 10);
    if (!Number.isSafeInteger(msgId) || msgId <= 0) {
      return res.status(400).send("Invalid Telegram message ID");
    }

    const rangeHeader = req.headers.range || "";
    const cacheKey = String(msgId);

    // --- FAST PATH 1: Instant RAM Segment Cache Hit (< 1ms) ---
    const fastCached = this.segmentBufferCache.get(cacheKey);
    if (fastCached) {
      const fileSize = fastCached.fileSize;
      const rangeResult = this.parseRange(rangeHeader, fileSize);
      if (rangeResult.error) {
        res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.status(416).send(rangeResult.error);
      }

      const { start, end, statusCode } = rangeResult;
      const contentLength = end - start + 1;
      const sliceBuf = (start === 0 && end === fileSize - 1)
        ? fastCached.buffer
        : fastCached.buffer.slice(start, end + 1);

      res.writeHead(statusCode, {
        "Content-Type": fastCached.mimeType || "video/mp2t",
        "Content-Length": String(contentLength),
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, User-Agent",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag, X-Cache",
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
        "CDN-Cache-Control": "max-age=31536000, immutable",
        "Cloudflare-CDN-Cache-Control": "max-age=31536000, immutable",
        "ETag": `"tg-${msgId}-${fileSize}"`,
        "X-Stream-Source": "telegram-channel",
        "X-Telegram-Message-Id": String(msgId),
        "X-Cache": "RAM-HIT",
        ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${fileSize}` } : {}),
      });

      if (req.method === "HEAD") return res.end();
      res.end(sliceBuf);
      return;
    }

    // --- NORMAL PATH: Lookup metadata & fetch from Telegram MTProto ---
    try {
      const client = await this.withTimeout(this.init(), 20000, "Telegram initialization");
      const channel = await this.resolveChannel(client, channelInput);
      const meta = await this.getMessageMeta(client, channel, msgId);

      if (!meta || !meta.msg || (!meta.document && !meta.media)) {
        return res.status(404).send(`Telegram message #${msgId} media not found`);
      }

      const fileSize = meta.fileSize || 0;
      const mimeType = meta.mimeType || "video/mp2t";

      // For standard HLS chunk segments (<= 15MB), buffer and cache in RAM
      if (fileSize > 0 && fileSize <= 15 * 1024 * 1024) {
        const segData = await this.fetchSegmentBuffer(client, channel, msgId, meta);
        const rangeResult = this.parseRange(rangeHeader, segData.fileSize);
        if (rangeResult.error) {
          res.setHeader("Content-Range", `bytes */${segData.fileSize}`);
          return res.status(416).send(rangeResult.error);
        }

        const { start, end, statusCode } = rangeResult;
        const contentLength = end - start + 1;
        const sliceBuf = (start === 0 && end === segData.fileSize - 1)
          ? segData.buffer
          : segData.buffer.slice(start, end + 1);

        res.writeHead(statusCode, {
          "Content-Type": segData.mimeType || mimeType,
          "Content-Length": String(contentLength),
          "Accept-Ranges": "bytes",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, User-Agent",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag, X-Cache",
          "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
          "CDN-Cache-Control": "max-age=31536000, immutable",
          "Cloudflare-CDN-Cache-Control": "max-age=31536000, immutable",
          "ETag": `"tg-${msgId}-${segData.fileSize}"`,
          "X-Stream-Source": "telegram-channel",
          "X-Telegram-Message-Id": String(msgId),
          "X-Cache": segData.fromCache ? "RAM-HIT" : "MTPROTO-FETCH",
          ...(statusCode === 206 ? { "Content-Range": `bytes ${start}-${end}/${segData.fileSize}` } : {}),
        });

        if (req.method === "HEAD") return res.end();
        res.end(sliceBuf);
        return;
      }

      // --- STREAMING PATH (For large single video files > 15MB) ---
      const rangeResult = this.parseRange(rangeHeader, fileSize);
      if (rangeResult.error) {
        if (fileSize > 0) res.setHeader("Content-Range", `bytes */${fileSize}`);
        return res.status(416).send(rangeResult.error);
      }

      const { start, end, statusCode } = rangeResult;
      const contentLength = fileSize > 0 ? end - start + 1 : undefined;

      const headers = {
        "Content-Type": mimeType,
        "Accept-Ranges": "bytes",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range, If-Range, Content-Type, Accept, User-Agent",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length, Content-Type, ETag, X-Cache",
        "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
        "CDN-Cache-Control": "max-age=31536000, immutable",
        "Cloudflare-CDN-Cache-Control": "max-age=31536000, immutable",
        "ETag": `"tg-${msgId}-${fileSize}"`,
        "X-Stream-Source": "telegram-channel",
        "X-Telegram-Message-Id": String(msgId),
        "X-Cache": "STREAM-DIRECT",
      };

      if (statusCode === 206 && fileSize > 0) {
        headers["Content-Range"] = `bytes ${start}-${end}/${fileSize}`;
        headers["Content-Length"] = String(contentLength);
      } else if (fileSize > 0) {
        headers["Content-Length"] = String(fileSize);
      }

      if (req.method === "HEAD") {
        res.writeHead(statusCode, headers);
        return res.end();
      }

      let aborted = false;
      req.once("aborted", () => { aborted = true; });
      req.once("close", () => {
        if (!res.writableEnded) aborted = true;
      });

      const chunkSize = 512 * 1024;
      const iter = client.iterDownload({
        file: meta.fileLocation || meta.document || meta.media,
        offset: bigInt(start),
        chunkSize: chunkSize,
        requestSize: chunkSize,
        dcId: meta.targetDcId,
      });

      const iterator = iter[Symbol.asyncIterator]();
      let firstResult;
      try {
        firstResult = await this.withTimeout(iterator.next(), 20000, "First chunk download");
      } catch (firstErr) {
        if (!res.headersSent) {
          return res.status(500).json({ error: "Failed to download chunk from Telegram", message: firstErr.message });
        }
        throw firstErr;
      }

      if (!firstResult || firstResult.done || !firstResult.value) {
        if (!res.headersSent) return res.status(404).send("Empty media stream from Telegram");
        return res.end();
      }

      res.writeHead(statusCode, headers);
      let firstChunk = firstResult.value;
      if (contentLength !== undefined && firstChunk.length > contentLength) {
        firstChunk = firstChunk.slice(0, contentLength);
      }

      let totalSent = firstChunk.length;
      const canContinueFirst = res.write(firstChunk);
      if (!canContinueFirst) {
        await new Promise((resolve) => res.once("drain", resolve));
      }

      if (contentLength !== undefined && totalSent >= contentLength) {
        if (!res.writableEnded && !res.destroyed) res.end();
        return;
      }

      for await (let chunk of iter) {
        if (aborted || res.destroyed || res.writableEnded) break;
        if (!chunk || chunk.length === 0) continue;

        if (contentLength !== undefined) {
          const remaining = contentLength - totalSent;
          if (remaining <= 0) break;
          if (chunk.length > remaining) {
            chunk = chunk.slice(0, remaining);
          }
        }

        totalSent += chunk.length;
        const canContinue = res.write(chunk);
        if (!canContinue) {
          await new Promise((resolve) => res.once("drain", resolve));
        }

        if (contentLength !== undefined && totalSent >= contentLength) break;
      }

      if (!res.writableEnded && !res.destroyed) res.end();
    } catch (err) {
      console.error(`❌ [TelegramStream] Error for #${msgId}:`, err.message);
      if (!res.headersSent) {
        return res.status(err.message?.includes("timeout") ? 504 : 500).send(`Telegram stream error: ${err.message}`);
      }
      if (!res.writableEnded && !res.destroyed) {
        try { res.end(); } catch {}
      }
    }
  }
}

module.exports = new TelegramStreamEngine();
