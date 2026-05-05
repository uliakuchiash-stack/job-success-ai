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
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[ ]{2,}/g, " ")
    .replace(/\n[ ]+/g, "\n")
    .replace(/[ ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normaliseLine(line) {
  return String(line || "")
    .replace(/[|•·●▪▫◆◇■□]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getLines(text) {
  return cleanText(text)
    .split("\n")
    .map(normaliseLine)
    .filter(Boolean);
}

function decodeXmlEntities(text) {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
}

function stripXml(xml) {
  let s = String(xml || "");

  s = s
    .replace(/<w:tab\s*\/>/g, " ")
    .replace(/<w:br\s*\/>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, " ")
    .replace(/<[^>]+>/g, "");

  s = decodeXmlEntities(s);

  return cleanText(
    s
      .split("\n")
      .map(line => line.replace(/\s+/g, " ").trim())
      .join("\n")
  );
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
    const parts = [];

    if (entries["word/document.xml"]) {
      parts.push(stripXml(entries["word/document.xml"].toString("utf8")));
    }

    for (const key of Object.keys(entries)) {
      if (/^word\/header\d*\.xml$/i.test(key) || /^word\/footer\d*\.xml$/i.test(key)) {
        const value = stripXml(entries[key].toString("utf8"));
        if (value) parts.push(value);
      }
    }

    return cleanText(parts.join("\n"));
  } catch (e) {
    return "";
  }
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
      const streamBuffer = Buffer.from(streamRaw, "latin1");
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

    return cleanText(chunks.join("\n").replace(/[^\S\n]+/g, " "));
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
  const labelled = String(text || "").match(
    /(?:телефон|тел|phone|mobile|mob|tel|telefono|teléfono|téléphone|telefon|telefone|电话|手機|手机|連絡先|联系方式|الهاتف|رقم الهاتف)\s*[:：\-–—]?\s*(\+?\d[\d\s().-]{7,}\d)/i
  );

  if (labelled && labelled[1]) {
    return labelled[1].replace(/\s{2,}/g, " ").trim();
  }

  const m = String(text || "").match(/(\+?\d[\d\s().-]{7,}\d)/);
  return m ? m[1].replace(/\s{2,}/g, " ").trim() : "";
}

function titleCaseName(value) {
  const raw = String(value || "").trim();

  if (/[\u3400-\u9FFF\u3040-\u30FF]/.test(raw)) {
    return raw;
  }

  return raw
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(word => {
      return word
        .split("-")
        .map(part => {
          if (!part) return "";
          return part.charAt(0).toUpperCase() + part.slice(1);
        })
        .join("-");
    })
    .join(" ")
    .trim();
}

function isResumeHeading(line) {
  const l = String(line || "")
    .trim()
    .replace(/[.:;|•\-–—：]+$/g, "")
    .toLowerCase();

  const headings = [
    "резюме",
    "resume",
    "cv",
    "c.v.",
    "curriculum vitae",
    "curriculum",
    "lebenslauf",
    "bewerbung",
    "currículo",
    "curriculo",
    "hoja de vida",
    "profil",
    "życiorys",
    "zyciorys",
    "履历",
    "履歷",
    "简历",
    "簡歷",
    "个人简历",
    "個人簡歷",
    "个人履历",
    "個人履歷",
    "이력서",
    "職務経歴書",
    "職歴",
    "السيرة الذاتية",
    "سيرة ذاتية"
  ];

  return headings.includes(l);
}

function isContactLine(line) {
  return /email|e-mail|mail|почта|пошта|телефон|тел|phone|mobile|mob|tel|contact|contacts|контакти|контакт|telefono|teléfono|téléphone|telefon|telefone|电话|手機|手机|邮箱|電子郵件|邮件|連絡先|联系方式|الهاتف|بريد|@|\+?\d[\d\s().-]{7,}\d/i.test(
    String(line || "")
  );
}

function looksLikeLocationLabel(line) {
  return /(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|adresse|ville|pays|dirección|ciudad|país|endereço|cidade|país|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/i.test(
    String(line || "")
  );
}

function looksLikeLocation(line) {
  const clean = normaliseLine(line);
  if (!clean) return false;
  if (clean.length > 100) return false;
  if (/@/.test(clean)) return false;
  if (/\+?\d[\d\s().-]{7,}\d/.test(clean)) return false;

  if (looksLikeLocationLabel(clean)) return true;

  if (/^[\p{L}\p{M}\s.'’ʼ-]+,\s*[\p{L}\p{M}\s.'’ʼ-]+$/u.test(clean)) {
    return true;
  }

  if (/[\u3400-\u9FFF]/.test(clean) && /(市|省|区|縣|县|國|国|中国|台灣|台湾|香港|北京|上海|深圳|广州|廣州)/.test(clean)) {
    return true;
  }

  const commonLocationWords =
    /(ukraine|україна|украина|poland|polska|germany|deutschland|france|italy|spain|canada|usa|united states|united kingdom|england|china|中国|japan|日本|korea|한국|romania|moldova|молдова|turkey|türkiye|netherlands|ireland|australia|city|місто|город|stadt|ville|ciudad|cidade)/i;

  if (commonLocationWords.test(clean)) return true;

  return false;
}

function looksLikeJobTitleOrHeading(line) {
  const lower = normaliseLine(line).toLowerCase();

  if (!lower) return true;

  const banned = [
    "resume",
    "cv",
    "curriculum",
    "vitae",
    "profile",
    "email",
    "phone",
    "contact",
    "contacts",
    "address",
    "location",
    "education",
    "experience",
    "skills",
    "languages",
    "objective",
    "summary",
    "about me",
    "work experience",
    "employment",
    "personal information",
    "career objective",
    "резюме",
    "профіль",
    "профиль",
    "контакти",
    "контакт",
    "телефон",
    "пошта",
    "досвід",
    "опыт",
    "освіта",
    "образование",
    "навички",
    "навыки",
    "мови",
    "языки",
    "локація",
    "адреса",
    "адрес",
    "бажана посада",
    "желаемая должность",
    "дані",
    "данные",
    "lebenslauf",
    "ausbildung",
    "berufserfahrung",
    "kenntnisse",
    "fähigkeiten",
    "profil",
    "erfahrung",
    "wykształcenie",
    "doświadczenie",
    "umiejętności",
    "języki",
    "edukacja",
    "experiencia",
    "educación",
    "habilidades",
    "idiomas",
    "formation",
    "expérience",
    "compétences",
    "langues",
    "教育",
    "经验",
    "經驗",
    "工作经历",
    "工作經歷",
    "技能",
    "语言",
    "語言",
    "个人信息",
    "個人信息",
    "联系方式",
    "聯繫方式",
    "連絡先",
    "学歴",
    "職歴",
    "スキル",
    "言語",
    "학력",
    "경력",
    "기술",
    "언어",
    "التعليم",
    "الخبرة",
    "المهارات",
    "اللغات",
    "social worker",
    "customer support",
    "chat operator",
    "teacher",
    "care assistant",
    "cleaner",
    "manager",
    "developer",
    "designer",
    "recruiter",
    "administrator",
    "consultant",
    "coordinator",
    "operator",
    "specialist",
    "assistant",
    "engineer",
    "accountant",
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
    "прибиральниця",
    "вихователь",
    "cover letter"
  ];

  if (banned.some(w => lower.includes(w))) return true;

  if (/^\d{4}\s*[-–—]\s*\d{4}/.test(lower)) return true;
  if (/^\d{4}\s*[-–—]\s*(present|now|current|тепер|дотепер|obecnie|aktuell|现在|現在)/i.test(lower)) return true;

  return false;
}

function isMostlySymbolsOrNumbers(line) {
  const clean = normaliseLine(line);
  if (!clean) return true;

  const letters = clean.match(/\p{L}/gu) || [];
  const digits = clean.match(/\d/g) || [];

  if (letters.length === 0) return true;
  if (digits.length > letters.length) return true;

  return false;
}

function looksLikeName(line) {
  const clean = normaliseLine(line);

  if (!clean) return false;
  if (clean.length < 2 || clean.length > 80) return false;
  if (isContactLine(clean)) return false;
  if (looksLikeLocation(clean)) return false;
  if (looksLikeJobTitleOrHeading(clean)) return false;
  if (/https?:|www\.|linkedin|telegram|facebook|instagram|github/i.test(clean)) return false;
  if (/\d{2,}/.test(clean)) return false;
  if (isMostlySymbolsOrNumbers(clean)) return false;

  const hasCjk = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(clean);

  if (hasCjk) {
    const onlyCjkNameChars = /^[\p{L}\p{M}\s.'’ʼ・·-]+$/u.test(clean);
    if (!onlyCjkNameChars) return false;

    const compact = clean.replace(/\s+/g, "");
    if (compact.length < 2 || compact.length > 20) return false;

    return true;
  }

  const words = clean.split(" ").filter(Boolean);

  if (words.length < 2 || words.length > 5) return false;

  const letterWords = words.filter(w =>
    /^[\p{L}\p{M}'’ʼ.-]+$/u.test(w)
  );

  if (letterWords.length !== words.length) return false;

  const longEnough = words.filter(w => {
    const letters = w.replace(/[^\p{L}\p{M}]/gu, "");
    return letters.length >= 2;
  });

  if (longEnough.length < 2) return false;

  return true;
}

function extractNameAfterResumeHeading(lines) {
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    if (!isResumeHeading(lines[i])) continue;

    for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
      const candidate = normaliseLine(lines[j]);

      if (!candidate) continue;
      if (isResumeHeading(candidate)) continue;
      if (isContactLine(candidate)) continue;
      if (looksLikeLocation(candidate)) continue;

      if (looksLikeName(candidate)) {
        return titleCaseName(candidate);
      }
    }
  }

  return "";
}

function extractNameBeforeContacts(lines) {
  const contactIndex = lines.findIndex(line => isContactLine(line));
  const end = contactIndex === -1 ? Math.min(lines.length, 30) : Math.min(contactIndex, 30);
  const candidates = [];

  for (let i = 0; i < end; i++) {
    const line = lines[i];

    if (isResumeHeading(line)) continue;
    if (looksLikeLocation(line)) continue;

    if (looksLikeName(line)) {
      candidates.push({
        value: line,
        score: 100 - i * 5 + (line === line.toUpperCase() ? 10 : 0)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  return candidates.length ? titleCaseName(candidates[0].value) : "";
}

function nameFromEmail(email) {
  if (!email) return "";

  const local = String(email).split("@")[0] || "";
  if (!local || /\d{4,}/.test(local)) return "";

  const parts = local
    .replace(/[._-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .filter(p => p.length >= 2 && !/^\d+$/.test(p));

  if (parts.length < 2 || parts.length > 3) return "";

  return parts
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

function fallbackName(text) {
  const raw = String(text || "");
  const lines = getLines(raw).slice(0, 150);

  const direct = raw.match(
    /(?:^|\n|\r)\s*(РЕЗЮМЕ|RESUME|C\.?V\.?|CV|CURRICULUM VITAE|LEBENSLAUF|履历|履歷|简历|簡歷|个人简历|個人簡歷|이력서|職務経歴書|السيرة الذاتية)\s*(?:\n|\r)+\s*([^\n\r]{2,80})/iu
  );

  if (direct && direct[2] && looksLikeName(direct[2])) {
    return titleCaseName(direct[2]);
  }

  const afterResume = extractNameAfterResumeHeading(lines);
  if (afterResume) return afterResume;

  const beforeContacts = extractNameBeforeContacts(lines);
  if (beforeContacts) return beforeContacts;

  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const line = lines[i];

    const splitByDash = line.split(/\s+[—–-]\s+/);
    if (splitByDash.length >= 2 && looksLikeName(splitByDash[0])) {
      return titleCaseName(splitByDash[0]);
    }
  }

  return nameFromEmail(firstEmail(raw));
}

function removeLocationLabel(line) {
  return String(line || "")
    .replace(/(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|ville|pays|dirección|ciudad|país|endereço|cidade|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/ig, "")
    .replace(/[:：\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackLocation(text) {
  const raw = String(text || "");
  const lines = getLines(raw).slice(0, 120);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksLikeLocationLabel(line)) {
      const sameLine = removeLocationLabel(line);

      if (
        sameLine &&
        sameLine.length < 100 &&
        !isContactLine(sameLine) &&
        !looksLikeJobTitleOrHeading(sameLine)
      ) {
        return sameLine;
      }

      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const next = lines[j];

        if (
          next &&
          next.length < 100 &&
          !isContactLine(next) &&
          !isResumeHeading(next) &&
          !looksLikeJobTitleOrHeading(next)
        ) {
          return next;
        }
      }
    }
  }

  const name = fallbackName(raw);
  const nameIndex = name
    ? lines.findIndex(line => normaliseLine(line).toLowerCase() === normaliseLine(name).toLowerCase())
    : -1;

  if (nameIndex !== -1) {
    for (let j = nameIndex + 1; j <= nameIndex + 4 && j < lines.length; j++) {
      const candidate = lines[j];

      if (!candidate) continue;
      if (isContactLine(candidate)) continue;
      if (isResumeHeading(candidate)) continue;
      if (looksLikeJobTitleOrHeading(candidate)) continue;
      if (looksLikeName(candidate)) continue;

      if (looksLikeLocation(candidate)) return candidate;

      if (
        candidate.length <= 80 &&
        /^[\p{L}\p{M}\s.'’ʼ,，-]+$/u.test(candidate) &&
        /[,，]/.test(candidate)
      ) {
        return candidate;
      }
    }
  }

  for (const line of lines.slice(0, 40)) {
    if (isResumeHeading(line)) continue;
    if (isContactLine(line)) continue;
    if (looksLikeName(line)) continue;
    if (looksLikeJobTitleOrHeading(line)) continue;

    if (looksLikeLocation(line)) return line;
  }

  return "";
}

function fallbackLanguages(text) {
  const lines = getLines(text);
  const idx = lines.findIndex(l =>
    /(languages|language|мови|языки|języki|sprachen|langues|idiomas|línguas|语言|語言|言語|언어|اللغات)/i.test(l)
  );

  if (idx !== -1) {
    const next = lines.slice(idx, idx + 5).join(", ");
    return next
      .replace(/languages|language|мови|языки|języki|sprachen|langues|idiomas|línguas|语言|語言|言語|언어|اللغات/ig, "")
      .replace(/[:：\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  const found = [];
  const langs = [
    "English", "Ukrainian", "Russian", "Polish", "German", "French", "Spanish", "Italian", "Chinese", "Japanese", "Korean", "Arabic",
    "Англійська", "Українська", "Російська", "Польська", "Німецька", "Французька", "Іспанська", "Китайська",
    "английский", "украинский", "русский", "польский", "немецкий", "французский", "испанский", "китайский",
    "中文", "普通话", "漢語", "汉语", "日本語", "한국어", "العربية"
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

  if (!out.name && fb.name) out.name = fb.name;
  if (!out.location && fb.location) out.location = fb.location;
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

  const firstLines = getLines(text).slice(0, 80).join("\n");

  const system = `
You are a strict multilingual CV parsing assistant.

Return JSON only.

The CV may be written in any language, including English, Ukrainian, Russian, Polish, German, French, Spanish, Portuguese, Italian, Chinese, Japanese, Korean, Arabic or mixed languages.

Extract the candidate profile from the CV text.

Critical rules:
- Do not invent information.
- Keep the person's real name exactly as written, but normalise full uppercase names into normal readable case when appropriate.
- If the CV begins with a heading like "РЕЗЮМЕ", "RESUME", "CV", "Curriculum Vitae", "Lebenslauf", "简历", "履历", "個人簡歷", "이력서", "職務経歴書", or Arabic CV headings, the next meaningful line is often the candidate name.
- Detect candidate name in any writing system: Latin, Cyrillic, Chinese, Japanese, Korean, Arabic, etc.
- Do not confuse candidate name with job title, CV heading, section heading, education heading, company name, city, country, email, phone number or website.
- Detect location in any language or writing system. It may be a city, country, region, province, state or address line.
- Do not force the location into English. Keep it in the CV language if written that way.
- Extract email and phone if present.
- Extract target / desired role if present.
- Extract languages if present.
- Split education:
  education = university / school / institution name;
  speciality = degree / speciality / qualification / profession.
- Keep experience, volunteering and courses as arrays.
- Empty unknown fields must be empty strings, not null.
- If something is not clearly present in the CV, leave it empty.

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
${text.slice(0, 18000)}
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
        firstLines: getLines(text).slice(0, 80),
        detectedNameFallback: fallbackName(text),
        detectedLocationFallback: fallbackLocation(text),
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
      firstLines: getLines(text).slice(0, 80),
      detectedNameFallback: fallbackName(text),
      detectedLocationFallback: fallbackLocation(text),
      filename: file.filename
    });

  } catch (error) {
    return sendJson(res, 200, {
      profile: fallbackProfile(""),
      warning: "CV analysis fallback mode.",
      details: error && error.message ? error.message : String(error)
    });
  }
}
