const crypto = require("crypto");

/**
 * Supabase & CineFlix OTT User Authentication Service
 * 
 * Verifies user credentials against Supabase GoTrue Auth API (/auth/v1/token?grant_type=password)
 * Matches accounts created in the CineFlix OTT Android/iOS app.
 */

const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").trim();
const JWT_SECRET = process.env.APP_SECRET || "cineflix_secret_jwt_salt_2026";

// In-memory active user sessions: token -> { user, expiresAt }
const activeSessions = new Map();

function createSessionToken(user) {
  const payload = {
    sub: user.id || user.email || "user",
    email: user.email || "",
    role: user.role || "user",
    iat: Date.now(),
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
  };
  const str = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(str).digest("base64url");
  const token = `${str}.${signature}`;
  activeSessions.set(token, payload);
  return token;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [str, sig] = parts;
  const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(str).digest("base64url");
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(str, "base64url").toString("utf-8"));
    if (Date.now() > payload.exp) {
      activeSessions.delete(token);
      return null;
    }
    return payload;
  } catch (_) {
    return null;
  }
}

function getSessionFromReq(req) {
  // 1. From Query
  const queryToken = req.query.auth_token || req.query.token;
  if (queryToken) {
    const valid = verifySessionToken(queryToken);
    if (valid) return valid;
  }

  // 2. From Cookie
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader.match(/(?:^|;\s*)cineflix_session=([^;]+)/);
  if (match) {
    const valid = verifySessionToken(match[1]);
    if (valid) return valid;
  }

  // 3. From Authorization header
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const valid = verifySessionToken(authHeader.substring(7).trim());
    if (valid) return valid;
  }

  return null;
}

/**
 * Strict Authenticate against Supabase GoTrue Auth API & Database Records
 * Ensures deleted or non-existent accounts are rejected immediately.
 */
