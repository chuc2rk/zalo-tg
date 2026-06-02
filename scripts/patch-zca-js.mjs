import { readFileSync, writeFileSync, existsSync } from 'node:fs';

let patched = 0;

function patchFile(file, patches) {
  if (!existsSync(file)) {
    console.warn(`[patch-zca-js] Skip ${file}: not found`);
    return;
  }

  let source = readFileSync(file, 'utf8');
  let changed = false;

  for (const { name, before, after, marker } of patches) {
    if (marker && source.includes(marker)) continue;
    if (source.includes(after)) continue;
    if (!source.includes(before)) {
      throw new Error(`[patch-zca-js] Expected ${name} block not found in ${file}; zca-js may have changed.`);
    }
    source = source.replace(before, after);
    changed = true;
  }

  if (changed) {
    writeFileSync(file, source);
    patched += 1;
  }
}

const qmsgPatch = {
  name: 'qmsgAttach quote guard',
  before: 'qmsgAttach: isGroupMessage ? JSON.stringify(prepareQMSGAttach(quote)) : undefined',
  after: 'qmsgAttach: JSON.stringify(prepareQMSGAttach(quote))',
};

for (const file of [
  'node_modules/zca-js/dist/apis/sendMessage.js',
  'node_modules/zca-js/dist/cjs/apis/sendMessage.cjs',
]) {
  patchFile(file, [qmsgPatch]);
}

const esmUploadConcurrencyPatch = {
  name: 'uploadAttachment concurrency limiter (esm)',
  marker: 'ZCA_UPLOAD_CONCURRENCY',
  before: `const requests = [], results = [];
        for (let atmIndex = 0; atmIndex < attachmentsData.length; atmIndex++) {`,
  after: `const requests = [], results = [];
        const uploadConcurrency = Math.max(1, Number(process.env.ZCA_UPLOAD_CONCURRENCY || 3));
        const runUploadQueue = async () => {
            for (let i = 0; i < requests.length; i += uploadConcurrency) {
                await Promise.all(requests.slice(i, i + uploadConcurrency).map((request) => request()));
            }
        };
        for (let atmIndex = 0; atmIndex < attachmentsData.length; atmIndex++) {`,
};
const esmUploadRequestPatch = {
  name: 'uploadAttachment deferred requests (esm)',
  before: `requests.push(utils
                    .request(utils.makeURL(url + urlType[data.fileType], { type: typeParam, params: encryptedParams }), {
                    method: "POST",
                    headers: data.chunkContent[i].getHeaders(),
                    body: data.chunkContent[i].getBuffer(),
                })
                    .then(async (response) => {`,
  after: `requests.push(() => utils
                    .request(utils.makeURL(url + urlType[data.fileType], { type: typeParam, params: encryptedParams }), {
                    method: "POST",
                    headers: data.chunkContent[i].getHeaders(),
                    body: data.chunkContent[i].getBuffer(),
                })
                    .then(async (response) => {`,
};
const esmUploadRunPatch = {
  name: 'uploadAttachment run queue (esm)',
  before: '        await Promise.all(requests);',
  after: '        await runUploadQueue();',
};

patchFile('node_modules/zca-js/dist/apis/uploadAttachment.js', [
  esmUploadConcurrencyPatch,
  esmUploadRequestPatch,
  esmUploadRunPatch,
]);

const cjsUploadConcurrencyPatch = {
  name: 'uploadAttachment concurrency limiter (cjs)',
  marker: 'ZCA_UPLOAD_CONCURRENCY',
  before: `const requests = [], results = [];
        for (let atmIndex = 0; atmIndex < attachmentsData.length; atmIndex++) {`,
  after: `const requests = [], results = [];
        const uploadConcurrency = Math.max(1, Number(process.env.ZCA_UPLOAD_CONCURRENCY || 3));
        const runUploadQueue = async () => {
            for (let i = 0; i < requests.length; i += uploadConcurrency) {
                await Promise.all(requests.slice(i, i + uploadConcurrency).map((request) => request()));
            }
        };
        for (let atmIndex = 0; atmIndex < attachmentsData.length; atmIndex++) {`,
};
const cjsUploadRequestPatch = {
  name: 'uploadAttachment deferred requests (cjs)',
  before: `requests.push(utils$1
                    .request(utils$1.makeURL(url + urlType[data.fileType], { type: typeParam, params: encryptedParams }), {
                    method: "POST",
                    headers: data.chunkContent[i].getHeaders(),
                    body: data.chunkContent[i].getBuffer(),
                })
                    .then(async (response) => {`,
  after: `requests.push(() => utils$1
                    .request(utils$1.makeURL(url + urlType[data.fileType], { type: typeParam, params: encryptedParams }), {
                    method: "POST",
                    headers: data.chunkContent[i].getHeaders(),
                    body: data.chunkContent[i].getBuffer(),
                })
                    .then(async (response) => {`,
};
const cjsUploadRunPatch = {
  name: 'uploadAttachment run queue (cjs)',
  before: '        await Promise.all(requests);',
  after: '        await runUploadQueue();',
};

patchFile('node_modules/zca-js/dist/cjs/apis/uploadAttachment.cjs', [
  cjsUploadConcurrencyPatch,
  cjsUploadRequestPatch,
  cjsUploadRunPatch,
]);

if (patched > 0) console.log(`[patch-zca-js] Patched ${patched} zca-js file(s).`);
