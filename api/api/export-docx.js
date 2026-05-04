import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from "docx";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      profile = {},
      template = "simple",
      photo = "",
      language = "English"
    } = req.body || {};

    const safeName = cleanFileName(profile.name || "Candidate");
    const doc =
      template === "classicPhoto" || template === "classic" || template === "photo"
        ? buildClassicPhotoDoc(profile, photo, language)
        : buildSimpleAtsDoc(profile, language);

    const buffer = await Packer.toBuffer(doc);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName || "Resume"}_CV.docx"`
    );

    return res.status(200).send(buffer);
  } catch (error) {
    return res.status(500).json({
      error: "DOCX export failed",
      details: error.message
    });
  }
}

function buildSimpleAtsDoc(profile, language) {
  const L = labels(language);

  return new Document({
    styles: baseStyles(),
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 900,
              right: 900,
              bottom: 900,
              left: 900
            }
          }
        },
        children: [
          title(profile.name || "Your Name"),
          role(profile.target || ""),
          contactLine(profile),
          divider(),

          sectionTitle(L.profile),
          text(summary(profile, language)),

          sectionTitle(L.experience),
          ...experienceBlocks(profile.experience, L),

          sectionTitle(L.education),
          text(educationText(profile, L)),

          sectionTitle(L.skills),
          text(joinList([profile.skills, profile.softSkills])),

          ...(profile.profileLanguages
            ? [sectionTitle(L.languages), text(profile.profileLanguages)]
            : []),

          ...(profile.hobbies
            ? [sectionTitle(L.interests), text(profile.hobbies)]
            : [])
        ]
      }
    ]
  });
}

function buildClassicPhotoDoc(profile, photo, language) {
  const L = labels(language);
  const image = imageFromDataUrl(photo);

  const leftChildren = [];

  if (image) {
    leftChildren.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 260 },
        children: [
          new ImageRun({
            data: image.buffer,
            transformation: {
              width: 105,
              height: 105
            }
          })
        ]
      })
    );
  }

  leftChildren.push(
    smallSection(L.contact),
    smallText(profile.email || ""),
    smallText(profile.phone || ""),
    smallText(profile.location || ""),
    smallSection(L.languages),
    smallText(profile.profileLanguages || ""),
    smallSection(L.skills),
    smallText(joinList([profile.skills, profile.softSkills])),
    ...(profile.hobbies
      ? [smallSection(L.interests), smallText(profile.hobbies)]
      : [])
  );

  const rightChildren = [
    title(profile.name || "Your Name"),
    role(profile.target || ""),
    dividerGold(),

    sectionTitle(L.profile),
    text(summary(profile, language)),

    sectionTitle(L.experience),
    ...experienceBlocks(profile.experience, L),

    sectionTitle(L.education),
    text(educationText(profile, L)),

    ...(profile.manualCourses && profile.manualCourses.length
      ? [
          sectionTitle(L.courses),
          ...courseBlocks(profile.manualCourses)
        ]
      : [])
  ];

  const layoutTable = new Table({
    width: {
      size: 100,
      type: WidthType.PERCENTAGE
    },
    borders: noBorders(),
    rows: [
      new TableRow({
        children: [
          new TableCell({
            width: { size: 31, type: WidthType.PERCENTAGE },
            shading: {
              type: ShadingType.CLEAR,
              color: "auto",
              fill: "F3E8D6"
            },
            margins: {
              top: 420,
              bottom: 420,
              left: 350,
              right: 350
            },
            verticalAlign: VerticalAlign.TOP,
            children: leftChildren
          }),
          new TableCell({
            width: { size: 69, type: WidthType.PERCENTAGE },
            margins: {
              top: 420,
              bottom: 420,
              left: 520,
              right: 300
            },
            verticalAlign: VerticalAlign.TOP,
            children: rightChildren
          })
        ]
      })
    ]
  });

  return new Document({
    styles: baseStyles(),
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: 720,
              right: 720,
              bottom: 720,
              left: 720
            }
          }
        },
        children: [layoutTable]
      }
    ]
  });
}

function baseStyles() {
  return {
    paragraphStyles: [
      {
        id: "Normal",
        name: "Normal",
        run: {
          font: "Arial",
          size: 21,
          color: "222222"
        },
        paragraph: {
          spacing: {
            after: 100,
            line: 250
          }
        }
      },
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        quickFormat: true,
        run: {
          font: "Arial",
          size: 31,
          bold: true,
          color: "111111"
        },
        paragraph: {
          spacing: {
            before: 260,
            after: 120
          }
        }
      }
    ]
  };
}

function title(value) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    spacing: { after: 80 },
    children: [
      new TextRun({
        text: String(value || "").toUpperCase(),
        bold: true,
        size: 34,
        font: "Arial",
        color: "111111"
      })
    ]
  });
}

function role(value) {
  return new Paragraph({
    spacing: { after: 170 },
    children: [
      new TextRun({
        text: value || "",
        size: 22,
        font: "Arial",
        color: "7A5B2E",
        bold: true
      })
    ]
  });
}