async function authenticateUser(identifier, password) {
  if (!identifier || !password) {
    return { success: false, error: "Please enter both Email/Username and Password" };
  }

  const cleanIdent = String(identifier).trim();
  const cleanPass = String(password).trim();

  // Supabase GoTrue Auth Check (Strict - No backdoor fallbacks)
  if (SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("placeholder")) {
    try {
      const emailToTry = cleanIdent.includes("@") ? cleanIdent.toLowerCase() : `${cleanIdent.toLowerCase()}@cineflix.com`;

      const supaRes = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: emailToTry,
          password: cleanPass,
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await supaRes.json();

      if (supaRes.ok && data.access_token && data.user) {
        const userId = data.user.id;
        const email = data.user.email || emailToTry;

        // Fetch name from public.profiles or user metadata
        let userName = data.user.user_metadata?.full_name || data.user.user_metadata?.name || "";
        if (!userName) {
          try {
            const pRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&limit=1`, {
              headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                Accept: "application/json",
              },
              signal: AbortSignal.timeout(4000),
            });
            if (pRes.ok) {
              const pList = await pRes.json();
              if (Array.isArray(pList) && pList.length > 0 && pList[0].name) {
                userName = pList[0].name;
              }
            }
          } catch (_) {}
        }
        if (!userName) userName = email.split("@")[0];

        // Ensure database row exists in public.subscription_requests
        const subInfo = await checkUserSubscription(userId, email);
        if (subInfo.status === "NONE" && !subInfo.raw) {
          try {
            await fetch(`${SUPABASE_URL}/rest/v1/subscription_requests`, {
              method: "POST",
              headers: {
                apikey: SUPABASE_ANON_KEY,
                Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({
                user_id: userId,
                user_email: email,
                user_name: userName,
                status: "free",
                plan_id: "free",
                created_at: new Date().toISOString(),
              }),
            });
          } catch (_) {}
        }

        const user = {
          id: userId,
          email: email,
          name: userName,
          role: data.user.role || "user",
        };
        const token = createSessionToken(user);
        return { success: true, user, token };
      }

      const rawErr = data.error_description || data.msg || data.message || "Invalid login credentials";
      const friendlyErr = rawErr.includes("Invalid login credentials") || rawErr.includes("invalid_grant")
        ? "❌ Invalid Email or Password. No matching account found."
        : rawErr;

      return {
        success: false,
        error: friendlyErr,
      };
    } catch (err) {
      console.error("[Supabase Auth Error]:", err.message);
      return { success: false, error: `Authentication server error: ${err.message}` };
    }
  }

  return {
    success: false,
    error: "Supabase authentication is not configured. Please set SUPABASE_URL and SUPABASE_ANON_KEY.",
  };
}

/**
 * VIP Subscription Plans (JioHotstar & Netflix style VIP tiers)
 */
const VIP_PLANS = [
  {
    id: "plan_trial_30d",
    title: "1-Month VIP All-Access Trial",
    price: 2,
    durationDays: 30,
    badge: "🔥 ALL UNLOCKED (MOVIES + LIVE) • ₹2",
    description: "30 Days Full VIP Access to Movies, Series & Live Cricket in 4K UHD",
  },
  {
    id: "plan_daily_live",
    title: "24-Hr Live TV Pass",
    price: 5,
    durationDays: 1,
    badge: "🏏 ONLY ₹5 • 24 HOURS ACCESS",
    description: "24 Hours Live Cricket & Sports Channels • HD 1080p Streaming",
  },
  {
    id: "plan_3m",
    title: "3 Months VIP Pass",
    price: 49,
    durationDays: 90,
    badge: "POPULAR • SAVE 70%",
    description: "Quarterly Full VIP (₹16/mo) • All OTT Releases + 4K Streams + Live TV.",
  },
  {
    id: "plan_12m",
    title: "12 Months VIP Ultra",
    price: 99,
    durationDays: 365,
    badge: "BEST VALUE • 1 YEAR",
    description: "Annual VIP membership (₹8.2/mo) • Unlimited 4K Ultra HD & Live Cricket.",
  },
];

/**
 * Register a new user in Supabase GoTrue Auth
 * Automatically triggers verification email to user's Gmail
 */
async function registerUser(fullName, email, password) {
  if (!email || !password) {
    return { success: false, error: "Please provide both Email and Password" };
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanPassword = String(password).trim();
  const cleanName = String(fullName || cleanEmail.split("@")[0]).trim();

  if (cleanPassword.length < 6) {
    return { success: false, error: "Password must be at least 6 characters long." };
  }

  if (SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("placeholder")) {
    try {
      const supaRes = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
        method: "POST",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: cleanEmail,
          password: cleanPassword,
          data: {
            full_name: cleanName,
            name: cleanName,
          },
        }),
        signal: AbortSignal.timeout(10000),
      });

      const data = await supaRes.json().catch(() => ({}));

      if (supaRes.ok && data.user) {
        const user = {
          id: data.user.id || cleanEmail,
          email: data.user.email || cleanEmail,
          name: cleanName,
          role: "user",
        };

        // Create active record in public.profiles and subscription_requests
        try {
          await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify({
              id: user.id,
              name: cleanName,
              email: cleanEmail,
              created_at: new Date().toISOString(),
            }),
          });
        } catch (_) {}

        return {
          success: true,
          user,
          requiresEmailVerification: !data.session,
          message: data.session
            ? "Account created successfully!"
            : "Verification link sent to your Gmail! Please check your inbox or spam folder to confirm.",
        };
      }

      // Handle case where user is already registered in auth.users
      const rawMsg = data.error_description || data.msg || data.message || data.error || "";
      if (
        rawMsg.toLowerCase().includes("already registered") ||
        rawMsg.toLowerCase().includes("already exists") ||
        rawMsg.toLowerCase().includes("email_exists") ||
        supaRes.status === 400 ||
        supaRes.status === 422
      ) {
        // Try validating if password matches existing account
        try {
          const authAttempt = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
            method: "POST",
            headers: {
              apikey: SUPABASE_ANON_KEY,
              Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              email: cleanEmail,
              password: cleanPassword,
            }),
            signal: AbortSignal.timeout(8000),
          });

          const authData = await authAttempt.json().catch(() => ({}));
          if (authAttempt.ok && authData.access_token && authData.user) {
            const user = {
              id: authData.user.id || cleanEmail,
              email: authData.user.email || cleanEmail,
              name: cleanName,
              role: "user",
            };

            return {
              success: true,
              user,
              message: "Account verified & logged in successfully! Welcome back.",
            };
          }
        } catch (_) {}

        return {
          success: false,
          error: `⚠️ \`${cleanEmail}\` is already registered in CineFlix.\nPlease tap **Sign In** with your password or use another email.`,
        };
      }

      return {
        success: false,
        error: rawMsg || "Failed to create account. Please try again.",
      };
    } catch (err) {
      return { success: false, error: `Signup server error: ${err.message}` };
    }
  }

  const user = { id: cleanEmail, email: cleanEmail, name: cleanName, role: "user" };
  return { success: true, user, message: "Account created successfully!" };
}

function parseSubscriptionRow(row) {
  if (!row) return null;
  const status = String(row.status || "").toLowerCase().trim();
  const planId = row.plan_id;
  const plan = VIP_PLANS.find((p) => p.id === planId) || VIP_PLANS[0];

  const isApproved =
    status === "approved" ||
    status === "active" ||
    status === "completed" ||
    status === "paid" ||
    status === "success" ||
    row.is_active === true ||
    row.is_vip === true;

  if (isApproved) {
    const createdAtMs = new Date(row.created_at || Date.now()).getTime();
    const durationMs = (plan.durationDays || 30) * 24 * 60 * 60 * 1000;
    const expiryMs = row.expires_at ? new Date(row.expires_at).getTime() : createdAtMs + durationMs;

    const isExpired = Date.now() > expiryMs;
    return {
      isVip: !isExpired,
      status: isExpired ? "EXPIRED" : "ACTIVE",
      plan,
      expiryDate: new Date(expiryMs).toISOString().split("T")[0],
      raw: row,
    };
  } else if (status === "pending") {
    return { isVip: false, status: "PENDING", plan, message: "Payment verification pending admin approval." };
  } else if (status === "rejected") {
    return { isVip: false, status: "REJECTED", plan, message: "Payment was rejected." };
  }
  return null;
}

/**
 * Check if a user has an active VIP subscription in Supabase database
 * Checks multiple tables (subscription_requests, profiles, subscriptions)
 */
async function checkUserSubscription(userId, email) {
  if (!userId && !email) {
    return { isVip: false, status: "NONE", plan: null };
  }

  const uid = userId ? String(userId).trim() : "";
  const cleanEmail = email ? String(email).trim().toLowerCase() : "";

  if (uid === "admin" || cleanEmail === "admin@cineflix.app") {
    return { isVip: true, status: "ACTIVE", plan: VIP_PLANS[3], expiryDate: "Lifetime Admin VIP" };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("placeholder")) {
    return { isVip: false, status: "NONE", plan: null };
  }

  const authHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: "application/json",
  };

  try {
    // 1. Check in public.subscription_requests by user_email
    if (cleanEmail) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/subscription_requests?user_email=eq.${encodeURIComponent(cleanEmail)}&order=created_at.desc&limit=1`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const sub = parseSubscriptionRow(rows[0]);
            if (sub) return sub;
          }
        }
      } catch (_) {}

      // Fallback query if column is named email
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/subscription_requests?email=eq.${encodeURIComponent(cleanEmail)}&order=created_at.desc&limit=1`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(4000),
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const sub = parseSubscriptionRow(rows[0]);
            if (sub) return sub;
          }
        }
      } catch (_) {}
    }

    // 2. Check in public.subscription_requests by user_id
    if (uid) {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/subscription_requests?user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const sub = parseSubscriptionRow(rows[0]);
            if (sub) return sub;
          }
        }
      } catch (_) {}
    }

    // 3. Check in public.profiles table
    const profileUrls = [];
    if (cleanEmail) profileUrls.push(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(cleanEmail)}&limit=1`);
    if (uid) profileUrls.push(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&limit=1`);

    for (const pUrl of profileUrls) {
      try {
        const profRes = await fetch(pUrl, { headers: authHeaders, signal: AbortSignal.timeout(4000) });
        if (profRes.ok) {
          const profRows = await profRes.json();
          if (Array.isArray(profRows) && profRows.length > 0) {
            const prof = profRows[0];
            const isVip =
              prof.is_vip === true ||
              prof.role === "vip" ||
              prof.role === "admin" ||
              String(prof.subscription_status || "").toLowerCase() === "active" ||
              String(prof.status || "").toLowerCase() === "active" ||
              String(prof.status || "").toLowerCase() === "approved";

            if (isVip) {
              const planId = prof.plan_id || prof.plan || "plan_1m";
              const plan = VIP_PLANS.find((p) => p.id === planId) || VIP_PLANS[0];
              const expiryDate = prof.vip_expires_at || prof.expires_at || "";
              return {
                isVip: true,
                status: "ACTIVE",
                plan,
                expiryDate: expiryDate ? new Date(expiryDate).toISOString().split("T")[0] : "Active VIP",
                raw: prof,
              };
            }
          }
        }
      } catch (_) {}
    }

    // 4. Check in public.subscriptions table (if present)
    if (cleanEmail || uid) {
      const subUrl = cleanEmail
        ? `${SUPABASE_URL}/rest/v1/subscriptions?user_email=eq.${encodeURIComponent(cleanEmail)}&order=created_at.desc&limit=1`
        : `${SUPABASE_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1`;
      try {
        const subRes = await fetch(subUrl, { headers: authHeaders, signal: AbortSignal.timeout(4000) });
        if (subRes.ok) {
          const subRows = await subRes.json();
          if (Array.isArray(subRows) && subRows.length > 0) {
            const sub = parseSubscriptionRow(subRows[0]);
            if (sub) return sub;
          }
        }
      } catch (_) {}
    }
  } catch (err) {
    console.warn("⚠️ [Supabase] Subscription check note:", err.message);
  }

  return { isVip: false, status: "NONE", plan: null };
}

