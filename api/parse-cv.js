export const config = {
  api: {
    bodyParser: false
  }
};

import zlib from "zlib";

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
    k => k.toLowerCase() === name.toLowerCase()
  );
  return key ? req.headers[key] : "";
}

function parseMultipart(buffer, contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match ? (match[1] || match[2]) : "";

  if (!boundary) {
    return { fields: {}, files: [] };
  }

  const boundaryText = "--" + boundary;
  const raw = buffer.toString("binary");
  const parts = raw.split(boundaryText);
  const fields = {};
  const files = [];

  for (const part of parts) {
    if (!part || part === "--" || part.trim() === "--") continue;

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerText = part.slice(0, headerEnd);
    let content = part.slice(headerEnd + 4);

    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    if (content.endsWith("--")) content = content.slice(0, -2);

    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const fileMatch = headerText.match(/filename="([^"]*)"/i);
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

    const name = nameMatch ? nameMatch[1] : "";
    const filename = fileMatch ? fileMatch[1] : "";

    if (!name) continue;

    const contentBuffer = Buffer.from(content, "binary");

    if (filename) {
      files.push({
        fieldName: name,
        filename,
        contentType: typeMatch ? typeMatch[1].trim() : "",
        buffer: contentBuffer
      });
    } else {
      fields[name] = contentBuffer.toString("utf8").trim();
    }
  }

  return { fields, files };
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripXml(xml) {
  return String(xml || "")
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTextFromDocx(buffer) {
  try {
    const marker = Buffer.from("word/document.xml");
    const idx = buffer.indexOf(marker);

    if (idx === -1) return "";

    const xmlStart = buffer.indexOf(Buffer.from("<w:document"), idx);
    const xmlEnd = buffer.indexOf(Buffer.from("</w:document>"), xmlStart);

    if (xmlStart === -1 || xmlEnd === -1) return "";

    const xml = buffer.slice(xmlStart, xmlEnd + "</w:document>".length).toString("utf8");
    return cleanText(stripXml(xml));
  } catch (e) {
    return "";
  }
}

function extractTextFromPdfBasic(buffer) {
  try {
    let raw = buffer.toString("latin1");

    raw = raw.replace(/\\r/g, "\n").replace(/\\n/g, "\n");

    const chunks = [];

    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let m;

    while ((m = streamRegex.exec(raw))) {
      let streamContent = Buffer.from(m[1], "latin1");

      try {
        streamContent = zlib.inflateSync(streamContent);
      } catch (e) {}

      const s = streamContent.toString("latin1");

      const textMatches = [...s.matchAll(/\(([^()]*)\)\s*Tj/g)];
      for (const t of textMatches) chunks.push(t[1]);

      const arrayMatches = [...s.matchAll(/\[([\s\S]*?)\]\s*TJ/g)];
      for (const a of arrayMatches) {
        const inside = a[1];
        const parts = [...inside.matchAll(/\(([^()]*)\)/g)].map(x => x[1]);
        if (parts.length) chunks.push(parts.join(""));
      }
    }

    if (!chunks.length) {
      const simple = [...raw.matchAll(/\(([^()]{2,})\)/g)].map(x => x[1]);
      chunks.push(...simple);
    }

    return cleanText(
      chunks
        .join("\n")
        .replace(/\\\(/g, "(")
        .replace(/\\\)/g, ")")
        .replace(/\\\\/g, "\\")
    );
  } catch (e) {
    return "";
  }
}

function extractText(file) {
  const filename = String(file.filename || "").toLowerCase();
  const type = String(file.contentType || "").toLowerCase();

  if (filename.endsWith(".txt") || type.includes("text/plain")) {
    return cleanText(file.buffer.toString("utf8"));
  }

  if (filename.endsWith(".docx")) {
    return extractTextFromDocx(file.buffer);
  }

  if (filename.endsWith(".pdf") || type.includes("pdf")) {
    return extractTextFromPdfBasic(file.buffer);
  }

  return cleanText(file.buffer.toString("utf8"));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {}
    }
    return null;
  }
}

function firstEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : "";
}

function firstPhone(text) {
  const m = String(text || "").match(/(\+?\d[\d\s().-]{7,}\d)/);
  return m ? m[1].replace(/\s{2,}/g, " ").trim() : "";
}

