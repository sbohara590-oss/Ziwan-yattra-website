import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const app = express();app.use(express.static(path.join(__dirname, "public")));
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 3000;
const enquiriesFile = path.join(__dirname, "enquiries.json");

const rawSupabaseUrl = process.env.SUPABASE_URL?.trim();
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

if (!rawSupabaseUrl || !supabaseKey) {
  console.error(
    "Missing SUPABASE_URL or SUPABASE_PUBLISHABLE_KEY in backend/.env"
  );
  process.exit(1);
}

// Yeh naya code automatically base URL nikal lega, chahe tumne galti se
// /rest/v1/ ya kuch aur extra laga diya ho.
let supabaseUrl;
try {
  const parsedUrl = new URL(rawSupabaseUrl);
  supabaseUrl = parsedUrl.origin; 
  console.log("✅ DEBUG: Final Supabase URL is:", supabaseUrl);
} catch (error) {
  console.error("❌ Supabase URL configuration error:", error.message);
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);
const adminSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();

if (!adminSecretKey) {
  console.error("Missing SUPABASE_SECRET_KEY in backend/.env");
  process.exit(1);
}

const adminSupabase = createClient(supabaseUrl, adminSecretKey);
// ===== FIREBASE PUSH NOTIFICATIONS =====
const firebaseAdmin = require("firebase-admin");

const serviceAccountPath =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  "/etc/secrets/firebase-service-account.json";

const serviceAccount = JSON.parse(
  fs.readFileSync(serviceAccountPath, "utf8")
);

if (!firebaseAdmin.apps.length) {
  firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccount)
  });
}

const firebaseMessaging = firebaseAdmin.messaging();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10kb" }));

const allowedOrigins = new Set([
    'https://sbohara590-oss.github.io',
    "https://ziwanyattra.com",
    "https://www.ziwanyattra.com",
    'http://127.0.0.1:5500',
    'http://localhost:5500',
    'http://127.0.0.1:5501',
    'http://localhost:5501',
    'http://localhost:3000'
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({
      success: false,
      error: "Origin not allowed."
    });
  }

  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use("/api", rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: {
    success: false,
    error: "Too many requests. Please try again later."
  }
}));

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ZIWAN YATTRA backend is running."
  });
});
// Save browser push subscription
app.post("/api/push/subscribe", async (req, res) => {
  const token = req.body?.token;

  if (typeof token !== "string" || token.length < 50 || token.length > 4096) {
    return res.status(400).json({
      success: false,
      error: "Invalid notification token."
    });
  }

  try {
    const { error } = await adminSupabase
      .from("push_subscriptions")
      .upsert({ token }, { onConflict: "token" });

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error("Push subscription error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Could not save notification subscription."
    });
  }
});

app.post("/api/enquiries", async (req, res) => {
  const { category, helpType, details, email = "" } = req.body || {};

  if (
    typeof category !== "string" ||
    !category.trim() ||
    typeof helpType !== "string" ||
    !helpType.trim() ||
    typeof details !== "string" ||
    !details.trim()
  ) {
    return res.status(400).json({
      success: false,
      error: "Category, type of help, and requirements are required."
    });
  }

  if (
    category.length > 100 ||
    helpType.length > 100 ||
    details.length > 3000 ||
    typeof email !== "string" ||
    email.length > 254
  ) {
    return res.status(400).json({
      success: false,
      error: "One or more fields are too long or invalid."
    });
  }

  const enquiry = {
  "Category": category.trim(),
  "Help type": helpType.trim(),
  "Details": details.trim(),
  "Email": email.trim()
};

  try {
    const { error } = await supabase
      .from("enquiries")
      .insert(enquiry);

    if (error) {
      console.error("SUPABASE INSERT ERROR:", {
        code: error.code,
        message: error.message,
        details: error.details,
        hint: error.hint
      });

      return res.status(500).json({
        success: false,
        error: "Supabase could not save the enquiry.",
        code: error.code || "SUPABASE_ERROR"
      });
    }

    // Local backup is best-effort; Supabase is the primary database.
    try {
      let entries = [];

      if (fs.existsSync(enquiriesFile)) {
        const saved = JSON.parse(
          fs.readFileSync(enquiriesFile, "utf8")
        );

        if (Array.isArray(saved)) {
          entries = saved;
        }
      }

      entries.push({
        ...enquiry,
        saved_at: new Date().toISOString()
      });

      fs.writeFileSync(
        enquiriesFile,
        JSON.stringify(entries, null, 2),
        "utf8"
      );
    } catch (backupError) {
      console.error("Local backup failed:", backupError.message);
    }

    return res.status(201).json({
      success: true,
      message: "Enquiry saved successfully."
    });
  } catch (error) {
    console.error("Unexpected enquiry error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Server error while saving enquiry."
    });
  }
});
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({
    exp: Date.now() + 2 * 60 * 60 * 1000
  })).toString("base64url");

  const signature = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  return `${payload}.${signature}`;
}

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const parts = token.split(".");

  if (parts.length !== 2) {
    return res.status(401).json({
      success: false,
      error: "Please log in."
    });
  }

  const [payload, signature] = parts;
  const expected = crypto
    .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
    .update(payload)
    .digest("base64url");

  if (!safeEqual(signature, expected)) {
    return res.status(401).json({
      success: false,
      error: "Invalid session."
    });
  }

  try {
    const data = JSON.parse(
      Buffer.from(payload, "base64url").toString()
    );

    if (!Number.isFinite(data.exp) || data.exp < Date.now()) {
      return res.status(401).json({
        success: false,
        error: "Session expired."
      });
    }
  } catch {
    return res.status(401).json({
      success: false,
      error: "Invalid session."
    });
  }

  next();
}

