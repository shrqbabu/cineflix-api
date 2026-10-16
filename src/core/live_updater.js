const fs = require("fs");
const path = require("path");
const { LiveStreamProxy } = require("./live_stream");

const DEFAULT_CHANNELS = [
  {
    id: "star1",
    title: "Star Sports 1 HD",
    stream_url: "http://51.75.127.199:3141/starsports2/index.m3u8",
    referer: "https://sportslive.wine/",
    poster_url: "https://crichd.mobile/assets/channels/star1.webp",
    category: "Star Sports",
    language: "English",
    quality: "1080p HD",
    is_active: true,
    sort_order: 6
  },
  {
    id: "starhindi",
    title: "Star Sports 1 Hindi HD",
    stream_url: "http://51.75.127.199:3141/starsportskhel/index.m3u8",
    referer: "https://sportslive.wine/",
    poster_url: "https://crichd.mobile/assets/channels/starhindi.webp",
    category: "Star Sports",
    language: "Hindi",
    quality: "1080p HD",
    is_active: true,
    sort_order: 7
  },
  {
    id: "ddsports",
    title: "DD Sports 1.0 HD (Cricket)",
    stream_url: "https://mumbai-edge.smartplaytv.in/DDSportsHD/index.m3u8",
    referer: "https://sportslive.wine/",
    poster_url: "https://mumbai-edge.smartplaytv.in/DDSportsHD/logo.png",
    category: "DD Sports",
    language: "Hindi",
    quality: "1080p HD",
    is_active: true,
    sort_order: 8
  }
];

class LiveChannelUpdater {
  /**
   * Syncs the given channel list or default channels to Supabase `public.live_channels`
   */
  static async syncToSupabase(customChannels = null) {
    const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

    const channelsToSync = customChannels || DEFAULT_CHANNELS;

    // First update local memory / channels.json
    for (const ch of channelsToSync) {
      LiveStreamProxy.updateChannel(
        ch.id,
        ch.cdn_url || ch.upstreamUrl,
        ch.referer || "https://playsza.xyz/",
        ch.title
      );
    }

    if (!supabaseUrl || !supabaseKey || supabaseUrl.includes("placeholder")) {
      console.warn("⚠️ [LiveUpdater] Supabase credentials not configured in environment. Updated local channels.json only.");
      return { success: true, count: channelsToSync.length, target: "local_only" };
    }

    try {
      const endpoint = `${supabaseUrl}/rest/v1/live_channels`;
      const payload = channelsToSync.map(ch => ({
        id: ch.id,
        title: ch.title,
        cdn_url: ch.stream_url || ch.upstreamUrl,
        stream_url: ch.stream_url || ch.upstreamUrl,
        tele_cdn: ch.tele_cdn || ch.teleCdn || "",
        referer: ch.referer || "https://playsza.xyz/",
        poster_url: ch.poster_url || ch.posterUrl || "",
        category: ch.category || "Live Sports",
        language: ch.language || "Hindi",
        quality: ch.quality || "1080p HD",
        is_active: ch.is_active !== false,
        sort_order: ch.sort_order || 0
      }));

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates"
        },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`❌ [LiveUpdater] Supabase sync failed (HTTP ${res.status}):`, errText);
        return { success: false, error: `Supabase HTTP ${res.status}: ${errText}` };
      }

      console.log(`✅ [LiveUpdater] Successfully synced ${payload.length} channels to Supabase live_channels.`);
      return { success: true, count: payload.length, target: "supabase" };
    } catch (err) {
      console.error("❌ [LiveUpdater] Sync error:", err.message);
      return { success: false, error: err.message };
    }
  }

  /**
   * Updates a single channel in Supabase and local cache
   */
  static async updateChannel(id, streamUrl, referer = "https://playsza.xyz/", title = "", quality = "1080p HD") {
    const cleanId = id.toLowerCase().trim();
    LiveStreamProxy.updateChannel(cleanId, streamUrl, referer, title);

    const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
    const supabaseKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "").trim();

    if (!supabaseUrl || !supabaseKey || supabaseUrl.includes("placeholder")) {
      return { success: true, channelId: cleanId, target: "local" };
    }

    try {
      const endpoint = `${supabaseUrl}/rest/v1/live_channels?id=eq.${encodeURIComponent(cleanId)}`;
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({
          stream_url: streamUrl,
          cdn_url: streamUrl,
          referer: referer,
          title: title || undefined,
          quality: quality,
          is_active: true
        })
      });

      if (res.ok) {
        console.log(`✅ [LiveUpdater] Channel '${cleanId}' updated in Supabase.`);
        return { success: true, channelId: cleanId, target: "supabase" };
      }
    } catch (err) {
      console.warn(`⚠️ [LiveUpdater] Could not update Supabase:`, err.message);
    }

    return { success: true, channelId: cleanId, target: "local" };
  }

  /**
   * Checks the expiration and status of all configured channels
   */
  static async checkChannelsStatus() {
    const channels = LiveStreamProxy.getChannels();
    const results = [];
    const now = Date.now();

    for (const [id, ch] of Object.entries(channels)) {
      const url = ch.upstreamUrl || "";
      let expiresAt = null;
      let minutesRemaining = null;

      const expMatch = url.match(/expires=(\d+)/i);
      if (expMatch) {
        const expUnix = parseInt(expMatch[1], 10);
        expiresAt = new Date(expUnix * 1000).toISOString();
        minutesRemaining = Math.max(0, Math.round((expUnix * 1000 - now) / 60000));
      }

      results.push({
        id,
        title: ch.title || id.toUpperCase(),
        url: url.substring(0, 80) + (url.length > 80 ? "..." : ""),
        referer: ch.referer,
        expiresAt,
        minutesRemaining,
        isExpiringSoon: minutesRemaining !== null && minutesRemaining < 20
      });
    }

    return results;
  }
}

module.exports = {
  LiveChannelUpdater,
  DEFAULT_CHANNELS
};
