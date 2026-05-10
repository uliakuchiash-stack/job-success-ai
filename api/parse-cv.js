export const config = {
  api: {
    bodyParser: false
  }
};

import mammoth from "mammoth";
import pdfParse from "pdf-parse";

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
    .replace(/\n{4,}/g, "\n\n")
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
    /(?:телефон|тел|phone|mobile|mob|tel|telefono|teléfono|téléphone|telefon|telefone|contact|contacts|контакти|контакт|номер|phone number|电话|手機|手机|الهاتف|رقم الهاتف)\s*[:：\-–—]?\s*(\+?\d[\d\s().-]{7,}\d)/i
  );

  if (labelled && labelled[1]) {
    return labelled[1].replace(/\s{2,}/g, " ").trim();
  }

  const m = String(text || "").match(/(\+?\d[\d\s().-]{7,}\d)/);
  return m ? m[1].replace(/\s{2,}/g, " ").trim() : "";
}

function titleCaseName(value) {
  const raw = String(value || "").trim();

  if (/[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(raw)) {
    return raw;
  }

  return raw
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map(word =>
      word
        .split("-")
        .map(part => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ""))
        .join("-")
    )
    .join(" ")
    .trim();
}

function isContactLine(line) {
  return /email|e-mail|mail|почта|пошта|телефон|тел|phone|mobile|mob|tel|contact|contacts|контакти|контакт|telefono|teléfono|téléphone|telefon|telefone|邮箱|電子郵件|邮件|連絡先|联系方式|الهاتف|بريد|@|\+?\d[\d\s().-]{7,}\d/i.test(
    String(line || "")
  );
}

function isResumeHeading(line) {
  const l = String(line || "")
    .trim()
    .replace(/[.:;|•\-–—：]+$/g, "")
    .toLowerCase();

  return [
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
    "이력서",
    "職務経歴書",
    "السيرة الذاتية",
    "سيرة ذاتية"
  ].includes(l);
}

