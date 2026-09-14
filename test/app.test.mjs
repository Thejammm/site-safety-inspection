// Site Safety Inspection tests - run with: npm test
//
// This app has lost a client's data in production once (2026-08-25: 28 photos,
// two silent failures at once). Most of what follows exists because something
// here broke for real, not because it seemed worth asserting. The source
// guards come first: they are the ones a future edit is most likely to undo
// without noticing, because nothing on screen changes when they go.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const APP = path.join(here, '..', 'public', 'index.html');
const SRC = fs.readFileSync(APP, 'utf8');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(p => fs.existsSync(p));

// ────────────────────────────────────────────────────────────────
//  Source guards - the race and scoping rules that must survive edits
// ────────────────────────────────────────────────────────────────

test('saveNow refuses to write until the first restore has finished, and during a sync reload', () => {
  // Both halves matter. Without _restoredOnce, collectState() reads a
  // half-restored page and writes that over a good draft. Without the
  // AHS_SYNC_RELOADING half, the sync layer's own reload fires pagehide,
  // collects the empty page, and overwrites the draft it just hydrated -
  // which is what silently broke pulling a report onto a second device.
  const m = SRC.match(/function saveNow\s*\(\)\s*\{\s*([\s\S]{0,160})/);
  assert.ok(m, 'saveNow() not found - has it been renamed?');
  assert.match(m[1], /_restoredOnce/, 'saveNow no longer waits for the first restore');
  assert.match(m[1], /AHS_SYNC_RELOADING/, 'saveNow no longer stands down during a sync reload');
});

test('"New inspection" adopts a report that has no visit context instead of wiping it', () => {
  // 2026-09-14: setting an inspection up in the office and then pressing the
  // obvious button destroyed it. The button opened the start form in 'new'
  // mode, which archives the report and runs resetForNewVisit() - clearing
  // sections, item rows, criteria answers, photos and summaries. A report that
  // has never been through the start form IS the inspection being set up, so
  // the handler must branch on hasVisit() and adopt, and must confirm before
  // it ever takes the destructive path.
  const m = SRC.match(/nb\.onclick = function\(\)\s*\{([\s\S]{0,1400}?)\n      \};/);
  assert.ok(m, 'the New inspection button handler was not found - has it been rewired?');
  const body = m[1];
  assert.match(body, /hasVisit\(\s*CUR\.visit\s*\)/,
    'New inspection no longer checks for a visit context - it will wipe the setup again');
  assert.match(body, /adopt\s*:\s*true/,
    'New inspection no longer adopts the report being set up');
  assert.match(body, /confirm\(/,
    'New inspection takes the archive-and-clear path without confirming');
});

test('switching project saves the one you are leaving before clearing the device', () => {
  // 2026-09-14: 'the app doesnt save what i have done when i change to another
  // inspection'. openProject()/newBlankProject() called setProject() and then
  // _clearSyncedKeys() without ever pushing the project being left, so any work
  // newer than the 800ms debounce was wiped off the device having never reached
  // the server - and if the push failed they switched anyway, leaving it blank.
  // Both must flush FIRST, and both must abort when the flush reports failure.
  const flush = SRC.match(/async function _flushCurrent\(\)\s*\{([\s\S]*?)\r?\n {4}\}/);
  assert.ok(flush, '_flushCurrent() is gone - switching can silently drop work again');
  assert.match(flush[1], /clearTimeout\(\s*_saveTimer\s*\)/,
    'a debounced push can still fire after the project name has changed');
  assert.match(flush[1], /saveNow/,
    'the page is not forced into the draft, so the push sends stale content');

  for (const fn of ['openProject', 'newBlankProject']) {
    const m = SRC.match(new RegExp('async function ' + fn + '\\(name\\)\\s*\\{([\\s\\S]*?)\\r?\\n {4}\\}'));
    assert.ok(m, fn + '() not found, or no longer async - it must await the flush');
    const body = m[1];
    const flushAt = body.indexOf('_flushCurrent');
    const setAt = body.indexOf('setProject(');
    assert.ok(flushAt !== -1, fn + ' no longer saves the project being left');
    assert.ok(setAt !== -1, fn + ' no longer sets the project');
    assert.ok(flushAt < setAt, fn + ' changes the target before saving - the push lands under the wrong project');
    assert.match(body, /if\(!\(await _flushCurrent\(\)\)\)/,
      fn + ' does not abort when the save fails - it will clear the device anyway');
  }
});

test('photos can be written out as real files, and the store asks to persist', () => {
  // 2026-09-14: 'i lost them a few weeks ago'. Browser storage had been the only
  // copy on the device. Two things must stay: the origin asks the browser to
  // persist its storage (iOS evicts script storage it thinks is idle), and the
  // Save-photos button that hands the user real image files (share sheet to
  // Photos on iPad, downloads elsewhere). Neither shows on screen when lost.
  assert.match(SRC, /navigator\.storage\.persist\(\)/, 'the persistent-storage request is gone');
  assert.match(SRC, /AHS_PHOTOS\.persist\(\)/, 'persist() is defined but no longer called at load');
  assert.match(SRC, /id="savePhotos"/, 'the Save photos to device button is gone');
  const h = SRC.match(/async function savePhotosToDevice\(\)\s*\{([\s\S]*?)\r?\n\}/);
  assert.ok(h, 'savePhotosToDevice() not found');
  assert.match(h[1], /navigator\.share\(/, 'the share-sheet path (Photos on iPad) is gone');
  assert.match(h[1], /\.download = /, 'the download fallback is gone - desktop users get nothing');
  assert.match(h[1], /AHS_PHOTOS\.get\(/, 'photos not yet in memory are skipped instead of read from the store');
});

test('a poor site signal degrades to amber and a retry, never a hang or a red banner', () => {
  // 2026-09-14: 'on site the web access drops out and the app freezes'. Four
  // rules, each undone silently by a careless edit: every request times out;
  // one upload in flight at a time (edits during it queue one more); photos
  // ride only when the set changed, and the SERVER keeps its copy when the key
  // is absent; a network failure is an amber note plus backoff retry, and the
  // red banner stays reserved for the server actually rejecting.
  const apiFn = SRC.match(/async function api\(path, opts\)\s*\{([\s\S]*?)\r?\n {4}\}/);
  assert.ok(apiFn, 'api() not found');
  assert.match(apiFn[1], /AbortController/, 'requests no longer time out - a stalled signal hangs the app');
  assert.match(SRC, /if\(_inflight\)\{ _pushAgain = true; return _inflight; \}/, 'pushes can overlap again');
  assert.match(SRC, /if\(!sendingPhotos\) delete blob\[PHOTO_KEY\];/, 'every save re-uploads every photo again');
  assert.match(SRC, /else if\(!blob\[PHOTO_KEY\]\) blob\[PHOTO_KEY\] = \{\};/, 'deleting the last photo would not clear it on the server');
  assert.match(SRC, /AHS_SAVE_STATUS\.note\('offline'/, 'a lost signal raises the red NOT SAVED banner instead of the amber note');
  assert.match(SRC, /_retryTimer = setTimeout\(function\(\)\{ _retryTimer = null; push\(\); \}, _retryMs\);/, 'no automatic retry when the signal returns');
  // server side of the photo rule
  const route = fs.readFileSync(path.join(here, '..', 'routes', 'state.js'), 'utf8');
  assert.match(route, /require\('\.\/merge-state'\)/, 'routes/state.js no longer merges - an omitted __photos__ would wipe the server copy');
  assert.match(route, /JSON\.stringify\(merged\)/, 'the merged state is not what gets written');
  // service worker: known-offline serves the shell at once
  const sw = fs.readFileSync(path.join(here, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /navigator\.onLine === false/, 'offline load waits the full timeout before showing the cached app');
});

test('the photo store is only ever wiped wholesale from the confirmed device wipe', () => {
  // Clearing this store loses every photo for every report on the device.
  // Per-report clears must delete their own ids. One legitimate caller.
  const lines = SRC.split('\n');
  const callers = lines
    .map((l, i) => ({ l, n: i + 1 }))
    .filter(x => /AHS_PHOTOS\s*\.\s*clear\s*\(/.test(x.l));
  assert.equal(callers.length, 1, 'expected exactly one AHS_PHOTOS.clear() caller, found ' + callers.length);
  // Walk back to the enclosing function and confirm it is the wipe.
  const before = lines.slice(0, callers[0].n).reverse();
  const fn = before.find(l => /^\s*(async\s+)?function\s+\w+/.test(l));
  assert.match(fn, /function\s+wipeDevice/, 'AHS_PHOTOS.clear() has escaped wipeDevice()');
  assert.match(SRC, /function wipeDevice\(\)\s*\{\s*if\s*\(\s*!confirm\(/, 'wipeDevice no longer confirms first');
});

test('sync pushes only the photos this report references, never the whole pool', () => {
  // The store is shared across every project on the device. Pushing all() puts
  // one client's photographs into another client's state blob.
  const i = SRC.indexOf('AHS_PHOTOS.all()');
  assert.ok(i > 0, 'AHS_PHOTOS.all() not found - has the sync payload changed?');
  const after = SRC.slice(i, i + 400);
  assert.match(after, /ids\.forEach|wanted/, 'the photo pool is no longer filtered to referenced ids');
  assert.doesNotMatch(after, /\[\s*PHOTO_KEY\s*\]\s*=\s*pool\b/, 'the entire photo pool is being assigned to the sync blob');
});

test('a failed save always raises the banner, never only a pill or the console', () => {
  // The 2026-08-25 loss was silent: the report looked saved. Every failure
  // path has to reach AHS_SAVE_STATUS.fail.
  assert.match(SRC, /AHS_SAVE_STATUS\.fail\('draft'/, 'draft failures no longer raise the banner');
  const fails = (SRC.match(/AHS_SAVE_STATUS\.fail\(/g) || []).length;
  assert.ok(fails >= 3, 'expected the banner on at least the draft, photo and server paths, found ' + fails);
});

test('item row cells wrap instead of overflowing', () => {
  // Grid children default to min-width:auto, which refuses to shrink and
  // pushes long text out of the cell rather than wrapping it.
  assert.match(SRC, /\.item-row\s*>\s*\*\s*\{[^}]*min-width\s*:\s*0/, 'the grid min-width trap guard is gone');
  assert.match(SRC, /\.item-row\s+\.rte\s*\{[^}]*overflow-wrap\s*:\s*anywhere/, 'item row text no longer wraps on long unbroken strings');
});

test('the offline shell is network-first and its cache name was bumped', () => {
  // Cache-first left every iPad a build behind. The cache name must also
  // change per build or the old shell is served from disk forever.
  const sw = fs.readFileSync(path.join(here, '..', 'public', 'sw.js'), 'utf8');
  assert.match(sw, /ahs-ssi-rev4-\d+/, 'the cache name no longer carries a build number');
  assert.doesNotMatch(sw, /caches\.match\([^)]*\)\s*\.then\(\s*(function\s*\([^)]*\)\s*\{\s*)?return\s+\w+\s*\|\|\s*fetch/,
    'the shell looks cache-first again - iPads will sit a build behind');
});

// ────────────────────────────────────────────────────────────────
//  Behaviour - the app booted from disk, as an inspector uses it offline
// ────────────────────────────────────────────────────────────────

const boot = async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 200)));
  page.on('dialog', d => d.accept());
  await page.goto('file:///' + APP.split(path.sep).join('/'), { waitUntil: 'networkidle0', timeout: 60000 });
  await new Promise(r => setTimeout(r, 1500));
  return { browser, page, errs };
};

test('the app boots from disk with no script errors', { skip: !CHROME && 'Chrome not found' }, async () => {
  const { browser, page, errs } = await boot();
  const ready = await page.evaluate(() => ({
    draft: !!(window.AHS_DRAFT && window.AHS_DRAFT.collect),
    photos: !!(window.AHS_PHOTOS && window.AHS_PHOTOS.put),
    capture: !!(window.AHS_CAPTURE && window.AHS_CAPTURE.syncItem),
    status: !!(window.AHS_SAVE_STATUS && window.AHS_SAVE_STATUS.fail),
  }));
  await browser.close();
  assert.deepEqual(errs, [], 'script errors on boot');
  assert.deepEqual(ready, { draft: true, photos: true, capture: true, status: true });
});

test('no unrendered values reach the screen', { skip: !CHROME && 'Chrome not found' }, async () => {
  // The same defect class fixed in the Compass report layer: a value that
  // reaches the page as "[object Object]" is invisible to any test that
  // asserts on the data behind it, because the data is right.
  const { browser, page, errs } = await boot();
  const seen = await page.evaluate(() => document.body.innerText);
  await browser.close();
  assert.doesNotMatch(seen, /\[object Object\]/, 'the page prints [object Object]');
  assert.doesNotMatch(seen, /(^|[\s(\[,:])undefined([\s).\],]|$)/, 'the page prints undefined');
  assert.doesNotMatch(seen, /(^|[\s(\[,:])NaN([\s).\],%]|$)/, 'the page prints NaN');
  assert.deepEqual(errs, []);
});

test('the draft carries photo ids, never the image data', { skip: !CHROME && 'Chrome not found' }, async () => {
  // A draft holding base64 images blows Safari's ~5MB localStorage cap at
  // about three photos, and the write throws. Ids only.
  const { browser, page, errs } = await boot();
  const r = await page.evaluate(async () => {
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(4000);
    await window.AHS_PHOTOS.put('test-photo-1', dataUrl);
    const back = await window.AHS_PHOTOS.get('test-photo-1');
    const draft = JSON.stringify(await window.AHS_DRAFT.collect());
    await window.AHS_PHOTOS.del('test-photo-1');
    const gone = await window.AHS_PHOTOS.get('test-photo-1');
    return { roundTrip: back === dataUrl, draftHasImageData: draft.indexOf('A'.repeat(200)) >= 0, deleted: !gone };
  });
  await browser.close();
  assert.ok(r.roundTrip, 'the photo store did not return what was put in it');
  assert.ok(!r.draftHasImageData, 'image data is being written into the localStorage draft');
  assert.ok(r.deleted, 'deleting a photo left it in the store');
  assert.deepEqual(errs, []);
});

test('deleting a photo removes only that id', { skip: !CHROME && 'Chrome not found' }, async () => {
  const { browser, page, errs } = await boot();
  const r = await page.evaluate(async () => {
    await window.AHS_PHOTOS.put('keep-me', 'data:image/png;base64,AAAA');
    await window.AHS_PHOTOS.put('drop-me', 'data:image/png;base64,BBBB');
    await window.AHS_PHOTOS.del('drop-me');
    const kept = await window.AHS_PHOTOS.get('keep-me');
    const dropped = await window.AHS_PHOTOS.get('drop-me');
    await window.AHS_PHOTOS.del('keep-me');
    return { kept: !!kept, dropped: !dropped };
  });
  await browser.close();
  assert.ok(r.kept, 'deleting one photo took another with it');
  assert.ok(r.dropped);
  assert.deepEqual(errs, []);
});

test('dropping a section deselects its checks but keeps the answers', { skip: !CHROME && 'Chrome not found' }, async () => {
  // Removing a section from the report used to be undone by the next build.
  // Answers are kept so re-selecting restores what was recorded on site.
  const { browser, page, errs } = await boot();
  const r = await page.evaluate(() => {
    if (!window.AHS_CAPTURE || !window.AHS_CAPTURE.dropSection) return { skip: true };
    const before = window.AHS_CAPTURE.serialize ? JSON.stringify(window.AHS_CAPTURE.serialize()) : '';
    let threw = null;
    try { window.AHS_CAPTURE.dropSection('no-such-instance'); } catch (e) { threw = e.message; }
    const after = window.AHS_CAPTURE.serialize ? JSON.stringify(window.AHS_CAPTURE.serialize()) : '';
    return { skip: false, threw, unchanged: before === after };
  });
  await browser.close();
  if (r.skip) { assert.fail('AHS_CAPTURE.dropSection is missing'); }
  assert.equal(r.threw, null, 'dropSection threw on an unknown instance id');
  assert.ok(r.unchanged, 'dropSection mutated state for an instance that does not exist');
  assert.deepEqual(errs, []);
});

test('syncItem accepts inc so a removed row stays removed', { skip: !CHROME && 'Chrome not found' }, async () => {
  const { browser, page, errs } = await boot();
  const ok = await page.evaluate(() => {
    const src = window.AHS_CAPTURE.syncItem.toString();
    return /\binc\b/.test(src);
  });
  await browser.close();
  assert.ok(ok, 'syncItem no longer handles inc - removed rows will come back on the next build');
  assert.deepEqual(errs, []);
});
