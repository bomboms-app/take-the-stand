#!/usr/bin/env node
// Take the Stand: your own past notes take the stand against your present plans.
// 100% on-device: embeddings, retrieval and generation all run through QVAC.

import readline from 'node:readline/promises';
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

const NOTES_DIR = process.env.PAST_YOU_NOTES || './notes';
const MY_NOTES_DIR = process.env.PAST_YOU_MY_NOTES || './my-notes';
const WORKSPACE = 'take-the-stand';
const TOP_K = 4;

// Set PAST_YOU_TONE=kind | direct | brutal
const TONE = Object.hasOwn(TONES, process.env.PAST_YOU_TONE) ? process.env.PAST_YOU_TONE : 'direct';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[92m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`
};

let caseNumber = 0;

async function crossExamine({ llmId, embedId, claim }) {
  caseNumber += 1;
  const hits = await ragSearch({ modelId: embedId, workspace: WORKSPACE, query: claim, topK: TOP_K });

  console.log(`\n${c.green(c.bold(`CASE #${caseNumber}`))} ${c.dim(`· tone: ${TONE}`)}`);

  if (!hits.length) {
    console.log(c.yellow('No relevant notes found. Nothing to cross-examine you with.\n'));
    return;
  }

  const exhibits = buildExhibits(hits);

  console.log(c.bold('EXHIBITS FROM YOUR OWN NOTES'));
  for (const e of exhibits) {
    console.log(`${c.green(`Exhibit ${e.letter}`)} ${c.dim(`${e.source} · relevance ${e.score.toFixed(2)}`)}`);
    console.log(`  ${e.text.length > 220 ? e.text.slice(0, 220) + '…' : e.text}`);
  }

  const tl = timeline(exhibits);
  if (tl.length) {
    console.log(`\n${c.bold('TIMELINE')}  ${tl.map((t) => `${t.date} (${t.letters.join(', ')})`).join(c.dim('  →  '))}`);
  }

  console.log(`\n${c.bold('PAST YOU TAKES THE STAND')}\n`);
  const run = completion({
    modelId: llmId,
    history: crossExamHistory(exhibits, claim, TONE),
    stream: true,
    captureThinking: true,
    generationParams: { temp: 0.4, predict: 900 }
  });

  for await (const event of run.events) {
    if (event.type === 'contentDelta') process.stdout.write(event.text);
  }
  const final = await run.final;
  const tps = final.stats?.tokensPerSecond;

  process.stdout.write(c.dim('\n\nWeighing the evidence… '));
  const verdict = VERDICTS[await getVerdict(llmId, exhibits, claim)];
  console.log(`\n${c.green(c.bold('VERDICT: ' + verdict.label))}  ${c.dim(verdict.note)}`);
  console.log(c.dim(`(${tps ? tps.toFixed(1) + ' tok/s · ' : ''}generated locally, nothing left this machine)\n`));
}

async function main() {
  const dirs = [NOTES_DIR, MY_NOTES_DIR];
  const chunks = readNotes(dirs);
  if (!chunks.length) {
    console.error(`No .md/.txt notes found in "${NOTES_DIR}". Add some, or set PAST_YOU_NOTES=/path/to/notes`);
    process.exit(1);
  }

  console.log(c.green(c.bold('\nTake the Stand')) + c.dim(': your past notes vs. your present plans'));
  console.log(c.dim(`${chunks.length} note passages · tone: ${TONE}\n`));

  let embedId;
  let llmId;
  try {
    embedId = await loadModel({ modelSrc: GTE_LARGE_FP16, onProgress: onProgress('embedding model') });
    llmId = await loadModel({
      modelSrc: QWEN3_1_7B_INST_Q4,
      modelConfig: { ctx_size: 4096 },
      onProgress: onProgress('language model')
    });

    try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* none yet */ }

    process.stdout.write('▸ Reading your notes on-device… ');
    const result = await ragIngest({ modelId: embedId, workspace: WORKSPACE, documents: chunks, chunk: false });
    console.log(`indexed ${result.processed.length} passages.`);

    const argClaim = process.argv.slice(2).join(' ').trim();
    if (argClaim) {
      await crossExamine({ llmId, embedId, claim: argClaim });
    } else {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      console.log(c.dim('\nCourt is in session. Tell Past You what you\'re about to do or believe. Empty line to adjourn.\n'));
      while (true) {
        const claim = (await rl.question(c.bold('I am going to… › '))).trim();
        if (!claim) break;
        await crossExamine({ llmId, embedId, claim });
      }
      rl.close();
      console.log(c.green('Court adjourned.\n'));
    }
  } catch (error) {
    console.error('✖', error);
    process.exitCode = 1;
  } finally {
    try { await ragCloseWorkspace({ workspace: WORKSPACE, deleteOnClose: true }); } catch { /* ignore */ }
    if (llmId) await unloadModel({ modelId: llmId, clearStorage: false }).catch(() => {});
    if (embedId) await unloadModel({ modelId: embedId, clearStorage: false }).catch(() => {});
    process.exit(process.exitCode ?? 0);
  }
}

main();
