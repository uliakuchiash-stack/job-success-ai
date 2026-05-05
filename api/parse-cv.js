// api/parse-cv.js
// Job Success AI — CV parser
// Main fix: stronger fallbackName detection for CVs like:
// РЕЗЮМЕ
// ЮЛІЯ КУЧІЯШ
// Одеса, Україна
// Телефон...
// Email...

const fs = require("fs");
const path = require("path");

function optionalRequire(name) {
  try {
    return require(name);
  } catch (e) {
    return null;
  }
}

const formidable = optionalRequire("formidable");
const mammoth = optionalRequire("mammoth");
const pdfParse = optionalRequire("pdf-parse");

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function cleanText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function getLines(text) {
  return cleanText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function titleCaseName(name) {
  const smallWords = new Set(["de", "da", "di", "van", "von"]);

  return String(name || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => {
      if (!word) return word;
      if (smallWords.has(word)) return word;

      return word
        .split("-")
        .map((part) =>
          part
            .split("'")
            .map((piece) =>
              piece ? piece.charAt(0).toUpperCase() + piece.slice(1) : piece
            )
            .join("'")
        )
        .join("-");
    })
    .join(" ")
    .trim();
}

function looksLikeResumeHeader(line) {
  const value = String(line || "")
    .trim()
    .replace(/[.:|•\-–—]+$/g, "")
    .toUpperCase();

  return [
    "РЕЗЮМЕ",
    "РЕЗЮМЭ",
    "RESUME",
    "CV",
    "CURRICULUM VITAE",
    "CURRICULUM VITÆ",
  ].includes(value);
}

function hasContactInfo(line) {
  const value = String(line || "");
  return (
    /@/.test(value) ||
    /\+?\d[\d\s().-]{6,}/.test(value) ||
    /(телефон|phone|mobile|email|e-mail|mail|contact|contacts|контакти|контакт)/i.test(
      value
    )
  );
}

function looksLikeLocation(line) {
  const value = String(line || "").trim();

  if (!value) return false;

  if (
    /(україна|украина|ukraine|poland|польща|польша|united kingdom|uk|great britain|england|london|одеса|одесса|kyiv|київ|киев|львів|львов|lviv)/i.test(
      value
    )
  ) {
    return true;
  }

  if (/^[\p{L}\s.'’,-]+,\s*[\p{L}\s.'’,-]+$/u.test(value) && value.length <= 60) {
    return true;
  }

  return false;
}

function looksLikeJobTitleOrHeading(line) {
  const value = String(line || "").trim().toLowerCase();

  if (!value) return true;

  const badWords = [
    "resume",
    "cv",
    "curriculum vitae",
    "резюме",
    "досвід",
    "опыт",
    "experience",
    "work experience",
    "employment",
    "education",
    "освіта",
    "образование",
    "skills",
    "навички",
    "навыки",
    "languages",
    "мови",
    "языки",
    "summary",
    "profile",
    "профіль",
    "профиль",
    "about me",
    "про себе",
    "contacts",
    "contact",
    "контакти",
    "контакт",
    "social worker",
    "customer support",
    "chat operator",
    "teacher",
    "care assistant",
    "manager",
    "developer",
    "designer",
    "recruiter",
    "assistant",
    "specialist",
    "administrator",
    "consultant",
    "coordinator",
    "worker",
    "operator",
    "працівник",
    "работник",
    "оператор",
    "вчитель",
    "учитель",
    "асистент",
    "менеджер",
    "спеціаліст",
    "специалист",
    "адміністратор",
    "администратор",
  ];

  if (badWords.some((word) => value.includes(word))) return true;

  if (/^\d{4}\s*[-–—]\s*\d{4}/.test(value)) return true;
  if (/^\d{4}\s*[-–—]\s*(present|тепер|дотепер|now|current)/i.test(value)) return true;

  return false;
}

function looksLikeNameCandidate(line) {
  const value = String(line || "")
    .trim()
    .replace(/[•|]+/g, " ")
    .replace(/\s+/g, " ");

  if (!value) return false;
  if (value.length < 4 || value.length > 60) return false;
  if (hasContactInfo(value)) return false;
  if (looksLikeLocation(value)) return false;
  if (looksLikeJobTitleOrHeading(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);

  if (words.length < 2 || words.length > 4) return false;

  const letterOnlyWords = words.filter((word) =>
    /^[\p{L}'’.-]+$/u.test(word)
  );

  if (letterOnlyWords.length !== words.length) return false;

  const longEnoughWords = words.filter((word) => {
    const letters = word.replace(/[^A-Za-zА-Яа-яІіЇїЄєҐґŁłŚśŻżŹźĆćŃńÓóĄąĘę]/g, "");
    return letters.length >= 2;
  });

  if (longEnoughWords.length < 2) return false;

  return true;
}

function findNameAfterResumeHeader(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!looksLikeResumeHeader(lines[i])) continue;

    for (let j = i + 1; j < Math.min(lines.length, i + 6); j++) {
      const candidate = lines[j];

      if (!candidate) continue;
      if (hasContactInfo(candidate)) continue;
      if (looksLikeLocation(candidate)) continue;

      if (looksLikeNameCandidate(candidate)) {
        return titleCaseName(candidate);
      }

      if (looksLikeJobTitleOrHeading(candidate)) continue;
    }
  }

  return "";
}

function fallbackName(text) {
  const lines = getLines(text);

  const fromHeader = findNameAfterResumeHeader(lines);
  if (fromHeader) return fromHeader;

  const firstLines = lines.slice(0, 12);

  for (const line of firstLines) {
    if (looksLikeResumeHeader(line)) continue;
    if (hasContactInfo(line)) continue;
    if (looksLikeLocation(line)) continue;

    if (looksLikeNameCandidate(line)) {
      return titleCaseName(line);
    }
  }

  return "";
}

function extractEmail(text) {
  const match = String(text || "").match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
  );
  return match ? match[0].trim() : "";
}

