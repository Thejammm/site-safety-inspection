// ══════════════════════════════════════════════════════════════
//  mergeState - how an incoming state blob lands on an existing row
//
//  A client that has not changed its photos since its last successful
//  upload omits __photos__ entirely, so a text edit costs kilobytes instead
//  of every photo again (that re-serialisation is what made the app feel
//  frozen on a poor site signal). When the key is ABSENT, keep the photos
//  already on the row. An explicit {} still clears them. Everything else is
//  the incoming state, untouched.
// ══════════════════════════════════════════════════════════════
const PHOTO_KEY = '__photos__';

function mergeState(existing, incoming){
  if(!incoming || typeof incoming !== 'object') return incoming;
  if(Object.prototype.hasOwnProperty.call(incoming, PHOTO_KEY)) return incoming;
  if(existing && typeof existing === 'object' && existing[PHOTO_KEY]){
    const out = Object.assign({}, incoming);
    out[PHOTO_KEY] = existing[PHOTO_KEY];
    return out;
  }
  return incoming;
}

module.exports = { mergeState, PHOTO_KEY };
