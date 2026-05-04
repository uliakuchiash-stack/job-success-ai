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

    const body = req.body || {};

    const textRaw =
      body.text ||
      body.message ||
      body.question ||
      body.content ||
      "";

    const voiceRaw = body.voice || "alloy";

    const allowedVoices = [
      "alloy",
      "ash",
      "ballad",
      "coral",
      "echo",
      "fable",
      "nova",
      "onyx",
      "sage",
      "shimmer"
    ];

    const voice = allowedVoices.includes(voiceRaw) ? voiceRaw : "alloy";

    const text = String(textRaw)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 900);

    if (!text) {
      return res.status(400).json({
        error: "No text provided for TTS."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);

    const openaiResponse = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: text,
        response_format: "mp3",
        speed: 1.03
      })
    });

    clearTimeout(timeout);

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      return res.status(openaiResponse.status).json({
        error: "OpenAI TTS request failed",
        details: errorText
      });
    }

    const arrayBuffer = await openaiResponse.arrayBuffer();
    const audioBuffer = Buffer.from(arrayBuffer);

    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audioBuffer.length);
    res.setHeader("Cache-Control", "no-store");

    return res.status(200).send(audioBuffer);

  } catch (error) {
    if (error.name === "AbortError") {
      return res.status(504).json({
        error: "TTS timeout",
        details: "Voice generation took too long."
      });
    }

    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}
