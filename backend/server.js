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
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found."
  });
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