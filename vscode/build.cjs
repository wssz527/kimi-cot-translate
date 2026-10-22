const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { assertEngine } = require('./adapter.cjs');

const source = join(__dirname, '..', 'kct.js');
assertEngine(require(source));
mkdirSync(join(__dirname, 'vendor'), { recursive: true });
writeFileSync(join(__dirname, 'vendor', 'kct.cjs'), readFileSync(source));
console.log('Built vscode/vendor/kct.cjs from the shared Node/browser translator.');
