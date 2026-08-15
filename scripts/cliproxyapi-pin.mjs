#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLI_PROXY_PIN_PATH = fileURLToPath(
  new URL('./cliproxyapi-pin.json', import.meta.url),
);

const STOCK_UPSTREAM = 'https://github.com/router-for-me/CLIProxyAPI';
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GO_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

function objectValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('pin must be a JSON object');
  }
  return value;
}

function requiredString(pin, field) {
  const value = pin[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`pin is missing required string '${field}'`);
  }
  return value;
}

export function parseCLIProxyPin(input) {
  let decoded;
  try {
    decoded = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (error) {
    throw new Error(`pin is not valid JSON: ${error.message}`);
  }

  const value = objectValue(decoded);
  const repository = requiredString(value, 'repository');
  const tag = requiredString(value, 'tag');
  const commit = requiredString(value, 'commit');
  const goVersion = requiredString(value, 'goVersion');
  const goDarwinArm64Sha256 = requiredString(value, 'goDarwinArm64Sha256');
  const bundlePath = requiredString(value, 'bundlePath');

  if (repository !== STOCK_UPSTREAM) {
    throw new Error(`repository must remain the stock upstream ${STOCK_UPSTREAM}`);
  }
  if (!RELEASE_TAG.test(tag)) {
    throw new Error(`tag '${tag}' is not an immutable version tag; floating refs are forbidden`);
  }
  if (!FULL_SHA.test(commit)) {
    throw new Error('commit must be a full lowercase 40-character SHA');
  }
  if (!GO_VERSION.test(goVersion)) {
    throw new Error('goVersion must be a pinned dotted release version');
  }
  if (!SHA256.test(goDarwinArm64Sha256)) {
    throw new Error('goDarwinArm64Sha256 must be a lowercase SHA-256');
  }
  if (
    path.posix.isAbsolute(bundlePath)
    || path.posix.normalize(bundlePath) !== bundlePath
    || !bundlePath.startsWith('Contents/Resources/')
    || bundlePath.endsWith('/')
    || !/^[0-9A-Za-z._/-]+$/.test(bundlePath)
  ) {
    throw new Error('bundlePath must be a normalized file below Contents/Resources');
  }

  return Object.freeze({
    repository,
    tag,
    commit,
    goVersion,
    goDarwinArm64Sha256,
    bundlePath,
    version: tag.slice(1),
  });
}

export function readCLIProxyPin(pinPath = CLI_PROXY_PIN_PATH) {
  return parseCLIProxyPin(fs.readFileSync(pinPath, 'utf8'));
}

export function assertFetchedSource(pin, { tagCommit, headCommit, dirty = false }) {
  if (!FULL_SHA.test(tagCommit ?? '')) {
    throw new Error('fetched tag did not resolve to a full commit SHA');
  }
  if (tagCommit !== pin.commit) {
    throw new Error(`tag/SHA mismatch: ${pin.tag} resolves to ${tagCommit}, pin records ${pin.commit}`);
  }
  if (!FULL_SHA.test(headCommit ?? '') || headCommit !== pin.commit) {
    throw new Error(`checked-out HEAD ${headCommit || '(missing)'} is not pinned commit ${pin.commit}`);
  }
  if (dirty) {
    throw new Error('fetched source is dirty; refusing to build');
  }
}

export function resolveBundledCLIProxyPath(appBundlePath, pin) {
  const appRoot = path.resolve(appBundlePath);
  const resolved = path.resolve(appRoot, ...pin.bundlePath.split('/'));
  if (!resolved.startsWith(`${appRoot}${path.sep}`)) {
    throw new Error('bundlePath escapes the app bundle');
  }
  return resolved;
}

export function cliProxyManifest({ binaryPath, pin }) {
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(binaryPath)).digest('hex');
  return {
    artifact: 'cliproxyapi',
    upstreamTag: pin.tag,
    upstreamCommit: pin.commit,
    goVersion: pin.goVersion,
    target: 'darwin/arm64',
    sha256,
  };
}

export function verifyCLIProxyArtifact({ binaryPath, manifestPath, pin }) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`artifact manifest is not valid JSON: ${error.message}`);
  }
  const expected = cliProxyManifest({ binaryPath, pin });
  for (const [field, value] of Object.entries(expected)) {
    if (manifest?.[field] !== value) {
      throw new Error(`artifact manifest ${field} mismatch: expected ${value}, got ${manifest?.[field] ?? '(missing)'}`);
    }
  }
  return manifest;
}

function writeCLIProxyManifest(binaryPath, manifestPath, pin) {
  const temporary = `${manifestPath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cliProxyManifest({ binaryPath, pin }), null, 2)}\n`, {
    mode: 0o644,
  });
  fs.renameSync(temporary, manifestPath);
}

function main(args) {
  const [command, ...rest] = args;
  if (command === 'values' && rest.length <= 1) {
    const pin = readCLIProxyPin(rest[0]);
    process.stdout.write([
      pin.repository,
      pin.tag,
      pin.commit,
      pin.goVersion,
      pin.goDarwinArm64Sha256,
      pin.bundlePath,
    ].join('\t'));
    return;
  }
  if (command === 'verify-source' && (rest.length === 3 || rest.length === 4)) {
    const [tagCommit, headCommit, cleanliness, pinPath] = rest;
    if (cleanliness !== 'clean' && cleanliness !== 'dirty') {
      throw new Error("source cleanliness must be 'clean' or 'dirty'");
    }
    const pin = readCLIProxyPin(pinPath);
    assertFetchedSource(pin, { tagCommit, headCommit, dirty: cleanliness === 'dirty' });
    return;
  }
  if (command === 'bundle-path' && (rest.length === 1 || rest.length === 2)) {
    const [appBundlePath, pinPath] = rest;
    process.stdout.write(resolveBundledCLIProxyPath(appBundlePath, readCLIProxyPin(pinPath)));
    return;
  }
  if (command === 'write-manifest' && (rest.length === 2 || rest.length === 3)) {
    const [binaryPath, manifestPath, pinPath] = rest;
    writeCLIProxyManifest(binaryPath, manifestPath, readCLIProxyPin(pinPath));
    return;
  }
  if (command === 'verify-artifact' && (rest.length === 2 || rest.length === 3)) {
    const [binaryPath, manifestPath, pinPath] = rest;
    verifyCLIProxyArtifact({ binaryPath, manifestPath, pin: readCLIProxyPin(pinPath) });
    return;
  }
  throw new Error(
    'usage: cliproxyapi-pin.mjs values [pin-file] | verify-source <tag-sha> <head-sha> <clean|dirty> [pin-file] | bundle-path <app-bundle> [pin-file] | write-manifest <binary> <manifest> [pin-file] | verify-artifact <binary> <manifest> [pin-file]',
  );
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`cliproxyapi-pin.mjs: ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
