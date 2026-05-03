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
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=([^;]+)/i);
  return match ? match[1] : null;
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from("--" + boundary);
  const parts = [];
  let start = buffer.indexOf(boundaryBuffer);

  while (start !== -1) {
    start += boundaryBuffer.length;

    if (buffer[start] === 45 && buffer[start + 1] === 45) break;

    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;

    const next = buffer.indexOf(boundaryBuffer, start);
    if (next === -1) break;

    let part = buffer.slice(start, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) {
      part = part.slice(0, -2);
    }

    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd !== -1) {
      const headersRaw = part.slice(0, headerEnd).toString("utf8");
      const body = part.slice(headerEnd + 4);

      const nameMatch = headersRaw.match(/name="([^"]+)"/i);
      const fileMatch = headersRaw.match(/filename="([^"]*)"/i);
      const typeMatch = headersRaw.match(/Content-Type:\s*([^\r\n]+)/i);

      parts.push({
        name: nameMatch ? nameMatch[1] : "",
        filename: fileMatch ? fileMatch[1] : "",
        contentType: typeMatch ? typeMatch[1].trim() : "application/octet-stream",
        body,
      });
    }

    start = next;
  }

  return parts;
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

function normaliseProfile(data) {
  const profile = data && typeof data === "object" ? data : {};

  return {
    name: profile.name || "",
    email: profile.email || "",
    phone: profile.phone || "",
    location: profile.location || "",
    target: profile.target || "",
    languages: profile.languages || "",
    education: profile.education || "",
    speciality: profile.speciality || "",
    skills: profile.skills || "",
    softSkills: profile.softSkills || "",
    hobbies: profile.hobbies || "",
    experience: Array.isArray(profile.experience) ? profile.experience : [],
    volunteering: Array.isArray(profile.volunteering) ? profile.volunteering : [],
    courses: Array.isArray(profile.courses) ? profile.courses : [],
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

    const contentType = req.headers["content-type"] || "";
    const boundary = getBoundary(contentType);

    if (!boundary) {
      return sendJson(res, 400, { error: "Expected multipart/form-data" });
    }

    const buffer = await readRequestBuffer(req);

    if (buffer.length > 12 * 1024 * 1024) {
      return sendJson(res, 413, { error: "File is too large. Maximum 12 MB." });
    }

    const parts = parseMultipart(buffer, boundary);
    const filePart = parts.find((p) => p.name === "file" && p.filename);
    const languagePart = parts.find((p) => p.name === "language");

    if (!filePart || !filePart.body || !filePart.body.length) {
      return sendJson(res, 400, { error: "No CV file uploaded" });
    }

    const language = languagePart ? languagePart.body.toString("utf8").trim() : "English";
    const filename = filePart.filename || "cv-file";
    const mimeType = filePart.contentType || "application/octet-stream";
    const base64 = filePart.body.toString("base64");

    const prompt = `
You are parsing a candidate CV/resume.

Return ONLY valid JSON.
Do not invent experience.
Use only information found in the CV.
If information is missing, return an empty string or empty array.
Translate field labels and generated wording into this language: ${language}.
Keep job titles, company names, school names and personal names as written unless clearly necessary.

Required JSON shape:
{
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
              {
                type: "input_file",
                filename,
                file_data: `data:${mimeType};base64,${base64}`,
              },
            ],
          },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "cv_profile",
            schema: {
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
                "courses"
              ],
            },
          },
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        error: "OpenAI CV parsing failed",
        details: raw.slice(0, 1000),
      });
    }

    const openaiData = safeJsonParse(raw);
    const outputText = extractOutputText(openaiData || {});
    const parsedProfile = safeJsonParse(outputText);

    if (!parsedProfile) {
      return sendJson(res, 500, {
        error: "Could not parse CV result",
        details: outputText.slice(0, 1000),
      });
    }

    return sendJson(res, 200, {
      ok: true,
      filename,
      profile: normaliseProfile(parsedProfile),
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "CV parser error",
      details: error.message || String(error),
    });
  }
}
