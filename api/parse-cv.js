export const config = {
  api: {
    bodyParser: false
  }
};

import zlib from "zlib";

function sendJson(res, status, data) {
  return res.status(status).json(data);
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getHeader(req, name) {
  const key = Object.keys(req.headers || {}).find(
    k => k.toLowerCase() === name.toLowerCase()
  );
  return key ? req.headers[key] : "";
}

function splitBuffer(buffer, separator) {
  const parts = [];
  let start = 0;
  let index;

  while ((index = buffer.indexOf(separator, start)) !== -1) {
    parts.push(buffer.slice(start, index));
    start = index + separator.length;
  }

  parts.push(buffer.slice(start));
  return parts;
}

function parseMultipart(buffer, contentType) {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = match ? (match[1] || match[2]) : "";

  if (!boundary) return { fields: {}, files: [] };

  const boundaryBuffer = Buffer.from("--" + boundary);
  const parts = splitBuffer(buffer, boundaryBuffer);

  const fields = {};
  const files = [];

  for (let part of parts) {
    if (!part || part.length < 10) continue;

    if (part.slice(0, 2).toString() === "\r\n") part = part.slice(2);
    if (part.slice(-2).toString() === "\r\n") part = part.slice(0, -2);
    if (part.toString("utf8").trim() === "--") continue;

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) continue;

    const headerBuffer = part.slice(0, headerEnd);
    let contentBuffer = part.slice(headerEnd + 4);

    if (contentBuffer.slice(-2).toString() === "\r\n") {
      contentBuffer = contentBuffer.slice(0, -2);
    }

    if (contentBuffer.slice(-2).toString() === "--") {
      contentBuffer = contentBuffer.slice(0, -2);
    }

    const headerText = headerBuffer.toString("utf8");
    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const fileMatch = headerText.match(/filename="([^"]*)"/i);
    const typeMatch = headerText.match(/content-type:\s*([^\r\n]+)/i);

    const name = nameMatch ? nameMatch[1] : "";
    const filename = fileMatch ? fileMatch[1] : "";

    if (!name) continue;

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
    .replace(/\u0000/g, "")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodePdfString(s) {
  return String(s || "")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\([0-7]{1,3})/g, (_, oct) =>
      String.fromCharCode(parseInt(oct, 8))
    );
}

function decodeHexPdf(hex) {
  try {
    let clean = String(hex || "").replace(/[^0-9A-Fa-f]/g, "");
    if (clean.length % 2) clean += "0";

    const buf = Buffer.from(clean, "hex");

    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      let out = "";
      for (let i = 2; i + 1 < buf.length; i += 2) {
        out += String.fromCharCode(buf.readUInt16BE(i));
      }
      return out;
    }

    return buf.toString("utf8");
  } catch (e) {
    return "";
  }
}

function extractTextFromPdfStream(streamText) {
  const chunks = [];

  for (const m of streamText.matchAll(/\(([\s\S]*?)\)\s*Tj/g)) {
    chunks.push(decodePdfString(m[1]));
  }

  for (const m of streamText.matchAll(/<([0-9A-Fa-f\s]+)>\s*Tj/g)) {
    chunks.push(decodeHexPdf(m[1]));
  }

  for (const arr of streamText.matchAll(/\[([\s\S]*?)\]\s*TJ/g)) {
    const inside = arr[1];
    const parts = [];

    for (const m of inside.matchAll(/\(([\s\S]*?)\)|<([0-9A-Fa-f\s]+)>/g)) {
      if (m[1] !== undefined) parts.push(decodePdfString(m[1]));
      if (m[2] !== undefined) parts.push(decodeHexPdf(m[2]));
    }

    if (parts.length) chunks.push(parts.join(""));
  }

  return chunks.join("\n");
}

function extractTextFromPdfBasic(buffer) {
  try {
    const raw = buffer.toString("latin1");
    const chunks = [];

    const streamRegex = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    let match;

    while ((match = streamRegex.exec(raw))) {
      const streamRaw = match[1];
      let streamBuffer = Buffer.from(streamRaw, "latin1");
      let decoded = "";

      try {
        decoded = zlib.inflateSync(streamBuffer).toString("latin1");
      } catch (e) {
        decoded = streamBuffer.toString("latin1");
      }

      const extracted = extractTextFromPdfStream(decoded);
      if (extracted) chunks.push(extracted);
    }

    if (!chunks.length) chunks.push(extractTextFromPdfStream(raw));

    return cleanText(
      chunks
        .join("\n")
        .replace(/[^\S\n]+/g, " ")
    );
  } catch (e) {
    return "";
  }
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

function extractZipEntries(buffer) {
  const entries = {};
  let offset = 0;

  while (offset < buffer.length - 30) {
    const sig = buffer.readUInt32LE(offset);

    if (sig !== 0x04034b50) {
      offset++;
      continue;
    }

    const flags = buffer.readUInt16LE(offset + 6);
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);

    const nameStart = offset + 30;
    const nameEnd = nameStart + fileNameLength;
    const fileName = buffer.slice(nameStart, nameEnd).toString("utf8");

    const dataStart = nameEnd + extraLength;

    if (flags & 0x08) {
      offset = dataStart + Math.max(1, compressedSize || 1);
      continue;
    }

    const dataEnd = dataStart + compressedSize;
    const compressed = buffer.slice(dataStart, dataEnd);

    let data = Buffer.alloc(0);

    try {
      if (method === 0) data = compressed;
      if (method === 8) data = zlib.inflateRawSync(compressed);
    } catch (e) {}

    if (fileName) entries[fileName] = data;
    offset = dataEnd;
  }

  return entries;
}