app.post("/api/admin/login", (req, res) => {
  const password = req.body?.password;

  if (!safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({
      success: false,
      error: "Incorrect password."
    });
  }

  return res.json({
    success: true,
    token: createAdminToken()
  });
});

app.post("/api/admin/posts", requireAdmin, async (req, res) => {
  const {
    title,
    category,
    description,
    content,
    image_url = "",
    internal_links = [],
    seo_title = "",
    meta_description = "",
    focus_keywords = "",
    seo_slug = "",
    status = "draft"
  } = req.body || {};

  const categories = [
    "News",
    "National",
    "International",
    "Local",
    "Sports",
    "Gaming",
    "Entertainment"
  ];

  if (
    typeof title !== "string" || !title.trim() || title.trim().length > 180 ||
    !categories.includes(category) ||
    typeof description !== "string" || !description.trim() || description.trim().length > 500 ||
    typeof content !== "string" || !content.trim() ||
    typeof image_url !== "string" || image_url.length > 2000 ||
    !Array.isArray(internal_links) ||
    !internal_links.every(x => typeof x === "string" && x.length <= 500) ||
    typeof seo_title !== "string" || seo_title.length > 180 ||
    typeof meta_description !== "string" || meta_description.length > 300 ||
    typeof focus_keywords !== "string" || focus_keywords.length > 500 ||
    typeof seo_slug !== "string" || seo_slug.length > 180 ||
    !["draft", "published"].includes(status)
  ) {
    return res.status(400).json({
      success: false,
      error: "Please check all post and SEO fields."
    });
  }

  const makeSlug = value => value.trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);

  const slug = seo_slug.trim() ? makeSlug(seo_slug) : makeSlug(title);

  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    return res.status(400).json({
      success: false,
      error: "Invalid SEO URL slug. Use lowercase letters, numbers and hyphens."
    });
  }

  try {
    const now = new Date().toISOString();

    const { data, error } = await adminSupabase
      .from("daily_posts")
      .insert({
        title: title.trim(),
        slug,
        category,
        description: description.trim(),
        content: content.trim(),
        image_url: image_url.trim(),
        internal_links,
        seo_title: seo_title.trim(),
        meta_description: meta_description.trim(),
        focus_keywords: focus_keywords.trim(),
        status,
        updated_at: now,
        published_at: status === "published" ? now : null
      })
      .select()
      .single();

    if (error) {
      console.error("Admin post insert error:", error.code, error.message);
      return res.status(500).json({
        success: false,
        error: error.code === "23505"
          ? "This URL slug already exists. Please choose another SEO URL slug."
          : "Could not save the post. Check server logs and database settings."
      });
    }

    // ===== SEND PUSH NOTIFICATION AFTER PUBLISH =====
    if (status === "published") {
      try {
        const { data: subscribers, error: tokenError } = await adminSupabase
          .from("push_subscriptions")
          .select("token");

        if (tokenError) throw tokenError;

        const tokens = (subscribers || []).map(item => item.token).filter(Boolean);

        for (let i = 0; i < tokens.length; i += 500) {
          const batch = tokens.slice(i, i + 500);
          const result = await firebaseMessaging.sendEachForMulticast({
            tokens: batch,
            notification: {
              title: "ZIWAN YATTRA",
              body: title.trim()
            },
            data: {
              title: "ZIWAN YATTRA",
              body: title.trim(),
              url: `https://ziwanyattra.com/article.html?slug=${slug}`
            }
          });

          const invalidTokens = [];
          result.responses.forEach((response, index) => {
            if (
              !response.success &&
              [
                "messaging/registration-token-not-registered",
                "messaging/invalid-registration-token"
              ].includes(response.error?.code)
            ) {
              invalidTokens.push(batch[index]);
            }
          });

          if (invalidTokens.length) {
            await adminSupabase
              .from("push_subscriptions")
              .delete()
              .in("token", invalidTokens);
          }
        }

        console.log("ZIWAN YATTRA push notification completed.");
      } catch (pushError) {
        console.error("Push notification error:", pushError.message);
      }
    }

    return res.status(201).json({ success: true, post: data });
  } catch (error) {
    console.error("Admin post error:", error.message);
    return res.status(500).json({ success: false, error: "Server error." });
  }
});

