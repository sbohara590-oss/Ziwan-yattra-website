require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const app = express();
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
    status = "draft"
  } = req.body || {};

  const categories = [
    "News",
    "Gaming",
    "Sports",
    "General Knowledge"
  ];

  if (
    typeof title !== "string" || !title.trim() || title.length > 180 ||
    !categories.includes(category) ||
    typeof description !== "string" || !description.trim() ||
    description.length > 500 ||
    typeof content !== "string" || !content.trim() ||
    typeof image_url !== "string" || image_url.length > 2000 ||
    !Array.isArray(internal_links) ||
    !internal_links.every(
      x => typeof x === "string" && x.length <= 500
    ) ||
    !["draft", "published"].includes(status)
  ) {
    return res.status(400).json({
      success: false,
      error: "Please check all post fields."
    });
  }

  const slug = title.trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 150);

  if (!slug) {
    return res.status(400).json({
      success: false,
      error: "Invalid title."
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
        status,
        updated_at: now,
        published_at: status === "published" ? now : null
      })
      .select()
      .single();

    if (error) {
      console.error(
        "Admin post insert error:",
        error.code,
        error.message
      );

      return res.status(500).json({
        success: false,
        error: error.code === "23505"
          ? "This title already exists. Change the title."
          : "Could not save the post. Check server logs and database settings."
      });
    }

    return res.status(201).json({
      success: true,
      post: data
    });
  } catch (error) {
    console.error("Admin post error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Server error."
    });
  }
});
// Daily Updates: fetch published posts
app.get("/api/daily-posts", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("daily_posts")
      .select("*")
      .eq("status", "published")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Daily posts fetch error:", error.message);
      return res.status(500).json({
        success: false,
        error: "Could not load daily posts."
      });
    }

    return res.json({
      success: true,
      posts: data || []
    });
  } catch (error) {
    console.error("Daily posts server error:", error.message);
    return res.status(500).json({
      success: false,
      error: "Server error while loading posts."
    });
  }
});



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

const server = app.listen(PORT, () => {
  console.log(`🚀 ZIWAN YATTRA backend running at http://localhost:${PORT}`);
});

server.on("error", (error) => {
  console.error("Backend startup failed:", error.message);
  process.exitCode = 1;
});
/* ===== ZIWAN YATTRA POLL API ===== */

// Public: Get active poll
app.get("/api/daily-polls", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("daily_polls")
      .select("id, question, options, status, created_at")
      .eq("status", "active")
      .order("created_at", { ascending: false });

    if (error) throw error;

    const polls = await Promise.all((data || []).map(async (poll) => {
      const { data: votes, error: voteError } = await supabase
        .from("daily_poll_votes")
        .select("option_index")
        .eq("poll_id", poll.id);

      if (voteError) throw voteError;

      const counts = (Array.isArray(poll.options) ? poll.options : []).map(
        (_, index) => (votes || []).filter(v => v.option_index === index).length
      );

      const totalVotes = counts.reduce((sum, count) => sum + count, 0);

      return {
        ...poll,
        results: counts.map((count, index) => ({
          option_index: index,
          votes: count,
          percentage: totalVotes ? Math.round(count * 100 / totalVotes) : 0
        })),
        total_votes: totalVotes
      };
    }));

    res.json({ success: true, polls });
  } catch (error) {
    console.error("Poll fetch error:", error.message);
    res.status(500).json({ success: false, error: "Could not load polls." });
  }
});

// Public: Submit a vote
app.post("/api/daily-polls/:id/vote", async (req, res) => {
  const pollId = req.params.id;
  const optionIndex = req.body?.option_index;

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pollId) ||
    !Number.isInteger(optionIndex) ||
    optionIndex < 0
  ) {
    return res.status(400).json({ success: false, error: "Invalid poll or option." });
  }

  try {
    const { data: poll, error: pollError } = await supabase
      .from("daily_polls")
      .select("id, options, status")
      .eq("id", pollId)
      .maybeSingle();

    if (pollError || !poll || poll.status !== "active") {
      return res.status(404).json({ success: false, error: "Poll not found or closed." });
    }

    if (!Array.isArray(poll.options) || optionIndex >= poll.options.length) {
      return res.status(400).json({ success: false, error: "Invalid option." });
    }

    const voterToken = req.body?.voter_token;
    if (typeof voterToken !== "string" || voterToken.length < 16 || voterToken.length > 200) {
      return res.status(400).json({ success: false, error: "Missing voter token." });
    }

    const voterHash = crypto
      .createHmac("sha256", process.env.ADMIN_SESSION_SECRET)
      .update(pollId + ":" + voterToken)
      .digest("hex");

    const { error: insertError } = await adminSupabase
      .from("daily_poll_votes")
      .insert({
        poll_id: pollId,
        option_index: optionIndex,
        voter_hash: voterHash
      });

    if (insertError?.code === "23505") {
      return res.status(409).json({ success: false, error: "You have already voted in this poll." });
    }

    if (insertError) throw insertError;

    return res.status(201).json({ success: true, message: "Vote saved." });
  } catch (error) {
    console.error("Poll vote error:", error.message);
    return res.status(500).json({ success: false, error: "Could not save vote." });
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

    const { data: stats, error: statsError } = await supabase
      .from("daily_post_stats")
      .select("views, likes")
      .eq("post_id", postId)
      .maybeSingle();

    if (statsError) throw statsError;

    const { count, error: likesError } = await supabase
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