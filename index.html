export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing on the server."
      });
    }

    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    const buffer = Buffer.concat(chunks);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ error: "Audio file is required" });
    }

    const contentType = req.headers["content-type"] || "audio/webm";

    const file = new Blob([buffer], { type: contentType });

    const formData = new FormData();
    formData.append("file", file, "answer.webm");
    formData.append("model", "gpt-4o-mini-transcribe");

    const openaiResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: formData
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      return res.status(openaiResponse.status).json({
        error: "OpenAI transcription request failed",
        details: errorText
      });
    }

    const data = await openaiResponse.json();

    return res.status(200).json({
      text: data.text || ""
    });
  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}

export const config = {
  api: {
    bodyParser: false
  }
};