/**
 * Automatically resolve user by their Telegram ID or Email from Supabase.
 * Checks `subscription_requests`, `profiles` and user tables.
 * Returns { found: false } when Supabase confirms the user data was deleted / does not exist.
 */
async function resolveTelegramUser(userId, username = "", emailToCheck = "") {
  if (!userId && !emailToCheck) return { found: false };
  const uid = userId ? String(userId).trim() : "";
  const email = emailToCheck ? String(emailToCheck).trim().toLowerCase() : "";

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("placeholder")) {
    return { found: false };
  }

  const authHeaders = {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    Accept: "application/json",
  };

  try {
    // 1. Check in `public.subscription_requests` table
    const subUrls = [];
    if (email) {
      subUrls.push(`${SUPABASE_URL}/rest/v1/subscription_requests?user_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`);
    }
    if (uid) {
      subUrls.push(`${SUPABASE_URL}/rest/v1/subscription_requests?user_id=eq.${encodeURIComponent(uid)}&order=created_at.desc&limit=1`);
    }

    for (const subUrl of subUrls) {
      try {
        const subRes = await fetch(subUrl, { headers: authHeaders, signal: AbortSignal.timeout(4000) });
        if (subRes.ok) {
          const rows = await subRes.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const row = rows[0];
            const userEmail = row.user_email || row.email || email || (username ? `${username}@t.me` : `tg_${uid}@cineflix.app`);
            const name = row.user_name || row.name || username || `User ${uid.slice(-4)}`;
            const subParsed = parseSubscriptionRow(row);
            const isVip = !!subParsed?.isVip;

            return {
              found: true,
              user: {
                id: row.user_id || uid,
                email: userEmail,
                name: name,
              },
              isVip,
              plan: subParsed?.plan || VIP_PLANS[0],
              status: isVip ? "ACTIVE" : String(row.status || "FREE").toUpperCase(),
              expiryDate: subParsed?.expiryDate || "",
            };
          }
        }
      } catch (_) {}
    }

    // 2. Check in `public.profiles` table
    const profUrls = [];
    if (email) profUrls.push(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(email)}&limit=1`);
    if (uid) profUrls.push(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(uid)}&limit=1`);

    for (const profUrl of profUrls) {
      try {
        const profRes = await fetch(profUrl, { headers: authHeaders, signal: AbortSignal.timeout(4000) });
        if (profRes.ok) {
          const profRows = await profRes.json();
          if (Array.isArray(profRows) && profRows.length > 0) {
            const prof = profRows[0];
            const userEmail = prof.email || email || (username ? `${username}@t.me` : `tg_${uid}@cineflix.app`);
            const name = prof.full_name || prof.name || username || "CineFlix Member";
            const isVip =
              prof.is_vip === true ||
              prof.role === "vip" ||
              prof.role === "admin" ||
              String(prof.subscription_status || "").toLowerCase() === "active" ||
              String(prof.status || "").toLowerCase() === "active" ||
              String(prof.status || "").toLowerCase() === "approved";

            return {
              found: true,
              user: { id: prof.id || uid, email: userEmail, name },
              isVip,
              plan: isVip ? VIP_PLANS[0] : null,
              status: isVip ? "ACTIVE" : "FREE",
              expiryDate: prof.vip_expires_at ? new Date(prof.vip_expires_at).toISOString().split("T")[0] : "",
            };
          }
        }
      } catch (_) {}
    }

    return { found: false };
  } catch (err) {
    console.warn("⚠️ [Supabase] Telegram user auto-resolve note:", err.message);
  }
  return { found: false };
}

