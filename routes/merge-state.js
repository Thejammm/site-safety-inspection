// ══════════════════════════════════════════════════════════════
//  save rules - how an incoming report lands on an existing one
//
//  Pure decisions, no database, so every rule can be tested on its own.
//  Photos are not part of this any more: they have their own rows, and
//  nothing in a save can remove one (routes/store.js).
// ══════════════════════════════════════════════════════════════
const KEEP_EVERY_MS = 10 * 60 * 1000;   // one earlier version per ten minutes of steady work
const KEEP_MAX = 40;                    // per project

function iso(t){ const d = new Date(t); return isNaN(d) ? '' : d.toISOString(); }

// The autosave stamps the draft with "t": the same content saved twice is
// still the same content.
function sameContent(a, b){
  const flat = o => JSON.stringify(Object.keys(o || {}).filter(k => k !== '__photos__').sort().map(k =>
    [k, typeof o[k] === 'string' ? o[k].replace(/"t":\d{10,},?/, '') : o[k]]));
  return flat(a) === flat(b);
}

// May this save replace what is there?
//   cur  { state, updated_at, device_id } or null when nothing is saved yet
//   msg  { state, base, deviceId, force }
// 'save'      go ahead
// 'same'      nothing differs: just tell the device which version this is
// 'conflict'  another device saved since this one last looked: ask first
function decideSave(cur, msg){
  if(!cur) return 'save';
  if(msg.force) return 'save';
  if(msg.base === undefined || msg.base === null || msg.base === '') return 'save';   // a build from before this check
  if(iso(cur.updated_at) === iso(msg.base)) return 'save';                            // working from the latest
  if(cur.device_id && msg.deviceId && cur.device_id === msg.deviceId) return 'save';  // its own last save, whose reply was lost
  if(sameContent(cur.state, msg.state)) return 'same';
  return 'conflict';
}

// Keep a copy of what is about to be replaced?
function keepVersion(cur, msg, lastKeptAt, now){
  if(!cur || sameContent(cur.state, msg.state)) return false;
  if(msg.force) return true;                                               // someone chose this copy over that one
  if((cur.device_id || '') !== (msg.deviceId || '')) return true;          // another device's work
  return !lastKeptAt || (now - new Date(lastKeptAt).getTime()) > KEEP_EVERY_MS;
}

module.exports = { decideSave, keepVersion, sameContent, iso, KEEP_EVERY_MS, KEEP_MAX };
