export const config = {
  api: {
    bodyParser: false
  }
};

import mammoth from "mammoth";
import pdfParse from "pdf-parse";
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
  return cleanText(decodeXmlEntities(s));
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

function extractTextFromDocxFallback(buffer) {
  try {
    const entries = extractZipEntries(buffer);
    const parts = [];
    const importantXmlFiles = [
      "word/document.xml",
      "word/header1.xml",
      "word/header2.xml",
      "word/header3.xml",
      "word/footer1.xml",
      "word/footer2.xml",
      "word/footer3.xml"
    ];

    for (const key of importantXmlFiles) {
      if (entries[key]) {
        const value = stripXml(entries[key].toString("utf8"));
        if (value) parts.push(value);
      }
    }

    for (const key of Object.keys(entries)) {
      if (
        /^word\/(header|footer)\d*\.xml$/i.test(key) ||
        /^word\/footnotes\.xml$/i.test(key) ||
        /^word\/endnotes\.xml$/i.test(key)
      ) {
        const value = stripXml(entries[key].toString("utf8"));
        if (value && !parts.includes(value)) parts.push(value);
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
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
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

function extractTextFromPdfFallback(buffer) {
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

function extractTextFromRtf(buffer) {
  const raw = buffer.toString("utf8");
  return cleanText(
    raw
      .replace(/\\'[0-9a-fA-F]{2}/g, " ")
      .replace(/\\[a-z]+\d* ?/gi, " ")
      .replace(/[{}]/g, " ")
  );
}

async function extractText(file) {
  const filename = String(file.filename || "").toLowerCase();
  const type = String(file.contentType || "").toLowerCase();

  if (filename.endsWith(".txt") || type.includes("text/plain")) {
    return cleanText(file.buffer.toString("utf8"));
  }

  if (filename.endsWith(".rtf") || type.includes("rtf")) {
    return extractTextFromRtf(file.buffer);
  }

  if (filename.endsWith(".docx") || type.includes("wordprocessingml")) {
    let text = "";
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      text = cleanText(result.value || "");
    } catch (e) {}
    if (!text || text.length < 10) text = extractTextFromDocxFallback(file.buffer);
    return cleanText(text);
  }

  if (filename.endsWith(".pdf") || type.includes("pdf")) {
    let text = "";
    try {
      const result = await pdfParse(file.buffer);
      text = cleanText(result.text || "");
    } catch (e) {}
    if (!text || text.length < 10) text = extractTextFromPdfFallback(file.buffer);
    return cleanText(text);
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
  if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF]/.test(raw)) return raw;

  return raw
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(word =>
      word
        .split("-")
        .map(part => part ? part.charAt(0).toUpperCase() + part.slice(1) : "")
        .join("-")
    )
    .join(" ")
    .trim();
}

function isResumeHeading(line) {
  const l = String(line || "").trim().replace(/[.:;|•\-–—：]+$/g, "").toLowerCase();
  return [
    "резюме", "resume", "cv", "c.v.", "curriculum vitae", "curriculum",
    "lebenslauf", "bewerbung", "currículo", "curriculo", "hoja de vida",
    "profil", "życiorys", "zyciorys", "履历", "履歷", "简历", "簡歷",
    "个人简历", "個人簡歷", "이력서", "職務経歴書", "職歴",
    "السيرة الذاتية", "سيرة ذاتية"
  ].includes(l);
}

function isContactLine(line) {
  return /email|e-mail|mail|почта|пошта|телефон|тел|phone|mobile|mob|tel|contact|contacts|контакти|контакт|telefono|teléfono|téléphone|telefon|telefone|电话|手機|手机|邮箱|電子郵件|邮件|連絡先|联系方式|الهاتف|بريد|@|\+?\d[\d\s().-]{7,}\d/i.test(String(line || ""));
}

function looksLikeLocationLabel(line) {
  return /(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|ville|pays|dirección|ciudad|país|endereço|cidade|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/i.test(String(line || ""));
}

function looksLikeLocation(line) {
  const clean = normaliseLine(line);
  if (!clean || clean.length > 120) return false;
  if (/@/.test(clean)) return false;
  if (/\+?\d[\d\s().-]{7,}\d/.test(clean)) return false;
  if (looksLikeLocationLabel(clean)) return true;

  if (/^[\p{L}\p{M}\s.'’ʼ-]+,\s*[\p{L}\p{M}\s.'’ʼ-]+$/u.test(clean)) return true;

  const commonLocationWords =
    /(ukraine|україна|украина|poland|polska|germany|deutschland|france|italy|spain|canada|usa|united states|united kingdom|england|china|中国|japan|日本|korea|한국|romania|moldova|молдова|turkey|türkiye|netherlands|ireland|australia|city|місто|город|stadt|ville|ciudad|cidade)/i;

  return commonLocationWords.test(clean);
}

function isSectionHeading(line) {
  const lower = normaliseLine(line).toLowerCase();
  if (!lower) return true;

  const headings = [
    "resume", "cv", "curriculum", "vitae", "profile", "email", "phone",
    "contact", "contacts", "address", "location", "education", "experience",
    "skills", "languages", "objective", "summary", "about me", "work experience",
    "employment", "personal information", "career objective",
    "резюме", "профіль", "профиль", "контакти", "контакт", "телефон", "пошта",
    "досвід", "опыт", "освіта", "образование", "навички", "навыки", "мови",
    "языки", "локація", "адреса", "адрес", "бажана посада", "желаемая должность",
    "lebenslauf", "ausbildung", "berufserfahrung", "kenntnisse", "fähigkeiten",
    "profil", "erfahrung", "wykształcenie", "doświadczenie", "umiejętności",
    "języki", "edukacja", "experiencia", "educación", "habilidades", "idiomas",
    "formation", "expérience", "compétences", "langues",
    "教育", "经验", "經驗", "工作经历", "工作經歷", "技能", "语言", "語言",
    "个人信息", "個人信息", "联系方式", "聯繫方式", "連絡先", "学歴",
    "職歴", "スキル", "言語", "학력", "경력", "기술", "언어",
    "التعليم", "الخبرة", "المهارات", "اللغات"
  ];

  return headings.some(w => lower === w || lower.includes(w + ":"));
}

function looksLikeJobTitle(line) {
  const lower = normaliseLine(line).toLowerCase();
  return /(social worker|customer support|chat operator|teacher|care assistant|cleaner|manager|developer|designer|recruiter|administrator|consultant|coordinator|operator|specialist|assistant|engineer|accountant|працівник|работник|оператор|вчитель|учитель|асистент|менеджер|спеціаліст|специалист|адміністратор|администратор|прибиральниця|вихователь|викладач|кухар|продавець)/i.test(lower);
}

function looksLikeName(line) {
  const clean = normaliseLine(line);
  if (!clean || clean.length < 2 || clean.length > 90) return false;
  if (isContactLine(clean)) return false;
  if (looksLikeLocation(clean)) return false;
  if (isSectionHeading(clean)) return false;
  if (looksLikeJobTitle(clean)) return false;
  if (/https?:|www\.|linkedin|telegram|facebook|instagram|github/i.test(clean)) return false;
  if (/\d{2,}/.test(clean)) return false;

  const hasCjk = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(clean);
  if (hasCjk) {
    const compact = clean.replace(/\s+/g, "");
    return compact.length >= 2 && compact.length <= 24;
  }

  const words = clean.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;
  if (!words.every(w => /^[\p{L}\p{M}'’ʼ.-]+$/u.test(w))) return false;
  return words.filter(w => w.replace(/[^\p{L}\p{M}]/gu, "").length >= 2).length >= 2;
}

function fallbackName(text) {
  const raw = String(text || "");
  const lines = getLines(raw).slice(0, 150);

  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    if (!isResumeHeading(lines[i])) continue;
    for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
      if (looksLikeName(lines[j])) return titleCaseName(lines[j]);
    }
  }

  const contactIndex = lines.findIndex(line => isContactLine(line));
  const end = contactIndex === -1 ? Math.min(lines.length, 30) : Math.min(contactIndex, 30);
  const candidates = [];

  for (let i = 0; i < end; i++) {
    if (looksLikeName(lines[i])) {
      candidates.push({ value: lines[i], score: 100 - i * 5 + (lines[i] === lines[i].toUpperCase() ? 10 : 0) });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length) return titleCaseName(candidates[0].value);

  const email = firstEmail(raw);
  if (email) {
    const local = email.split("@")[0].replace(/[._-]+/g, " ");
    if (!/\d{4,}/.test(local)) {
      const parts = local.split(" ").filter(p => p.length >= 2 && !/^\d+$/.test(p));
      if (parts.length >= 2 && parts.length <= 3) return titleCaseName(parts.join(" "));
    }
  }

  return "";
}

function removeLocationLabel(line) {
  return String(line || "")
    .replace(/(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|ville|pays|dirección|ciudad|país|endereço|cidade|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/ig, "")
    .replace(/[:：\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackLocation(text) {
  const lines = getLines(text).slice(0, 150);

  for (let i = 0; i < lines.length; i++) {
    if (!looksLikeLocationLabel(lines[i])) continue;

    const sameLine = removeLocationLabel(lines[i]);
    if (sameLine && sameLine.length < 120 && !isContactLine(sameLine) && !isSectionHeading(sameLine)) {
      return sameLine;
    }

    for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
      const next = lines[j];
      if (next && next.length < 120 && !isContactLine(next) && !isResumeHeading(next) && !isSectionHeading(next)) {
        return next;
      }
    }
  }

  for (const line of lines.slice(0, 50)) {
    if (isResumeHeading(line) || isContactLine(line) || looksLikeName(line) || isSectionHeading(line)) continue;
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
    return lines
      .slice(idx, idx + 5)
      .join(", ")
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

function extractPeriodFromLine(line) {
  const s = String(line || "");
  const m =
    s.match(/(?:\b|^)((?:19|20)\d{2}\s*(?:[-–—/]|to|до|по)\s*(?:(?:19|20)\d{2}|present|current|now|тепер|дотепер|нині|сьогодні|обecnie|obecnie|aktuell|现在|現在)|(?:19|20)\d{2})/i) ||
    s.match(/(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|січ|лют|бер|кві|тра|чер|лип|сер|вер|жов|лис|гру)[a-zа-яіїєґ.]*\s+(?:19|20)\d{2}\s*(?:[-–—/]|to|до|по)\s*(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|січ|лют|бер|кві|тра|чер|лип|сер|вер|жов|лис|гру)[a-zа-яіїєґ.]*\s+)?(?:(?:19|20)\d{2}|present|current|now|тепер|дотепер|нині|сьогодні|obecnie|aktuell)/i);
  return m ? cleanText(m[1]) : "";
}

function detectSection(line) {
  const l = normaliseLine(line).toLowerCase();
  if (/(work experience|professional experience|employment|experience|досвід роботи|опыт работы|досвід|опыт|doświadczenie|berufserfahrung|expérience|experiencia|esperienza)/i.test(l)) return "experience";
  if (/(education|освіта|образование|wykształcenie|ausbildung|formation|educación|istruzione)/i.test(l)) return "education";
  if (/(skills|навички|навыки|umiejętności|fähigkeiten|compétences|habilidades|competenze)/i.test(l)) return "skills";
  if (/(volunteer|volunteering|волонтер|волонтёр|wolontariat|ehrenamt|bénévolat|voluntariado)/i.test(l)) return "volunteering";
  if (/(course|certificate|courses|certificates|курси|сертифікати|курсы|сертификаты|kursy|zertifikat|certificat|certificado)/i.test(l)) return "courses";
  return "";
}

function extractBlocksBySection(text) {
  const lines = getLines(text);
  const sections = { experience: [], education: [], skills: [], volunteering: [], courses: [] };
  let current = "";

  for (const line of lines) {
    const section = detectSection(line);
    if (section) {
      current = section;
      continue;
    }
    if (current && line) {
      if (isSectionHeading(line) && !detectSection(line)) continue;
      sections[current].push(line);
    }
  }

  return sections;
}

function fallbackExperience(text) {
  const sections = extractBlocksBySection(text);
  const lines = sections.experience.slice(0, 80);
  const items = [];
  let current = null;

  for (const line of lines) {
    const period = extractPeriodFromLine(line);
    const possibleTitle = looksLikeJobTitle(line) || period || /^[\p{L}\p{M}\s.'’ʼ&(),-]{3,80}$/u.test(line);

    if (period || (possibleTitle && line.length < 90 && !isContactLine(line))) {
      if (current && (current.position || current.company || current.desc)) items.push(current);

      const cleanLine = cleanText(line.replace(period, "").replace(/[-–—]{2,}/g, " "));
      current = {
        company: "",
        position: "",
        period: period || "",
        dates: period || "",
        desc: ""
      };

      if (cleanLine.includes(" at ") || cleanLine.includes(" в ") || cleanLine.includes(" у ")) {
        const parts = cleanLine.split(/\s+(?:at|в|у)\s+/i);
        current.position = cleanText(parts[0] || "");
        current.company = cleanText(parts.slice(1).join(" ") || "");
      } else if (looksLikeJobTitle(cleanLine)) {
        current.position = cleanLine;
      } else {
        current.company = cleanLine;
      }

      continue;
    }

    if (current) {
      current.desc = cleanText([current.desc, line].filter(Boolean).join(" "));
    }
  }

  if (current && (current.position || current.company || current.desc)) items.push(current);

  return items
    .map(x => ({
      company: cleanText(x.company),
      position: cleanText(x.position),
      period: cleanText(x.period),
      dates: cleanText(x.dates || x.period),
      desc: cleanText(x.desc)
    }))
    .filter(x => x.company || x.position || x.period || x.desc)
    .slice(0, 8);
}

function fallbackEducation(text) {
  const sections = extractBlocksBySection(text);
  return cleanText(sections.education.slice(0, 8).join("\n"));
}

function fallbackSkills(text) {
  const sections = extractBlocksBySection(text);
  return cleanText(sections.skills.slice(0, 12).join(", "));
}

function emptyProfile(text = "") {
  const name = fallbackName(text);
  const location = fallbackLocation(text);
  const email = firstEmail(text);
  const phone = firstPhone(text);
  return {
    name,
    fullName: name,
    full_name: name,
    candidateName: name,
    candidate_name: name,
    email,
    phone,
    location,
    city: location,
    address: location,
    target: "",
    jobTitle: "",
    position: "",
    languages: fallbackLanguages(text),
    education: fallbackEducation(text),
    speciality: "",
    skills: fallbackSkills(text),
    softSkills: "",
    soft_skills: "",
    hobbies: "",
    experience: fallbackExperience(text),
    volunteering: [],
    courses: []
  };
}

function normalizeExperienceArray(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => {
      const period = cleanText(x.period || x.dates || x.date || x.years || "");
      return {
        company: cleanText(x.company || x.organisation || x.organization || ""),
        position: cleanText(x.position || x.role || ""),
        period,
        dates: period,
        desc: cleanText(x.desc || x.description || x.responsibilities || "")
      };
    })
    .filter(x => x.company || x.position || x.period || x.desc);
}

function normalizeProfile(p, text) {
  const fb = emptyProfile(text);
  const profile = p && typeof p === "object" ? p : {};

  const name = cleanText(
    profile.name || profile.fullName || profile.full_name ||
    profile.candidateName || profile.candidate_name || fb.name
  );

  const location = cleanText(profile.location || profile.city || profile.address || fb.location);
  const target = cleanText(profile.target || profile.jobTitle || profile.job_title || profile.position || "");
  let experience = normalizeExperienceArray(profile.experience);

  if (!experience.length) experience = fb.experience;

  experience = experience.map(item => {
    if (!item.period) {
      const p1 = extractPeriodFromLine(`${item.position} ${item.company} ${item.desc}`);
      item.period = p1;
      item.dates = p1;
    }
    return item;
  });

  return {
    name,
    fullName: name,
    full_name: name,
    candidateName: name,
    candidate_name: name,
    email: cleanText(profile.email || fb.email),
    phone: cleanText(profile.phone || fb.phone),
    location,
    city: location,
    address: location,
    target,
    jobTitle: target,
    position: target,
    languages: cleanText(profile.languages || fb.languages),
    education: cleanText(profile.education || fb.education),
    speciality: cleanText(profile.speciality || profile.degree || profile.qualification || ""),
    skills: cleanText(profile.skills || fb.skills),
    softSkills: cleanText(profile.softSkills || profile.soft_skills || ""),
    soft_skills: cleanText(profile.softSkills || profile.soft_skills || ""),
    hobbies: cleanText(profile.hobbies || ""),
    experience,
    volunteering: Array.isArray(profile.volunteering)
      ? profile.volunteering.map(x => ({
          org: cleanText(x.org || x.organisation || x.organization || ""),
          role: cleanText(x.role || x.position || ""),
          desc: cleanText(x.desc || x.description || "")
        })).filter(x => x.org || x.role || x.desc)
      : [],
    courses: Array.isArray(profile.courses)
      ? profile.courses.map(x => ({
          name: cleanText(x.name || x.course || ""),
          place: cleanText(x.place || x.organisation || x.organization || x.school || ""),
          period: cleanText(x.period || x.year || ""),
          desc: cleanText(x.desc || x.description || "")
        })).filter(x => x.name || x.place || x.period || x.desc)
      : []
  };
}

async function analyseWithOpenAI(text, language) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing");

  const firstLines = getLines(text).slice(0, 120).join("\n");

  const system = `
You are a strict multilingual CV parsing assistant.

Return JSON only. Do not invent anything.

Rules:
- Extract only facts that are present in the CV text.
- If a field is not present, return an empty string or empty array.
- Never create hobbies, volunteering, courses, companies, schools, or experience that are not clearly written in the CV.
- Keep the candidate name exactly as written, but normalise ALL CAPS names into readable case when appropriate.
- Do not confuse name with job title, section heading, city, country, email, phone, website, company, school, or template text.
- Extract work experience with company, position, period/dates, and description.
- If dates like 2024-2025 are present, put them in both "period" and "dates".
- Split education: education = institution/school/university; speciality = degree/speciality/qualification.
- Empty unknown fields must be empty strings, not null.

Return exactly this JSON shape:
{
  "profile": {
    "name": "",
    "fullName": "",
    "full_name": "",
    "email": "",
    "phone": "",
    "location": "",
    "city": "",
    "address": "",
    "target": "",
    "jobTitle": "",
    "position": "",
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
        "period": "",
        "dates": "",
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

  if (!response.ok) throw new Error(await response.text() || "OpenAI request failed");

  const data = await response.json();
  return safeJsonParse(data.choices?.[0]?.message?.content || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    const contentType = getHeader(req, "content-type");

    if (!String(contentType).includes("multipart/form-data")) {
      return sendJson(res, 200, {
        profile: emptyProfile(""),
        warning: "Expected multipart/form-data upload."
      });
    }

    const buffer = await readRequestBuffer(req);
    const parsed = parseMultipart(buffer, contentType);
    const file = parsed.files.find(f => f.fieldName === "file") || parsed.files[0];
    const language = parsed.fields.language || "English";

    if (!file) {
      return sendJson(res, 200, {
        profile: emptyProfile(""),
        warning: "No file uploaded."
      });
    }

    const text = await extractText(file);
    const fallback = emptyProfile(text);

    if (!text || text.length < 10) {
      return sendJson(res, 200, {
        profile: fallback,
        warning: "Could not read text from this CV. Try DOCX, TXT, or a PDF with selectable text.",
        rawTextPreview: text.slice(0, 1200),
        firstLines: getLines(text).slice(0, 100),
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
      firstLines: getLines(text).slice(0, 100),
      detectedNameFallback: fallback.name,
      detectedLocationFallback: fallback.location,
      filename: file.filename
    });
  } catch (error) {
    return sendJson(res, 200, {
      profile: emptyProfile(""),
      warning: "CV analysis fallback mode.",
      details: error && error.message ? error.message : String(error)
    });
  }
}
