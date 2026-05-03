export const config = {
  api: {
    bodyParser: false,
  },
};

function sendJson(res, status, data) {
  res.status(status).json(data);
}

async function readRequestBuffer(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks);
}

function getHeader(req, name) {
  const key = Object.keys(req.headers || {}).find(
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? req.headers[key] : "";
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType).match(/boundary=([^;]+)/i);

  if (!boundaryMatch) {
    throw new Error("Multipart boundary not found");
  }

  const boundary = `--${boundaryMatch[1]}`;
  const body = buffer.toString("binary");
  const parts = body.split(boundary).filter((part) => {
    const clean = part.trim();
    return clean && clean !== "--";
  });

  const fields = {};
  const files = {};

  for (const part of parts) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const rawHeaders = part.slice(0, headerEnd);
    let rawContent = part.slice(headerEnd + 4);

    rawContent = rawContent.replace(/\r\n--$/, "");
    rawContent = rawContent.replace(/\r\n$/, "");

    const nameMatch = rawHeaders.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];
    const fileNameMatch = rawHeaders.match(/filename="([^"]*)"/i);
    const contentTypeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);

    if (fileNameMatch) {
      files[fieldName] = {
        filename: fileNameMatch[1] || "audio.webm",
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "audio/webm",
        buffer: Buffer.from(rawContent, "binary"),
      };
    } else {
      fields[fieldName] = rawContent.trim();
    }
  }

  return { fields, files };
}

function normalizeLanguageCode(language) {
  const code = String(language || "").toLowerCase().trim();

  if (code.startsWith("uk")) return "uk";
  if (code.startsWith("en")) return "en";
  if (code.startsWith("pl")) return "pl";
  if (code.startsWith("de")) return "de";
  if (code.startsWith("fr")) return "fr";
  if (code.startsWith("es")) return "es";
  if (code.startsWith("it")) return "it";
  if (code.startsWith("pt")) return "pt";
  if (code.startsWith("nl")) return "nl";
  if (code.startsWith("tr")) return "tr";
  if (code.startsWith("ro")) return "ro";
  if (code.startsWith("cs")) return "cs";
  if (code.startsWith("sk")) return "sk";
  if (code.startsWith("ka")) return "ka";
  if (code.startsWith("ar")) return "ar";
  if (code.startsWith("zh")) return "zh";
  if (code.startsWith("ja")) return "ja";
  if (code.startsWith("ko")) return "ko";
  if (code.startsWith("hi")) return "hi";
  if (code.startsWith("he")) return "he";

  return "";
}

function languagePrompt(languageName) {
  const name = String(languageName || "").trim();

  if (name === "Українська") {
    return "Transcribe the speech in Ukrainian. Correct obvious speech recognition mistakes. Do not translate. Return only the spoken text.";
  }

  if (name === "English") {
    return "Transcribe the speech in English. Correct obvious speech recognition mistakes. Do not translate. Return only the spoken text.";
  }

  if (name) {
    return `Transcribe the speech in ${name}. Correct obvious speech recognition mistakes. Do not translate. Return only the spoken text.`;
  }

  return "Transcribe the speech. Correct obvious speech recognition mistakes. Do not translate. Return only the spoken text.";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return sendJson(res, 500, { error: "OPENAI_API_KEY is missing" });
    }

    const contentType = getHeader(req, "content-type");

    if (!String(contentType).includes("multipart/form-data")) {
      return sendJson(res, 400, { error: "Expected multipart/form-data" });
    }

    const buffer = await readRequestBuffer(req);
    const { fields, files } = parseMultipart(buffer, contentType);

    const audio = files.file || files.audio;

    if (!audio || !audio.buffer || audio.buffer.length < 1000) {
      return sendJson(res, 400, {
        error: "Audio file is missing or too small",
      });
    }

    const language = normalizeLanguageCode(fields.language);
    const languageName = fields.languageName || fields.language || "";

    const form = new FormData();

    const blob = new Blob([audio.buffer], {
      type: audio.contentType || "audio/webm",
    });

    form.append("file", blob, audio.filename || "answer.webm");
    form.append("model", "gpt-4o-mini-transcribe");
    form.append("response_format", "json");
    form.append("prompt", languagePrompt(languageName));

    if (language) {
      form.append("language", language);
    }

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: form,
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        error: "OpenAI transcription failed",
        details: raw.slice(0, 1200),
      });
    }

    let data;

    try {
      data = JSON.parse(raw);
    } catch (_) {
      data = { text: raw };
    }

    const text = String(data.text || "").trim();

    if (!text) {
      return sendJson(res, 200, {
        ok: true,
        text: "",
        warning: "No speech was recognised",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      text,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Transcription API error",
      details: error.message || String(error),
    });
  }
}
