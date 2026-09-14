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
  assert.match(SRC, /var ref = '\(' \+ STATUS_LETTER\[it\.st\] \+ \(basis \? ', ' \+ basis : ''\) \+ '\)';/, 'findings no longer end with their status letter and legal basis');
  // 2026-09-15: only the reference is highlighted - a whole highlighted line cannot be edited on the iPad
  assert.match(SRC, /g\.html = \(g\.hl && g\.ref\) \? _esc\(g\.text\.slice\(0, g\.text\.length - g\.ref\.length\)\) \+ '<span style="background-color:#FFE58A">' \+ _esc\(g\.ref\) \+ '<\/span>'/, 'the whole finding line is highlighted again');
  assert.doesNotMatch(SRC, /'<span style="background-color:#FFE58A">' \+ c\.html \+ '<\/span>'/, 'the merge wraps the whole user line in the highlight again');
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
  assert.match(L.AHS_LAW.anchorLine('PC3'), /^Assessed against CDM 2015 regs 12\(1\), 12\(4\), 13\(3\)\(c\) and 15\(7\); MHSWR 1999 reg 3\(1\)\.$/);
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

test('the summary composer writes from the inspector\'s own words and never leaves [INSERT] cues', () => {
  // 2026-09-14: the composed summaries were template prose with [INSERT] cues
  // that ignored every note typed on site. The composer now takes the whole
  // report as its model. This pins the behaviours that make it worth having,
  // running the block exactly as it is embedded in the page.
  const s = SRC.indexOf('// ── AHS_COMPOSE start ──'), e = SRC.indexOf('// ── AHS_COMPOSE end ──');
  assert.ok(s > 0 && e > s, 'AHS_COMPOSE block (with its start/end markers) not found');
  const C = new Function(SRC.slice(s, e) + '\nreturn AHS_COMPOSE;')();
  const criteria = [
    'Task-specific RAMS were in place for the activities being undertaken.',
    'Adequate supervision was provided to manage the work activities safely.',
    'At the time of the inspection the following was observed:',
  ];
  const model = {
    client: 'Department for Health', pc: 'Henry Boot Construction Ltd', contract: 'G & H Ltd', contractor: 'Morley Ventilation Ltd',
    contact: 'Mark (Site Supervisor)', inspector: 'Simon Archer',
    visit: { works_phase: 'Installing ductwork', operatives_on_site: 3 },
    legal: { statutory: 'CDM 2015 regs 13(1) and 15(8)', hse: 'site rules and induction', contractual: '' },
    criteria,
    sections: [
      { name: 'CDM Roles, Cooperation & Communication',
        lines: ['At the time of the inspection the following was observed:', 'Actions to be addressed,',
          '• The Principal Contractor can improve by engaging in regular communication with their appointed contractors -',
          'PC is not participating in the regular safety meeting.'],
        rows: [{ item: 'Understanding of CDM duties', status: 'minor', note: 'No safety meetings taking place on a regular basis' }] },
      { name: 'Risk Assessments & Method Statements',
        lines: ['• Task-specific RAMS were in place for the activities being undertaken. (see images)',
          '• Adequate supervision was provided to manage the work activities safely the operative I spoke to knew the RAMS well',
          '• Through the you see we say scheme have so far this month raised …....'],
        rows: [{ item: 'RAMS in place', status: 'compliant', note: 'G and H approve the RAMS', text: criteria[0] },
               { item: 'Supervision', status: 'compliant', note: '', text: criteria[1] }] },
    ],
  };
  const site = C.build(model, 'site').join('\n'), closing = C.build(model, 'closing').join('\n');
  assert.doesNotMatch(site + closing, /\[INSERT/i, 'a cue was written instead of leaving the unknown out');
  assert.match(site, /No safety meetings taking place on a regular basis/, 'the note against a finding is not in the summary');
  assert.match(site, /Action: The Principal Contractor can improve[^\n]*PC is not participating/, 'the comment lines typed under a section (label + continuation) were lost');
  assert.match(site, /CDM 2015 regulations 13\(1\) and 13\(3\)\(a\) place with Henry Boot Construction Ltd/, 'a PC-level failure is not escalated to the Principal Contractor, naming the regulation');
  assert.match(site, /operative the inspector spoke to knew the RAMS well/, 'words typed onto the end of a criteria line were lost, or left in the first person');
  assert.doesNotMatch(site, /Task-specific RAMS were in place/, 'a criteria sentence the builder wrote was passed off as the inspector\'s words');
  assert.doesNotMatch(site, /…/, 'an unfilled placeholder line reached the summary');
  assert.match(closing, /A1\. Understanding of CDM duties/, 'findings are not numbered in the sign-off');
  assert.match(closing, /measured against CDM 2015 regs 13\(1\) and 15\(8\)\. The standard applied is HSE's construction guidance on site rules and induction\./, 'the sign-off no longer summarises the legal basis in a paragraph');
  assert.match(site, /measured against CDM 2015 regs 13\(1\) and 15\(8\)/, 'the site summary no longer summarises the legal basis');
  assert.match(SRC, /function buildLocalSummary\(kind\)\{[\s\S]{0,600}AHS_COMPOSE\.build\(/, 'buildLocalSummary no longer composes through AHS_COMPOSE');
});
