// ══════════════════════════════════════════════════════════════
//  photo rules - what counts as a report photo, and where one is referred to
//
//  Photos used to travel inside the saved report as one block. A device that
//  could not read its photos sent an empty block, and the server took that to
//  mean "delete them" (Blackburn and Woldgate, November 2026). Now a photo is
//  its own row (routes/store.js) and a save can only ever add one.
//
//  Pure helpers, no database, so each can be tested on its own.
// ══════════════════════════════════════════════════════════════
const PHOTO_KEY = '__photos__';
const ID_RE   = /^[A-Za-z0-9][\w.:-]{2,119}$/;
const DATA_RE = /^data:image\/[a-z0-9.+-]+;base64,/i;
// the ids this app gives its photos, wherever they appear in a saved report
const IDS_IN_TEXT = /img-(?:[a-z]+-)?\d{13}-[a-z0-9]+/g;

function validPhoto(id, data){
  return ID_RE.test(String(id || '')) && typeof data === 'string' && DATA_RE.test(data);
}

// Split a saved report into its text and any photos an older build sent
// inside it. The text is stored without them.
function splitPhotos(state){
  if(!state || typeof state !== 'object') return { state, photos: {} };
  const out = Object.assign({}, state);
  const inside = out[PHOTO_KEY];
  delete out[PHOTO_KEY];
  const photos = {};
  if(inside && typeof inside === 'object'){
    Object.keys(inside).forEach(id => { if(validPhoto(id, inside[id])) photos[id] = inside[id]; });
  }
  return { state: out, photos };
}

// Every photo id a saved report refers to: its picture list by structure (an
// id of any shape), everything else (criteria answers, earlier visits) by the
// shape the app gives its ids.
function idsIn(state){
  const out = new Set();
  Object.keys(state || {}).forEach(k => {
    if(k === PHOTO_KEY || k === 'clientLogo') return;
    const v = state[k];
    const text = typeof v === 'string' ? v : JSON.stringify(v || '');
    (text.match(IDS_IN_TEXT) || []).forEach(id => out.add(id));
    if(k.indexOf('AHS_REPORT_DRAFT_V1:') === 0){
      try{
        const d = typeof v === 'string' ? JSON.parse(v) : v;
        (d.images || []).forEach(im => { if(im && im.id && ID_RE.test(String(im.id))) out.add(String(im.id)); });
      }catch(_){ /* not a draft we can read: the pattern above still applies */ }
    }
  });
  return Array.from(out);
}

module.exports = { PHOTO_KEY, validPhoto, splitPhotos, idsIn };