function looksLikeName(line) {
  const clean = String(line || "")
    .replace(/[|•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return false;
  if (clean.length < 4 || clean.length > 55) return false;

  const banned = [
    "resume", "cv", "curriculum", "vitae", "profile", "email", "phone",
    "contact", "address", "location", "education", "experience", "skills",
    "languages", "objective", "summary", "резюме", "профіль", "контакти",
    "телефон", "пошта", "досвід", "освіта", "навички", "мови", "локація"
  ];

  const lower = clean.toLowerCase();
  if (banned.some(w => lower.includes(w))) return false;
  if (/@/.test(clean)) return false;
  if (/\d{3,}/.test(clean)) return false;

  const words = clean.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  const letterWords = words.filter(w => /^[A-Za-zА-Яа-яІіЇїЄєҐґ'’-]+$/.test(w));
  if (letterWords.length !== words.length) return false;

  return true;
}

function fallbackName(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 25);

  for (const line of lines) {
    if (looksLikeName(line)) return line;
  }

  return "";
}

function fallbackLocation(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(x => x.trim())
    .filter(Boolean);

  const locationLabel = /(location|address|city|country|локація|адреса|місто|країна|адрес|город|страна)/i;

  for (let i = 0; i < lines.length; i++) {
    if (locationLabel.test(lines[i])) {
      const sameLine = lines[i]
        .replace(locationLabel, "")
        .replace(/[:\-–—]/g, " ")
        .trim();

      if (sameLine && sameLine.length < 70 && !/@/.test(sameLine)) {
        return sameLine;
      }

      const next = lines[i + 1] || "";
      if (next && next.length < 70 && !/@/.test(next) && !/\d{5,}/.test(next)) {
        return next;
      }
    }
  }

  const cityPatterns = [
    /\b(Odesa|Odessa|Kyiv|Kiev|Lviv|London|Manchester|Birmingham|Liverpool|Bristol|Warsaw|Krakow|Berlin|Paris|Madrid|Rome)\b(?:,\s*[A-Za-zА-Яа-яІіЇїЄєҐґ .'-]+)?/i,
    /\b(Одеса|Київ|Львів|Харків|Дніпро|Лондон|Манчестер|Бірмінгем|Варшава|Краків|Берлін|Париж)\b(?:,\s*[A-Za-zА-Яа-яІіЇїЄєҐґ .'-]+)?/i
  ];

  for (const p of cityPatterns) {
    const m = text.match(p);
    if (m) return m[0].trim();
  }

  return "";
}

function fallbackLanguages(text) {
  const lines = cleanText(text).split("\n").map(x => x.trim()).filter(Boolean);
  const idx = lines.findIndex(l => /(languages|мови|языки)/i.test(l));

  if (idx !== -1) {
    const next = lines.slice(idx, idx + 4).join(", ");
    return next.replace(/languages|мови|языки/ig, "").replace(/[:\-–—]/g, " ").trim();
  }

  const found = [];
  const langs = [
    "English", "Ukrainian", "Russian", "Polish", "German", "French",
    "Англійська", "Українська", "Російська", "Польська", "Німецька",
    "английский", "украинский", "русский", "польский"
  ];

  for (const l of langs) {
    if (new RegExp(l, "i").test(text)) found.push(l);
  }

  return [...new Set(found)].join(", ");
}

function fallbackProfile(text) {
  return {
    name: fallbackName(text),
    email: firstEmail(text),
    phone: firstPhone(text),
    location: fallbackLocation(text),
    target: "",
    languages: fallbackLanguages(text),
    education: "",
    speciality: "",
    skills: "",
    softSkills: "",
    hobbies: "",
    experience: [],
    volunteering: [],
    courses: []
  };
}

function normalizeProfile(p, text) {
  const fb = fallbackProfile(text);
  const profile = p && typeof p === "object" ? p : {};

  const out = {
    name: cleanText(profile.name || fb.name),
    email: cleanText(profile.email || fb.email),
    phone: cleanText(profile.phone || fb.phone),
    location: cleanText(profile.location || fb.location),
    target: cleanText(profile.target || profile.jobTitle || profile.position || ""),
    languages: cleanText(profile.languages || fb.languages),
    education: cleanText(profile.education || ""),
    speciality: cleanText(profile.speciality || profile.degree || profile.qualification || ""),
    skills: cleanText(profile.skills || ""),
    softSkills: cleanText(profile.softSkills || profile.soft_skills || ""),
    hobbies: cleanText(profile.hobbies || ""),
    experience: Array.isArray(profile.experience) ? profile.experience : [],
    volunteering: Array.isArray(profile.volunteering) ? profile.volunteering : [],
    courses: Array.isArray(profile.courses) ? profile.courses : []
  };

  if (!out.name) out.name = fb.name;
  if (!out.email) out.email = fb.email;
  if (!out.phone) out.phone = fb.phone;
  if (!out.location) out.location = fb.location;
  if (!out.languages) out.languages = fb.languages;

  out.experience = out.experience.map(x => ({
    company: cleanText(x.company || x.organisation || x.organization || ""),
    position: cleanText(x.position || x.role || ""),
    desc: cleanText(x.desc || x.description || x.responsibilities || "")
  })).filter(x => x.company || x.position || x.desc);

  out.volunteering = out.volunteering.map(x => ({
    org: cleanText(x.org || x.organisation || x.organization || ""),
    role: cleanText(x.role || x.position || ""),
    desc: cleanText(x.desc || x.description || "")
  })).filter(x => x.org || x.role || x.desc);

  out.courses = out.courses.map(x => ({
    name: cleanText(x.name || x.course || ""),
    place: cleanText(x.place || x.organisation || x.organization || x.school || ""),
    period: cleanText(x.period || x.year || ""),
    desc: cleanText(x.desc || x.description || "")
  })).filter(x => x.name || x.place || x.period || x.desc);

  return out;
}

async function analyseWithOpenAI(text, language) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const system = `
You are a CV parsing assistant.

Return JSON only.

Extract candidate profile from the CV text.

Important rules:
- Do not invent information.
- If a field is not found, return an empty string.
- Extract name from the top of the CV if possible.
- Name can be Ukrainian, English, Polish or Russian.
- Do not confuse name with job title, "CV", "Resume", "Profile", "Education", or section headings.
- Extract location from contact/address/location/city lines or from city/country mentions.
- Split education into:
  education = university / school / institution name;
  speciality = degree / speciality / qualification / profession.
- Keep experience as an array.
- Keep courses as an array.
- Keep volunteering as an array.

Return exactly this JSON:
{
  "profile": {
    "name": "",
    "email": "",
    "phone": "",
    "location": "",
    "target": "",
    "languages": "",
    "education": "",
    "speciality": "",
    "skills": "",
    "softSkills": "",
    "hobbies": "",
    "experience": [
      {
        "company": "",
        "position": "",
        "desc": ""
      }
    ],
    "volunteering": [
      {
        "org": "",
        "role": "",
        "desc": ""
      }
    ],
    "courses": [
      {
        "name": "",
        "place": "",
        "period": "",
        "desc": ""
      }
    ]
  }
}
`;

  const user = `
App language: ${language}

CV text:
${text.slice(0, 14000)}
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.1,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: user }
      ]
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(err || "OpenAI request failed");
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";
  return safeJsonParse(content);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const contentType = getHeader(req, "content-type");

    if (!String(contentType).includes("multipart/form-data")) {
      return sendJson(res, 400, {
        error: "Expected multipart/form-data upload."
      });
    }

    const buffer = await readRequestBuffer(req);
    const parsed = parseMultipart(buffer, contentType);

    const file = parsed.files.find(f => f.fieldName === "file") || parsed.files[0];
    const language = parsed.fields.language || "English";

    if (!file) {
      return sendJson(res, 400, { error: "No file uploaded." });
    }

    const text = extractText(file);

    if (!text || text.length < 20) {
      return sendJson(res, 400, {
        error: "Could not read enough text from this CV. Try TXT, DOCX or a clearer PDF."
      });
    }

    let aiProfile = null;

    try {
      const ai = await analyseWithOpenAI(text, language);
      aiProfile = ai?.profile || ai;
    } catch (e) {
      aiProfile = null;
    }

    const profile = normalizeProfile(aiProfile, text);

    return sendJson(res, 200, {
      profile,
      rawTextPreview: text.slice(0, 1200)
    });

  } catch (error) {
    return sendJson(res, 500, {
      error: "CV analysis error",
      details: error.message
    });
  }
}
