export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      language = "English",
      recruiter = "Naomi",
      position = "Job position",
      company = "Company",
      vacancy = "",
      answers = [],
      lastQuestion = ""
    } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing on the server."
      });
    }

    const isFirstQuestion = !answers || answers.length === 0;

    const systemPrompt = `
You are ${recruiter}, a professional AI recruiter and interview coach.

You must speak in this language only: ${language}.

Your job:
- Ask realistic interview questions for the position.
- Adapt questions to the company and vacancy description.
- If the candidate answered, briefly react to the answer in 1 sentence.
- Then ask the next interview question.
- Be natural, human, supportive, professional.
- Do not sound robotic.
- Do not write long essays.
- Keep each response short enough to be spoken aloud.

Format your response as JSON only:
{
  "comment": "short feedback or empty string",
  "question": "next interview question",
  "tips": "one short improvement tip"
}
`;

    const userPrompt = isFirstQuestion
      ? `
Start a new interview.

Position: ${position}
Company / Country: ${company}
Vacancy description: ${vacancy || "Not provided"}

Ask the first interview question.
`
      : `
Continue the interview.

Position: ${position}
Company / Country: ${company}
Vacancy description: ${vacancy || "Not provided"}

Previous question:
${lastQuestion}

Candidate answer:
${answers[answers.length - 1] || ""}

Give a short comment and ask the next question.
`;

    const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        response_format: { type: "json_object" }
      })
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      return res.status(openaiResponse.status).json({
        error: "OpenAI request failed",
        details: errorText
      });
    }

    const data = await openaiResponse.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      parsed = {
        comment: "",
        question: content,
        tips: ""
      };
    }

    return res.status(200).json({
      comment: parsed.comment || "",
      question: parsed.question || "",
      tips: parsed.tips || ""
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
