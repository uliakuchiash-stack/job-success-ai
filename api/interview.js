export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      mode = "question",
      language = "English",
      recruiter = "Naomi",
      position = "Job position",
      company = "Company",
      vacancy = "",
      answers = [],
      questions = [],
      askedQuestions = [],
      questionLimit = 10,
      feedback = false,
      job = "",
      profile = {},
      instruction = ""
    } = req.body || {};

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing on the server."
      });
    }

    if (mode === "cover_letter") {
      return await createCoverLetter(req, res, {
        language,
        job,
        company,
        vacancy,
        profile
      });
    }

    if (mode === "feedback" || feedback === true) {
      return await createInterviewFeedback(req, res, {
        language,
        recruiter,
        position,
        company,
        vacancy,
        answers,
        questions
      });
    }

    return await createNextQuestion(req, res, {
      language,
      recruiter,
      position,
      company,
      vacancy,
      answers,
      questions,
      askedQuestions,
      questionLimit,
      instruction
    });

  } catch (error) {
    return res.status(500).json({
      error: "Server error",
      details: error.message
    });
  }
}

async function callOpenAI(messages, temperature = 0.45) {
  const openaiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature,
      messages,
      response_format: { type: "json_object" }
    })
  });

  if (!openaiResponse.ok) {
    const errorText = await openaiResponse.text();
    throw new Error(errorText || "OpenAI request failed");
  }

  const data = await openaiResponse.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(content);
  } catch (e) {
    return {};
  }
}

async function createNextQuestion(req, res, data) {
  const {
    language,
    recruiter,
    position,
    company,
    vacancy,
    answers = [],
    questions = [],
    askedQuestions = [],
    questionLimit = 10,
    instruction = ""
  } = data;

  const allAsked = [...questions, ...askedQuestions].filter(Boolean);
  const lastAnswer = answers[answers.length - 1] || "";
  const role = String(position || "").toLowerCase();

  const fallback = getFallbackQuestion(role, language, allAsked.length);

  const systemPrompt = `
You are ${recruiter}, a professional AI recruiter.

Speak only in this language: ${language}.

You must ask ONE short, realistic interview question.

Rules:
- Return JSON only.
- Do not write long comments.
- Do not ask abstract questions for practical jobs.
- Do not ask about "methods", "approaches", "strategies", "optimisation" unless the job is managerial.
- For cleaner / cleaning / прибиральниця / уборщица, ask about real cleaning experience, places cleaned, cleaning products, schedule, client comments, physical work, reliability and start date.
- For cook / chef / kitchen jobs, ask about kitchen tasks, speed, cleanliness, teamwork, food preparation.
- For customer support / chat operator, ask about clients, complaints, typing, tone, difficult messages.
- For care / social worker, ask about helping people, empathy, responsibility, difficult situations.
- Avoid repeating previous questions.
- Keep the question simple and concrete.
- The question must match the vacancy and position.

Return JSON:
{
  "question": "one interview question only"
}
`;

  const userPrompt = `
Position: ${position}
Company / Country: ${company}
Vacancy description:
${vacancy || "Not provided"}

Previous questions:
${allAsked.join("\n") || "None"}

Candidate answers:
${answers.join("\n") || "None"}

Extra instruction:
${instruction || "Ask the next practical interview question."}

Ask question number ${allAsked.length + 1} of ${questionLimit}.
`;

  try {
    const parsed = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.35);

    let question = cleanQuestion(parsed.question || parsed.text || "");

    if (!question || question.length > 190 || isBadAbstractQuestion(question)) {
      question = fallback;
    }

    return res.status(200).json({
      question,
      text: question
    });

  } catch (error) {
    return res.status(200).json({
      question: fallback,
      text: fallback
    });
  }
}

