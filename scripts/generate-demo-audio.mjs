#!/usr/bin/env node
/**
 * Generate demo interaction audio with the Bailian (DashScope) Qwen-TTS
 * model — the same product family as the LubanNav voice assistant.
 *
 * Produces per-scene, per-role WAV files (user question + assistant reply
 * as separate tracks, zh and en) under artifacts/demo-audio/ so video/PPT
 * editors can mix them freely.
 *
 * Requires DASHSCOPE_API_KEY (reads .env.codex.local / .env / env).
 * Usage: node scripts/generate-demo-audio.mjs
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
// Public so the files ship with the site (dist) and can be referenced by
// future offline-demo features; also version-controlled in git.
const OUT_DIR = resolve(ROOT, 'public/demo-audio');
const TTS_ENDPOINT =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';

const ASSISTANT_VOICE = 'Cherry'; // female, close to the live voice style
const USER_VOICE = 'Ethan'; // male, distinguishes the user track

const SCENES = [
  {
    id: 'ask-library',
    zh: {
      user: '带我去图书馆。',
      assistant: '好的，从主入口到图书馆大约九百八十五米，步行约十四分钟。现在出发吧，我会一路为您导航。',
    },
    en: {
      user: 'Take me to the library.',
      assistant: "Sure. From the main entrance to the library it's about 985 meters, a 14-minute walk. Let's go — I'll guide you the whole way.",
    },
  },
  {
    id: 'along-the-way',
    zh: {
      user: '沿途会经过哪些地方？',
      assistant: '您会依次经过活动中心和行政大楼。活动中心是学生社团的聚集场所，行政大楼是校级行政办公区域。',
    },
    en: {
      user: 'What will we pass along the way?',
      assistant: "You'll pass the Student Activity Center and the Administration Building. The Activity Center hosts student clubs, and the Administration Building holds the university offices.",
    },
  },
  {
    id: 'weather',
    zh: {
      user: '今天要带伞吗？',
      assistant: '今天多云有阵雨，降水概率百分之七十，建议出门带伞。三楼的露天平台会比较湿滑，走路时注意脚下。',
    },
    en: {
      user: 'Do I need an umbrella today?',
      assistant: "It's cloudy with showers today — a 70 percent chance of rain. I'd bring an umbrella, and watch your step. The open-air platform on the 3rd floor may be slippery.",
    },
  },
  {
    id: 'bag',
    zh: {
      user: '你可以帮我背包吗？',
      assistant: '如果你有包，可以尝试放在小车的平台上，我们将会一起移动。您可以直接放在我身上。',
    },
    en: {
      user: 'Can you carry my bag?',
      assistant: "If you have a bag, you can put it on the robot's carrier platform and we'll move together. You can place it right on me.",
    },
  },
  {
    id: 'arrival',
    zh: {
      user: '快到了吗？',
      assistant: '已经接近目的地了。请带好随身物品：背包、手机、校园卡和钥匙。谢谢您的使用。',
    },
    en: {
      user: 'Are we almost there?',
      assistant: "We're almost at the destination. Please grab your belongings — backpack, phone, campus card and keys. Thanks for using LubanNav.",
    },
  },
];

function loadApiKey() {
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  for (const file of ['.env.codex.local', '.env']) {
    try {
      const content = readFileSyncSafe(resolve(ROOT, file));
      const match = content?.match(/^\s*DASHSCOPE_API_KEY\s*=\s*(.+)\s*$/m);
      if (match?.[1]) return match[1].trim();
    } catch {
      // try next file
    }
  }
  return null;
}

import { readFileSync } from 'node:fs';
function readFileSyncSafe(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

async function synthesize(text, { voice, language }) {
  const response = await fetch(TTS_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${loadApiKey()}`,
    },
    body: JSON.stringify({
      model: 'qwen3-tts-flash',
      input: { text, voice, language_type: language === 'zh' ? 'Chinese' : 'English' },
    }),
  });
  const body = await response.json();
  const url = body?.output?.audio?.url;
  if (!url) {
    throw new Error(`TTS failed: ${JSON.stringify(body).slice(0, 200)}`);
  }
  const audio = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (audio.length < 1000) throw new Error(`TTS returned a tiny file (${audio.length} B)`);
  return audio;
}

const jobs = [];
for (const scene of SCENES) {
  for (const lang of ['zh', 'en']) {
    const copy = scene[lang];
    jobs.push(
      { file: resolve(OUT_DIR, lang, `${scene.id}.user.wav`), text: copy.user, voice: USER_VOICE, language: lang },
      { file: resolve(OUT_DIR, lang, `${scene.id}.assistant.wav`), text: copy.assistant, voice: ASSISTANT_VOICE, language: lang },
    );
  }
}

let ok = 0;
let skipped = 0;
let failed = 0;

for (const job of jobs) {
  try {
    await mkdir(resolve(OUT_DIR, job.language), { recursive: true });
    try {
      const existing = await readFile(job.file);
      if (existing.length > 0) {
        skipped += 1;
        console.log(`skip  ${job.file.replace(ROOT + '/', '')}`);
        continue;
      }
    } catch {
      // not present yet
    }
    const wav = await synthesize(job.text, job);
    await writeFile(job.file, wav);
    ok += 1;
    console.log(`ok    ${job.file.replace(ROOT + '/', '')} (${(wav.length / 1024).toFixed(0)} KB)`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL  ${job.file.replace(ROOT + '/', '')} — ${error.message}`);
  }
}

console.log(`\nDone: ${ok} generated, ${skipped} skipped, ${failed} failed → ${OUT_DIR}`);
