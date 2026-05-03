export const config = {
  api: {
    bodyParser: false,
  },
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
    (k) => k.toLowerCase() === name.toLowerCase()
  );
  return key ? req.headers[key] : "";
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = String(contentType).match(/boundary=([^;]+)/i);
  if (!boundaryMatch) throw new Error("Multipart boundary not found");

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
    rawContent = rawContent.replace(/\r\n--$/, "").replace(/\r\n$/, "");

    const nameMatch = rawHeaders.match(/name="([^"]+)"/i);
    if (!nameMatch) continue;

    const fieldName = nameMatch[1];
    const fileNameMatch = rawHeaders.match(/filename="([^"]*)"/i);
    const contentTypeMatch = rawHeaders.match(/Content-Type:\s*([^\r\n]+)/i);

    if (fileNameMatch) {
      files[fieldName] = {
        filename: fileNameMatch[1] || "cv-file",
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        buffer: Buffer.from(rawContent, "binary"),
      };
    } else {
      fields[fieldName] = rawContent.trim();
    }
  }

  return { fields, files };
}

function cleanXmlText(xml) {
  return String(xml || "")
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function readUInt16LE(buffer, offset) {
  return buffer.readUInt16LE(offset);
}

function extractDocxText(buffer) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length - 30) {
    const signature = readUInt32LE(buffer, offset);

    if (signature !== 0x04034b50) {
      offset++;
      continue;
    }

    const compression = readUInt16LE(buffer, offset + 8);
    const compressedSize = readUInt32LE(buffer, offset + 18);
    const uncompressedSize = readUInt32LE(buffer, offset + 22);
    const fileNameLength = readUInt16LE(buffer, offset + 26);
    const extraLength = readUInt16LE(buffer, offset + 28);

    const fileNameStart = offset + 30;
    const fileNameEnd = fileNameStart + fileNameLength;
    const fileName = buffer.slice(fileNameStart, fileNameEnd).toString("utf8");

    const dataStart = fileNameEnd + extraLength;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > buffer.length || compressedSize <= 0) {
      offset += 30 + fileNameLength + extraLength;
      continue;
    }

    const raw = buffer.slice(dataStart, dataEnd);
    let content = null;

    try {
      if (compression === 0) {
        content = raw;
      } else if (compression === 8) {
        content = zlib.inflateRawSync(raw);
      }
    } catch (_) {
      content = null;
    }

    if (content) {
      entries.push({ fileName, content, uncompressedSize });
    }

    offset = dataEnd;
  }

  const wanted = entries.filter((entry) =>
    /word\/(document|footnotes|endnotes|header|footer)\d*\.xml$/i.test(entry.fileName)
  );

  const xml = wanted.map((entry) => entry.content.toString("utf8")).join("\n");
  return cleanXmlText(xml);
}

function extractPdfTextVeryBasic(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];

  const textMatches = raw.match(/\(([^()]{2,300})\)\s*Tj/g) || [];
  for (const item of textMatches) {
    chunks.push(item.replace(/^\(/, "").replace(/\)\s*Tj$/, ""));
  }

  const arrayMatches = raw.match(/\[(.*?)\]\s*TJ/g) || [];
  for (const item of arrayMatches) {
    const inner = item.replace(/^\[/, "").replace(/\]\s*TJ$/, "");
    const parts = inner.match(/\(([^()]*)\)/g) || [];
    chunks.push(parts.map((p) => p.slice(1, -1)).join(""));
  }

  return chunks
    .join("\n")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTextFromFile(file) {
  const name = String(file.filename || "").toLowerCase();
  const type = String(file.contentType || "").toLowerCase();

  if (name.endsWith(".docx") || type.includes("wordprocessingml")) {
    return extractDocxText(file.buffer);
  }

  if (name.endsWith(".txt") || type.includes("text/plain")) {
    return file.buffer.toString("utf8").trim();
  }

  if (name.endsWith(".pdf") || type.includes("pdf")) {
    return extractPdfTextVeryBasic(file.buffer);
  }

  return file.buffer.toString("utf8").trim();
}