function extractPhone(text) {
  const source = String(text || "");

  const labelled = source.match(
    /(?:телефон|phone|mobile|mob|tel)\s*[:\-]?\s*(\+?\d[\d\s().-]{7,})/i
  );

  if (labelled && labelled[1]) {
    return labelled[1].replace(/\s+/g, " ").trim();
  }

  const match = source.match(/(\+?\d[\d\s().-]{8,}\d)/);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function extractLocation(text) {
  const lines = getLines(text);

  for (const line of lines.slice(0, 15)) {
    if (hasContactInfo(line)) continue;
    if (looksLikeResumeHeader(line)) continue;
    if (looksLikeNameCandidate(line)) continue;

    if (looksLikeLocation(line)) {
      return line.trim();
    }
  }

  const labelled = String(text || "").match(
    /(?:location|address|адреса|адрес|місто|город)\s*[:\-]?\s*([^\n]+)/i
  );

  if (labelled && labelled[1]) {
    return labelled[1].trim();
  }

  return "";
}

function extractLanguages(text) {
  const source = String(text || "");

  const known = [
    "Ukrainian",
    "Українська",
    "Украинский",
    "Russian",
    "Русский",
    "Polish",
    "Польська",
    "Польский",
    "English",
    "Англійська",
    "Английский",
    "German",
    "Німецька",
    "Немецкий",
    "French",
    "Французька",
    "Французский",
  ];

  const found = [];

  for (const lang of known) {
    const re = new RegExp(`\\b${lang}\\b`, "i");
    if (re.test(source) && !found.includes(lang)) {
      found.push(lang);
    }
  }

  return found.join(", ");
}

function extractSection(text, names) {
  const lines = getLines(text);
  const lowerNames = names.map((n) => n.toLowerCase());

  let start = -1;

  for (let i = 0; i < lines.length; i++) {
    const cleaned = lines[i].replace(/[.:]+$/g, "").toLowerCase();
    if (lowerNames.includes(cleaned)) {
      start = i + 1;
      break;
    }
  }

  if (start === -1) return "";

  const stopWords = [
    "experience",
    "work experience",
    "employment",
    "education",
    "skills",
    "languages",
    "summary",
    "profile",
    "contacts",
    "contact",
    "досвід",
    "опыт",
    "освіта",
    "образование",
    "навички",
    "навыки",
    "мови",
    "языки",
    "профіль",
    "профиль",
    "контакти",
    "контакт",
  ];

  const collected = [];

  for (let i = start; i < lines.length; i++) {
    const cleaned = lines[i].replace(/[.:]+$/g, "").toLowerCase();

    if (stopWords.includes(cleaned) && collected.length > 0) break;

    collected.push(lines[i]);

    if (collected.join(" ").length > 1200) break;
  }

  return collected.join("\n").trim();
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = [];

    req.on("data", (chunk) => data.push(chunk));
    req.on("end", () => resolve(Buffer.concat(data)));
    req.on("error", reject);
  });
}