async function createInterviewFeedback(req, res, data) {
  const {
    language,
    recruiter,
    position,
    company,
    vacancy,
    answers = [],
    questions = []
  } = data;

  if (!answers || answers.length === 0) {
    return res.status(200).json({
      score: "—",
      feedback: language === "Українська"
        ? "Ви ще не дали відповідей, тому повний фідбек сформувати неможливо."
        : "You have not answered any questions yet, so full feedback is not possible."
    });
  }

  const systemPrompt = `
You are ${recruiter}, an interview coach.

Speak only in this language: ${language}.

Analyse only the candidate's real answers.
Do not invent experience.
Do not give generic feedback.

Return JSON only:
{
  "score": "number from 1 to 10",
  "feedback": "detailed feedback with sections"
}

Feedback must include:
- score;
- what was good;
- what to improve;
- one concrete improved answer example;
- practical advice for the next interview.

Make it useful, specific and not too short.
`;

  const userPrompt = `
Position: ${position}
Company / Country: ${company}
Vacancy description:
${vacancy || "Not provided"}

Questions:
${questions.join("\n") || "Not provided"}

Candidate answers:
${answers.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Create detailed interview feedback.
`;

  try {
    const parsed = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.35);

    let score = parsed.score || parsed.rating || estimateScore(answers);
    let feedback = parsed.feedback || parsed.comment || parsed.tips || "";

    if (!feedback || feedback.length < 180) {
      feedback = fallbackFeedback(language, answers, score);
    }

    return res.status(200).json({
      score,
      rating: score,
      feedback,
      tips: feedback
    });

  } catch (error) {
    const score = estimateScore(answers);

    return res.status(200).json({
      score,
      rating: score,
      feedback: fallbackFeedback(language, answers, score),
      tips: fallbackFeedback(language, answers, score)
    });
  }
}

async function createCoverLetter(req, res, data) {
  const {
    language,
    job,
    company,
    vacancy,
    profile = {}
  } = data;

  const systemPrompt = `
You are a professional career assistant.

Write only in this language: ${language}.

Create a complete professional cover letter.
Do not invent experience.
Use only the profile information provided.
Make it natural, clear and suitable for job applications.

Return JSON only:
{
  "letter": "cover letter text"
}
`;

  const userPrompt = `
Job title: ${job || "Job position"}
Company: ${company || "Company"}
Vacancy description:
${vacancy || "Not provided"}

Candidate profile:
Name: ${profile.name || ""}
Target: ${profile.target || ""}
Experience: ${JSON.stringify(profile.experience || [])}
Education: ${profile.education || ""}
Speciality: ${profile.speciality || ""}
Skills: ${profile.skills || ""}
Languages: ${profile.languages || ""}

Write the cover letter.
`;

  try {
    const parsed = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.45);

    const letter = parsed.letter || parsed.text || "";

    return res.status(200).json({
      letter,
      text: letter
    });

  } catch (error) {
    return res.status(500).json({
      error: "Cover letter generation failed",
      details: error.message
    });
  }
}

function cleanQuestion(q) {
  return String(q || "")
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/^question\s*:\s*/i, "")
    .trim();
}

function isBadAbstractQuestion(q) {
  const s = String(q || "").toLowerCase();

  const badWords = [
    "approach",
    "method",
    "strategy",
    "optimisation",
    "optimization",
    "process improvement",
    "які ваші методи",
    "який ваш підхід",
    "стратег",
    "оптиміза"
  ];

  return badWords.some(w => s.includes(w));
}

