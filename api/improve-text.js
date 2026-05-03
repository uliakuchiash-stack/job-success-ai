function sendJson(res, status, data) {
  res.status(status).json(data);
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Method not allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return sendJson(res, 500, { error: "OPENAI_API_KEY is missing" });
    }

    const body = req.body || {};
    const text = String(body.text || "").trim();
    const language = String(body.language || "English").trim();
    const mode = String(body.mode || "improve").trim();

    if (!text) {
      return sendJson(res, 400, { error: "Text is empty" });
    }

    const task =
      mode === "grammar"
        ? `
Correct grammar, spelling, punctuation and obvious wording mistakes.
Do not change the meaning.
Do not add new facts.
Do not invent experience.
Keep the result natural and professional.
`
        : `
Improve this text for a CV / professional profile.
Make it clearer, more professional and more useful for job applications.
Do not invent experience.
Do not add facts that the user did not say.
Keep the meaning.
`;

    const prompt = `
You are improving text for a job application app.

Language of final text: ${language}

Task:
${task}

User text:
${text}

Return ONLY valid JSON:
{
  "improvedText": ""
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
            name: "improved_text_result",
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                improvedText: {
                  type: "string",
                },
              },
              required: ["improvedText"],
            },
          },
        },
      }),
    });

    const raw = await response.text();

    if (!response.ok) {
      return sendJson(res, 500, {
        error: "OpenAI improve text failed",
        details: raw.slice(0, 1000),
      });
    }

    const openaiData = safeJsonParse(raw);
    const outputText = extractOutputText(openaiData || {});
    const parsed = safeJsonParse(outputText);

    if (!parsed || !parsed.improvedText) {
      return sendJson(res, 500, {
        error: "Could not parse improved text",
        details: outputText.slice(0, 1000),
      });
    }

    return sendJson(res, 200, {
      ok: true,
      improvedText: parsed.improvedText.trim(),
    });
  } catch (error) {
    return sendJson(res, 500, {
      error: "Improve text API error",
      details: error.message || String(error),
    });
  }
}
