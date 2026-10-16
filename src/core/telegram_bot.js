const fs = require("fs");
const path = require("path");
const https = require("https");
const dns = require("dns");
const { MovieBoxClient } = require("./client");
const { MultiProvider } = require("./multi_provider");
const { workerPool } = require("./worker_pool");
const {
  authenticateUser,
  registerUser,
  checkEmailExists,
  checkUserSubscription,
  resolveTelegramUser,
  getActivePrerollAd,
  getSupabaseLiveChannels,
  VIP_PLANS,
} = require("./supabase_auth");

const VIP_BOT_USERNAME = (
  process.env.VIP_BOT_USERNAME ||
  process.env.SUBSCRIPTION_BOT_USERNAME ||
  "CineFlixVIPBot"
).replace(/^@/, "").trim();

const telegramHttpsAgent = new https.Agent({
  keepAlive: true,
  lookup: (hostname, options, callback) => {
    dns.lookup(hostname, { family: 4, all: false }, callback);
  },
});

class MovieBoxTelegramBot {
  constructor(customToken = null) {
    this.token = (
      customToken ||
      process.env.MOVIEBOX_BOT_TOKEN ||
      (!process.env.TG_API_ID ? process.env.TG_BOT_TOKEN : "") ||
      process.env.TG_BOT_TOKEN ||
      ""
    ).trim();
    this.client = new MovieBoxClient();
    this.offset = 0;
    this.isRunning = false;
    this.botInfo = null;
    this.abortController = null;
    this.sessionsFile = path.join(__dirname, "../../data/bot_auth_sessions.json");
    this.authorizedUsers = new Map();
    this.userStates = new Map(); // Tracks inline interactive Login / Signup steps
    this.loadSessions();
  }

  // ============================================================
  // SESSION & VIP AUTHENTICATION MANAGEMENT
  // ============================================================