/**
 * Modern Netflix / CineFlix Dark Themed Login HTML Page
 */
function renderLoginPageHtml(redirectUrl = "/", errorMessage = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CineFlix OTT — Login to Stream</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at center, #1e1022 0%, #08060b 100%);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .login-card {
      background: rgba(18, 14, 24, 0.85);
      backdrop-filter: blur(16px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 20px;
      padding: 40px 32px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 30px 60px rgba(0, 0, 0, 0.7);
      text-align: center;
    }
    .brand {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      font-size: 26px;
      font-weight: 900;
      letter-spacing: -0.5px;
      color: #fff;
      margin-bottom: 6px;
    }
    .brand span {
      color: #e50914;
    }
    .subtitle {
      font-size: 14px;
      color: #9ca3af;
      margin-bottom: 24px;
    }
    .alert-error {
      background: rgba(239, 68, 68, 0.15);
      border: 1px solid rgba(239, 68, 68, 0.3);
      color: #f87171;
      padding: 12px;
      border-radius: 10px;
      font-size: 13px;
      margin-bottom: 20px;
      display: ${errorMessage ? "block" : "none"};
      text-align: left;
    }
    .form-group {
      margin-bottom: 18px;
      text-align: left;
    }
    label {
      display: block;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #9ca3af;
      margin-bottom: 8px;
    }
    input {
      width: 100%;
      padding: 14px 16px;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 10px;
      color: #fff;
      font-size: 15px;
      outline: none;
      transition: all 0.2s ease;
    }
    input:focus {
      border-color: #e50914;
      background: rgba(255, 255, 255, 0.08);
      box-shadow: 0 0 0 3px rgba(229, 9, 20, 0.2);
    }
    .btn-submit {
      width: 100%;
      padding: 15px;
      background: linear-gradient(135deg, #e50914, #b91c1c);
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      margin-top: 10px;
      transition: transform 0.1s ease, box-shadow 0.2s ease;
      box-shadow: 0 8px 24px rgba(229, 9, 20, 0.35);
    }
    .btn-submit:hover {
      box-shadow: 0 10px 30px rgba(229, 9, 20, 0.5);
    }
    .btn-submit:active {
      transform: scale(0.98);
    }
    .footer-note {
      font-size: 12px;
      color: #6b7280;
      margin-top: 24px;
      line-height: 1.5;
    }
    .footer-note b {
      color: #9ca3af;
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="brand">🎬 Cine<span>Flix</span> OTT</div>
    <div class="subtitle">Enter your CineFlix account to watch stream</div>

    <div class="alert-error" id="errorMsg">${errorMessage}</div>

    <form id="loginForm" method="POST" action="/auth/login">
      <input type="hidden" name="redirect" value="${encodeURIComponent(redirectUrl)}">
      
      <div class="form-group">
        <label for="username">Email or App Username</label>
        <input type="text" id="username" name="username" placeholder="user@gmail.com or username" required autofocus autocomplete="username">
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" placeholder="Enter your password" required autocomplete="current-password">
      </div>

      <button type="submit" class="btn-submit" id="submitBtn">Sign In to Stream</button>
    </form>

    <div class="footer-note">
      🔒 Protected by <b>CineFlix Supabase Auth</b>.<br>
      Same account works on Android App, Web & VLC Player.
    </div>
  </div>

  <script>
    const form = document.getElementById("loginForm");
    const errBox = document.getElementById("errorMsg");
    const submitBtn = document.getElementById("submitBtn");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.style.display = "none";
      submitBtn.innerText = "Verifying...";
      submitBtn.disabled = true;

      const username = document.getElementById("username").value.trim();
      const password = document.getElementById("password").value;
      const redirect = "${encodeURIComponent(redirectUrl)}";

      try {
        const res = await fetch("/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username, password, redirect: decodeURIComponent(redirect) })
        });
        const data = await res.json();
        if (data.success) {
          window.location.href = data.redirect || decodeURIComponent(redirect) || "/";
        } else {
          errBox.innerText = data.error || "Login failed";
          errBox.style.display = "block";
          submitBtn.innerText = "Sign In to Stream";
          submitBtn.disabled = false;
        }
      } catch (err) {
        errBox.innerText = "Network error: " + err.message;
        errBox.style.display = "block";
        submitBtn.innerText = "Sign In to Stream";
        submitBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

let cachedPreroll = null;
let lastPrerollFetch = 0;
const PREROLL_CACHE_TTL = 30000; // 30 seconds cache

/**
 * Fetches active pre-roll video ad / segment file configured in Supabase.
 * If no segment is configured in Supabase, returns { enabled: false, videoUrl: null }
 * so the movie starts directly without any delay.
 */
async function getActivePrerollAd() {
  const now = Date.now();
  if (cachedPreroll !== null && now - lastPrerollFetch < PREROLL_CACHE_TTL) {
    return cachedPreroll;
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("placeholder")) {
    return { enabled: false, videoUrl: null };
  }

  try {
    // 1. Try querying `public.preroll_ads` table
    const res = await fetch(`${SUPABASE_URL}/rest/v1/preroll_ads?is_active=eq.true&order=created_at.desc&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (res.ok) {
      const list = await res.json();
      if (Array.isArray(list) && list.length > 0) {
        const item = list[0];
        const videoUrl = item.video_url || item.segment_url || item.url || "";
        if (videoUrl && (videoUrl.startsWith("http://") || videoUrl.startsWith("https://"))) {
          cachedPreroll = {
            enabled: true,
            id: item.id || "preroll_1",
            title: item.title || "CineFlix Promo",
            videoUrl: videoUrl,
            skipAfterSec: item.skip_after_sec !== undefined ? Number(item.skip_after_sec) : 5,
            duration: item.duration || 0,
          };
          lastPrerollFetch = now;
          return cachedPreroll;
        }
      }
    }

    // 2. Fallback: Try querying `public.app_config` table
    const configRes = await fetch(`${SUPABASE_URL}/rest/v1/app_config?key=eq.preroll_ad&select=*`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });

    if (configRes.ok) {
      const configList = await configRes.json();
      if (Array.isArray(configList) && configList.length > 0) {
        const row = configList[0];
        const val = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        if (val && (val.enabled === true || val.is_active === true) && val.videoUrl) {
          cachedPreroll = {
            enabled: true,
            id: "config_preroll",
            title: val.title || "Sponsored",
            videoUrl: val.videoUrl,
            skipAfterSec: val.skipAfterSec !== undefined ? Number(val.skipAfterSec) : 5,
          };
          lastPrerollFetch = now;
          return cachedPreroll;
        }
      }
    }
  } catch (err) {
    console.warn("⚠️ [Supabase] Preroll check note:", err.message);
  }

  cachedPreroll = { enabled: false, videoUrl: null };
  lastPrerollFetch = now;
  return cachedPreroll;
}

/**
 * Fetches active live cricket & sports channels dynamically from Supabase `public.live_channels` table.
 * Matches channels controlled in the Android OTT app.
 */
async function getSupabaseLiveChannels() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY && !SUPABASE_URL.includes("placeholder")) {
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/live_channels?is_active=eq.true&order=sort_order.asc`, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(6000),
      });

      if (res.ok) {
        const list = await res.json();
        if (Array.isArray(list)) {
          return list.map((item) => ({
            id: item.id || `live_${item.sort_order || 1}`,
            title: item.title || "Live Sports",
            streamUrl: item.stream_url || "",
            teleCdn: item.tele_cdn || "",
            referer: item.referer || "https://sportslive.wine/",
            poster: item.poster_url || "",
            category: item.category || "Live Sports",
            language: item.language || "Hindi",
            quality: item.quality || "1080p",
            plot: item.plot || "",
          }));
        }
      }
    } catch (err) {
      console.warn("⚠️ [Supabase] live_channels query note:", err.message);
    }
  }

  return [];
}

/**
 * Check if an email is already registered in Supabase
 */
async function checkEmailExists(email) {
  if (!email || !SUPABASE_URL || !SUPABASE_ANON_KEY || SUPABASE_URL.includes("placeholder")) {
    return false;
  }
  const cleanEmail = String(email).trim().toLowerCase();
  try {
    // 1. Check in public.profiles table
    const profRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?email=eq.${encodeURIComponent(cleanEmail)}&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (profRes.ok) {
      const profs = await profRes.json();
      if (Array.isArray(profs) && profs.length > 0) {
        return true;
      }
    }

    // 2. Check in public.subscription_requests table
    const subRes = await fetch(`${SUPABASE_URL}/rest/v1/subscription_requests?user_email=eq.${encodeURIComponent(cleanEmail)}&limit=1`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(4000),
    });
    if (subRes.ok) {
      const subs = await subRes.json();
      if (Array.isArray(subs) && subs.length > 0) {
        return true;
      }
    }
  } catch (err) {
    console.warn("⚠️ [Supabase] checkEmailExists note:", err.message);
  }
  return false;
}

module.exports = {
  authenticateUser,
  registerUser,
  checkEmailExists,
  checkUserSubscription,
  resolveTelegramUser,
  getActivePrerollAd,
  getSupabaseLiveChannels,
  VIP_PLANS,
  createSessionToken,
  verifySessionToken,
  getSessionFromReq,
  renderLoginPageHtml,
};
