require("dotenv").config();

const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;
const enquiriesFile = path.join(__dirname, "enquiries.json");

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing Supabase settings in backend/.env");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = new Set([
  "http://127.0.0.1:5500",
  "http://localhost:5500",
  "http://127.0.0.1:5501",
  "http://localhost:5501",
  "http://localhost:3000"
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  if (origin && !allowedOrigins.has(origin)) {
    return res.status(403).json({
      success: false,
      error: "Origin not allowed."
    });
  }

  next();
});

app.use(express.json({ limit: "10kb" }));

app.use(rateLimit({
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
    message: "ZIWAN YATTRA backend is running!"
  });
});

app.post("/api/enquiries", async (req, res) => {
  const { category, helpType, details, email = "" } = req.body || {};

  if (
    typeof category !== "string" || !category.trim() ||
    typeof helpType !== "string" || !helpType.trim() ||
    typeof details !== "string" || !details.trim()
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
      error: "One or more fields are too long."
    });
  }

  const enquiry = {
    category: category.trim(),
    help_type: helpType.trim(),
    details: details.trim(),
    email: email.trim()
  };

  // Save to Supabase first.
  try {
    const { data, error } = await supabase
      .from("enquiries")
      .insert(enquiry)
      .select("id, created_at")
      .single();

    if (error) {
      console.error("Supabase save failed:", error.message);

      return res.status(500).json({
        success: false,
        error: "Database save failed. Check Supabase table permissions and server settings."
      });
    }

    // Keep a local backup too.
    try {
      let entries = [];

      if (fs.existsSync(enquiriesFile)) {
        const saved = JSON.parse(
          fs.readFileSync(enquiriesFile, "utf8")
        );

        if (Array.isArray(saved)) entries = saved;
      }

      entries.push({
        ...enquiry,
        id: data.id,
        created_at: data.created_at
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
      message: "Enquiry received and saved.",
      id: data.id
    });
  } catch (error) {
    console.error("Unexpected enquiry error:", error.message);

    return res.status(500).json({
      success: false,
      error: "Something went wrong while saving the enquiry."
    });
  }
});

app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found"
  });
});

app.listen(PORT, () => {
  console.log(`ZIWAN YATTRA backend running at http://localhost:${PORT}`);
});