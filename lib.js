// Shared logic for Take the Stand (terminal + browser).
// Everything here runs on-device; the only model calls go through the QVAC SDK.

import fs from 'node:fs';
import path from 'node:path';
import { completion } from '@qvac/sdk';

export const MAX_CHUNK_CHARS = 900;
// Below this best-match score, the notes are treated as unrelated to the plan.
export const MIN_RELEVANCE = 0.6;

// How hard Past You goes on you.
export const TONES = {
  kind: 'Be gentle, warm and encouraging, but still honest.',
  direct: 'Be direct, honest and caring.',
  brutal: 'Be blunt and unsparing, but never insulting about who I am.'
};

export const VERDICTS = {
  pattern: { label: 'GUILTY OF REPEATING A PATTERN', note: 'Your notes show you have been here before.' },
  consistent: { label: 'CONSISTENT WITH YOUR PAST SELF', note: 'Your notes back this plan up.' },
  unclear: { label: 'NOT ENOUGH EVIDENCE', note: 'Your notes do not say much about this.' }
};

export function onProgress(label) {
  return (p) => {
    const mb = (n) => (n / 1e6).toFixed(1);
    const line = `▸ Downloading ${label} ${p.percentage.toFixed(0)}% (${mb(p.downloaded)}/${mb(p.total)} MB)`;
    process.stderr.write(process.stderr.isTTY ? `\r${line}` : `${line}\n`);
    if (p.percentage >= 100) process.stderr.write('\n');
  };
}

// One chunk per paragraph (long paragraphs are split), prefixed with the file name
// so the source and its date travel with the text through embedding and retrieval.
export function readNotes(dirs) {
  const chunks = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/\.(md|txt)$/i.test(file)) continue;
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const para of raw.split(/\n\s*\n/)) {
        const text = para.replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
        if (text.length < 30) continue;
        for (let i = 0; i < text.length; i += MAX_CHUNK_CHARS) {
          chunks.push(`[${file}] ${text.slice(i, i + MAX_CHUNK_CHARS)}`);
        }
      }
    }
  }
  return chunks;
}

export function parseExhibit(content) {
  const m = content.match(/^\[(.+?)\]\s*([\s\S]*)$/);
  return m ? { source: m[1], text: m[2] } : { source: 'unknown', text: content };
}

export function dateFromSource(source) {
  const m = source.match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function buildExhibits(hits) {
  return hits.map((h, i) => {
    const { source, text } = parseExhibit(h.content);
    return {
      letter: String.fromCharCode(65 + i),
      score: Number(h.score),
      source,
      text,
      date: dateFromSource(source)
    };
  });
}

// Exhibits grouped by date, oldest first: [{ date, letters: ['A', 'C'] }]
export function timeline(exhibits) {
  const byDate = new Map();
  for (const e of exhibits) {
    if (!e.date) continue;
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e.letter);
  }
  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, letters]) => ({ date, letters }));
}

function evidenceText(exhibits) {
  return exhibits.map((e) => `Exhibit ${e.letter} (${e.source}): ${e.text}`).join('\n\n');
}

export function crossExamHistory(exhibits, claim, tone) {
  return [
    {
      role: 'system',
      content:
        'You are the user\'s own past self, speaking from their private journal. ' +
        'Speak in first person to your present self. ' + TONES[tone] + ' ' +
        'Only use the journal excerpts you are given.'
    },
    {
      role: 'user',
      content:
        `Here are excerpts from my journal:\n\n${evidenceText(exhibits)}\n\n` +
        `Today I am saying: "${claim}"\n\n` +
        'Reply as my past self in under 100 words. Point out where these excerpts ' +
        'conflict with, or repeat a pattern in, what I am saying today, and cite them ' +
        'as Exhibit A, Exhibit B, etc. If they do not conflict, say so honestly. ' +
        'Make your final sentence one hard question for me. /no_think'
    }
  ];
}

export function verdictHistory(exhibits, claim) {
  return [
    { role: 'system', content: 'You are a strict classifier. Answer with exactly one word.' },
    {
      role: 'user',
      content:
        `Journal excerpts:\n\n${evidenceText(exhibits)}\n\n` +
        `The plan the user states today: "${claim}"\n\n` +
        'Answer with exactly one word:\n' +
        'PATTERN if the journal shows the user already struggled with, failed at, or regretted something similar.\n' +
        'CONSISTENT if the plan matches lessons the journal says the user learned.\n' +
        'UNCLEAR if the excerpts are not really about this plan.\n' +
        '/no_think'
    }
  ];
}

// Picks whichever verdict word the model said first; anything else is "unclear".
export function parseVerdict(text) {
  const up = String(text).toUpperCase();
  const found = ['PATTERN', 'CONSISTENT', 'UNCLEAR']
    .map((k) => [k, up.indexOf(k)])
    .filter(([, i]) => i >= 0)
    .sort((a, b) => a[1] - b[1]);
  return found.length ? found[0][0].toLowerCase() : 'unclear';
}

export async function getVerdict(llmId, exhibits, claim) {
  if (!exhibits.length) return 'unclear';
  const best = Math.max(...exhibits.map((e) => e.score));
  if (best < MIN_RELEVANCE) return 'unclear';
  const run = completion({
    modelId: llmId,
    history: verdictHistory(exhibits, claim),
    stream: true,
    captureThinking: true,
    generationParams: { temp: 0, predict: 200 }
  });
  const final = await run.final;
  return parseVerdict(final.contentText);
}
