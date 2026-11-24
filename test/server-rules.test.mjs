// Server rules for saved reports and photos. No database needed.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const req = createRequire(import.meta.url);

test('photos sent with a save are split out, and an empty list is just nothing to add', () => {
  // 2026-11-24: a device that could not read its photos sent an empty list,
  // and the server read that as "delete them all".
  const { splitPhotos, validPhoto, idsIn } = req('../routes/photo-store.js');
  const pic = 'data:image/jpeg;base64,AAAA';
  const draft = JSON.stringify({ images: [{ id: 'img-1700000000001-aaaaaaaaa' }, { id: 'odd_old_id' }],
    capture: { sections: { C1: { items: { a: { photos: ['img-cap-1700000000002-bbbbbbbbb'] } } } } } });
  const out = splitPhotos({ 'AHS_REPORT_DRAFT_V1:/': draft, __photos__: { 'img-1700000000001-aaaaaaaaa': pic, bad: 'not a picture', 'x y': pic } });
  assert.deepEqual(Object.keys(out.photos), ['img-1700000000001-aaaaaaaaa'], 'only real pictures under usable ids are kept');
  assert.equal(out.state.__photos__, undefined, 'the report text still carries photos');
  assert.deepEqual(splitPhotos({ a: '1', __photos__: {} }).photos, {}, 'an empty list must add nothing');
  assert.deepEqual(splitPhotos({ a: '1' }).photos, {});
  assert.equal(validPhoto('img-1', 'data:text/html;base64,AAAA'), false, 'something that is not an image was accepted as a photo');
  assert.deepEqual(idsIn({ 'AHS_REPORT_DRAFT_V1:/': draft, AHS_INSPECTIONS_V1: '[{"state":{"images":[{"id":"img-quick-1700000000003-ccccccc"}]}}]', clientLogo: 'img-1700000000009-zzzzzzzzz' }).sort(),
    ['img-1700000000001-aaaaaaaaa', 'img-cap-1700000000002-bbbbbbbbb', 'img-quick-1700000000003-ccccccc', 'odd_old_id'],
    'a report must be read for every photo it uses: its pictures, its criteria answers and its earlier visits');
});

test('a save from an out-of-date copy is asked about; a build without the check saves as before', () => {
  const { decideSave, keepVersion } = req('../routes/merge-state.js');
  const cur = { state: { d: '{"t":1700000000000,"x":1}' }, updated_at: new Date('2026-11-24T10:00:00.000Z'), device_id: 'ipad' };
  const other = { d: '{"t":1700000009999,"x":2}' };
  assert.equal(decideSave(null, { state: other }), 'save');
  assert.equal(decideSave(cur, { state: other }), 'save', 'the app on the devices today sends no version, and must save exactly as it did');
  assert.equal(decideSave(cur, { state: other, base: '2026-11-24T10:00:00.000Z', deviceId: 'laptop' }), 'save');
  assert.equal(decideSave(cur, { state: other, base: '2026-11-24T09:00:00.000Z', deviceId: 'ipad' }), 'save', 'a device whose last reply was lost is refused its own next save');
  assert.equal(decideSave(cur, { state: other, base: '2026-11-24T09:00:00.000Z', deviceId: 'laptop' }), 'conflict', 'an out-of-date copy replaces a newer one without asking');
  assert.equal(decideSave(cur, { state: { d: '{"t":1700000005555,"x":1}' }, base: '2026-11-24T09:00:00.000Z', deviceId: 'laptop' }), 'same');
  assert.equal(decideSave(cur, { state: other, base: '2026-11-24T09:00:00.000Z', deviceId: 'laptop', force: true }), 'save');
  const now = Date.parse('2026-11-24T10:05:00Z');
  assert.equal(keepVersion(cur, { state: other, deviceId: 'laptop' }, null, now), true, 'another device\'s work is replaced without a copy being kept');
  assert.equal(keepVersion(cur, { state: other, deviceId: 'ipad' }, new Date(now - 60000), now), false, 'every autosave keeps a version');
  assert.equal(keepVersion(cur, { state: other, deviceId: 'ipad' }, new Date(now - 11 * 60000), now), true);
  assert.equal(keepVersion(cur, { state: { d: '{"t":1700000005555,"x":1}' }, deviceId: 'laptop' }, null, now), false, 'an identical save keeps a version');
});
