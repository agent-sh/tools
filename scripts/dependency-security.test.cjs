const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { readFile, mkdtemp, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
// read-yaml-file@1.1.0 is overridden to the CommonJS-compatible 2.1.0:
// it uses js-yaml 4 / argparse 2 and removes sprintf-js, which has no patched release.
// Upgrading js-yaml alone breaks read-yaml-file 1's removed safeLoad API.
// Resolve through the actual Changesets chain, not an unrelated direct install.
const changesetsRequire = createRequire(require.resolve('@changesets/cli/package.json'));
const manypkgPath = changesetsRequire.resolve('@manypkg/get-packages');
const manypkgRequire = createRequire(manypkgPath);
const readYaml = manypkgRequire('read-yaml-file');

test('release dependency graph excludes unpatched sprintf-js (GHSA-hp3w-g68c-fv3c)', async () => {
  const lockfile = await readFile(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  assert.doesNotMatch(lockfile, /\bsprintf-js(?:@|:)/);
  const yamlRequire = createRequire(manypkgRequire.resolve('read-yaml-file'));
  const argparseRequire = createRequire(createRequire(yamlRequire.resolve('js-yaml')).resolve('argparse'));
  const argparse = argparseRequire('./package.json');
  assert.equal(argparse.version, '2.0.1');
  assert.equal(argparse.dependencies?.['sprintf-js'], undefined);
});

test('read-yaml-file preserves async, sync, BOM and invalid-YAML behavior', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-yaml-'));
  try {
    const file = path.join(dir, 'pnpm-workspace.yaml');
    await writeFile(file, '\uFEFFpackages:\n  - packages/*\n  - "!packages/excluded"\n');
    const expected = { packages: ['packages/*', '!packages/excluded'] };
    assert.deepEqual(await readYaml(file), expected);
    assert.deepEqual(readYaml.sync(file), expected);
    await writeFile(file, 'packages: [unterminated');
    await assert.rejects(readYaml(file), { name: 'YAMLException' });
    assert.throws(() => readYaml.sync(file), { name: 'YAMLException' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Changesets workspace discovery still reads every pnpm package', async () => {
  const { getPackages } = changesetsRequire('@manypkg/get-packages');
  const result = await getPackages(root);
  const directories = await readFile(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  assert.match(directories, /packages\/\*/);
  const { readdir } = require('node:fs/promises');
  const expected = [];
  for (const dir of await readdir(path.join(root, 'packages'))) {
    try {
      const json = JSON.parse(await readFile(path.join(root, 'packages', dir, 'package.json'), 'utf8'));
      expected.push(json.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  assert.ok(expected.length > 0);
  assert.deepEqual(result.packages.map(pkg => pkg.packageJson.name).sort(), expected.sort());
});