// Daily Updates: fetch published posts with view counts
app.get("/api/daily-posts", async (req, res) => {
  try {
    const { data: posts, error: postsError } = await supabase
      .from("daily_posts")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (postsError) throw postsError;

    const postRows = posts || [];
    const postIds = postRows
      .map(post => post.id)
      .filter(id => id !== null && id !== undefined);

    let statsRows = [];

    if (postIds.length > 0) {
      const { data: stats, error: statsError } = await adminSupabase
        .from("daily_post_stats")
        .select("post_id, views")
        .in("post_id", postIds);

      if (statsError) throw statsError;
      statsRows = stats || [];
    }

    const viewsByPostId = new Map(
      statsRows.map(row => [
        String(row.post_id),
        Number(row.views) || 0
      ])
    );

    const updatedPosts = postRows.map(post => ({
      ...post,
      views: viewsByPostId.get(String(post.id)) || 0
    }));

    return res.json({
      success: true,
      posts: updatedPosts
    });

  } catch (error) {
    console.error("Daily posts fetch error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Could not load daily posts."
    });
  }
});

// ===== ZIWAN YATTRA DYNAMIC NEWS SITEMAP =====
app.get("/sitemap.xml", async (req, res) => {
  try {
    const { data: posts, error } = await supabase
      .from("daily_posts")
      .select("slug, updated_at, published_at, created_at")
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const staticUrls = [
      "https://ziwanyattra.com/",
      "https://ziwanyattra.com/daily-updates.html",
      "https://ziwanyattra.com/article.html",
      "https://ziwanyattra.com/daily-tools.html",
      "https://ziwanyattra.com/mobile-help.html",
      "https://ziwanyattra.com/creator-services.html",
      "https://ziwanyattra.com/ai-knowledge.html",
      "https://ziwanyattra.com/privacy-policy.html",
      "https://ziwanyattra.com/technician.html",
      "https://ziwanyattra.com/gaming.html",
      "https://ziwanyattra.com/education.html",
      "https://ziwanyattra.com/government-services.html",
      "https://ziwanyattra.com/shopping.html",
      "https://ziwanyattra.com/ziwan-yattra-rewards-promo-1.html",
      "https://ziwanyattra.com/ZIWAN-YATTRA-Computer-Tech-Book-Language-Fix.html"
    ];

    const escapeXml = (value) =>
      String(value).replace(/[<>&"']/g, (char) => ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;"
      })[char]);

    const staticXml = staticUrls.map((url) =>
      `<url><loc>${escapeXml(url)}</loc></url>`
    ).join("");

    const articleXml = (posts || [])
      .filter((post) => post.slug)
      .map((post) => {
        const url = `https://ziwanyattra.com/article.html?slug=${encodeURIComponent(post.slug)}`;
        const date = post.updated_at || post.published_at || post.created_at;
        const lastmod = date && !Number.isNaN(Date.parse(date))
          ? `<lastmod>${new Date(date).toISOString().slice(0, 10)}</lastmod>`
          : "";

        return `<url><loc>${escapeXml(url)}</loc>${lastmod}</url>`;
      }).join("");

    res.type("application/xml").send(
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
      staticXml + articleXml + `</urlset>`
    );
  } catch (error) {
    console.error("Sitemap error:", error.message);
    res.status(500).type("text/plain").send("Could not generate sitemap.");
  }
});
// ===== END NEWS SITEMAP =====
// ===== REQUEST ERROR HANDLER =====
app.use((error, req, res, next) => {
  console.error("Request error:", error.message);

  if (res.headersSent) {
    return next(error);
  }

  res.status(400).json({
    success: false,
    error: "Invalid request."
  });
});