function extractTextFromDocx(buffer) {
  try {
    const entries = extractZipEntries(buffer);
    const doc = entries["word/document.xml"];
    if (!doc) return "";
    return cleanText(stripXml(doc.toString("utf8")));
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

  if (filename.endsWith(".docx") || type.includes("wordprocessingml")) {
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

function normaliseLine(line) {
  return String(line || "")
    .replace(/[|•·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLines(text) {
  return cleanText(text)
    .split("\n")
    .map(normaliseLine)
    .filter(Boolean);
}

function looksLikeName(line) {
  const clean = normaliseLine(line);

  if (!clean) return false;
  if (clean.length < 4 || clean.length > 70) return false;
  if (/@/.test(clean)) return false;
  if (/\d{3,}/.test(clean)) return false;
  if (/https?:|www\.|linkedin|telegram|facebook/i.test(clean)) return false;

  const lower = clean.toLowerCase();

  const bannedExactOrContains = [
    "resume",
    "cv",
    "curriculum",
    "vitae",
    "profile",
    "email",
    "phone",
    "contact",
    "address",
    "location",
    "education",
    "experience",
    "skills",
    "languages",
    "objective",
    "summary",
    "резюме",
    "профіль",
    "контакти",
    "телефон",
    "пошта",
    "досвід",
    "освіта",
    "навички",
    "мови",
    "локація",
    "адреса",
    "бажана посада",
    "прибиральниця",
    "cleaner",
    "customer support",
    "social worker",
    "cover letter"
  ];

  if (bannedExactOrContains.some(w => lower.includes(w))) return false;

  const words = clean.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  const letterWords = words.filter(w =>
    /^[A-Za-zА-Яа-яІіЇїЄєҐґ'’ʼ-]+$/.test(w)
  );

  if (letterWords.length !== words.length) return false;

  const hasUpperStart = words.some(w => /^[A-ZА-ЯІЇЄҐ]/.test(w));
  if (!hasUpperStart) return false;

  return true;
}

function scoreNameCandidate(line, index) {
  let score = 0;
  const clean = normaliseLine(line);
  const words = clean.split(" ").filter(Boolean);

  if (looksLikeName(clean)) score += 50;
  if (index <= 3) score += 30;
  if (index <= 8) score += 15;
  if (words.length === 2) score += 15;
  if (words.length === 3) score += 10;
  if (/^[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’ʼ-]+\s+[А-ЯІЇЄҐA-Z][а-яіїєґa-z'’ʼ-]+/.test(clean)) score += 20;
  if (clean === clean.toUpperCase() && /[A-ZА-ЯІЇЄҐ]/.test(clean)) score += 5;

  return score;
}

function nameFromEmail(email) {
  if (!email) return "";

  const local = email.split("@")[0] || "";
  if (!local || /\d{4,}/.test(local)) return "";

  const parts = local
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .filter(p => p.length >= 2 && !/^\d+$/.test(p))
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

  if (parts.length >= 2 && parts.length <= 3) return parts.join(" ");
  return "";
}

function fallbackName(text) {
  const lines = getLines(text).slice(0, 80);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksLikeName(line)) {
      candidates.push({
        value: line,
        score: scoreNameCandidate(line, i)
      });
    }

    const joined2 = normaliseLine(`${lines[i] || ""} ${lines[i + 1] || ""}`);
    if (looksLikeName(joined2)) {
      candidates.push({
        value: joined2,
        score: scoreNameCandidate(joined2, i) - 5
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length) return candidates[0].value;

  return nameFromEmail(firstEmail(text));
}

function fallbackLocation(text) {
  const lines = getLines(text);

  const locationLabel =
    /(location|address|city|country|локація|адреса|місто|країна|адрес|город|страна|місцезнаходження)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (locationLabel.test(line)) {
      const sameLine = line
        .replace(locationLabel, "")
        .replace(/[:\-–—]/g, " ")
        .trim();

      if (sameLine && sameLine.length < 90 && !/@/.test(sameLine) && !/\d{5,}/.test(sameLine)) {
        return sameLine;
      }

      const next = lines[i + 1] || "";
      if (next && next.length < 90 && !/@/.test(next) && !/\d{5,}/.test(next)) {
        return next;
      }
    }
  }

  const cityCountryPatterns = [
    /(Одеса|Odesa|Odessa)\s*,?\s*(Україна|Ukraine|Ukraina)?/i,
    /(Київ|Kyiv|Kiev)\s*,?\s*(Україна|Ukraine|Ukraina)?/i,
    /(Львів|Lviv)\s*,?\s*(Україна|Ukraine|Ukraina)?/i,
    /(Харків|Kharkiv)\s*,?\s*(Україна|Ukraine|Ukraina)?/i,
    /(Дніпро|Dnipro)\s*,?\s*(Україна|Ukraine|Ukraina)?/i,
    /(London|Manchester|Birmingham|Liverpool|Bristol)\s*,?\s*(UK|United Kingdom|England)?/i,
    /(Warsaw|Krakow)\s*,?\s*(Poland)?/i,
    /(Berlin)\s*,?\s*(Germany)?/i,
    /(Paris)\s*,?\s*(France)?/i,
    /(Madrid)\s*,?\s*(Spain)?/i,
    /(Rome)\s*,?\s*(Italy)?/i
  ];

  for (const pattern of cityCountryPatterns) {
    const m = String(text || "").match(pattern);
    if (m) {
      const raw = m[0].replace(/\s+/g, " ").trim();
      if (/^(Одеса|Odesa|Odessa)$/i.test(raw)) return "Одеса, Україна";
      return raw;
    }
  }

  if (/Україна|Ukraine/i.test(text) && /Одеса|Odesa|Odessa/i.test(text)) {
    return "Одеса, Україна";
  }

  return "";
}

function fallbackLanguages(text) {
  const lines = getLines(text);
  const idx = lines.findIndex(l => /(languages|мови|языки)/i.test(l));

  if (idx !== -1) {
    const next = lines.slice(idx, idx + 5).join(", ");
    return next
      .replace(/languages|мови|языки/ig, "")
      .replace(/[:\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const found = [];
  const langs = [
    "English", "Ukrainian", "Russian", "Polish", "German", "French",
    "Англійська", "Українська", "Російська", "Польська", "Німецька", "Французька",
    "английский", "украинский", "русский", "польский"
  ];

  for (const lang of langs) {
    if (new RegExp(lang, "i").test(text)) found.push(lang);
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

  const fbName = fb.name;
  const fbLocation = fb.location;

  if (!out.name && fbName) out.name = fbName;
  if (!out.location && fbLocation) out.location = fbLocation;

  if (!out.email) out.email = fb.email;
  if (!out.phone) out.phone = fb.phone;
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

  const firstLines = getLines(text).slice(0, 60).join("\n");

  const system = `
You are a strict CV parsing assistant.

Return JSON only.

Extract the candidate profile from the CV text.

Critical rules:
- Do not invent information.
- Extract candidate name if it appears anywhere in the first lines or near contact details.
- The name may be Cyrillic/Ukrainian, for example "Юлія Кучіяш", "Кучіяш Юлія", or Latin, for example "Yuliia Kuchiash".
- Do not confuse candidate name with job title, CV heading, section heading, education heading, or company name.
- Extract location if a city/country appears, for example "Одеса, Україна", "Odesa, Ukraine", "London, UK".
- Split education:
  education = university / school / institution name;
  speciality = degree / speciality / qualification / profession.
- Keep experience, volunteering and courses as arrays.
- Empty unknown fields must be empty strings, not null.

Return exactly:
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

Most important first lines:
${firstLines}

Full CV text:
${text.slice(0, 15000)}
`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0,
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
      return sendJson(res, 200, {
        profile: fallbackProfile(""),
        warning: "Expected multipart/form-data upload."
      });
    }

    const buffer = await readRequestBuffer(req);
    const parsed = parseMultipart(buffer, contentType);

    const file = parsed.files.find(f => f.fieldName === "file") || parsed.files[0];
    const language = parsed.fields.language || "English";

    if (!file) {
      return sendJson(res, 200, {
        profile: fallbackProfile(""),
        warning: "No file uploaded."
      });
    }

    const text = extractText(file);
    const basicProfile = fallbackProfile(text);

    if (!text || text.length < 10) {
      return sendJson(res, 200, {
        profile: basicProfile,
        warning: "Could not read enough text from this CV. Try DOCX or TXT if PDF does not work.",
        rawTextPreview: text.slice(0, 1200),
        firstLines: getLines(text).slice(0, 60),
        filename: file.filename
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
      rawTextPreview: text.slice(0, 1200),
      firstLines: getLines(text).slice(0, 60),
      detectedNameFallback: fallbackName(text),
      detectedLocationFallback: fallbackLocation(text),
      filename: file.filename
    });

  } catch (error) {
    return sendJson(res, 200, {
      profile: fallbackProfile(""),
      warning: "CV analysis fallback mode.",
      details: error.message
    });
  }
}
