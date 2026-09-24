#!/usr/bin/env node
// Take the Stand (web): the same on-device cross-examination, in your browser.
// The server binds to 127.0.0.1 only, so it is reachable from this computer alone.
// Embeddings, retrieval and generation all run locally through QVAC.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import {
  loadModel,
  unloadModel,
  completion,
  ragIngest,
  ragSearch,
  ragCloseWorkspace,
  GTE_LARGE_FP16,
  QWEN3_1_7B_INST_Q4
} from '@qvac/sdk';
import {
  TONES,
  VERDICTS,
  readNotes,
  buildExhibits,
  timeline,
  crossExamHistory,
  getVerdict,
  onProgress
} from './lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const NOTES_DIR = process.env.PAST_YOU_NOTES || './notes';
const MY_NOTES_DIR = process.env.PAST_YOU_MY_NOTES || './my-notes';
const PORT = Number(process.env.PORT) || 3000;
const WORKSPACE = 'take-the-stand-web';
const TOP_K = 4;
const MAX_CLAIM_CHARS = 500;
const MIN_NOTE_CHARS = 30;
const MAX_NOTE_CHARS = 4000;

let embedId;
let llmId;
let passageCount = 0;
let busy = false; // one job at a time keeps the local models happy

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function send(res, obj) {
  res.write(JSON.stringify(obj) + '\n');
}

function readBody(req, limit = 20_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Rebuilds the on-device index from every note file (samples + your own entries).
async function reindex() {
  const chunks = readNotes([NOTES_DIR, MY_NOTES_DIR]);
  try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* none yet */ }
  if (!chunks.length) {
    passageCount = 0;
    return 0;
  }
  const result = await ragIngest({ modelId: embedId, workspace: WORKSPACE, documents: chunks, chunk: false });
  passageCount = result.processed.length;
  return passageCount;
}

async function handleAsk(req, res) {
  let claim = '';
  let tone = 'direct';
  try {
    const body = JSON.parse(await readBody(req));
    claim = String(body.claim || '').trim().slice(0, MAX_CLAIM_CHARS);
    if (Object.hasOwn(TONES, body.tone)) tone = body.tone;
  } catch {
    return json(res, 400, { error: 'Bad request' });
  }
  if (!claim) return json(res, 400, { error: 'Type what you are about to do first.' });
  if (busy) return json(res, 429, { error: 'Court is busy. Try again in a moment.' });

  busy = true;
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
  try {
    const hits = await ragSearch({ modelId: embedId, workspace: WORKSPACE, query: claim, topK: TOP_K });
    const exhibits = buildExhibits(hits);
    send(res, { type: 'exhibits', exhibits, timeline: timeline(exhibits), tone });

    if (!exhibits.length) {
      send(res, { type: 'done' });
      return;
    }

    const run = completion({
      modelId: llmId,
      history: crossExamHistory(exhibits, claim, tone),
      stream: true,
      captureThinking: true,
      generationParams: { temp: 0.4, predict: 900 }
    });

    for await (const event of run.events) {
      if (event.type === 'contentDelta') send(res, { type: 'token', text: event.text });
    }
    const final = await run.final;

    send(res, { type: 'weighing' });
    const key = await getVerdict(llmId, exhibits, claim);
    send(res, { type: 'verdict', verdict: key, ...VERDICTS[key] });
    send(res, { type: 'done', tokensPerSecond: final.stats?.tokensPerSecond ?? null });
  } catch (error) {
    console.error('✖', error);
    send(res, { type: 'error', message: 'Something went wrong while generating. Check the terminal.' });
  } finally {
    busy = false;
    res.end();
  }
}

async function handleNotes(req, res) {
  let text = '';
  let date = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in local time
  try {
    const body = JSON.parse(await readBody(req));
    text = String(body.text || '').trim();
    if (body.date) date = String(body.date);
  } catch {
    return json(res, 400, { error: 'Bad request' });
  }
  if (text.length < MIN_NOTE_CHARS) return json(res, 400, { error: `Write at least ${MIN_NOTE_CHARS} characters.` });
  if (text.length > MAX_NOTE_CHARS) return json(res, 400, { error: `Keep an entry under ${MAX_NOTE_CHARS} characters.` });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    return json(res, 400, { error: 'That date does not look right.' });
  }
  if (busy) return json(res, 429, { error: 'Court is busy. Try again in a moment.' });

  busy = true;
  try {
    fs.mkdirSync(MY_NOTES_DIR, { recursive: true });
    const file = `browser-${date}-${Date.now()}.md`;
    fs.writeFileSync(path.join(MY_NOTES_DIR, file), `# ${date}\n\n${text}\n`);
    const passages = await reindex();
    json(res, 200, { ok: true, passages, file });
  } catch (error) {
    console.error('✖', error);
    json(res, 500, { error: 'Could not save the entry. Check the terminal.' });
  } finally {
    busy = false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } else if (req.method === 'GET' && url.pathname === '/api/info') {
      json(res, 200, { passages: passageCount, notesDir: NOTES_DIR });
    } else if (req.method === 'POST' && url.pathname === '/api/ask') {
      await handleAsk(req, res);
    } else if (req.method === 'POST' && url.pathname === '/api/notes') {
      await handleNotes(req, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  } catch (error) {
    console.error('✖', error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

async function shutdown() {
  console.log('\n▸ Shutting down…');
  server.close();
  try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* ignore */ }
  if (llmId) await unloadModel({ modelId: llmId, clearStorage: false }).catch(() => {});
  if (embedId) await unloadModel({ modelId: embedId, clearStorage: false }).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function main() {
  if (!readNotes([NOTES_DIR, MY_NOTES_DIR]).length) {
    console.error(`No .md/.txt notes found in "${NOTES_DIR}". Add some, or set PAST_YOU_NOTES=/path/to/notes`);
    process.exit(1);
  }

  try {
    embedId = await loadModel({ modelSrc: GTE_LARGE_FP16, onProgress: onProgress('embedding model') });
    llmId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelConfig: { ctx_size: 4096 },
      onProgress: onProgress('language model')
    });
    console.log(`▸ Indexed ${await reindex()} passages on-device.`);
  } catch (error) {
    console.error('✖', error);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n▸ Take the Stand is in session: http://localhost:${PORT}`);
    console.log('▸ Only this computer can open it. Press Ctrl+C to stop.\n');
  });
}

main();
