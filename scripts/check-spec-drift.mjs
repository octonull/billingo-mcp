// Compares the vendored specs against upstream SwaggerHub.
// Warns; never fails. Upstream being wrong (3.0.15 dropping the live partner
// endpoints) is a known state, and CI must not go red because of it.
import { readFileSync } from 'node:fs';

const VERSIONS = ['3.0.14', '3.0.15'];
let drifted = false;

for (const version of VERSIONS) {
  const url = `https://api.swaggerhub.com/apis/Billingo/Billingo/${version}`;
  let upstream;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      console.log(
        `::warning::${version}: upstream returned HTTP ${response.status}. 3.0.15 is unpublished, so this can happen.`,
      );
      continue;
    }
    upstream = await response.json();
  } catch (error) {
    console.log(`::warning::${version}: could not fetch upstream (${error.message}).`);
    continue;
  }

  const vendored = JSON.parse(readFileSync(`spec/billingo-${version}.json`, 'utf8'));
  const ourPaths = new Set(Object.keys(vendored.paths));
  const theirPaths = new Set(Object.keys(upstream.paths));

  const added = [...theirPaths].filter((p) => !ourPaths.has(p));
  const removed = [...ourPaths].filter((p) => !theirPaths.has(p));

  if (added.length === 0 && removed.length === 0) {
    console.log(`${version}: no path drift.`);
    continue;
  }
  drifted = true;
  if (added.length > 0)
    console.log(`::warning::${version}: upstream ADDED paths not vendored: ${added.join(', ')}`);
  if (removed.length > 0)
    console.log(
      `::warning::${version}: upstream REMOVED paths we still vendor: ${removed.join(', ')}. Check whether the live API still serves them before deleting anything.`,
    );
}

console.log(drifted ? 'Spec drift detected — review the warnings above.' : 'Specs match upstream.');
