import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const files = [
  'node_modules/zca-js/dist/apis/sendMessage.js',
  'node_modules/zca-js/dist/cjs/apis/sendMessage.cjs',
];

const before = 'qmsgAttach: isGroupMessage ? JSON.stringify(prepareQMSGAttach(quote)) : undefined';
const after = 'qmsgAttach: JSON.stringify(prepareQMSGAttach(quote))';

let patched = 0;
for (const file of files) {
  if (!existsSync(file)) {
    console.warn(`[patch-zca-js] Skip ${file}: not found`);
    continue;
  }

  const source = readFileSync(file, 'utf8');
  if (source.includes(after)) continue;
  if (!source.includes(before)) {
    throw new Error(`[patch-zca-js] Expected qmsgAttach guard not found in ${file}; zca-js sendMessage may have changed.`);
  }

  writeFileSync(file, source.replace(before, after));
  patched += 1;
}

if (patched > 0) console.log(`[patch-zca-js] Patched qmsgAttach for ${patched} file(s).`);
