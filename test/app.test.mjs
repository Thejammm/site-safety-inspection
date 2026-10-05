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
  const m = SRC.match(/nb\.onclick = async function\(\)\s*\{([\s\S]{0,3000}?)\n      \};/);
  assert.ok(m, 'the New inspection button handler was not found - has it been rewired?');
  const body = m[1];
  assert.match(body, /hasVisit\(\s*CUR\.visit\s*\)/,
    'New inspection no longer checks for a visit context - it will wipe the setup again');
  assert.match(body, /adopt\s*:\s*true/,
    'New inspection no longer adopts the report being set up');
  assert.match(body, /confirm\(/,
    'New inspection takes the archive-and-clear path without confirming');
  // 2026-09-22, Simon: an inspection done offline has to be safe on the device
  // before the app is emptied for the next one. New inspection writes the whole
  // report to a file, names the file, and clears nothing if the file never
  // appeared.
  assert.match(body, /await window\.AHS_EXPORT_HTML\(\{ announce: false \}\)/,
    'New inspection no longer saves the inspection to a file before it clears it');
  const saveAt = body.indexOf('AHS_EXPORT_HTML'), clearAt = body.lastIndexOf('openStart({})');
  assert.ok(saveAt > 0 && clearAt > saveAt, 'the report is cleared before the file is written');
  assert.match(body, /if\(!saved\)\{/, 'a failed save no longer stops the clear');
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
  // 2026-09-16: the work moved into window.AHS_TO_DEVICE and savePhotosToDevice
  // became a one-line call into it. The guarantees are unchanged.
  const h = [SRC.slice(SRC.indexOf('window.AHS_TO_DEVICE'), SRC.indexOf('function savePhotosToDevice'))];
  assert.ok(h[1] = h[0], 'the AHS_TO_DEVICE photo module was not found');
  assert.match(h[1], /navigator\.share\(/, 'the share-sheet path (Photos on iPad) is gone');
  assert.match(h[1], /\.download = /, 'the download fallback is gone - desktop users get nothing');
  assert.match(h[1], /dataUrl/, 'the module no longer reads the image data it is meant to write out');
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

test('rebuilding the report leaves untouched sections and hand-added rows alone', () => {
  // 2026-09-14, first site visit: 'the inspection comments keep resetting each
  // time I add another inspection category'. build() rewrote EVERY captured
  // section from builder state on every run. Each section now keeps the
  // signature it was built from and is skipped when that has not changed, and
  // rows the user added by hand (no capKey) are lifted out and put back.
  assert.match(SRC, /if\(sec\.builtSig === sig && !opts\.force\) continue;/,
    'build() rewrites unchanged sections again - editing one section and adding another will reset it');
  assert.match(SRC, /manual\.forEach\(function\(r\)\{ list\.appendChild\(r\); \}\);/,
    'hand-added item rows are dropped on rebuild again');
  assert.ok((SRC.match(/sec\.builtSig = sig;/g) || []).length >= 2, 'the built signature is not recorded on both the built and the emptied path');
});

test('a changed section merges its narrative with what the user typed, instead of regenerating it', () => {
  // Same visit. Even a section that DID change used to be regenerated from
  // scratch, wiping the user's own lines and rewordings in that box. The
  // rebuild now merges: the user's version of a generated line wins, their
  // own lines are kept after, and lines for switched-off items go.
  assert.match(SRC, /function _mergeNarrative\(gen, boxHTML, prevKeys, prevText\)/,
    '_mergeNarrative() is gone - a changed section wipes the user\'s comments again');
  assert.match(SRC, /var html = _mergeNarrative\(gen, boxRte \? boxRte\.innerHTML : \(inst \? inst\.content : ''\), sec\.builtLines \|\| \[\], sec\.builtText \|\| \{\}\);/,
    'the narrative is no longer merged with the box');
  assert.match(SRC, /sec\.builtLines = gen\.map\(function\(g\)\{ return g\.key; \}\);/,
    'generated lines are not remembered, so switched-off items leave their edited lines behind');
  assert.match(SRC, /if\(prevText && prevText\[g\.key\] != null && c\.text === String\(prevText\[g\.key\]\)/,
    'an unedited narrative line no longer takes the new version, so a status letter or note change never reaches the report');
});

test('each item row has its own x; the section-level remove button is gone', () => {
  // 2026-09-14: with an x on every row the '- Remove Item Row' button was
  // clutter and it went, with rowToRemove(). The x itself must stay.
  const add = SRC.match(/function addItemRow\(itemsList\) \{([\s\S]*?)\r?\n\}/);
  assert.ok(add, 'addItemRow not found');
  assert.match(add[1], /class="item-del"/, 'rows have no per-row delete');
  assert.match(add[1], /removeItemRow\(itemsList, itemRow\)/, 'the per-row x does not remove its own row');
  assert.doesNotMatch(SRC, /Remove Item Row|btn-remove-row-btn|function rowToRemove/, 'the section-level remove button is back');
  assert.match(SRC, /@media print\{ \.item-del\{ display:none !important; \} \}/, 'the x would print on the client report');
});

test('findings end with their status letter and the criteria modal has no include switch', () => {
  // Simon, 2026-09-14: a neat letter at the end of every highlighted finding -
  // (A) action, (AD) advisory, (O) observation - and the "In report" switch
  // removed: answering an item puts it in, the x on its report row takes it
  // out, answering it again brings it back.
  assert.match(SRC, /var STATUS_LETTER = \{ minor:'A', advisory:'AD', observation:'O' \};/, 'STATUS_LETTER map changed or gone');
  // 2026-09-15, Simon's review: a finding carries the CHECK'S NAME. The criteria
  // sentence is written as a pass, so printing it under the opportunities heading
  // stated the pass and the failure in one line - the contradictory findings text
  // he found in Site Set-Up and Accidents.
  assert.match(SRC, /findLines\.push\('• ' \+ q\.check \+ \(it\.note \? ' - ' \+ it\.note : ''\) \+ suffix \+ ' \(' \+ STATUS_LETTER\[it\.st\] \+ '\)'\);/,
    'a finding is back to the criteria sentence, which reads as a pass, or lost its status letter');
  // 2026-09-15: the regulation is named once, in the conclusion. The box says so.
  assert.doesNotMatch(SRC, /AHS_LAW\.basisText\(q\.id, it\.st\)/, 'the regulation is back on the end of every line in the comments box');
  assert.match(SRC, /gen\.push\(\{ text: OPPORTUNITIES_NOTE, hl:false \}\);/, 'the box no longer points to the conclusion for the regulations');
  // 2026-09-15: the PDF finding cards carry no Requirement line either. The
  // regulations are named once, in the closing paragraph of the conclusion.
  assert.doesNotMatch(SRC, /'Requirement: '/, 'the PDF finding cards are citing a regulation against each item again');
  assert.doesNotMatch(SRC, /lawLines/, 'the requirement block is back on the finding cards');
  // 2026-09-15: the builder highlights nothing. Findings sit under their own
  // heading and end with their reference, so the amber only got in the way of
  // editing. Ours is stripped from any line carried over; the toolbar
  // highlight (the colour picker) is the user's and must survive.
  assert.doesNotMatch(SRC, /background-color:#FFE58A/, 'the builder is painting findings amber again');
  assert.match(SRC, /function _unhighlight\(html\)\{/, 'the amber is no longer stripped from lines carried over on rebuild');
  assert.match(SRC, /return _unhighlight\(c\.html\);/, 'a hand-edited line keeps the old amber on rebuild');
  assert.match(SRC, /hiliteColor/, "the toolbar highlight button is gone - that one is the user's own");
  assert.doesNotMatch(SRC, /class="cap-inc"|_syncInc|In report</, 'the include switch is back in the criteria modal');
  assert.match(SRC, /if\(it\.inc === false\) delete it\.inc;/, 'answering a removed item no longer brings it back into the report');
});

test('opening the app never writes the server copy over unsynced work on the device', () => {
  // 2026-09-14, first site visit: an inspection done offline, reopened when a
  // bar of signal came back, was REPLACED by the older server copy. pull()
  // hydrated on every fresh session (iOS kills the PWA constantly) and
  // applyState() wrote over localStorage regardless of what was there. Now a
  // persisted dirty sequence says whether the device holds work the server has
  // not seen; if it does, pull() pushes (device wins) and never hydrates.
  const pull = SRC.match(/async function pull\(\)\s*\{([\s\S]*?)\r?\n {4}\}/);
  assert.ok(pull, 'pull() not found');
  const dirtyAt = pull[1].indexOf('_isDirty()');
  const applyAt = pull[1].indexOf('applyState(');
  assert.ok(dirtyAt !== -1, 'pull() no longer checks for unsynced work - reopening online will wipe an offline inspection again');
  assert.ok(applyAt === -1 || dirtyAt < applyAt, 'pull() hydrates before checking for unsynced work');
  assert.match(pull[1], /_markClean\(r\.updatedAt\)/, 'a hydrate does not record the server version it took, so the next open re-hydrates');
  // only a REAL change marks the device dirty: the draft re-saves itself with a
  // fresh "t" on pagehide, and that must not look like work
  assert.match(SRC, /if\(_sameSynced\(prev, v\)\) return;/, 'an identical re-save marks the device dirty, so a clean device pushes instead of hydrating');
  assert.match(SRC, /_bumpDirty\(\); scheduleSave\(\);/, 'local changes no longer mark the device dirty');
  assert.match(SRC, /_markPushed\(seq, resp && resp\.updatedAt\);/, 'a successful push does not clear the dirty mark');
  assert.match(SRC, /visibilityState === 'visible' && _user && _isDirty\(\)\) push\(\)/, 'coming back to the app does not retry unsynced work');
});

test('a save can never capture a half-restored photo list', () => {
  // 2026-09-14: a 56-photo report came back from an export with 36, then 25,
  // then 10 photos. The draft restore ran on DOMContentLoaded AND on pageshow
  // (which fires right after load), each pass emptied allImages and rebuilt it
  // one store read at a time, and _restoredOnce only guarded the FIRST pass -
  // so a save landing mid-pass wrote the half-built list back as truth and the
  // rest of the photos dropped off the report. Three guards, each one enough
  // to reopen the hole if removed.
  const save = SRC.match(/function saveNow\(\)\s*\{\s*([\s\S]{0,300})/);
  assert.ok(save, 'saveNow() not found');
  assert.match(save[1], /if \(_restoring\) \{ _saveAfterRestore = true; return; \}/,
    'saveNow no longer stands down while a restore pass is rebuilding the page');
  assert.match(SRC, /_restoring\+\+;/, 'restoreIfPresent no longer counts itself in');
  assert.match(SRC, /allImages = built;/, 'the photo list is no longer built privately and swapped in whole');
  assert.ok(!/allImages = \[\];\s*let missing = 0;/.test(SRC), 'applyState empties allImages before rebuilding it again');
  const ps = SRC.match(/addEventListener\("pageshow", async \(e\) => \{([\s\S]{0,400}?)restoreIfPresent\(\)/);
  assert.ok(ps && /e\.persisted/.test(ps[1]), 'pageshow restores on every load again, not only on a BFCache return');
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

test('every finding cites a verified regulation from the register, never a free-typed one', () => {
  // 2026-09-14: Simon wants every check to state the law being measured
  // against, so a finding is no longer "just me saying it". The only source
  // of citations is LAW_REGISTER (each statutory entry read on
  // legislation.gov.uk). This pins: the register and the mapping resolve,
  // every contractor check is mapped, Action/Advisory cite and Observation
  // does not, the section anchor line reads correctly, and the PDF appendix exists.
  const s = SRC.indexOf('// ── AHS_LAW start ──'), e = SRC.indexOf('// ── AHS_LAW end ──');
  assert.ok(s > 0 && e > s, 'AHS_LAW block (with its start/end markers) not found');
  const L = new Function(SRC.slice(s, e) + '\nreturn { LAW_REGISTER, CRITERIA_LAW, SECTION_LAW, AHS_LAW };')();
  const ids = new Set(L.LAW_REGISTER.map(x => x.id));
  const bad = [];
  Object.keys(L.CRITERIA_LAW).forEach(pid => L.CRITERIA_LAW[pid].law.forEach(id => { if (!ids.has(id)) bad.push(pid + '->' + id); }));
  Object.keys(L.SECTION_LAW).forEach(k => L.SECTION_LAW[k].forEach(id => { if (!ids.has(id)) bad.push(k + '->' + id); }));
  assert.deepEqual(bad, [], 'a check or section cites an id that is not in the register');
  const noUrl = L.LAW_REGISTER.filter(x => x.kind === 'statutory' && !/^https:\/\/www\.legislation\.gov\.uk\//.test(x.url)).map(x => x.id);
  assert.deepEqual(noUrl, [], 'a statutory entry has no legislation.gov.uk reference');
  // every contractor check in SIMPLE_PHRASES is mapped
  const p0 = SRC.indexOf('const SIMPLE_PHRASES = [');
  let i = SRC.indexOf('[', p0), d = 0, p1 = -1;
  for (; i < SRC.length; i++) { const ch = SRC[i]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) { p1 = i; break; } } }
  const phrases = new Function('return ' + SRC.slice(SRC.indexOf('[', p0), p1 + 1) + ';')();
  const unmapped = phrases.filter(p => /^\((?:PC|C) - Section \d+\)/.test(p.label || '') && !L.CRITERIA_LAW[p.id]).map(p => p.id);
  assert.deepEqual(unmapped, [], 'checks with no legal basis (contractor and Principal Contractor sections)');
  assert.equal(L.AHS_LAW.anchorLine('PC16'), 'Assessed against CDM 2015 reg 13(4)(c); CDM 2015 Schedule 2.');
  assert.equal(L.AHS_LAW.basisText('s11_9', 'minor'), 'CDM 2015 reg 19(2)', 'temporary works must rest on the regulation, with BS 5975 as the standard behind it');
  assert.equal(L.AHS_LAW.holderPhrase('s17_5'), "the Principal Contractor's duty");
  // the HSE construction pages are the cornerstone: every check carries its section's page as supporting basis
  assert.ok(L.AHS_LAW.forItem('s7_1').law.some(x => x.id === 'g_hse_excavations' && /hse\.gov\.uk\/construction\//.test(x.url)), 'the HSE Excavations page is no longer behind the excavation checks');
  assert.ok(L.AHS_LAW.forItem('d7').law.some(x => x.id === 'g_hse_admin'), 'Documentation checks carry no HSE page');
  assert.equal(L.AHS_LAW.basisText('d7', 'minor'), 'CDM 2015 reg 12(1)', 'Documentation items are not mapped to the CPP duty');
  // 2026-09-15: the five "Assessed against" lines Simon rewrote in his review.
  // CDM 2015 reg 31(3), 15(9)(a), 15(9)(b) and MHSWR 1999 reg 11 were read on
  // legislation.gov.uk before being added to the register.
  assert.equal(L.AHS_LAW.anchorLine('PC3'), 'Assessed against CDM 2015 reg 15(7); MHSWR 1999 reg 3(1).', 'Documentation citations changed');
  assert.equal(L.AHS_LAW.anchorLine('C22'), 'Assessed against CDM 2015 regs 12(1), 12(4), 15(3)(b), 15(9)(a), 15(9)(b) and 30(1).', 'Construction Phase Plan citations changed');
  // 2026-09-22: reg 22(2) is excavations and is off housekeeping. What is left
  // here is only the fallback, used when a section holds no mapped checks.
  assert.equal(L.AHS_LAW.anchorLine('C26'), 'Assessed against CDM 2015 regs 17(1), 17(2), 18(1), 32(1) and 35(1); WAHR 2005 regs 4(1), 6(2) and 6(3).', 'Site Set-Up & Housekeeping fallback citations changed');
  assert.ok(!(L.SECTION_LAW.C26 || []).includes('cdm22_2'), 'reg 22(2), which is excavations, is back on housekeeping');
  ['C32', 'PC5', 'PC7'].forEach(k => assert.ok((L.SECTION_LAW[k] || []).includes('cdm22_2'), 'reg 22(2) has been lost from ' + k + ', where it belongs'));

  // THE RULE. A citation line names the regulations behind the checks actually
  // in this report, never a fixed list per section. Two reports went to a client
  // on 21 September citing reg 22(2) on sites with no excavation.
  assert.equal(L.AHS_LAW.anchorLine('C26', ['c26_1', 'c26_2', 'c26_3', 'c26_4', 'c26_5']),
    'Assessed against CDM 2015 regs 17(1), 17(2), 17(4), 18(1) and 35(1); HSWA 1974 s.2(2)(d).',
    'the housekeeping anchor is not being built from the checks in the section');
  assert.equal(L.AHS_LAW.anchorLine('C34', ['c34_1']), 'Assessed against COSHH 2002 regs 6(1) and 12(1).',
    'the COSHH assessment check lost reg 6(1) or reg 12(1)');
  assert.equal(L.AHS_LAW.anchorLine('C31', ['c31_3']), 'Assessed against WAHR 2005 regs 6(3), 10(1) and 11.',
    'falling objects (reg 10) and danger areas (reg 11) are not behind the edge protection check');
  assert.match(L.AHS_LAW.anchorLine('C29', ['c29_1', 'c29_2', 'c29_3']), /PUWER 1998 regs 4\(1\), 5\(1\) and 6\(2\); LOLER 1998 regs 8\(1\) and 9\(3\)/,
    'the plant section no longer reaches PUWER inspection or LOLER');

  // A section the inspector wrote himself is never left with no regulations.
  assert.equal(L.AHS_LAW.anchorLine('cust-anything', ['his1', 'his2']),
    'Assessed against HSWA 1974 s.2(1) and s.3(1); MHSWR 1999 reg 3(1).',
    'a section of his own making prints findings with no regulations at all');

  // A citation line carries regulations. Guidance never appears in one; the
  // contractual entries a Principal Contractor section rests on still do.
  const guidanceIds = L.LAW_REGISTER.filter(x => x.kind === 'guidance').map(x => x.id);
  Object.keys(L.SECTION_LAW).forEach(k => {
    const pids = Object.keys(L.CRITERIA_LAW).filter(p => L.AHS_LAW.sectionOf(p) === k);
    const ids = L.AHS_LAW.anchorIds(k, pids);
    const leaked = ids.filter(id => guidanceIds.includes(id));
    assert.deepEqual(leaked, [], 'HSE guidance is being cited in the ' + k + ' assessed-against line');
  });
  assert.match(L.AHS_LAW.anchorLine('C41', ['c41_1']), /the Construction Phase Plan for the project\.$/,
    'the Principal Contractor sections lost the contractual entry they rest on');
  assert.doesNotMatch(SRC, /The standard applied is HSE's construction guidance on/,
    'the measured-against line is naming HSE guidance again');

  // the two regulations added for this, read on legislation.gov.uk first
  assert.equal(L.AHS_LAW.get('wahr11').cite, 'WAHR 2005 reg 11');
  assert.match(L.AHS_LAW.get('wahr11').requirement, /preventing unauthorised persons from entering/, 'reg 11 is not the danger-areas duty');
  assert.equal(L.AHS_LAW.get('coshh12_1').cite, 'COSHH 2002 reg 12(1)');
  assert.match(L.AHS_LAW.get('coshh12_1').requirement, /information, instruction and training/, 'COSHH reg 12(1) is not the training duty');
  assert.equal(L.AHS_LAW.anchorLine('C38'), 'Assessed against RIDDOR 2013 regs 4, 7 and 12; MHSWR 1999 regs 5(1) and 11.', 'Accidents citations changed');
  assert.equal(L.AHS_LAW.anchorLine('C40'), 'Assessed against CDM 2015 regs 15(10), 17(1), 27(3)(d), 27(4), 30(1) and 31(3); MHOR 1992 reg 4(1)(a).', 'Access & Egress citations changed');
  assert.equal(L.AHS_LAW.get('cdm31_3').cite, 'CDM 2015 reg 31(3)');
  assert.equal(L.AHS_LAW.get('mhswr11').cite, 'MHSWR 1999 reg 11');
  assert.match(L.AHS_LAW.get('cdm15_9a').requirement, /suitable site induction/, 'reg 15(9)(a) is not the induction duty');
  assert.match(L.AHS_LAW.get('cdm15_9b').requirement, /serious and imminent danger/, 'reg 15(9)(b) is not the emergency-procedures duty');
  // the closing paragraph of the conclusion is built from the same section list
  // as the "Assessed against" lines, so the two can never disagree
  assert.match(SRC, /function summaryForSections\(keys\)\{/, 'the conclusion no longer names the regulations the sections were assessed against');
  assert.match(SRC, /var legal = \(hasLaw && cited\.length\) \? AHS_LAW\.summaryForChecks\(cited\) : null;/,
    'the measured-against list is no longer built from the checks that carry an Action or an Advisory');
  assert.match(SRC, /AHS_LAW\.anchorLine\(t\.key, rows\.map\(function\(r\)\{ return r\.capPid; \}\)\)/,
    'the section anchor is back to a fixed list per section');
  const docsInBuilder = phrases.filter(p => /^d\d+$/.test(p.id) && !/^\(PC - Section 3\) /.test(p.label || '')).map(p => p.id);
  assert.deepEqual(docsInBuilder, [], 'Documentation items have lost the section label that puts them in the criteria builder');
  assert.equal(L.AHS_LAW.basisText('c24_3', 'minor'), 'CDM 2015 reg 15(8)');
  assert.equal(L.AHS_LAW.basisText('c24_3', 'advisory'), 'CDM 2015 reg 15(8)');
  assert.equal(L.AHS_LAW.basisText('c24_3', 'observation'), '', 'an observation must not cite');
  assert.equal(L.AHS_LAW.basisText('c24_3', 'compliant'), '');
  assert.match(L.AHS_LAW.basisText('c41_1', 'minor'), /Construction Phase Plan.*CDM 2015 reg 15\(3\)\(b\)/, 'a CPP-based check must name the regulation that makes the CPP binding');
  assert.equal(L.AHS_LAW.anchorLine('C24'), 'Assessed against CDM 2015 regs 15(7) and 15(8); MHSWR 1999 reg 13(2).');
  assert.equal(L.AHS_LAW.holderPhrase('c22_4'), "the Principal Contractor's duty");
  assert.match(SRC, /if\(anchor\) gen\.push\(\{ text: anchor, hl:false \}\);/, 'the section anchor line is no longer written');
  assert.doesNotMatch(SRC, /doc\.text\('Legal basis of findings'/, 'the regulation appendix is back in the PDF (Simon: it makes the report massive)');
  assert.doesNotMatch(SRC, /doc\.text\('KEY FINDINGS'/, 'Key Findings is back on the PDF executive summary (Simon asked for it removed)');
  assert.match(SRC, /legal: legal,/, 'the composer model no longer carries the one-paragraph legal basis');
  const lg = L.AHS_LAW.summaryFor(['s7_1', 's17_5', 'c41_1']);
  assert.equal(lg.statutory, 'CDM 2015 regs 22(1) and 28(2)');
  assert.match(lg.hse, /excavations/);
  assert.match(lg.contractual, /Construction Phase Plan \(CDM 2015 reg 15\(3\)\(b\)\)/);
  assert.match(SRC, /class="cap-law"/, 'the criteria modal no longer shows the basis under each check');
});

test('the report is square and flat, and a section never leaves its heading behind', () => {
  // Simon's house style, the same pass Compass had: square edges, flat fills,
  // ruled, uppercase labels. No rounded rectangles and no rounded stroke caps -
  // a rounded cap softens the end of every rule it touches.
  assert.doesNotMatch(SRC, /roundedRect/, 'a rounded rectangle is back in the report');
  // The dials are the one curve in the report - Simon asked for them back.
  // Their round cap must be returned to square straight after, or every rule
  // that follows ends soft.
  const dial = SRC.match(/function drawTachographDial\(([\s\S]*?)\n\}/);
  assert.ok(dial, 'the tachograph dials are gone - they were liked');
  // 2026-09-15: the dials got the square treatment too - a square plate, a
  // scale of straight ticks and a needle. Nothing in the report is curved now,
  // so there is no round stroke cap left anywhere in it.
  assert.equal((SRC.match(/setLineCap\('round'\)/g) || []).length, 0, 'a round stroke cap is back in the report');
  assert.match(dial[1], /doc\.rect\(px, py, pw, ph\)/, 'the speedo lost its square plate');
  assert.match(dial[1], /const TICKS = 25;/, 'the speedo scale of straight ticks is gone');
  assert.match(dial[1], /the needle and its square hub/, 'the speedo lost its needle');
  // the criteria tiles are square and flat
  assert.match(SRC, /doc\.rect\(xPos, yPos, badgeWidth, badgeHeight, 'F'\)/, 'the criteria tiles are no longer square and flat');

  // and a criterion does not take a page each, nor strand its heading
  assert.match(SRC, /const needed = Math\.min\(150, 16 \+ narrativeH \+ 34\);/,
    'the space a section needs is no longer measured - a heading can be stranded at the foot of a page');
  assert.match(SRC, /if \(!findingsPageOpen \|\| \(265 - y\) < needed\)/, 'sections are back to one page each');
  assert.match(SRC, /'Findings \(continued\)' : 'Findings'/, 'the carry-on pages lost their heading');
});

test('the report carries the date on its front page, not the day it was reprinted', () => {
  // 2026-09-22: a report regenerated a week later was stamping the day it was
  // reprinted into every page footer.
  assert.match(SRC, /const dateStr = _reportDateStr\(\);/, 'the footer is back to stamping today');
  const f = SRC.match(/function _reportDateStr\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(f, '_reportDateStr() not found');
  assert.match(f[1], /getElementById\('fp-report-date'\)/, 'the footer date no longer reads the front page');
  assert.match(f[1], /new Date\(\)\.toLocaleDateString\('en-GB'\)/, 'there is no fallback for a report with no date set');
});

test('an introduction goes into Purpose and Rationale once', () => {
  // 2026-09-22: the box read the same opening paragraph twice, run together
  // with no break, because inserting an introduction added a second copy.
  assert.match(SRC, /if \(\/Introduction\/i\.test\(String\(sn\.title \|\| ''\)\)\) _stripIntro\(window\.snippetTargetEl\);/,
    'an introduction no longer replaces one already in the box');
  const f = SRC.match(/function _stripIntro\(target\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(f, '_stripIntro() not found');
  assert.match(f[1], /nodeValue = ''/, '_stripIntro no longer clears the text it matched');
});

test('the alert bar never traps you inside a full-screen panel', () => {
  // 2026-09-15: an amber photo note left Simon stuck in the criteria modal.
  // The bar is fixed at the top on the maximum z-index - which it must be, it
  // is what tells him a save has failed - so it covered the modal's own header
  // and its Back button. The panels now start below it, and an amber note
  // (nothing lost) can be dismissed. A save failure must never be dismissible.
  assert.match(SRC, /'z-index:2147483647'/, 'the alert bar no longer sits above everything - a failed save could be hidden');
  assert.match(SRC, /#capOverlay\{position:fixed;inset:0;top:var\(--ahs-alert-h,0px\)/,
    'the criteria modal is back under the alert bar - its Back button would be unreachable');
  assert.match(SRC, /#psOverlay\{position:fixed;inset:0;top:var\(--ahs-alert-h,0px\)/,
    'the photo panel is back under the alert bar');
  assert.match(SRC, /function publishHeight\(px\)/, 'the bar no longer publishes its height, so the panels cannot clear it');
  assert.match(SRC, /publishHeight\(b\.offsetHeight\);/, 'the published height is never set from the bar itself');
  assert.match(SRC, /publishHeight\(0\);/, 'the offset is never released when the bar goes');
  // the dismiss belongs to notes only
  const paint = SRC.match(/function repaint\(\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(paint, 'repaint() not found');
  assert.match(paint[1], /if \(!isSave\) \{[\s\S]{0,600}Dismiss this message/,
    'the dismiss is no longer limited to amber notes - a save failure could be cleared without saving');
});

test('one inspection can carry sections from both lists, PC and contractor', () => {
  // 2026-09-15: 'the inspection criteria doesnt let me add criteria for the PC
  // and the C ... i need to report on the poor PC controls'. The PC/Contractor
  // buttons were filtering the REPORT as well as the list, so PC checks
  // answered during a contractor visit never reached it. build() must consider
  // every section; only the tile list is filtered by the button.
  const fn = SRC.match(/async function build\(opts\)\s*\{([\s\S]{0,600})/);
  assert.ok(fn, 'build() not found');
  assert.match(fn[1], /var ts = topics\(\);/, 'build() is filtering sections by the list on screen again - the other list would vanish from the report');
  assert.doesNotMatch(fn[1], /t\.mode === S\.mode/, 'build() is back to writing only the current mode');
  // the home screen still filters the tiles, and says what is in the report from the other list
  const home = SRC.match(/function renderHome\(\)\s*\{([\s\S]{0,1200})/);
  assert.ok(home, 'renderHome() not found');
  assert.match(home[1], /var ts = topics\(\)\.filter\(function\(t\)\{ return t\.mode === S\.mode \|\| t\.custom; \}\);/,
    'the tile list no longer filters by the chosen list');
  assert.match(home[1], /var total = 0; topics\(\)\.forEach/, 'the answered count no longer covers both lists');
  assert.match(SRC, /Also in this report from the/, 'the home screen no longer shows what the other list has contributed');
  assert.match(SRC, /data-cross=/, 'there is no way across to a section answered in the other list');
});

test('accidents and incidents is a criteria section on both visit types', () => {
  // 2026-09-15: Simon asked for a simple accidents and incidents section on the
  // PC and the contractor visit. A section needs BOTH halves to surface as a
  // tile: the checks, labelled with its section number, and the section
  // template in SIMPLE_SNIPPETS that gives it its title. Lose either half and
  // the tile vanishes without a word.
  function literal(name) {
    const p0 = SRC.indexOf('const ' + name + ' = [');
    assert.ok(p0 > 0, name + ' not found');
    let i = SRC.indexOf('[', p0), d = 0, p1 = -1;
    for (; i < SRC.length; i++) { const ch = SRC[i]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) { p1 = i; break; } } }
    return new Function('return ' + SRC.slice(SRC.indexOf('[', p0), p1 + 1) + ';')();
  }
  const phrases = literal('SIMPLE_PHRASES');
  const snippets = literal('SIMPLE_SNIPPETS');
  for (const [mode, num] of [['PC', 19], ['C', 38]]) {
    const label = new RegExp('^\\(' + mode + ' - Section ' + num + '\\)');
    const checks = phrases.filter(p => label.test(p.label || ''));
    assert.equal(checks.length, 5, mode + ' accidents section should have 5 checks, found ' + checks.length);
    assert.ok(checks.every(c => (c.text || '').length > 40), mode + ' accidents checks must each carry a full report sentence');
    const tmpl = snippets.find(s => new RegExp('^\\s*' + mode + '\\s*-\\s*Section\\s*' + num + '\\b').test(s.title || ''));
    assert.ok(tmpl, mode + ' Section ' + num + ' template is gone - the tile would lose its title and never appear');
    assert.match(tmpl.title, /Accidents/i, mode + ' Section ' + num + ' is no longer the accidents section');
  }
  // and the builder gives both the same three-letter code
  assert.match(SRC, /'accidents incidents & near misses':'INC'/, 'the accidents sections lost their INC code');
});

test('the report is structured: scene setting, then an outcome organised under the criteria', () => {
  // Simon's spec, 15 September. The first summary sets the scene and carries no
  // findings; the second is the Inspection Outcome / Conclusion, organised under
  // each criterion as What went well / What needs attention, with the regulation
  // against the matters needing attention only, and a three-part caveat. The
  // block is run exactly as it is embedded in the page.
  const s = SRC.indexOf('// ── AHS_COMPOSE start ──'), e = SRC.indexOf('// ── AHS_COMPOSE end ──');
  assert.ok(s > 0 && e > s, 'AHS_COMPOSE block (with its start/end markers) not found');
  const C = new Function(SRC.slice(s, e) + '\nreturn AHS_COMPOSE;')();
  const criteria = [
    'Task-specific RAMS were in place for the activities being undertaken.',
    'Adequate supervision was provided to manage the work activities safely.',
    C.OBSERVED, C.OPPORTUNITIES,
  ];
  const model = {
    client: 'Department for Health', pc: 'Henry Boot Construction Ltd', contract: 'G & H Ltd', contractor: 'Morley Ventilation Ltd',
    contact: 'Mark (Site Supervisor)', inspector: 'Simon Archer',
    visit: { works_phase: 'Installing ductwork', operatives_on_site: 3 },
    legal: { statutory: 'CDM 2015 regs 13(1) and 15(8)', hse: 'site rules and induction', contractual: '' },
    scope: { instruments: 'the Construction (Design and Management) Regulations 2015', statutory: 'CDM 2015 reg 13(1)', hse: 'site rules and induction' },
    criteria,
    sections: [
      { name: 'CDM Roles, Cooperation & Communication',
        lines: [C.OBSERVED, C.OPPORTUNITIES, 'Actions to be addressed,',
          '• The Principal Contractor can improve by engaging in regular communication with their appointed contractors -',
          'PC is not participating in the regular safety meeting.'],
        rows: [{ item: 'Understanding of CDM duties', status: 'minor', note: 'No safety meetings taking place on a regular basis',
                 basis: 'CDM 2015 reg 13(1)', holder: "the Principal Contractor's duty" }] },
      { name: 'Risk Assessments & Method Statements',
        lines: ['• Task-specific RAMS were in place for the activities being undertaken. (see images)',
          '• Adequate supervision was provided to manage the work activities safely the operative I spoke to knew the RAMS well',
          '• Through the you see we say scheme have so far this month raised …....'],
        rows: [{ item: 'RAMS in place', status: 'compliant', note: 'T Clarke approve the RAMS', text: criteria[0] },
               { item: 'Supervision', status: 'compliant', note: '', text: criteria[1] }] },
    ],
  };
  const site = C.build(model, 'site').join('\n'), closing = C.build(model, 'closing').join('\n');

  // ── the scene setting sets the scene and nothing else ──
  assert.doesNotMatch(site + closing, /\[INSERT/i, 'a cue was written instead of leaving the unknown out');
  assert.doesNotMatch(site, /…/, 'an unfilled placeholder line reached the summary');
  assert.match(site, /## Inspection criteria covered\n• CDM Roles, Cooperation & Communication/, 'the scene setting no longer lists the criteria covered');
  assert.match(site, /assessed against the Construction \(Design and Management\) Regulations 2015/, 'the scene setting no longer names the law the criteria are assessed against');
  assert.doesNotMatch(site, /No safety meetings|What needs attention|corrective action/, 'the scene setting contains findings or actions, which belong in the conclusion');

  // ── the conclusion is organised under the criteria ──
  assert.match(closing, /## CDM Roles, Cooperation & Communication\n### What needs attention/, 'the conclusion is not organised under the criteria');
  assert.match(closing, /## Risk Assessments & Method Statements\n### What went well/, 'What went well is missing under a criterion with compliant items');
  // 2026-09-15: the section comments box is the report text. Where the inspector
  // has written his own account of a section there, the conclusion carries that
  // account and lists the items by name. The raw note captured on the row is not
  // repeated underneath it - that was the same finding stated twice.
  assert.match(closing, /### What needs attention\n• Understanding of CDM duties\n/,
    'an item is not listed by name where the box carries the inspector own account');
  assert.doesNotMatch(closing, /No safety meetings taking place on a regular basis/,
    'the raw note on the row is repeated under the account written in the box');
  // 2026-09-15: the regulations are named once, in the closing paragraph. Nothing
  // is cited against an item, and A1/AD1/O1 are working marks for the app only.
  assert.doesNotMatch(closing, /\(CDM 2015 reg[^)]*duty\)/, 'a regulation is being printed against an individual matter again');
  assert.doesNotMatch(closing, /• A\d+\.|• AD\d+\.|• O\d+\./, 'the status references are back in the conclusion');
  assert.match(closing, /• The Principal Contractor can improve by engaging in regular communication[^\n]*PC is not participating/,
    "the inspector's own action line is not carried into What needs attention");
  assert.match(closing, /• RAMS in place - T Clarke approve the RAMS\./, 'a compliant item lost the evidence, or its capitals were mangled');
  assert.match(closing, /• Supervision - The operative the inspector spoke to knew the RAMS well/, 'words typed onto a criteria line were lost, or left in the first person');

  assert.match(closing, /CDM 2015 regulation 13\(1\) places with Henry Boot Construction Ltd/, 'a PC-level matter is no longer escalated to the Principal Contractor');
  assert.match(closing, /The matters needing attention above are measured against CDM 2015 regs 13\(1\) and 15\(8\)\./, 'the conclusion no longer summarises the legal basis in a paragraph');

  // ── the caveat: a snapshot, a proportionate timescale, and the duty that remains ──
  assert.match(closing, /reflect the conditions observed and the discussions held on the date of the inspection only\./, 'the caveat lost the inspection-date sentence');
  assert.match(closing, /within a reasonable and proportionate timescale, taking account of the nature and risk associated with the finding\./, 'the caveat lost the proportionate-timescale sentence');
  assert.match(closing, /does not remove the responsibility of the duty holder to manage health and safety on a continuing basis\./, 'the caveat lost the continuing-duty sentence');

  // ── the app renders the structure the same way the composer wrote it ──
  assert.match(SRC, /function buildLocalSummary\(kind\)\{[\s\S]{0,600}AHS_COMPOSE\.build\(/, 'buildLocalSummary no longer composes through AHS_COMPOSE');
  assert.match(SRC, /target\.innerHTML = _composedHtml\(parts\);/, 'the composed text is no longer rendered through _composedHtml');
  assert.match(SRC, /'<strong>' \+ esc\(m\[1\]\) \+ '<\/strong>'/, 'heading markers no longer become bold in the box and the PDF');
  assert.match(SRC, /gen\.push\(\{ text: OPPORTUNITIES_HEADING, hl:false, head:true \}\);/, 'the comments box no longer separates observations from opportunities');
  assert.match(SRC, /g\.html = g\.head \? '<strong>' \+ _esc\(g\.text\) \+ '<\/strong>'/, 'the comments-box headings are no longer bold');
});

// ────────────────────────────────────────────────────────────────
//  Temporary Works - a tile on each list, in Simon's own words
// ────────────────────────────────────────────────────────────────

// The 25 checks exactly as Simon wrote them in his brief of 5 October 2026,
// each with the source he gave for it: [wording, source]. The wording is his.
// Do not tidy it here to make a test pass - change it only when he does.
const TW = {
  pc: [
    ["PC's Designated Individual named and the temporary works procedure in place.",
     "CITB simplified TW process flowchart v02.00; CITB TWC lesson plan 5.3"],
    ["TWC appointment letter issued and accepted; TWC named in the construction phase plan; deputy appointed.",
     "CITB flowchart v02.00; TWf Information Sheet 3, 3.1.2; CITB TWCTC scheme of work 5.6"],
    ["TWS appointment letters where TWSs are used, each showing which TWC they answer to (a TWS is optional; with none, the TWC covers the duties).",
     "CITB flowchart v02.00; CITB TWCTC scheme of work 5.7, 5.8"],
    ["Organogram shows every DI, TWC and TWS and who answers to whom.",
     "CITB TWCTC scheme of work 5.2"],
    ["Any subcontractor managing its own TW has the PC's DI's agreement, its own TWC appointed by its own DI, and a communication protocol in the implementation plan. The PC's TWC keeps overall responsibility.",
     "CITB TWCTC scheme of work 5.9; CITB TWC lesson plan 4.4; IOSH BS 5975:2019 update slides"],
    ["Temporary works register current, with every item seen on site, its implementation risk class and its design check category.",
     "CITB completed example TW register v02.00; CITB TWC lesson plan 6.1"],
    ["Design brief issued for each item and signed off by the originator, TWC and PC's TWC.",
     "CITB completed example TW design brief v02.00"],
    ["Design certificate and design check certificate for each design, at the right independence for its category (categories 2 and 3 need check calculations; category 3 is checked by another organisation).",
     "CITB completed example design and check certificate v02.00; CITB TWC lesson plan 6.4"],
    ["Standard solutions have a recorded application check; any change from the supplier's tables has been peer reviewed.",
     "CITB TWC lesson plan 6.5, 6.6"],
    ["Implementation plan, RAMS and ITP with hold points, reviewed and accepted before installation; approved by the PC's TWC if written by others.",
     "CITB TWC lesson plan 7.2, 10.1; CITB completed example TW register v02.00"],
    ["The implementation plan says who may issue permits and for what scope; permits to load and unload are issued by the PC's TWC or someone authorised.",
     "CITB TWC lesson plan 10.3"],
    ["Inspection regime set for each item and records up to date, including statutory inspections.",
     "CITB completed example TW register v02.00; CITB flowchart v02.00"],
    ["Changes recorded in writing against the original brief and approved by the designer before any alteration.",
     "CITB TWC lesson plan 10.2; IOSH BS 5975:2019 update slides"],
    ["TWC has the authority to stop the work.",
     "HSE Management of Temporary Works presentation; IOSH BS 5975:2019 update slides"],
    ["TW information for the Health and Safety File identified, such as items left in place.",
     "CITB completed example TW design brief v02.00; TWf Information Sheet 3, 3.3"],
  ],
  c: [
    ["The contractor's temporary works are on the PC's register.",
     "CITB TWC lesson plan 6.1; CITB completed example TW register v02.00"],
    ["If the contractor manages its own TW: the PC's DI has agreed, and the contractor's TWC is appointed by its own DI and works within the PC's TWC's system.",
     "CITB TWCTC scheme of work 5.9; CITB TWC lesson plan 4.4"],
    ["The supervisor on site knows who their TWC is.",
     "CITB TWCTC scheme of work 5.7, 5.8"],
    ["Built as designed: checked against the drawing on site, using the designer's quality-control checklist where there is one.",
     "CITB TWC lesson plan 7.3"],
    ["Proprietary or standard kit: supplier's information in hand and an application check recorded for this location.",
     "CITB TWC lesson plan 6.5; HSE Management of Temporary Works presentation"],
    ["RAMS for the temporary works reviewed and accepted by the PC before installation.",
     "CITB completed example TW register v02.00"],
    ["Permit to load held by the supervisor directly responsible before any loading, with the load case and controls matching what is happening.",
     "CITB completed example TW permit to load v02.00"],
    ["No unauthorised changes, such as props or ties removed for access; any change has gone through the TWC to the designer and been approved first.",
     "CITB TWC lesson plan 10.2"],
    ["Inspections carried out and recorded to the regime on the register, including statutory inspections.",
     "CITB completed example TW register v02.00; CITB flowchart v02.00"],
    ["Striking or dismantling only under a permit to unload, with the sequence referenced and the permanent works confirmed self-supporting.",
     "CITB completed example TW permit to unload v02.00; CITB TWC lesson plan 10.3, 10.5"],
  ],
};
const TW_LISTS = [['PC', 43, 's43_', TW.pc], ['C', 44, 'c44_', TW.c]];

function listLiteral(name) {
  const p0 = SRC.indexOf('const ' + name + ' = [');
  assert.ok(p0 > 0, name + ' not found');
  let i = SRC.indexOf('[', p0), d = 0, p1 = -1;
  for (; i < SRC.length; i++) { const ch = SRC[i]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) { p1 = i; break; } } }
  return new Function('return ' + SRC.slice(SRC.indexOf('[', p0), p1 + 1) + ';')();
}

test('temporary works is a tile on both lists, in the words Simon wrote, each with its source', () => {
  // A tile needs both halves: the checks, labelled with the section number, and
  // the section title in SIMPLE_SNIPPETS. The name on the checklist is the
  // wording without its final full stop, as every other check name is, so a
  // finding reads "<wording> - <note> (A)"; the report sentence is the wording whole.
  const phrases = listLiteral('SIMPLE_PHRASES'), snippets = listLiteral('SIMPLE_SNIPPETS');
  const byId = Object.fromEntries(phrases.map(p => [p.id, p]));
  for (const [mode, num, prefix, list] of TW_LISTS) {
    const head = '(' + mode + ' - Section ' + num + ') ';
    const checks = phrases.filter(p => (p.label || '').startsWith(head));
    assert.equal(checks.length, list.length, mode + ' temporary works should have ' + list.length + ' checks, found ' + checks.length + ' - nothing is to be added to or dropped from his list');
    list.forEach(([wording, source], i) => {
      const p = byId[prefix + (i + 1)];
      assert.ok(p, prefix + (i + 1) + ' is missing');
      assert.equal(p.text, wording, prefix + (i + 1) + ': the wording is no longer what Simon wrote');
      assert.equal(p.label, head + wording.replace(/\.$/, ''), prefix + (i + 1) + ': the name on the checklist has drifted from the wording');
      assert.equal(p.src, source, prefix + (i + 1) + ': the source is no longer what Simon gave');
    });
    const tmpl = snippets.find(s => new RegExp('^\\s*' + mode + '\\s*-\\s*Section\\s*' + num + '\\b').test(s.title || ''));
    assert.ok(tmpl, mode + ' Section ' + num + ' template is gone - the tile would never appear');
    assert.match(tmpl.title, /- Temporary Works$/, mode + ' Section ' + num + ' is no longer the temporary works section');
  }
  assert.match(SRC, /'temporary works':'TWK'/, 'the temporary works tiles lost their TWK code');
  // The source is shown under the check on the criteria screen...
  assert.match(SRC, /check: m\[3\], text: p\.text \|\| '', src: p\.src \|\| ''/, 'the bank no longer carries a check\'s source through to the criteria screen');
  assert.match(SRC, /\(q\.src \? '<div class="cap-law">Source: ' \+ esc\(q\.src\) \+ '<\/div>' : ''\)/, 'the source is no longer shown under the check');
  // ...and nowhere else. The report cites regulations, never course material.
  const b0 = SRC.indexOf('async function build(opts){'), b1 = SRC.indexOf('// ── Wire up ──', b0);
  assert.ok(b0 > 0 && b1 > b0, 'build() not found');
  assert.doesNotMatch(SRC.slice(b0, b1), /\.src\b/, 'build() is writing a check\'s source into the report');
  // Simon kept the temporary works checks that were already there: saved inspections use them.
  ['s11_9', 's11_10', 's11_11', 's11_12', 's11_13', 's11_14', 's11_15', 's11_16', 'c32_5'].forEach(id =>
    assert.ok(byId[id], 'the existing temporary works check ' + id + ' has gone - saved inspections refer to it'));
});

test('temporary works rests on regulations already in the register, never on the course material', () => {
  // The sources are CITB, TWf, IOSH and HSE training material: not law. Simon
  // approved the basis on 5 October 2026: CDM 2015 reg 13(1) and reg 19 for the
  // Principal Contractor's list, regs 15(2), 15(3) and 19 for the contractor's,
  // with BS 5975 behind both as the standard. Reg 12(7) was read on
  // legislation.gov.uk that day before it was added for the Health and Safety File check.
  const s = SRC.indexOf('// ── AHS_LAW start ──'), e = SRC.indexOf('// ── AHS_LAW end ──');
  const L = new Function(SRC.slice(s, e) + '\nreturn { CRITERIA_LAW, SECTION_HSE, AHS_LAW };')();
  const approved = {
    PC: ['cdm13_1', 'cdm19_1', 'cdm19_2', 'cdm19_3', 'cdm12_7', 'g_bs5975'],
    C: ['cdm15_2', 'cdm15_3a', 'cdm15_3b', 'cdm19_1', 'cdm19_2', 'cdm19_3', 'g_bs5975'],
  };
  const holder = { PC: 'Principal Contractor', C: 'Contractor' };
  const pids = {};
  for (const [mode, , prefix, list] of TW_LISTS) {
    pids[mode] = list.map((_, i) => prefix + (i + 1));
    pids[mode].forEach(pid => {
      const m = L.CRITERIA_LAW[pid];
      assert.ok(m, pid + ' has no legal basis');
      assert.equal(m.holder, holder[mode], pid + ' names the wrong duty holder');
      m.law.forEach(id => assert.ok(approved[mode].includes(id), pid + ' cites ' + id + ', which is not in the basis Simon approved'));
      assert.equal(L.AHS_LAW.get(m.law[0]).kind, 'statutory', pid + ' must rest on a regulation first, with the standard behind it');
    });
  }
  assert.equal(L.AHS_LAW.anchorLine('PC43', pids.PC), 'Assessed against CDM 2015 regs 12(7), 13(1), 19(2) and 19(3).');
  assert.equal(L.AHS_LAW.anchorLine('C44', pids.C), 'Assessed against CDM 2015 regs 15(2), 15(3)(a), 15(3)(b), 19(1), 19(2) and 19(3).');
  assert.equal(L.AHS_LAW.get('cdm12_7').cite, 'CDM 2015 reg 12(7)');
  assert.match(L.AHS_LAW.get('cdm12_7').requirement, /relevant to the health and safety file/, 'reg 12(7) is not the file-information duty');
  assert.deepEqual([L.SECTION_HSE.PC43, L.SECTION_HSE.C44], [['g_hse_tw'], ['g_hse_tw']], 'HSE\'s temporary works page is no longer behind the temporary works sections');
});

test('a finding with no note is not read back as the inspector\'s own words', () => {
  // Found on 5 October 2026 while proving the temporary works tiles, and already
  // live: a finding marked without a note is written into the comments box as
  // the check's name and its letter. The composer took that line for something
  // the inspector had typed, printed "The inspector also noted: Permits to load
  // and strike." and, because the box now seemed to speak for the section,
  // dropped the notes on the section's other findings from the conclusion.
  const s = SRC.indexOf('// ── AHS_COMPOSE start ──'), e = SRC.indexOf('// ── AHS_COMPOSE end ──');
  const C = new Function(SRC.slice(s, e) + '\nreturn AHS_COMPOSE;')();
  const stop = 'TWC has the authority to stop the work.';
  const model = lines => ({
    client: 'Department for Health', pc: 'Henry Boot Construction Ltd', contract: '', contractor: '',
    contact: 'Mark (Site Manager)', inspector: 'Simon Archer', visit: {},
    legal: { statutory: 'CDM 2015 regs 19(2) and 19(3)', hse: '', contractual: '' },
    scope: { instruments: 'the Construction (Design and Management) Regulations 2015', statutory: 'CDM 2015 reg 19(2)', hse: '' },
    criteria: [C.OBSERVED, C.OPPORTUNITIES, stop],
    sections: [{ name: 'Scaffolds and Temporary works', lines,
      rows: [{ item: 'Temporary works coordination', status: 'minor', note: 'No TWC appointed in writing' },
             { item: 'Permits to load and strike', status: 'minor', note: '' },
             { item: stop.replace(/\.$/, ''), status: 'observation', note: '', text: stop }] }],
  });
  const built = [C.OPPORTUNITIES, '• Temporary works coordination - No TWC appointed in writing (A)',
    '• Permits to load and strike (A)', '• ' + stop.replace(/\.$/, '') + ' (O)'];
  const closing = C.build(model(built), 'closing').join('\n');
  assert.doesNotMatch(closing, /also noted/i, 'a finding line the builder wrote has come back as the inspector\'s own words');
  assert.match(closing, /• Temporary works coordination - No TWC appointed in writing\./, 'the note on another finding in the section dropped out of the conclusion');
  assert.match(closing, /• Permits to load and strike - corrective action required\./, 'a finding with no note lost its line');
  // what he does type into the box is still his
  const own = C.build(model(built.concat(['The hoarding on the east boundary had been moved without the coordinator being told.'])), 'closing').join('\n');
  assert.match(own, /The hoarding on the east boundary had been moved without the coordinator being told\./, 'the inspector\'s own line was swallowed');
});

test('temporary works stays out of the report until a check is marked, then survives a reload', { skip: !CHROME && 'Chrome not found' }, async () => {
  // Simon's brief: hidden until needed. Opening the tile and marking nothing
  // must leave no trace in the report or the saved inspection; a mark, a note
  // and the report section they build must all come back after a reload.
  const { browser, page, errs } = await boot();
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const snapshot = () => page.evaluate(() => ({
    saved: Object.keys(localStorage).filter(k => k.indexOf('AHS_REPORT_DRAFT_V1:') === 0).map(k => localStorage.getItem(k)).join(''),
    sections: Array.from(document.querySelectorAll('#secs .insp-section')).map(sec => ({
      name: sec.querySelector('.field .rte').innerText.trim(),
      rows: Array.from(sec.querySelectorAll('.items-list .item-row')).map(r => {
        const t = r.querySelectorAll(".rte[contenteditable='true']");
        return [t[0].innerText.trim(), r.querySelector('select.status-select').value, t[1].innerText.trim()];
      }),
    })),
  }));
  // The criteria screen reopens where it was left, so go back to the tiles
  // first. The mode buttons are looked up inside the overlay: the page has
  // another, hidden, set with the same data-mode.
  const openTile = async () => {
    await page.evaluate(() => {
      document.getElementById('capOpen').click();
      const back = document.getElementById('capBack');
      if (back.style.display !== 'none') back.click();
    });
    await page.click('#capOverlay .cap-mode button[data-mode="PC"]');
    await page.click('#capOverlay .cap-tile[data-key="PC43"]');
  };
  const close = async () => { await page.evaluate(() => document.getElementById('capHide').click()); await pause(1500); };

  let shown, untouched, marked, reloaded, back;
  try {
    await openTile();
    shown = await page.evaluate(() => Array.from(document.querySelectorAll('.cap-item')).map(n => n.querySelectorAll('.cap-law').length));
    await close();
    untouched = await snapshot();
    await openTile();
    await page.click('.cap-item[data-pid="s43_6"] .cap-st[data-st="minor"]');
    await page.type('.cap-item[data-pid="s43_6"] .cap-note', 'Register not updated since March');
    await close();
    marked = await snapshot();
    await page.reload({ waitUntil: 'networkidle0' });
    await pause(2000);
    reloaded = await snapshot();
    await openTile();
    back = await page.evaluate(() => { const n = document.querySelector('.cap-item[data-pid="s43_6"]');
      return [n.querySelector('.cap-st[data-on="1"]').getAttribute('data-st'), n.querySelector('.cap-note').value]; });
  } finally {
    await browser.close();   // a failure must not leave Chrome holding the whole run open
  }

  assert.equal(shown.length, 15, 'the tile does not open its 15 checks');
  assert.ok(shown.every(n => n === 2), 'a check is missing its regulation line or its source line');
  assert.deepEqual(untouched.sections, [], 'opening the tile put something in the report');
  assert.doesNotMatch(untouched.saved, /PC43|s43_/, 'opening the tile wrote temporary works into the saved inspection');
  const row = [TW.pc[5][0].replace(/\.$/, ''), 'minor', 'Register not updated since March'];
  assert.deepEqual(marked.sections, [{ name: 'Temporary Works', rows: [row] }], 'the marked check did not build its section in the report');
  assert.deepEqual(reloaded.sections, marked.sections, 'the temporary works section did not survive a reload');
  assert.deepEqual(back, ['minor', 'Register not updated since March'], 'the tick or the note did not survive a reload');
  assert.deepEqual(errs, []);
});

// ────────────────────────────────────────────────────────────────
//  Compass link - accreditation evidence out, focus areas in
// ────────────────────────────────────────────────────────────────

// The 14 questions the master list (accreditation-master-questions.json,
// 5 October 2026) says a site inspection can evidence. A check may only be
// tagged to one of these.
const SITE_QIDS = ['HS-11', 'HS-15', 'HS-17', 'CN-01', 'CN-02', 'CN-04', 'CN-05', 'QA-04', 'QA-07', 'BS-03', 'BS-04', 'BS-06', 'BS-11', 'EN-02'];
function accredLiteral(name) {
  const m = SRC.match(new RegExp('var ' + name + ' = (\\{[^\\n]*\\});'));
  assert.ok(m, name + ' not found in the Compass link module');
  return JSON.parse(m[1]);
}

test('accreditation tags point only at questions a site inspection can evidence, from checks that exist', () => {
  const TAGS = accredLiteral('TAGS'), Q = accredLiteral('Q');
  const p0 = SRC.indexOf('const SIMPLE_PHRASES = [');
  let i = SRC.indexOf('[', p0), d = 0, p1 = -1;
  for (; i < SRC.length; i++) { const ch = SRC[i]; if (ch === '[') d++; else if (ch === ']') { d--; if (d === 0) { p1 = i; break; } } }
  const ids = new Set(new Function('return ' + SRC.slice(SRC.indexOf('[', p0), p1 + 1) + ';')().map(p => p.id));
  Object.keys(TAGS).forEach(pid => {
    assert.ok(ids.has(pid), 'tagged check ' + pid + ' is not in the criteria');
    TAGS[pid].forEach(q => {
      assert.ok(SITE_QIDS.includes(q), pid + ' is tagged to ' + q + ', which a site inspection cannot evidence');
      assert.ok(Q[q], q + ' has no wording');
    });
  });
  assert.equal(Object.keys(TAGS).length, 41, 'the tag list changed - show Simon before it ships');
  // HS-11 needs the advice shown to have been acted on; BS-04 is defects
  // reported to manufacturers. No check evidences either, so neither is tagged.
  assert.ok(!Object.values(TAGS).flat().includes('HS-11') && !Object.values(TAGS).flat().includes('BS-04'));
  assert.deepEqual(TAGS.c44_4, ['QA-04'], 'temporary works built-as-designed evidences installation checked');
  assert.deepEqual(TAGS.c44_6, ['CN-01'], 'temporary works RAMS accepted evidences the RAMS question');
  assert.match(Q['HS-17'], /^Practical evidence of two-way consultation with the workforce/);
  assert.match(SRC, /var REPORT_QIDS = \['HS-15', 'BS-06'\];/, 'the report itself no longer evidences monitoring');
  assert.match(SRC, /var SYNC_KEYS {5}= \['FRONTPAGE_DATA_V1','clientLogo','AHS_INSPECTIONS_V1','AHS_ACCRED_EVIDENCE_V1'\];/, 'the evidence no longer travels with the project');
});

test('the link server matches a client by its reference, and keeps only well-formed evidence', async () => {
  const { createRequire } = await import('node:module');
  const req = createRequire(import.meta.url);
  const dbPath = req.resolve('../db/index.js');
  req.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: {} } };   // the route's pure parts need no database
  const link = req('../routes/link.js');
  const rows = [
    { project: 'Woldgate School', ev: JSON.stringify({ client: ' mvl ', sent: [{ inspectionId: 'a', date: '2026-09-01', items: [{ qids: ['HS-17', 'bad'], check: 'c', photo: 'javascript:alert(1)' }] }, { inspectionId: 'b', date: '2026-10-01', items: [{ qids: ['CN-05'], check: 'w', photo: 'data:image/jpeg;base64,AAA' }] }] }) },
    { project: 'Other', ev: JSON.stringify({ client: 'RSSC', sent: [{ inspectionId: 'c', items: [{ qids: ['HS-17'] }] }] }) },
    { project: 'Broken', ev: '{not json' },
  ];
  const out = link.evidenceFor(rows, 'MVL');
  assert.deepEqual(out.map(r => r.inspectionId), ['b', 'a'], 'MVL only, newest first');
  assert.deepEqual(out[1].items[0].qids, ['HS-17'], 'a malformed question id is dropped');
  assert.equal(out[1].items[0].photo, '', 'only an image data URL passes as a photo');
  assert.equal(out[0].project, 'Woldgate School');
  assert.deepEqual(link.evidenceFor(rows, ''), []);
  assert.deepEqual(link.cleanFocus([{ id: 'HS-17', text: 'x' }, { id: 'drop me' }]).map(f => f.id), ['HS-17']);
  assert.match(fs.readFileSync(path.join(here, '..', 'server.js'), 'utf8'), /app\.use\('\/api\/link', {2}linkRoutes\);/, 'the link route is not mounted');
  assert.match(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'), /CREATE TABLE IF NOT EXISTS link_focus/);
});

test('a finished inspection sends its compliant tagged checks and the report, and nothing else', { skip: !CHROME && 'Chrome not found' }, async () => {
  const { browser, page, errs } = await boot();
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const tile = async (mode, key) => {
    await page.evaluate(() => { document.getElementById('capOpen').click(); const b = document.getElementById('capBack'); if (b.style.display !== 'none') b.click(); });
    await page.click('#capOverlay .cap-mode button[data-mode="' + mode + '"]');
    await page.click('#capOverlay .cap-tile[data-key="' + key + '"]');
  };
  let shown, collected, stored, resent, draftSame, focusAsked;
  try {
    await tile('C', 'C25');
    shown = await page.evaluate(() => (Array.from(document.querySelectorAll('.cap-item[data-pid="c25_5"] .cap-acc')).map(x => x.textContent))[0] || '');
    await page.click('.cap-item[data-pid="c25_5"] .cap-st[data-st="compliant"]');
    await page.type('.cap-item[data-pid="c25_5"] .cap-note', 'Weekly toolbox talk signed by all six');
    await tile('C', 'C23');
    await page.click('.cap-item[data-pid="c23_1"] .cap-st[data-st="advisory"]');
    await tile('C', 'C26');
    await page.click('.cap-item[data-pid="c26_1"] .cap-st[data-st="compliant"]');
    await page.evaluate(() => document.getElementById('capHide').click());
    await pause(1500);
    collected = await page.evaluate(() => window.AHS_ACCRED.collect().map(it => [it.checkId, it.qids.join(' '), it.note]));
    const draft0 = await page.evaluate(async () => { const o = await window.AHS_DRAFT.collect(); delete o.t; return JSON.stringify(o); });
    await page.evaluate(() => localStorage.setItem('AHS_ACCRED_EVIDENCE_V1', JSON.stringify({ v: 1, client: 'MVL', sent: [] })));
    await page.evaluate(() => window.AHS_ACCRED.send());
    await pause(800);
    stored = await page.evaluate(() => JSON.parse(localStorage.getItem('AHS_ACCRED_EVIDENCE_V1')));
    await page.evaluate(() => window.AHS_ACCRED.send());
    await pause(800);
    resent = await page.evaluate(() => JSON.parse(localStorage.getItem('AHS_ACCRED_EVIDENCE_V1')).sent.length);
    draftSame = draft0 === await page.evaluate(async () => { const o = await window.AHS_DRAFT.collect(); delete o.t; return JSON.stringify(o); });
    focusAsked = await page.evaluate(async () => (await window.AHS_ACCRED.loadFocus()).ok);
  } finally {
    await browser.close();
  }
  assert.match(shown, /Accreditation evidence: HS-17 Practical evidence of two-way consultation/, 'a tagged check does not say which question it evidences');
  assert.deepEqual(collected, [['c25_5', 'HS-17', 'Weekly toolbox talk signed by all six'], ['report', 'HS-15 BS-06', '3 checks reviewed across 3 criteria, 1 finding raised for action']],
    'only compliant tagged checks go, with the report; an advisory and an untagged check stay behind');
  assert.equal(stored.client, 'MVL');
  assert.equal(stored.sent.length, 1);
  assert.equal(stored.sent[0].items.length, 2);
  assert.match(stored.sent[0].reportName, /^Safety Inspection Report - /);
  assert.ok(stored.sent[0].inspectionId && stored.sent[0].date && stored.sent[0].sentAt, 'the evidence is dated and tied to its inspection');
  assert.equal(resent, 1, 'sending the same inspection again replaces it, never doubles it');
  assert.ok(draftSame, 'sending to Compass changed the inspection itself');
  assert.equal(focusAsked, false, 'from disk there is no server, and asking for focus areas must fail quietly');
  assert.deepEqual(errs, []);
});

test('evidence kept in the offline copy reaches Compass through Open file', () => {
  // The offline copy has no server, so its evidence rides in the saved file.
  // Open file in the online app must bring that key across, after which it
  // syncs like the rest of the project; the panel says so in the offline copy.
  const openFile = SRC.slice(SRC.indexOf('Open a saved inspection file  (ONLINE app'));
  assert.match(openFile, /var LS_KEYS = \['FRONTPAGE_DATA_V1', 'clientLogo', 'AHS_INSPECTIONS_V1', 'AHS_SIGNOFF_ON', 'AHS_ACCRED_EVIDENCE_V1'\];/,
    'Open file drops the accreditation evidence an offline save carries');
  assert.match(SRC, /if\(window\.AHS_OFFLINE\) return \{ ok:false, why:'offline-copy' \};/, 'the offline copy tries to reach Compass');
  assert.match(SRC, /window\.AHS_OFFLINE \? 'Keep for Compass' : 'Send to Compass'/, 'the offline copy promises to send what it can only keep');
});
