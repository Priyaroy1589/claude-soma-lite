import './soma-home.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import process from 'node:process';
import { readFileSync } from 'node:fs';

test('runtime is Node >= 24', () => {
  const major = Number(process.versions.node.split('.')[0]);
  assert.ok(major >= 24, `need Node >= 24, got ${process.versions.node}`);
});

test('package.json holds the global constraints: ESM, Node >= 24, zero deps', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(pkg.type, 'module', 'package must be ESM ("type":"module")');

  assert.ok(
    String(pkg.engines?.node).includes('>=24'),
    `engines.node must pin the Node 24 floor, got ${JSON.stringify(pkg.engines?.node)}`,
  );

  for (const field of ['dependencies', 'devDependencies']) {
    assert.ok(
      !(field in pkg),
      `claude-soma-lite has zero npm dependencies; remove "${field}" and use built-in node: modules`,
    );
  }
});
