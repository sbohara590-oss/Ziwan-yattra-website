require("dotenv").config({
  path: require("path").join(__dirname, ".env")
});

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

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

app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "10kb" }));

const allowedOrigins = new Set([https://sbohara590-oss.github.io/
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:5501",
  "http://localhost:5501",
  "http://localhost:3000"
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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