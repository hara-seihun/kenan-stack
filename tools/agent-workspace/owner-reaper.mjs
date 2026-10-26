// A timer pass has two bounded phases. Binding is evidence migration, never owner inference.
// Release remains the existing guarded transition, including a fresh native observation.
export function reapEndedOwners({bind,release}) {
 const binding=bind();
 if(!binding.ok)return {ok:false,kind:'owner-reaper',binding,release:null};
 const released=release();
 return {ok:released.ok,kind:'owner-reaper',binding,release:released};
}

// Stable pool order with a durable anchor. Timer passes wrap; explicit walks do not.
export function ownerPage(records,anchor,{wrap=true}={}) {
 if(!anchor)return records;
 const later=record=>record.root>anchor.root||(record.root===anchor.root&&(record.path>anchor.path||(record.path===anchor.path&&record.id>anchor.id)));
 const pivot=records.findIndex(later);
 if(!wrap)return pivot<0?[]:records.slice(pivot);
 return pivot<0?records:[...records.slice(pivot),...records.slice(0,pivot)];
}