function getFallbackQuestion(role, language, index) {
  const uk = language === "Українська";

  const cleanerUk = [
    "Чи маєте ви досвід прибирання?",
    "Які приміщення ви прибирали раніше?",
    "Чи працювали ви з мийними засобами?",
    "Що ви робите, якщо клієнт робить зауваження?",
    "Чи можете ви працювати швидко, але акуратно?",
    "Чи готові ви працювати за графіком роботодавця?",
    "Коли ви можете почати?"
  ];

  const cleanerEn = [
    "Do you have cleaning experience?",
    "What places have you cleaned before?",
    "Have you worked with cleaning products?",
    "What do you do if a client gives a comment or complaint?",
    "Can you work quickly but carefully?",
    "Can you work the schedule offered by the employer?",
    "When can you start?"
  ];

  const chefUk = [
    "Який у вас досвід роботи на кухні?",
    "Які страви або заготовки ви готували раніше?",
    "Чи можете ви працювати у швидкому темпі?",
    "Як ви підтримуєте чистоту на робочому місці?",
    "Коли ви можете почати?"
  ];

  const chefEn = [
    "What kitchen experience do you have?",
    "What dishes or preparation tasks have you worked with?",
    "Can you work at a fast pace?",
    "How do you keep your workplace clean?",
    "When can you start?"
  ];

  const supportUk = [
    "Чи маєте ви досвід спілкування з клієнтами?",
    "Що ви відповісте клієнту, якщо він незадоволений?",
    "Чи можете ви швидко й грамотно відповідати в чаті?",
    "Як ви дієте, якщо не знаєте відповідь на питання клієнта?",
    "Чи комфортно вам працювати з повідомленнями протягом дня?"
  ];

  const supportEn = [
    "Do you have experience communicating with customers?",
    "What would you say to an unhappy customer?",
    "Can you answer chat messages quickly and clearly?",
    "What do you do if you do not know the answer to a customer question?",
    "Are you comfortable working with messages during the day?"
  ];

  const careUk = [
    "Чи маєте ви досвід допомоги людям або догляду?",
    "Як ви поводитеся з людиною, яка хвилюється або засмучена?",
    "Чи можете ви виконувати щоденні завдання уважно й терпляче?",
    "Що для вас означає відповідальність у роботі з людьми?",
    "Коли ви можете почати?"
  ];

  const careEn = [
    "Do you have experience helping or caring for people?",
    "How do you speak with a person who is worried or upset?",
    "Can you do daily tasks carefully and patiently?",
    "What does responsibility mean to you when working with people?",
    "When can you start?"
  ];

  const generalUk = [
    "Який ваш досвід найбільше підходить для цієї посади?",
    "Чому вас зацікавила ця вакансія?",
    "Які ваші сильні сторони для цієї роботи?",
    "Розкажіть про ситуацію, де ви добре впоралися із завданням.",
    "Коли ви можете почати працювати?"
  ];

  const generalEn = [
    "What experience is most relevant to this role?",
    "Why are you interested in this vacancy?",
    "What are your strongest skills for this job?",
    "Tell me about a situation where you handled a task well.",
    "When can you start working?"
  ];

  let list;

  if (role.includes("clean") || role.includes("приб") || role.includes("убор")) {
    list = uk ? cleanerUk : cleanerEn;
  } else if (role.includes("chef") || role.includes("cook") || role.includes("кухар") || role.includes("повар")) {
    list = uk ? chefUk : chefEn;
  } else if (role.includes("support") || role.includes("chat") || role.includes("оператор") || role.includes("клієнт")) {
    list = uk ? supportUk : supportEn;
  } else if (role.includes("care") || role.includes("social") || role.includes("догляд") || role.includes("соці")) {
    list = uk ? careUk : careEn;
  } else {
    list = uk ? generalUk : generalEn;
  }

  return list[index % list.length];
}

function estimateScore(answers) {
  const count = answers.length;
  const avgLength = answers.reduce((sum, a) => sum + String(a || "").split(/\s+/).length, 0) / Math.max(1, count);

  let score = 5.5;

  if (count >= 3) score += 0.8;
  if (count >= 5) score += 0.7;
  if (avgLength >= 15) score += 0.8;
  if (avgLength >= 30) score += 0.5;

  return Math.min(9, Math.max(4, score)).toFixed(1);
}

function fallbackFeedback(language, answers, score) {
  const uk = language === "Українська";
  const shortCount = answers.filter(a => String(a || "").split(/\s+/).length < 8).length;

  if (uk) {
    return `ОЦІНКА
${score} / 10

ЩО БУЛО ДОБРЕ
- Ви відповіли на ${answers.length} питань.
- Ви почали показувати свій досвід і мотивацію.
${shortCount ? "- Частина відповідей була короткою або погано розпізнаною, тому варто відповідати трохи детальніше." : ""}

ЩО ПОКРАЩИТИ
- Додавайте конкретний приклад із роботи або життя.
- Відповідайте за схемою: досвід → що саме робили → чому це корисно роботодавцю.
- Не відповідайте однією фразою, якщо питання важливе.

ПРИКЛАД КРАЩОЇ ВІДПОВІДІ
“Я маю досвід роботи на подібній посаді. Я уважно виконую завдання, дотримуюся інструкцій, можу працювати стабільно й відповідально. Для мене важливо виконувати роботу якісно та бути пунктуальною.”

ПОРАДА
Перед наступною співбесідою підготуйте 3 короткі приклади: ваш досвід, ваша сильна сторона і ситуація, де ви добре впоралися із завданням.`;
  }

  return `SCORE
${score} / 10

WHAT WAS GOOD
- You answered ${answers.length} questions.
- You started showing your experience and motivation.
${shortCount ? "- Some answers were short or poorly recognised, so it would be better to answer with more detail." : ""}

WHAT TO IMPROVE
- Add one specific example from work or life.
- Use this structure: experience → what you did → why it helps the employer.
- Do not answer with only one phrase when the question is important.

BETTER ANSWER EXAMPLE
“I have experience in a similar role. I follow instructions carefully, work responsibly and pay attention to detail. I understand that reliability and punctuality are important for this job.”

ADVICE
Before the next interview, prepare three short examples: your experience, your strongest quality and one situation where you handled a task well.`;
}