function safeJsonParse(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (_) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return JSON.parse(text.slice(first, last + 1));
      } catch (_) {
        return null;
      }
    }
  }

  return null;
}

function extractOutputText(response) {
  if (response.output_text) return response.output_text;

  const chunks = [];

  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.text) chunks.push(content.text);
        }
      }
    }
  }

  return chunks.join("\n").trim();
}

function linesFromText(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function looksLikeName(line) {
  const clean = line
    .replace(/[•●|:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!clean) return false;
  if (clean.length < 5 || clean.length > 60) return false;
  if (clean.includes("@")) return false;
  if (/\d/.test(clean)) return false;

  const banned =
    /resume|cv|curriculum|vitae|email|phone|tel|address|profile|summary|experience|education|skills|резюме|профіль|досвід|освіта|навички|телефон|пошта/i;

  if (banned.test(clean)) return false;

  const words = clean.split(" ").filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;

  return words.every((word) => /^[A-ZА-ЯІЇЄҐ][A-Za-zА-Яа-яІіЇїЄєҐґʼ'’.-]+$/.test(word));
}

function fallbackName(text) {
  const lines = linesFromText(text).slice(0, 20);

  for (const line of lines) {
    if (looksLikeName(line)) return line.replace(/\s+/g, " ").trim();
  }

  return "";
}

function fallbackEmail(text) {
  const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0] : "";
}

function fallbackPhone(text) {
  const m = String(text || "").match(/(\+?\d[\d\s().-]{7,}\d)/);
  return m ? m[0].replace(/\s+/g, " ").trim() : "";
}

function fallbackLocation(text) {
  const lines = linesFromText(text).slice(0, 40);

  const cityWords =
    /(Odesa|Odessa|Kyiv|Kiev|Lviv|London|Manchester|Birmingham|Liverpool|Bristol|Cardiff|Ukraine|Ukrainian|UK|United Kingdom|Poland|Germany|Одеса|Київ|Львів|Україна|Велика Британія|Лондон|Польща|Німеччина)/i;

  for (const line of lines) {
    if (line.includes("@")) continue;
    if (cityWords.test(line) && line.length <= 80) {
      return line.replace(/\s+/g, " ").trim();
    }
  }

  return "";
}

function splitEducationAndSpeciality(profile) {
  const education = String(profile.education || "").trim();
  const speciality = String(profile.speciality || "").trim();

  if (!education) return profile;

  const markers = [
    "Бакалавр",
    "Магістр",
    "Спеціаліст",
    "Викладач",
    "Учитель",
    "Bachelor",
    "Master",
    "Specialist",
    "Degree",
    "Qualification",
    "Teacher",
  ];

  let markerIndex = -1;
  let marker = "";

  for (const m of markers) {
    const idx = education.toLowerCase().indexOf(m.toLowerCase());
    if (idx !== -1 && (markerIndex === -1 || idx < markerIndex)) {
      markerIndex = idx;
      marker = m;
    }
  }

  if (markerIndex > 0) {
    const institution = education.slice(0, markerIndex).replace(/[,\-—–]+$/g, "").trim();
    const degreePart = education.slice(markerIndex).replace(/^[,\-—–]+/g, "").trim();

    if (institution.length >= 5) {
      profile.education = institution;
    }

    if (!speciality && degreePart.length >= 3) {
      profile.speciality = degreePart;
    }
  }

  return profile;
}

function applyFallbacks(profile, text) {
  const result = profile || {};

  if (!result.name) result.name = fallbackName(text);
  if (!result.email) result.email = fallbackEmail(text);
  if (!result.phone) result.phone = fallbackPhone(text);
  if (!result.location) result.location = fallbackLocation(text);

  splitEducationAndSpeciality(result);

  return result;
}

function emptyProfile() {
  return {
    name: "",
    email: "",
    phone: "",
    location: "",
    target: "",
    languages: "",
    education: "",
    speciality: "",
    skills: "",
    softSkills: "",
    hobbies: "",
    experience: [],
    volunteering: [],
    courses: [],
  };
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

    const file = files.file || files.cv;

    if (!file || !file.buffer || file.buffer.length < 10) {
      return sendJson(res, 400, { error: "CV file is missing" });
    }

    const requestedLanguage = String(fields.language || "English").trim();
    const extractedText = extractTextFromFile(file);

    if (!extractedText || extractedText.length < 20) {
      return sendJson(res, 400, {
        error: "Could not read enough text from this CV file. Try PDF, DOCX or TXT.",
      });
    }

    const prompt = `
You are parsing a CV/resume for a job application app.

Final profile language: ${requestedLanguage}

Important rules:
- Extract only facts present in the CV.
- Do not invent experience, education, skills or locations.
- If a field is not present, return an empty string.
- Candidate name is usually at the very top of the CV. Look carefully at the first lines.
- If the CV contains a large heading with a person's name, use it as "name".
- Location means city/country/address, if present.
- Education must be split:
  - "education" = only university / school / college / institution name.
  - "speciality" = degree, qualification, speciality, profession, faculty or teaching subject.
- Example:
  "Південноукраїнський національний педагогічний університет ім. К. Д. Ушинського, Бакалавр — Викладач української мови, літератури та світової літератури"
  should become:
  education: "Південноукраїнський національний педагогічний університет ім. К. Д. Ушинського"
  speciality: "Бакалавр — Викладач української мови, літератури та світової літератури"
- Target job should be the role the person is applying for or the strongest career direction from the CV.
- Soft skills should be separated from professional skills.
- Translate labels/content naturally into the final profile language only when appropriate.
- Keep names, universities, companies and emails unchanged.

CV text:
${extractedText.slice(0, 18000)}

Return ONLY valid JSON:
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

    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: prompt,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "parsed_cv_profile",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                profile: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    email: { type: "string" },
                    phone: { type: "string" },
                    location: { type: "string" },
                    target: { type: "string" },
                    languages: { type: "string" },
                    education: { type: "string" },
                    speciality: { type: "string" },
                    skills: { type: "string" },
                    softSkills: { type: "string" },
                    hobbies: { type: "string" },
                    experience: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          company: { type: "string" },
                          position: { type: "string" },
                          desc: { type: "string" },
                        },
                        required: ["company", "position", "desc"],
                      },
                    },
                    volunteering: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          org: { type: "string" },
                          role: { type: "string" },
                          desc: { type: "string" },
                        },
                        required: ["org", "role", "desc"],
                      },
                    },
                    courses: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: {
                          name: { type: "string" },
                          place: { type: "string" },
                          period: { type: "string" },
                          desc: { type: "string" },
                        },
                        required: ["name", "place", "period", "desc"],
                      },
                    },
                  },
                  required: [
                    "name",
                    "email",
                    "phone",
                    "location",
                    "target",
                    "languages",
                    "education",
                    "speciality",
                    "skills",
                    "softSkills",
                    "hobbies",
                    "experience",
                    "volunteering",
                    "courses",
                  ],
                },
              },
              required: ["profile"],
            },
          },
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        error: "OpenAI CV parsing failed",
        details: raw.slice(0, 1200),
      });
    }

    const openaiData = safeJsonParse(raw);
    const outputText = extractOutputText(openaiData || {});
    const parsed = safeJsonParse(outputText);

    let profile = parsed && parsed.profile ? parsed.profile : emptyProfile();
    profile = applyFallbacks(profile, extractedText);

    return sendJson(res, 200, {
      ok: true,
      profile,
      extractedLength: extractedText.length,
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "CV parser API error",
      details: error.message || String(error),
    });
  }
}