function looksLikeLocationLabel(line) {
  return /(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|ville|pays|dirección|ciudad|país|endereço|cidade|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/i.test(
    String(line || "")
  );
}

function removeLocationLabel(line) {
  return String(line || "")
    .replace(/(location|address|city|country|state|region|province|place|локація|адреса|місто|країна|область|адрес|город|страна|регион|województwo|miasto|kraj|adres|ort|adresse|stadt|land|ville|pays|dirección|ciudad|país|endereço|cidade|地址|城市|国家|國家|所在地|住所|地點|地点|居住地|지역|주소|المدينة|الدولة|العنوان)/ig, "")
    .replace(/[:：\-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeLocation(line) {
  const clean = normaliseLine(line);
  if (!clean) return false;
  if (clean.length > 120) return false;
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
    /(ukraine|україна|украина|poland|polska|germany|deutschland|france|italy|spain|canada|usa|united states|united kingdom|england|china|中国|japan|日本|korea|한국|romania|moldova|молдова|turkey|türkiye|netherlands|ireland|australia|city|місто|город|stadt|ville|ciudad|cidade|одеса|київ|львів|харків|варшава|berlin|london|paris|madrid|rome)/i;

  return commonLocationWords.test(clean);
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
  if (clean.length < 2 || clean.length > 90) return false;
  if (isContactLine(clean)) return false;
  if (looksLikeLocation(clean)) return false;
  if (looksLikeJobTitleOrHeading(clean)) return false;
  if (/https?:|www\.|linkedin|telegram|facebook|instagram|github/i.test(clean)) return false;
  if (/\d{2,}/.test(clean)) return false;
  if (isMostlySymbolsOrNumbers(clean)) return false;

  const hasCjk = /[\u3400-\u9FFF\u3040-\u30FF\uAC00-\uD7AF]/.test(clean);

  if (hasCjk) {
    const compact = clean.replace(/\s+/g, "");
    return compact.length >= 2 && compact.length <= 24;
  }

  const words = clean.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 5) return false;

  const letterWords = words.filter(w => /^[\p{L}\p{M}'’ʼ.-]+$/u.test(w));
  if (letterWords.length !== words.length) return false;

  const longEnough = words.filter(w => {
    const letters = w.replace(/[^\p{L}\p{M}]/gu, "");
    return letters.length >= 2;
  });

  return longEnough.length >= 2;
}

function fallbackName(text) {
  const raw = String(text || "");
  const lines = getLines(raw).slice(0, 150);

  for (let i = 0; i < Math.min(lines.length, 50); i++) {
    if (!isResumeHeading(lines[i])) continue;

    for (let j = i + 1; j <= i + 8 && j < lines.length; j++) {
      const candidate = normaliseLine(lines[j]);
      if (looksLikeName(candidate)) return titleCaseName(candidate);
    }
  }

  const contactIndex = lines.findIndex(line => isContactLine(line));
  const end = contactIndex === -1 ? Math.min(lines.length, 35) : Math.min(contactIndex, 35);

  const candidates = [];
  for (let i = 0; i < end; i++) {
    const candidate = normaliseLine(lines[i]);
    if (isResumeHeading(candidate)) continue;
    if (looksLikeName(candidate)) {
      candidates.push({
        value: candidate,
        score: 100 - i * 5 + (candidate === candidate.toUpperCase() ? 10 : 0)
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  if (candidates.length) return titleCaseName(candidates[0].value);

  const email = firstEmail(raw);
  if (email) {
    const local = email.split("@")[0];
    const parts = local
      .replace(/[._-]+/g, " ")
      .split(" ")
      .filter(p => p.length >= 2 && !/^\d+$/.test(p));

    if (parts.length >= 2 && parts.length <= 3) {
      return parts.map(x => x.charAt(0).toUpperCase() + x.slice(1).toLowerCase()).join(" ");
    }
  }

  return "";
}

function fallbackLocation(text) {
  const raw = String(text || "");
  const lines = getLines(raw).slice(0, 150);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (looksLikeLocationLabel(line)) {
      const sameLine = removeLocationLabel(line);

      if (
        sameLine &&
        sameLine.length < 120 &&
        !isContactLine(sameLine) &&
        !looksLikeJobTitleOrHeading(sameLine)
      ) {
        return sameLine;
      }

      for (let j = i + 1; j <= i + 3 && j < lines.length; j++) {
        const next = lines[j];

        if (
          next &&
          next.length < 120 &&
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
    for (let j = nameIndex + 1; j <= nameIndex + 6 && j < lines.length; j++) {
      const candidate = lines[j];

      if (!candidate) continue;
      if (isContactLine(candidate)) continue;
      if (isResumeHeading(candidate)) continue;
      if (looksLikeJobTitleOrHeading(candidate)) continue;
      if (looksLikeName(candidate)) continue;

      if (looksLikeLocation(candidate)) return candidate;
    }
  }

  for (const line of lines.slice(0, 60)) {
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
    const next = lines.slice(idx, idx + 6).join(", ");
    const cleaned = next
      .replace(/languages|language|мови|языки|języki|sprachen|langues|idiomas|línguas|语言|語言|言語|언어|اللغات/ig, "")
      .replace(/[:：\-–—]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (cleaned) return cleaned;
  }

  const found = [];
  const langs = [
    "English", "Ukrainian", "Russian", "Polish", "German", "French", "Spanish", "Italian", "Portuguese", "Dutch", "Romanian", "Chinese", "Japanese", "Korean", "Arabic",
    "Англійська", "Українська", "Російська", "Польська", "Німецька", "Французька", "Іспанська", "Китайська",
    "английский", "украинский", "русский", "польский", "немецкий", "французский", "испанский", "китайский",
    "中文", "普通话", "漢語", "汉语", "日本語", "한국어", "العربية"
  ];

  for (const lang of langs) {
    if (new RegExp(lang, "i").test(text)) found.push(lang);
  }

  return [...new Set(found)].join(", ");
}

function sectionText(text, headings, stopHeadings) {
  const lines = getLines(text);
  const start = lines.findIndex(line => headings.some(h => new RegExp(h, "i").test(line)));

  if (start === -1) return "";

  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];

    if (stopHeadings.some(h => new RegExp(h, "i").test(line))) break;
    out.push(line);
    if (out.join(" ").length > 1600) break;
  }

  return cleanText(out.join("\n"));
}

function fallbackEducation(text) {
  return sectionText(
    text,
    ["education", "освіта", "образование", "edukacja", "wykształcenie", "ausbildung", "formation", "educación", "學歷", "学歴", "التعليم"],
    ["experience", "досвід", "опыт", "skills", "навички", "languages", "мови", "courses", "certificates", "work", "employment"]
  );
}

function fallbackSkills(text) {
  return sectionText(
    text,
    ["skills", "навички", "навыки", "umiejętności", "fähigkeiten", "competences", "compétences", "habilidades", "技能", "المهارات"],
    ["experience", "досвід", "education", "освіта", "languages", "мови", "courses", "certificates", "work", "employment"]
  );
}

function fallbackExperience(text) {
  const expText = sectionText(
    text,
    ["experience", "work experience", "employment", "досвід", "опыт", "досвід роботи", "berufserfahrung", "doświadczenie", "experiencia", "expérience", "工作经历", "職歴", "الخبرة"],
    ["education", "освіта", "образование", "skills", "навички", "languages", "мови", "courses", "certificates"]
  );

  if (!expText) return [];

  const chunks = expText
    .split(/\n(?=\d{4}|[A-ZА-ЯІЇЄҐ][^\n]{3,80})/g)
    .map(x => cleanText(x))
    .filter(Boolean)
    .slice(0, 5);

  return chunks.map(chunk => {
    const lines = getLines(chunk);
    const first = lines[0] || "";
    const rest = lines.slice(1).join("\n");

    let company = "";
    let position = first;

    if (first.includes(" - ") || first.includes(" — ") || first.includes(" – ")) {
      const parts = first.split(/\s[-–—]\s/);
      position = parts[0] || "";
      company = parts.slice(1).join(" - ");
    }

    return {
      company: cleanText(company),
      position: cleanText(position),
      desc: cleanText(rest || chunk)
    };
  }).filter(x => x.company || x.position || x.desc);
}

function fallbackCourses(text) {
  const courseText = sectionText(
    text,
    ["courses", "certificates", "certifications", "курси", "сертифікати", "курсы", "сертификаты", "szkolenia", "certyfikaty", "zertifikate"],
    ["experience", "education", "skills", "languages", "досвід", "освіта", "навички", "мови"]
  );

  if (!courseText) return [];

  return getLines(courseText).slice(0, 8).map(line => ({
    name: line,
    place: "",
    period: "",
    desc: ""
  }));
}

function fallbackProfile(text) {
  const name = fallbackName(text);
  const email = firstEmail(text);
  const phone = firstPhone(text);
  const location = fallbackLocation(text);
  const languages = fallbackLanguages(text);
  const education = fallbackEducation(text);
  const skills = fallbackSkills(text);
  const experience = fallbackExperience(text);
  const courses = fallbackCourses(text);

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

    languages,
    education,
    speciality: "",
    skills,
    softSkills: "",
    soft_skills: "",
    hobbies: "",

    experience,
    volunteering: [],
    courses
  };
}

function forceFallbackFields(profile, text) {
  const fb = fallbackProfile(text);

  if (!profile.name && fb.name) profile.name = fb.name;
  if (!profile.fullName && profile.name) profile.fullName = profile.name;
  if (!profile.full_name && profile.name) profile.full_name = profile.name;
  if (!profile.candidateName && profile.name) profile.candidateName = profile.name;
  if (!profile.candidate_name && profile.name) profile.candidate_name = profile.name;

  if (!profile.email && fb.email) profile.email = fb.email;
  if (!profile.phone && fb.phone) profile.phone = fb.phone;

  if (!profile.location && fb.location) profile.location = fb.location;
  if (!profile.city && profile.location) profile.city = profile.location;
  if (!profile.address && profile.location) profile.address = profile.location;

  if (!profile.languages && fb.languages) profile.languages = fb.languages;
  if (!profile.education && fb.education) profile.education = fb.education;
  if (!profile.skills && fb.skills) profile.skills = fb.skills;

  if ((!profile.experience || !profile.experience.length) && fb.experience.length) {
    profile.experience = fb.experience;
  }

  if ((!profile.courses || !profile.courses.length) && fb.courses.length) {
    profile.courses = fb.courses;
  }

  return profile;
}

function normalizeProfile(p, text) {
  const fb = fallbackProfile(text);
  const profile = p && typeof p === "object" ? p : {};

  let name = cleanText(
    profile.name ||
    profile.fullName ||
    profile.full_name ||
    profile.candidateName ||
    profile.candidate_name ||
    fb.name
  );

  let location = cleanText(
    profile.location ||
    profile.city ||
    profile.address ||
    fb.location
  );

  const target = cleanText(
    profile.target ||
    profile.jobTitle ||
    profile.job_title ||
    profile.position ||
    fb.target ||
    ""
  );

  const out = {
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
    education: cleanText(profile.education || profile.institution || fb.education),
    speciality: cleanText(profile.speciality || profile.degree || profile.qualification || ""),
    skills: cleanText(profile.skills || fb.skills),
    softSkills: cleanText(profile.softSkills || profile.soft_skills || ""),
    soft_skills: cleanText(profile.softSkills || profile.soft_skills || ""),
    hobbies: cleanText(profile.hobbies || ""),

    experience: Array.isArray(profile.experience) ? profile.experience : fb.experience,
    volunteering: Array.isArray(profile.volunteering) ? profile.volunteering : [],
    courses: Array.isArray(profile.courses) ? profile.courses : fb.courses
  };

  forceFallbackFields(out, text);

  out.name = cleanText(out.name || fallbackName(text));
  out.fullName = out.name;
  out.full_name = out.name;
  out.candidateName = out.name;
  out.candidate_name = out.name;

  out.location = cleanText(out.location || fallbackLocation(text));
  out.city = out.location;
  out.address = out.location;

  out.email = cleanText(out.email || firstEmail(text));
  out.phone = cleanText(out.phone || firstPhone(text));
  out.languages = cleanText(out.languages || fallbackLanguages(text));

  out.experience = (Array.isArray(out.experience) ? out.experience : []).map(x => ({
    company: cleanText(x.company || x.organisation || x.organization || x.employer || ""),
    position: cleanText(x.position || x.role || x.title || ""),
    desc: cleanText(x.desc || x.description || x.responsibilities || x.details || "")
  })).filter(x => x.company || x.position || x.desc);

  out.volunteering = (Array.isArray(out.volunteering) ? out.volunteering : []).map(x => ({
    org: cleanText(x.org || x.organisation || x.organization || ""),
    role: cleanText(x.role || x.position || ""),
    desc: cleanText(x.desc || x.description || "")
  })).filter(x => x.org || x.role || x.desc);

  out.courses = (Array.isArray(out.courses) ? out.courses : []).map(x => ({
    name: cleanText(x.name || x.course || x.title || ""),
    place: cleanText(x.place || x.organisation || x.organization || x.school || x.provider || ""),
    period: cleanText(x.period || x.year || x.date || ""),
    desc: cleanText(x.desc || x.description || "")
  })).filter(x => x.name || x.place || x.period || x.desc);

  return out;
}

async function extractTextFromDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return cleanText(result.value || "");
}

async function extractTextFromPdf(buffer) {
  const result = await pdfParse(buffer);
  return cleanText(result.text || "");
}

async function extractText(file) {
  const filename = String(file.filename || "").toLowerCase();
  const type = String(file.contentType || "").toLowerCase();

  if (filename.endsWith(".txt") || type.includes("text/plain")) {
    return cleanText(file.buffer.toString("utf8"));
  }

  if (filename.endsWith(".docx") || type.includes("wordprocessingml")) {
    return await extractTextFromDocx(file.buffer);
  }

  if (filename.endsWith(".pdf") || type.includes("pdf")) {
    return await extractTextFromPdf(file.buffer);
  }

  if (filename.endsWith(".doc")) {
    return "";
  }

  try {
    return cleanText(file.buffer.toString("utf8"));
  } catch (e) {
    return "";
  }
}

async function analyseWithOpenAI(text, language) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing");
  }

  const firstLines = getLines(text).slice(0, 120).join("\n");

  const system = `
You are a strict multilingual CV parsing assistant.

Return JSON only.

The CV may be written in any language, including English, Ukrainian, Russian, Polish, German, French, Spanish, Portuguese, Italian, Chinese, Japanese, Korean, Arabic or mixed languages.

Extract the candidate profile from the CV text.

Critical rules:
- Do not invent information.
- Extract every useful field that is clearly present.
- Keep the person's real name exactly as written, but normalise full uppercase names into normal readable case when appropriate.
- If the CV begins with a heading like "РЕЗЮМЕ", "RESUME", "CV", "Curriculum Vitae", "Lebenslauf", "简历", "履历", "個人簡歷", "이력서", "職務経歴書", or Arabic CV headings, the next meaningful line is often the candidate name.
- Detect candidate name in any writing system: Latin, Cyrillic, Chinese, Japanese, Korean, Arabic, etc.
- Do not confuse candidate name with job title, CV heading, section heading, education heading, company name, city, country, email, phone number or website.
- Detect location in any language or writing system. It may be a city, country, region, province, state or address line.
- Do not force the location into English. Keep it in the CV language if written that way.
- Extract email and phone if present.
- Extract target / desired role if present.
- Extract languages if present.
- Extract professional skills and soft skills if present.
- Extract hobbies/interests if present.
- Split education:
  education = university / school / institution name;
  speciality = degree / speciality / qualification / profession.
- Keep experience, volunteering and courses as arrays.
- For experience: company, position and description/responsibilities must be filled when present.
- Empty unknown fields must be empty strings, not null.
- If something is not clearly present in the CV, leave it empty.

Return exactly:
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
${text.slice(0, 22000)}
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

function fileReadWarning(file, text) {
  const filename = String(file.filename || "").toLowerCase();

  if (filename.endsWith(".doc")) {
    return "Old .doc files are not supported. Please save as .docx or PDF with selectable text.";
  }

  if (filename.endsWith(".pdf") && (!text || text.length < 10)) {
    return "Could not read text from this PDF. It may be a scanned/image PDF. Please upload DOCX, TXT, or a PDF with selectable text.";
  }

  if (!text || text.length < 10) {
    return "Could not read enough text from this CV. Please try DOCX, TXT, or PDF with selectable text.";
  }

  return "";
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

    let text = "";

    try {
      text = await extractText(file);
    } catch (e) {
      text = "";
    }

    text = cleanText(text);

    const basicProfile = forceFallbackFields(fallbackProfile(text), text);
    const warning = fileReadWarning(file, text);

    if (!text || text.length < 10) {
      return sendJson(res, 200, {
        profile: basicProfile,
        warning,
        rawTextPreview: text.slice(0, 1200),
        firstLines: getLines(text).slice(0, 100),
        detectedNameFallback: fallbackName(text),
        detectedLocationFallback: fallbackLocation(text),
        filename: file.filename,
        fileType: file.contentType || "",
        textLength: text.length
      });
    }

    let aiProfile = null;
    let aiWarning = "";

    try {
      const ai = await analyseWithOpenAI(text, language);
      aiProfile = ai?.profile || ai;
    } catch (e) {
      aiProfile = null;
      aiWarning = e && e.message ? e.message : "AI analysis failed, fallback used.";
    }

    const profile = normalizeProfile(aiProfile, text);

    return sendJson(res, 200, {
      profile,
      warning: warning || aiWarning || "",
      rawTextPreview: text.slice(0, 1200),
      firstLines: getLines(text).slice(0, 100),
      detectedNameFallback: fallbackName(text),
      detectedLocationFallback: fallbackLocation(text),
      filename: file.filename,
      fileType: file.contentType || "",
      textLength: text.length
    });
  } catch (error) {
    return sendJson(res, 200, {
      profile: forceFallbackFields(fallbackProfile(""), ""),
      warning: "CV analysis fallback mode.",
      details: error && error.message ? error.message : String(error)
    });
  }
}