app.get("/share/:slug", async (req, res) => {
  const slug = String(req.params.slug || "").trim();

  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/i.test(slug)) {
    return res.status(400).send("Invalid article link.");
  }

  try {
    const { data: post, error } = await adminSupabase
      .from("daily_posts")
      .select("title, slug, description, content, image_url, status, seo_title, meta_description, focus_keywords")
      .eq("slug", slug)
      .eq("status", "published")
      .maybeSingle();

    if (error) throw error;
    if (!post) return res.status(404).send("Article not found.");

    const esc = (value) =>
      String(value ?? "").replace(/[&<>"']/g, (c) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      })[c]);

    const title = String(post.seo_title || post.title || "Latest News").trim();
    const description = String(
      post.meta_description || post.description || post.content || "Read the latest news on ZIWAN YATTRA."
    ).replace(/\s+/g, " ").trim().slice(0, 300);

    const articleUrl =
      "https://ziwanyattra.com/article.html?slug=" +
      encodeURIComponent(post.slug);

    const shareUrl =
      "https://ziwan-yattra-backend.onrender.com/share/" +
      encodeURIComponent(post.slug);

    let imageUrl = "https://ziwanyattra.com/icons/icon-512.png";

    if (post.image_url) {
      try {
        const image = new URL(post.image_url);
        if (image.protocol === "https:" || image.protocol === "http:") {
          imageUrl = image.href;
        }
      } catch (e) {
        console.error("Invalid article image URL:", e.message);
      }
    }

    res.set("Cache-Control", "public, max-age=300");
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} | ZIWAN YATTRA</title>
<meta name="description" content="${esc(description)}">
<meta name="keywords" content="${esc(post.focus_keywords || "")}">
<meta property="og:site_name" content="ZIWAN YATTRA">
<meta property="og:type" content="article">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(imageUrl)}">
<meta property="og:image:secure_url" content="${esc(imageUrl)}">
<meta property="og:image:alt" content="${esc(title)}">
<meta property="og:url" content="${esc(shareUrl)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(imageUrl)}">
</head>
<body>
<p>Opening <a href="${esc(articleUrl)}">${esc(title)}</a> on ZIWAN YATTRA...</p>
<script>
window.location.replace(${JSON.stringify(articleUrl)});
</script>
</body>
</html>`);
  } catch (error) {
    console.error("Social share route error:", error);
    res.status(500).send("Could not load this article.");
  }
});
// ==========================================
// FACEBOOK / WHATSAPP SHARE PREVIEW (DYNAMIC)
// ==========================================
app.get('/share/news', async (req, res) => {
    try {
        const newsId = req.query.id;

        let newsTitle = "ZIWAN YATTRA - News Article";
        let newsImage = "https://ziwanyattra.com/icons/icon-512.png";
        let newsDesc = "Read the latest news and updates on ZIWAN YATTRA.";

        if (newsId) {
            const { data: newsData, error } = await supabase
                .from('daily_posts')
                .select('title, image_url, summary')
                .eq('id', newsId)
                .single();

            if (newsData) {
                newsTitle = newsData.title || newsTitle;

                if (newsData.image_url) {
                    newsImage = newsData.image_url;
                }

                if (newsData.summary) {
                    newsDesc = newsData.summary;
                }
            }
        }

        let html = fs.readFileSync(
            path.join(process.cwd(), 'article.html'),
            'utf-8'
        );

        html = html.replace(
            '<!-- OG_IMAGE_TAG -->',
            `<meta property="og:image" content="${newsImage}" />`
        );

        html = html.replace(
            '<!-- OG_TITLE_TAG -->',
            `<meta property="og:title" content="${newsTitle}" />`
        );

        html = html.replace(
            '<!-- OG_DESC_TAG -->',
            `<meta property="og:description" content="${newsDesc}" />`
        );

        res.send(html);
    } catch (error) {
        console.error("Share error:", error);
        res.status(500).send("Internal Server Error");
    }
});
/* ===== ZIWAN YATTRA NEWS VIEWS & LIKES API ===== */

// Get views and likes for a published article
app.get("/api/daily-posts/:id/stats", async (req, res) => {
  const postId = Number(req.params.id);

  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return res.status(400).json({
      success: false,
      error: "Invalid article ID."
    });
  }

  try {
    const { data: post, error: postError } = await supabase
      .from("daily_posts")
      .select("id")
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();

    if (postError) throw postError;
    if (!post) {
      return res.status(404).json({
        success: false,
        error: "Article not found."
      });
    }

    const { data: stats, error: statsError } = await adminSupabase
      .from("daily_post_stats")
      .select("views, likes")
      .eq("post_id", postId)
      .maybeSingle();

    if (statsError) throw statsError;
    console.log("ARTICLE STATS DEBUG:", { postId, stats, statsError });
    const { count, error: likesError } = await adminSupabase
      .from("daily_post_likes")
      .select("*", { count: "exact", head: true })
      .eq("post_id", postId);

    if (likesError) throw likesError;

    return res.json({
      success: true,
      views: stats?.views || 0,
      likes: count || 0
    });
  } catch (error) {
    console.error("Article stats error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Could not load article stats."
    });
  }
});

// Count a view when a published article is opened
app.post("/api/daily-posts/:id/view", async (req, res) => {
  const postId = Number(req.params.id);

  if (!Number.isSafeInteger(postId) || postId <= 0) {
    return res.status(400).json({
      success: false,
      error: "Invalid article ID."
    });
  }

  try {
    const { data: post, error: postError } = await supabase
      .from("daily_posts")
      .select("id")
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();

    if (postError) throw postError;
    if (!post) {
      return res.status(404).json({
        success: false,
        error: "Article not found."
      });
    }

    const { data, error } = await adminSupabase.rpc(
      "increment_daily_post_view",
      { p_post_id: postId }
    );

    if (error) throw error;

    return res.json({
      success: true,
      views: data
    });
  } catch (error) {
    console.error("Article view error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Could not record article view."
    });
  }
});

// Like or unlike an article
app.post("/api/daily-posts/:id/like", async (req, res) => {
  const postId = Number(req.params.id);
  const voterToken = req.body?.voter_token;

  if (
    !Number.isSafeInteger(postId) ||
    postId <= 0 ||
    typeof voterToken !== "string" ||
    voterToken.length < 16 ||
    voterToken.length > 200
  ) {
    return res.status(400).json({
      success: false,
      error: "Invalid article ID or voter token."
    });
  }

  try {
    const { data: post, error: postError } = await supabase
      .from("daily_posts")
      .select("id")
      .eq("id", postId)
      .eq("status", "published")
      .maybeSingle();

    if (postError) throw postError;
    if (!post) {
      return res.status(404).json({
        success: false,
        error: "Article not found."
      });
    }

    const voterHash = crypto
      .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
      .update("like:" + postId + ":" + voterToken)
      .digest("hex");

    const { data: existing, error: findError } = await adminSupabase
      .from("daily_post_likes")
      .select("post_id")
      .eq("post_id", postId)
      .eq("voter_hash", voterHash)
      .maybeSingle();

    if (findError) throw findError;

    let liked;

    if (existing) {
      const { error } = await adminSupabase
        .from("daily_post_likes")
        .delete()
        .eq("post_id", postId)
        .eq("voter_hash", voterHash);

      if (error) throw error;
      liked = false;
    } else {
      const { error } = await adminSupabase
        .from("daily_post_likes")
        .insert({ post_id: postId, voter_hash: voterHash });

      if (error) throw error;
      liked = true;
    }

    const { count, error: countError } = await adminSupabase
      .from("daily_post_likes")
      .select("*", { count: "exact", head: true })
      .eq("post_id", postId);

    if (countError) throw countError;

    const { error: statsError } = await adminSupabase
      .from("daily_post_stats")
      .upsert({
        post_id: postId,
        likes: count || 0,
        updated_at: new Date().toISOString()
      }, { onConflict: "post_id" });

    if (statsError) throw statsError;

    return res.json({
      success: true,
      liked,
      likes: count || 0
    });
  } catch (error) {
    console.error("Article like error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Could not update like."
    });
  }
});

const server = app.listen(PORT, () => {
  console.log(`🚀 ZIWAN YATTRA backend running at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  console.error("Backend startup failed:", error.message);
  process.exitCode = 1;
});