function contactLine(profile) {
  const parts = [profile.email, profile.phone, profile.location].filter(Boolean);

  return new Paragraph({
    spacing: { after: 180 },
    children: [
      new TextRun({
        text: parts.join(" | "),
        size: 20,
        font: "Arial",
        color: "444444"
      })
    ]
  });
}

function divider() {
  return new Paragraph({
    border: {
      bottom: {
        color: "111111",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 8
      }
    },
    spacing: {
      after: 220
    }
  });
}

function dividerGold() {
  return new Paragraph({
    border: {
      bottom: {
        color: "C9A45C",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 10
      }
    },
    spacing: {
      after: 220
    }
  });
}

function sectionTitle(value) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: {
      before: 260,
      after: 90
    },
    border: {
      bottom: {
        color: "D6C3A2",
        space: 1,
        style: BorderStyle.SINGLE,
        size: 4
      }
    },
    children: [
      new TextRun({
        text: String(value || "").toUpperCase(),
        bold: true,
        size: 20,
        font: "Arial",
        color: "7A5B2E"
      })
    ]
  });
}

function smallSection(value) {
  return new Paragraph({
    spacing: {
      before: 220,
      after: 80
    },
    children: [
      new TextRun({
        text: String(value || "").toUpperCase(),
        bold: true,
        size: 18,
        font: "Arial",
        color: "7A5B2E"
      })
    ]
  });
}

function text(value) {
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({
        text: String(value || "—"),
        size: 21,
        font: "Arial",
        color: "333333"
      })
    ]
  });
}

function smallText(value) {
  return new Paragraph({
    spacing: { after: 80 },
    children: [
      new TextRun({
        text: String(value || "—"),
        size: 19,
        font: "Arial",
        color: "333333"
      })
    ]
  });
}

function experienceBlocks(items, L) {
  const arr = Array.isArray(items) ? items : [];

  if (!arr.length) {
    return [text("—")];
  }

  const blocks = [];

  arr.forEach(item => {
    blocks.push(
      new Paragraph({
        spacing: { before: 120, after: 40 },
        children: [
          new TextRun({
            text: `${item.position || L.position} — ${item.company || L.company}`,
            bold: true,
            size: 21,
            font: "Arial",
            color: "111111"
          })
        ]
      })
    );

    if (item.desc) {
      blocks.push(
        new Paragraph({
          spacing: { after: 120 },
          children: [
            new TextRun({
              text: item.desc,
              size: 20,
              font: "Arial",
              color: "333333"
            })
          ]
        })
      );
    }
  });

  return blocks;
}

function courseBlocks(items) {
  const arr = Array.isArray(items) ? items : [];

  if (!arr.length) {
    return [text("—")];
  }

  return arr.flatMap(item => [
    new Paragraph({
      spacing: { before: 100, after: 40 },
      children: [
        new TextRun({
          text: `${item.name || ""}${item.period ? " — " + item.period : ""}`,
          bold: true,
          size: 20,
          font: "Arial",
          color: "111111"
        })
      ]
    }),
    new Paragraph({
      spacing: { after: 100 },
      children: [
        new TextRun({
          text: [item.place, item.desc].filter(Boolean).join(" — ") || "—",
          size: 19,
          font: "Arial",
          color: "333333"
        })
      ]
    })
  ]);
}

function summary(profile, language) {
  if (language === "Українська" || language === "Ukrainian") {
    return `Мотивований фахівець, орієнтований на якісну роботу, відповідальність та розвиток у напрямку ${profile.target || "обраної посади"}.`;
  }

  return `Motivated professional focused on quality work, responsibility and development in the field of ${profile.target || "the target role"}.`;
}

function educationText(profile, L) {
  const parts = [];

  if (profile.education) parts.push(profile.education);
  if (profile.speciality) parts.push(`${L.speciality}: ${profile.speciality}`);

  return parts.join("\n") || "—";
}

function joinList(items) {
  return items
    .filter(Boolean)
    .join(", ")
    .replace(/\s+/g, " ")
    .trim();
}

function labels(language) {
  if (language === "Українська" || language === "Ukrainian") {
    return {
      profile: "Профіль",
      experience: "Досвід",
      education: "Освіта",
      skills: "Навички",
      languages: "Мови",
      contact: "Контакти",
      interests: "Хобі",
      courses: "Курси",
      speciality: "Спеціальність",
      position: "Посада",
      company: "Компанія"
    };
  }

  return {
    profile: "Profile",
    experience: "Experience",
    education: "Education",
    skills: "Skills",
    languages: "Languages",
    contact: "Contact",
    interests: "Interests",
    courses: "Courses",
    speciality: "Speciality",
    position: "Position",
    company: "Company"
  };
}

function imageFromDataUrl(dataUrl) {
  if (!dataUrl || typeof dataUrl !== "string") return null;

  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i);

  if (!match) return null;

  return {
    ext: match[1].toLowerCase() === "jpg" ? "jpeg" : match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64")
  };
}

function cleanFileName(value) {
  return String(value || "Candidate")
    .replace(/[^\p{L}\p{N}_ -]+/gu, "")
    .replace(/\s+/g, "_")
    .slice(0, 60);
}

function noBorders() {
  return {
    top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }
  };
}