  loadSessions() {
    try {
      if (fs.existsSync(this.sessionsFile)) {
        const raw = fs.readFileSync(this.sessionsFile, "utf-8");
        const list = JSON.parse(raw);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.userId) {
              this.authorizedUsers.set(String(item.userId), item);
            }
          }
        }
      }
    } catch (e) {
      console.warn("⚠️ [TelegramBot] Could not read sessions file:", e.message);
    }
  }

  saveSessions() {
    try {
      const dir = path.dirname(this.sessionsFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.authorizedUsers.values());
      fs.writeFileSync(this.sessionsFile, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.warn("⚠️ [TelegramBot] Could not save sessions file:", e.message);
    }
  }

  authorizeUser(userId, user, isVip = false, plan = null, expiryDate = "") {
    const uid = String(userId);
    const entry = {
      userId: uid,
      accountId: user?.id || uid,
      email: user?.email || "",
      name: user?.name || user?.email?.split("@")[0] || "User",
      isVip: !!isVip,
      plan: plan?.title || (isVip ? "VIP Member" : "Free"),
      expiryDate: expiryDate || "",
      loggedInAt: new Date().toISOString(),
    };
    this.authorizedUsers.set(uid, entry);
    this.saveSessions();
    return entry;
  }

  getAuthorizedUser(userId) {
    return this.authorizedUsers.get(String(userId)) || null;
  }

  async ensureUserSession(userId, from = null) {
    const uid = String(userId);
    let session = this.getAuthorizedUser(uid);

    // 1. If already logged in, verify/refresh VIP status live from Supabase without clearing session
    if (session) {
      try {
        const subInfo = await checkUserSubscription(session.accountId, session.email);
        if (subInfo && subInfo.isVip !== undefined) {
          session.isVip = !!subInfo.isVip;
          if (subInfo.plan?.title) session.plan = subInfo.plan.title;
          if (subInfo.expiryDate) session.expiryDate = subInfo.expiryDate;
          this.saveSessions();
        }
      } catch (_) {}
      return session;
    }

    // 2. If not logged in locally, attempt automatic lookup from Supabase (by Telegram ID or Username)
    try {
      const resolved = await resolveTelegramUser(uid, from?.username || "");
      if (resolved && resolved.found && resolved.user) {
        session = this.authorizeUser(
          uid,
          resolved.user,
          resolved.isVip,
          resolved.plan,
          resolved.expiryDate
        );
        return session;
      }
    } catch (e) {
      console.warn("[ensureUserSession Auto-resolve Note]:", e.message);
    }

    return null;
  }

  getUserState(userId, chatId = null) {
    const uid = String(userId);
    const cid = chatId ? String(chatId) : null;
    return this.userStates.get(uid) || (cid ? this.userStates.get(cid) : null) || null;
  }

  setUserState(userId, chatId, state) {
    const uid = String(userId);
    const cid = String(chatId);
    this.userStates.set(uid, state);
    this.userStates.set(cid, state);
  }

  clearUserState(userId, chatId = null) {
    const uid = String(userId);
    const cid = chatId ? String(chatId) : null;
    this.userStates.delete(uid);
    if (cid) this.userStates.delete(cid);
  }

  deauthorizeUser(userId) {
    const uid = String(userId);
    this.clearUserState(uid);
    const removed = this.authorizedUsers.delete(uid);
    if (removed) {
      this.saveSessions();
    }
    return removed;
  }

  // ============================================================
  // URL & TELEGRAM API HELPERS
  // ============================================================

  getBaseUrl() {
    return `https://api.telegram.org/bot${this.token}`;
  }

  getHostUrl() {
    return workerPool.getBestWorker();
  }

  getMiniAppUrl(subjectId = "", season = 0, episode = 0, quality = "auto", title = "", extraMeta = {}) {
    let rawHost = (
      process.env.EXOPLAYER_URL ||
      process.env.MINIAPP_URL ||
      process.env.WEBAPP_URL ||
      process.env.BASE_HOST_URL ||
      process.env.HOST_URL ||
      this.getHostUrl()
    ).trim();

    rawHost = rawHost.replace(/^[=\s"']+/, "").replace(/[/"'\s]+$/, "");
    if (!rawHost.startsWith("http://") && !rawHost.startsWith("https://")) {
      rawHost = `https://${rawHost}`;
    }
    // Telegram Mini App strictly requires https://
    rawHost = rawHost.replace(/^http:\/\//i, "https://");

    let base = rawHost;
    if (!base.endsWith("/player") && !base.endsWith("/exoplayer") && !base.endsWith(".html")) {
      base = `${base}/player`;
    }

    const params = new URLSearchParams();
    if (subjectId) params.set("id", String(subjectId));
    if (season > 0) params.set("s", String(season));
    if (episode > 0) params.set("e", String(episode));
    if (quality && quality !== "auto") params.set("q", String(quality));
    if (title) {
      const cleanTitle = String(title).replace(/[^a-zA-Z0-9 \-_.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 35);
      if (cleanTitle) params.set("title", cleanTitle);
    }
    if (extraMeta.year) params.set("year", String(extraMeta.year));
    if (extraMeta.rating) params.set("rating", String(extraMeta.rating));

    const query = params.toString();
    return query ? `${base}?${query}` : base;
  }

  getLiveMiniAppUrl(channelId, channelTitle, directStreamUrl = "", referer = "") {
    let rawHost = (
      process.env.EXOPLAYER_URL ||
      process.env.MINIAPP_URL ||
      process.env.WEBAPP_URL ||
      process.env.BASE_HOST_URL ||
      process.env.HOST_URL ||
      this.getHostUrl()
    ).trim();

    rawHost = rawHost.replace(/^[=\s"']+/, "").replace(/[/"'\s]+$/, "");
    if (!rawHost.startsWith("http://") && !rawHost.startsWith("https://")) {
      rawHost = `https://${rawHost}`;
    }
    rawHost = rawHost.replace(/^http:\/\//i, "https://");

    let base = rawHost;
    if (!base.endsWith("/player") && !base.endsWith("/exoplayer") && !base.endsWith(".html")) {
      base = `${base}/player`;
    }

    // Direct stream without adding proxy for live channels
    const streamUrl = (directStreamUrl && directStreamUrl.trim()) ? directStreamUrl.trim() : `${rawHost}/api/live/${channelId}.m3u8`;

    const cleanTitle = String(channelTitle).replace(/[^a-zA-Z0-9 \-_.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 35);
    const params = new URLSearchParams();
    params.set("url", streamUrl);
    params.set("title", cleanTitle);
    params.set("type", "m3u8");

    return `${base}?${params.toString()}`;
  }

  async callApi(method, payload = {}) {
    const url = `${this.getBaseUrl()}/${method}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(35000),
      // @ts-ignore
      agent: telegramHttpsAgent,
    });
    const json = await res.json();
    if (!json.ok) {
      if (payload.parse_mode && (json.description?.includes("parse entities") || json.description?.includes("can't parse"))) {
        const fallbackPayload = { ...payload };
        delete fallbackPayload.parse_mode;
        if (typeof fallbackPayload.text === "string") {
          fallbackPayload.text = fallbackPayload.text.replace(/[*_`]/g, "");
        }
        if (typeof fallbackPayload.caption === "string") {
          fallbackPayload.caption = fallbackPayload.caption.replace(/[*_`]/g, "");
        }
        const retryRes = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(fallbackPayload),
          signal: AbortSignal.timeout(35000),
          // @ts-ignore
          agent: telegramHttpsAgent,
        });
        const retryJson = await retryRes.json();
        if (retryJson.ok) return retryJson.result;
      }
      throw new Error(json.description || `Telegram API error on ${method}`);
    }
    return json.result;
  }

  // ============================================================
  // BOT LIFECYCLE & POLLING
  // ============================================================

  async start() {
    if (!this.token) {
      console.log("ℹ️ [TelegramBot] No bot token configured. Bot disabled.");
      return;
    }
    try {
      this.botInfo = await this.callApi("getMe");
      console.log(`🤖 [TelegramBot] CineFlix Interactive OTT Bot started: @${this.botInfo.username}`);
      this.isRunning = true;
      try {
        await this.callApi("deleteWebhook", { drop_pending_updates: false }).catch(() => {});
        await this.callApi("setChatMenuButton", {
          menu_button: {
            type: "default",
          },
        }).catch(() => {});
      } catch (_) {}
      this.pollUpdates();
    } catch (err) {
      console.error("❌ [TelegramBot] Failed to start bot:", err.message);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  async pollUpdates() {
    while (this.isRunning) {
      try {
        const updates = await this.callApi("getUpdates", {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ["message", "callback_query"],
        });

        for (const u of updates) {
          this.offset = u.update_id + 1;
          this.handleUpdate(u).catch((e) => {
            console.error("⚠️ [TelegramBot Update Error]:", e.message);
          });
        }
      } catch (err) {
        if (!this.isRunning) break;
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  async handleUpdate(update) {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // ============================================================
  // MESSAGE HANDLER (INSTRUCTIONS, INTERACTIVE INLINE AUTH, SEARCH)
  // ============================================================

  async handleMessage(msg) {
    const chatId = msg.chat.id;
    const from = msg.from;
    const userId = from ? String(from.id) : String(chatId);
    const text = (msg.text || "").trim();

    if (!text) return;

    // 0. Check interactive conversational state (Inline Sign In / Sign Up)
    const userState = this.getUserState(userId, chatId);
    if (userState && !text.startsWith("/")) {
      return await this.handleInteractiveAuthState(chatId, userId, text, userState, msg);
    }

    // Direct standalone Email sent by user -> Automatically treat as Sign In
    const emailOnlyMatch = text.match(/^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$/);
    if (emailOnlyMatch) {
      const email = text.toLowerCase();
      this.setUserState(userId, chatId, { step: "LOGIN_PASSWORD", email });
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text:
          `🔐 *Account:* \`${email}\`\n\n` +
          `👉 Please send your *CineFlix Password*:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign In", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    // Cancel state command
    if (text === "/cancel") {
      this.clearUserState(userId, chatId);
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: "✓ Operation cancelled.",
      });
      return await this.sendWelcomeInstructions(chatId, userId, from);
    }

    // 1. Logout Command: /logout
    if (text === "/logout") {
      this.deauthorizeUser(userId);
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `🔒 *Logged Out Successfully*\n\nYour CineFlix session has been cleared.\nSend \`/start\` to sign in again.`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "🔐 Sign In", callback_data: "menu:login_prompt" },
              { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
            ],
          ],
        },
      });
      return;
    }

    // 2. Info / Status Command: /id, /whoami, /profile, /info
    if (text === "/id" || text === "/whoami" || text === "/profile" || text === "/info") {
      const auth = await this.ensureUserSession(userId, from);
      const isAuth = !!auth;

      let subInfo = { isVip: false, status: "NONE" };
      if (isAuth) {
        subInfo = await checkUserSubscription(auth.accountId, auth.email);
        if (subInfo.isVip !== auth.isVip) {
          auth.isVip = subInfo.isVip;
          auth.expiryDate = subInfo.expiryDate || "";
          this.saveSessions();
        }
      }

      const reply =
        `👤 *CineFlix OTT User Profile*\n\n` +
        `• *Telegram ID:* \`${userId}\`\n` +
        `• *Username:* @${from?.username || "N/A"}\n` +
        `• *Account:* \`${auth?.email || "Guest (Not Logged In)"}\`\n` +
        `• *VIP Status:* ${subInfo.isVip ? `🟢 Active VIP (${subInfo.expiryDate || "Subscribed"})` : "🔴 Free Tier"}\n\n` +
        (subInfo.isVip
          ? `_Type any movie or series name to start streaming in 4K Ultra HD!_`
          : `_Send \`/plans\` to activate VIP access or tap Sign In below:_`);

      const keyboard = [];
      if (!isAuth) {
        keyboard.push([
          { text: "🔐 Sign In", callback_data: "menu:login_prompt" },
          { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
        ]);
      }
      keyboard.push([
        { text: "👑 View VIP Subscription Plans", callback_data: "menu:plans" },
      ]);

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: reply,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // 3. Subscription Plans Command: /plans, /vip, /pricing
    if (text === "/plans" || text === "/vip" || text === "/pricing" || text === "/subscription") {
      return await this.sendPlansMessage(chatId);
    }

    // 3b. Live Cricket & Sports Channels Command (VIP Gated): /live, /cricket, /sports, /match
    if (text === "/live" || text === "/cricket" || text === "/sports" || text === "/match") {
      return await this.sendLiveCricketChannels(chatId, userId);
    }

    // 4. Direct Sign Up Command (Fallback): /signup <Name> <Email> <Password>
    const signupMatch = text.match(/^\/(?:signup|register)\s+([^\s]+(?:\s+[^\s]+)*)\s+([^\s]+@[^\s]+)\s+([^\s]+)$/i);
    if (signupMatch) {
      const name = signupMatch[1].trim();
      const email = signupMatch[2].trim().toLowerCase();
      const password = signupMatch[3].trim();

      const waitMsg = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⏳ Creating your CineFlix account for *${email}*...`,
        parse_mode: "Markdown",
      });

      try {
        const res = await registerUser(name, email, password);
        if (res.success) {
          this.authorizeUser(userId, res.user, false, null, "");

          const signupSuccessText =
            `🎉 *Account Created Successfully!* ✉️\n\n` +
            `👤 *Name:* ${name}\n` +
            `📧 *Email:* \`${email}\`\n\n` +
            `📬 *Gmail Verification Sent:* Please open your Gmail app and click the confirmation link to activate full app sync.\n\n` +
            `👑 *Upgrade to VIP to Unlock 4K Ultra HD Movies & Live Cricket:*`;

          const keyboard = [
            [
              { text: `💳 Activate ₹2 VIP Trial on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
            ],
            [
              { text: "👑 View All VIP Plans", callback_data: "menu:plans" },
            ],
          ];

          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: signupSuccessText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } else {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ *Sign Up Failed:*\n${res.error}`,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "📝 Try Sign Up Again", callback_data: "menu:signup_prompt" }]],
            },
          });
          return;
        }
      } catch (err) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `⚠️ Sign Up error: ${err.message}`,
        });
        return;
      }
    }

    // 5. Direct Login Command (Fallback): /login <email> <password>
    const loginMatch = text.match(/^\/login\s+([^\s]+)\s+(.+)$/i) || text.match(/^([a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+)\s+(.+)$/);
    if (loginMatch) {
      const email = loginMatch[1].trim().toLowerCase();
      const password = loginMatch[2].trim();

      const waitMsg = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `🔐 Verifying CineFlix account for *${email}*...`,
        parse_mode: "Markdown",
      });

      try {
        const authRes = await authenticateUser(email, password);
        if (authRes.success) {
          const subInfo = await checkUserSubscription(authRes.user.id, authRes.user.email);
          this.authorizeUser(userId, authRes.user, subInfo.isVip, subInfo.plan, subInfo.expiryDate);

          const loginReply =
            `🎉 *Sign In Successful!* ✨\n\n` +
            `👤 *Account:* \`${authRes.user.email}\`\n` +
            `👑 *VIP Status:* ${subInfo.isVip ? `🟢 Active VIP Member (Expires: ${subInfo.expiryDate || "Active"})` : "🔴 Free Tier (No Active Plan)"}\n\n` +
            (subInfo.isVip
              ? `🍿 *Type any Movie or Web Series title to start streaming in 4K:*`
              : `⚡ *Activate the ₹2 VIP All-Access Trial on @${VIP_BOT_USERNAME} to unlock 4K streaming:*`);

          const keyboard = [];
          if (!subInfo.isVip) {
            keyboard.push([
              { text: `💳 Subscribe on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
            ]);
            keyboard.push([
              { text: "👑 View VIP Plans", callback_data: "menu:plans" },
            ]);
          }

          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: loginReply,
            parse_mode: "Markdown",
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
          });
          return;
        } else {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ *Sign In Failed:*\n\n${authRes.error || "Invalid Gmail or Password."}`,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🔐 Try Sign In", callback_data: "menu:login_prompt" },
                  { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
                ],
              ],
            },
          });
          return;
        }
      } catch (err) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `⚠️ Sign In error: ${err.message}`,
        });
        return;
      }
    }

    // 6. Start / Help Command
    if (text.startsWith("/start") || text.startsWith("/help")) {
      const startArg = text.replace(/^\/(start|help)\s*/i, "").trim();
      if (startArg) {
        if (startArg.startsWith("m_") || startArg.startsWith("m:")) {
          const id = startArg.replace(/^m[_:]/, "");
          return await this.handleMovieSelect(chatId, id);
        }
        if (startArg.startsWith("s_") || startArg.startsWith("s:")) {
          const id = startArg.replace(/^s[_:]/, "");
          return await this.sendSeriesSeasonSelector(chatId, id);
        }
      }

      return await this.sendWelcomeInstructions(chatId, userId, from);
    }

    // 7. Process Movie / Series Search Query
    const query = text.replace(/^\/(search|movie|find|play)\s*/i, "").trim();
    if (!query) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: "Please send a movie or series name to search, e.g. `Avatar` or `Money Heist`",
        parse_mode: "Markdown",
      });
      return;
    }

    const waitMsg = await this.callApi("sendMessage", {
      chat_id: chatId,
      text: `🔍 Searching catalog for *"${query}"*...`,
      parse_mode: "Markdown",
    });

    try {
      await this.client.ensureSession();
      const res = await this.client.search(query, 1, 8);
      const items = res.items || [];

      if (items.length === 0) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `❌ No results found for *"${query}"*. Please try another spelling.`,
          parse_mode: "Markdown",
        });
        return;
      }

      // Build inline buttons for results
      const keyboard = items.slice(0, 8).map((it) => {
        const typeIcon = it.type === "series" ? "📺 [SERIES]" : "🎬 [MOVIE]";
        const hindiBadge = it.isHindi ? " 🇮🇳" : "";
        const titleLabel = `${it.cleanTitle || it.title} (${it.year || "N/A"}) ${typeIcon}${hindiBadge}`;
        const prefix = it.type === "series" ? "s" : "m";
        return [
          {
            text: titleLabel,
            callback_data: `${prefix}:${it.id}`,
          },
        ];
      });

      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `🍿 *Results for "${query}":*\nSelect a title below to stream:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: keyboard,
        },
      });
    } catch (err) {
      await this.callApi("editMessageText", {
        chat_id: chatId,
        message_id: waitMsg.message_id,
        text: `⚠️ Search failed: ${err.message}`,
      });
    }
  }

  // ============================================================
  // INTERACTIVE INLINE AUTHENTICATION STATE HANDLER
  // ============================================================

  async handleInteractiveAuthState(chatId, userId, text, state, msg) {
    const step = state.step;

    // --- Interactive Sign In Steps ---
    if (step === "LOGIN_EMAIL") {
      const email = text.trim().toLowerCase();
      if (!email.includes("@") || !email.includes(".")) {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: "❌ *Invalid email format.* Please send a valid Gmail / Email address (e.g. `alex@gmail.com`):",
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Cancel Sign In", callback_data: "action:cancel_auth" }]],
          },
        });
        return;
      }

      this.setUserState(userId, chatId, { step: "LOGIN_PASSWORD", email });
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text:
          `🔐 *Account:* \`${email}\`\n\n` +
          `👉 Please send your *Account Password*:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign In", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    if (step === "LOGIN_PASSWORD") {
      const email = state.email;
      const password = text.trim();
      this.clearUserState(userId, chatId);

      // Delete password message for security
      if (msg.message_id) {
        this.callApi("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      }

      const waitMsg = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `🔐 Verifying credentials for *${email}*...`,
        parse_mode: "Markdown",
      });

      try {
        const authRes = await authenticateUser(email, password);
        if (authRes.success) {
          const subInfo = await checkUserSubscription(authRes.user.id, authRes.user.email);
          this.authorizeUser(userId, authRes.user, subInfo.isVip, subInfo.plan, subInfo.expiryDate);

          const loginReply =
            `🎉 *Sign In Successful!* ✨\n\n` +
            `👤 *Account:* \`${authRes.user.email}\`\n` +
            `👑 *VIP Status:* ${subInfo.isVip ? `🟢 Active VIP Member (Expires: ${subInfo.expiryDate || "Active"})` : "🔴 Free Tier (No Active Plan)"}\n\n` +
            (subInfo.isVip
              ? `🍿 *Send any Movie or Web Series title to start streaming in 4K:*`
              : `⚡ *Activate the ₹2 VIP All-Access Trial on @${VIP_BOT_USERNAME} to unlock 4K streaming:*`);

          const keyboard = [];
          if (!subInfo.isVip) {
            keyboard.push([
              { text: `💳 Subscribe on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
            ]);
            keyboard.push([
              { text: "👑 View VIP Plans", callback_data: "menu:plans" },
            ]);
          }

          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: loginReply,
            parse_mode: "Markdown",
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined,
          });
          return;
        } else {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ *Sign In Failed:*\n\n${authRes.error || "Invalid Gmail or Password."}`,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "🔐 Try Sign In", callback_data: "menu:login_prompt" },
                  { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
                ],
              ],
            },
          });
          return;
        }
      } catch (err) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `⚠️ Sign In error: ${err.message}`,
        });
        return;
      }
    }

    // --- Interactive Sign Up Steps ---
    if (step === "SIGNUP_NAME") {
      const name = text.trim();
      this.setUserState(userId, chatId, { step: "SIGNUP_EMAIL", name });
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text:
          `📝 *Full Name:* ${name}\n\n` +
          `👉 *Step 2/3:* Please enter your **Gmail / Email Address**:`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign Up", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    if (step === "SIGNUP_EMAIL") {
      const email = text.trim().toLowerCase();
      if (!email.includes("@") || !email.includes(".")) {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: "❌ *Invalid email format.* Please send a valid Gmail / Email address (e.g. `rahul@gmail.com`):",
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[{ text: "« Cancel Sign Up", callback_data: "action:cancel_auth" }]],
          },
        });
        return;
      }

      // Check if email is already registered in CineFlix
      const isRegistered = await checkEmailExists(email);
      if (isRegistered) {
        this.clearUserState(userId, chatId);
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text:
            `⚠️ *Account Already Exists!*\n\n` +
            `The email \`${email}\` is already registered in CineFlix.\n\n` +
            `👉 Please **Sign In** with your existing password:`,
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "🔐 Sign In with this Account", callback_data: "menu:login_prompt" }],
              [{ text: "📝 Use a Different Email", callback_data: "menu:signup_prompt" }],
              [{ text: "« Cancel", callback_data: "action:cancel_auth" }],
            ],
          },
        });
        return;
      }

      this.setUserState(userId, chatId, { step: "SIGNUP_PASSWORD", name: state.name, email });
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text:
          `📝 *Account:* \`${email}\`\n\n` +
          `👉 *Step 3/3:* Choose a secure **Password** (min 6 characters):`,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign Up", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    if (step === "SIGNUP_PASSWORD") {
      const name = state.name;
      const email = state.email;
      const password = text.trim();
      this.clearUserState(userId, chatId);

      // Delete password message for security
      if (msg.message_id) {
        this.callApi("deleteMessage", { chat_id: chatId, message_id: msg.message_id }).catch(() => {});
      }

      const waitMsg = await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⏳ Creating your CineFlix account for *${email}*...`,
        parse_mode: "Markdown",
      });

      try {
        const res = await registerUser(name, email, password);
        if (res.success) {
          this.authorizeUser(userId, res.user, false, null, "");

          const signupSuccessText =
            `🎉 *Account Created Successfully!* ✉️\n\n` +
            `👤 *Name:* ${name}\n` +
            `📧 *Email:* \`${email}\`\n\n` +
            `📬 *Gmail Verification Sent:* Please open your Gmail and click the confirmation link to complete registration.\n\n` +
            `👑 *Upgrade to VIP to Unlock 4K Ultra HD Streaming & Live TV:*`;

          const keyboard = [
            [
              { text: `💳 Activate ₹2 VIP Trial on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
            ],
            [
              { text: "👑 View All VIP Plans", callback_data: "menu:plans" },
            ],
          ];

          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: signupSuccessText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } else {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: waitMsg.message_id,
            text: `❌ *Sign Up Failed:*\n${res.error}\n\nPlease try again below:`,
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[{ text: "📝 Try Sign Up Again", callback_data: "menu:signup_prompt" }]],
            },
          });
          return;
        }
      } catch (err) {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: waitMsg.message_id,
          text: `⚠️ Sign Up error: ${err.message}`,
        });
        return;
      }
    }
  }

  // ============================================================
  // WELCOME & STREAMING INSTRUCTIONS
  // ============================================================

  async sendWelcomeInstructions(chatId, userId, from = null, origMsgId = null) {
    const auth = await this.ensureUserSession(userId, from);
    const isAuth = !!auth;

    const instructionsText =
      `🎬 *Welcome to CineFlix OTT!* 🍿\n\n` +
      `📖 *Streaming Guide (3 Easy Steps):*\n` +
      `1️⃣ *Search:* Type any Movie or Series name in this chat.\n` +
      `2️⃣ *Select Dub & Quality:* Choose Hindi/Original audio and 4K UHD or 1080p.\n` +
      `3️⃣ *Watch:* Tap the final *Watch in CineFlix OTT* button to play instantly!\n\n` +
      `👤 *Account:* ${isAuth ? `\`${auth.email}\`` : "Guest (Not logged in)"}\n` +
      `👑 *VIP Access:* ${auth?.isVip ? `🟢 Active VIP (${auth.expiryDate || "Member"})` : "🔴 Free Tier"}\n\n` +
      `🍿 *Send any title to start watching:* \`Avatar\`, \`Jawan\`, \`Money Heist\``;

    const keyboard = [
      [
        { text: "🏏 Live Cricket 🔴 (VIP)", callback_data: "menu:live" },
      ],
    ];

    if (!isAuth) {
      keyboard.push([
        { text: "🔐 Sign In", callback_data: "menu:login_prompt" },
        { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
      ]);
    }
    keyboard.push([
      { text: "👑 View VIP Subscription Plans", callback_data: "menu:plans" },
    ]);

    if (origMsgId) {
      try {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: origMsgId,
          text: instructionsText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      } catch (_) {}
    }

    await this.callApi("sendMessage", {
      chat_id: chatId,
      text: instructionsText,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // ============================================================
  // VIP SUBSCRIPTION PLANS MENU
  // ============================================================

  async sendPlansMessage(chatId, origMsgId = null) {
    let plansText = `👑 *CineFlix OTT VIP Subscription Plans*\n\n`;

    VIP_PLANS.forEach((p, idx) => {
      plansText += `*${idx + 1}. ${p.title}* (${p.badge})\n`;
      plansText += `💰 *Price:* ₹${p.price} | ⏱️ *Duration:* ${p.durationDays} Days\n`;
      plansText += `✨ ${p.description}\n\n`;
    });

    plansText +=
      `👉 *How to Activate your VIP Subscription:*\n` +
      `Tap the button below to message our dedicated VIP Payment Bot *@${VIP_BOT_USERNAME}* with your 12-digit UPI UTR number and receipt. Your plan will be activated within 2 minutes!`;

    const keyboard = [
      [
        { text: `💳 Subscribe on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
      ],
      [
        { text: "« Back to Main Menu", callback_data: "menu:start" },
      ],
    ];

    if (origMsgId) {
      try {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: origMsgId,
          text: plansText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      } catch (_) {}
    }

    await this.callApi("sendMessage", {
      chat_id: chatId,
      text: plansText,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // ============================================================
  // VIP GATED LIVE CRICKET CHANNELS MENU
  // ============================================================

  async sendLiveCricketChannels(chatId, userId, origMsgId = null) {
    const auth = await this.ensureUserSession(userId);
    const isAuth = !!auth;

    // 1. Check if user is logged in
    if (!isAuth) {
      const notAuthText =
        `🔒 *Live Cricket is an Exclusive VIP Feature*\n\n` +
        `Please sign in to your CineFlix account or create a free account to access Live Cricket & Sports channels:`;

      const keyboard = [
        [
          { text: "🔐 Sign In", callback_data: "menu:login_prompt" },
          { text: "📝 Sign Up", callback_data: "menu:signup_prompt" },
        ],
        [
          { text: "👑 View VIP Subscription Plans", callback_data: "menu:plans" },
        ],
        [
          { text: "« Back to Main Menu", callback_data: "menu:start" },
        ],
      ];

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: notAuthText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: notAuthText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // 2. Check VIP Subscription status against Supabase
    const subInfo = await checkUserSubscription(auth.accountId, auth.email);
    if (subInfo.isVip !== auth.isVip) {
      auth.isVip = subInfo.isVip;
      auth.expiryDate = subInfo.expiryDate || "";
      this.saveSessions();
    }

    // If logged in, but not VIP:
    if (!subInfo.isVip) {
      const nonVipText =
        `👑 *CineFlix VIP Access Required*\n\n` +
        `👤 *Account:* \`${auth.email}\`\n` +
        `🔴 *Status:* Free Tier (No Active Subscription)\n\n` +
        `⚡ *Live Cricket & 24x7 Sports Channels* are exclusive to VIP members.\n\n` +
        `👉 *Activate the ₹2 VIP All-Access Trial or ₹5 24-Hr Pass on @${VIP_BOT_USERNAME} to unlock Live Cricket instantly:*`;

      const keyboard = [
        [
          { text: `💳 Activate on @${VIP_BOT_USERNAME}`, url: `https://t.me/${VIP_BOT_USERNAME}` },
        ],
        [
          { text: "👑 View VIP Plans", callback_data: "menu:plans" },
          { text: "« Back to Main Menu", callback_data: "menu:start" },
        ],
      ];

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: nonVipText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: nonVipText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    // 3. User is VIP! Load all live cricket channels dynamically from Supabase
    const liveChannels = await getSupabaseLiveChannels();

    if (!liveChannels || liveChannels.length === 0) {
      const noLiveText =
        `🏏 *CineFlix VIP Live Cricket Channels*\n\n` +
        `👑 *VIP Member:* \`${auth.email}\` (${subInfo.expiryDate || "Active"})\n\n` +
        `ℹ️ *No Live Cricket Channels or Matches are active right now.*\n\n` +
        `Please check back during live match hours!`;

      const keyboard = [
        [{ text: "« Back to Main Menu", callback_data: "menu:start" }],
      ];

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: noLiveText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: noLiveText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    const keyboard = [];
    liveChannels.forEach((ch) => {
      // Use tele_cdn column for Telegram (fallback to streamUrl if empty)
      const liveStreamUrl = (ch.teleCdn && ch.teleCdn.trim()) ? ch.teleCdn.trim() : (ch.streamUrl || "");
      const url = this.getLiveMiniAppUrl(ch.id, ch.title, liveStreamUrl, ch.referer);
      const flag = ch.language?.toLowerCase() === "hindi" ? " 🇮🇳" : "";
      keyboard.push([
        { text: `📺 ${ch.title}${flag}`, web_app: { url } },
      ]);
    });

    keyboard.push([
      { text: "« Back to Main Menu", callback_data: "menu:start" },
    ]);

    const liveText =
      `🏏 *CineFlix VIP Live Cricket Channels* 🔴\n\n` +
      `👑 *VIP Member:* \`${auth.email}\` (${subInfo.expiryDate || "Active"})\n` +
      `⚡ *Ultra HD 1080p 60fps • 0-Delay Live Stream*\n\n` +
      `👉 *Select a live channel below to watch in CineFlix OTT:*`;

    if (origMsgId) {
      try {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: origMsgId,
          text: liveText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      } catch (_) {}
    }

    await this.callApi("sendMessage", {
      chat_id: chatId,
      text: liveText,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  // ============================================================
  // CALLBACK QUERY HANDLER
  // ============================================================

  async handleCallbackQuery(cb) {
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const userId = cb.from ? String(cb.from.id) : String(chatId);
    const data = cb.data || "";

    // Main Menu / Home: "menu:start"
    if (data === "menu:start") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      this.clearUserState(userId, chatId);
      return await this.sendWelcomeInstructions(chatId, userId, cb.from, msgId);
    }

    // View Plans: "menu:plans"
    if (data === "menu:plans") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Loading VIP plans..." }).catch(() => {});
      return await this.sendPlansMessage(chatId, msgId);
    }

    // Live Cricket Channels (VIP Gated): "menu:live"
    if (data === "menu:live") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Checking VIP status..." }).catch(() => {});
      return await this.sendLiveCricketChannels(chatId, userId, msgId);
    }

    // Interactive Sign In Prompt
    if (data === "menu:login_prompt") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      this.setUserState(userId, chatId, { step: "LOGIN_EMAIL" });
      const loginPromptText =
        `🔐 *CineFlix Account Sign In*\n\n` +
        `👉 Please send your registered **Gmail / Email Address**:`;

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: loginPromptText,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign In", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    // Interactive Sign Up Prompt
    if (data === "menu:signup_prompt") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => {});
      this.setUserState(userId, chatId, { step: "SIGNUP_NAME" });
      const signupPromptText =
        `📝 *Create Free CineFlix Account* (Step 1/3)\n\n` +
        `👉 What is your **Full Name**?`;

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: signupPromptText,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[{ text: "« Cancel Sign Up", callback_data: "action:cancel_auth" }]],
        },
      });
      return;
    }

    // Cancel Auth State
    if (data === "action:cancel_auth") {
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Cancelled" }).catch(() => {});
      this.clearUserState(userId, chatId);
      return await this.sendWelcomeInstructions(chatId, userId, cb.from, msgId);
    }

    // 1. Movie Selected: "m:<id>" -> Step 1: Language / Quality Selection
    if (data.startsWith("m:")) {
      const subjectId = data.substring(2);
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Loading movie..." }).catch(() => {});
      await this.handleMovieSelect(chatId, subjectId, msgId);
      return;
    }

    // 2. Series Selected: "s:<id>" -> Step 1a: Season Selection
    if (data.startsWith("s:")) {
      const subjectId = data.substring(2);
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "Loading seasons..." }).catch(() => {});
      await this.sendSeriesSeasonSelector(chatId, subjectId, msgId);
      return;
    }

    // 3. Series Season Chosen: "se:<id>:<season>" -> Step 1b: Episode Selection
    if (data.startsWith("se:")) {
      const [, subjectId, season] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: `Loading Season ${season}...` }).catch(() => {});
      await this.sendSeriesEpisodeSelector(chatId, subjectId, parseInt(season) || 1, msgId);
      return;
    }

    // 4. Series Episode Chosen: "ep:<id>:<season>:<episode>" -> Step 2: Language Selection
    if (data.startsWith("ep:")) {
      const [, subjectId, season, episode] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: `Selected S${season}E${episode}...` }).catch(() => {});
      await this.handleSeriesEpisodeSelect(chatId, subjectId, parseInt(season) || 1, parseInt(episode) || 1, msgId);
      return;
    }

    // 5. Language Picked: "step:lang:<type>:<subjectId>:<season>:<episode>:<dubId>" -> Step 3: Quality Selection
    if (data.startsWith("step:lang:")) {
      const [, , type, subjectId, season, episode, dubId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "✓ Audio Selected! Next: Quality" }).catch(() => {});
      await this.sendQualitySelector(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, msgId);
      return;
    }

    // 6. Quality Picked: "step:play:<type>:<subjectId>:<season>:<episode>:<dubId>:<quality>" -> Step 4: Stream Players
    if (data.startsWith("step:play:")) {
      const [, , type, subjectId, season, episode, dubId, quality] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "🎬 Generating stream & players..." }).catch(() => {});
      await this.sendFinalStreamPlayerCard(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, quality, msgId, userId);
      return;
    }

    // Navigation Back to Seasons: "step:back:season:<subjectId>"
    if (data.startsWith("step:back:season:")) {
      const [, , , subjectId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Seasons" }).catch(() => {});
      await this.sendSeriesSeasonSelector(chatId, subjectId, msgId);
      return;
    }

    // Navigation Back to Episodes: "step:back:ep:<subjectId>:<season>"
    if (data.startsWith("step:back:ep:")) {
      const [, , , subjectId, season] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Episodes" }).catch(() => {});
      await this.sendSeriesEpisodeSelector(chatId, subjectId, parseInt(season) || 1, msgId);
      return;
    }

    // Navigation Back to Language: "step:back:lang:<type>:<subjectId>:<season>:<episode>"
    if (data.startsWith("step:back:lang:")) {
      const [, , , type, subjectId, season, episode] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Language" }).catch(() => {});
      if (type === "s") {
        await this.handleSeriesEpisodeSelect(chatId, subjectId, parseInt(season) || 1, parseInt(episode) || 1, msgId);
      } else {
        await this.handleMovieSelect(chatId, subjectId, msgId);
      }
      return;
    }

    // Navigation Back to Quality: "step:back:qual:<type>:<subjectId>:<season>:<episode>:<dubId>"
    if (data.startsWith("step:back:qual:")) {
      const [, , , type, subjectId, season, episode, dubId] = data.split(":");
      await this.callApi("answerCallbackQuery", { callback_query_id: cb.id, text: "« Back to Quality" }).catch(() => {});
      await this.sendQualitySelector(chatId, type, subjectId, parseInt(season) || 0, parseInt(episode) || 0, dubId, msgId);
      return;
    }
  }

  // ============================================================
  // STEP 2: MOVIE / SERIES LANGUAGE SELECTOR
  // ============================================================

  async handleMovieSelect(chatId, subjectId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      if (details.type === "series" || (Array.isArray(details.seasons) && details.seasons.length > 0)) {
        return await this.sendSeriesSeasonSelector(chatId, subjectId, origMsgId);
      }

      // If multiple audio dubs exist, show Language Selection step
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        const keyboard = [];
        let row = [];
        const defaultHindiIdx = details.dubs.findIndex((d) => d.isHindi);
        const preselectDubId = defaultHindiIdx !== -1 ? details.dubs[defaultHindiIdx].subjectId : details.dubs[0].subjectId;

        details.dubs.forEach((d) => {
          const isDef = d.subjectId === preselectDubId;
          const flag = d.isHindi ? "🇮🇳 " : "";
          const shortName = d.languageName.replace(/ dub$/i, "");
          row.push({
            text: `${isDef ? "⭐ " : ""}${flag}${shortName}${isDef ? " (Default)" : ""}`,
            callback_data: `step:lang:m:${subjectId}:0:0:${d.subjectId}`,
          });
          if (row.length === 2) {
            keyboard.push(row);
            row = [];
          }
        });
        if (row.length > 0) keyboard.push(row);
        keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

        const promptText =
          `🎬 *${title}* (${details.year || "N/A"})\n` +
          `⭐ *Rating:* ${details.rating || "N/A"} | 📝 *Genres:* ${(details.genres || []).join(", ") || "General"}\n\n` +
          `🔊 *Step 1/2: Select Audio Language / Dub:*`;

        if (origMsgId) {
          try {
            await this.callApi("editMessageText", {
              chat_id: chatId,
              message_id: origMsgId,
              text: promptText,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          } catch (_) {}
        }

        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: promptText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      }

      // Only 1 dub available -> proceed directly to Quality selection
      const targetDubId = (Array.isArray(details.dubs) && details.dubs[0]?.subjectId) || subjectId;
      await this.sendQualitySelector(chatId, "m", subjectId, 0, 0, targetDubId, origMsgId);
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error fetching movie details: ${err.message}`,
      });
    }
  }

  async handleSeriesEpisodeSelect(chatId, subjectId, season, episode, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      // If multiple audio dubs exist, show Language Selection step
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        const keyboard = [];
        let row = [];
        const defaultHindiIdx = details.dubs.findIndex((d) => d.isHindi);
        const preselectDubId = defaultHindiIdx !== -1 ? details.dubs[defaultHindiIdx].subjectId : details.dubs[0].subjectId;

        details.dubs.forEach((d) => {
          const isDef = d.subjectId === preselectDubId;
          const flag = d.isHindi ? "🇮🇳 " : "";
          const shortName = d.languageName.replace(/ dub$/i, "");
          row.push({
            text: `${isDef ? "⭐ " : ""}${flag}${shortName}${isDef ? " (Default)" : ""}`,
            callback_data: `step:lang:s:${subjectId}:${season}:${episode}:${d.subjectId}`,
          });
          if (row.length === 2) {
            keyboard.push(row);
            row = [];
          }
        });
        if (row.length > 0) keyboard.push(row);
        keyboard.push([{ text: "« Back to Episodes", callback_data: `step:back:ep:${subjectId}:${season}` }]);

        const promptText =
          `📺 *${title}* — *Season ${season} Episode ${episode}*\n\n` +
          `🔊 *Step 1/2: Select Audio Language / Dub:*`;

        if (origMsgId) {
          try {
            await this.callApi("editMessageText", {
              chat_id: chatId,
              message_id: origMsgId,
              text: promptText,
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            });
            return;
          } catch (_) {}
        }

        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: promptText,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
        return;
      }

      // Only 1 dub available -> proceed directly to Quality selection
      const targetDubId = (Array.isArray(details.dubs) && details.dubs[0]?.subjectId) || subjectId;
      await this.sendQualitySelector(chatId, "s", subjectId, season, episode, targetDubId, origMsgId);
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error fetching series episode: ${err.message}`,
      });
    }
  }

  // ============================================================
  // STEP 3: QUALITY (HEVC) SELECTOR
  // ============================================================

  async sendQualitySelector(chatId, type, subjectId, season, episode, dubId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;

      let chosenDubName = "Original / Hindi Audio";
      if (Array.isArray(details.dubs) && details.dubs.length > 0) {
        const found = details.dubs.find((d) => d.subjectId === dubId);
        if (found) {
          chosenDubName = `${found.isHindi ? "🇮🇳 " : ""}${found.languageName}`;
        }
      }

      const keyboard = [
        [
          {
            text: "⚡ Auto / Adaptive HEVC (Recommended)",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:auto`,
          },
        ],
        [
          {
            text: "✨ 1080p [FHD HEVC H.265]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:0`,
          },
          {
            text: "🎬 720p [HD HEVC H.265]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:1`,
          },
        ],
        [
          {
            text: "📱 480p [SD Data Saver]",
            callback_data: `step:play:${type}:${subjectId}:${season}:${episode}:${dubId}:2`,
          },
        ],
      ];

      // Back navigation button
      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        keyboard.push([
          {
            text: "« Back to Audio Language",
            callback_data: `step:back:lang:${type}:${subjectId}:${season}:${episode}`,
          },
        ]);
      } else if (type === "s") {
        keyboard.push([
          {
            text: "« Back to Episodes",
            callback_data: `step:back:ep:${subjectId}:${season}`,
          },
        ]);
      } else {
        keyboard.push([
          {
            text: "« Back to Main Menu",
            callback_data: "menu:start",
          },
        ]);
      }

      const headerTitle = type === "s"
        ? `📺 *${title}* — *Season ${season} Episode ${episode}*`
        : `🎬 *${title}* (${details.year || "N/A"})`;

      const promptText =
        `${headerTitle}\n` +
        `🔊 *Selected Audio:* ${chosenDubName}\n\n` +
        `⚙️ *Step 2/2: Select Video Quality (HEVC / H.265):*`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }

  // ============================================================
  // STEP 4: FINAL STREAM CARD & VIP GATING
  // ============================================================

  async sendFinalStreamPlayerCard(chatId, type, subjectId, season, episode, dubId, quality = "auto", origMsgId = null, userId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const isSeries = type === "s" || season > 0;

      let targetSubjectId = dubId || subjectId;
      let dubInfo = "Original / Hindi Audio";

      if (Array.isArray(details.dubs) && details.dubs.length > 0) {
        const found = details.dubs.find((d) => d.subjectId === targetSubjectId);
        if (found) {
          dubInfo = `${found.isHindi ? "🇮🇳 " : ""}${found.languageName}`;
        }
      }

      let streamInfo = await this.client.getStreams(targetSubjectId, season, episode);
      let streamUrl = "";

      if (streamInfo && streamInfo.streams && streamInfo.streams.length > 0) {
        const s = streamInfo.streams[0];
        streamUrl = s.streamUrl;
      } else if (targetSubjectId !== subjectId) {
        const origStream = await this.client.getStreams(subjectId, season, episode);
        if (origStream && origStream.streams && origStream.streams.length > 0) {
          const s = origStream.streams[0];
          streamUrl = s.streamUrl;
          dubInfo = "Original Audio";
          targetSubjectId = subjectId;
        }
      }

      if (!streamUrl) {
        const fallback = await MultiProvider.resolveAny(title, season, episode);
        if (fallback && fallback.streamUrl) {
          streamUrl = fallback.streamUrl;
        }
      }

      if (!streamUrl) {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: `❌ Stream not available for *${title}*.`,
          parse_mode: "Markdown",
        });
        return;
      }

      let qualityLabel = "Auto (Adaptive Multi-Bitrate HEVC)";
      if (quality === "0") qualityLabel = "1080p FHD HEVC (H.265)";
      else if (quality === "1") qualityLabel = "720p HD HEVC (H.265)";
      else if (quality === "2") qualityLabel = "480p SD HEVC (Data Saver)";

      const label = isSeries ? `${title} S${season}E${episode}` : title;
      const miniAppUrl = this.getMiniAppUrl(targetSubjectId, season, episode, quality, label, {
        year: details.year,
        rating: details.rating,
      });

      // Check User Authentication & VIP Subscription
      const auth = userId ? await this.ensureUserSession(userId) : null;
      let subInfo = { isVip: true, status: "ACTIVE" };

      if (auth) {
        subInfo = await checkUserSubscription(auth.accountId, auth.email);
        if (subInfo.isVip !== auth.isVip) {
          auth.isVip = subInfo.isVip;
          this.saveSessions();
        }
      }

      // Check for active Supabase Pre-roll Video Segment / Ad
      let prerollInfo = "";
      try {
        const preroll = await getActivePrerollAd();
        if (preroll && preroll.enabled && preroll.videoUrl) {
          prerollInfo = `📢 *Sponsored:* ${preroll.title}\n`;
        }
      } catch (_) {}

      const headerText = isSeries
        ? `📺 *${title}* — *Season ${season} Episode ${episode}*`
        : `🎬 *${title}* (${details.year || "N/A"})`;

      const text =
        `${headerText}\n\n` +
        `⭐ *Rating:* ${details.rating || "N/A"} | 🎞️ *Codec:* HEVC (H.265 / hev1)\n` +
        `🔊 *Audio:* ${dubInfo}\n` +
        `⚙️ *Quality:* ${qualityLabel}\n` +
        `📝 *Genres:* ${(details.genres || []).join(", ") || "General"}\n` +
        (prerollInfo ? `${prerollInfo}\n` : `\n`) +
        `⚡ *Tap below to watch in CineFlix OTT:*`;

      const keyboard = [
        [
          { text: "▶️ Watch in CineFlix OTT", web_app: { url: miniAppUrl } },
        ],
      ];

      const navRow = [
        { text: "⚙️ Change Quality", callback_data: `step:back:qual:${type}:${subjectId}:${season}:${episode}:${targetSubjectId}` },
      ];

      if (Array.isArray(details.dubs) && details.dubs.length > 1) {
        navRow.push({
          text: "🔊 Change Audio",
          callback_data: `step:back:lang:${type}:${subjectId}:${season}:${episode}`,
        });
      }

      keyboard.push(navRow);
      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      const fullMessage = text;

      if (origMsgId) {
        await this.callApi("deleteMessage", {
          chat_id: chatId,
          message_id: origMsgId,
        }).catch(() => {});
      }

      if (details.cover) {
        await this.callApi("sendPhoto", {
          chat_id: chatId,
          photo: details.cover,
          caption: fullMessage,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        }).catch(async () => {
          await this.callApi("sendMessage", {
            chat_id: chatId,
            text: fullMessage,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
        });
      } else {
        await this.callApi("sendMessage", {
          chat_id: chatId,
          text: fullMessage,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
      }
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Stream extraction error: ${err.message}`,
      });
    }
  }

  async sendSeriesSeasonSelector(chatId, subjectId, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const seasons = details.seasons || [];

      if (seasons.length === 0) {
        await this.sendSeriesEpisodeSelector(chatId, subjectId, 1, origMsgId);
        return;
      }

      const keyboard = [];
      let row = [];
      seasons.forEach((s) => {
        row.push({
          text: `Season ${s.se}`,
          callback_data: `se:${subjectId}:${s.se}`,
        });
        if (row.length === 3) {
          keyboard.push(row);
          row = [];
        }
      });
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "« Back to Main Menu", callback_data: "menu:start" }]);

      const promptText = `📺 *${title}*\nSelect a Season:`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }

  async sendSeriesEpisodeSelector(chatId, subjectId, season, origMsgId = null) {
    try {
      await this.client.ensureSession();
      const details = await this.client.getDetails(subjectId);
      const title = details.cleanTitle || details.title;
      const foundSeason = (details.seasons || []).find((s) => s.se === season);
      const totalEpisodes = foundSeason?.maxEp || 24;

      const keyboard = [];
      let row = [];
      for (let ep = 1; ep <= Math.min(totalEpisodes, 50); ep++) {
        row.push({
          text: `Ep ${ep}`,
          callback_data: `ep:${subjectId}:${season}:${ep}`,
        });
        if (row.length === 4) {
          keyboard.push(row);
          row = [];
        }
      }
      if (row.length > 0) keyboard.push(row);
      keyboard.push([{ text: "« Back to Seasons", callback_data: `step:back:season:${subjectId}` }]);

      const promptText = `📺 *${title}* — Season ${season}\nSelect an Episode:`;

      if (origMsgId) {
        try {
          await this.callApi("editMessageText", {
            chat_id: chatId,
            message_id: origMsgId,
            text: promptText,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
          return;
        } catch (_) {}
      }

      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: promptText,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err) {
      await this.callApi("sendMessage", {
        chat_id: chatId,
        text: `⚠️ Error: ${err.message}`,
      });
    }
  }
}

const botInstance = new MovieBoxTelegramBot();

module.exports = {
  MovieBoxTelegramBot,
  botInstance,
};
