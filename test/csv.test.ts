import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCsv } from '../src/example/csv.ts';

test('fields with commas, quotes or line breaks are quoted; formula-looking fields are defused', () => {
  assert.equal(
    toCsv([['a,b', 'say "hi"', 'line\nbreak', '=SUM(A1)', 'plain']]),
    '"a,b","say ""hi""","line\nbreak",\'=SUM(A1),plain\r\n',
  );
});

test('every formula prefix is defused, and quoting still applies after the prefix', () => {
  assert.equal(toCsv([['+1', '-1', '@cmd', '=a,b']]), "'+1,'-1,'@cmd,\"'=a,b\"\r\n");
});

test('rows are joined with CRLF and the output ends with one', () => {
  assert.equal(toCsv([['id', 'name'], ['1', 'x']]), 'id,name\r\n1,x\r\n');
});
