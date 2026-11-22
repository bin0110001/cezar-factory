import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

parse(await readFile(new URL('../compose.yaml', import.meta.url), 'utf8'));
JSON.parse(await readFile(new URL('./rules.json', import.meta.url), 'utf8'));
console.log('OCR worker assets parsed');
