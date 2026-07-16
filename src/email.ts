// Rendu HTML + envoi des emails du digest (quotidien et mensuel).
// Les styles sont inline sur chaque balise : c'est la seule approche fiable
// dans les clients mail (Gmail/Outlook strippent souvent <style> et les classes).

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_TO = process.env.EMAIL_TO;
const EMAIL_FROM = process.env.EMAIL_FROM ?? "onboarding@resend.dev";

if (!RESEND_API_KEY) throw new Error("Missing RESEND_API_KEY");
if (!EMAIL_TO) throw new Error("Missing EMAIL_TO");

const resend = new Resend(RESEND_API_KEY);

// Styles inline par balise. Palette sobre, lisible en clair comme en sombre
// (fonds clairs explicites pour que le dark mode des clients mail inverse proprement).
const S = {
  h1: "margin:0 0 16px;font-size:22px;line-height:1.3;color:#111827;border-bottom:3px solid #4f46e5;padding-bottom:10px;",
  h2: "margin:28px 0 12px;font-size:17px;line-height:1.35;color:#111827;border-bottom:1px solid #e5e7eb;padding-bottom:6px;",
  h3: "margin:20px 0 8px;font-size:15px;color:#374151;",
  p: "margin:0 0 12px;font-size:15px;line-height:1.65;color:#1f2937;",
  ul: "margin:0 0 14px;padding-left:22px;",
  li: "margin:0 0 8px;font-size:15px;line-height:1.6;color:#1f2937;",
  a: "color:#4f46e5;text-decoration:underline;word-break:break-word;",
  hr: "border:none;border-top:1px solid #e5e7eb;margin:22px 0;",
  strong: "color:#111827;",
  blockquote:
    "margin:0 0 14px;padding:10px 14px;border-left:4px solid #f59e0b;background:#fffbeb;color:#78350f;font-size:14px;line-height:1.6;",
};

function inline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, `<strong style="${S.strong}">$1</strong>`)
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((.+?)\)/g, `<a href="$2" style="${S.a}">$1</a>`);
}

// Convertisseur Markdown→HTML minimaliste, traité ligne par ligne pour gérer
// correctement titres, puces, citations, séparateurs et paragraphes.
export function markdownToHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  for (const raw of md.split("\n")) {
    const indented = /^\s+\S/.test(raw); // ligne de continuation (indentée)
    const line = raw.trim();

    if (!line) {
      closeList();
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      closeList();
      out.push(`<hr style="${S.hr}">`);
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length as 1 | 2 | 3;
      out.push(`<h${level} style="${S[`h${level}`]}">${inline(heading[2])}</h${level}>`);
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote style="${S.blockquote}">${inline(quote[1])}</blockquote>`);
      continue;
    }

    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!inList) {
        out.push(`<ul style="${S.ul}">`);
        inList = true;
      }
      out.push(`<li style="${S.li}">${inline(bullet[1])}</li>`);
      continue;
    }

    // Ligne indentée suivant une puce : on la rattache à l'item courant
    if (indented && inList && out.length > 0) {
      out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, `<br>${inline(line)}</li>`);
      continue;
    }

    closeList();
    out.push(`<p style="${S.p}">${inline(line)}</p>`);
  }
  closeList();
  return out.join("\n");
}

// Enveloppe le contenu dans une mise en page email : fond gris, carte blanche
// centrée, typo système, pied de page discret.
export function renderEmailHtml(markdown: string, footerNote: string): string {
  const body = markdownToHtml(markdown);
  return `<!DOCTYPE html>
<html lang="fr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f3f4f6;">
  <div style="max-width:680px;margin:0 auto;padding:24px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="background:#ffffff;border-radius:12px;border:1px solid #e5e7eb;padding:28px 30px;">
${body}
    </div>
    <p style="text-align:center;font-size:12px;color:#9ca3af;margin:16px 0 0;">
      ${footerNote} — généré automatiquement par mon-agent-news
    </p>
  </div>
</body>
</html>`;
}

// Envoi avec retry pour survivre aux erreurs transitoires de Resend
// (réseau, 5xx, rate limit). Lève une erreur si toutes les tentatives échouent.
const EMAIL_MAX_ATTEMPTS = 3;

export async function sendEmail(opts: {
  subject: string;
  markdown: string;
  footerNote: string;
}): Promise<string | undefined> {
  const html = renderEmailHtml(opts.markdown, opts.footerNote);
  let lastError = "";
  for (let attempt = 1; attempt <= EMAIL_MAX_ATTEMPTS; attempt++) {
    const { data, error } = await resend.emails
      .send({
        from: EMAIL_FROM,
        to: EMAIL_TO!,
        subject: opts.subject,
        html,
        text: opts.markdown,
      })
      .catch((err: Error) => ({ data: null, error: { message: err.message } }));

    if (!error) return data?.id;
    lastError = JSON.stringify(error);
    console.error(`Erreur envoi email (tentative ${attempt}/${EMAIL_MAX_ATTEMPTS}):`, error);
    if (attempt < EMAIL_MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, 10_000 * attempt));
  }
  throw new Error(`Envoi email échoué après ${EMAIL_MAX_ATTEMPTS} tentatives : ${lastError}`);
}