async function parseMultipart(req) {
  if (!formidable) {
    throw new Error(
      "Missing dependency: formidable. Add it to api/package.json dependencies."
    );
  }

  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 12 * 1024 * 1024,
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function firstValue(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function getUploadedFile(files) {
  if (!files) return null;

  const possibleKeys = ["file", "cv", "resume", "document", "upload"];

  for (const key of possibleKeys) {
    if (files[key]) return firstValue(files[key]);
  }

  const all = Object.values(files).flat();
  return all.length ? all[0] : null;
}

async function extractTextFromFile(file) {
  if (!file) return "";

  const filePath = file.filepath || file.path;
  const fileName = file.originalFilename || file.name || "";
  const mimeType = file.mimetype || file.type || "";
  const ext = path.extname(fileName).toLowerCase();

  if (!filePath || !fs.existsSync(filePath)) return "";

  const buffer = fs.readFileSync(filePath);

  if (ext === ".pdf" || mimeType.includes("pdf")) {
    if (!pdfParse) {
      throw new Error(
        "Missing dependency: pdf-parse. Add it to api/package.json dependencies."
      );
    }

    const parsed = await pdfParse(buffer);
    return cleanText(parsed.text || "");
  }

  if (
    ext === ".docx" ||
    mimeType.includes(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
  ) {
    if (!mammoth) {
      throw new Error(
        "Missing dependency: mammoth. Add it to api/package.json dependencies."
      );
    }

    const parsed = await mammoth.extractRawText({ buffer });
    return cleanText(parsed.value || "");
  }

  return cleanText(buffer.toString("utf8"));
}

async function getTextFromRequest(req) {
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    const { fields, files } = await parseMultipart(req);

    const directText =
      firstValue(fields.text) ||
      firstValue(fields.cvText) ||
      firstValue(fields.resumeText) ||
      "";

    if (directText) return cleanText(directText);

    const file = getUploadedFile(files);
    return await extractTextFromFile(file);
  }

  const raw = await readRawBody(req);
  const bodyText = raw.toString("utf8");

  if (contentType.includes("application/json")) {
    try {
      const json = JSON.parse(bodyText || "{}");
      return cleanText(json.text || json.cvText || json.resumeText || "");
    } catch (e) {
      return cleanText(bodyText);
    }
  }

  return cleanText(bodyText);
}

function parseCvText(text) {
  const cleaned = cleanText(text);

  const name = fallbackName(cleaned);
  const email = extractEmail(cleaned);
  const phone = extractPhone(cleaned);
  const location = extractLocation(cleaned);
  const languages = extractLanguages(cleaned);

  const summary = extractSection(cleaned, [
    "Summary",
    "Profile",
    "About me",
    "Профіль",
    "Профиль",
    "Про себе",
  ]);

  const experience = extractSection(cleaned, [
    "Experience",
    "Work Experience",
    "Employment",
    "Досвід",
    "Опыт",
    "Досвід роботи",
    "Опыт работы",
  ]);

  const education = extractSection(cleaned, [
    "Education",
    "Освіта",
    "Образование",
  ]);

  const skills = extractSection(cleaned, [
    "Skills",
    "Навички",
    "Навыки",
    "Key Skills",
  ]);

  return {
    name,
    fullName: name,
    full_name: name,

    email,
    phone,
    location,

    languages,
    summary,
    experience,
    education,
    skills,

    rawText: cleaned,
  };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return sendJson(res, 405, {
        error: "Method not allowed. Use POST.",
      });
    }

    const text = await getTextFromRequest(req);

    if (!text) {
      return sendJson(res, 400, {
        error: "No CV text or file received.",
      });
    }

    const parsed = parseCvText(text);

    return sendJson(res, 200, parsed);
  } catch (error) {
    return sendJson(res, 500, {
      error: "CV parsing failed.",
      details: error && error.message ? error.message : String(error),
    });
  }
};
