export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

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
      instruction = "",
      qaPairs = []
    } = body;

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is missing on the server."
      });
    }

    if (mode === "cover_letter") {
      return await createCoverLetter(res, {
        language,
        job,
        company,
        vacancy,
        profile
      });
    }

    if (mode === "feedback" || feedback === true) {
      return await createInterviewFeedback(res, {
        language,
        recruiter,
        position,
        company,
        vacancy,
        answers,
        questions,
        qaPairs
      });
    }

    return await createNextQuestion(res, {
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

async function callOpenAI(messages, temperature = 0.35) {
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

async function createNextQuestion(res, data) {
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

  const role = String(position || "").toLowerCase();
  const allAsked = [...questions, ...askedQuestions].filter(Boolean);
  const fallback = getFallbackQuestion(role, language, allAsked.length);

  const systemPrompt = `
You are ${recruiter}, a professional AI recruiter.

Speak only in this language: ${language}.

Your task is to ask ONE next interview question.

Important rules:
- Return JSON only.
- Ask one short, clear, practical question.
- Do not write comments before the question.
- Do not ask abstract questions for practical jobs.
- Do not use words like "methods", "approaches", "strategies", "optimisation", "process improvement" unless the role is managerial.
- Do not repeat previous questions.
- Adapt to the position and vacancy.
- For cleaner / cleaning / прибиральниця / уборщица: ask about real cleaning experience, places cleaned, products used, schedule, client comments, physical work, reliability, start date.
- For cook / chef / kitchen: ask about kitchen tasks, food preparation, cleanliness, speed, teamwork.
- For customer support / chat operator: ask about customer messages, complaints, polite tone, fast typing, unclear questions.
- For care / social worker: ask about helping people, patience, responsibility, difficult situations.
- If the candidate gave a short answer, ask a follow-up that helps them give a better concrete answer.

Return JSON exactly like:
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
${allAsked.length ? allAsked.map((q, i) => `${i + 1}. ${q}`).join("\n") : "None"}

Candidate answers:
${answers.length ? answers.map((a, i) => `${i + 1}. ${a}`).join("\n") : "None"}

Question number to ask now: ${allAsked.length + 1}
Maximum questions: ${questionLimit}

Extra instruction from frontend:
${instruction || "Ask the next practical interview question."}
`;

  try {
    const parsed = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.28);

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

async function createInterviewFeedback(res, data) {
  const {
    language,
    recruiter,
    position,
    company,
    vacancy,
    answers = [],
    questions = [],
    qaPairs = []
  } = data;

  const pairs = buildPairs(questions, answers, qaPairs);

  if (!pairs.length) {
    return res.status(200).json({
      score: "—",
      feedback: language === "Українська"
        ? "Ви ще не дали відповідей, тому повний фідбек сформувати неможливо."
        : "You have not answered any questions yet, so full feedback is not possible."
    });
  }

  const systemPrompt = `
You are ${recruiter}, a professional interview coach.

Speak only in this language: ${language}.

You must analyse the candidate's interview answers based on the exact question-answer pairs.

Return JSON only:
{
  "score": "number from 1 to 10",
  "feedback": "full feedback text"
}

Very important:
- Do NOT give generic feedback.
- Do NOT use the same template for every candidate.
- Analyse each answer according to the exact question that was asked.
- If the question was about schedule, give advice about schedule.
- If the question was about cleaning products, give advice about naming products and safe use.
- If the question was about client comments, give advice about calm communication and fixing the issue.
- If the question was about places cleaned, give advice about naming places and tasks.
- Do NOT say "add a work example" unless the exact question needed a work example.
- If an answer is already enough for that question, say it was enough and why.
- If an answer is too short, say exactly what one sentence could be added.
- Give one improved answer example based on the weakest real answer.
- The improved answer must match one actual question from the interview.
- Mention the strongest answer and the weakest answer.
- Be useful and specific.

Feedback structure:
1. Score.
2. What was good.
3. What to improve by specific question.
4. Improved answer example.
5. Short advice for the next interview.
`;

  const userPrompt = `
Position: ${position}
Company / Country: ${company}
Vacancy description:
${vacancy || "Not provided"}

Interview question-answer pairs:
${pairs.map((p, i) => `Pair ${i + 1}
Question: ${p.question}
Answer: ${p.answer}`).join("\n\n")}

Create feedback that is specific to these answers.
Do not give advice that does not match the questions.
`;

  try {
    const parsed = await callOpenAI([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.25);

    const score = normaliseScore(parsed.score || parsed.rating || estimateScore(pairs));
    let feedback = String(parsed.feedback || parsed.comment || parsed.tips || "").trim();

    if (!feedback || feedback.length < 220 || looksGeneric(feedback)) {
      feedback = buildSpecificFallbackFeedback(language, pairs, score);
    }

    return res.status(200).json({
      score,
      rating: score,
      feedback,
      tips: feedback
    });
  } catch (error) {
    const score = estimateScore(pairs);
    const feedback = buildSpecificFallbackFeedback(language, pairs, score);

    return res.status(200).json({
      score,
      rating: score,
      feedback,
      tips: feedback
    });
  }
}

async function createCoverLetter(res, data) {
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

function buildPairs(questions, answers, qaPairs) {
  if (Array.isArray(qaPairs) && qaPairs.length) {
    return qaPairs
      .map(p => ({
        question: String(p.question || "").trim(),
        answer: String(p.answer || "").trim()
      }))
      .filter(p => p.answer);
  }

  const cleanQuestions = Array.isArray(questions) ? questions.filter(Boolean) : [];
  const cleanAnswers = Array.isArray(answers) ? answers.filter(Boolean) : [];

  return cleanAnswers.map((answer, i) => {
    let question = cleanQuestions[i] || cleanQuestions[i + 1] || "";

    return {
      question: String(question || "Question not provided").trim(),
      answer: String(answer || "").trim()
    };
  });
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

function normaliseScore(score) {
  const n = parseFloat(String(score).replace(",", "."));
  if (Number.isFinite(n)) {
    return Math.min(10, Math.max(1, n)).toFixed(1).replace(".0", "");
  }
  return String(score || "7");
}

function estimateScore(pairs) {
  const count = pairs.length;
  const avgLength = pairs.reduce((sum, p) => {
    return sum + String(p.answer || "").split(/\s+/).filter(Boolean).length;
  }, 0) / Math.max(1, count);

  let score = 5.2;

  if (count >= 3) score += 0.5;
  if (count >= 5) score += 0.5;
  if (avgLength >= 12) score += 0.6;
  if (avgLength >= 25) score += 0.6;

  return Math.min(8.8, Math.max(4.5, score)).toFixed(1);
}

function looksGeneric(text) {
  const s = String(text || "").toLowerCase();

  const genericPhrases = [
    "додавайте конкретний приклад",
    "відповідайте структуровано",
    "не обмежуйтеся однією фразою",
    "add one specific example",
    "use this structure",
    "do not answer with only one phrase"
  ];

  let hits = 0;
  for (const phrase of genericPhrases) {
    if (s.includes(phrase)) hits++;
  }

  return hits >= 2;
}

function buildSpecificFallbackFeedback(language, pairs, score) {
  const uk = language === "Українська";
  const weakest = findWeakestPair(pairs);
  const strongest = findStrongestPair(pairs);

  if (uk) {
    return `ОЦІНКА
${score} / 10

ЩО БУЛО ДОБРЕ
- Ви відповіли на ${pairs.length} питань.
- Найсильніша відповідь була на питання: “${strongest.question}”
- У цій відповіді було видно конкретику: “${shorten(strongest.answer, 120)}”

ЩО ПОКРАЩИТИ
- Найслабше місце було у відповіді на питання: “${weakest.question}”
- Ваша відповідь: “${shorten(weakest.answer, 140)}”
${adviceForQuestion(weakest.question, uk)}

ПРИКЛАД КРАЩОЇ ВІДПОВІДІ
${improvedAnswerForQuestion(weakest.question, weakest.answer, uk)}

КОРОТКА ПОРАДА
На наступній співбесіді відповідайте так: 1) коротко по суті питання, 2) одна конкретна деталь, 3) чому це корисно роботодавцю.`;
  }

  return `SCORE
${score} / 10

WHAT WAS GOOD
- You answered ${pairs.length} questions.
- Your strongest answer was for this question: “${strongest.question}”
- This answer had useful detail: “${shorten(strongest.answer, 120)}”

WHAT TO IMPROVE
- The weakest answer was for this question: “${weakest.question}”
- Your answer was: “${shorten(weakest.answer, 140)}”
${adviceForQuestion(weakest.question, uk)}

BETTER ANSWER EXAMPLE
${improvedAnswerForQuestion(weakest.question, weakest.answer, uk)}

SHORT ADVICE
In the next interview, answer like this: 1) answer the exact question, 2) add one concrete detail, 3) explain why it helps the employer.`;
}

function findWeakestPair(pairs) {
  return pairs
    .slice()
    .sort((a, b) => {
      const al = String(a.answer || "").split(/\s+/).filter(Boolean).length;
      const bl = String(b.answer || "").split(/\s+/).filter(Boolean).length;
      return al - bl;
    })[0] || pairs[0];
}

function findStrongestPair(pairs) {
  return pairs
    .slice()
    .sort((a, b) => {
      const al = String(a.answer || "").split(/\s+/).filter(Boolean).length;
      const bl = String(b.answer || "").split(/\s+/).filter(Boolean).length;
      return bl - al;
    })[0] || pairs[0];
}

function adviceForQuestion(question, uk) {
  const q = String(question || "").toLowerCase();

  if (q.includes("мий") || q.includes("cleaning product") || q.includes("засоб")) {
    return uk
      ? "- Тут краще назвати 1–2 засоби, з якими ви працювали, і сказати, що використовуєте їх безпечно та за інструкцією."
      : "- It would be better to name 1–2 cleaning products you used and say that you use them safely and according to instructions.";
  }

  if (q.includes("клієнт") || q.includes("зауваж") || q.includes("complaint") || q.includes("comment")) {
    return uk
      ? "- Тут важливо показати спокійну реакцію: вислухати, не сперечатися, виправити проблему."
      : "- Here it is important to show a calm reaction: listen, do not argue, and fix the problem.";
  }

  if (q.includes("граф") || q.includes("schedule")) {
    return uk
      ? "- Тут краще чітко сказати, які дні або години вам підходять, і чи готові ви до змінного графіка."
      : "- Here it is better to clearly say which days or hours suit you and whether you can work a flexible schedule.";
  }

  if (q.includes("коли") || q.includes("start")) {
    return uk
      ? "- Тут достатньо чітко сказати дату або період, коли ви можете почати."
      : "- Here it is enough to clearly say the date or period when you can start.";
  }

  if (q.includes("приміщ") || q.includes("places") || q.includes("cleaned")) {
    return uk
      ? "- Тут краще назвати конкретні місця: квартира, будинок, офіс, кафе, готель, і що саме ви там прибирали."
      : "- Here it is better to name specific places: home, office, café, hotel, and what exactly you cleaned there.";
  }

  return uk
    ? "- Тут можна додати одну конкретну деталь, яка прямо відповідає на питання."
    : "- Here you can add one concrete detail that directly answers the question.";
}

function improvedAnswerForQuestion(question, answer, uk) {
  const q = String(question || "").toLowerCase();

  if (q.includes("мий") || q.includes("cleaning product") || q.includes("засоб")) {
    return uk
      ? "“Я працювала з різними мийними засобами для кухні, ванної кімнати та підлоги. Завжди читала інструкцію, використовувала рукавички і стежила, щоб засіб не пошкодив поверхню.”"
      : "“I have worked with different cleaning products for kitchens, bathrooms and floors. I always read the instructions, use gloves and make sure the product does not damage the surface.”";
  }

  if (q.includes("клієнт") || q.includes("зауваж") || q.includes("complaint") || q.includes("comment")) {
    return uk
      ? "“Якщо клієнт робить зауваження, я спокійно вислухаю, уточню, що саме потрібно виправити, і одразу перероблю роботу. Для мене важливо, щоб клієнт був задоволений.”"
      : "“If a client gives a comment, I listen calmly, ask what exactly needs to be fixed, and correct it straight away. It is important to me that the client is satisfied.”";
  }

  if (q.includes("приміщ") || q.includes("places") || q.includes("cleaned")) {
    return uk
      ? "“Я прибирала приватні будинки: кухню, ванну кімнату, кімнати та підлогу. Також протирала пил, мила поверхні і стежила, щоб усе виглядало чисто та акуратно.”"
      : "“I cleaned private homes, including kitchens, bathrooms, rooms and floors. I also dusted, cleaned surfaces and made sure everything looked clean and tidy.”";
  }

  if (q.includes("граф") || q.includes("schedule")) {
    return uk
      ? "“Я готова працювати за графіком роботодавця. Мені підходять будні дні, і я можу обговорити години роботи заздалегідь.”"
      : "“I can work according to the employer’s schedule. Weekdays suit me, and I can discuss the working hours in advance.”";
  }

  if (q.includes("коли") || q.includes("start")) {
    return uk
      ? "“Я можу почати працювати найближчим часом. Якщо потрібно, я готова вийти на пробний день або співбесіду.”"
      : "“I can start soon. If needed, I am ready to come for a trial day or an interview.”";
  }

  return uk
    ? "“Я маю відповідний досвід і готова виконувати цю роботу уважно та відповідально. Для мене важливо працювати якісно, дотримуватися інструкцій і бути пунктуальною.”"
    : "“I have relevant experience and I am ready to do this work carefully and responsibly. It is important to me to work well, follow instructions and be punctual.”";
}

function shorten(text, max) {
  const s = String(text || "").trim();
  if (s.length <= max) return s;
  return s.slice(0, max).trim() + "...";
}
